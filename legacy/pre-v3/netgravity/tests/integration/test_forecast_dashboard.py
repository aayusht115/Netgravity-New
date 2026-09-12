"""The dashboard receives the selected series' own modelling evidence."""
from app.backend.api.forecast import _serialise_series
import pytest
from netgravity.forecasting import (
    DemandPoint, DemandTimeSeries, ForecastingService, ForecastRequest, Frequency,
)


def test_series_carries_frequency_validation_warnings_and_fitted_window():
    result = ForecastingService().forecast(ForecastRequest(
        snapshot_id="forecast-dashboard-test", horizon=3, run_backtest=True,
        series=[DemandTimeSeries(market_id="M", product_id="P", frequency=Frequency.WEEK,
            history=[DemandPoint(period=i + 1, quantity=100.125 + i * 2.25) for i in range(24)])],
    ))
    series = result.series[0]
    payload = _serialise_series(series)
    assert payload["frequency"] == "WEEK"
    assert {k:v for k,v in payload["accuracy"].items() if k != "calculation_trace"} == series.accuracy.model_dump(mode="json")
    assert payload["accuracy"]["calculation_trace"] == series.accuracy.calculation_trace
    assert payload["warnings"] == series.warnings
    assert payload["regime"] == series.regime.model_dump(mode="json")
    assert payload["points"][0]["mean"] == series.points[0].mean
    assert payload["pattern"] == series.pattern.value


def test_unmeasured_accuracy_is_never_manufactured():
    from netgravity.forecasting import SeriesForecast, ForecastStatus
    row = _serialise_series(SeriesForecast(market_id="M", product_id="P",
        status=ForecastStatus.INSUFFICIENT_HISTORY, warnings=["Observed history is too short"]))
    assert row["points"] == []
    assert row["accuracy"] is None
    assert row["regime"] is None
    assert row["warnings"] == ["Observed history is too short"]


@pytest.mark.parametrize("horizon", [3, 6, 12])
def test_api_horizon_reaches_real_forecaster_and_its_provenance(monkeypatch, horizon):
    from flask import Flask
    from types import SimpleNamespace
    from app.backend.api import forecast as module
    from app.backend.services import security
    from netgravity.orchestrator import build_orchestrator
    from netgravity.tests.integration.test_forecasting import _delhi_history, _history_provider
    from netgravity.tests.integration.conftest import build_delhi_network
    history = _delhi_history()
    orch = build_orchestrator(network=build_delhi_network(), enable_llm=False,
        history_provider=_history_provider(history))
    monkeypatch.setattr(security.auth_service, "resolve_session", lambda token: SimpleNamespace(user_id="owner"))
    monkeypatch.setattr(module.project_registry, "snapshot_for", lambda *args, **kwargs: orch.snapshots.current_id)
    monkeypatch.setattr(module.demand_history_store, "for_snapshot", lambda snapshot: (history, []))
    monkeypatch.setattr(module, "_uploaded_signals_for", lambda *args: ([], []))
    app = Flask(__name__)
    app.register_blueprint(module.create_forecast_blueprint(orch))
    with app.test_client() as client:
        response = client.get(f"/api/forecast?project_id=owned&horizon={horizon}",
            headers={"Authorization": "Bearer test-token"})
    payload = response.get_json()
    assert response.status_code == 200, payload
    assert payload["horizon"] == horizon
    assert any(row["status"] == "OK" for row in payload["series"])
    assert all(len(row["points"]) == (horizon if row["status"] == "OK" else 0) for row in payload["series"])
    assert payload["outlook"]["horizon"] == horizon
    ctx = orch.get_execution_state(payload["execution_id"])
    assert ctx.forecast_horizon == horizon
    assert ctx.forecast_result.provenance.horizon == horizon


@pytest.mark.parametrize("horizon", [0, 13, 24, -1, 1.5, True, "12"])
def test_structured_horizon_is_bounded_and_strict(horizon):
    from pydantic import ValidationError
    from netgravity.orchestrator.schemas.requests import OrchestratorRequest
    with pytest.raises(ValidationError):
        OrchestratorRequest(forecast_horizon=horizon)
