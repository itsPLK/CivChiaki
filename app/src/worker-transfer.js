/* Bounded copies between rooted UI views and the owned worker BackingStore. */
(function(g){
 "use strict";
 function create(p){
  function integer(n){return Number.isSafeInteger(n)&&n>=0;}
  function checked(bytes,offset,write){
   if(p.busy())throw Error("Worker job in flight");
   var shared=p.shared();offset=offset===undefined?0:offset;
   if(!shared||!integer(bytes)||!integer(offset)||offset+bytes>shared.bytes||(write&&offset<320))throw Error("Worker transfer range rejected");
   if(p.read64(shared.bs)!==shared.data||p.read64(shared.bs+8n)!==BigInt(shared.bytes)||p.read32(shared.data)!==0x42564943n)throw Error("Worker BackingStore identity changed");
   return {address:shared.data+BigInt(offset),bytes:bytes};
  }
  function address(view,bytes){
   if(!(view instanceof Uint8Array)||!integer(bytes)||bytes>view.byteLength||view.byteOffset+view.byteLength>view.buffer.byteLength)throw Error("Expected live Uint8Array transfer range");
   var object=p.addrof(view),ptr=p.read64(object+0x28n);
   if(p.read32(object+0x30n)!==0n||ptr<0x100000000n||ptr+BigInt(view.byteLength)>0x8000000000n)throw Error("UI transfer view is not a validated external buffer");
   // Non-mutating verification also supports subarrays and one-byte uploads.
   for(var i=0;i<Math.min(bytes,8);i++)if(p.read8(ptr+BigInt(i))!==BigInt(view[i]))throw Error("UI transfer view pointer mismatch");
   return ptr;
  }
  function copy(to,from,n){var start=p.now(),result=p.memcpy(to,from,BigInt(n));if(result!==to)throw Error("Worker memcpy returned an unexpected pointer");return p.now()-start;}
  return {
   write:function(src,offset){if(!(src instanceof Uint8Array))throw Error("Expected binary input Uint8Array");var r=checked(src.byteLength,offset,true);if(!r.bytes)return 0;return copy(r.address,address(src,r.bytes),r.bytes);},
   read:function(dst,bytes,offset){if(!(dst instanceof Uint8Array))throw Error("Expected binary output Uint8Array");bytes=bytes===undefined?dst.byteLength:bytes;var r=checked(bytes,offset,false);if(!integer(bytes)||bytes>dst.byteLength)throw Error("Output view is too small");if(!bytes)return 0;return copy(address(dst,bytes),r.address,bytes);}
  };
 }
 g.CivChiakiWorkerTransfer={create:create};
})(typeof window!=="undefined"?window:globalThis);
