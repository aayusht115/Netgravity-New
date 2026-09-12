"""Isolated, synthetic browser-QA server; never connects to Azure or sends mail.

Run with .venv/bin/python scripts/run-kpi-review.py. This in-memory test store
is disposable and does not change the production Azure Blob architecture.
"""
import os
import sys
import argparse
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--with-demand-history', action='store_true')
parser.add_argument('--with-location-data', action='store_true')
parser.add_argument('--port', type=int, default=5053)
options = parser.parse_args()
os.environ.update({
    "NETGRAVITY_STATE_BACKEND": "sqlite", "NETGRAVITY_DB_PATH": ":memory:",
    "NETGRAVITY_STORAGE_BACKEND": "local", "NETGRAVITY_SEED_DEMO": "0",
    "NETGRAVITY_ENV": "development", "NETGRAVITY_KPI_MONITOR_WORKER": "false",
    "NETGRAVITY_DATA_ROOT": tempfile.mkdtemp(prefix="netgravity-v3-review-"),
    "NETGRAVITY_DATABASE_URL": "", "DATABASE_URL": "",
    "TEXT_API_TOKEN": "", "NETGRAVITY_LLM_API_KEY": "", "NETGRAVITY_OPENAI_API_KEY": "",
    "NETGRAVITY_ANTHROPIC_API_KEY": "", "OPENAI_API_KEY": "",
    "NETGRAVITY_SMTP_HOST": "", "NETGRAVITY_EMAIL_API_KEY": "",
})
from app.backend.app import app
from app.backend.services.security import auth_service
from app.backend.services.project_registry import project_registry
from netgravity.tests.integration.test_warehouse_deep_dive import _network

user = auth_service.register(email="kpi-review@example.test", password="LocalKpiReview!2026", name="KPI review fixture")
project = project_registry.create(name=("Location QA — synthetic network" if options.with_location_data else "Forecast QA — synthetic demand history" if options.with_demand_history else "KPI QA — synthetic seasonal network"), owner_id=user.user_id,
    description="Local test fixture only; not customer data")
network = _network()
if options.with_location_data:
    network = _network(periods=[200, 220], inventory=True)
    points = {"PLANT": (33.7, -85), "DC_N": (33.75, -84.4), "DC_S": (32.8, -83.6),
              "DC_NEW": (33, -82.8), "MKT_N": (34, -84), "MKT_S": (32.4, -83.2)}
    for facility in network.facilities:
        facility.latitude, facility.longitude = points[facility.id]
    network.currency = "USD"
network.facilities[1].name = "Atlanta Southeast Gateway DC (test)"
network.facilities[2].name = "Dallas Regional DC (test)"
network.facilities[2].capacity_units_per_period = 2000
project_registry.bind_network(project.project_id, network, user_id=user.user_id, label="Synthetic seasonal QA")
if options.with_demand_history:
    from app.backend.services.demand_history_store import demand_history_store
    from netgravity.forecasting import DemandPoint, DemandTimeSeries, Frequency
    demand_history_store.put(network.network_id, [
        DemandTimeSeries(market_id=market, product_id="P1", frequency=Frequency.MONTH,
            history=[DemandPoint(period=i + 1, quantity=value,
                timestamp=f"{2024 + i // 12}-{i % 12 + 1:02d}-01") for i, value in enumerate(values)])
        for market, values in [
            ("MKT_N", [320 + i * 7.25 + [0, 12, -8, 10, 0, -6][i % 6] for i in range(24)]),
            ("MKT_S", [0, 0, 130, 0, 100, 0, 0, 140, 0, 0, 125, 0] * 2),
        ]
    ])
app.run(host="127.0.0.1", port=options.port, debug=False)
