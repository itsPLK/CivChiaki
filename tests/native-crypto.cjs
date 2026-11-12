const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{load}=require('./helpers.cjs');
function environment(){
 const sdk=0x7000000000n,allocationBase=0x200000000n,heapBase=0x300000000n,memory=Buffer.alloc(16384),heap=new Uint8Array(12000),owned=new Set(),contexts=new Map();let cursor=0,calls=0;
 const symbols={_ZN2nn4util8BitArray3XorEPS1_RKS1_S4_:0x7fbc0n,nncryptoAes128GcmEncryptorInitialize:0x31b0n,nncryptoAes128GcmEncryptorReset:0x3250n,nncryptoAes128GcmEncryptorUpdateAad:0x3260n,nncryptoAes128GcmEncryptorGetMac:0x3310n,nncryptoAes128GcmEncryptorObjectSize:0x8c1310n,_ZN2nn6crypto6detail11XtsModeImpl13ProcessBlocksINS0_12AesEncryptorILm16EEEEEmPhPKhi:0x12b40n};
 const fingerprints=new Map([[0x7fbc0n,0xb9400828n],[0x7fbf0n,0xca0a016an],[0x7fc08n,0xd65f03c0n],[0x31b0n,0xa9bb7bfdn],[0x31b4n,0xf9000bf9n],[0x3250n,0x9102c000n],[0x3254n,0x14000148n],[0x3260n,0x91032000n],[0x3310n,0x9102c000n],[0x12b40n,0xa9bc7bfdn],[0x12b94n,0x710012ffn],[0x12e60n,0xd65f03c0n]]);
 function bytes(p,n){if(p>=heapBase&&p+BigInt(n)<=heapBase+BigInt(heap.length))return Buffer.from(heap.buffer,Number(p-heapBase),n);assert.ok(p>=allocationBase&&p+BigInt(n)<=allocationBase+BigInt(memory.length));return memory.subarray(Number(p-allocationBase),Number(p-allocationBase)+n);}
 function r64(p){return bytes(p,8).readBigUInt64LE();}
 const g=load(['app/src/native-crypto.js'],{sdk_base:sdk,malloc:n=>{const p=allocationBase+BigInt(cursor);cursor+=n+16;owned.add(p);return p;},free:p=>assert.ok(owned.delete(p)),
 read32:p=>p>=sdk?fingerprints.get(p-sdk):BigInt(bytes(p,4).readUInt32LE()),read64:p=>p===sdk+0x8c1310n?584n:p===sdk+0x8c1318n?16n:r64(p),write32:(p,n)=>bytes(p,4).writeUInt32LE(Number(n)),write64:(p,n)=>bytes(p,8).writeBigUInt64LE(n),
 call_rop:(fn,...a)=>{calls++;const op=fn-sdk;
  if(op===0x31b0n){assert.equal(a[2],16n);assert.equal(a[4],16n);contexts.set(a[0],{key:Buffer.from(bytes(a[1],16)),iv:Buffer.from(bytes(a[3],16)),aad:Buffer.alloc(0)});return 0n;}
  if(op===0x7fbc0n){const n=Math.ceil(bytes(a[1]+8n,4).readUInt32LE()/64)*8,left=bytes(r64(a[1]),n),right=bytes(r64(a[2]),n),out=bytes(r64(a[0]),n);for(let i=0;i<n;i++)out[i]=left[i]^right[i];return 0n;}
  const c=contexts.get(a[0]);
  if(op===0x3250n){assert.equal(a[2],16n);c.iv=Buffer.from(bytes(a[1],16));c.aad=Buffer.alloc(0);return 0n;}
  if(op===0x3260n){c.aad=Buffer.from(bytes(a[1],Number(a[2])));return 0n;}
  if(op===0x3310n){assert.equal(a[2],16n);const cipher=crypto.createCipheriv('aes-128-gcm',c.key,c.iv);cipher.setAAD(c.aad);cipher.final();bytes(a[1],16).set(cipher.getAuthTag());return 0n;}
  if(op===0x12b40n){assert.equal(r64(a[0]+0x10n),0n);assert.equal(r64(a[0]+0x18n),0n);assert.equal(bytes(a[0]+0x48n,4).readUInt32LE(),1);const n=(Number(a[3])-1)*16,key=contexts.get(r64(a[0]+0x38n)).key,cipher=crypto.createCipheriv('aes-128-ecb',key,null);cipher.setAutoPadding(false);const result=Buffer.concat([cipher.update(bytes(a[2],n)),cipher.final()]);bytes(a[1],n).set(result);return BigInt(n);}
  throw Error('Unexpected native entry');
 }});
 const transport={resolveNativeSymbol:n=>sdk+symbols[n]},io={heapAddress:h=>{assert.equal(h,heap);return heapBase;}};
 return {g,heap,owned,fingerprints,calls:()=>calls,create:()=>g.CivChiakiNativeCrypto.create(io,transport,null)};
}
test('native crypto ABI preserves vectors, cache eviction, truncation, and allocation ownership',()=>{
 const e=environment(),p=e.create();
 for(let keyId=0;keyId<7;keyId++)for(const n of [0,1,16,31,1500]){
  const key=Buffer.alloc(16,keyId*17),iv=Buffer.alloc(16,keyId*23),data=Buffer.from(Array.from({length:n},(_,i)=>i&255));e.heap.set(key,1);e.heap.set(iv,17);e.heap.set(data,65);e.heap.fill(0xa5,10000,10016);
  const c=crypto.createCipheriv('aes-128-gcm',key,iv,{authTagLength:4});c.setAAD(data);c.final();p.gmac(1,17,65,n,10000,e.heap);assert.deepEqual(Buffer.from(e.heap.subarray(10000,10004)),c.getAuthTag());assert.ok(e.heap.subarray(10004,10016).every(x=>x===0xa5));
 }
 const fixtures=require('./fixtures/native-ecb.json');for(const c of fixtures){const data=Buffer.from(c.input,'hex');e.heap.set(Buffer.from(c.key,'hex'),1);e.heap.set(data,67);p.ecb(1,67,data.length,e.heap);assert.deepEqual(Buffer.from(e.heap.subarray(67,67+data.length)),Buffer.from(c.expected,'hex'));}
 assert.equal(p.stats().nativeGmacCalls,35);assert.equal(p.stats().nativeEcbCalls,48);p.close();p.close();assert.equal(e.owned.size,0);assert.throws(()=>p.ecb(1,67,16,e.heap),/closed/);
});
test('native crypto rejects mismatched code and invalid buffers before native calls',()=>{
 const e=environment();e.fingerprints.set(0x3254n,0n);assert.throws(e.create,/instructions/);assert.equal(e.owned.size,0);assert.equal(e.calls(),0);
 const f=environment(),p=f.create();for(const args of [[-1,65,16],[1,65,17],[1,11999,16]])assert.throws(()=>p.ecb(...args,f.heap));assert.equal(f.calls(),0);assert.equal(p.ecb(1,11984,16,f.heap),1);p.close();assert.equal(f.owned.size,0);
});

test('native XOR preserves odd tails and canaries across alignment boundaries',()=>{
 const e=environment(),p=e.create();for(let offset=0;offset<8;offset++)for(const n of [0,1,7,8,9,15,16,31,1500]){e.heap.fill(0xa5);const left=Buffer.from(Array.from({length:n},(_,i)=>(i*17)&255)),right=Buffer.from(Array.from({length:n},(_,i)=>(i*31+9)&255));e.heap.set(left,65+offset);e.heap.set(right,5001);p.xor(65+offset,5001,n,e.heap);assert.deepEqual(Buffer.from(e.heap.subarray(65+offset,65+offset+n)),Buffer.from(left.map((b,i)=>b^right[i])));assert.equal(e.heap[64+offset],0xa5);assert.equal(e.heap[65+offset+n],0xa5);}p.close();assert.equal(e.owned.size,0);
});
