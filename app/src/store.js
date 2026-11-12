/* Two alternating, read-back-verified records survive interrupted save writes. */
(function(g){
 "use strict";
 var ROOT="save:/civhomebrew/data/chiaki",defaults={resolution:3,fps:30,bitrate:0,overlay:false};
 // bitrate 0 is Auto: requested Kbps by resolution (360p..1080p) at 30/60 FPS.
 // Above what the receiver can process, latency control lets the console back off.
 var AUTO={1:[2000,3000],2:[6000,8000],3:[10000,15000],4:[15000,20000]};
 var CHOICES=[0,2000,3000,5000,8000,10000,12000,15000,20000,25000,30000,40000,50000];
 function autoBitrate(s){return AUTO[s.resolution][s.fps===60?1:0];}
 function bitrateFor(s){return s.bitrate||autoBitrate(s);}
 function nextBitrate(current){var i=CHOICES.indexOf(current);return CHOICES[(i+1)%CHOICES.length];}
 // Left/right: step without wrapping; an unknown saved value steps from Auto.
 function stepBitrate(current,delta){var i=CHOICES.indexOf(current);if(i<0)i=0;return CHOICES[Math.max(0,Math.min(CHOICES.length-1,i+delta))];}
 function ipv4(text){return typeof text==="string"&&/^\d{1,3}(\.\d{1,3}){3}$/.test(text)&&text.split(".").every(function(n){return Number(n)<=255&&String(Number(n))===n;});}
 function settings(s){return !!s&&[1,2,3,4].indexOf(s.resolution)>=0&&[30,60].indexOf(s.fps)>=0&&Number.isInteger(s.bitrate)&&(s.bitrate===0||s.bitrate>=1000&&s.bitrate<=50000)&&(s.overlay===undefined||typeof s.overlay==="boolean");}
 function host(h){return !!h&&ipv4(h.address)&&[800,900,1000,1000100].indexOf(h.target)>=0&&typeof h.name==="string"&&h.name.length<=128&&/^[a-f0-9]{32}$/.test(h.key)&&/^[a-f0-9]{32}$/.test(h.morning)&&/^[a-f0-9]{12}$/.test(h.mac);}
 function validate(v){return !!v&&v.version===1&&Number.isSafeInteger(v.generation)&&v.generation>=0&&Array.isArray(v.hosts)&&v.hosts.length<=64&&v.hosts.every(host)&&new Set(v.hosts.map(function(h){return h.address;})).size===v.hosts.length&&settings(v.settings);}
 function create(io){
  var value=null,chain=Promise.resolve();
  function clone(v){return JSON.parse(JSON.stringify(v));}
  async function load(){
   if(value)return clone(value);var entries=[],present=false;
   for(var i=0;i<2;i++){
    var text=await io.read(ROOT+"/state-"+i+".json",65536);if(text===null)continue;present=true;
    try{var v=JSON.parse(text);if(validate(v))entries.push(v);}catch(_){}
   }
   entries.sort(function(a,b){return b.generation-a.generation;});
   if(!entries.length&&present)throw Error("Saved Chiaki data is unreadable. The files were left intact.");
   value=entries[0]||{version:1,generation:0,hosts:[],settings:Object.assign({},defaults)};return clone(value);
  }
  function mutate(change){
   var result=chain.then(async function(){
    var next=await load();change(next);next.generation++;
    if(!validate(next))throw Error("Invalid Chiaki save data");
    await io.ensureDirectory("save:/civhomebrew/data");await io.ensureDirectory(ROOT);
    var path=ROOT+"/state-"+(next.generation%2)+".json",text=JSON.stringify(next);
    await io.write(path,text);await io.commit();
    if(await io.read(path,65536)!==text)throw Error("Chiaki save verification failed");value=next;return clone(value);
   });chain=result.catch(function(){});return result;
  }
  return {load:load,saveHost:function(h){return mutate(function(v){v.hosts=v.hosts.filter(function(old){return old.address!==h.address;});v.hosts.push(h);});},removeHost:function(address){return mutate(function(v){v.hosts=v.hosts.filter(function(h){return h.address!==address;});});},saveSettings:function(s){return mutate(function(v){v.settings=clone(s);});}};
 }
 function browserIO(storage){
  var prefix="civchiaki-preview:";
  return {read:async function(p){return storage.getItem(prefix+p);},write:async function(p,v){storage.setItem(prefix+p,v);},ensureDirectory:async function(){},commit:async function(){}};
 }
 g.CivChiakiStore={create:create,browserIO:browserIO,ipv4:ipv4,validHost:host,defaults:defaults,root:ROOT,validSettings:settings,autoBitrate:autoBitrate,bitrateFor:bitrateFor,nextBitrate:nextBitrate,stepBitrate:stepBitrate,bitrateChoices:CHOICES.slice()};
})(typeof window!=="undefined"?window:globalThis);
