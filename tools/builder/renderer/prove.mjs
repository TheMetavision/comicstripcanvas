import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { Resvg } from '@resvg/resvg-js';
import { PNG } from 'pngjs';
const fonts=fs.readdirSync('_fonts').map(f=>'_fonts/'+f);
const cases=JSON.parse(fs.readFileSync('run/cases.json','utf8'));
let worstPct=0, fails=0;
console.log('case                              size          differing px      worst Δ');
for(const tag of cases){
  const svg=fs.readFileSync(`run/${tag}.builder.svg`,'utf8');
  const vb=/viewBox="([^"]+)"/.exec(svg)[1].split(/\s+/).map(Number);
  const W=Math.min(2200,Math.round(vb[2]));   // cap the raster; both sides scale alike
  const bR=new Resvg(svg,{fitTo:{mode:'width',value:W},
    font:{fontFiles:fonts,loadSystemFonts:false,defaultFontFamily:'Chewy'},background:'white'}).render();
  execSync(`node render.mjs --recipe run/${tag}.recipe.json --assets assets-preview --fonts _fonts --preview --width ${W} --out run/${tag}.r.png`,{stdio:'pipe'});
  const a=PNG.sync.read(bR.asPng()), b=PNG.sync.read(fs.readFileSync(`run/${tag}.r.png`));
  if(a.width!==b.width||a.height!==b.height){
    console.log(`${tag.padEnd(33)} SIZE MISMATCH ${a.width}x${a.height} vs ${b.width}x${b.height}`); fails++; continue;
  }
  let diff=0,worst=0; const hits=[];
  for(let i=0;i<a.data.length;i+=4){
    const d=Math.max(Math.abs(a.data[i]-b.data[i]),Math.abs(a.data[i+1]-b.data[i+1]),Math.abs(a.data[i+2]-b.data[i+2]));
    worst=Math.max(worst,d);
    if(d>10){ diff++; if(diff<4){ const px=(i/4)|0; hits.push(`${px%a.width},${(px/a.width)|0}`);} }
  }
  const pct=diff/(a.width*a.height)*100; worstPct=Math.max(worstPct,pct);
  if(pct>0.01) fails++;
  console.log(`${tag.padEnd(33)} ${(a.width+'x'+a.height).padEnd(13)} ${String(diff).padStart(8)} (${pct.toFixed(4)}%)   ${String(worst).padStart(3)}` + (hits.length?`   first at ${hits.join(' ')}`:''));
}
console.log(`\n${cases.length-fails}/${cases.length} match. Worst divergence ${worstPct.toFixed(4)}%.`);
process.exit(fails?1:0);
