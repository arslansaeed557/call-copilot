import { WebSocket } from 'ws';
import fs from 'node:fs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const t=(await(await fetch('http://127.0.0.1:9333/json')).json()).find(x=>x.type==='page'&&!x.url.includes('overlay'));
const ws=new WebSocket(t.webSocketDebuggerUrl); let id=0;
const send=(m,p)=>new Promise(r=>{const i=++id;const h=x=>{const d=JSON.parse(x.toString());if(d.id===i){ws.off('message',h);r(d);}};ws.on('message',h);ws.send(JSON.stringify({id:i,method:m,params:p}));});
ws.on('open', async () => {
  await send('Page.reload'); await sleep(4500);
  const r=await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync('/tmp/del.png', Buffer.from(r.result.data,'base64'));
  console.log('shot'); ws.close(); process.exit(0);
});
setTimeout(()=>process.exit(1),40000);
