import fs from 'node:fs';
import { PNG } from 'pngjs';
const [,, A, B, label] = process.argv;
const a=PNG.sync.read(fs.readFileSync(A)), b=PNG.sync.read(fs.readFileSync(B));
if(a.width!==b.width||a.height!==b.height){
  console.log(`${label}: SIZE MISMATCH ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  process.exit(1);
}
let diff=0, worst=0;
const out=new PNG({width:a.width,height:a.height});
for(let i=0;i<a.data.length;i+=4){
  const d=Math.max(Math.abs(a.data[i]-b.data[i]),Math.abs(a.data[i+1]-b.data[i+1]),
                   Math.abs(a.data[i+2]-b.data[i+2]));
  worst=Math.max(worst,d);
  if(d>10){ diff++; out.data[i]=255;out.data[i+1]=0;out.data[i+2]=255;out.data[i+3]=255; }
  else { const g=(a.data[i]+a.data[i+1]+a.data[i+2])/3;
    out.data[i]=out.data[i+1]=out.data[i+2]=Math.round(190+g*0.25); out.data[i+3]=255; }
}
const tot=a.width*a.height;
fs.writeFileSync('run/diff-'+label+'.png',PNG.sync.write(out));
console.log(`${label.padEnd(18)} ${a.width}x${a.height}  differing: ${diff} px (${(diff/tot*100).toFixed(4)}%)  worst delta ${worst}`);
