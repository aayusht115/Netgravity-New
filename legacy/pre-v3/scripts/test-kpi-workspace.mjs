// Run: node --experimental-vm-modules scripts/test-kpi-workspace.mjs
// Actual pure metrics and workspace code; the small DOM boundary tests behavior, not layout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { facilityPeriodMetrics, corridorMetrics, finiteMetric } from '../app/frontend/js/kpi-metrics.js';

const f = { id: 'DC_A', capacity: 100 };
const horizon = { periodsModelled: 12, periodLabels: { 1: 'Jan 2026', 2: 'Feb 2026' },
  byFacility: { DC_A: { throughput: { 1: 0, 2: 90 }, utilisation: { 1: 0, 2: 90 } } } };
const health = { facility_id: 'DC_A', is_open: true, rated_capacity_per_period: 100,
  avg_throughput_units: 45, peak_throughput_units: 90 };
assert.equal(finiteMetric(0), true);
for (const missing of [null, undefined, '', '0', NaN, Infinity]) assert.equal(finiteMetric(missing), false);
let metric = facilityPeriodMetrics(f, horizon, 'HORIZON', health);
assert.equal(metric.throughput, 45); assert.equal(metric.utilisation, 45); assert.equal(metric.peakHeadroom, 10);
metric = facilityPeriodMetrics(f, horizon, '1', health);
assert.equal(metric.throughput, 0); assert.equal(metric.utilisation, 0); assert.equal(metric.basis, 'Jan 2026');
metric = facilityPeriodMetrics(f, horizon, '2', health);
assert.equal(metric.throughput, 90); assert.equal(metric.utilisation, 90);
assert.equal(metric.peakHeadroom, 10, 'Peak headroom stays full horizon when the throughput period changes');
metric = facilityPeriodMetrics(f, horizon, 'missing', health);
assert.equal(metric.throughput, null); assert.equal(metric.utilisation, null, 'A missing period is not a zero');
metric = facilityPeriodMetrics(f, horizon, 'HORIZON', { ...health, is_open: false, avg_throughput_units: 0, peak_throughput_units: 0 });
assert.equal(metric.peakHeadroom, null, 'A site not operating cannot advertise physical headroom');
assert.equal(metric.utilisation, null, 'A site not operating cannot be labelled healthy at zero utilization');
assert.equal(facilityPeriodMetrics(f, horizon, 'HORIZON', { ...health, rated_capacity_per_period: 0 }).utilisation, null);

const lanes = [
  { flowHorizon: 1200, flow: 100, cost: 1, leadTime: 2, carbonKg: 120 },
  { flowHorizon: 3600, flow: 300, cost: 3, leadTime: 6, carbonKg: 360 },
  { flowHorizon: 0, flow: 0, cost: 999, leadTime: 999, carbonKg: null },
];
const corridor = corridorMetrics(lanes);
assert.equal(corridor.totalFlow, 4800);
assert.equal(corridor.weightedCost, 2.5, 'Rates are weighted by full-horizon flow, not a mean of rates');
assert.equal(corridor.weightedLead, 5);
assert.equal(corridor.carbon, 480);
assert.equal(corridor.carbonPerUnit, 0.1, 'Annual carbon uses annual flow; it must not be divided by monthly average');
assert.equal(corridor.activeCount, 2); assert.equal(corridor.connectedCount, 3);
assert.equal(corridorMetrics([{ flowHorizon: 0 }]).totalFlow, 0);
assert.equal(corridorMetrics([{ flowHorizon: 0 }]).weightedCost, null);
assert.equal(corridorMetrics([{ flowHorizon: 5, cost: null, leadTime: 0, carbonKg: 0 }]).weightedLead, 0);
assert.equal(corridorMetrics([{ flowHorizon: 5, cost: 0, leadTime: 0, carbonKg: 0 }]).carbonPerUnit, 0);
const incomplete = corridorMetrics([...lanes, { flowHorizon: null }]);
for (const key of ['totalFlow','weightedCost','weightedLead','carbon','carbonPerUnit']) {
  assert.equal(incomplete[key], null, `Unknown arc flow cannot silently produce a complete ${key}`);
}
assert.equal(corridorMetrics([{ flowHorizon: 5, carbonKg: null }]).carbon, null);

const elements = new Map(), cards = [], documentListeners = new Map(), windowListeners = new Map();
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.handlers = new Map(); this.hidden = false; this.open = false; this.style = {}; this._html = ''; this.textContent = ''; }
  set id(value) { this._id = value; elements.set(value, this); }
  get id() { return this._id; }
  set innerHTML(value) {
    this._html = value;
    if (this.tagName === 'dialog') { this.body = new Element(); this.body.parent = this; }
    if (value.includes('id="kpi-monitor-form"')) { const form = new Element('form'); form.id = 'kpi-monitor-form'; }
  }
  get innerHTML() { return this._html; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  hasAttribute(key) { return key in this.attributes; }
  append(...nodes) { nodes.forEach(node => { this.children.push(node); node.parent = this; }); }
  addEventListener(name, fn) { this.handlers.set(name, fn); }
  querySelector(selector) {
    if (selector === '.kpi-dialog-body') return this.body;
    if (selector.startsWith(':scope')) return this.children.find(node => node.className === 'kpi-insight-button');
    if (selector.includes('.card-title')) return { textContent: this.title || this.dataset.kpiTile };
    return null;
  }
  closest(selector) { if (selector === 'button') return this; if (selector === '.card') return this.card; return null; }
  cloneNode() { return new Element(this.tagName); }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
}
function element(id, tag) { const el = new Element(tag); el.id = id; return el; }
for (const id of ['kpi-workspace-controls','kpi-network-panel','kpi-facility-panel','kpi-facility-controls','tab-facility-dashboard']) element(id);
const chartIds = ['chart-wh-utilisation','chart-wh-spend','chart-wh-mix','chart-wh-headroom','chart-wh-stock','table-wh-health',
  'chart-dash-throughput','chart-dash-costs','chart-dash-lanes','table-dash-lanes'];
for (const id of chartIds) { const chart = element(id); const card = new Element(); chart.card = card; card.title = id; cards.push(card); }
const summaryCards = Array.from({ length: 4 }, () => new Element()); cards.push(...summaryCards);
const facilityCards = ['facility-utilisation','facility-headroom','facility-cost','facility-stock','facility-lead','facility-carbon']
  .map(key => { const card = new Element(); card.dataset.kpiTile = key; return card; }); cards.push(...facilityCards);
const attentionCard = new Element(); attentionCard.dataset.kpiTile = 'health'; attentionCard.dataset.kpiFacility = 'DC_A'; cards.push(attentionCard);
const document = {
  body: new Element('body'), getElementById: id => elements.get(id), createElement: tag => new Element(tag),
  createTextNode: text => ({ textContent: text }), querySelector: () => null,
  querySelectorAll: selector => selector.includes('#wh-summary-grid') ? summaryCards : cards.filter(card => card.dataset.kpiTile),
  addEventListener: (name, fn) => documentListeners.set(name, fn),
};
const window = { dispatchEvent() {}, addEventListener: (name, fn) => windowListeners.set(name, fn) };
const requests = [], storage = new Map(), projectListeners = [], renders = [];
let project = 'project-A', snapshot = 'snapshot-A', user = { user_id: 'user-A', email: 'a@example.test' };
let report = { n_open: 2, n_bottlenecks: 1, total_facility_spend: 100 };
const dcs = [{ id: 'DC_A', name: 'Atlanta' }, { id: 'DC_B', name: 'Boston' }];
const context = vm.createContext({ document, window, console, Object, Event: class {},
  MutationObserver: class { observe() {} }, alert() {},
  localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } });
function synthetic(values) { return new vm.SyntheticModule(Object.keys(values), function () {
  for (const [key, value] of Object.entries(values)) this.setExport(key, value);
}, { context }); }
const modules = {
  './data.js': synthetic({ PLANTS: [], DCS: dcs, SOLVE_HORIZON: horizon, formatCurrency: value => '$' + value }),
  './warehouse.js': synthetic({ getWarehouseReport: () => report, renderWarehouseDashboard: () => {} }),
  './integration/project-context.js': synthetic({ getActiveProjectId: () => project, getActiveSnapshotId: () => snapshot,
    onProjectChange: fn => projectListeners.push(fn) }),
  './identity.js': synthetic({ getCurrentUser: () => user }),
  './integration/api-client.js': synthetic({ apiClient: {
    post: (path, body) => new Promise(resolve => requests.push({ path, body, resolve })),
    get: (path, body) => new Promise(resolve => requests.push({ path, body, resolve })),
  } }),
  './kpi-facility.js': synthetic({ renderKpiFacility: (id, period) => renders.push({ id, period }),
    escapeKpi: value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])) }),
};
const source = fs.readFileSync(new URL('../app/frontend/js/kpi-workspace.js', import.meta.url), 'utf8');
const workspace = new vm.SourceTextModule(source, { context });
await workspace.link(specifier => modules[specifier]); await workspace.evaluate();
const w = workspace.namespace;
w.initKpiWorkspace(); w.refreshKpiWorkspace(); w.refreshKpiWorkspace();
for (const card of cards) assert.equal(card.children.filter(node => node.className === 'kpi-insight-button').length, 1, 'Every static/dynamic/attention tile has exactly one Insights button');
assert.equal(elements.get('kpi-network-panel').hidden, false);
assert.equal(elements.get('kpi-facility-panel').hidden, true);
const click = dataset => { const target = new Element('button'); target.dataset = dataset; documentListeners.get('click')({ target }); };
click({ kpiView: 'facility' });
assert.equal(elements.get('kpi-network-panel').hidden, true); assert.equal(elements.get('kpi-facility-panel').hidden, false);
click({ kpiFacility: 'DC_B' });
assert.deepEqual(renders.at(-1), { id: 'DC_B', period: 'HORIZON' });
documentListeners.get('change')({ target: { id: 'kpi-period-select', value: '2' } });
assert.deepEqual(renders.at(-1), { id: 'DC_B', period: '2' });
assert.notEqual(w.pinStorageKey('u:a', 'b'), w.pinStorageKey('u', 'a:b'));
assert.notEqual(w.pinStorageKey('user-A', 'project-A'), w.pinStorageKey('user-B', 'project-A'));
assert.equal(w.pinStorageKey(null, 'project-A'), null);

// Event-bound real Insights behavior: correct API route, precise facility/period, safe text, max three.
const button = facilityCards[0].children[0];
const pending = button.handlers.get('click')();
assert.equal(requests.at(-1).path, '/api/kpi-tile-insights');
assert.equal(requests.at(-1).body.facility_id, 'DC_B'); assert.equal(requests.at(-1).body.period, 'Feb 2026', 'The backend resolves the selected period by its canonical label');
requests.at(-1).resolve({ insights: Array.from({ length: 4 }, (_, i) => ({ title: '<img onerror=bad> ' + i,
  evidence: 'Measured evidence', action: 'Test a scenario' })), mode: 'rules', basis: 'Current solved horizon', data_version: 'v1' });
await pending; await Promise.resolve();
let html = elements.get('kpi-insight-dialog').body.innerHTML;
assert.equal((html.match(/<li>/g) || []).length, 3);
assert(!html.includes('<img onerror=')); assert(html.includes('&lt;img'));
assert.match(html, /Evidence-based optimisation insights/);
// Old project response must not replace a newer project's dialog.
button.handlers.get('click')(); const old = requests.at(-1);
project = 'project-B'; snapshot = 'snapshot-B'; projectListeners.forEach(fn => fn());
facilityCards[0].children[0].handlers.get('click')(); const fresh = requests.at(-1);
fresh.resolve({ insights: [{ title:'NEW PROJECT', evidence:'Current', action:'Review' }] }); await Promise.resolve(); await Promise.resolve();
old.resolve({ insights: [{ title:'OLD PROJECT', evidence:'Stale', action:'Ignore' }] }); await Promise.resolve(); await Promise.resolve();
html = elements.get('kpi-insight-dialog').body.innerHTML;
assert.match(html, /NEW PROJECT/); assert(!html.includes('OLD PROJECT'));

const monitorButton = new Element('button'); monitorButton.attributes['data-kpi-monitor'] = '';
documentListeners.get('click')({ target: monitorButton });
assert.equal(requests.at(-1).path, '/api/kpi-monitors');
requests.at(-1).resolve({ capabilities: { email_delivery: { configured: false }, worker_enabled: false, metrics: [], directions: [] }, monitors: [] });
await new Promise(resolve => setImmediate(resolve));
assert.match(elements.get('kpi-monitor-dialog').body.innerHTML, /Email alerts are not ready/, elements.get('kpi-monitor-dialog').body.textContent);
assert.match(elements.get('kpi-monitor-dialog').body.innerHTML, /name="enabled"[^>]*disabled/);

// Unlabelled solve periods still offer real model-period choices without inventing dates.
horizon.periodLabels = {};
horizon.byFacility.DC_A = { throughput: { 1: 12, 6: 60 } };
click({ kpiFacility: 'DC_A' });
assert.match(elements.get('kpi-facility-controls').innerHTML, /Model period 6/);
documentListeners.get('change')({ target: { id: 'kpi-period-select', value: '6' } });
assert.deepEqual(renders.at(-1), { id:'DC_A', period:'6' });
button.handlers.get('click')();
assert.equal(requests.at(-1).body.period, '6');
requests.at(-1).resolve({ insights: [] });
await new Promise(resolve => setImmediate(resolve));
user = { user_id:'user-B', email:'b@example.test' };
windowListeners.get('identityChanged')();
assert.equal(elements.get('kpi-insight-dialog').open, false, 'Changing account closes the previous account’s briefing');
assert.equal(elements.get('kpi-monitor-dialog').open, false, 'Changing account closes monitoring controls');

// Execute the actual facility renderer too: clear messages, honest closed state and partial-scope labels.
const facilitySource = fs.readFileSync(new URL('../app/frontend/js/kpi-facility.js', import.meta.url), 'utf8');
const facility = new vm.SourceTextModule(facilitySource, { context });
const clears = [], chartCalls = [];
for (const id of ['dash-metrics-grid','dash-corridor-summary','dash-facility-name','dash-facility-type']) element(id);
const facilityLanes = [
  { from:'DC_A', to:'M1', flowHorizon:1200, flow:100, cost:1, leadTime:2, carbonKg:120 },
  { from:'DC_A', to:'M2', flowHorizon:3600, flow:300, cost:3, leadTime:6, carbonKg:360 },
  { from:'DC_A', to:'M3', flowHorizon:null, flow:null, cost:4, leadTime:8, carbonKg:null },
];
const facilityModules = {
  './data.js': synthetic({ PLANTS:[], DCS:dcs, LANES:facilityLanes, SOLVE_HORIZON:horizon,
    getFacilityById:id => dcs.find(item => item.id === id), isDCFacility:() => true,
    formatCurrency:value => '$' + value, formatCurrencyExact:value => '$' + value, formatNumber:String,
    fmtNum:(value, digits=1) => value == null ? '—' : Number(value).toFixed(digits) }),
  './warehouse.js': modules['./warehouse.js'],
  './charts.js': synthetic({ clearDashboardChart:(...args) => clears.push(args),
    renderFacilityThroughputChart:(...args) => chartCalls.push(['throughput',...args]),
    renderFacilityCostBreakdownChart:(...args) => chartCalls.push(['cost',...args]),
    renderFacilityLaneFlowsChart:(...args) => chartCalls.push(['lanes',...args]) }),
  './kpi-metrics.js': synthetic({ finiteMetric, facilityPeriodMetrics, corridorMetrics }),
};
await facility.link(specifier => facilityModules[specifier]); await facility.evaluate();
facility.namespace.renderKpiFacility(null, 'HORIZON');
assert.equal(clears.length, 3);
assert(clears.every(args => typeof args[1] === 'string'), 'No-facility clear calls must not receive forEach indexes as messages');
report = { health_kpis:[{ ...health, is_open:false, total_facility_cost:0, avg_throughput_units:0, peak_throughput_units:0 }] };
facility.namespace.renderKpiFacility('DC_A', 'HORIZON');
assert.equal((elements.get('dash-metrics-grid').innerHTML.match(/>Not operating</g) || []).length, 2);
assert.match(elements.get('dash-metrics-grid').innerHTML, /Reported-flow subtotal: 480 kg/);
assert.match(elements.get('dash-metrics-grid').innerHTML, /2 \/ 3 corridors report flow/);
assert.equal(chartCalls.find(call => call[0] === 'cost')[3], report.health_kpis[0], 'The actual health row, not fabricated cost, is passed to the chart');

// Preserve data provenance at the integration boundary: flow and carbon must share the horizon.
const hydrate = fs.readFileSync(new URL('../app/frontend/js/integration/hydrate.js', import.meta.url), 'utf8');
assert.match(hydrate, /lane\.flowHorizon\s*=\s*f\s*\?\s*f\.flow_units/);
assert.match(hydrate, /lane\.carbonKg\s*=\s*f\s*\?\s*f\.carbon_kg/);
assert(!/apiClient\.(?:get|post)\('\/kpi-/.test(source), 'KPI services must route through /api to Python');
const backend = fs.readFileSync(new URL('../app/backend/api/kpi_tile_insights.py', import.meta.url), 'utf8');
const tileContract = backend.slice(backend.indexOf('TILES = frozenset({'), backend.indexOf('\n})', backend.indexOf('TILES = frozenset({')));
for (const card of cards) assert(tileContract.includes(`'${card.dataset.kpiTile}'`), `${card.dataset.kpiTile} must have a supported backend evidence route`);
console.log('KPI workspace tests passed: real metrics, scopes, periods, weighted rates, carbon basis, every-tile insights, escaping, request races, and unavailable email state.');
