const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');const {load}=require('../helpers.cjs');
const Core=require('../../dist/runtime/chiaki-core.js'),env=load(['app/vendor/forge-aes.js','app/src/crypto.js']),forge=env.CivChiakiForgeAES,api=env.CivChiakiCrypto;
async function setup(fast){const provider=fast?api.create(forge):null,c=await Core({chiakiPlatform:{crypto:provider,randomFill:a=>crypto.randomFillSync(a)}}),owned=[];function alloc(n){const p=c._malloc(n);owned.push(p);c.HEAPU8.fill(0,p,p+n);return p;}function put(bytes){const p=alloc(bytes.length);c.HEAPU8.set(bytes,p);return p;}const ctx=alloc(4096),log=alloc(128),handshake=put(Buffer.from('83cf931a6aa769a6c4485d19c15ccc52','hex')),secret=put(Buffer.from('73c8d549c4d9db502ec044ea33648c6ac9f36c41b6a0504fe093defb619b0973','hex'));c._chiaki_log_init(log,0,0,0);assert.equal(c._chiaki_gkcrypt_init(ctx,log,0,42,handshake,secret),0);return {c,ctx,alloc,put,provider,close(){c._chiaki_gkcrypt_fini(ctx);owned.forEach(p=>c._free(p));if(provider)provider.close();}};}
test('JS bulk hooks match the original Mbed TLS Takion key stream and GMAC across refresh boundaries',async()=>{
 const slow=await setup(false),fast=await setup(true);
 try{
  for(const [lo,hi] of [[0,0],[0x30,0],[0x420,1],[0x6b0000,0],[0x10000000,0]]){
   const outputs=[];for(const e of [slow,fast]){const p=e.alloc(4096);assert.equal(e.c._chiaki_gkcrypt_gen_key_stream(e.ctx,lo,hi,p,4096),0);outputs.push(Buffer.from(e.c.HEAPU8.subarray(p,p+4096)));}assert.deepEqual(outputs[0],outputs[1]);
   for(const size of [0,1,16,17,1200]){const data=Buffer.from(Array.from({length:size},(_,i)=>(i*29)&255)),tags=[];for(const e of [slow,fast]){const p=e.put(data.length?data:Buffer.alloc(1)),out=e.alloc(4);assert.equal(e.c._chiaki_gkcrypt_gmac(e.ctx,lo,hi,p,size,out),0);tags.push(Buffer.from(e.c.HEAPU8.subarray(out,out+4)));}assert.deepEqual(tags[0],tags[1]);}
  }assert.ok(fast.provider.stats().ecbCalls>0);assert.ok(fast.provider.stats().gmacCalls>0);
 }finally{slow.close();fast.close();}
});
test('real decrypt ABI preserves non-block-aligned packet positions with accelerated XOR',async()=>{
 const slow=await setup(false),fast=await setup(true);let xors=0;
 fast.provider.xor=(dst,key,n,heap)=>{for(let i=0;i<n;i++)heap[dst+i]^=heap[key+i];xors++;return 0;};
 try{for(const [lo,hi] of [[0,0],[37,0],[0xfffffffd,3]])for(const size of [0,1,7,8,15,31,1500]){
  const input=Buffer.from(Array.from({length:size||1},(_,i)=>(i*29+13)&255)),outputs=[];
  for(const e of [slow,fast]){const p=e.put(input);assert.equal(e.c._chiaki_gkcrypt_decrypt(e.ctx,lo,hi,p,size),0);outputs.push(Buffer.from(e.c.HEAPU8.subarray(p,p+size)));}assert.deepEqual(outputs[0],outputs[1]);
 }assert.equal(xors,21);fast.provider.xor=()=>-1;const p=fast.put(Buffer.alloc(16));assert.notEqual(fast.c._chiaki_gkcrypt_decrypt(fast.ctx,37,0,p,16),0);
 }finally{slow.close();fast.close();}
});

test('cached bulk provider preserves the actual C decrypt ABI across packet offsets and reordering',async()=>{
 const slow=await setup(false),fast=await setup(true),cached=api.withKeyStreamCache(fast.provider,fast.c);fast.c.chiakiPlatform.crypto=cached;
 try{for(const [lo,hi] of [[0,0],[1400,0],[2800,0],[1400,0],[0xfffffffd,3],[1500,4]])for(const n of [1,7,16,31,1400]){
  const input=Buffer.from(Array.from({length:n},(_,i)=>(i*13+23)&255)),outputs=[];
  for(const e of [slow,fast]){const p=e.put(input);assert.equal(e.c._chiaki_gkcrypt_decrypt(e.ctx,lo,hi,p,n),0);outputs.push(Buffer.from(e.c.HEAPU8.subarray(p,p+n)));}assert.deepEqual(outputs[0],outputs[1]);
 }assert.ok(cached.stats().keyStreamHits>0);
 }finally{cached.close();slow.close();fast.close();}
});
