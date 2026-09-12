// Run: node --experimental-vm-modules scripts/test-kpi-chart-correctness.mjs
// Execute the shipped modules, with only their browser and service boundaries replaced.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { forecastPeriodUnit } from '../app/frontend/js/forecast-metrics.js';

const elements = new Map();
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.style = {}; this.className = ''; this.parentElement = null; this.textContent = ''; }
  set id(value) { this._id = value; elements.set(value, this); }
  get id() { return this._id; }
  get classList() { return { contains: (value) => this.className.split(' ').includes(value) }; }
  append(...items) { items.forEach((item) => { item.parentElement = this; this.children.push(item); }); }
  remove() { elements.delete(this.id); if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((item) => item !== this); }
  replaceWith(node) { const parent = this.parentElement; parent.children[parent.children.indexOf(this)] = node; node.parentElement = parent; }
  insertAdjacentElement(_position, node) { this.parentElement.append(node); }
  closest(selector) { return this.classList.contains(selector.slice(1)) ? this : this.parentElement?.closest(selector); }
  setAttribute() {}
}
function canvas(id) { const card = new Element(); const plot = new Element(); const node = new Element('canvas'); node.id = id; card.append(plot); plot.append(node); return node; }
function allText(node) { return [node.textContent, ...node.children.map(allText)].join(' '); }
const drawn = new Map();
class Chart {
  static register() {}
  constructor(node, config) { this.config = config; this.destroyed = false; drawn.set(node.id, this); }
  destroy() { this.destroyed = true; }
}
const horizon = { byFacility: {}, periodLabels: {}, periodsModelled: 3 };
const events = [];
const listeners = new Map();
const document = { getElementById: (id) => elements.get(id) || null,
  createElement: (tag) => new Element(tag), querySelector: () => null };
const window = { dispatchEvent: (event) => events.push(event), addEventListener: (name, fn) => listeners.set(name, fn) };
const context = vm.createContext({ Chart, document, window, console,
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } } });
const format = (value) => value === null || value === undefined ? '—' : String(value);
const data = { DEMAND_HISTORY: [], FORECAST: {}, SCENARIOS: [], SOLVE_HORIZON: horizon,
  perPeriodLabel: () => 'units/month', currencyLabel: () => 'USD',
  formatCurrency: (value) => '$' + value, formatCurrencyExact: format,
  formatNumber: format, fmtNum: format, horizonLabel: () => '3 modelled periods' };
function synthetic(values) { return new vm.SyntheticModule(Object.keys(values), function () {
  for (const [key, value] of Object.entries(values)) this.setExport(key, value);
}, { context }); }
const dataModule = synthetic(data);
const charts = new vm.SourceTextModule(fs.readFileSync(new URL('../app/frontend/js/charts.js', import.meta.url), 'utf8'), { context });
const forecastMetricsModule = synthetic({ forecastPeriodUnit });
await charts.link(specifier => specifier === './forecast-metrics.js' ? forecastMetricsModule : dataModule); await charts.evaluate();
const c = charts.namespace;

canvas('throughput');
horizon.byFacility.A = { throughput: { 1: 0, 2: null, 3: 125 } };
horizon.periodLabels = { 1: '2026-01', 2: '2026-02', 3: '2026-03' };
c.renderFacilityThroughputChart('throughput', { id: 'A', capacity: 200 });
assert.deepEqual(Array.from(drawn.get('throughput').config.data.datasets[0].data), [0, null, 125]);
assert.deepEqual(Array.from(drawn.get('throughput').config.data.labels), ['2026-01', '2026-02', '2026-03']);
assert.equal(drawn.get('throughput').config.data.datasets.length, 2, 'No invented forecast series');
const previous = drawn.get('throughput');
c.renderFacilityThroughputChart('throughput', { id: 'B', throughput: 9999 });
assert(previous.destroyed, 'A missing series destroys the previous facility chart');
assert.match(elements.get('throughput-empty').textContent, /No solved per-period/);

canvas('cost');
c.renderFacilityCostBreakdownChart('cost', { id: 'A' }, { facility_id: 'A', fixed_cost: 20,
  handling_cost: 30, holding_cost: 0, opening_cost: 40, total_facility_cost: 100 });
assert.deepEqual(Array.from(drawn.get('cost').config.data.datasets[0].data), [20, 30, 40, 10]);
assert.match(allText(elements.get('cost-legend')), /20\.0%/);
assert.match(allText(elements.get('cost-legend')), /Other \/ unattributed facility cost/);
c.renderFacilityCostBreakdownChart('cost', { id: 'A' }, { facility_id: 'B', fixed_cost: 20 });
assert.match(elements.get('cost-empty').textContent, /No authoritative/);
assert(!elements.has('cost-legend'), 'Wrong-scope costs remove stale legends');

canvas('spend');
const sites = Array.from({ length: 15 }, (_, i) => ({ facility_id: `D${i}`, total_facility_cost: 10 }));
c.renderWarehouseSpendChart('spend', sites, 150);
assert.equal(drawn.get('spend').config.data.datasets[0].data.reduce((sum, n) => sum + n, 0), 150);
assert.equal(drawn.get('spend').config.data.datasets[0].data.at(-1), 60, 'Other includes the six non-top-nine sites');
assert.match(allText(elements.get('spend-legend')), /6\.7%/);
assert.match(allText(elements.get('spend-legend')), /40\.0%/);
c.renderWarehouseSpendChart('spend', sites.slice(0, 2), 150);
assert.equal(drawn.get('spend').config.data.datasets[0].data.at(-1), 130, 'Even partial top-site input uses the real total');
c.renderWarehouseSpendChart('spend', [], 0);
assert.match(elements.get('spend-empty').textContent, /zero facility spend/);

canvas('mix');
c.renderWarehouseStatusMixChart('mix', [{ label: 'Tight', value: 1, color: 'red' }, { label: 'Healthy', value: 3, color: 'green' }]);
assert.match(allText(elements.get('mix-legend')), /1 site · 25\.0%/);
assert.match(allText(elements.get('mix-legend')), /3 sites · 75\.0%/);
c.renderWarehouseStatusMixChart('mix', []);
assert(!elements.has('mix-legend'));

canvas('util');
const many = Array.from({ length: 16 }, (_, i) => ({ facility_id: 'DC' + i, peak_utilization_pct: i === 0 ? null : i * 2, avg_utilization_pct: i }));
c.renderWarehouseUtilisationChart('util', many, 90, true);
assert.equal(drawn.get('util').config.data.labels.length, 16, 'Under-used tail is not silently omitted');
assert.equal(drawn.get('util').config.data.datasets[0].data[0], null, 'Missing utilisation is not zero');
assert.equal(drawn.get('util').config.options.indexAxis, 'y');
canvas('headroom');
c.renderWarehouseHeadroomChart('headroom', [{ facility_id: 'Missing', rated_capacity_per_period: 100, peak_throughput_units: null },
  { facility_id: 'Over', rated_capacity_per_period: 100, peak_throughput_units: 120 }], true);
assert.equal(drawn.get('headroom').config.data.labels.length, 1, 'Missing throughput cannot imply 100% headroom');
assert.equal(drawn.get('headroom').config.data.datasets.at(-1).data[0], 20);

let project = 'A', snapshot = 'A1';
const changeListeners = [];
const requests = [];
const projectModule = synthetic({ getActiveProjectId: () => project, getActiveSnapshotId: () => snapshot,
  onProjectChange: (fn) => changeListeners.push(fn) });
const serviceModule = synthetic({ kpiService: { getWarehouseDeepDive: (id) => new Promise((resolve, reject) => requests.push({ id, resolve, reject })) } });
const warehouse = new vm.SourceTextModule(fs.readFileSync(new URL('../app/frontend/js/warehouse.js', import.meta.url), 'utf8'), { context });
await warehouse.link((specifier) => specifier === './data.js' ? dataModule : specifier === './charts.js' ? charts
  : specifier.includes('kpi-service') ? serviceModule : projectModule);
await warehouse.evaluate();
const w = warehouse.namespace;
const first = w.loadWarehouseReport();
project = 'B'; snapshot = 'B1'; changeListeners.forEach((fn) => fn());
const second = w.loadWarehouseReport();
const current = { network_id: 'B', health_kpis: [] };
requests[1].resolve({ project_id: 'B', snapshot_id: 'B1', warehouse: current });
await second;
requests[0].resolve({ project_id: 'A', snapshot_id: 'A1', warehouse: { network_id: 'A' } });
await first;
assert.equal(w.getWarehouseReport(), current, 'Late previous-project response cannot replace the current report');
snapshot = 'B2';
assert.equal(w.getWarehouseReport(), null, 'Old snapshot is unreadable immediately');
w.clearWarehouseState();
const oldVersion = w.loadWarehouseReport();
w.clearWarehouseState();
const newVersion = w.loadWarehouseReport();
requests[3].resolve({ project_id: 'B', snapshot_id: 'B2', warehouse: current }); await newVersion;
requests[2].resolve({ project_id: 'B', snapshot_id: 'B2', warehouse: { network_id: 'OLD' } }); await oldVersion;
assert.equal(w.getWarehouseReport(), current, 'Late same-project/version-invalidated request cannot replace fresh data');
assert(events.some((event) => event.type === 'warehouseReportUpdated' && event.detail.report === current));
w.clearWarehouseState();
const failed = w.loadWarehouseReport(); requests.at(-1).reject(new Error('Unavailable')); await failed;
assert.equal(w.getWarehouseReport(), null, 'Failure cannot retain an old report');
console.log('KPI chart runtime tests passed: truthful series, full-denominator shares, persistent labels, null/zero, complete rankings, and project/version races.');
