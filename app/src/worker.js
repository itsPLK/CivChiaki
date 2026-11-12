/* Chiaki binary job adapter over the bundled native worker scheduler (app/vendor/worker-native.js).
 * One in-flight job; the worker's payload bank is reused in place. */
(function(g){
 "use strict";
 var HEADER=320,MAGIC=0x42564943,COMMIT=0x454e4421,MAX_BYTES=4194304,MAX_SOURCE=262144,MAX_METADATA=65536;
 function prelude(total){
  return 'if(globalThis.__civChiakiBinaryWorker)globalThis.__civChiakiBinaryWorker.retire();'+
   'globalThis.__civChiakiBinaryWorker=(function(){var B='+total+',S=new ArrayBuffer(B),H=new Uint32Array(S,0,16),E=new Uint8Array(S,64,256),O=new Uint8Array(S,320),seq=0,step=null;H[0]='+MAGIC+';H[2]=B;H[8]=1;'+
   'function run(a,n){var s=++seq;H[3]=0;H[1]=s;H[4]=0;H[5]=0;H[6]=0;H[7]=n;try{if(!step)throw Error("civStep missing");var used=step(a,O,O.subarray(0,n));if(!Number.isInteger(used)||used<0||used>O.length)throw Error("Invalid worker output length");H[6]=used;}catch(e){var m=String(e&&e.stack||e).slice(0,256);for(var i=0;i<m.length;i++)E[i]=m.charCodeAt(i)&127;H[5]=m.length;H[4]=1;}H[3]=('+COMMIT+'^s)>>>0;}'+
   'return{queue:function(a,n){Promise.resolve().then(function(){run(a,n);});},bind:function(fn){step=typeof fn==="function"?fn:null;return !!step;},retire:function(){H[0]=0;step=null;}};})();';
 }
 function asciiJson(value){var text=JSON.stringify(value===undefined?null:value);if(typeof text!=="string")throw TypeError("Worker metadata is not JSON-serialisable");return text.replace(/[\u0080-\uffff]/g,function(c){return '\\u'+c.charCodeAt(0).toString(16).padStart(4,'0');});}
 function create(backend,onRelease){
  var loaded=false,capacity=0,header=new Uint8Array(new ArrayBuffer(HEADER)),view=new DataView(header.buffer),output=null,pending=null,seq=0,closed=false,failure=null;
  var metrics={binary:true,jobs:0,results:0,errors:0,inputBytes:0,outputBytes:0,uploadMs:0,copyMs:0};
  function healthy(){if(closed)throw Error("Worker is released");if(failure)throw Error("Worker unusable: "+failure);}
  function idle(){healthy();if(pending||backend.busy)throw Error("Worker job in flight");}
  function word(n){return view.getUint32(n*4,true);}
  function limits(timeout,wait){if(!Number.isFinite(timeout)||timeout<0||timeout>60000||!Number.isFinite(wait)||wait<0||wait>10)throw RangeError("Invalid worker poll limits");}
  function validBase(){if(word(0)!==MAGIC||word(2)!==HEADER+capacity||word(8)!==1)throw Error("Binary worker header is corrupt");}
  function retire(){if(!loaded)return;backend.evaluate("binary-retire","__civChiakiBinaryWorker.retire();",1024);backend.forgetShared();loaded=false;output=null;capacity=0;}
  var api={
   load:async function(source,config){
    idle();var bytes=config&&config.bytes;
    if(!Number.isInteger(bytes)||bytes<4||bytes>MAX_BYTES||bytes%4)throw RangeError("Invalid worker capacity");
    if(typeof source!=="string"||!source.length||source.length>MAX_SOURCE||/[^\x01-\x7f]/.test(source))throw RangeError("Worker source must be bounded ASCII");
    retire();capacity=bytes;
    try{
     var init=prelude(HEADER+bytes);backend.evaluate("binary-prelude",init,init.length+1);
     var app='(function(){\n'+source+'\n;if(!__civChiakiBinaryWorker.bind(typeof civStep==="function"?civStep:null))throw Error("civStep missing");})();';
     backend.evaluate("binary-app",app,app.length+1);backend.locate(HEADER+bytes);backend.readShared(header,HEADER);validBase();
     output=new Uint8Array(new ArrayBuffer(bytes));seq=0;loaded=true;return {bytes:bytes,binary:true};
    }catch(error){capacity=0;output=null;try{backend.evaluate("binary-load-cleanup","if(globalThis.__civChiakiBinaryWorker)__civChiakiBinaryWorker.retire();",1024);backend.forgetShared();}catch(cleanup){failure=String(cleanup);}throw error;}
   },
   submitBinary:function(metadata,bytes){
    idle();if(!loaded)throw Error("Worker has no app code");if(!(bytes instanceof Uint8Array)||bytes.byteLength>capacity)throw RangeError("Binary input exceeds capacity");
    var text=asciiJson(metadata);if(text===undefined||text.length>MAX_METADATA)throw RangeError("Worker metadata exceeds limit");idle();
    try{
     metrics.uploadMs+=backend.writeShared(bytes,HEADER);metrics.inputBytes+=bytes.byteLength;
     backend.submit('__civChiakiBinaryWorker.queue('+text+','+bytes.byteLength+');');pending={seq:++seq,inputBytes:bytes.byteLength};metrics.jobs++;return seq;
    }catch(error){failure=String(error);throw error;}
   },
   poll:function(options){
    healthy();if(!pending)return null;options=options||{};var timeout=options.timeoutMs===undefined?2000:options.timeoutMs,wait=options.waitMs===undefined?0:options.waitMs;limits(timeout,wait);
    try{
     var done=backend.poll(header,timeout,wait,HEADER);if(!done)return null;
     validBase();if(word(1)!==pending.seq||word(3)!==((COMMIT^pending.seq)>>>0)||word(7)!==pending.inputBytes||word(4)>1||word(5)>256||word(6)>capacity||(!word(4)&&word(5)!==0))throw Error("Binary worker result bounds or sequence mismatch");
     var used=word(6),error=null;if(word(4)){if(used!==0)throw Error("Failed worker published output");error='';for(var i=0;i<word(5);i++)error+=String.fromCharCode(header[64+i]);if(!error)error="Worker job failed";metrics.errors++;}
     var copyMs=done.copyMs||0;if(used)copyMs+=backend.readShared(output,used,HEADER);
     var result={seq:pending.seq,data:output.subarray(0,used),error:error,waitMs:done.waitMs,submitMs:done.submitMs,copyMs:copyMs};pending=null;metrics.results++;metrics.outputBytes+=used;metrics.copyMs+=copyMs;return result;
    }catch(error){failure=String(error);throw error;}
   },
   stats:function(){var stats=backend.stats();return Object.assign({},stats,metrics,{nativeJobs:stats.jobs,loaded:loaded,busy:!!pending,poisoned:failure||backend.stats().poisoned});},
   release:async function(timeoutMs){
    if(closed)return;limits(timeoutMs===undefined?2000:timeoutMs,0);var until=Date.now()+(timeoutMs===undefined?2000:timeoutMs);
    while(pending&&!failure&&!backend.stats().poisoned){api.poll({timeoutMs:timeoutMs===undefined?2000:timeoutMs,waitMs:0});if(!pending)break;if(Date.now()>=until)throw Error("Worker still owns in-flight buffers");await new Promise(function(r){setTimeout(r,4);});}
    if(!failure&&!backend.stats().poisoned)retire();closed=true;if(onRelease)onRelease();
   }
  };
  Object.defineProperties(api,{bytes:{get:function(){return capacity;}},busy:{get:function(){return !!pending;}},released:{get:function(){return closed;}}});return Object.freeze(api);
 }
 var state=g.__civChiakiBinaryWorkerState;
 if(!state)state=g.__civChiakiBinaryWorkerState={version:1,backend:null,owner:null,failure:null};
 function open(options){
  if(state.version!==1)throw Error("Chiaki worker backend version mismatch");
  if(state.owner&&!state.owner.released)throw Error("Chiaki binary worker is already owned");
  if(state.failure)throw Error("Chiaki binary worker requires a game restart: "+state.failure);
  if(!state.backend)state.backend=g.CivChiakiWorkerNative.create(options&&options.primitives);
  if(state.backend.stats().poisoned)throw Error("Chiaki binary worker requires a game restart");
  var owner=create(state.backend,function(){var stats=owner.stats();if(stats.poisoned)state.failure=String(stats.poisoned);state.owner=null;});state.owner=owner;return owner;
 }
 g.CivChiakiWorker={create:create,open:open,prelude:prelude,constants:{HEADER:HEADER,MAGIC:MAGIC,COMMIT:COMMIT,MAX_BYTES:MAX_BYTES,MAX_SOURCE:MAX_SOURCE,MAX_METADATA:MAX_METADATA}};
})(typeof window!=="undefined"?window:globalThis);
