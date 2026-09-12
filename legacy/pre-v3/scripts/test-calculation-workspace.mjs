// node --experimental-vm-modules scripts/test-calculation-workspace.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

let project='project-A', snapshot='snapshot-A';
const pending=[], projectListeners=[], listeners={};
const dialog={open:false,innerHTML:'',handlers:{},setAttribute(){},
  addEventListener(type,fn){this.handlers[type]=fn;},showModal(){this.open=true;},
  close(){this.open=false;this.handlers.close?.();},querySelector(){return null;}};
const context=vm.createContext({console,URLSearchParams,CSS:{escape:value=>value},
  window:{addEventListener(type,fn){listeners[type]=fn;}},
  document:{getElementById:()=>dialog, createElement:()=>dialog,body:{appendChild(){}}}});
// Force first creation so close/snapshot invalidation handlers are installed.
let mounted=false;
context.document.getElementById=()=>mounted ? dialog : (mounted=true,null);
const synthetic=values=>new vm.SyntheticModule(Object.keys(values),function(){
  for(const [key,value] of Object.entries(values))this.setExport(key,value);
},{context});
const calc=new vm.SourceTextModule(fs.readFileSync('app/frontend/js/calculations.js','utf8'),{context});
await calc.link(name=>name.includes('api-client') ? synthetic({apiClient:{get:(path,query)=>new Promise((resolve,reject)=>pending.push({path,query,resolve,reject}))}})
  : synthetic({getActiveProjectId:()=>project,getActiveSnapshotId:()=>snapshot,onProjectChange:fn=>projectListeners.push(fn)}));
await calc.evaluate();
const {openCalculations,escapeCalculationText}=calc.namespace;
const report=label=>({title:label,scope:{},metrics:[{id:'cost',label:'Cost',value:10,formula:'5 + 5',worked:'5 + 5 = 10',inputs:{raw:'<img onerror=bad>'}}],sources:{}});
let first=openCalculations('/api/kpis/calculations');
let second=openCalculations('/api/forecast/calculations/run-B');
pending[1].resolve(report('Run B')); await second;
pending[0].resolve(report('Run A')); await first;
assert.match(dialog.innerHTML,/Run B/); assert(!dialog.innerHTML.includes('Run A'));
assert.match(dialog.innerHTML,/5 \+ 5 = 10/);
assert(!dialog.innerHTML.includes('<img'));
assert.match(dialog.innerHTML,/format=docx/);
first=openCalculations('/api/kpis/calculations');
project='project-B';projectListeners.forEach(fn=>fn());
assert(!dialog.open);
pending.at(-1).resolve(report('Old private result'));await first;
assert(!dialog.innerHTML.includes('Old private result'));

// Execute the real scenario renderer with deterministic browser controls.
const panel={innerHTML:'',querySelectorAll:()=>[],querySelector:()=>({addEventListener(){}})};
const scenarioSource=fs.readFileSync('app/frontend/js/scenarios.js','utf8');
const renderer=scenarioSource.slice(scenarioSource.indexOf('function renderMultiScenarioTakeCard()'),scenarioSource.indexOf('// ─── Open Scenario Detail Drawer'));
const advice=[];
const ctx=vm.createContext({console,Map,encodeURIComponent,document:{getElementById:()=>panel},
  SCENARIOS:[{id:'A',name:'Scenario A',executionId:'runA'},{id:'B',name:'Scenario B',executionId:'runB'}],
  multiSelectedIds:['A','B'],executiveFocusId:'A',mapActiveId:'A',executiveGeneration:0,executiveCache:new Map(),
  getActiveProjectId:()=>project,getActiveSnapshotId:()=>snapshot,executiveEscape:escapeCalculationText,
  apiClient:{get:(path)=>new Promise((resolve,reject)=>advice.push({path,resolve,reject}))},
  openCalculations(){},renderScenarioMapToggle(){},updateScenarioMap(){}});
vm.runInContext(renderer,ctx);
ctx.renderMultiScenarioTakeCard();
ctx.executiveFocusId='B';ctx.renderMultiScenarioTakeCard();
assert.equal(advice[1].path,'/api/scenarios/B/briefing');
const payload=label=>({summary:{name:label,conclusion:'<img onerror=bad>'},recommendations:[],findings:[],all_evidence:[],message:'AI unavailable'});
advice[1].resolve(payload('Selected B'));await new Promise(setImmediate);
advice[0].resolve(payload('Stale A'));await new Promise(setImmediate);
assert.match(panel.innerHTML,/Selected B/);assert(!panel.innerHTML.includes('Stale A'));
assert.match(panel.innerHTML,/&lt;img/);assert(!panel.innerHTML.includes('<img'));
assert.match(panel.innerHTML,/Retry AI connection/);
ctx.executiveFocusId='A';ctx.executiveCache.clear();ctx.renderMultiScenarioTakeCard();
ctx.executiveGeneration++;project='project-C';ctx.executiveCache.clear();
advice.at(-1).resolve(payload('Wrong project'));await new Promise(setImmediate);
assert.equal(ctx.executiveCache.size,0);
console.log('Calculation and scenario UI checks passed: actual equations, export URL, selected-run races, project isolation, escaping and explicit AI-unavailable state.');
