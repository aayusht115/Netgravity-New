"""Integration boundaries: team v3 data, Atlas view, and existing Blob durability."""
from types import SimpleNamespace

import pytest
from flask import Flask, jsonify

from app.backend.api import network_structure as module
from app.backend.services import security
from app.backend.services.twin_demand import demand_surface
from netgravity.tests.integration.test_warehouse_deep_dive import _network


@pytest.fixture
def network():
    value = _network(periods=[200, 220])
    for facility in value.facilities:
        if facility.id == "MKT_N":
            facility.latitude, facility.longitude = 34, -84
    return value


def test_heatmap_sums_input_rows_and_discloses_unmapped_demand(network):
    original = network.model_dump(mode="json")
    data = demand_surface(network)
    expected = sum(row.quantity for row in network.demands)
    assert data["total_quantity"] == pytest.approx(expected)
    assert data["mapped_quantity"] + sum(p["quantity"] for p in data["omitted"]) == pytest.approx(expected)
    assert [p["id"] for p in data["points"]] == ["MKT_N"]
    assert [p["id"] for p in data["omitted"]] == ["MKT_S"]
    assert network.model_dump(mode="json") == original


def test_heatmap_empty_is_not_zero_coverage(network):
    network.demands = []
    data = demand_surface(network)
    assert data["points"] == [] and data["coverage_pct"] is None


@pytest.fixture
def client(monkeypatch, network):
    def snapshot_for(project_id, *, user_id):
        if project_id != "owned" or user_id != "owner":
            from app.backend.services.errors import ForbiddenError
            raise ForbiddenError("This project belongs to another user.")
        return "snapshot-v3"
    monkeypatch.setattr(module.project_registry, "snapshot_for", snapshot_for)
    def resolve(token):
        if token != "fixture":
            from app.backend.services.errors import UnauthenticatedError
            raise UnauthenticatedError("Authentication required.")
        return SimpleNamespace(user_id="owner")
    monkeypatch.setattr(security.auth_service, "resolve_session", resolve)
    orch = SimpleNamespace(snapshots=SimpleNamespace(get=lambda _: SimpleNamespace(network=network)))
    app = Flask(__name__)
    from app.backend.services.errors import ApplicationError
    app.register_error_handler(ApplicationError, lambda exc: (jsonify(exc.to_payload()), exc.http_status))
    app.register_blueprint(module.create_network_structure_blueprint(orch))
    return app.test_client()


def test_demand_endpoint_requires_authentication(client):
    assert client.get("/api/network/demand-surface?project_id=owned").status_code == 401


@pytest.mark.parametrize("query,status", [
    ("project_id=owned&snapshot_id=snapshot-v3", 200),
    ("project_id=someone-elses", 403),
    ("project_id=owned&snapshot_id=stale", 409),
    ("", 400),
])
def test_demand_endpoint_is_owner_and_snapshot_bound(client, query, status):
    response = client.get("/api/network/demand-surface?" + query,
                          headers={"Authorization": "Bearer fixture"})
    assert response.status_code == status, response.get_json()
    if status == 200:
        assert response.json["snapshot_id"] == "snapshot-v3"
        assert response.json["demand"]["mapped_quantity"] > 0


def test_uploaded_forecast_refresh_replaces_previous_replica_view():
    from app.backend.services.demand_history_store import UploadedForecastStore
    store = UploadedForecastStore()
    records = {"network": [{"marketId": "M", "period": "2027-01", "quantity": 10}]}
    store.bind_persistence(lambda *args: None, lambda: records)
    assert store.refresh() == 1
    assert store.get("network")[0]["quantity"] == 10
    records.clear()
    assert store.refresh() == 0
    assert not store.has("network")
