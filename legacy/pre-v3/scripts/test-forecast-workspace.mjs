// node --experimental-vm-modules scripts/test-forecast-workspace.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as metrics from '../app/frontend/js/forecast-metrics.js';

const makeEntry = (overrides = {}) => ({ key:'M/P', label:'Market / Product', engine:'ETS', frequency:'MONTH',
  history:{ values:[999, 50, 60], labels:['1','2','3'] },
  forecast:{ values:[90.125,100.25], labels:['+1','+2'], lower:[80,90], upper:[100,115] },
  accuracy:{ mase:0.8, wape:0.125, n_folds:3 }, ...overrides });
let m = metrics.forecastMetrics(makeEntry());
assert.equal(m.total, 190.375, 'Do not round model points before calculating KPIs');
assert.equal(m.recent, 110, 'Compare equal-length windows, not all history');
assert.equal(m.growth, (190.375/110-1)*100);
assert.equal(m.peak, 100.25); assert.equal(m.peakLabel, '+2');
assert.equal(m.peakLower, 90); assert.equal(m.peakUpper, 115, 'Do not add marginal quantiles across periods');
for (const value of [null, undefined, '', '0', Infinity, NaN]) {
  const forecast = { values:[0,value], labels:['+1','+2'], lower:[], upper:[] };
  assert.equal(metrics.forecastMetrics(makeEntry({ forecast })).total, null);
}
assert.equal(metrics.forecastMetrics(makeEntry({history:{values:[0,0]}})).growth, null);
assert.equal(metrics.forecastMetrics(makeEntry({history:{values:[0]}})).recent, null);
assert.equal(metrics.forecastMetrics(makeEntry({forecast:{values:[0,0],labels:['+1','+2']}})).total, 0);
assert.equal(metrics.forecastMetrics(makeEntry({forecast:{values:[1],labels:['+1','+2']}})).peak, null);
assert.equal(metrics.forecastMetrics(null).total, null);
assert.equal(metrics.forecastPeriodUnit('WEEK'), 'week');
assert.equal(metrics.forecastPeriodUnit(null), 'period');

const elements = new Map();
for (const id of ['fc-kpi-grid','fc-kpi-scope','fc-validation-card','fc-run-model','fc-horizon-select','fc-model-status','fc-model-form']) {
  elements.set(id,{textContent:'',innerHTML:'',dataset:{},attributes:{},handlers:{}, value:'6',
    setAttribute(key,value) { this.attributes[key] = value; }, addEventListener(key,fn) { this.handlers[key] = fn; }, querySelectorAll() {return [];} });
}
elements.get('fc-horizon-select').options = [3,6,12].map(value => ({value:String(value)}));
const listeners = new Map(), projectListeners = [], pending = [];
const window = {addEventListener(type,fn) { listeners.set(type,[...(listeners.get(type)||[]),fn]); },
  dispatchEvent(event) { (listeners.get(event.type)||[]).forEach(fn=>fn(event)); }};
let project = 'project-A', snapshot = 'snapshot-A', user = {user_id:'user-A'};
const forecast = {}, catalogue = [];
const context = vm.createContext({window,console,CustomEvent:class {constructor(type){this.type=type;}},
  document:{getElementById:id=>elements.get(id)}});
function synthetic(values) { return new vm.SyntheticModule(Object.keys(values), function () {
  for (const [key,value] of Object.entries(values)) this.setExport(key,value);
},{context}); }
const source = fs.readFileSync(new URL('../app/frontend/js/integration/hydrate.js',import.meta.url),'utf8');
const data = { FORECAST:forecast, FORECAST_CATALOGUE:catalogue, MARKETS:[],
  setForecastSeries(entry) { forecast.seriesLabel = entry.seriesLabel || ''; },
  setForecastCatalogue(entries) { catalogue.splice(0,catalogue.length,...entries); }, setForecastBriefing() {} };
const projectModule = { getActiveProjectId:()=>project, getActiveSnapshotId:()=>snapshot,
  setActiveSnapshotId:value=>{snapshot=value;}, onProjectChange:fn=>projectListeners.push(fn) };
const imports = {};
for (const match of source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g)) {
  const names = match[1].split(',').map(name=>name.trim()).filter(Boolean);
  const overrides = match[2] === '../data.js' ? data : match[2] === './project-context.js' ? projectModule
    : match[2] === '../identity.js' ? {getCurrentUser:()=>user}
    : match[2] === './services/forecast-service.js' ? { forecastService:{getForecast:(project,horizon)=>new Promise((resolve,reject)=>pending.push({project,horizon,resolve,reject}))} } : {};
  imports[match[2]] = synthetic(Object.fromEntries(names.map(name=>[name,overrides[name] ?? (()=>{})])));
}
const hydration = new vm.SourceTextModule(source,{context});
await hydration.link(name=>imports[name]); await hydration.evaluate();
const workspace = new vm.SourceTextModule(fs.readFileSync(new URL('../app/frontend/js/forecast-workspace.js',import.meta.url),'utf8'),{context});
const workspaceImports = {'./data.js':synthetic(data),'./forecast-metrics.js':synthetic(metrics),
  './integration/hydrate.js':hydration,'./integration/project-context.js':synthetic(projectModule), './calculations.js':synthetic({openForecastCalculations(){}})};
await workspace.link(name=>workspaceImports[name]); await workspace.evaluate();
const refresh = hydration.namespace.reloadDemandForecast, render = workspace.namespace.renderForecastWorkspace;
function response(horizon=6) { return {project_id:project,snapshot_id:snapshot,status:'OK',horizon,execution_id:'run-A',series:[
  {market_id:'M',product_id:'P',engine:'ETS',frequency:'MONTH',pattern:'SMOOTH',status:'OK',
    history:Array.from({length:24},(_,i)=>({period:i+1,quantity:50.125+i})),
    points:Array.from({length:horizon},(_,i)=>({period:i+1,mean:90.125+i,p10:80+i,p90:100+i})),
    accuracy:{mase:0.8,wape:0.125,n_folds:3},warnings:['<img src=x onerror=bad>'],regime:{n_periods_used:12,reason:'Recent history'},
  },
  {market_id:'B',product_id:'P',engine:'Croston',frequency:'WEEK',pattern:'INTERMITTENT',status:'OK',
    history:[{period:1,quantity:0},{period:2,quantity:0}],
    points:Array.from({length:horizon},(_,i)=>({period:i+1,mean:0,p10:0,p90:0})),accuracy:null},
]}; }

render(); assert.match(elements.get('fc-kpi-grid').innerHTML,/—/);
let run = refresh(6); assert.equal(pending.at(-1).horizon,6);
assert.equal(elements.get('fc-run-model').disabled,true);
pending.at(-1).resolve(response()); await run; render();
assert.equal(catalogue[0].forecast.values[0],90.125);
assert.equal(catalogue[0].frequency,'MONTH');
assert.match(elements.get('fc-validation-card').innerHTML,/12\.5%/);
assert.match(elements.get('fc-validation-card').innerHTML,/24 \/ 12 periods/);
assert.match(elements.get('fc-validation-card').innerHTML,/&lt;img/);
assert(!elements.get('fc-validation-card').innerHTML.includes('<img'));
forecast.seriesLabel = 'B/P'; render();
assert.match(elements.get('fc-validation-card').innerHTML,/Croston/);
assert.match(elements.get('fc-validation-card').innerHTML,/Not backtested/);
assert(!elements.get('fc-validation-card').innerHTML.includes('12.5%'));
assert.match(elements.get('fc-kpi-scope').textContent,/6 weeks/);
assert.match(elements.get('fc-kpi-grid').innerHTML,/Needs 6 complete/);

const control = elements.get('fc-horizon-select');
control.value = '12'; control.handlers.change();
assert.match(elements.get('fc-model-status').textContent,/Click Run forecast/);
run = elements.get('fc-model-form').handlers.submit({preventDefault(){}});
assert.equal(pending.at(-1).horizon,12);
assert.equal(control.disabled,true);
pending.at(-1).resolve(response(12)); await run; render();
assert.equal(forecast.seriesLabel,'B/P','Keep the user’s selected series after a model run');
assert.match(elements.get('fc-kpi-scope').textContent,/12 weeks/);
assert.equal(control.disabled,false);

// An older horizon response cannot overwrite a newer completed run.
const older = refresh(3), oldReply = pending.at(-1);
const newer = refresh(6), newReply = pending.at(-1);
newReply.resolve(response(6)); await newer;
oldReply.resolve(response(3)); await older;
assert.equal(window.__ngForecastMeta.horizon,6);
// Same-project snapshot changes must clear stale values AND release the loading UI.
run = refresh(6); const stale = response(6); snapshot = 'snapshot-B';
pending.at(-1).resolve(stale); await run;
assert.equal(window.__ngForecastMeta,null);
assert.equal(window.__ngForecastLoad.loading,false);
assert.equal(catalogue.length,0);
// Project and identity isolation.
run = refresh(6); const wrongProject = response(6); project = 'project-B';
projectListeners.forEach(fn=>fn()); pending.at(-1).resolve(wrongProject); await run;
assert.equal(catalogue.length,0);
run = refresh(6); const wrongUser = response(6); user = {user_id:'user-B'};
window.dispatchEvent({type:'identityChanged'}); pending.at(-1).resolve(wrongUser); await run;
assert.equal(catalogue.length,0);
// Failure does not leave a plausible old chart/KPI set.
run = refresh(12); pending.at(-1).resolve(response(6)); await run; render();
assert.equal(catalogue.length,0);
assert.match(elements.get('fc-model-status').textContent,/different horizon/);
run = refresh(6); pending.at(-1).reject(new Error('Forecast service unavailable')); await run; render();
assert.equal(catalogue.length,0);
assert.match(elements.get('fc-model-status').textContent,/Forecast service unavailable/);
assert.equal(elements.get('fc-run-model').disabled,false);
console.log('Forecast metrics, selected-series UI, precision, horizon runs, failure states and request isolation passed.');
