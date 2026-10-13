import { WebSocket } from 'ws';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const targets=async()=>(await(await fetch('http://127.0.0.1:9333/json')).json()).filter(x=>x.type==='page');
function attach(u){const ws=new WebSocket(u);let id=0;
  const a={ws,send:(m,p)=>new Promise(r=>{const i=++id;const h=x=>{const d=JSON.parse(x.toString());if(d.id===i){ws.off('message',h);r(d);}};ws.on('message',h);ws.send(JSON.stringify({id:i,method:m,params:p}));})};
  a.ev=async e=>(await a.send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true,userGesture:true})).result?.result?.value;
  return new Promise((res,rej)=>{ws.on('open',()=>res(a));ws.on('error',rej);});}
const pass=(n,ok,d='')=>console.log(`  ${ok?'PASS':'FAIL'}  ${n}${d?'  — '+d:''}`);
const main=(await targets()).find(x=>!x.url.includes('overlay')&&!x.url.includes('region'));
const app=await attach(main.webSocketDebuggerUrl);

const srcs=JSON.parse(await app.ev(`(async()=>JSON.stringify((await window.desktop.screens.list()).map(s=>({id:s.id,kind:s.kind,name:s.name}))))()`));
console.log('  available sources:', srcs.map(s=>`${s.kind}:${s.name.slice(0,30)}`).join(' | '));
const win = srcs.find(s=>s.kind==='window') || srcs[0];
console.log('  targeting:', win.name.slice(0,40));

await app.ev(`(()=>{const s=JSON.parse(localStorage.getItem('call-copilot.settings.v1')||'{}');
  s.answerProvider='nova'; s.detail='brief'; s.screenSourceId=${JSON.stringify(win.id)}; s.screenSourceName=${JSON.stringify(win.name)};
  localStorage.setItem('call-copilot.settings.v1',JSON.stringify(s)); return 1;})()`);
await app.send('Page.reload'); await sleep(3500);
const a2=await attach(main.webSocketDebuggerUrl);
await a2.ev(`document.getElementById('clearAnswers').click(); document.getElementById('readScreen').click();`);
let vis='';
for(let i=0;i<14;i++){ await sleep(3000);
  vis=await a2.ev(`document.querySelector('.answer-body')?.textContent?.trim()||''`);
  if(vis.length>40) break; }
const refused=/cannot read|re-snip/i.test(vis);
pass('vision read returns something coherent', vis.length>20, vis.slice(0,120));
console.log(refused ? '   (model declined — nothing readable in that window)' : '   (model read the window content)');
process.exit(0);
