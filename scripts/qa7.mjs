import { WebSocket } from 'ws';
import fs from 'node:fs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const targets=async()=>(await(await fetch('http://127.0.0.1:9333/json')).json()).filter(x=>x.type==='page');
function attach(u){const ws=new WebSocket(u);let id=0;
  const a={ws,send:(m,p)=>new Promise(r=>{const i=++id;const h=x=>{const d=JSON.parse(x.toString());if(d.id===i){ws.off('message',h);r(d);}};ws.on('message',h);ws.send(JSON.stringify({id:i,method:m,params:p}));})};
  a.ev=async e=>(await a.send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true,userGesture:true})).result?.result?.value;
  return new Promise((res,rej)=>{ws.on('open',()=>res(a));ws.on('error',rej);});}
const main=(await targets()).find(x=>!x.url.includes('overlay')&&!x.url.includes('region'));
const app=await attach(main.webSocketDebuggerUrl);
const srcs=JSON.parse(await app.ev(`(async()=>JSON.stringify((await window.desktop.screens.list()).map(s=>({id:s.id,kind:s.kind,name:s.name}))))()`));
const scr=srcs.find(s=>s.kind==='screen');
// dump the actual captured image so we can SEE what the model was given
const shot=await app.ev(`(async()=>{const r=await window.desktop.screens.capture(${JSON.stringify(scr.id)},${JSON.stringify(scr.name)});
  return r.ok ? r.dataUrl : 'ERR';})()`);
if(shot==='ERR'){ console.log('capture failed'); process.exit(1); }
fs.writeFileSync('/tmp/captured.jpg', Buffer.from(shot.split(',')[1],'base64'));
console.log('  captured image saved:', Math.round(fs.statSync('/tmp/captured.jpg').size/1024)+'KB');
process.exit(0);
