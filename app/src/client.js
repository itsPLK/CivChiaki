(function(g){
 "use strict";
 var EVENT={CONNECTED:0,PIN:1,RUMBLE:8,QUIT:9,REGISTRATION_FAILED:100,IDLE:101};
 function hex(bytes){return Array.from(bytes).map(function(n){return n.toString(16).padStart(2,"0");}).join("");}
 function unhex(text){return new Uint8Array(text.match(/../g).map(function(p){return parseInt(p,16);}));}
 function account(text){
  if(typeof text!=="string"||! /^[A-Za-z0-9+/]{11}=$/.test(text))throw Error("Enter the eight-byte PSN account ID in Base64 (12 characters).");
  // Gameface provides neither atob nor btoa. Decode the fixed eight-byte ID
  // here and reject noncanonical padding bits rather than depending on DOM APIs.
  var alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",out=[],buffer=0,bits=0;
  for(var i=0;i<11;i++){buffer=(buffer<<6)|alphabet.indexOf(text[i]);bits+=6;if(bits>=8){bits-=8;out.push((buffer>>>bits)&255);}buffer&=(1<<bits)-1;}
  if(out.length!==8||buffer!==0)throw Error("Invalid Base64 PSN account ID");
  return new Uint8Array(out);
 }
 async function create(options){
  options=options||{};var events=[],core=null,media=null,video=null,io=null,fec=null,worker=null,controller=null,closed=false,closing=false,stopping=null;
  var activeHost=null,settings=null,registrationHost=null,fatal=null,paused=false,lastInput="",gate=inputGate(),pulse=0,pulseUntil=0,crypto=g.CivChiakiCrypto?g.CivChiakiCrypto.create():null;
  async function stage(name){if(options.onStage)await options.onStage(name);}
  function queue(type,data){events.push({type:type,data:data});}
  function failure(error){if(!fatal){fatal=error;queue("error",error.message);}}
  function guarded(fn,fallback){return function(){try{return fn.apply(null,arguments);}catch(e){failure(e);return fallback;}};}
  try{
   var transport=options.transport||g.CivChiakiNative.create();
   io=options.io||g.MoonlightStreamIO.create(transport);
   if(g.CivChiakiNativeCrypto&&g.CivChiakiNative.available)crypto=g.CivChiakiNativeCrypto.create(io,transport,crypto);
   await stage("native-adapters-ready");
   if(options.worker!==false){
    worker=options.worker||(g.CivChiakiWorker.open());
    if(worker)await worker.load(g.CivChiakiFec.source(!!worker.submitBinary),{bytes:4194304});
   }
   await stage("worker-ready");
   fec=g.CivChiakiFec.create(worker,{onError:function(e){queue("warning","FEC: "+e.message);}});
   var platform={io:io.io,randomFill:io.randomFill,fec:fec,crypto:crypto,
    // Delay-based congestion signal (see congestioncontrol adaptation in tools/build.py).
    receiveBacklogMs:function(){return options.latencyControl!==false&&io.backlogMs?io.backlogMs():0;},
    log:function(level,text){queue("log",{level:level,text:text});},
    event:function(type,a,b,text){queue("native",{type:type,a:a,b:b,text:text});},
    registered:function(target,name,mac,key,morning){queue("registered",{address:registrationHost,target:target,name:name,mac:hex(mac),key:hex(key),morning:hex(morning)});},
    discovered:function(target,address,name,state){queue("discovered",{target:target,address:address,name:name,state:state});},
    video:guarded(function(p,n,l,r,h){return video&&video.push(p,n,l,r,h)?1:0;},0),
    audioHeader:guarded(function(rate,channels,samples){if(media)media.audioSetup(rate,channels,1,1,samples);}),
    audio:guarded(function(p,n,h){if(media)media.audioFrame(p,n,h);})};
   core=await (options.factory||g.ChiakiCore)({chiakiPlatform:platform,printErr:function(text){queue("log",{level:1,text:text});}});
   // Allocate before streaming; the provider uses the current heap after growth.
   if(crypto&&g.CivChiakiCrypto.withKeyStreamCache&&options.keyStreamCache!==false){crypto=g.CivChiakiCrypto.withKeyStreamCache(crypto,core);platform.crypto=crypto;}
   await stage("core-created");
   if(core._cc_init())throw Error("Chiaki core initialization failed (cryptographic entropy unavailable)");
   // Video MACs are skipped unless explicitly requested; other packets are always verified.
   if(core._cc_set_verify_video_mac)core._cc_set_verify_video_mac(options.verifyVideoMac?1:0);
   // Video units are decrypted once per frame (one native XOR) unless disabled.
   if(core._cc_set_defer_video_decrypt)core._cc_set_defer_video_decrypt(options.batchVideoDecrypt===false?0:1);
   // Optional: video on its own task so FEC waits do not stop socket reads.
   if(core._cc_set_video_queue)core._cc_set_video_queue(options.videoTask===true?1:0);
   await stage("core-initialized");
   if(io.attachCore)io.attachCore(core);
   await stage("io-attached");
   controller=options.controller||g.MoonlightControllerInput.createNative({onRumbleError:function(e){queue("warning",e.message);}});
   await stage("controller-ready");
  }catch(error){if(crypto)crypto.close();if(controller)controller.close();if(fec)await fec.close();else if(worker)await worker.release();if(io)io.close();throw error;}
  function withBytes(arrays,fn){
   var pointers=[];try{for(var a of arrays){var p=core._malloc(a.length+1);if(!p)throw Error("Chiaki allocation failed");pointers.push(p);core.HEAPU8.set(a,p);core.HEAPU8[p+a.length]=0;}return fn(pointers);}finally{for(var p of pointers)core._free(p);}
  }
  function ascii(text){return Uint8Array.from(text,function(c){return c.charCodeAt(0);});}
  function check(code,operation){if(code)throw Error(operation+" failed (Chiaki error "+code+")");}
  function neutral(){pulse=0;if(core._cc_mode()===2)core._cc_controller(0,0,0,0,0,0,0);lastInput="";if(controller&&controller.stopRumble)controller.stopRumble();}
  function cleanupMedia(){
   if(media){media.close();media=null;}if(video){video.close();video=null;}activeHost=null;settings=null;lastInput="";
  }
  async function stop(){
   if(stopping)return stopping;
   stopping=(async function(){
    neutral();core._cc_stop();if(io.interrupt)io.interrupt(50);
    var deadline=Date.now()+8000;
    while(core._cc_mode()!==0){core._cc_tick(6);if(media)media.finishVideo();if(Date.now()>deadline)throw Error("Chiaki is still stopping; native resources retained. Retry close.");await new Promise(function(r){setTimeout(r,4);});}
    await stage("protocol-stopped");
    if(media&&options.onImage){options.onImage(null);for(var i=0;i<2;i++)await new Promise(function(r){if(g.requestAnimationFrame)g.requestAnimationFrame(r);else setTimeout(r,16);});}
    // Native GPU work must finish before the decoder, image or buffers are freed.
    if(media){var limit=Date.now()+2000;for(;;){try{await stage("media-close-begin");cleanupMedia();await stage("media-closed");break;}catch(error){if(Date.now()>limit)throw error;media.finishVideo();await new Promise(function(r){setTimeout(r,8);});}}}
   })();try{await stopping;}finally{stopping=null;}
  }
  function input(value){
   if(!value||!value.state)return;
   var s=value.state,buttons=0,now=Date.now(),gated=gate.filter(s[0],value.exit,now);
   if(gated.toggle){paused=!paused;neutral();queue("menu",paused);}
   if(paused||closing)return;
   var flags=gated.flags;if(gated.pulse){pulse|=gated.pulse;pulseUntil=now+100;}
   var map=[[0x1000,1],[0x2000,2],[0x4000,4],[0x8000,8],[4,16],[8,32],[1,64],[2,128],[0x100,256],[0x200,512],[0x40,1024],[0x80,2048],[0x10,4096],[0x20,8192]];
   for(var p of map)if(flags&p[0])buttons|=p[1];
   if(now>=pulseUntil)pulse=0;buttons|=pulse;
   var state=[buttons,s[1],s[2],s[3],-s[4],s[5],-s[6]].map(function(n,i){return i>=3?Math.max(-32768,Math.min(32767,n)):n;}),signature=state.join(",");
   if(signature!==lastInput){core._cc_controller.apply(core,state);lastInput=signature;}
  }
  return {
   discover:function(address){if(closed||closing)throw Error("Chiaki is closed");if(io.resume)io.resume();if(address){if(!g.CivChiakiStore.ipv4(address))throw Error("Invalid discovery address");withBytes([ascii(address)],function(p){check(core._cc_discover_at(p[0]),"Discovery");});}else check(core._cc_discover(),"Discovery");},
   wakeup:function(host){
    if(closed||closing||!g.CivChiakiStore.validHost(host))throw Error("Invalid registered console");if(io.resume)io.resume();
    var key=unhex(host.key),text="";for(var c of key){if(!c)break;text+=String.fromCharCode(c);}
    if(! /^[a-fA-F0-9]{1,16}$/.test(text))throw Error("Saved wake credential is invalid");
    withBytes([ascii(host.address),ascii(text)],function(p){check(core._cc_wakeup(p[0],host.target>=1000000?1:0,p[1]),"Wake console");});
   },
   register:function(host,target,id,pin){
    if(closed||closing||stopping||core._cc_mode())throw Error("Chiaki is busy");
    if(!g.CivChiakiStore.ipv4(host)||[800,900,1000,1000100].indexOf(target)<0||! /^\d{8}$/.test(pin))throw Error("Enter an IPv4 address and the eight-digit console registration PIN.");
    var decoded=account(id);registrationHost=host;if(io.resume)io.resume();
    withBytes([ascii(host),decoded],function(p){check(core._cc_register(p[0],target,p[1],Number(pin)),"Registration");});
   },
   connect:function(host,profile){
    if(closed||closing||stopping||core._cc_mode())throw Error("Chiaki is busy");
    if(!g.CivChiakiStore.validHost(host))throw Error("Invalid registered console");
    // Auto (0) resolves to the per-resolution/FPS default before reaching the core.
    if(profile&&!profile.bitrate&&g.CivChiakiStore&&g.CivChiakiStore.bitrateFor)profile=Object.assign({},profile,{bitrate:g.CivChiakiStore.bitrateFor(profile),autoBitrate:true});
    fatal=null;paused=false;activeHost=host;settings=profile;if(io.resume)io.resume();
    media=(options.mediaFactory||g.MoonlightStreamMedia.create)(io,core,{renderer:"native-gpu-texture",smoothVideo:true,onImage:function(url){if(!stopping&&!closing&&options.onImage)options.onImage(url);},onStatus:function(s){queue("status",s);}});
    try{
     var dims=[[0,0],[640,360],[960,540],[1280,720],[1920,1080]][profile.resolution];if(!dims)throw Error("Invalid resolution");
     check(media.videoSetup(1,dims[0],dims[1],profile.fps),"H.264 decoder setup");
     video=g.CivChiakiH264.create(core,media,profile.fps);
     withBytes([ascii(host.address),unhex(host.key),unhex(host.morning)],function(p){check(core._cc_connect(p[0],host.target>=1000000?1:0,p[1],p[2],profile.resolution,profile.fps,profile.bitrate),"Connection");});
    }catch(error){cleanupMedia();throw error;}
   },
   tick:function(){
    if(closed||stopping)return;
    try{
     // Start GPU work before pumping protocol fibers so transfer completion can
     // overlap CPU/network work rather than occupying a second animation tick.
     if(media)media.drainVideo();
     if(core._cc_mode()===2){var value=controller&&controller.poll();if(!value&&g.navigator&&g.navigator.getGamepads){for(var pad of g.navigator.getGamepads()){value=g.MoonlightControllerInput.fromBrowser(pad);if(value)break;}}if(value)input(value);else if(pulse)input({state:[0,0,0,0,0,0,0],exit:false});else neutral();}
     core._cc_tick(options.pumpBudgetMs||12);
     if(media){var now=g.MoonlightTelemetry?g.MoonlightTelemetry.now():Date.now();media.finishVideo(now+2);media.drainAudio();}
     if(fatal&&core._cc_mode()===2)core._cc_stop();
     if(core._cc_mode()===0&&media)stop().catch(failure);
    }catch(error){failure(error);core._cc_stop();}
   },
   events:function(){var out=events;events=[];return out;},
   service:function(){
    if(closed||closing||stopping||core._cc_mode()!==2)return;
    try{core._cc_tick(options.serviceBudgetMs||4);if(media)media.drainAudio();}catch(error){failure(error);core._cc_stop();}
   },
   loginPin:function(pin){if(! /^\d{4}$/.test(pin))throw Error("Enter a four-digit console login PIN");withBytes([ascii(pin)],function(p){check(core._cc_login_pin(p[0]),"Login PIN");});},
   button:function(button){if(core._cc_mode()===2){neutral();pulse=button&0xffff;pulseUntil=Date.now()+100;core._cc_controller(pulse,0,0,0,0,0,0);lastInput="";}},
   pause:function(){paused=true;neutral();},resume:function(){paused=false;lastInput="";gate.reset();},
   rumble:function(low,high){if(!paused&&controller&&controller.rumble)controller.rumble(0,low*257,high*257);},
   stop:stop,
   close:async function(){if(closed)return;closing=true;await stop();if(controller)controller.close();await stage("controller-closed");await fec.close();await stage("worker-closed");if(crypto)crypto.close();await stage("crypto-closed");io.close();await stage("io-closed");closed=true;},
   state:function(){return {mode:core._cc_mode(),paused:paused,profile:settings?Object.assign({},settings):null,pumpBudgetMs:options.pumpBudgetMs||12,serviceBudgetMs:options.serviceBudgetMs||4,host:activeHost?{address:activeHost.address,name:activeHost.name,target:activeHost.target}:null,crypto:crypto?crypto.stats():null,verifyVideoMac:!!options.verifyVideoMac,videoMacSkipped:core._cc_video_mac_skipped_count?core._cc_video_mac_skipped_count():null,batchVideoDecrypt:options.batchVideoDecrypt!==false,videoFramesDecrypted:core._cc_video_decrypt_frames?core._cc_video_decrypt_frames():null,videoTask:options.videoTask===true,latencyControl:options.latencyControl!==false,congestionSignals:core._cc_congestion_signals?core._cc_congestion_signals():null,recovery:core._cc_recovery_metrics?Array.from(new Float64Array(core.HEAPU8.buffer,core._cc_recovery_metrics(),2)):null,videoQueue:core._cc_video_queue_metrics?Array.from(new Float64Array(core.HEAPU8.buffer,core._cc_video_queue_metrics(),4)):null,runtime:core._cc_runtime_metrics?Array.from(new Float64Array(core.HEAPU8.buffer,core._cc_runtime_metrics(),41)):null,worker:fec.stats(),network:io.stats||null,media:media?media.stats():null};}
  };
 }
 // Filters controller flags before they reach the console. Buttons still down when the
 // menu opens or closes (−/+, the menu's confirm press) are dropped until released.
 // −/+ (0x10/0x20) are held back 200 ms so pressing them together for the menu doesn't
 // leak the first one; a quicker tap is replayed on release as a Share/Options pulse.
 function inputGate(){
  var held=0,since=0,tap=0,exitHeld=false;
  function reset(){held=-1;since=0;tap=0;}
  return {reset:reset,filter:function(flags,exit,now){
   var toggle=!!exit&&!exitHeld,pulse=0;exitHeld=!!exit;if(toggle)reset();
   if(held===-1)held=flags;held&=flags;flags&=~held;
   if(flags&0x30){if(!since)since=now;tap|=flags&0x30;if(now-since<200)flags&=~0x30;else tap=0;}
   else{if(tap)pulse=(tap&0x10?4096:0)|(tap&0x20?8192:0);since=0;tap=0;}
   return {flags:flags,pulse:pulse,toggle:toggle};
  }};
 }
 g.CivChiakiClient={create:create,inputGate:inputGate,account:account,events:EVENT};
})(typeof window!=="undefined"?window:globalThis);
