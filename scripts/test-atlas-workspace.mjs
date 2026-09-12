import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {mercatorUV,markerStyle} from '../app/frontend/js/atlas-geography.js';
import {heatLayer} from '../app/frontend/js/demand-heat.js';
assert.deepEqual(mercatorUV(0,0),{u:.5,v:.5});
assert(Math.abs(mercatorUV(85.0511287798066,180).v)<1e-12);
assert(Math.abs(mercatorUV(-85.0511287798066,-180).v-1)<1e-12);
for (const [util,colour] of [[0,'#047857'],[84.9,'#047857'],[85,'#b45309'],[94.99,'#b45309'],[95,'#b91c1c'],[95.01,'#b91c1c'],[null,'#94a3b8']]) {
  assert.equal(markerStyle({utilPct:util,isOpen:true},'dc').ring,colour);
}
assert.equal(markerStyle({utilPct:0,isOpen:false},'dc').ring,'#94a3b8');
assert.equal(markerStyle({status:'CANDIDATE',utilPct:0},'dc').inactive,true);
assert.equal(markerStyle({status:'CANDIDATE',isOpen:true,utilPct:40},'dc').inactive,false);
assert.match(markerStyle({},'plant').icon,/factory.svg$/);
assert.match(markerStyle({},'dc').icon,/warehouse.svg$/);
assert.match(markerStyle({},'market').icon,/map-pin.svg$/);

let project='A',snapshot='A1';
const requests=[],renders=[];
const elements=new Map([['atlas-demand-heat',{checked:true,disabled:true}],['atlas-demand-scope',{textContent:''}]]);
const context=vm.createContext({console,document:{getElementById:id=>elements.get(id)},window:{},JSON,Number});
const dependencies={
  './integration/api-client.js':{apiClient:{get:(path,scope)=>new Promise((resolve,reject)=>requests.push({path,scope,resolve,reject}))}},
  './integration/project-context.js':{getActiveProjectId:()=>project,getActiveSnapshotId:()=>snapshot,onProjectChange:()=>{}},
  './atlas-map.js':{setTwinMapHeat:(points,visible)=>renders.push({view:'2d',points,visible})},
  './twin3d.js':{setTwin3DHeat:(points,visible)=>renders.push({view:'3d',points,visible}),controlTwinCamera:()=>{}},
  './workspace-chrome.js':{showInfoPanel:()=>{}},
  './atlas-geography.js':{escapeAtlasText:String},
};
const mod=new vm.SourceTextModule(fs.readFileSync('app/frontend/js/atlas-workspace.js','utf8'),{context});
await mod.link(name=>{const values=dependencies[name];assert(values,name);return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value]of Object.entries(values))this.setExport(key,value);},{context});});
await mod.evaluate();
const response=(id,weight)=>({snapshot_id:id,demand:{points:[{latitude:33,longitude:-84,quantity:weight}],mapped_quantity:weight,total_quantity:weight,periods:[1,2],omitted:[]}});
const first=mod.namespace.refreshAtlasWorkspace();
assert.deepEqual({...requests[0].scope},{project_id:'A',snapshot_id:'A1'});
project='B';snapshot='B1';const second=mod.namespace.refreshAtlasWorkspace();
requests[1].resolve(response('B1',630));await second;
requests[0].resolve(response('A1',99));await first;
assert.equal(renders.at(-1).points[0].quantity,630,'Late old-project demand cannot overwrite current heatmap');
assert.match(elements.get('atlas-demand-scope').textContent,/630 of 630/);
assert.match(elements.get('atlas-demand-scope').textContent,/2 uploaded planning periods, not forecast/);
assert.equal(elements.get('atlas-demand-heat').disabled,false);
snapshot='B2';const bad=mod.namespace.refreshAtlasWorkspace();requests[2].resolve(response('B1',777));await bad;
assert.equal(renders.at(-1).points.length,0,'Wrong snapshot clears heat instead of showing stale demand');
assert.equal(elements.get('atlas-demand-heat').disabled,true);
assert.match(elements.get('atlas-demand-scope').textContent,/snapshot changed/);
const error=mod.namespace.refreshAtlasWorkspace();requests[3].reject(new Error('Demand unavailable'));await error;
assert.equal(renders.at(-1).points.length,0);
project=null;snapshot=null;await mod.namespace.refreshAtlasWorkspace();
assert.match(elements.get('atlas-demand-scope').textContent,/Choose a project/);
const html=fs.readFileSync('app/frontend/index.html','utf8');
for(const table of ['plants','dcs','markets'])assert.match(html,new RegExp('id="table-'+table+'"'));
assert.equal((html.match(/<details class="card atlas-facility-strip"/g)||[]).length,3);
for(const column of ['Plant ID','DC ID','Market ID','Throughput','Utilisation','Priority','SLA'])assert(html.includes('>'+column+'<'));
// Leaflet overlay-pane translation must cancel the canvas origin, so density
// remains directly under its market even when the old location CSS is absent.
let draw,heatImage;
const heatCanvas={style:{},remove(){},getContext:()=>({
  createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),
  putImageData:img=>{heatImage=img;},
})};
const globals={L:globalThis.L,requestAnimationFrame:globalThis.requestAnimationFrame,cancelAnimationFrame:globalThis.cancelAnimationFrame};
try {
  globalThis.requestAnimationFrame=fn=>{draw=fn;return 1;};
  globalThis.cancelAnimationFrame=()=>{};
  globalThis.L={
    Layer:{extend:methods=>class{constructor(){Object.assign(this,methods);}addTo(){this.onAdd();}}},
    DomUtil:{create:()=>heatCanvas,setPosition:(canvas,point)=>{canvas.origin=point;}},
  };
  let paneOffset={x:55,y:25};
  const map={getPanes:()=>({overlayPane:{appendChild(){}}}),getSize:()=>({x:100,y:100}),
    containerPointToLayerPoint:()=>({x:-paneOffset.x,y:-paneOffset.y}),
    latLngToContainerPoint:()=>({x:30,y:70}),on(){},off(){}};
  const layer=heatLayer(map,[{latitude:34,longitude:-84,quantity:420}]);draw();
  assert.equal(heatCanvas.style.position,'absolute');
  assert.equal(heatCanvas.style.left,'0');assert.equal(heatCanvas.style.top,'0');
  assert.equal(heatCanvas.style.pointerEvents,'none');
  assert.equal(heatCanvas.origin.x+paneOffset.x+30,30);
  assert.equal(heatCanvas.origin.y+paneOffset.y+70,70);
  assert.equal(heatImage.data[(70*100+30)*4+3],210);
  paneOffset={x:-91,y:110};layer.redraw();draw();
  assert.equal(heatCanvas.origin.x+paneOffset.x+30,30,'Pan keeps heat pinned to market');
  layer.onRemove();
} finally {for(const [name,value]of Object.entries(globals)) {if(value===undefined)delete globalThis[name];else globalThis[name]=value;}}
console.log('Atlas checks passed: aligned Mercator and Leaflet heat pixels, DC thresholds/inactive states, shared role glyphs, actual demand/scope, stale/error/empty handling and all table fields.');
