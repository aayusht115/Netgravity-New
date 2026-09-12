"""Exercise the merged app through Next's HTTP proxy against the isolated QA server.

Start scripts/run-kpi-review.py with both fixture flags first. This creates
test projects/scenarios only on loopback; it refuses non-local destinations.
"""
from __future__ import annotations

import argparse
import io
import sys
import uuid
import zipfile
from pathlib import Path
from urllib.parse import urlparse

import pandas as pd
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from netgravity.tests.test_normalised_upload import normalised_tables

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--url', default='http://127.0.0.1:3017')
args = parser.parse_args()
url = args.url.rstrip('/')
parsed = urlparse(url)
if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.path:
    parser.error('Only a loopback HTTP QA server is permitted.')
session = requests.Session()


def call(method, path, *, status=200, **kwargs):
    response = session.request(method, url + path, timeout=180, **kwargs)
    assert response.status_code == status, (path, response.status_code, response.text[:800])
    print(f'{response.status_code} {method} {path}', flush=True)
    return response


call('GET', '/')
call('GET', '/api/network/demand-surface', status=401)
call('POST', '/api/auth/login', json={
    'email': 'kpi-review@example.test', 'password': 'LocalKpiReview!2026'})
session.headers['X-CSRF-Token'] = session.cookies['ng_csrf']
assert call('GET', '/api/auth/me').json()['user']['email'] == 'kpi-review@example.test'
projects = call('GET', '/api/projects').json()['projects']
project = next(p for p in projects if p['name'] == 'Location QA — synthetic network')
scope = {'project_id': project['id']}
structure = call('GET', '/api/network/structure', params=scope).json()
for path in ('network', 'facilities', 'flows', 'warehouse'):
    call('GET', '/api/kpis/' + path, params=scope)
call('GET', '/api/insights', params={**scope, 'scope': 'NETWORK'})
surface = call('GET', '/api/network/demand-surface', params=scope).json()
assert surface['demand']['total_quantity'] == 630
assert surface['demand']['mapped_quantity'] == 630
call('GET', '/api/network/demand-surface', params={**scope, 'snapshot_id': 'stale'}, status=409)
forecast = call('GET', '/api/forecast', params={**scope, 'horizon': 6}).json()
assert forecast['status'] == 'OK', forecast
assert forecast['series'], forecast


def document(path):
    response = call('GET', path, params=scope)
    assert 'wordprocessingml' in response.headers['content-type']
    with zipfile.ZipFile(io.BytesIO(response.content)) as package:
        assert len(package.read('word/document.xml')) > 1000


document('/api/forecast/document')
scenario = call('POST', '/api/scenarios/simulate', status=201, json={
    **scope, 'name': 'V3 local smoke: 5% demand growth', 'action': 'CHANGE_DEMAND',
    'demand_multiplier': 1.05}).json()
assert scenario['feasible'] is True, scenario
assert scenario['recommended_actions'], scenario
document(f"/api/scenarios/{scenario['id']}/document")
call('GET', '/api/scenarios/' + scenario['id'], params=scope)
call('GET', '/api/scenarios', params=scope)

# Parse and confirm a new workbook, proving the UI upload route does not rely
# on the server's seeded network. The fixture is deliberately small and named.
upload_project = call('POST', '/api/projects', status=201, json={
    'name': 'V3 upload smoke ' + uuid.uuid4().hex[:6],
    'description': 'Synthetic test workbook, generated locally.'}).json()
upload_scope = {'project_id': upload_project['id']}
workbook = io.BytesIO()
with pd.ExcelWriter(workbook, engine='openpyxl') as writer:
    for sheet, table in normalised_tables.__wrapped__().items():
        table.to_excel(writer, sheet_name=sheet, index=False)
preview = call('POST', '/api/ingestions/preview/upload-and-parse',
               data=upload_scope, files={'files': ('synthetic-v3-qa.xlsx', workbook.getvalue(),
               'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')}).json()
assert preview['status'] == 'PREVIEW' and not preview['parse_errors'], preview
bound = call('POST', '/api/ingestions/preview/commit', status=201, json=upload_scope).json()
assert bound['status'] == 'BOUND' and bound['network_summary']['facilities'] == 6, bound
assert bound['network_summary']['demand_history_series'] == 4, bound
heat = call('GET', '/api/network/demand-surface', params=upload_scope).json()
assert heat['snapshot_id'] == bound['snapshot_id']
assert heat['demand']['mapped_quantity'] == heat['demand']['total_quantity'] > 0
assert len(heat['demand']['points']) == 2
call('GET', '/api/kpis/network', params=upload_scope)
call('GET', '/api/forecast', params=upload_scope)
assert call('GET', '/api/network/demand-surface', params=scope).json() == surface
print('PASS: Next proxy, cookie auth, isolation, upload/commit, KPIs, insights, demand heat, forecast, scenario and DOCX responses.')
