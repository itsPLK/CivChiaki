const test=require('node:test'),assert=require('node:assert/strict'),{load}=require('./helpers.cjs');
const api=load(['app/src/worker-transfer.js']).CivChiakiWorkerTransfer;
function environment(){
 const data=0x300000000n,bs=0x400000000n,bank=new Uint8Array(448),objects=new Map(),buffers=new Map(),copies=[];new DataView(bank.buffer).setUint32(0,0x42564943,true);let cursor=0,busy=false,identity=true,basePointer=0n,badRead=false;
 function region(p,n){if(p>=data&&p+BigInt(n)<=data+BigInt(bank.length))return bank.subarray(Number(p-data),Number(p-data)+n);for(const [buffer,base] of buffers)if(p>=base&&p+BigInt(n)<=base+BigInt(buffer.byteLength))return new Uint8Array(buffer,Number(p-base),n);throw Error('Unknown native range');}
 const p={shared:()=>({bs,data,bytes:bank.length}),busy:()=>busy,now:()=>1,
  addrof:view=>{const object=0x500000000n+BigInt(++cursor*64);if(!buffers.has(view.buffer))buffers.set(view.buffer,0x200000000n+BigInt(buffers.size*65536));objects.set(object,{ptr:buffers.get(view.buffer)+BigInt(view.byteOffset)});return object;},
  read64:address=>{if(address===bs)return identity?data:data+8n;if(address===bs+8n)return BigInt(bank.length);for(const [object,v] of objects)if(address===object+0x28n)return v.ptr;throw Error('Unknown pointer field');},
  read32:address=>{if(address===data)return 0x42564943n;for(const [object]of objects)if(address===object+0x30n)return basePointer;throw Error('Unknown word field');},
  read8:address=>BigInt(region(address,1)[0]^(badRead?1:0)),
  memcpy:(to,from,n)=>{region(to,Number(n)).set(Uint8Array.from(region(from,Number(n))));copies.push({to,from,n});return to;}
 };return {transfer:api.create(p),bank,copies,setBusy:x=>busy=x,invalidate:()=>identity=false,badBase:()=>basePointer=1n,badRead:()=>badRead=true};
}
test('native binary copies respect byte offsets, guards and exact output lengths',()=>{
 const e=environment(),input=Uint8Array.from({length:64},(_,i)=>i);const before=Uint8Array.from(input);e.transfer.write(input.subarray(11,28),327);assert.deepEqual(Array.from(e.bank.subarray(327,344)),Array.from(input.subarray(11,28)));assert.deepEqual(input,before);assert.equal(e.bank[326],0);assert.equal(e.bank[344],0);
 const output=new Uint8Array(80);output.fill(211);e.transfer.read(output.subarray(3,23),17,327);assert.deepEqual(Array.from(output.subarray(3,20)),Array.from(input.subarray(11,28)));assert.equal(output[2],211);assert.equal(output[20],211);assert.deepEqual(e.copies.map(c=>Number(c.n)),[17,17]);
 e.transfer.write(Uint8Array.of(99),320);assert.equal(e.bank[320],99);assert.equal(e.transfer.write(new Uint8Array(0),448),0);assert.equal(e.transfer.read(output,0,448),0);
});
test('in-flight jobs, header writes, invalid ranges and stale identities fail before memcpy',()=>{
 const e=environment(),bytes=new Uint8Array(16);for(const offset of [0,319,-1,1.5,Infinity,440])assert.throws(()=>e.transfer.write(bytes,offset),/range/);assert.throws(()=>e.transfer.read(bytes,17,320),/small/);assert.throws(()=>e.transfer.read(bytes,-1,320),/range/);assert.equal(e.copies.length,0);
 e.setBusy(true);assert.throws(()=>e.transfer.write(bytes,320),/flight/);assert.throws(()=>e.transfer.read(bytes,16,320),/flight/);e.setBusy(false);e.invalidate();assert.throws(()=>e.transfer.write(bytes,320),/identity/);assert.equal(e.copies.length,0);
 for(const corrupt of ['badBase','badRead']){const v=environment();v[corrupt]();assert.throws(()=>v.transfer.write(Uint8Array.of(1,2),320),/external|mismatch/);assert.equal(v.copies.length,0);}
});
