/* Final direct-eval value is the app lifetime; CivHomebrew waits before unload. */
(async function(){
 "use strict";
 var g=window,previous=g.__civswitchApp;if(previous&&previous.close)await previous.close();
 var finish,lifetime=new Promise(function(r){finish=r;}),closed=false,closing=false,frame=null,serviceTimer=null,client=null,store=null,state=null,screen="hosts",selected=0,controls=[],removers=[],subscription=null;
 var diagnostics=[],draft={address:"",target:1000100,account:"",pin:""},busy=false,menu=false,streaming=false,selectedHost=null,discovered={};
 function record(message){diagnostics.push({time:Date.now(),message:String(message).slice(0,512)});if(diagnostics.length>100)diagnostics.shift();}
 function listen(target,name,fn){target.addEventListener(name,fn,true);removers.push(function(){target.removeEventListener(name,fn,true);});}
 function node(tag,parent,style,text){var e=document.createElement(tag);Object.assign(e.style,style||{});if(text!==undefined)e.textContent=text;if(parent)parent.appendChild(e);return e;}
 var root=node("div",document.body,{position:"fixed",left:"0",right:"0",top:"0",bottom:"0",backgroundColor:"#0b111b",color:"#eff4fb",fontFamily:"Arial, sans-serif",zIndex:"2",display:"flex",flexDirection:"column",padding:"48px 64px",boxSizing:"border-box",outline:"none"});
 root.id="civchiaki";root.tabIndex=-1;
 var image=node("div",root,{position:"absolute",left:"0",top:"0",right:"0",bottom:"0",backgroundColor:"#000",backgroundSize:"contain",backgroundPosition:"center",backgroundRepeat:"no-repeat",display:"none"});
 var overlay=node("div",root,{position:"absolute",left:"16px",top:"16px",padding:"8px 12px",backgroundColor:"rgba(0,0,0,0.6)",color:"#d8f3ff",fontFamily:"monospace",fontSize:"16px",lineHeight:"21px",whiteSpace:"pre",borderRadius:"6px",display:"none",pointerEvents:"none"});
 var panel=node("div",root,{position:"relative",display:"flex",flexDirection:"column",flexGrow:"1"});
 var eyebrow=node("div",panel,{fontSize:"17px",letterSpacing:"3px",color:"#7abfff",marginBottom:"8px"},"REMOTE PLAY / CIVHOMEBREW");
 var title=node("div",panel,{fontSize:"48px",marginBottom:"16px"},"Chiaki");
 var status=node("div",panel,{fontSize:"21px",color:"#b8c9dd",minHeight:"32px",marginBottom:"20px"},"Loading saved consoles…");status.setAttribute("role","status");
 var content=node("div",panel,{display:"flex",flexDirection:"column",maxWidth:"900px",flexGrow:"1",overflowY:"auto"});
 var footer=node("div",panel,{fontSize:"17px",color:"#8fa3bc",marginTop:"20px"},"D-pad  Move     A  Select     B  Back");
 var keyboard=g.CivKeyboard.create({root:root,native:function(){return g.CivChiakiNative.available;},focus:function(){root.focus();},error:function(s){notice(s);}});
 function notice(text){status.textContent=text;record(text);}
 function paint(){controls.forEach(function(c,i){c.node.style.borderColor=i===selected?"#7abfff":"#2c3b50";c.node.style.backgroundColor=i===selected?"#203e60":"#121e2c";c.node.setAttribute("data-selected",i===selected?"true":"false");});}
 function clear(){while(content.firstChild)content.removeChild(content.firstChild);controls=[];selected=0;}
 function action(label,fn,adjust){
  var i=controls.length,e=node("button",content,{display:"flex",alignItems:"center",minHeight:"56px",marginBottom:"10px",padding:"12px 20px",border:"2px solid #2c3b50",borderRadius:"10px",color:"#eff4fb",backgroundColor:"#121e2c",fontFamily:"Arial, sans-serif",fontSize:"22px",textAlign:"left",outline:"none"},label);e.type="button";e.tabIndex=-1;
  function run(){if(closed||closing||busy||keyboard.active())return;selected=i;paint();Promise.resolve().then(fn).catch(function(error){notice(error.message);busy=false;});}
  controls.push({node:e,run:run,adjust:adjust?function(delta){if(closed||closing||busy||keyboard.active())return;Promise.resolve().then(function(){return adjust(delta);}).catch(function(error){notice(error.message);});}:null});e.addEventListener("click",run);return e;
 }
 function show(name){
  screen=name;clear();image.style.display=streaming?"flex":"none";
  panel.style.display=streaming&&!menu?"none":"flex";
  panel.style.backgroundColor=streaming?"rgba(11,17,27,0.94)":"transparent";
  if(name==="hosts"){
   title.textContent="Your consoles";status.textContent="PlayStation Remote Play · H.264";
   if(state&&state.hosts.length)state.hosts.forEach(function(host){action((host.target>=1000000?"PS5":"PS4")+"   "+(host.name||host.address)+"    "+host.address,function(){selectedHost=host;show("console");});});
   else node("div",content,{fontSize:"24px",color:"#94a9c2",marginBottom:"28px",padding:"30px 0"},"Add a console to start playing.");
   Object.keys(discovered).forEach(function(address){var h=discovered[address];if(state.hosts.some(function(saved){return saved.address===address;}))return;action("Found: "+h.name+"   "+address,function(){draft.address=address;draft.target=h.target;show("register");});});
   action("＋  Add console",function(){show("register");});action("Find consoles on network",async function(){await ensureClient();client.discover();busy=true;notice("Searching the local network… B cancels.");});action("Stream settings",function(){show("settings");});action("Close Chiaki",close);
  }else if(name==="console"){
   title.textContent=selectedHost.name||selectedHost.address;status.textContent=(selectedHost.target>=1000000?"PlayStation 5":"PlayStation 4")+" · "+selectedHost.address;
   action("Connect",connect);action("Wake console",async function(){await ensureClient();client.wakeup(selectedHost);notice("Wake request sent. Allow the console a few seconds, then connect.");});action("Remove from Chiaki",async function(){state=await store.removeHost(selectedHost.address);show("hosts");});action("Back",function(){show("hosts");});
  }else if(name==="register"){
   title.textContent="Add a console";status.textContent="On your PlayStation: Settings → Remote Play → Link / Add Device";
   field("Console address",draft.address,15,async function(v){draft.address=v;});
   action("Console: "+({1000100:"PS5",1000:"PS4 · 10+",900:"PS4 · 9",800:"PS4 · 8"})[draft.target],function(){var types=[1000100,1000,900,800];draft.target=types[(types.indexOf(draft.target)+1)%types.length];show("register");});
   field("PSN account ID (Base64)",draft.account,12,async function(v){draft.account=v;});field("Registration PIN",draft.pin?"••••••••":"",8,async function(v){draft.pin=v;},true);
   action("Register console",register);action("Back",function(){show("hosts");});
  }else if(name==="settings"){
   title.textContent="Stream settings";status.textContent="H.264 · SDR · stereo audio";
   var s=state.settings;
   function save(change){return async function(){state=await store.saveSettings(Object.assign({},state.settings,change(state.settings)));rerender();};}
   action("Resolution: "+["","360p","540p","720p","1080p"][s.resolution],save(function(v){return {resolution:v.resolution%4+1};}),function(d){return save(function(v){return {resolution:Math.max(1,Math.min(4,v.resolution+d))};})();});
   action("Frame rate: "+s.fps+" FPS",save(function(v){return {fps:v.fps===60?30:60};}),function(d){return save(function(){return {fps:d>0?60:30};})();});
   action("Bitrate: "+bitrateLabel(s),save(function(v){return {bitrate:g.CivChiakiStore.nextBitrate(v.bitrate)};}),function(d){return save(function(v){return {bitrate:g.CivChiakiStore.stepBitrate(v.bitrate,d)};})();});
   action("Debug overlay: "+(s.overlay?"On":"Off"),toggleOverlay);
   action("Back",function(){show("hosts");});
  }else if(name==="stream"){
   title.textContent=selectedHost.name||selectedHost.address;status.textContent=menu?"Stream paused for controls":"Connecting…";
   action("Resume",function(){menu=false;client.resume();show("stream");});
   action("PS button",function(){client.button(1<<15);menu=false;client.resume();show("stream");});
   action("Touchpad click",function(){client.button(1<<14);menu=false;client.resume();show("stream");});
   action("Debug overlay: "+(state.settings.overlay?"On":"Off"),toggleOverlay);
   action("Disconnect",disconnect);
   footer.textContent="− and + together  Open controls     B  Resume";
  }
  if(name!=="stream")footer.textContent=name==="settings"?"D-pad  Move     ◀ ▶  Change     A  Select     B  Back":"D-pad  Move     A  Select     B  Back";
  paint();
 }
 function bitrateLabel(s){var mbps=function(k){return (k/1000)+" Mbps";};return s.bitrate?mbps(s.bitrate):"Auto ("+mbps(g.CivChiakiStore.autoBitrate(s))+")";}
 // Re-render the current screen without moving the highlight.
 function rerender(){var keep=selected;show(screen);selected=Math.min(keep,Math.max(0,controls.length-1));paint();}
 async function toggleOverlay(){state=await store.saveSettings(Object.assign({},state.settings,{overlay:!state.settings.overlay}));overlayPrevious=null;rerender();}
 // Debug overlay: rates are computed from client counters between samples.
 var overlayPrevious=null,overlayNext=0,workMs=0;
 function updateOverlay(now){
  var visible=streaming&&!menu&&!!state&&!!state.settings.overlay&&!!client;
  overlay.style.display=visible?"block":"none";if(!visible){overlayPrevious=null;return;}
  if(now<overlayNext)return;overlayNext=now+500;
  // io.stats is one live object: snapshot the counters used for rates.
  var st=client.state(),live=st.network||{},n={receivedBytes:live.receivedBytes,receiveCalls:live.receiveCalls,batchReceiveCalls:live.batchReceiveCalls,fullBatches:live.fullBatches||0},m=st.media||{},w=st.worker||{},sample={time:now,work:workMs,n:n,m:m,w:w,recovery:st.recovery||[0,0],signals:st.congestionSignals||0},p=overlayPrevious;overlayPrevious=sample;
  var profile=st.profile||state.settings,lines=[["","360p","540p","720p","1080p"][profile.resolution]+profile.fps+" · requested "+(profile.bitrate/1000)+" Mbps"+(profile.autoBitrate?" (auto)":"")];
  if(!p){overlay.textContent=lines[0]+"\nmeasuring…";return;}
  var dt=Math.max(1,sample.time-p.time)/1000,d=function(a,b,k){return (a[k]||0)-(b[k]||0);},per=function(a,b,k,c){var x=d(a,b,c);return x>0?d(a,b,k)/x:0;};
  var batches=d(n,p.n,"batchReceiveCalls"),full=d(n,p.n,"fullBatches");
  lines.push("received  "+(d(n,p.n,"receivedBytes")*8/dt/1e6).toFixed(1)+" Mbps   "+Math.round(d(n,p.n,"receiveCalls")/dt)+" pkt/s");
  lines.push("video     "+(d(m,p.m,"presented")/dt).toFixed(0)+" fps   decode "+per(m,p.m,"decodeMs","decodeSamples").toFixed(1)+" ms   to screen "+per(m,p.m,"presentAgeMs","presentAgeSamples").toFixed(0)+" ms");
  lines.push("queue     "+(batches?Math.round(full*100/batches):0)+"% full batches   congestion signals +"+(sample.signals-p.signals));
  lines.push("FEC       "+d(w,p.w,"jobs")+" jobs   "+(sample.recovery[0]-p.recovery[0])+" skipped   worst gap "+Math.round(m.maxIntervalMs||0)+" ms");
  lines.push("audio     "+Math.round(d(m,p.m,"audioEmptyMs")*100/(dt*1000))+"% empty   "+d(m,p.m,"audioConcealed")+" concealed   "+d(m,p.m,"audioDropped")+" dropped");
  lines.push("Chiaki    "+Math.round((sample.work-p.work)*100/(dt*1000))+"% of UI thread");
  overlay.textContent=lines.join("\n");
 }
 function field(label,value,max,set,password){action(label+": "+(value||"Enter…"),async function(){var text=await keyboard.edit("",max,!!password,label);if(text!==null){await set(text);show("register");}});}
 async function ensureClient(){
  if(client)return client;if(!g.CivChiakiNative.available)throw Error("This is a browser preview. Launch the .civapp from CivHomebrew to use Remote Play.");
  notice("Preparing Remote Play…");client=await g.CivChiakiClient.create({onImage:function(url){image.style.backgroundImage=url?'url("'+url+'")':"";}});return client;
 }
 async function register(){
  if(!g.CivChiakiStore.ipv4(draft.address))throw Error("Enter the console’s IPv4 address.");g.CivChiakiClient.account(draft.account);if(! /^\d{8}$/.test(draft.pin))throw Error("Enter the eight-digit registration PIN shown on your console.");
  busy=true;try{await ensureClient();client.register(draft.address,draft.target,draft.account,draft.pin);notice("Registering with your PlayStation… B cancels.");}catch(e){busy=false;throw e;}
 }
 async function connect(){
  busy=true;try{await ensureClient();client.connect(selectedHost,state.settings);streaming=true;menu=false;show("stream");}finally{busy=false;}
 }
 async function disconnect(){busy=true;notice("Disconnecting…");try{await client.stop();streaming=false;menu=false;image.style.backgroundImage="";show("hosts");}finally{busy=false;}}
 async function process(event){
  if(event.type==="log"){record(event.data.text);return;}
  if(event.type==="discovered"){discovered[event.data.address]=event.data;return;}
  if(event.type==="registered"){
   try{state=await store.saveHost(event.data);draft.pin="";draft.account="";show("hosts");notice("Console registered.");}catch(error){notice("Registration succeeded, but saving failed: "+error.message);}finally{busy=false;}return;
  }
  if(event.type==="menu"){menu=event.data;show("stream");return;}
  if(event.type==="error"){notice(event.data);if(streaming){menu=true;show("stream");notice(event.data);}return;}
  if(event.type==="status"||event.type==="warning"){notice(event.data);return;}
  if(event.type!=="native")return;
  var e=event.data;
  if(e.type===101&&busy&&screen==="hosts"){busy=false;show("hosts");notice(Object.keys(discovered).length?"Network search complete.":"No consoles found. You can add one by address.");return;}
  if(e.type===0){notice("Connected");return;}
  if(e.type===8){client.rumble(e.a,e.b);return;}
  if(e.type===1){client.pause();menu=true;show("stream");var pin=await keyboard.edit("",4,true,e.a?"login PIN (previous PIN incorrect)":"console login PIN");if(pin!==null){try{client.loginPin(pin);menu=false;client.resume();show("stream");}catch(error){notice(error.message);}}return;}
  if(e.type===9){await client.stop();streaming=false;menu=false;busy=false;show("hosts");notice(e.a===1?"Disconnected":"Remote Play ended (reason "+e.a+")"+(e.text?": "+e.text:""));return;}
  if(e.type===100){busy=false;notice(e.a===0?"Registration canceled.":"Registration failed. Check the account ID, PIN, console address, and Remote Play settings.");}
 }
 var eventChain=Promise.resolve();
 async function close(){
  if(closed)return lifetime;if(closing)return;
  closing=true;keyboard.cancel();notice("Closing Chiaki…");
  try{if(client)await client.close();await eventChain;}catch(error){closing=false;notice(error.message);return;}
  closed=true;if(frame!==null)cancelAnimationFrame(frame);if(serviceTimer!==null)clearTimeout(serviceTimer);removers.forEach(function(fn){fn();});
  if(subscription&&subscription.clear)subscription.clear();else if(g.engine&&g.engine.off)g.engine.off("InputAction",nativeAction,owner);
  root.remove();if(g.__civswitchApp===instance)delete g.__civswitchApp;finish();return lifetime;
 }
 function back(){
  if(keyboard.active()){keyboard.cancel();return;}
  if(busy){if(client)client.stop().catch(function(e){notice(e.message);});return;}
  if(streaming){menu=false;client.resume();show("stream");return;}
  if(screen==="hosts")close();else show("hosts");
 }
 var lastAction="",nextRepeat=0,owner={owner:"civchiaki"};
 function navigate(name,phase){
  if(closed||closing||keyboard.active())return;if(name==="keyboard-escape")name="cancel";
  if(phase!==0&&phase!==3){lastAction="";return;}
  if(streaming&&!menu)return;
  if(name==="cancel"){if(phase===0)back();return;}if(busy)return;
  if(name==="accept"){if(phase===0&&controls[selected])controls[selected].run();return;}
  if(name==="nav-left"||name==="nav-right"){if(phase===0&&controls[selected]&&controls[selected].adjust)controls[selected].adjust(name==="nav-right"?1:-1);return;}
  var delta=name==="nav-up"?-1:name==="nav-down"?1:0;if(!delta||!controls.length)return;
  var now=Date.now();if(phase===3&&(lastAction!==name||now<nextRepeat))return;
  lastAction=name;nextRepeat=now+(phase===0?350:140);selected=(selected+delta+controls.length)%controls.length;paint();
 }
 function nativeAction(name,phase,x,y){if(name==="nav-move"){x=Number(x);y=Number(y);if(Math.abs(x)>=0.5&&Math.abs(x)>Math.abs(y))name=x>0?"nav-right":"nav-left";else if(Math.abs(y)>=0.5)name=y>0?"nav-up":"nav-down";else return;}navigate(name,Number(phase));}
 listen(g,"keydown",function(e){if(keyboard.active())return;var name={ArrowUp:"nav-up",ArrowDown:"nav-down",ArrowLeft:"nav-left",ArrowRight:"nav-right",Enter:"accept",Escape:"cancel"}[e.key];if(e.key==="F8"){close();e.preventDefault();e.stopImmediatePropagation();}else if(e.key==="Escape"&&streaming&&!menu){client.pause();menu=true;show("stream");e.preventDefault();e.stopImmediatePropagation();}else if(name){navigate(name,e.repeat?3:0);e.preventDefault();e.stopImmediatePropagation();}});
 listen(g,"blur",function(){if(client)client.pause();if(streaming){menu=true;show("stream");}});
 function gameEvent(e){var d=e.detail||{};if(["nav-move","nav-up","nav-down","nav-left","nav-right","accept","cancel","keyboard-escape"].indexOf(d.name)<0)return;if(!g.engine)nativeAction(d.name,d.status,d.x,d.y);e.preventDefault();e.stopImmediatePropagation();}
 listen(g,"navigate-input",gameEvent);listen(g,"engine-input",gameEvent);
 if(g.engine&&g.engine.on)subscription=g.engine.on("InputAction",nativeAction,owner);
 var instance={id:"civchiaki",close:close,lifetime:lifetime,diagnostics:diagnostics,status:function(){return {screen:screen,busy:busy,streaming:streaming,client:client?client.state():null};}};g.__civswitchApp=instance;
 try{
  var io=g.CivChiakiNative.available?g.CivChiakiNative.storage():g.CivChiakiStore.browserIO(g.localStorage);
  store=g.CivChiakiStore.create(io);state=await store.load();show("hosts");
 }catch(error){clear();notice(error.message);action("Close Chiaki",close);paint();}
 function tick(){
  if(closed)return;
  var start=g.performance&&g.performance.now?g.performance.now():Date.now();
  if(client&&!closing){client.tick();client.events().forEach(function(e){eventChain=eventChain.then(function(){if(!closed)return process(e);}).catch(function(error){notice(error.message);});});}
  if(serviceTimer===null&&client&&!closing)serviceTimer=setTimeout(function(){serviceTimer=null;if(closed||closing)return;var begin=g.performance&&g.performance.now?g.performance.now():Date.now();client.service();workMs+=(g.performance&&g.performance.now?g.performance.now():Date.now())-begin;},4);
  var end=g.performance&&g.performance.now?g.performance.now():Date.now();workMs+=end-start;
  try{updateOverlay(end);}catch(error){overlay.textContent="overlay: "+error.message;}
  frame=requestAnimationFrame(tick);
 }
 root.focus();frame=requestAnimationFrame(tick);
 if(typeof log==="function")await log("CIVCHIAKI_READY");
 await lifetime;
})();
