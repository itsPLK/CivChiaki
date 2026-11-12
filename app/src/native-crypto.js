/* Civ VII 1.0.0 SDK GCM C wrappers: verified instruction layout and object ABI.
 * The SDK does AES/GHASH natively; only the four-byte GMAC result crosses back.
 */
(function(g){
 "use strict";
 function create(io,transport,fallback){
  if(typeof sdk_base!=="bigint"||typeof call_rop!=="function")return fallback;
  var prefix="nncryptoAes128GcmEncryptor",names=["Initialize","Reset","UpdateAad","GetMac"],offsets=[0x31b0n,0x3250n,0x3260n,0x3310n],signatures=[[0xa9bb7bfdn,0xf9000bf9n],[0x9102c000n,0x14000148n],[0x91032000n],[0x9102c000n]],api={};
  for(var i=0;i<names.length;i++){
   var p=transport.resolveNativeSymbol(prefix+names[i]);if(p!==sdk_base+offsets[i])throw Error("Unsupported native GCM entry");
   for(var j=0;j<signatures[i].length;j++){if(read32(p+BigInt(j*4))!==signatures[i][j])throw Error("Unsupported native GCM instructions");}api[names[i]]=p;
  }
  var size=transport.resolveNativeSymbol(prefix+"ObjectSize");if(read64(size)!==0x248n||read64(size+8n)!==16n)throw Error("Unsupported native GCM object layout");
  var bulk=transport.resolveNativeSymbol("_ZN2nn6crypto6detail11XtsModeImpl13ProcessBlocksINS0_12AesEncryptorILm16EEEEEmPhPKhi");
  if(bulk!==sdk_base+0x12b40n||read32(bulk)!==0xa9bc7bfdn||read32(bulk+0x54n)!==0x710012ffn||read32(bulk+0x320n)!==0xd65f03c0n)throw Error("Unsupported native bulk AES instructions");
  var xorFunction=transport.resolveNativeSymbol("_ZN2nn4util8BitArray3XorEPS1_RKS1_S4_");
  if(xorFunction!==sdk_base+0x7fbc0n||read32(xorFunction)!==0xb9400828n||read32(xorFunction+0x30n)!==0xca0a016an||read32(xorFunction+0x48n)!==0xd65f03c0n)throw Error("Unsupported native XOR instructions");
  var owned=[],aesContexts=[],contexts=[],closed=false,stats={nativeXorCalls:0,nativeXorBytes:0,nativeXorMs:0,nativeEcbCalls:0,nativeEcbBytes:0,nativeEcbMs:0,nativeGmacCalls:0,nativeGmacBytes:0,nativeGmacMs:0,maxNativeGmacMs:0};
  function alloc(n){var p=malloc(n+15);if(p<0x100000000n||p>=0x8000000000n)throw Error("Native crypto allocation failed");owned.push(p);return (p+15n)&~15n;}
  var tag=alloc(16),mode=alloc(80),xorLeft=alloc(16),xorRight=alloc(16);
  var initialize=api.Initialize,reset=api.Reset,updateAad=api.UpdateAad,getMac=api.GetMac,viewHeap=null,view=null;
  function heapView(heap){if(heap!==viewHeap){viewHeap=heap;view=new DataView(heap.buffer,heap.byteOffset,heap.byteLength);}return view;}
  // Context caches compare key words (contents, not pointers) and evict in
  // insertion order, like the previous Map. Avoids building strings per packet.
  function lookup(list,heap,key){
   var v=heapView(heap),k0=v.getUint32(key,true),k1=v.getUint32(key+4,true),k2=v.getUint32(key+8,true),k3=v.getUint32(key+12,true);
   for(var i=0;i<list.length;i++){var e=list[i];if(e.k0===k0&&e.k1===k1&&e.k2===k2&&e.k3===k3)return e;}
   var entry;if(list.length>=4){entry=list.shift();entry.fresh=true;}else entry={context:0n,fresh:true};
   entry.k0=k0;entry.k1=k1;entry.k2=k2;entry.k3=k3;list.push(entry);return entry;
  }
  function range(heap,p,n){if(!Number.isInteger(p)||!Number.isInteger(n)||p<0||n<0||p+n>heap.length)throw Error("Native crypto heap range rejected");}
  function now(){return g.MoonlightTelemetry?g.MoonlightTelemetry.now():Date.now();}
  return {
   xor:function(data,key,length,heap){
    if(closed)throw Error("Native crypto provider closed");range(heap,data,length);range(heap,key,length);var begin=now(),whole=length-length%8;
    if(whole){var base=io.heapAddress(heap);write64(xorLeft,base+BigInt(data));write32(xorLeft+8n,BigInt(whole*8));write64(xorRight,base+BigInt(key));call_rop(xorFunction,xorLeft,xorLeft,xorRight);}
    for(var i=whole;i<length;i++)heap[data+i]^=heap[key+i];stats.nativeXorCalls++;stats.nativeXorBytes+=length;stats.nativeXorMs+=now()-begin;return 0;
   },
   keyStream:function(key,iv,low,high,data,length,heap){if(closed)throw Error("Native crypto provider closed");range(heap,key,16);g.CivChiakiCrypto.fillCounter(key,iv,low,high,data,length,heap);return this.ecb(key,data,length,heap);},
   ecb:function(key,data,length,heap){
    if(closed)throw Error("Native crypto provider closed");range(heap,key,16);range(heap,data,length);
    if(length%16)throw Error("AES block length rejected");if(!length)return 0;
    // The bulk routine buffers one trailing block. Keep that bounded read in
    // the validated heap; it never changes the sentinel or emits its bytes.
    if(length>1048576||data+length+16>heap.length)return fallback?fallback.ecb(key,data,length,heap):1;
    var start=now(),base=io.heapAddress(heap),entry=lookup(aesContexts,heap,key),context;
    if(entry.fresh){if(!entry.context)entry.context=alloc(584);var k=base+BigInt(key);call_rop(initialize,entry.context,k,16n,k,16n);entry.fresh=false;}
    context=entry.context;
    // With a zero XTS tweak every whitening/multiply operation stays zero,
    // leaving hardware AES-ECB. State 1 skips a previous buffered block.
    write64(mode+0x10n,0n);write64(mode+0x18n,0n);write64(mode+0x38n,context);write32(mode+0x48n,1n);
    var count=call_rop(bulk,mode,base+BigInt(data),base+BigInt(data),BigInt(length/16+1));
    if(count!==BigInt(length))throw Error("Native bulk AES output length mismatch");
    stats.nativeEcbCalls++;stats.nativeEcbBytes+=length;stats.nativeEcbMs+=now()-start;return 0;
   },
   gmac:function(key,iv,data,length,output,heap){
    if(closed)throw Error("Native crypto provider closed");range(heap,key,16);range(heap,iv,16);range(heap,data,length);range(heap,output,4);
    var start=now(),base=io.heapAddress(heap),entry=lookup(contexts,heap,key),context;
    if(entry.fresh){if(!entry.context)entry.context=alloc(0x248);call_rop(initialize,entry.context,base+BigInt(key),16n,base+BigInt(iv),16n);entry.fresh=false;}
    else call_rop(reset,entry.context,base+BigInt(iv),16n);
    context=entry.context;
    if(length)call_rop(updateAad,context,base+BigInt(data),BigInt(length));
    call_rop(getMac,context,tag,16n);heapView(heap).setUint32(output,Number(read32(tag)),true);
    var elapsed=now()-start;stats.nativeGmacCalls++;stats.nativeGmacBytes+=length;stats.nativeGmacMs+=elapsed;stats.maxNativeGmacMs=Math.max(stats.maxNativeGmacMs,elapsed);return 0;
   },
   stats:function(){return Object.assign({},fallback?fallback.stats():{},stats);},
   close:function(){if(closed)return;closed=true;contexts=[];aesContexts=[];for(var p of owned.reverse())free(p);owned=[];if(fallback)fallback.close();}
  };
 }
 g.CivChiakiNativeCrypto={create:create};
})(typeof window!=="undefined"?window:globalThis);
