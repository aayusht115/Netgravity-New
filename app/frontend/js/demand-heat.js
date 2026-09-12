/* global L */
/** Shared quantity-weighted density rendering; never used as solver input. */
export function heatPixels(width, height, points, radius = 28) {
  const density = new Float32Array(width * height);
  const scale=points.reduce((max,p)=>Number.isFinite(p.weight)?Math.max(max,p.weight):max,0);
  if(!scale)return new Uint8ClampedArray(width*height*4);
  let max = 0;
  for (const p of points) {
    if (!(p.weight > 0) || !Number.isFinite(p.weight) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const left = Math.max(0, Math.floor(p.x-radius)), right = Math.min(width-1, Math.ceil(p.x+radius));
    const top = Math.max(0, Math.floor(p.y-radius)), bottom = Math.min(height-1, Math.ceil(p.y+radius));
    for (let y=top; y<=bottom; y++) for (let x=left; x<=right; x++) {
      const r2 = ((x-p.x)**2+(y-p.y)**2)/(radius*radius);
      if (r2 >= 1) continue;
      const index = y*width+x;
      density[index] += (p.weight/scale) * (1-r2)**2;
      max = Math.max(max,density[index]);
    }
  }
  const rgba = new Uint8ClampedArray(width*height*4);
  if (!max) return rgba;
  for (let i=0; i<density.length; i++) {
    if (!density[i]) continue;
    const t = density[i]/max;
    rgba[i*4]=245; rgba[i*4+1]=Math.round(190*(1-t)); rgba[i*4+2]=Math.round(55*(1-t));
    rgba[i*4+3]=Math.round(210*Math.sqrt(t));
  }
  return rgba;
}

export function heatLayer(map, points) {
  const layer = new (L.Layer.extend({
    onAdd() {
      this.canvas = L.DomUtil.create('canvas','atlas-demand-heat-canvas');
      // This layer owns its positioning. Depending on the old scenario
      // stylesheet puts the canvas in normal flow and offsets the heat from
      // the actual market coordinates when that screen is not shipped.
      Object.assign(this.canvas.style, {
        position: 'absolute', left: '0', top: '0', pointerEvents: 'none',
      });
      map.getPanes().overlayPane.appendChild(this.canvas);
      this.redraw = () => {
        cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(() => {
          const size = map.getSize(), canvas = this.canvas;
          if (!canvas || size.x <= 0 || size.y <= 0) return;
          canvas.width = size.x; canvas.height = size.y;
          L.DomUtil.setPosition(canvas,map.containerPointToLayerPoint([0,0]));
          const ctx = canvas.getContext('2d');
          const image = ctx.createImageData(size.x,size.y);
          image.data.set(heatPixels(size.x,size.y,points.map(p=>{
            const xy=map.latLngToContainerPoint([p.latitude,p.longitude]);
            return {x:xy.x,y:xy.y,weight:p.quantity};
          })));
          ctx.putImageData(image,0,0);
        });
      };
      map.on('move zoom resize',this.redraw); this.redraw();
    },
    onRemove() { cancelAnimationFrame(this.frame); map.off('move zoom resize',this.redraw); this.canvas?.remove(); this.canvas=null; },
  }))();
  layer.addTo(map); return layer;
}
