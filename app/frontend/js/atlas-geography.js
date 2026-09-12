export const RELIEF_URL = new URL('../assets/maps/natural-earth-mercator.webp', import.meta.url).href;
export const MERCATOR_LIMIT = 85.0511287798066;
export const escapeAtlasText = value => String(value ?? '').replace(/[&<>"']/g,
  ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
export function mercatorUV(latitude, longitude) {
  const lat = Math.max(-MERCATOR_LIMIT,Math.min(MERCATOR_LIMIT,latitude))*Math.PI/180;
  return {u:(longitude+180)/360,v:(1-Math.asinh(Math.tan(lat))/Math.PI)/2};
}
let reliefPromise;
export function loadRelief() {
  if (!reliefPromise) reliefPromise = new Promise((resolve,reject)=>{
    const image = new Image(); image.onload=()=>resolve(image); image.onerror=reject; image.src=RELIEF_URL;
  }).catch(error=>{reliefPromise=null;throw error;});
  return reliefPromise;
}

/** Same role glyphs in 2D and 3D; only a DC's outer ring encodes utilisation. */
export function markerStyle(node, role) {
  const inactive = node.isOpen === false || (String(node.status || '').toUpperCase()==='CANDIDATE' && node.isOpen !== true);
  const colours = {plant:'#7636e8',dc:'#2479ca',market:'#4d9a6b'};
  let ring=colours[role];
  if(role==='dc') ring=inactive || !Number.isFinite(node.utilPct) ? '#94a3b8'
    : node.utilPct>=95 ? '#b91c1c' : node.utilPct>=85 ? '#b45309' : '#047857';
  const icon={plant:'factory',dc:'warehouse',market:'map-pin'}[role];
  return {ring,inactive,icon:new URL(`../assets/icons/${icon}.svg`,import.meta.url).href};
}
