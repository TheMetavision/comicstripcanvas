import fs from 'node:fs';
import { JSDOM } from 'jsdom';
const dom=new JSDOM(fs.readFileSync('../product-builder.html','utf8'),
 {runScripts:'dangerously',pretendToBeVisual:true,url:'https://x/',
  beforeParse(w){
   class F{constructor(){this.complete=false;this._l=[];}
     set src(v){this._src=v;this.complete=true;this.naturalWidth=1600;this.naturalHeight=1600;
       queueMicrotask(()=>this._l.forEach(f=>f()));}
     get src(){return this._src;} addEventListener(t,f){if(t==='load')this._l.push(f);}}
   w.Image=F; w.SVGElement.prototype.getComputedTextLength=()=>1;
   w.SVGElement.prototype.getBBox=()=>({x:0,y:0,width:9,height:9});
   w.Element.prototype.setPointerCapture=()=>{}; w.HTMLCanvasElement.prototype.getContext=()=>null;
   Object.defineProperty(w.HTMLElement.prototype,'clientWidth',{get(){return 1200;}});
   Object.defineProperty(w.HTMLElement.prototype,'clientHeight',{get(){return 800;}});
   w.document.fonts={ready:Promise.resolve(),load:()=>Promise.resolve()};
  }});
const {window}=dom, doc=window.document, $=id=>doc.getElementById(id);
const click=el=>el.dispatchEvent(new window.MouseEvent('click',{bubbles:true}));
await new Promise(r=>setTimeout(r,140));
const cases=[];
for(const name of ['Strip','Cover','Cover (full bleed)','Icon portrait','Icon landscape']){
  click([...$('switch').children].find(b=>b.textContent===name));
  await new Promise(r=>setTimeout(r,60));
  for(const fmt of ['poster','gallery']){
    $('fmtSel').value=fmt; $('fmtSel').dispatchEvent(new window.Event('change',{bubbles:true}));
    await new Promise(r=>setTimeout(r,40));
    for(const si of [0,2]){
      const s=$('sizeSel'); if(si>=s.options.length) continue;
      s.value=si; s.dispatchEvent(new window.Event('change',{bubbles:true}));
      await new Promise(r=>setTimeout(r,50));
      const tag=`${name.replace(/[^a-z]/gi,'')}-${fmt}-${si}`;
      fs.writeFileSync(`run/${tag}.recipe.json`, window.eval('JSON.stringify(recipe())'));
      const live=doc.querySelector('svg').cloneNode(true);
      live.setAttribute('xmlns','http://www.w3.org/2000/svg');
      live.querySelectorAll('.hit,[data-role="guide"]').forEach(e=>e.remove());
      const v=live.getAttribute('viewBox').split(' ').map(Number);
      live.setAttribute('width',Math.round(v[2])); live.setAttribute('height',Math.round(v[3]));
      fs.writeFileSync(`run/${tag}.builder.svg`, new window.XMLSerializer().serializeToString(live));
      cases.push(tag);
    }
  }
}
fs.writeFileSync('run/cases.json',JSON.stringify(cases,null,1));
console.log('captured', cases.length, 'cases');
