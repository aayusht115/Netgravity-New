"""Cross-replica invalidation for Blob-backed process-local registries.

Domain records remain fast in memory, but Azure Blob Storage is the source of
truth. Each tracked Blob write advances one entry in a compact change vector.
Before serving a request, a replica compares that vector with the one it last
applied and refreshes only the affected registry group.

The synchronizer is deliberately hosting-layer code: domain stores expose
``refresh``/``restore`` seams and remain unaware of Azure or Flask.
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Callable, Dict, Mapping, Tuple

from flask import jsonify

logger = logging.getLogger(__name__)

RefreshBinding = Tuple[str, Callable[[], Any]]


class ReplicaSynchronizer:
    """Apply a shared collection change vector to one worker's registries."""

    def __init__(self, database: Any,
                 refreshers: Mapping[str, RefreshBinding]) -> None:
        self._database = database
        self._refreshers = dict(refreshers)
        self._lock = threading.RLock()
        # Start empty even though startup just hydrated every store. A write
        # can race between that hydration and this object being constructed;
        # treating the current vector as already applied would lose exactly
        # that event. The first request re-applies any existing tokens once.
        self._seen: Dict[str, str] = {}

    @property
    def watched_collections(self) -> list[str]:
        return sorted(self._refreshers)

    def sync_if_changed(self) -> Dict[str, Any]:
        """Refresh every registry group changed since this worker last read it.

        A second vector read closes the race where another replica commits
        while this one is rehydrating. Three bounded passes keep a continuously
        busy writer from holding an unrelated request forever; any remaining
        change is intentionally left unseen and is picked up next request.
        """
        refreshed: Dict[str, Any] = {}
        with self._lock:
            for _ in range(3):
                current = dict(self._database.change_vector())
                changed = {
                    collection
                    for collection in self._refreshers
                    if current.get(collection) != self._seen.get(collection)
                }
                if "network_data" in changed:
                    changed = {
                        collection for collection in changed
                        if not collection.startswith("network_data:")
                    }
                if not changed:
                    break

                # users+sessions share one AuthService refresh, while all
                # network_data kinds share one upload-store refresh. Deduping
                # by binding name avoids listing the same blobs twice.
                planned: Dict[str, Callable[[], Any]] = {}
                for collection in sorted(changed):
                    name, refresh = self._refreshers[collection]
                    planned[name] = refresh

                pass_results = {
                    name: refresh()
                    for name, refresh in planned.items()
                }
                refreshed.update(pass_results)
                self._seen = current

                if dict(self._database.change_vector()) == current:
                    break

        if refreshed:
            logger.info("replica_sync.refreshed groups=%s", sorted(refreshed))
        return refreshed


def install(app: Any, orchestrator: Any) -> Dict[str, Any]:
    """Install request-time registry synchronization on a Flask application."""
    from app.backend.services import persistence

    database = persistence.database
    if (getattr(database, "kind", "") != "azure_blob"
            or not callable(getattr(database, "change_vector", None))):
        return {
            "enabled": False,
            "reason": "only required for the Azure Blob backend",
        }

    from app.backend.services.analysis_store import analysis_service
    from app.backend.services.dataset_store import dataset_store
    from app.backend.services.demand_history_store import (
        capacity_history_store,
        demand_history_store,
        uploaded_forecast_store,
        uploaded_signal_store,
    )
    from app.backend.services.project_registry import project_registry
    from app.backend.services.security import auth_service

    def refresh_network_data() -> int:
        counts = [
            demand_history_store.refresh(),
            uploaded_signal_store.refresh(),
            capacity_history_store.refresh(),
            uploaded_forecast_store.refresh(),
            dataset_store.refresh(),
        ]
        if orchestrator is not None:
            counts.append(orchestrator.twin.store.restore())
        return sum(counts)

    scenario_blueprint = app.blueprints.get("scenarios")
    refresh_api_scenarios = getattr(
        scenario_blueprint, "netgravity_refresh", lambda: 0
    )

    refreshers: Dict[str, RefreshBinding] = {
        "users": ("auth", auth_service.refresh),
        "sessions": ("auth", auth_service.refresh),
        "projects": ("projects", project_registry.refresh),
        # ``network_data`` is retained as a compatibility fallback for a
        # change vector written by the first version of replica sync. New
        # writes publish a kind-specific scope and reload only that store.
        "network_data": ("network_data", refresh_network_data),
        "network_data:demand_history": (
            "demand_history", demand_history_store.refresh
        ),
        "network_data:signals": ("signals", uploaded_signal_store.refresh),
        "network_data:capacity_history": (
            "capacity_history", capacity_history_store.refresh
        ),
        "network_data:dataset": ("datasets", dataset_store.refresh),
        "network_data:uploaded_forecast": (
            "uploaded_forecast", uploaded_forecast_store.refresh
        ),
        "analyses": ("analyses", analysis_service.refresh),
        "scenarios": ("api_scenarios", refresh_api_scenarios),
    }
    if orchestrator is not None:
        refreshers.update({
            "network_data:twin_state": (
                "twin_states", orchestrator.twin.store.restore
            ),
            "snapshots": ("snapshots", orchestrator.snapshots.restore),
            "scenario_networks": (
                "scenario_networks", orchestrator.scenarios.restore
            ),
        })

    synchronizer = ReplicaSynchronizer(database, refreshers)
    app.extensions["netgravity_replica_sync"] = synchronizer

    @app.before_request
    def _refresh_replica_registries():
        try:
            synchronizer.sync_if_changed()
        except Exception as exc:  # noqa: BLE001
            # Serving a known-stale ownership/auth/network registry would be
            # worse than a visible transient failure. Blob access is already a
            # production dependency, so expose the outage honestly as a 503.
            logger.exception("replica_sync.failed")
            return jsonify({
                "error": {
                    "code": "REGISTRY_SYNC_UNAVAILABLE",
                    "message": (
                        "Durable state could not be synchronized on this "
                        "replica. Retry the request."
                    ),
                    "context": {"type": type(exc).__name__},
                }
            }), 503
        return None

    return {
        "enabled": True,
        "strategy": "azure_blob_change_vector",
        "watched_collections": synchronizer.watched_collections,
    }
