import { WebSocket } from 'ws';
import fs from 'node:fs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const targets=async()=>(await(await fetch('http://127.0.0.1:9333/json')).json()).filter(x=>x.type==='page');
function attach(u){const ws=new WebSocket(u);let id=0;
  const a={ws,send:(m,p)=>new Promise(r=>{const i=++id;const h=x=>{const d=JSON.parse(x.toString());if(d.id===i){ws.off('message',h);r(d);}};ws.on('message',h);ws.send(JSON.stringify({id:i,method:m,params:p}));})};
  a.ev=async e=>(await a.send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true,userGesture:true})).result?.result?.value;
  return new Promise((res,rej)=>{ws.on('open',()=>res(a));ws.on('error',rej);});}
const t=(await targets()).find(x=>!x.url.includes('overlay'));
const app=await attach(t.webSocketDebuggerUrl);

console.log('1. naming the interview...');
await app.ev(`(()=>{const f=document.getElementById('sessionName');
  f.value='Acme Payments — Round 1'; f.dispatchEvent(new Event('input')); return f.value;})()`);

console.log('2. asking a question (as if the interviewer had)...');
await app.ev(`document.getElementById('clearAnswers').click();
  document.getElementById('replyInput').value='How would you design a rate limiter for a payments API?';
  document.getElementById('replyForm').dispatchEvent(new Event('submit',{cancelable:true}));`);
let ans='';
for(let i=0;i<14;i++){ await sleep(3000); ans=await app.ev(`document.querySelector('.answer-body')?.textContent?.trim()||''`); if(ans.length>40) break; }
console.log('   answered:', ans.slice(0,60)+'...');

console.log('3. pressing Start then Stop (Stop is what saves)...');
await app.ev(`document.getElementById('startStop').click();`); await sleep(5000);
await app.ev(`document.getElementById('startStop').click();`); await sleep(4000);

const saved=(await (await fetch('http://127.0.0.1:5178/api/sessions')).json()).sessions;
console.log('4. saved interviews now:', saved.map(s=>`"${s.name}" (${s.questions} answers)`).join(', ') || 'NONE');

await app.ev(`document.getElementById('sessionName').value=''; document.getElementById('sessionName').dispatchEvent(new Event('input'));`);
await sleep(1500);
const r=await app.send('Page.captureScreenshot',{format:'png'});
fs.writeFileSync('/tmp/demo.png', Buffer.from(r.result.data,'base64'));
process.exit(0);
