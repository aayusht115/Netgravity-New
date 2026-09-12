import { apiClient } from './integration/api-client.js';
import { getActiveProjectId, getActiveSnapshotId, onProjectChange } from './integration/project-context.js';
import { setTwinMapHeat } from './atlas-map.js';
import { setTwin3DHeat, controlTwinCamera } from './twin3d.js';
import { showInfoPanel } from './workspace-chrome.js';
import { escapeAtlasText as esc } from './atlas-geography.js';

let generation=0, loadedKey=null, surface=null, started=false;
const fmt=n=>Number.isFinite(n)?n.toLocaleString(undefined,{maximumFractionDigits:2}):'Not available';
const key=()=>JSON.stringify([getActiveProjectId(),getActiveSnapshotId()]);
function paint() {
  const visible=!!document.getElementById('atlas-demand-heat')?.checked;
  setTwinMapHeat(surface?.points || [],visible);setTwin3DHeat(surface?.points || [],visible);
}
function clear() {
  generation++;loadedKey=null;surface=null;paint();
  const toggle=document.getElementById('atlas-demand-heat');if(toggle)toggle.disabled=true;
  const note=document.getElementById('atlas-demand-scope');if(note)note.textContent='Choose a project with geocoded demand to see concentration.';
}
export async function refreshAtlasWorkspace() {
  const project=getActiveProjectId(),snapshot=getActiveSnapshotId(),currentKey=key();
  if(!project || !snapshot) {clear();return;}
  if(loadedKey===currentKey)return;
  clear();loadedKey=currentKey;
  const request=++generation;
  const note=document.getElementById('atlas-demand-scope');
  if(note)note.textContent='Loading uploaded demand…';
  try {
    const data=await apiClient.get('/api/network/demand-surface',{project_id:project,snapshot_id:snapshot});
    if(request!==generation || currentKey!==key())return;
    if(data.snapshot_id!==snapshot)throw new Error('The project snapshot changed. Reopen this view.');
    surface=data.demand;
    if(!surface || !Array.isArray(surface.points))throw new Error('Demand coordinates are not available for this snapshot.');
    const toggle=document.getElementById('atlas-demand-heat');if(toggle)toggle.disabled=!surface.points.length;
    if(note)note.textContent=`${fmt(surface.mapped_quantity)} of ${fmt(surface.total_quantity)} demand units mapped · ${surface.periods.length} uploaded planning periods, not forecast. ${surface.omitted.length ? surface.omitted.length+' locations lack coordinates.' : ''}`;
    paint();
  } catch(error) {
    if(request!==generation || currentKey!==key())return;
    loadedKey=null;surface=null;paint();
    if(note)note.textContent=error.message || 'Demand heatmap is unavailable. Facility data remains visible.';
  }
}
export function initAtlasWorkspace() {
  if(started)return;started=true;
  document.getElementById('atlas-demand-heat')?.addEventListener('change',paint);
  document.getElementById('atlas-dc-calculations')?.addEventListener('click',()=>document.getElementById('atlas-demand-method')?.click());
  document.getElementById('atlas-dc-insights')?.addEventListener('click',()=>window.navigateToTab?.('facility-dashboard'));
  document.getElementById('atlas-camera-controls')?.addEventListener('click',event=>{
    const action=event.target.closest('[data-camera]')?.dataset.camera;if(action)controlTwinCamera(action);
  });
  document.getElementById('twin-view-toggle')?.addEventListener('click',event=>{
    const view=event.target.closest('[data-view]')?.dataset.view;
    if(view)document.getElementById('atlas-camera-controls').hidden=view!=='3d';
    if(view)document.querySelectorAll('#twin-view-toggle [data-view]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.view===view)));
  });
  document.getElementById('atlas-demand-method')?.addEventListener('click',()=>{
    showInfoPanel('Reading the network map',`<h3>1. Facilities and status</h3><p>The icon identifies a plant, distribution centre or demand market. A DC ring shows solved utilisation: critical at or above 95%, stressed from 85% to below 95%, healthy below 85%. Grey indicates inactive or unavailable utilisation; dashed markers are inactive or proposed sites. Open the facility strips for exact values and IDs.</p><h3>2. Demand and scope</h3><p>${esc(surface?.methodology || 'Demand is unavailable for the current project snapshot.')}</p><p>${esc(document.getElementById('atlas-demand-scope')?.textContent || '')} This layer includes all uploaded planning periods; the top-bar period filter does not narrow it.</p><h3>3. How concentration is drawn</h3><p>Positive uploaded quantities weight radial kernels. Colour is normalised to the maximum density, not an absolute capacity or service-risk score. The 2D map uses a 28-screen-pixel radius; 3D uses 28 pixels on its 1,024-pixel-wide map texture. Zoom and view changes affect appearance, never demand totals or scenario inputs.</p><h3>4. Geographic context</h3><p>Both views use the same Web Mercator projection and bundled Natural Earth relief. Terrain is geographic context, not road routing, property availability or an elevation model. Fit network zooms into the uploaded sites; country view restores geographic context.</p>`);
  });
  onProjectChange(clear);
  for(const name of ['snapshotChanged','identityChanged'])window.addEventListener(name,clear);
  for(const name of ['networkDataLoaded','authoritativeDataLoaded'])window.addEventListener(name,refreshAtlasWorkspace);
  refreshAtlasWorkspace();
}
