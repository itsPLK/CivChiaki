/* Launch the exact packaged, ordered direct-eval bundle in real Chrome. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{spawn}=require('node:child_process');
const chromeCleanup=require('./helpers/chrome-cleanup.cjs');const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const pkg=JSON.parse(fs.readFileSync('dist/chiaki.civapp','utf8')),manifest=JSON.parse(fs.readFileSync('payload.json','utf8'));
 assert.equal(pkg.format,'civswitch-app');assert.equal(pkg.version,1);assert.deepEqual(pkg.scripts.map(s=>s.name),manifest.scripts);assert.equal(pkg.scripts.at(-1).name,'app/src/ui.js');
 for(const script of pkg.scripts)assert.equal(script.source,fs.readFileSync(script.name,'utf8'));
 const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><html><body></body></html>');});await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'civchiaki-chrome-'));
 const chrome=spawn(process.env.CHROME_BIN||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless','--disable-gpu','--disable-extensions','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'http://127.0.0.1:'+server.address().port],{stdio:['ignore','ignore','pipe']});
 const cleanup=chromeCleanup(chrome);let socket,stderr='',spawnError;chrome.on('error',e=>spawnError=e);chrome.stderr.on('data',b=>stderr=(stderr+b).slice(-2000));
 try{
  let port;for(let i=0;i<200;i++){if(spawnError)throw spawnError;try{port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);break;}catch(_){}if(chrome.exitCode!==null)throw Error(stderr);await pause(50);}assert.ok(port,'Chrome did not start');
  const tabs=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();socket=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true});});
  const pending=new Map();let id=0;socket.addEventListener('message',e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}});
  function call(method,params={}){return new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>{pending.delete(n);reject(Error('CDP timeout: '+method));},15000);pending.set(n,{resolve,reject,timer});socket.send(JSON.stringify({id:n,method,params}));});}
  async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:720,deviceScaleFactor:1,mobile:false});
  await evaluate(`window.__pkg=${JSON.stringify(pkg)};true`);
  const result=await evaluate(`(async()=>{
   var listeners=0,oldAdd=window.addEventListener.bind(window),oldRemove=window.removeEventListener.bind(window);
   window.addEventListener=function(){listeners++;return oldAdd(...arguments);};window.removeEventListener=function(){listeners--;return oldRemove(...arguments);};window.__listenerCount=()=>listeners;
   window.__done=false;
   // eval inside a function models the loader's lexical scope rather than
   // browser script tags which make var declarations global automatically.
   window.__lifetime=(function(){return eval(__pkg.scripts.map(s=>s.source).join('\\n;\\n'));})();
   __lifetime.then(()=>window.__done=true);await new Promise(r=>setTimeout(r,80));
   return {factory:typeof window.ChiakiCore,pending:!__done,title:document.querySelector('#civchiaki').textContent,buttons:document.querySelectorAll('#civchiaki button').length};
  })()`);
  assert.equal(result.factory,'function');assert.equal(result.pending,true);assert.match(result.title,/Your consoles/);assert.equal(result.buttons,4);
  const screenshot=await call('Page.captureScreenshot',{format:'png'});fs.mkdirSync('dist/qa',{recursive:true});fs.writeFileSync('dist/qa/hosts.png',Buffer.from(screenshot.data,'base64'));
  assert.equal(await evaluate(`(async()=>{document.querySelector('#civchiaki button').click();await new Promise(r=>setTimeout(r,20));return document.querySelector('#civchiaki').textContent.includes('Add a console');})()`),true);
  assert.equal(await evaluate(`(async()=>{dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await new Promise(r=>setTimeout(r,20));return document.querySelector('#civchiaki').textContent.includes('Your consoles');})()`),true);
  assert.equal(await evaluate(`(async()=>{await __civswitchApp.close();await __lifetime;return __done&&!document.getElementById('civchiaki')&&!window.__civswitchApp&&__listenerCount()===0;})()`),true);
  const nativeStart=await evaluate(`(async()=>{
   var calls=0;CivChiakiNative.available=true;CivChiakiNative.storage=function(){calls++;return CivChiakiStore.browserIO(localStorage);};
   window.PayloadNative={create:function(){throw Error('Launcher storage adapter must not be used for app data');}};
   window.__second=eval(__pkg.scripts[__pkg.scripts.length-1].source);await new Promise(r=>setTimeout(r,40));
   var result={calls:calls,hosts:document.querySelector('#civchiaki').textContent.includes('Your consoles')};await __civswitchApp.close();await __second;return result;
  })()`);
  assert.equal(nativeStart.calls,1);assert.equal(nativeStart.hosts,true);
  console.log('Package/Chrome smoke passed: exact sources, factory publication, UI, navigation, pending lifetime and clean close.');
 }finally{await cleanup(socket,profile);await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
