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

console.log('=== 11. SCREEN CAPTURE ===');
const list=await app.ev(`(async()=>JSON.stringify((await window.desktop.screens.list()).map(s=>({k:s.kind,n:s.name.slice(0,28),t:!!s.thumbnail}))))()`);
const srcs=JSON.parse(list);
pass('screens + windows enumerated', srcs.length>0, srcs.length+' sources, '+srcs.filter(s=>s.k==='screen').length+' displays');
pass('thumbnails present', srcs.every(s=>s.t));
pass('own windows excluded', !srcs.some(s=>/Call Copilot/i.test(s.n)));
const shot=await app.ev(`(async()=>{const l=await window.desktop.screens.list(); const s=l.find(x=>x.kind==='screen');
  const r=await window.desktop.screens.capture(s.id,s.name);
  return JSON.stringify({ok:r.ok,w:r.width,kb:Math.round((r.bytes||0)/1024),jpeg:r.dataUrl.startsWith('data:image/jpeg')});})()`);
const sh=JSON.parse(shot);
pass('whole-screen capture works', sh.ok&&sh.w>0, sh.w+'px, '+sh.kb+'KB, jpeg='+sh.jpeg);
pass('payload under body limit', sh.kb<2000, sh.kb+'KB vs 16MB limit');

console.log('\n=== 12. SCREEN READ -> ANSWER (vision) ===');
await app.ev(`(()=>{const s=JSON.parse(localStorage.getItem('call-copilot.settings.v1')||'{}');
  s.answerProvider='nova'; s.detail='brief'; localStorage.setItem('call-copilot.settings.v1',JSON.stringify(s)); return 1;})()`);
await app.send('Page.reload'); await sleep(3500);
const a2=await attach(main.webSocketDebuggerUrl);
await a2.ev(`(async()=>{const l=await window.desktop.screens.list(); const s=l.find(x=>x.kind==='screen');
  const st=JSON.parse(localStorage.getItem('call-copilot.settings.v1')||'{}');
  st.screenSourceId=s.id; st.screenSourceName=s.name; localStorage.setItem('call-copilot.settings.v1',JSON.stringify(st)); return 1;})()`);
await a2.send('Page.reload'); await sleep(3500);
const a3=await attach(main.webSocketDebuggerUrl);
await a3.ev(`document.getElementById('clearAnswers').click(); document.getElementById('readScreen').click();`);
let vis='';
for(let i=0;i<14;i++){ await sleep(3000);
  vis=await a3.ev(`document.querySelector('.answer-body')?.textContent?.trim()||''`);
  if(vis.length>40) break; }
pass('screen read produces an answer', vis.length>40, vis.slice(0,80));

console.log('\n=== 13. LOCAL MODEL ===');
await a3.ev(`(()=>{const s=JSON.parse(localStorage.getItem('call-copilot.settings.v1')||'{}');
  s.answerProvider='ollama'; s.models={...(s.models||{}), ollama:'llama3.2:3b'};
  localStorage.setItem('call-copilot.settings.v1',JSON.stringify(s)); return 1;})()`);
await a3.send('Page.reload'); await sleep(3500);
const a4=await attach(main.webSocketDebuggerUrl);
await a4.ev(`document.getElementById('clearAnswers').click();
  document.getElementById('replyInput').value='In one sentence, what is a mutex?';
  document.getElementById('replyForm').dispatchEvent(new Event('submit',{cancelable:true}));`);
let loc='';
for(let i=0;i<12;i++){ await sleep(3000);
  loc=await a4.ev(`document.querySelector('.answer-body')?.textContent?.trim()||''`);
  if(loc.length>30) break; }
pass('local model answers', loc.length>30, loc.slice(0,70));
process.exit(0);
