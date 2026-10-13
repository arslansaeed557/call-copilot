import { WebSocket } from 'ws';
const t=(await(await fetch('http://127.0.0.1:9333/json')).json()).find(x=>x.type==='page'&&!x.url.includes('overlay'));
const ws=new WebSocket(t.webSocketDebuggerUrl); let id=0;
const send=(m,p)=>new Promise(r=>{const i=++id;const h=x=>{const d=JSON.parse(x.toString());if(d.id===i){ws.off('message',h);r(d);}};ws.on('message',h);ws.send(JSON.stringify({id:i,method:m,params:p}));});
ws.on('open', async () => {
  const r=await send('Runtime.evaluate',{expression:`(()=>{
    const row=document.querySelector('.idle-row');
    const acts=row?.querySelector('.idle-actions');
    const btns=[...(acts?.querySelectorAll('button')||[])];
    const pane=document.getElementById('transcript');
    return JSON.stringify({
      paneWidth: Math.round(pane.clientWidth),
      rowWidth: Math.round(row?.getBoundingClientRect().width||0),
      buttons: btns.map(b=>({t:b.textContent, w:Math.round(b.getBoundingClientRect().width), right:Math.round(b.getBoundingClientRect().right)})),
      rowRight: Math.round(row?.getBoundingClientRect().right||0),
      paneRight: Math.round(pane.getBoundingClientRect().right)
    },null,1);})()`,returnByValue:true});
  console.log(r.result.result.value); ws.close(); process.exit(0);
});
setTimeout(()=>process.exit(1),20000);
