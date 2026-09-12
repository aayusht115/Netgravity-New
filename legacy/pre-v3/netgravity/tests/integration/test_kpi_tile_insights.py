"""Tile insights: scope, distinct evidence, numerical fidelity, fail-closed AI."""
from copy import deepcopy
from types import SimpleNamespace

import pytest
from flask import Flask

from app.backend.api import kpi_tile_insights as module
from app.backend.services.errors import ForbiddenError, UnauthenticatedError


def row(fid='LOW', **extra):
    values = dict(facility_id=fid, facility_name=fid+' centre', role='DC', is_open=True,
        health_band='UNDERUSED', avg_utilization_pct=10, peak_utilization_pct=20,
        peak_period='2', rated_capacity_per_period=100, avg_throughput_units=10,
        peak_throughput_units=20, headroom_units_peak=80, total_facility_cost=100,
        fixed_cost=70, handling_cost=20, holding_cost=10, opening_cost=0,
        avg_inventory_units=0, peak_inventory_units=0)
    values.update(extra)
    return values


@pytest.fixture
def analysis():
    return dict(currency='USD', data_version='v1', computed_at=123,
        warehouse={'health_kpis': [row(), row('HIGH', health_band='TIGHT', avg_utilization_pct=50,
            peak_utilization_pct=95, peak_throughput_units=95, headroom_units_peak=5)]},
        horizon={'periods_modelled': 12, 'period_labels': {'1': '2026-01', '2': '2026-02'},
                 'by_facility': {'LOW': {'utilisation': {'1': 12}, 'throughput': {'1': 12}}}},
        flows=[dict(origin_id='LOW', destination_id='CUSTOMER', flow_units=1200,
                    flow_units_per_period=100, carbon_kg=240, transport_cost=600)])


def text(items):
    return ' '.join(i['title']+' '+i['evidence']+' '+i['action'] for i in items)


@pytest.mark.parametrize('tile', sorted(module.TILES))
def test_every_tile_has_scoped_evidence(tile, analysis):
    items = module.tile_candidates(analysis, tile, 'LOW' if tile.startswith('facility-') else None,
        '2026-01', [dict(origin_id='LOW', destination_id='CUSTOMER', lead_time_days=2)])
    assert 1 <= len(items) <= 12
    assert all(set(i) >= {'title', 'evidence', 'action'} for i in items)
    if tile.startswith('facility-'):
        assert all(i.get('facility_id') == 'LOW' for i in items)
        assert 'HIGH centre' not in text(items)


def test_utilisation_covers_hidden_peak_and_consolidation(analysis):
    items = module.tile_candidates(analysis, 'utilisation')
    assert 'Seasonal pressure hidden' in items[0]['title']
    assert '50%' in items[0]['evidence'] and '95%' in items[0]['evidence']
    assert '5 units/period' in items[0]['evidence']
    assert items[1]['facility_id'] == 'LOW'
    assert 'Low utilisation even at peak' in items[1]['title']
    assert 'no saving is established' in items[1]['action']


def test_spend_share_includes_all_sites(analysis):
    analysis['warehouse']['health_kpis'] = [row(str(i)) for i in range(20)]
    analysis['warehouse']['top_facilities_driving_cost'] = [row(str(i)) for i in range(10)]
    items = module.tile_candidates(analysis, 'spend')
    assert '5.0%' in items[0]['evidence']
    assert '2,000 USD' in items[0]['evidence']


def test_mix_counts_closed_sites(analysis):
    analysis['warehouse']['health_kpis'].append(row('CLOSED', is_open=False, health_band='NOT_OPERATING'))
    items = module.tile_candidates(analysis, 'mix')
    assert len(items) == 3
    assert all('1 of 3 facilities (33.3%)' in i['evidence'] for i in items)


def test_stock_missing_is_not_zero(analysis):
    analysis['warehouse']['health_kpis'][1].update(avg_inventory_units=None, peak_inventory_units=None)
    items = module.tile_candidates(analysis, 'stock')
    assert '1 of 2 facilities' in items[0]['evidence']
    assert 'Missing inventory is not zero' in items[0]['evidence']
    assert 'Average 0 units; peak 0 units' in items[1]['evidence']


def test_closed_site_is_not_spare_capacity(analysis):
    analysis['warehouse']['health_kpis'][0]['is_open'] = False
    item = module.tile_candidates(analysis, 'facility-utilisation', 'LOW')[0]
    assert 'not operating' in item['title']
    assert 'zero load is not healthy' in item['evidence']


def test_period_uses_actual_series(analysis):
    item = module.tile_candidates(analysis, 'facility-utilisation', 'LOW', '2026-01')[0]
    assert '2026-01: 12%' in item['evidence']
    missing = module.tile_candidates(analysis, 'facility-utilisation', 'LOW', '2040-01')
    assert any('Selected period not modelled' == i['title'] for i in missing)


def test_carbon_denominators_match(analysis):
    item = module.tile_candidates(analysis, 'facility-carbon', 'LOW')[0]
    assert '240 kg CO₂e / 1,200 horizon lane-flow units = 0.2' in item['evidence']
    assert 'not per customer unit' in item['evidence']


def test_small_carbon_intensity_is_not_rounded_to_zero(analysis):
    analysis['flows'][0]['carbon_kg'] = 3.48
    item = module.tile_candidates(analysis, 'facility-carbon', 'LOW')[0]
    assert '= 0.0029 kg' in item['evidence']


def test_partial_carbon_is_not_a_whole_scope_intensity(analysis):
    analysis['flows'].append(dict(origin_id='HIGH', destination_id='LOW', flow_units=1000, carbon_kg=None))
    item = module.tile_candidates(analysis, 'facility-carbon', 'LOW')[0]
    assert '1 of 2' in item['evidence']
    assert 'cannot be calculated' in item['evidence']


def test_lead_time_is_flow_weighted_and_not_end_to_end(analysis):
    analysis['flows'].append(dict(origin_id='HIGH', destination_id='LOW', flow_units=400))
    lanes = [dict(origin_id='LOW', destination_id='CUSTOMER', lead_time_days=2),
             dict(origin_id='HIGH', destination_id='LOW', lead_time_days=10)]
    item = module.tile_candidates(analysis, 'facility-lead', 'LOW', lanes=lanes)[0]
    assert '4 days' in item['evidence']
    assert 'not end-to-end' in item['evidence']


def test_facility_cost_does_not_invent_components(analysis):
    items = module.tile_candidates(analysis, 'facility-costs', 'LOW')
    assert '100 USD (50.0%' in items[0]['evidence']
    assert 'transport is excluded' in items[0]['evidence']
    assert '580,000' not in text(items)
    assert 'Surcharge' not in text(items)


def test_no_rows_does_not_claim_healthy():
    items = module.tile_candidates({}, 'health')
    assert items[0]['title'] == 'No solved facility evidence'


def test_no_llm_is_disclosed(monkeypatch, analysis):
    monkeypatch.setenv('NETGRAVITY_DISABLE_LLM', 'true')
    items = module.tile_candidates(analysis, 'spend')
    returned, mode, disclosure = module.prioritise_candidates(items)
    assert returned == items[:3] and mode == 'evidence_rules'
    assert 'no AI-generated claims' in disclosure


@pytest.mark.parametrize('ids', [[1, 0], [0, 0], [True, 1], [999, 0], ['0', 1], []])
def test_ai_can_only_select_unique_existing_ids(monkeypatch, analysis, ids):
    monkeypatch.delenv('NETGRAVITY_DISABLE_LLM', raising=False)
    from netgravity.ingestion.ai import client as client_module
    from netgravity.ingestion import config as config_module
    config = SimpleNamespace(stub_mode=False, llm_timeout_seconds=60, llm_max_retries=3, llm_strict=False)
    monkeypatch.setattr(config_module, 'load_config', lambda: config)
    response = SimpleNamespace(stubbed=False, failed=False, data={'candidate_ids': ids,
        'invented_text': 'Save 9000 dollars now'})
    monkeypatch.setattr(client_module, 'get_client', lambda _: SimpleNamespace(extract_json=lambda **kwargs: response))
    items = module.tile_candidates(analysis, 'spend')
    actual, mode, _ = module.prioritise_candidates(items)
    if ids == [1, 0]:
        assert actual == [items[1], items[0]] and mode == 'ai'
    else:
        assert actual == items and mode == 'evidence_rules'
    assert '9000' not in text(actual)


@pytest.fixture
def client(monkeypatch, analysis):
    from app.backend.services import security
    def authenticate(token):
        if token != 'test-token':
            raise UnauthenticatedError('Authentication required')
        return SimpleNamespace(user_id='owner')
    def resolve(project_id, user_id):
        if project_id != 'owned' or user_id != 'owner':
            raise ForbiddenError('Not your project')
        return 'snapshot1'
    monkeypatch.setattr(security.auth_service, 'resolve_session', authenticate)
    monkeypatch.setattr(module.project_registry, 'snapshot_for', resolve)
    monkeypatch.setattr(module.analysis_service, 'get', lambda *a, **k: deepcopy(analysis))
    monkeypatch.setenv('NETGRAVITY_DISABLE_LLM', 'true')
    network = SimpleNamespace(facilities=[SimpleNamespace(id='LOW'), SimpleNamespace(id='HIGH')], lanes=[])
    snapshot = SimpleNamespace(data_version='v1', network=network)
    orchestrator = SimpleNamespace(snapshots=SimpleNamespace(get=lambda _: snapshot))
    app = Flask(__name__)
    app.config['TESTING'] = True
    app.register_blueprint(module.create_kpi_tile_insights_blueprint(orchestrator))
    with app.test_client() as c:
        yield c


AUTH = {'Authorization': 'Bearer test-token'}


def test_endpoint_auth_scope_provenance(client):
    body = dict(project_id='owned', tile='facility-cost', facility_id='LOW')
    assert client.post('/api/kpi-tile-insights', json=body).status_code == 401
    assert client.post('/api/kpi-tile-insights', json={**body, 'project_id': 'another-project'}, headers=AUTH).status_code == 403
    response = client.post('/api/kpi-tile-insights', json=body, headers=AUTH)
    assert response.status_code == 200
    payload = response.get_json()
    assert payload['data_version'] == 'v1'
    assert payload['basis']['snapshot_id'] == 'snapshot1'
    assert payload['basis']['computed_at'] == 123
    assert payload['mode'] == 'evidence_rules'
    assert 1 <= len(payload['insights']) <= 3


@pytest.mark.parametrize('body,status', [
    ({'project_id': 'owned', 'tile': 'bogus'}, 400),
    ({'project_id': 'owned', 'tile': 'facility-utilisation'}, 400),
    ({'project_id': 'owned', 'tile': 'facility-utilisation', 'facility_id': 'OTHER'}, 404),
    ({'project_id': 'owned', 'tile': 'spend', 'measurements': {'cost': 9999}}, 400),
    ({'project_id': 'owned', 'tile': ['spend']}, 400),
    ({'project_id': 'owned', 'tile': 'spend', 'period': 'x'*201}, 400),
    ([], 400),
])
def test_endpoint_rejects_untrusted_scope_and_numbers(client, body, status):
    assert client.post('/api/kpi-tile-insights', json=body, headers=AUTH).status_code == status


def test_cookie_auth_requires_csrf(client):
    client.set_cookie('ng_session', 'test-token')
    response = client.post('/api/kpi-tile-insights', json={'project_id': 'owned', 'tile': 'spend'})
    assert response.status_code == 403


def test_candidates_consume_a_real_authoritative_solve(monkeypatch):
    from netgravity.orchestrator.registry import build_orchestrator
    from netgravity.tests.fixtures.case16_synthetic import build_case16_network
    monkeypatch.setenv('NETGRAVITY_DISABLE_LLM', 'true')
    orchestrator = build_orchestrator(enable_llm=False)
    snapshot = orchestrator.snapshots.register(build_case16_network(), label='tile-insight-test')
    response = orchestrator.run_sync(module.OrchestratorRequest(input='baseline',
        explicit_intent=module.Intent.NETWORK_STATE_QUERY,
        actor=module.Actor(actor_id='test-user', role=module.ActorRole.PLANNER),
        network_snapshot_id=snapshot.snapshot_id, disable_llm=True))
    evidence = module.serialise_analysis(module.KPIRegistry(), orchestrator.get_execution_state(response.execution_id))
    assert evidence['warehouse']['health_kpis']
    fid = evidence['warehouse']['health_kpis'][0]['facility_id']
    lanes = [dict(origin_id=l.origin_id, destination_id=l.destination_id, lead_time_days=l.lead_time_days)
             for l in snapshot.network.lanes]
    for tile in module.TILES:
        candidates = module.tile_candidates(evidence, tile, fid if tile.startswith('facility-') else None, lanes=lanes)
        items, mode, _ = module.prioritise_candidates(candidates)
        assert 1 <= len(items) <= 3, tile
        assert mode == 'evidence_rules'
        assert 'NaN' not in text(items) and 'undefined' not in text(items)
