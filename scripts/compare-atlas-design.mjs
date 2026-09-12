import {createRequire} from 'node:module';
const sharp=createRequire(import.meta.url)('sharp');
const [reference,implementation,output]=process.argv.slice(2);
if(!output)throw new Error('Usage: node scripts/compare-atlas-design.mjs reference screenshot output');
const {width,height}=await sharp(implementation).metadata();
await sharp({create:{width:width*2,height,channels:3,background:'#fff'}}).composite([
  {input:await sharp(reference).resize(width,height).toBuffer(),left:0,top:0},
  {input:implementation,left:width,top:0},
]).png().toFile(output);
// Equal-size detail crops from the same normalized pair keep small controls
// and table typography readable during visual comparison.
for(const [name,top,cropHeight] of [['header',0,245],['tables',730,326]]) {
  const crop={left:220,top,width:width-220,height:Math.min(cropHeight,height-top)};
  const referenceCrop=await sharp(await sharp(reference).resize(width,height).toBuffer()).extract(crop).toBuffer();
  const implementationCrop=await sharp(implementation).extract(crop).toBuffer();
  await sharp({create:{width:crop.width*2,height:crop.height,channels:3,background:'#fff'}}).composite([
    {input:referenceCrop,left:0,top:0},{input:implementationCrop,left:crop.width,top:0},
  ]).png().toFile(output.replace(/\.png$/,`-${name}.png`));
}
