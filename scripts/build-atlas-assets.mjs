// Rebuild locally bundled, public-domain geographic relief and MIT icons.
// Usage: NODE_PATH=<sharp module directory> node scripts/build-atlas-assets.mjs <asset source directory>
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const sharp = createRequire(import.meta.url)('sharp');
const source = process.argv[2];
if (!source) throw new Error('Supply the directory containing NE1_50M_SR_W and @phosphor-icons/core package.');
const target = path.resolve('app/frontend/assets');
await fs.mkdir(path.join(target, 'icons'), {recursive:true});
await fs.mkdir(path.join(target, 'maps'), {recursive:true});
const colours = {factory:'#7636e8',warehouse:'#2479ca','map-pin':'#4d9a6b',graph:'#4b61ab',path:'#51607d',warning:'#d88432'};
for (const name of ['factory','warehouse','map-pin','graph','path','warning','plus','minus','caret-down']) {
  const svg = await fs.readFile(path.join(source, 'package/assets/regular', name+'.svg'), 'utf8');
  await fs.writeFile(path.join(target, 'icons', name+'.svg'), svg.replace('fill="currentColor"', `fill="${colours[name] || '#455775'}"`));
}
await fs.writeFile(path.join(target,'icons/PHOSPHOR-LICENSE'),
  (await fs.readFile(path.join(source,'package/LICENSE'),'utf8')).replace(/\r\n/g,'\n'));
// Natural Earth I 50m is equirectangular. Reproject the public-domain pixels
// into Web Mercator, rather than stretching latitude and misplacing terrain.
const size = 4096;
const {data,info} = await sharp(path.join(source,'NE1_50M_SR_W/NE1_50M_SR_W.tif'))
  .resize(size,size/2).removeAlpha().raw().toBuffer({resolveWithObject:true});
const output = Buffer.alloc(size*size*info.channels);
const rowBytes = size*info.channels;
for (let y=0;y<size;y++) {
  const lat = Math.atan(Math.sinh(Math.PI*(1-2*(y+.5)/size)))*180/Math.PI;
  const srcY = Math.max(0,Math.min(info.height-1,(90-lat)/180*info.height-.5));
  const a = Math.floor(srcY), b = Math.min(info.height-1,a+1), fraction=srcY-a;
  for(let x=0;x<rowBytes;x++) output[y*rowBytes+x] = Math.round(data[a*rowBytes+x]*(1-fraction)+data[b*rowBytes+x]*fraction);
}
await sharp(output,{raw:{width:size,height:size,channels:info.channels}})
  .webp({quality:86}).toFile(path.join(target,'maps/natural-earth-mercator.webp'));
console.log('Bundled relief (4096 × 4096 Web Mercator) and nine Phosphor icons.');
