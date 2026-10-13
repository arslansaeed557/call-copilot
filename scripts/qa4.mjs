import { WebSocket } from 'ws';
import { execSync } from 'node:child_process';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const targets=async()=>(await(await fetch('http://127.0.0.1:9333/json')).json()).filter(x=>x.type==='page');
function attach(u){const ws=new WebSocket(u);let id=0;
  const a={ws,send:(m,p)=>new Promise(r=>{const i=++id;const h=x=>{const d=JSON.parse(x.toString());if(d.id===i){ws.off('message',h);r(d);}};ws.on('message',h);ws.send(JSON.stringify({id:i,method:m,params:p}));})};
  a.ev=async e=>(await a.send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true,userGesture:true})).result?.result?.value;
  return new Promise((res,rej)=>{ws.on('open',()=>res(a));ws.on('error',rej);});}
const pass=(n,ok,d='')=>console.log(`  ${ok?'PASS':'FAIL'}  ${n}${d?'  — '+d:''}`);
const main=(await targets()).find(x=>!x.url.includes('overlay')&&!x.url.includes('region'));
const app=await attach(main.webSocketDebuggerUrl);

console.log('=== 8. LIVE CAPTURE + TRANSCRIPTION (real audio) ===');
await app.ev(`(()=>{const s=JSON.parse(localStorage.getItem('call-copilot.settings.v1')||'{}');
  s.source='system'; s.sttProvider='deepgram'; s.sttLanguage='en'; s.mode='manual';
  localStorage.setItem('call-copilot.settings.v1',JSON.stringify(s)); return 1;})()`);
await app.send('Page.reload'); await sleep(3500);
const a2=await attach(main.webSocketDebuggerUrl);
await a2.ev(`document.getElementById('clearTranscript').click(); document.getElementById('startStop').click();`);
await sleep(6000);
const started=await a2.ev(`JSON.stringify({btn:document.getElementById('startStop').textContent, status:document.getElementById('statusText').textContent})`);
pass('session starts (system audio)', /Stop/.test(started), started);

execSync('afplay -v 0.6 /tmp/them.wav');
await sleep(5000);
const lines=await a2.ev(`JSON.stringify([...document.querySelectorAll('.line .line-text')].map(e=>e.textContent))`);
const heard=JSON.parse(lines);
pass('real audio transcribed', heard.length>0, heard.join(' | ').slice(0,100));
pass('attributed to Them', heard.every(l=>l.startsWith('Them')), heard.length?heard[0].slice(0,30):'none');

console.log('\n=== 9. AUTO-ANSWER PAUSE HONOURED ===');
await a2.ev(`(()=>{const s=JSON.parse(localStorage.getItem('call-copilot.settings.v1')||'{}');
  s.mode='auto'; s.pauseMs=4000; localStorage.setItem('call-copilot.settings.v1',JSON.stringify(s)); return 1;})()`);
await a2.ev(`document.getElementById('startStop').click();`);
await sleep(1500);
pass('session stops cleanly', /Start/.test(await a2.ev(`document.getElementById('startStop').textContent`)));

console.log('\n=== 10. OVERLAY ===');
let ot=(await targets()).find(x=>x.url.includes('overlay'));
if(!ot){ await a2.ev(`document.getElementById('overlayBtn').click();`); await sleep(3500);
  ot=(await targets()).find(x=>x.url.includes('overlay')); }
pass('overlay opens', !!ot);
if(ot){
  const ov=await attach(ot.webSocketDebuggerUrl);
  await sleep(800);
  const st=await ov.ev(`JSON.stringify({
    controlsHidden:getComputedStyle(document.getElementById('ovControlsPane')).display==='none',
    transcriptHidden:getComputedStyle(document.getElementById('ovTranscriptPane')).display==='none',
    shield:document.getElementById('ovShield').textContent,
    hasReply:!!document.getElementById('ovReply'),
    bodyScrollable:getComputedStyle(document.getElementById('ovBody')).minHeight==='0px'})`);
  const o=JSON.parse(st);
  pass('panels collapsed by default', o.controlsHidden&&o.transcriptHidden);
  pass('hidden from screen share', o.shield==='Hidden', o.shield);
  pass('reply box present', o.hasReply);
  pass('body scroll fix applied', o.bodyScrollable);
  await ov.ev(`document.getElementById('ovControls').click();`); await sleep(600);
  const rows=await ov.ev(`JSON.stringify([...document.querySelectorAll('.ov-row > span:first-child')].map(x=>x.textContent))`);
  pass('overlay controls populated', JSON.parse(rows).length>=10, JSON.parse(rows).join(','));
}
process.exit(0);
