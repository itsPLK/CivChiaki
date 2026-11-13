/* Final direct-eval value is the app lifetime; CivHomebrew waits before unload. */
(async function(){
 "use strict";
 var g=window,previous=g.__civswitchApp;if(previous&&previous.close)await previous.close();
 var finish,lifetime=new Promise(function(r){finish=r;}),closed=false,closing=false,frame=null,serviceTimer=null,client=null,store=null,state=null,screen="hosts",selected=0,controls=[],removers=[],subscription=null;
 // Keep in sync with "release" in payload.json (checked by tests/package-smoke.cjs).
 var VERSION="0.2.0";
 // Palette from the Chiaki icon: lime/pale-yellow over deep teal.
 var C={bg:"#0d1714",text:"#f1f5e4",muted:"#a9bba3",dim:"#7d9078",accent:"#b5d33d",soft:"#eef07c",button:"#14211d",border:"#2a3b33",selected:"#27391c",card:"rgba(13,23,20,0.95)",overlay:"rgba(8,14,12,0.72)",danger:"#e2705c",dangerBg:"#3b1f19"};
 var diagnostics=[],draft={address:"",target:1000100,account:"",pin:""},busy=false,menu=false,streaming=false,selectedHost=null,discovered={};
 function record(message){diagnostics.push({time:Date.now(),message:String(message).slice(0,512)});if(diagnostics.length>100)diagnostics.shift();}
 function listen(target,name,fn){target.addEventListener(name,fn,true);removers.push(function(){target.removeEventListener(name,fn,true);});}
 function node(tag,parent,style,text){var e=document.createElement(tag);Object.assign(e.style,style||{});if(text!==undefined)e.textContent=text;if(parent)parent.appendChild(e);return e;}
 var root=node("div",document.body,{position:"fixed",left:"0",right:"0",top:"0",bottom:"0",backgroundColor:C.bg,color:C.text,fontFamily:"Arial, sans-serif",zIndex:"2",display:"flex",flexDirection:"column",padding:"48px 64px",boxSizing:"border-box",outline:"none"});
 root.id="civchiaki";root.tabIndex=-1;
 var image=node("div",root,{position:"absolute",left:"0",top:"0",right:"0",bottom:"0",backgroundColor:"#000",backgroundSize:"contain",backgroundPosition:"center",backgroundRepeat:"no-repeat",display:"none"});
 var overlay=node("div",root,{position:"absolute",left:"16px",top:"16px",padding:"8px 12px",backgroundColor:C.overlay,color:C.soft,fontFamily:"monospace",fontSize:"16px",lineHeight:"21px",whiteSpace:"pre",borderRadius:"6px",display:"none",pointerEvents:"none"});
 var panel=node("div",root,{position:"relative",display:"flex",flexDirection:"column",flexGrow:"1"});
 var eyebrow=node("div",panel,{fontSize:"17px",letterSpacing:"3px",color:C.accent,marginBottom:"8px"},"CIVCHIAKI v"+VERSION);
 var title=node("div",panel,{fontSize:"48px",marginBottom:"16px"},"Chiaki");
 var status=node("div",panel,{fontSize:"21px",color:C.muted,minHeight:"32px",marginBottom:"20px"},"Loading saved consoles…");status.setAttribute("role","status");
 var content=node("div",panel,{display:"flex",flexDirection:"column",maxWidth:"900px",flexGrow:"1",minHeight:"0",overflowY:"auto"}),into=content,split=-1;
 var footer=node("div",panel,{fontSize:"17px",color:C.dim,marginTop:"20px",whiteSpace:"pre"},"D-pad  Move     A  Select     B  Back");
 var keyboard=g.CivKeyboard.create({root:root,native:function(){return g.CivChiakiNative.available;},focus:function(){root.focus();},error:function(s){notice(s);}});
 function notice(text){status.textContent=text;record(text);}
 function paint(){controls.forEach(function(c,i){var on=i===selected;c.node.style.borderColor=on?C.accent:C.border;c.node.style.backgroundColor=on?C.selected:C.button;if(c.paint)c.paint(on);c.node.setAttribute("data-selected",i===selected?"true":"false");});var n=controls[selected]&&controls[selected].node;if(n){var top=n.offsetTop-content.offsetTop;if(top<content.scrollTop)content.scrollTop=top;else if(top+n.offsetHeight>content.scrollTop+content.clientHeight)content.scrollTop=top+n.offsetHeight-content.clientHeight;}}
 function clear(){while(content.firstChild)content.removeChild(content.firstChild);controls=[];selected=0;into=content;split=-1;content.style.maxWidth="900px";content.style.flexDirection="column";}
 function action(label,fn,adjust){
  var i=controls.length,e=node("button",into,{display:"flex",alignItems:"center",flexShrink:"0",minHeight:"56px",marginBottom:"10px",padding:"12px 20px",border:"2px solid "+C.border,borderRadius:"10px",color:C.text,backgroundColor:C.button,fontFamily:"Arial, sans-serif",fontSize:"22px",textAlign:"left",outline:"none"},label);e.type="button";e.tabIndex=-1;
  // One action at a time: presses during a slow action (first client start) are ignored, and the
  // pressed button dims so the press visibly registered.
  function run(){if(closed||closing||busy||running||keyboard.active())return;selected=i;paint();running=true;e.style.opacity="0.6";Promise.resolve().then(fn).catch(function(error){notice(error.message);busy=false;}).then(function(){running=false;e.style.opacity="1";});}
  controls.push({node:e,paint:null,run:run,adjust:adjust?function(delta){if(closed||closing||busy||keyboard.active())return;Promise.resolve().then(function(){return adjust(delta);}).catch(function(error){notice(error.message);});}:null});e.addEventListener("click",run);return e;
 }
 function section(label){node("div",into,{fontSize:"15px",letterSpacing:"3px",color:C.dim,margin:"18px 0 10px",flexShrink:"0"},label.toUpperCase());}
 function compact(e){Object.assign(e.style,{minHeight:"46px",padding:"8px 20px",fontSize:"20px",marginBottom:"8px"});return e;}
 // Console card: platform badge, then name over address/status.
 function consoleCard(target,name,detail,fn,found){
  var e=action("",fn);Object.assign(e.style,{minHeight:"84px",padding:"12px 20px"});
  var badge=node("span",e,{display:"flex",justifyContent:"center",alignItems:"center",width:"68px",height:"44px",flexShrink:"0",marginRight:"20px",borderRadius:"8px",fontSize:"21px",color:found?C.accent:C.bg,backgroundColor:found?"transparent":C.accent,border:"2px solid "+C.accent},target>=1000000?"PS5":"PS4");
  var text=node("span",e,{display:"flex",flexDirection:"column",flexGrow:"1"});node("span",text,{fontSize:"24px",marginBottom:"4px"},name);node("span",text,{fontSize:"17px",color:C.muted},detail);
  return e;
 }
 // Text field row: label on the left, an input-like box on the right.
 function field(label,value,max,set,password){
  var e=action("",async function(){var text=await keyboard.edit("",max,!!password,label);if(text!==null){await set(text);rerender();}});
  node("span",e,{flexGrow:"1"},label);
  var box=node("span",e,{width:"340px",padding:"6px 14px",backgroundColor:C.bg,border:"2px solid "+C.border,borderRadius:"6px",color:value?C.text:C.dim,overflow:"hidden",whiteSpace:"nowrap"},value||"Press A to enter");
  controls[controls.length-1].paint=function(on){box.style.borderColor=on?C.accent:C.border;};
  return e;
 }
 // Picker row: "Label        ◀ value ▶". Left/right step without wrapping; A cycles.
 // Arrows are CSS triangles because the game font lacks geometric-shape glyphs.
 function choice(label,options,current,set){
  var i=Math.max(0,options.findIndex(function(o){return o[0]===current;}));
  var e=action("",function(){return set(options[(i+1)%options.length][0]);},function(d){var j=Math.max(0,Math.min(options.length-1,i+d));if(j!==i)return set(options[j][0]);});
  node("span",e,{flexGrow:"1"},label);
  function arrow(left){return node("span",e,{width:"0",height:"0",borderTop:"9px solid transparent",borderBottom:"9px solid transparent",borderLeft:left?"0":"12px solid "+C.dim,borderRight:left?"12px solid "+C.dim:"0"});}
  var prev=arrow(true),value=node("span",e,{display:"flex",justifyContent:"center",width:"220px",flexShrink:"0",color:C.soft,padding:"0 12px"},options[i][1]),next=arrow(false);
  controls[controls.length-1].paint=function(on){prev.style.opacity=i>0?"1":"0.25";next.style.opacity=i<options.length-1?"1":"0.25";var c=on?C.accent:C.dim;prev.style.borderRightColor=c;next.style.borderLeftColor=c;};
  return e;
 }
 function show(name){
  screen=name;clear();image.style.display=streaming?"flex":"none";
  panel.style.display=streaming&&!menu?"none":"flex";
  // While streaming, the controls menu floats as a padded card over the video.
  Object.assign(panel.style,streaming?{backgroundColor:C.card,padding:"32px 40px",borderRadius:"16px",border:"1px solid "+C.border,width:"680px",maxWidth:"100%",margin:"auto",flexGrow:"0",boxSizing:"border-box"}:{backgroundColor:"transparent",padding:"0",borderRadius:"0",border:"none",width:"auto",maxWidth:"none",margin:"0",flexGrow:"1"});
  if(name==="hosts"){
   title.textContent="Your consoles";status.textContent="PlayStation Remote Play · H.264";
   // Two columns: consoles on the left, menu on the right; ← → jump between them.
   content.style.maxWidth="1152px";content.style.flexDirection="row";
   into=node("div",content,{display:"flex",flexDirection:"column",flexGrow:"1",minWidth:"0",marginRight:"32px"});
   section("Consoles");
   var found=Object.keys(discovered).filter(function(address){return !state.hosts.some(function(saved){return saved.address===address;});});
   state.hosts.forEach(function(host){consoleCard(host.target,host.name||host.address,host.address+"  ·  Ready to connect",function(){selectedHost=host;show("console");});});
   found.forEach(function(address){var h=discovered[address];consoleCard(h.target,h.name||address,address+"  ·  Found on network, press A to register",function(){draft.address=address;draft.target=h.target;show("register");},true);});
   if(!state.hosts.length&&!found.length)node("div",into,{fontSize:"21px",color:C.muted,marginBottom:"10px",padding:"24px 20px",border:"2px dashed "+C.border,borderRadius:"10px",flexShrink:"0"},"No consoles yet. Add one by address or search your network.");
   split=controls.length;into=node("div",content,{display:"flex",flexDirection:"column",width:"340px",flexShrink:"0"});
   section("Menu");
   [["+  Add console",function(){show("register");}],["Find consoles on network",async function(){await ensureClient();client.discover();busy=true;notice("Searching the local network… B cancels.");}],["Stream settings",function(){show("settings");}],["Close Chiaki",close]].forEach(function(m){compact(action(m[0],m[1]));});
  }else if(name==="console"){
   title.textContent=selectedHost.name||selectedHost.address;status.textContent=(selectedHost.target>=1000000?"PlayStation 5":"PlayStation 4")+" · "+selectedHost.address;
   action("Connect",connect);action("Wake console",async function(){await ensureClient();client.wakeup(selectedHost);notice("Wake request sent. Allow the console a few seconds, then connect.");});action("Remove from Chiaki",function(){show("remove");});action("Back",function(){show("hosts");});
  }else if(name==="remove"){
   // Deliberately heavy: focus starts on Keep, and Remove needs three presses in a row.
   // Moving off the Remove button resets the count.
   title.textContent="Remove "+(selectedHost.name||selectedHost.address)+"?";
   status.textContent="Chiaki will forget this console's pairing. To use it again you'll need a new registration PIN from the console.";
   action("Keep console",function(){show("console");});
   var left=3,removeButton=action("",async function(){
    if(--left>0){removeButton.textContent="Press A "+left+" more time"+(left>1?"s":"")+" to remove";return;}
    var gone=selectedHost;state=await store.removeHost(gone.address);selectedHost=null;show("hosts");notice((gone.name||gone.address)+" removed.");
   });
   removeButton.style.color=C.danger;
   controls[controls.length-1].paint=function(on){if(!on){left=3;removeButton.textContent="Remove permanently (press A 3 times)";}removeButton.style.borderColor=on?C.danger:C.border;removeButton.style.backgroundColor=on?C.dangerBg:C.button;};
  }else if(name==="register"){
   title.textContent="Add a console";status.textContent="On your PlayStation: Settings → Remote Play → Link / Add Device";
   field("Console address",draft.address,15,async function(v){draft.address=v;});
   choice("Console",[[1000100,"PS5"],[1000,"PS4 · 10+"],[900,"PS4 · 9"],[800,"PS4 · 8"]],draft.target,function(v){draft.target=v;rerender();});
   field("PSN account ID (Base64)",draft.account,12,async function(v){draft.account=v;});field("Registration PIN",draft.pin?"••••••••":"",8,async function(v){draft.pin=v;},true);
   action("Register console",register);action("Back",function(){show("hosts");});
  }else if(name==="settings"){
   title.textContent="Stream settings";status.textContent="H.264 · SDR · stereo audio";
   var s=state.settings;
   function save(change){return async function(){overlayPrevious=null;state=await store.saveSettings(Object.assign({},state.settings,change(state.settings)));rerender();};}
   function set(key){return function(v){var c={};c[key]=v;return save(function(){return c;})();};}
   choice("Resolution",[[1,"360p"],[2,"540p"],[3,"720p"],[4,"1080p"]],s.resolution,set("resolution"));
   choice("Frame rate",[[30,"30 FPS"],[60,"60 FPS"]],s.fps,set("fps"));
   choice("Bitrate",g.CivChiakiStore.bitrateChoices.map(function(k){return [k,bitrateLabel({resolution:s.resolution,fps:s.fps,bitrate:k})];}),s.bitrate,set("bitrate"));
   choice("Confirm button",[[false,"A  (Nintendo)"],[true,"B  (PlayStation)"]],!!s.swapButtons,set("swapButtons"));
   choice("Debug overlay",[[false,"Off"],[true,"On"]],!!s.overlay,set("overlay"));
   action("Back",function(){show("hosts");});
  }else if(name==="stream"){
   title.textContent=selectedHost.name||selectedHost.address;status.textContent=menu?"":"Connecting…";
   action("Resume",function(){menu=false;client.resume();show("stream");});
   action("PS button",function(){client.button(1<<15);menu=false;client.resume();show("stream");});
   action("Touchpad click",function(){client.button(1<<14);menu=false;client.resume();show("stream");});
   action("Debug overlay: "+(state.settings.overlay?"On":"Off"),toggleOverlay);
   action("Disconnect",disconnect);
   footer.textContent="D-pad  Move     "+keys().accept+"  Select     "+keys().back+"  or  − +  Back to game";
  }
  var k=keys();
  if(name!=="stream")footer.textContent="D-pad  Move     "+(name==="hosts"&&split>0?"← →  Consoles / Menu     ":name==="settings"||name==="register"?"← →  Change     ":"")+k.accept+"  Select     "+k.back+"  "+(name==="hosts"?"Close":"Back");
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
 async function ensureClient(){
  if(client)return client;if(!g.CivChiakiNative.available)throw Error("This is a browser preview. Launch the .civapp from CivHomebrew to use Remote Play.");
  // Share one start-up between callers so repeated presses can't create two clients.
  if(!clientPromise){notice("Preparing Remote Play…");clientPromise=g.CivChiakiClient.create({onImage:function(url){image.style.backgroundImage=url?'url("'+url+'")':"";}}).then(function(c){client=c;return c;},function(error){clientPromise=null;throw error;});}
  return clientPromise;
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
  if(screen==="hosts")close();else show(screen==="remove"?"console":"hosts");
 }
 var running=false,clientPromise=null,lastConsole=0,lastAction="",nextRepeat=0,owner={owner:"civchiaki"};
 function navigate(name,phase){
  if(closed||closing||keyboard.active())return;if(name==="keyboard-escape")name="cancel";
  if(phase!==0&&phase!==3){lastAction="";return;}
  if(streaming&&!menu)return;
  if(name==="cancel"){if(phase===0)back();return;}if(busy)return;
  if(name==="accept"){if(phase===0&&controls[selected])controls[selected].run();return;}
  if(name==="nav-left"||name==="nav-right"){if(phase!==0||!controls[selected])return;if(controls[selected].adjust)controls[selected].adjust(name==="nav-right"?1:-1);else if(split>0&&split<controls.length){var target=name==="nav-right"?split:Math.min(split-1,lastConsole);if((selected<split)!==(target<split)){if(selected<split)lastConsole=selected;selected=target;paint();}}return;}
  var delta=name==="nav-up"?-1:name==="nav-down"?1:0;if(!delta||!controls.length)return;
  var now=Date.now();if(phase===3&&(lastAction!==name||now<nextRepeat))return;
  lastAction=name;nextRepeat=now+(phase===0?350:140);selected=(selected+delta+controls.length)%controls.length;paint();
 }
 // Optional PlayStation-style layout: the bottom face button (Nintendo B) confirms.
 function keys(){return state&&state.settings.swapButtons?{accept:"B",back:"A"}:{accept:"A",back:"B"};}
 function nativeAction(name,phase,x,y){if(state&&state.settings.swapButtons&&(name==="accept"||name==="cancel"))name=name==="accept"?"cancel":"accept";if(name==="nav-move"){x=Number(x);y=Number(y);if(Math.abs(x)>=0.5&&Math.abs(x)>Math.abs(y))name=x>0?"nav-right":"nav-left";else if(Math.abs(y)>=0.5)name=y>0?"nav-up":"nav-down";else return;}navigate(name,Number(phase));}
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
