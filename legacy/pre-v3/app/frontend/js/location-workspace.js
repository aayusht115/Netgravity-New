/* global L */
import { apiClient } from './integration/api-client.js';
import { scenarioService } from './integration/services/scenario-service.js';
import { getActiveProjectId, getActiveSnapshotId, onProjectChange } from './integration/project-context.js';
import { createLocationBasemap } from './map.js';
import { escapeCalculationText as esc, openCalculations } from './calculations.js';

const fmt = value => Number.isFinite(value) ? value.toLocaleString(undefined, {maximumFractionDigits:2}) : 'Not available';
let generation = 0, active = null;

// One renderer shared with the Digital Twin, retaining this public export.
export { heatPixels } from './demand-heat.js';
import { heatLayer } from './demand-heat.js';
function closeWorkspace() {
  generation++;
  active?.dialog?.close();
}
onProjectChange(closeWorkspace);
for (const name of ['snapshotChanged','identityChanged']) window.addEventListener(name,closeWorkspace);

const input = (id,label,extra='') => `<label for="loc-${id}">${label}<input id="loc-${id}" ${extra}></label>`;
function layout() {
  return `<header class="location-header"><div><h2 id="location-title">Plan a site move</h2><p>Explore demand, inspect an area, then test the network. Your baseline stays unchanged.</p></div><button type="button" id="loc-close" aria-label="Close location planning">Close</button></header>
    <p id="loc-status" role="status">Loading the current project…</p>
    <div class="location-layout" id="loc-body" hidden>
      <div class="location-map-column"><div class="location-map-controls"><label><input type="checkbox" id="loc-heat" checked> Demand heatmap</label><label><input type="checkbox" id="loc-streets"> Street detail (external)</label><button type="button" id="loc-fit">Fit network</button><button type="button" id="loc-centre">Use demand centre</button></div>
        <div id="location-planning-map" aria-label="Location planning map; select a site then drag its highlighted marker or enter coordinates"></div>
        <p class="location-legend"><span class="location-heat-key"></span> Lower → higher demand concentration in this view · DC = distribution centre · P = plant · M = demand location</p>
        <p id="loc-demand-scope"></p><p id="loc-map-notice">Street detail is optional: enabling it shares the viewed map area with OpenStreetMap's tile service. No facility names, demand values or costs are sent.</p>
        <details><summary>How the heatmap and demand centre are calculated</summary><p id="loc-demand-method"></p><p>The heatmap sums quantity-weighted radial kernels within 28 screen pixels and scales colours to the highest visible density. Zoom changes smoothing, not demand or scenario inputs.</p></details>
        <section class="location-research"><h3>Explore nearby warehouse locations</h3><p>Publicly mapped buildings—not available property listings. Search sends only the proposed coordinates and radius to the map provider.</p>
          <div class="location-search-row">${input('radius','Search radius (km)','type="number" min="1" max="25" value="10"')}<button type="button" id="loc-search">Search nearby warehouses</button></div>
          <label><input type="checkbox" id="loc-external-consent"> Allow this area lookup using public map data</label>
          <div id="loc-research-result" aria-live="polite"></div>
        </section>
      </div>
      <form class="location-form" id="loc-form"><h3>1. Choose a site and position</h3><label for="loc-site">Facility<select id="loc-site"></select></label>
        <p>Drag the purple marker, click the map, or enter coordinates. One site per scenario.</p>
        <div class="location-pair">${input('lat','Latitude','type="number" min="-85" max="85" step="any" required')}${input('lng','Longitude','type="number" min="-180" max="180" step="any" required')}</div>
        <button type="button" id="loc-reset">Restore current position</button>
        <h3>2. State the assumptions</h3>
        <label for="loc-tariff">Freight and transit-time model<select id="loc-tariff"><option value="distance_proportional">Scale baseline rates and time with distance</option><option value="uploaded_components">Use uploaded tariff and transit components</option></select></label>
        <p>New distances retain each baseline lane's detour ratio. Road routes, borders and truck access are not verified. Capacity and lane connections stay unchanged.</p>
        <label><input type="checkbox" id="loc-ack" required> I understand these are planning estimates, not route or property quotes.</label>
        <details><summary>Implementation and recurring costs <span id="loc-currency"></span></summary>
          <p>Leave unknown costs blank. Enter 0 only when explicitly assumed or confirmed. Annual fixed cost is the new site's complete recurring fixed cost, not rent added on top of the old cost.</p>
          ${input('annual','New annual fixed operating cost','type="number" min="0" step="any" placeholder="Retain uploaded cost"')}
          <p id="loc-current-fixed"></p>
          ${input('fit-out','Fit-out and equipment (one time)','type="number" min="0" step="any"')}
          ${input('moving','Moving and transition (one time)','type="number" min="0" step="any"')}
          ${input('lease-exit','Existing lease exit (one time)','type="number" min="0" step="any"')}
          ${input('other','Other implementation costs (one time)','type="number" min="0" step="any"')}
          <label for="loc-source">Cost source, date and assumptions<textarea id="loc-source" maxlength="1000" placeholder="Quote reference or explicitly labelled budget estimate"></textarea></label>
        </details>
        <button type="submit" id="loc-preview">Inspect lane changes</button>
        <div id="loc-preview-result" aria-live="polite"></div>
        <h3>3. Calculate the scenario</h3>
        ${input('name','Scenario name','type="text" maxlength="100" required')}
        <button type="button" id="loc-run" class="location-primary" disabled>Calculate & save scenario</button>
        <p>Results are saved against this project snapshot. Implementation-inclusive totals remain unavailable until every cost category is stated.</p>
        <div id="loc-run-result" aria-live="polite"></div>
      </form>
    </div>`;
}

export async function openLocationWorkspace({onSolved}={}) {
  closeWorkspace();
  const dialog = document.createElement('dialog');
  dialog.id='location-workspace'; dialog.setAttribute('aria-labelledby','location-title');
  dialog.innerHTML=layout(); document.body.appendChild(dialog); dialog.showModal();
  const version=++generation, project=getActiveProjectId(), snapshot=getActiveSnapshotId();
  const state={dialog,map:null,preview:null,research:null,candidate:null,edit:0,running:false};
  active=state;
  const $=id=>dialog.querySelector('#loc-'+id);
  const current=()=>version===generation && project===getActiveProjectId() && snapshot===getActiveSnapshotId() && dialog.open;
  const status=message=>{$('status').textContent=message;};
  const scope={project_id:project,snapshot_id:snapshot};
  dialog.addEventListener('close',()=>{if(active===state){active=null;generation++;} state.map?.remove();dialog.remove();},{once:true});
  $('close').onclick=()=>dialog.close();
  let data;
  try { data=await apiClient.get('/api/scenarios/location-workspace',scope); }
  catch(error){if(current())status(error.message || 'The current network could not be loaded.');return;}
  if (!current()) return;
  if (data.snapshot_id!==snapshot) {status('The project changed. Close and reopen the location planner.');return;}
  const sites=data.sites.filter(s=>s.movable);
  if (!sites.length) {status('No existing plant or distribution centre has usable geographic coordinates. Update the upload before planning a move.');return;}
  $('body').hidden=false;
  $('site').innerHTML=sites.map(s=>`<option value="${esc(s.id)}">${esc(s.name)} · ${esc(s.id)}</option>`).join('');
  $('currency').textContent=data.currency || '(upload currency not stated)';
  const surface=data.demand;
  $('demand-scope').textContent=`${fmt(surface.mapped_quantity)} of ${fmt(surface.total_quantity)} demand units mapped (${fmt(surface.coverage_pct)}%). ${surface.omitted.length} demand locations lack coordinates. Scope: ${surface.periods.length} uploaded planning periods; not forecast demand.`;
  $('demand-method').textContent=surface.methodology;
  const map=state.map=createLocationBasemap(dialog.querySelector('#location-planning-map'));
  const pins=L.layerGroup().addTo(map), researchPins=L.layerGroup().addTo(map);
  const heat=heatLayer(map,surface.points);
  // Country vectors use tilePane; keep optional streets above their opaque
  // land fill but below demand, flow and facility overlays.
  map.createPane('locationStreets').style.zIndex='250';
  let streets=null;
  $('streets').onchange=()=>{
    if(!$('streets').checked){if(streets)map.removeLayer(streets);return;}
    if(!streets){streets=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{
      pane:'locationStreets',maxZoom:18,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'});
      streets.on('tileerror',()=>{$('map-notice').textContent='Some street tiles are unavailable. The facility and demand overlays still use your uploaded coordinates; no replacement geography is invented.';});}
    streets.addTo(map);
  };
  let draft, line;
  const site=()=>sites.find(s=>s.id===$('site').value);
  const validPoint=()=>Number.isFinite(Number($('lat').value)) && $('lat').value!=='' && Number.isFinite(Number($('lng').value)) && $('lng').value!=='' && Math.abs(Number($('lat').value))<=85 && Math.abs(Number($('lng').value))<=180;
  function invalidate() {
    state.edit++; state.preview=null; $('run').disabled=true;
    $('preview-result').textContent='Position or assumptions changed. Inspect lane changes before calculating.';
    $('run-result').replaceChildren();
    status('Position or assumptions changed. Inspect lane changes to refresh the scenario inputs.');
  }
  function syncPin() {
    if (!validPoint() || !draft) return;
    const latlng=[Number($('lat').value),Number($('lng').value)];
    draft.setLatLng(latlng); line.setLatLngs([[site().latitude,site().longitude],latlng]);
  }
  function setPoint(lat,lng,candidate=null) {
    if(state.running) return;
    $('lat').value=lat; $('lng').value=lng;state.candidate=candidate;
    invalidate();syncPin();
  }
  function renderPins() {
    pins.clearLayers();
    for(const s of data.sites) {
      if(!Number.isFinite(s.latitude)||!Number.isFinite(s.longitude))continue;
      const isSelected=s.id===site().id;
      const marker=L.marker([s.latitude,s.longitude],{icon:L.divIcon({className:'location-pin '+(isSelected?'location-origin':''),html:esc(s.role==='PLANT'?'P':['DC','WAREHOUSE'].includes(s.role)?'DC':s.role==='SUPPLIER'?'S':'M'),iconSize:[28,28]}),title:s.name+' · '+s.id});
      marker.bindTooltip(`${esc(s.name)} · ${esc(s.id)}${isSelected?' · current position':''}`);
      if(s.movable)marker.on('click',()=>{if(state.running)return;$('site').value=s.id;selectSite();});
      pins.addLayer(marker);
    }
    line=L.polyline([[site().latitude,site().longitude],[Number($('lat').value),Number($('lng').value)]],{color:'#7628b4',dashArray:'6 6'}).addTo(pins);
    draft=L.marker([Number($('lat').value),Number($('lng').value)],{draggable:!state.running,
      icon:L.divIcon({className:'location-pin location-draft',html:site().role==='PLANT'?'P':'DC',iconSize:[36,36]}),
      title:'Proposed position for '+site().name+' — drag to test a move'}).addTo(pins);
    draft.bindTooltip('Proposed '+esc(site().name)+' · drag to move');
    draft.on('dragend',()=>{const p=draft.getLatLng();setPoint(p.lat,((p.lng+180)%360+360)%360-180);});
  }
  function selectSite() {
    state.candidate=null;state.preview=null;
    $('lat').value=site().latitude;$('lng').value=site().longitude;
    $('name').value='Relocate '+site().name;
    $('current-fixed').textContent=`Uploaded annual fixed cost: ${fmt(site().fixed_cost_per_year)} ${data.currency || 'currency units'}. Blank retains this assumption; it does not establish local rent.`;
    // Costs entered for one site must not be silently carried to another.
    for(const key of ['annual','fit-out','moving','lease-exit','other','source'])$(key).value='';
    invalidate();renderPins();
    status('Select an operating site and drag its purple marker. Inspect assumptions before saving a scenario.');
  }
  function fit() {
    const points=data.sites.filter(s=>Number.isFinite(s.latitude)&&Number.isFinite(s.longitude)).map(s=>[s.latitude,s.longitude]);
    if(validPoint())points.push([Number($('lat').value),Number($('lng').value)]);
    if(points.length)map.fitBounds(points,{padding:[35,35],maxZoom:10});
  }
  $('site').onchange=selectSite;
  $('fit').onclick=fit;
  $('reset').onclick=()=>setPoint(site().latitude,site().longitude);
  $('centre').disabled=!surface.centre;
  $('centre').onclick=()=>{setPoint(surface.centre.latitude,surface.centre.longitude);fit();status('Demand centre selected as a search starting point—not an optimal or buildable site. Check nearby locations and network results.');};
  $('heat').onchange=()=>{$('heat').checked?heat.addTo(map):map.removeLayer(heat);};
  map.on('click',event=>{setPoint(event.latlng.lat,((event.latlng.lng+180)%360+360)%360-180);});
  $('form').addEventListener('input',event=>{
    if(event.target.id==='loc-name')return;
    invalidate();
    if(['loc-lat','loc-lng'].includes(event.target.id)){state.candidate=null;syncPin();}
  });
  const optional=id=>$(id).value.trim()===''?null:Number($(id).value);
  function assumptions(){return {latitude:Number($('lat').value),longitude:Number($('lng').value),
    tariff_model:$('tariff').value,acknowledge_estimates:$('ack').checked,
    annual_fixed_cost:optional('annual'),fit_out:optional('fit-out'),moving:optional('moving'),
    lease_exit:optional('lease-exit'),other:optional('other'),cost_source:$('source').value,
    research_id:state.research?.research_id || null,candidate_id:state.candidate?.id || null};}
  $('form').onsubmit=async event=>{
    event.preventDefault();const edit=state.edit;
    $('preview').disabled=true;status('Calculating affected lanes from the current snapshot…');
    const selected=site().id, spec=assumptions();
    try {
      const response=await apiClient.post('/api/scenarios/location-preview',{...scope,facility_id:selected,relocation:spec});
      if(!current() || edit!==state.edit)return;
      state.preview={trace:response.relocation,spec,facilityId:selected};
      const t=response.relocation;
      $('preview-result').innerHTML=`<h4>Lane changes ready</h4><p>${t.lanes.length} affected lanes. Demand-weighted straight-line distance: ${fmt(t.baseline_proximity.weighted_distance_km)} → ${fmt(t.proposed_proximity.weighted_distance_km)} km.</p><p>This proximity measure covers all mapped demand, not the selected site's allocated customers. Savings and service are evaluated by the next solve.</p><details><summary>Inspect every affected lane</summary><div class="location-table-scroll"><table><thead><tr><th>Lane</th><th>Distance km</th><th>Rate / unit</th><th>Transit days</th></tr></thead><tbody>${t.lanes.map(r=>`<tr><th>${esc(r.origin_id)} → ${esc(r.destination_id)}</th><td>${fmt(r.before.distance_km)} → ${fmt(r.after.distance_km)}</td><td>${fmt(r.before.rate_per_unit)} → ${fmt(r.after.rate_per_unit)}</td><td>${fmt(r.before.lead_time_days)} → ${fmt(r.after.lead_time_days)}</td></tr>`).join('')}</tbody></table></div></details>`;
      $('run').disabled=false;status('Lane assumptions are ready. Calculate the scenario to evaluate network cost, service and capacity.');
    }catch(error){if(current()&&edit===state.edit){$('preview-result').textContent=error.message;status('The move needs corrected inputs before it can be evaluated.');}}
    finally{if(current())$('preview').disabled=false;}
  };
  $('search').onclick=async()=>{
    if(state.running)return;
    if(!validPoint())return status('Enter valid proposed coordinates first.');
    if(!$('external-consent').checked)return status('Confirm the public area lookup before sharing the search coordinates.');
    const lat=Number($('lat').value),lng=Number($('lng').value),radius=Number($('radius').value);
    if(!Number.isFinite(radius)||radius<1||radius>25)return status('Choose a search radius between 1 and 25 km.');
    $('search').disabled=true;$('research-result').textContent='Looking up publicly mapped warehouse buildings…';
    const edit=state.edit;
    try{
      const result=await apiClient.post('/api/scenarios/location-research',{...scope,search:{latitude:lat,longitude:lng,radius_km:radius,consent_external:true}},{timeout:45000});
      if(!current())return;
      if(edit!==state.edit){$('research-result').textContent='The position or assumptions changed during the lookup. Search again for the current position.';return;}
      state.research=result;state.candidate=null;invalidate();researchPins.clearLayers();
      $('research-result').innerHTML=`<p>${esc(result.attribution)} · Retrieved ${esc(result.retrieved_at)} · Map data as of ${esc(result.osm_data_timestamp || 'not supplied by provider')} · ${fmt(result.demand_coverage_pct)}% demand coverage</p><p>Search centre: ${fmt(lat)}, ${fmt(lng)} · ${fmt(radius)} km radius. These results stay tied to this search area even if you move the pin.</p><p>Ranked only by demand proximity within this returned set. No availability, rent or total-cost recommendation is implied.${result.truncated?' Results were capped at 100 buildings; narrow the radius.':''}</p>${result.results.length?`<ol class="location-shortlist">${result.results.map((r,i)=>`<li><div><strong>${esc(r.name)}</strong><p>${fmt(r.demand_weighted_distance_km)} km demand-weighted distance · ${fmt(r.distance_from_search_km)} km from search centre</p><a href="${esc(r.source_url)}" target="_blank" rel="noopener noreferrer">Source map record</a></div><button type="button" data-candidate="${i}">Test this location</button></li>`).join('')}</ol>`:'<p>No mapped warehouse buildings were returned. This does not mean no warehouses exist or are available in the area.</p>'}`;
      const choose=r=>{setPoint(r.latitude,r.longitude,r);map.setView([r.latitude,r.longitude],Math.max(map.getZoom(),11));status('Mapped building selected for testing. Availability, access and costs still require verification.');};
      $('research-result').querySelectorAll('[data-candidate]').forEach(button=>button.onclick=()=>choose(result.results[Number(button.dataset.candidate)]));
      for(const r of result.results){L.circleMarker([r.latitude,r.longitude],{radius:6,color:'#0d766e',fillOpacity:.65}).bindTooltip(esc(r.name)).on('click',()=>choose(r)).addTo(researchPins);}
    }catch(error){if(current()&&edit===state.edit){$('research-result').textContent=error.message;}}
    finally{if(current())$('search').disabled=false;}
  };
  $('run').onclick=async()=>{
    if(!state.preview||state.running||!$('form').reportValidity())return;
    const captured=state.preview;state.running=true;
    const controls=[...$('form').querySelectorAll('input,select,textarea,button')];
    controls.forEach(control=>control.disabled=true);draft.dragging.disable();
    status('Solving this relocation scenario. It will be saved against the current snapshot; closing this view does not cancel the server run.');
    const name=$('name').value.trim();let saved=false;
    try{
      const result=await scenarioService.simulateScenario({...scope,name,action:'MOVE_FACILITY',facility_ids:[captured.facilityId],relocation:captured.spec});
      if(!current())return;
      saved=true;onSolved?.(result);
      const impact=result.implementation_impact || {};
      const cost=result.scenario_kpis?.business_network_cost?.value;
      $('run-result').innerHTML=`<h4>Scenario saved</h4><dl><dt>Network cost for the modeled horizon</dt><dd>${fmt(cost)} ${esc(data.currency||'')}</dd><dt>One-time implementation costs</dt><dd>${fmt(impact.one_time_cost)}</dd><dt>Net cost impact including implementation</dt><dd>${fmt(impact.net_horizon_impact)}</dd></dl><p>${esc(impact.basis||'')} Negative net impact means lower total cost under these assumptions; positive means additional cost.</p><button type="button" id="loc-calculations">See calculations / Download Word</button>`;
      $('calculations').onclick=()=>openCalculations(`/api/scenarios/${encodeURIComponent(result.id)}/calculations`);
      status('Relocation scenario saved. Compare it with the baseline in Scenario Planning.');
    }catch(error){if(current()){status('The scenario did not return a result. If the connection timed out, check the scenario list before retrying.');$('run-result').textContent=error.message;}}
    finally{if(current()){state.running=false;controls.forEach(control=>control.disabled=false);$('run').disabled=saved;draft.dragging.enable();}}
  };
  selectSite();map.invalidateSize();fit();
}
