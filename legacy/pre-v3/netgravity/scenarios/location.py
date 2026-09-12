"""Transparent location screening and relocation input transformations.

This is not road routing or property valuation. A move preserves the uploaded
lane detour ratio and uses an explicitly acknowledged tariff assumption.
The original snapshot is never mutated; the ordinary optimizer solves the copy.
"""
from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator

from netgravity.schemas.network import CanonicalNetwork, DistanceMethod, FacilityStatus, NodeRole

EARTH_RADIUS_KM = 6371.0
COST_ITEMS = {"fit_out": "Fit-out and equipment", "moving": "Moving and transition",
              "lease_exit": "Existing lease exit", "other": "Other implementation costs"}


class RelocationSpec(BaseModel):
    latitude: float = Field(ge=-85, le=85, allow_inf_nan=False)
    longitude: float = Field(ge=-180, le=180, allow_inf_nan=False)
    tariff_model: Literal["distance_proportional", "uploaded_components"]
    acknowledge_estimates: StrictBool
    annual_fixed_cost: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    fit_out: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    moving: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    lease_exit: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    other: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    cost_source: str = Field(default="", max_length=1000)
    research_id: str | None = Field(default=None, max_length=64)
    candidate_id: str | None = Field(default=None, max_length=64)
    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_assumptions(self):
        if not self.acknowledge_estimates:
            raise ValueError("Acknowledge that lane distance, tariff and transit time are planning estimates before running a move.")
        if self.candidate_id and not self.research_id:
            raise ValueError("A mapped location must reference its saved location research.")
        if any(getattr(self, key) is not None for key in ["annual_fixed_cost", *COST_ITEMS]) and not self.cost_source.strip():
            raise ValueError("Give the source/date or budget-assumption basis for the entered costs.")
        return self


def coordinates(latitude, longitude):
    return (isinstance(latitude, (int, float)) and not isinstance(latitude, bool)
            and isinstance(longitude, (int, float)) and not isinstance(longitude, bool)
            and math.isfinite(latitude) and math.isfinite(longitude)
            and -85 <= latitude <= 85 and -180 <= longitude <= 180)


def distance(a, b):
    """Haversine kilometres, with rounding guard at antipodal points."""
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    h = math.sin((lat2-lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin((lon2-lon1)/2)**2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(max(0, min(1, h))))


def demand_surface(network):
    """Original uploaded quantities, not inferred customer addresses or forecasts."""
    totals = {}
    for row in network.demands:
        totals[row.market_id] = totals.get(row.market_id, 0) + row.quantity
    facilities = {f.id: f for f in network.facilities}
    points, omitted = [], []
    for fid, quantity in totals.items():
        f = facilities[fid]
        item = {"id": fid, "name": f.name, "role": f.role.value, "quantity": quantity}
        if coordinates(f.latitude, f.longitude):
            points.append({**item, "latitude": f.latitude, "longitude": f.longitude})
        else:
            omitted.append(item)
    total = sum(totals.values())
    mapped = sum(p["quantity"] for p in points)
    # Spherical weighted centre avoids the +/-180 degree arithmetic-mean trap.
    xyz = [0.0, 0.0, 0.0]
    centre_terms = []
    for p in points:
        lat, lon = math.radians(p["latitude"]), math.radians(p["longitude"])
        vector = (math.cos(lat)*math.cos(lon), math.cos(lat)*math.sin(lon), math.sin(lat))
        centre_terms.append({"market_id": p["id"], "quantity": p["quantity"], "latitude_radians": lat,
                             "longitude_radians": lon, "unit_xyz": list(vector), "weighted_xyz": [p["quantity"]*v for v in vector]})
        for i, component in enumerate(vector):
            xyz[i] += p["quantity"] * component
    length = math.sqrt(sum(v*v for v in xyz))
    centre = ({"latitude": math.degrees(math.atan2(xyz[2], math.hypot(xyz[0], xyz[1]))),
               "longitude": math.degrees(math.atan2(xyz[1], xyz[0]))}
              if mapped > 0 and length > mapped * 1e-9 else None)
    return {"points": points, "omitted": omitted, "total_quantity": total,
            "mapped_quantity": mapped, "coverage_pct": mapped / total * 100 if total else None,
            "centre": centre, "periods": sorted({d.period for d in network.demands}),
            "centre_calculation": {"terms": centre_terms, "sum_weighted_xyz": xyz,
                                   "formula": "x=cos(lat)cos(lon), y=cos(lat)sin(lon), z=sin(lat). Sum(quantity × each component). Centre latitude=atan2(sum_z, sqrt(sum_x²+sum_y²)); longitude=atan2(sum_y,sum_x). Convert radians to degrees."},
            "period_labels": network.period_labels,
            "methodology": "Sum uploaded demand across products and planning periods by market/customer ID. Heat intensity represents demand quantity, not a count of individual customers. The demand centre is the quantity-weighted mean of unit-sphere XYZ coordinates, converted back to latitude/longitude; it is a search starting point, not an optimal or buildable site."}


def proximity(point, surface):
    records = [{"market_id": p["id"], "quantity": p["quantity"],
                "distance_km": distance(point, (p["latitude"], p["longitude"]))} for p in surface["points"]]
    for row in records:
        row["quantity_distance"] = row["quantity"] * row["distance_km"]
    total = sum(r["quantity"] for r in records)
    weighted_sum = sum(r["quantity_distance"] for r in records)
    return {"weighted_distance_km": weighted_sum / total if total else None,
            "sum_quantity_distance": weighted_sum, "mapped_demand": total,
            "records": records, "formula": "Sum(demand units × great-circle distance km) / mapped demand units",
            "scope": "All mapped demand in the uploaded horizon; not only demand assigned to this facility, and not a road distance."}


def relocation_inputs(network, facility_id, spec):
    facs = {f.id: f for f in network.facilities}
    site = facs.get(facility_id)
    if site is None or site.role not in {NodeRole.DC, NodeRole.WAREHOUSE, NodeRole.PLANT}:
        raise ValueError("Choose an existing plant or distribution centre, not a market/customer.")
    if site.status != FacilityStatus.EXISTING or site.is_forced_closed:
        raise ValueError("Relocation requires an existing operating site. Use the new-facility scenario for a candidate or closed site.")
    if not coordinates(site.latitude, site.longitude):
        raise ValueError("The selected site needs valid geographic coordinates in the upload.")
    target = (spec.latitude, spec.longitude)
    source = (site.latitude, site.longitude)
    lanes = []
    for index, lane in enumerate(network.lanes):
        if facility_id not in {lane.origin_id, lane.destination_id}:
            continue
        other_id = lane.destination_id if lane.origin_id == facility_id else lane.origin_id
        other = facs[other_id]
        if other_id == facility_id or not coordinates(other.latitude, other.longitude):
            raise ValueError(f"Lane {lane.origin_id} → {lane.destination_id} requires distinct endpoints with geographic coordinates. No lane was silently left unchanged.")
        old_geo = distance(source, (other.latitude, other.longitude))
        new_geo = distance(target, (other.latitude, other.longitude))
        if old_geo <= 1e-6 or lane.distance_km <= 0:
            raise ValueError(f"Lane {lane.origin_id} → {lane.destination_id} has no usable baseline distance. Supply valid route inputs before moving this site.")
        if lane.distance_km < old_geo * .99:
            raise ValueError(f"Lane {lane.origin_id} → {lane.destination_id} is shorter than its straight-line distance by more than 1%. Check the uploaded coordinates and distance before using them to price a move.")
        if lane.mode.value != "ROAD":
            raise ValueError(f"Lane {lane.origin_id} → {lane.destination_id} uses {lane.mode.value}. This first relocation model supports ROAD lanes only; rail, sea and air need routed or quoted replacement lanes.")
        if lane.tariff_requires_user_input:
            raise ValueError(f"Lane {lane.origin_id} → {lane.destination_id} requires a replacement freight quote before relocation.")
        ratio = new_geo / old_geo
        estimated_distance = lane.distance_km * ratio
        if spec.tariff_model == "uploaded_components":
            if (lane.rate_per_km is None or lane.fixed_leg_cost is None
                    or lane.speed_km_per_day is None or lane.speed_km_per_day <= 0
                    or lane.terminal_time_days is None):
                raise ValueError(f"Lane {lane.origin_id} → {lane.destination_id} is missing a rate/km, fixed leg cost, speed or terminal time. Supply all components or explicitly choose the proportional planning assumption.")
            rate = lane.fixed_leg_cost + lane.rate_per_km * estimated_distance
            lead = lane.terminal_time_days + estimated_distance / lane.speed_km_per_day
            rate_formula = "fixed leg cost + uploaded rate/km × estimated distance"
            time_formula = "terminal days + estimated distance / uploaded km per day"
        else:
            rate, lead = lane.rate_per_unit * ratio, lane.lead_time_days * ratio
            rate_formula = "baseline lane rate per unit × new great-circle distance / old great-circle distance"
            time_formula = "baseline transit days × new great-circle distance / old great-circle distance"
        if not all(math.isfinite(v) and v >= 0 for v in (rate, lead, estimated_distance)):
            raise ValueError("Relocation produced invalid lane estimates. Check the uploaded tariff components.")
        lanes.append({"lane_index": index, "origin_id": lane.origin_id, "destination_id": lane.destination_id,
                      "mode": lane.mode.value, "active": lane.is_active_baseline,
                      "old_great_circle_km": old_geo, "new_great_circle_km": new_geo,
                      "baseline_detour_ratio": lane.distance_km / old_geo, "distance_ratio": ratio,
                      "geographic_inputs": {"old_site": list(source), "new_site": list(target),
                                            "other_endpoint": [other.latitude, other.longitude], "earth_radius_km": EARTH_RADIUS_KM,
                                            "formula": "h=sin²((lat2-lat1)/2)+cos(lat1)cos(lat2)sin²((lon2-lon1)/2); km=2×6371×asin(sqrt(h)); angles in radians"},
                      "before": lane.model_dump(mode="json"),
                      "after": {"distance_km": estimated_distance, "rate_per_unit": rate, "lead_time_days": lead,
                                "distance_method": DistanceMethod.ESTIMATED.value, "network_distance_km": None},
                      "rate_formula": rate_formula, "time_formula": time_formula})
    if not lanes:
        raise ValueError("No connecting lanes exist for this facility; moving a marker alone would not model a network change.")
    surface = demand_surface(network)
    return {"method_version": "relocation-v1", "facility_id": site.id, "facility_name": site.name,
            "from": {"latitude": site.latitude, "longitude": site.longitude},
            "to": {"latitude": spec.latitude, "longitude": spec.longitude},
            "move_distance_km": distance(source, target), "assumptions": spec.model_dump(mode="json"),
            "old_annual_fixed_cost": site.fixed_cost_per_year,
            "new_annual_fixed_cost": spec.annual_fixed_cost if spec.annual_fixed_cost is not None else site.fixed_cost_per_year,
            "lanes": lanes, "demand": surface,
            "baseline_proximity": proximity(source, surface), "proposed_proximity": proximity(target, surface),
            "methodology": ["New lane distance = uploaded lane distance × new great-circle distance / old great-circle distance. This preserves the original detour ratio; it does not verify the new road route.",
                            "Haversine distance uses decimal-degree coordinates and Earth radius 6371 km. Every affected inbound and outbound lane is recalculated; connectivity, product eligibility and capacity are retained.",
                            "The selected tariff assumption supplies new lane rates and transit times; the same MILP then reassigns flows, checks service/capacity and recomputes transport, inventory and emissions.",
                            "Annual fixed cost replaces the old site's recurring fixed cost only if entered. Implementation costs are added separately once and are not hidden inside the solver's operating-cost total."],
            "limitations": ["Planning estimate, not verified road routing, truck access, property availability, land-use permission or a construction assessment.",
                            "Capacity and the original lane connections are held constant. No new customer address, lane, labour supply, utility capacity or downtime effect is invented.",
                            "Heatmap and proximity use uploaded demand, not the demand forecast. Unmapped demand is disclosed and excluded from geographic scoring.",
                            "Implementation totals cover only the entered categories; financing, tax, working capital, ramp-up and disruption losses require separate due diligence."]}


def apply_relocation(network, facility_id, spec):
    trace = relocation_inputs(network, facility_id, spec)
    result = network.model_copy(deep=True)
    for facility in result.facilities:
        if facility.id == facility_id:
            facility.latitude, facility.longitude = spec.latitude, spec.longitude
            facility.fixed_cost_per_year = trace["new_annual_fixed_cost"]
    for row in trace["lanes"]:
        result.lanes[row["lane_index"]] = result.lanes[row["lane_index"]].model_copy(update={
            **row["after"], "distance_method": DistanceMethod.ESTIMATED})
    result.scenario_calculation_context = {"relocation": trace}
    return result, [f"MOVE_FACILITY {facility_id} from {trace['from']} to {trace['to']}; {len(trace['lanes'])} lanes recalculated with {spec.tariff_model}"]


def implementation_impact(trace, baseline_cost, scenario_cost):
    assumptions = trace["assumptions"]
    lines = [{"id": key, "label": label, "value": assumptions.get(key), "source": assumptions.get("cost_source")}
             for key, label in COST_ITEMS.items()]
    complete = all(line["value"] is not None for line in lines)
    one_time = sum(line["value"] for line in lines) if complete else None
    delta = scenario_cost - baseline_cost if baseline_cost is not None and scenario_cost is not None else None
    return {"items": lines, "complete": complete, "one_time_cost": one_time,
            "network_cost_change": delta,
            "scenario_plus_implementation": scenario_cost + one_time if scenario_cost is not None and complete else None,
            "net_horizon_impact": delta + one_time if delta is not None and complete else None,
            "basis": "Same modeled planning horizon as the comparison. One-time implementation costs are added once. Blank costs are unknown, not zero. No annualization or payback is inferred."}
