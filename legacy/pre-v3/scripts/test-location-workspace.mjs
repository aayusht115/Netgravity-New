import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context=vm.createContext({console,Uint8ClampedArray,Float32Array,window:{addEventListener(){}},
  document:{},Math,Number,Map,Set});
const source=fs.readFileSync('app/frontend/js/location-workspace.js','utf8');
const exportsByModule={
  './integration/api-client.js':{apiClient:{}},
  './integration/services/scenario-service.js':{scenarioService:{}},
  './integration/project-context.js':{getActiveProjectId:()=>null,getActiveSnapshotId:()=>null,onProjectChange:()=>{}},
  './map.js':{createLocationBasemap:()=>{}},
  './calculations.js':{escapeCalculationText:String,openCalculations:()=>{}},
};
const module=new vm.SourceTextModule(source,{context});
const heatModule=new vm.SourceTextModule(fs.readFileSync('app/frontend/js/demand-heat.js','utf8'),{context});
await module.link(async name=>{
  if(name==='./demand-heat.js')return heatModule;
  assert.ok(exportsByModule[name],`Unexpected dependency ${name}`);
  const values=exportsByModule[name];
  return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value] of Object.entries(values))this.setExport(key,value);},{context});
});
await module.evaluate();
const heat=module.namespace.heatPixels;
assert.ok(heat(50,50,[]).every(v=>v===0));
assert.ok(heat(50,50,[{x:25,y:25,weight:0}]).every(v=>v===0));
assert.ok(heat(50,50,[{x:-100,y:-100,weight:100}]).every(v=>v===0));
const points=[{x:15,y:25,weight:10},{x:35,y:25,weight:30}];
const pixels=heat(50,50,points,8);
assert.ok(pixels[(25*50+35)*4+3]>pixels[(25*50+15)*4+3]);
assert.deepEqual([...pixels],[...heat(50,50,points.map(p=>({...p,weight:p.weight*10})),8)],'Visual normalization must preserve proportional demand');
assert.deepEqual([...pixels],[...heat(50,50,points.map(p=>({...p,weight:p.weight*1e100})),8)],'Large finite input must not overflow density');
assert.match(source,/snapshot_id:snapshot/);
assert.match(source,/edit!==state\.edit/);
assert.match(source,/project===getActiveProjectId\(\)/);
assert.match(source,/candidate_id:state\.candidate/);
assert.match(source,/No availability, rent or total-cost recommendation is implied/);
assert.match(source,/map\.removeLayer\(heat\)/);
const scenarioSource=fs.readFileSync('app/frontend/js/scenarios.js','utf8');
const changesSource=scenarioSource.slice(scenarioSource.indexOf('function describeScenarioChanges(scn)'),scenarioSource.indexOf('/** Lanes whose solved volume'));
const changesContext=vm.createContext({executiveEscape:value=>String(value).replaceAll('<','&lt;'),formatNumber:String,laneMovements:()=>[]});
vm.runInContext(changesSource,changesContext);
const changes=changesContext.describeScenarioChanges({movedSites:[{id:'D1',name:'<Moved DC>',lat:33.9,lng:-84.1}]});
assert.equal(changes.length,1);
assert.match(changes[0].text,/33.9, -84.1/);
assert.match(changes[0].text,/&lt;Moved DC>/);
assert(!scenarioSource.includes('this change moved nothing'));
console.log('Location heatmap checks passed: actual weights, zero/missing/offscreen, proportionality, overflow; snapshot and selection guards present.');
