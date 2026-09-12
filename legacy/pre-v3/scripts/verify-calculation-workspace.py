"""Exercise the isolated QA server. Never reads or writes production data.

Use the bundled artifact Python with --word for a renderable report sample.
"""
import argparse
import json
import sys
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--port', type=int, default=5055)
parser.add_argument('--word', action='store_true')
parser.add_argument('--output', default='validation/calculation_workspace_2026_09_09')
args = parser.parse_args()
origin = f'http://127.0.0.1:{args.port}'
token = ''


def api(path, body=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    req = Request(origin + path, headers=headers,
                  data=json.dumps(body).encode() if body is not None else None)
    with urlopen(req, timeout=180) as response:
        return json.load(response)


token = api('/api/auth/login', {'email': 'kpi-review@example.test', 'password': 'LocalKpiReview!2026'})['token']
project = api('/api/projects')['projects'][0]
assert 'QA' in project['name'], 'This harness must only run against an isolated QA fixture'
query = urlencode({'project_id': project['id'] if 'id' in project else project['project_id']})
project_id = project.get('project_id', project.get('id'))
forecast = api('/api/forecast?' + query + '&horizon=3')
report = api(forecast['calculation_path'] + '?' + query + '&series_id=MKT_S%2FP1')
assert report['execution_id'] == forecast['execution_id']
series = next(s for s in forecast['series'] if s['market_id'] == 'MKT_S')
assert report['metrics'][0]['value'] == sum(p['mean'] for p in series['points'])
baseline = api('/api/kpis/calculations?' + query)
costs = baseline['metrics'][0]
assert abs(sum(c['value'] for c in costs['inputs'] if c['included']) - costs['value']) < .001
scenario = api('/api/scenarios/simulate', {'project_id': project_id, 'name': 'QA demand growth',
               'action': 'CHANGE_DEMAND', 'demand_multiplier': 1.15})
scenario_report = api('/api/scenarios/' + scenario['id'] + '/calculations?' + query)
assert scenario_report['execution_id'] == scenario['execution_id']
briefing = api('/api/scenarios/' + scenario['id'] + '/briefing?' + query)
assert briefing['scenario_id'] == scenario['id']
assert briefing['status'] == 'AI_UNAVAILABLE', 'The QA server must never send an AI request'
assert not briefing['recommendations']
assert '15% increase in demand' in briefing['summary']['description']
transport = api('/api/scenarios/simulate', {'project_id': project_id, 'name': 'QA transport reduction',
                'action': 'CHANGE_TRANSPORT_COST', 'transport_cost_multiplier': .9})
transport_briefing = api('/api/scenarios/' + transport['id'] + '/briefing?' + query)
assert transport_briefing['scenario_id'] == transport['id']
assert '10% decrease in transport rates' in transport_briefing['summary']['description']
assert transport_briefing['findings'] != briefing['findings']
from app.backend.services.calculation_export import build_word, leaves
print(json.dumps({'forecast_run': forecast['execution_id'], 'scenario': scenario['id'],
                  'forecast_source_fields': len(list(leaves(report['sources']))),
                  'scenario_source_fields': len(list(leaves(scenario_report['sources']))),
                  'status': 'PASS'}))
if args.word:
    directory = Path(args.output)
    directory.mkdir(parents=True, exist_ok=True)
    output = directory / 'forecast-calculation-sample.docx'
    output.write_bytes(build_word(report).getvalue())
    print(output.resolve())
