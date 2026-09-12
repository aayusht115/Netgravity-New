"""User-initiated, bounded public warehouse context; never property listings."""
import hashlib
import json
import os
from datetime import datetime, timezone
from urllib.parse import urlparse

import requests
from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator

from app.backend.services.errors import ValidationError
from app.backend.services.ratelimit import limiter
from netgravity.scenarios.location import coordinates, demand_surface, distance, proximity

DEFAULT_ENDPOINT = "https://overpass.private.coffee/api/interpreter"
RESULT_LIMIT = 100


class LocationQuery(BaseModel):
    latitude: float = Field(ge=-85, le=85, allow_inf_nan=False)
    longitude: float = Field(ge=-180, le=180, allow_inf_nan=False)
    radius_km: float = Field(ge=1, le=25, allow_inf_nan=False)
    consent_external: StrictBool
    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def consent(self):
        if not self.consent_external:
            raise ValueError("Confirm sharing only the search centre and radius with the public map provider.")
        return self


def query_warehouses(query, post=None):
    endpoint = os.getenv("NETGRAVITY_OVERPASS_URL", DEFAULT_ENDPOINT).strip()
    parsed = urlparse(endpoint)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValidationError("The warehouse context provider is not configured with a valid HTTPS endpoint.")
    allowed, _, _ = limiter.check("location.provider", "all-users", limit=30, window_seconds=3600)
    if not allowed:
        raise ValidationError("The shared warehouse lookup budget is reached. Try later; existing scenarios remain usable.", http_status=429)
    lat, lng, radius = query.latitude, query.longitude, query.radius_km * 1000
    # Numeric validated inputs only: no user text, network names or demand are sent.
    expression = (f'[out:json][timeout:25][maxsize:16777216];('
                  f'nwr["building"="warehouse"](around:{radius:g},{lat:.7f},{lng:.7f});'
                  f'nwr["industrial"="warehouse"](around:{radius:g},{lat:.7f},{lng:.7f});'
                  f');out tags center {RESULT_LIMIT + 1};')
    try:
        with (post or requests.post)(endpoint, data={"data": expression},
                  headers={"User-Agent": "NetGravity-location-screening/1.0", "Accept": "application/json"},
                  timeout=(5, 30), allow_redirects=False, stream=True) as response:
            if response.status_code != 200:
                raise ValueError("provider HTTP failure")
            chunks, size = [], 0
            for chunk in response.iter_content(65536):
                size += len(chunk)
                if size > 2_000_000:
                    raise ValueError("provider response too large")
                chunks.append(chunk)
            raw = json.loads(b"".join(chunks))
        if not isinstance(raw, dict) or raw.get("remark") or not isinstance(raw.get("elements"), list):
            raise ValueError("provider returned incomplete data")
    except (requests.RequestException, ValueError, TypeError, KeyError) as exc:
        # No secret-bearing URL, response body or plausible substitute escapes.
        raise ValidationError("Nearby warehouse data is unavailable from the map provider. No property results or costs have been substituted. You can still move a site and run the network model.", http_status=503) from exc
    found, seen = [], set()
    for element in raw["elements"][:RESULT_LIMIT]:
        if not isinstance(element, dict):
            continue
        typ, eid = element.get("type"), element.get("id")
        if typ not in {"node", "way", "relation"} or not isinstance(eid, int) or eid <= 0:
            continue
        centre = element.get("center") or element
        if not isinstance(centre, dict):
            continue
        if not coordinates(centre.get("lat"), centre.get("lon")):
            continue
        identity = f"{typ}/{eid}"
        if identity in seen:
            continue
        seen.add(identity)
        raw_tags = element.get("tags") or {}
        if not isinstance(raw_tags, dict):
            continue
        tags = {k: str(v)[:300] for k, v in raw_tags.items()
                if k in {"name", "operator", "building", "industrial", "addr:street", "addr:housenumber", "addr:city", "addr:postcode"}}
        found.append({"id": identity, "name": tags.get("name") or tags.get("operator") or "Mapped warehouse · " + identity,
                      "latitude": centre["lat"], "longitude": centre["lon"],
                      "distance_from_search_km": distance((lat, lng), (centre["lat"], centre["lon"])),
                      "source_url": "https://www.openstreetmap.org/" + identity,
                      "tags": tags, "availability": "Not verified", "rent": None})
    metadata = raw.get("osm3s")
    data_timestamp = metadata.get("timestamp_osm_base") if isinstance(metadata, dict) else None
    return {"provider": parsed.hostname, "attribution": "© OpenStreetMap contributors · ODbL",
            "source_url": "https://www.openstreetmap.org/copyright",
            "retrieved_at": datetime.now(timezone.utc).isoformat(),
            "osm_data_timestamp": data_timestamp if isinstance(data_timestamp, str) else None,
            "query": {"latitude": lat, "longitude": lng, "radius_km": query.radius_km},
            "query_expression": expression, "results": found,
            "truncated": len(raw["elements"]) > RESULT_LIMIT,
            "limitations": ["Mapped warehouse buildings, not verified distribution-centre operations or available properties. Names and coverage may be incomplete or outdated.",
                            "Building bounding-box centres may lie outside a building; location does not establish an entrance, parcel boundary or truck access.",
                            "Ranking compares only returned mapped locations on demand-weighted straight-line distance. It does not evaluate rent, road routing, supply access, capacity, zoning, flood risk or total network cost."]}


def research_locations(snapshot, project_id, query):
    from app.backend.services.analysis_store import analysis_service
    # Cache this exact query for a six-hour window, while retaining immutable
    # provenance for any scenario referencing it. No autonomous polling.
    window = int(datetime.now(timezone.utc).timestamp() // 21600)
    fingerprint = hashlib.sha256(json.dumps([project_id, query.model_dump(), window], sort_keys=True).encode()).hexdigest()[:24]
    def fetch():
        research = query_warehouses(query)
        surface = demand_surface(snapshot.network)
        for item in research["results"]:
            score = proximity((item["latitude"], item["longitude"]), surface)
            item["demand_weighted_distance_km"] = score["weighted_distance_km"]
        research["results"].sort(key=lambda item: (item["demand_weighted_distance_km"] is None,
                                                 item["demand_weighted_distance_km"] or 0, item["id"]))
        research.update({"research_id": fingerprint, "project_id": project_id,
                         "snapshot_id": snapshot.snapshot_id, "demand_coverage_pct": surface["coverage_pct"],
                         "ranking_formula": "Sum(mapped demand units × great-circle distance km) / mapped demand units",
                         "demand_records": surface["points"]})
        return {"research": research}
    return analysis_service.get(snapshot.snapshot_id, snapshot.data_version, fetch,
                                variant="location-research:" + fingerprint)["research"]


def saved_research(snapshot, project_id, research_id):
    from app.backend.services.analysis_store import analysis_service
    entry = analysis_service.peek(snapshot.snapshot_id, snapshot.data_version, variant="location-research:" + research_id)
    research = (entry or {}).get("research")
    if not research or research.get("project_id") != project_id or research.get("snapshot_id") != snapshot.snapshot_id:
        raise ValidationError("The location research is not available for this project snapshot. Search again before running the scenario.")
    return research
