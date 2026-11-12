const test=require('node:test'),assert=require('node:assert/strict');const {load}=require('./helpers.cjs');
const api=load(['app/src/h264.js']).CivChiakiH264;
test('separate SPS/PPS callbacks configure the first access unit and preserve owned headers',()=>{
 const calls=[],freed=[],core={HEAPU8:new Uint8Array(200000),next:4096,_malloc(n){let p=this.next;this.next+=n;return p;},_free(p){freed.push(p);}};
 const adapter=api.create(core,{videoFrame(...a){calls.push(a);return 0;}},60);
 function push(bytes){core.HEAPU8.set(bytes,128);return adapter.push(128,bytes.length,0,false,core.HEAPU8);}
 assert.equal(push([0,0,1,0x65,1]),false);assert.equal(push([0,0,0,1,0x67,1,2,3,0,0,1,0x68,4]),true);assert.equal(calls.length,0);
 assert.equal(push([0,0,1,0x65,9]),true);assert.deepEqual(Array.from(core.HEAPU8.subarray(calls[0][4],calls[0][4]+calls[0][5])),[0x67,1,2,3]);assert.equal(calls[0][3],0);push([0,0,0,1,0x41,3]);assert.equal(calls[1][3],16667);adapter.close();adapter.close();assert.equal(freed.length,2);
});
test('large compressed slices are forwarded without scanning their payload',()=>{
 const core={HEAPU8:new Uint8Array(500000),next:200000,_malloc(n){const p=this.next;this.next+=n;return p;},_free(){}},calls=[];
 const adapter=api.create(core,{videoFrame(...args){calls.push(args);return 0;}},30);
 const bytes=new Uint8Array(150000);bytes.fill(0x88);const prefix=[0,0,1,0x67,1,2,3,0,0,0,1,0x68,4,0,0,1,0x65];bytes.set(prefix);
 let reads=0;const guarded=new Proxy(bytes,{get(target,key){if(/^[0-9]+$/.test(String(key))){reads++;assert.ok(Number(key)<prefix.length,'scanned compressed slice payload');}const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;}});
 const heap={length:bytes.length,subarray:()=>guarded};assert.equal(adapter.push(0,bytes.length,0,false,heap),true);assert.ok(reads<100);assert.equal(calls.length,1);assert.equal(calls[0][1],150000);assert.deepEqual(Array.from(core.HEAPU8.subarray(calls[0][4],calls[0][4]+calls[0][5])),[0x67,1,2,3]);assert.deepEqual(Array.from(core.HEAPU8.subarray(calls[0][6],calls[0][6]+calls[0][7])),[0x68,4]);adapter.close();
});
