const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {load}=require('./helpers.cjs');
const api=load(['app/src/crypto.js']).CivChiakiCrypto;
function setup(){
 let cursor=32768,calls=0,closed=0,status=0;const owned=new Set();
 const core={HEAPU8:new Uint8Array(65536),_malloc(n){const p=cursor;cursor+=n;owned.add(p);return p;},_free(p){assert.ok(owned.delete(p));}};
 function generate(key,iv,low,high,data,n,heap){calls++;if(status)return status;api.fillCounter(key,iv,low,high,data,n,heap);const c=crypto.createCipheriv('aes-128-ecb',heap.slice(key,key+16),null);c.setAutoPadding(false);heap.set(Buffer.concat([c.update(heap.subarray(data,data+n)),c.final()]),data);return 0;}
 const provider={keyStream:generate,stats:()=>({calls}),close(){closed++;}},cache=api.withKeyStreamCache(provider,core);
 core.HEAPU8.set(crypto.randomBytes(32),0);
 return {core,cache,owned,generate,calls:()=>calls,closed:()=>closed,setStatus:s=>status=s};
}
test('cached keys match independent AES output across reorder, key/IV changes, high positions and heap growth',()=>{
 const e=setup();
 for(const [lo,hi,n,change] of [[0,0,1440],[90,0,1440],[0,0,1440],[270,0,1504],[0xfffffff0,7,1440],[0x4a,8,1024],[0,0,1440,'key'],[90,0,1440,'iv'],[0,0,16],[1,0,0],[0,0,9008],[0xffffffff,0xffffffff,32],[90,0,1440,'grow']]){
  if(change==='grow'){const heap=new Uint8Array(131072);heap.set(e.core.HEAPU8);e.core.HEAPU8=heap;}
  const h=e.core.HEAPU8;if(change==='key')h[0]^=123;if(change==='iv')h[16]^=99;
  const reference=h.slice();assert.equal(e.generate(0,16,lo,hi,4096,n,reference),0);
  h.fill(0xa5,4095,4096+n+1);assert.equal(e.cache.keyStream(0,16,lo,hi,4096,n,h),0);
  assert.deepEqual(h.subarray(4096,4096+n),reference.subarray(4096,4096+n));assert.equal(h[4095],0xa5);assert.equal(h[4096+n],0xa5);
 }
 assert.ok(e.cache.stats().keyStreamHits>=3);e.cache.close();e.cache.close();assert.equal(e.owned.size,0);assert.equal(e.closed(),1);assert.ok(e.core.HEAPU8.subarray(32768,32768+2*8208).every(x=>x===0));assert.throws(()=>e.cache.keyStream(0,16,0,0,4096,16,e.core.HEAPU8),/closed/);
});
test('40 Mbps equivalent contiguous requests reduce AES invocations without changing requested bytes',()=>{
 const e=setup(),packets=3473,n=1440;
 for(let i=0;i<packets;i++)assert.equal(e.cache.keyStream(0,16,i*n/16,0,4096,n,e.core.HEAPU8),0);
 assert.equal(e.calls(),Math.ceil(packets/5));assert.equal(e.cache.stats().keyStreamRequestedBytes,packets*n);
 assert.ok(e.cache.stats().keyStreamGeneratedBytes<packets*n*1.15);e.cache.close();
});
test('failed generation is never cached or copied, and invalid input never reaches the provider',()=>{
 const e=setup(),h=e.core.HEAPU8;h.fill(0xa5,4096,4112);
 for(const status of [1,-1]){e.setStatus(status);assert.equal(e.cache.keyStream(0,16,0,0,4096,16,h),status);assert.ok(h.subarray(4096,4112).every(x=>x===0xa5));}
 e.setStatus(0);assert.equal(e.cache.keyStream(0,16,0,0,4096,16,h),0);assert.equal(e.calls(),3);
 for(const args of [[-1,16,0,0,4096,16],[0,16,0,0,4096,15],[0,16,0,0,65535,16]])assert.throws(()=>e.cache.keyStream(...args,h),/range|length/);
 assert.equal(e.calls(),3);e.cache.close();
});
