/* Bulk AES and GHASH in Forge's 32-bit JS kernels, avoiding wasm2js i64 GHASH.
 * Chiaki still owns nonce/key selection and little-endian counter formatting.
 */
(function(g){
 "use strict";
 // V8 here is interpreter-only: every bytecode counts, while typed-array
 // builtins run natively. Reuse views for the current heap buffer.
 var littleEndian=new Uint8Array(new Uint32Array([1]).buffer)[0]===1,viewHeap=null,viewData=null,viewWords=null;
 function views(heap){
  if(heap!==viewHeap){viewHeap=heap;viewData=new DataView(heap.buffer,heap.byteOffset,heap.byteLength);viewWords=heap.byteOffset%4===0?new Uint32Array(heap.buffer,heap.byteOffset,heap.byteLength>>>2):null;}
  return viewData;
 }
 function fillCounter(key,iv,low,high,data,length,heap){
  if(!Number.isInteger(iv)||iv<0||iv+16>heap.length||!Number.isInteger(data)||data<0||!Number.isInteger(length)||length<0||length%16||data+length>heap.length)throw Error("Key stream range rejected");
  var view=views(heap),base=4294967296;
  var a=view.getUint32(iv,true)+(low>>>0),b=view.getUint32(iv+4,true)+(high>>>0)+(a>=base?1:0),c=view.getUint32(iv+8,true)+(b>=base?1:0),d=(view.getUint32(iv+12,true)+(c>=base?1:0))>>>0;
  a>>>=0;b>>>=0;c>>>=0;
  var blocks=length/16;if(!blocks)return;
  if(littleEndian&&viewWords&&data%4===0&&a+blocks-1<base){
   // Only the first counter word changes when it cannot carry: write block 0,
   // replicate it with native bulk copies, then store one word per block.
   var w=data>>>2,filled=16;viewWords[w]=a;viewWords[w+1]=b;viewWords[w+2]=c;viewWords[w+3]=d;
   while(filled<length){var n=filled<length-filled?filled:length-filled;heap.copyWithin(data+filled,data,data+n);filled+=n;}
   for(var i=1;i<blocks;i++)viewWords[w+i*4]=a+i;
   return;
  }
  for(var end=data+length;data<end;data+=16){view.setUint32(data,a,true);view.setUint32(data+4,b,true);view.setUint32(data+8,c,true);view.setUint32(data+12,d,true);a=(a+1)>>>0;if(a===0){b=(b+1)>>>0;if(b===0){c=(c+1)>>>0;if(c===0)d=(d+1)>>>0;}}}
 }
 function create(forge){
  forge=forge||g.CivChiakiForgeAES||g.forge;if(!forge||!forge.cipher)return null;
  var ciphers=new Map(),closed=false,metrics={ecbCalls:0,ecbBytes:0,gmacCalls:0,gmacBytes:0,totalMs:0,maxMs:0};
  function now(){return g.performance&&g.performance.now?g.performance.now():Date.now();}
  function binary(heap,p,n){if(!Number.isInteger(p)||!Number.isInteger(n)||p<0||n<0||p+n>heap.length)throw Error("Crypto heap range rejected");var text="";for(var i=0;i<n;i+=8192)text+=String.fromCharCode.apply(null,heap.subarray(p+i,p+Math.min(n,i+8192)));return text;}
  function cipher(mode,key){var id=mode+key,result=ciphers.get(id);if(!result){result=forge.cipher.createCipher(mode,key);if(ciphers.size>=8)ciphers.delete(ciphers.keys().next().value);ciphers.set(id,result);}return result;}
  function write(heap,p,text){if(p<0||p+text.length>heap.length)throw Error("Crypto output range rejected");for(var i=0;i<text.length;i++)heap[p+i]=text.charCodeAt(i);}
  function timed(fn){if(closed)throw Error("Crypto provider closed");var start=now();try{return fn();}finally{var elapsed=now()-start;metrics.totalMs+=elapsed;metrics.maxMs=Math.max(metrics.maxMs,elapsed);}}
  return {
   keyStream:function(key,iv,low,high,data,length,heap){fillCounter(key,iv,low,high,data,length,heap);return this.ecb(key,data,length,heap);},
   ecb:function(key,data,length,heap){return timed(function(){
    if(length%16)throw Error("AES block length rejected");var input=binary(heap,data,length),c=cipher("AES-ECB",binary(heap,key,16));c.start();c.update(forge.util.createBuffer(input));if(!c.finish(function(){return true;}))throw Error("AES encryption failed");var output=c.output.getBytes();if(output.length!==length)throw Error("AES output length mismatch");write(heap,data,output);metrics.ecbCalls++;metrics.ecbBytes+=length;return 0;
   });},
   gmac:function(key,iv,data,length,output,heap){return timed(function(){
    // Compute the full tag and truncate explicitly: the reference Forge build
    // retains 16 bytes for short tagLength values divisible into 16.
    var c=cipher("AES-GCM",binary(heap,key,16));c.start({iv:binary(heap,iv,16),additionalData:binary(heap,data,length),tagLength:128});if(!c.finish())throw Error("GMAC failed");var tag=c.mode.tag.getBytes(4);if(tag.length!==4)throw Error("GMAC output length mismatch");write(heap,output,tag);metrics.gmacCalls++;metrics.gmacBytes+=length;return 0;
   });},
   stats:function(){return Object.assign({cachedKeys:ciphers.size},metrics);},
   close:function(){closed=true;ciphers.clear();}
  };
 }
 // Two small demand-filled windows amortize native AES calls without a producer
 // task. Cache identity includes key *contents* and IV, never just heap pointers.
 function withKeyStreamCache(provider,core){
  var windowBytes=8192,slots=[],closed=false,clock=0,metrics={keyStreamHits:0,keyStreamMisses:0,keyStreamRequestedBytes:0,keyStreamGeneratedBytes:0};
  function blank(p){return {pointer:p,valid:false,k0:0,k1:0,k2:0,k3:0,i0:0,i1:0,i2:0,i3:0,start:0,end:0,used:0};}
  try{for(var i=0;i<2;i++){var p=core._malloc(windowBytes+16);if(!p)throw Error("Key stream cache allocation failed");slots.push(blank(p));}}
  catch(error){for(var slot of slots)core._free(slot.pointer);throw error;}
  function inRange(p,n,heap){return Number.isInteger(p)&&Number.isInteger(n)&&p>=0&&n>=0&&p+n<=heap.length;}
  var result=Object.create(provider);
  result.keyStream=function(key,iv,low,high,data,length,heap){
   if(closed)throw Error("Crypto provider closed");
   if(heap!==core.HEAPU8)throw Error("Stale key stream heap");
   if(!inRange(key,16,heap)||!inRange(iv,16,heap)||!inRange(data,length,heap))throw Error("Key stream range rejected");
   if(length%16)throw Error("AES block length rejected");
   if(!length)return 0;
   metrics.keyStreamRequestedBytes+=length;low>>>=0;high>>>=0;
   // Positions below 2**53 blocks are exact Numbers; real streams never get
   // close. Anything larger goes straight to the provider, uncached.
   if(length>windowBytes||high>=0x200000)return provider.keyStream(key,iv,low,high,data,length,heap);
   // Identity is the key and IV *contents* (never just their heap pointers).
   var view=views(heap),k0=view.getUint32(key,true),k1=view.getUint32(key+4,true),k2=view.getUint32(key+8,true),k3=view.getUint32(key+12,true);
   var i0=view.getUint32(iv,true),i1=view.getUint32(iv+4,true),i2=view.getUint32(iv+8,true),i3=view.getUint32(iv+12,true);
   var position=high*4294967296+low,end=position+length/16,slot=null;
   for(var j=0;j<2;j++){var s=slots[j];if(s.valid&&position>=s.start&&end<=s.end&&s.k0===k0&&s.k1===k1&&s.k2===k2&&s.k3===k3&&s.i0===i0&&s.i1===i1&&s.i2===i2&&s.i3===i3){slot=s;break;}}
   if(slot)metrics.keyStreamHits++;
   else{
    metrics.keyStreamMisses++;
    slot=slots[0].used<=slots[1].used?slots[0]:slots[1];slot.valid=false;
    // Tiny control/audio requests do not trigger speculative video-sized work.
    var size=length<512?length:windowBytes;
    var status=provider.keyStream(key,iv,low,high,slot.pointer,size,heap);
    if(status!==0)return status;
    metrics.keyStreamGeneratedBytes+=size;
    slot.k0=k0;slot.k1=k1;slot.k2=k2;slot.k3=k3;slot.i0=i0;slot.i1=i1;slot.i2=i2;slot.i3=i3;slot.start=position;slot.end=position+size/16;slot.valid=true;
   }
   slot.used=++clock;var source=slot.pointer+(position-slot.start)*16;
   heap.copyWithin(data,source,source+length);return 0;
  };
  result.stats=function(){return Object.assign({},provider.stats(),metrics);};
  result.close=function(){if(closed)return;closed=true;for(var slot of slots){core.HEAPU8.fill(0,slot.pointer,slot.pointer+windowBytes+16);slot.valid=false;core._free(slot.pointer);}slots=[];provider.close();};
  return result;
 }
 g.CivChiakiCrypto={create:create,fillCounter:fillCounter,withKeyStreamCache:withKeyStreamCache};
})(typeof window!=="undefined"?window:globalThis);
