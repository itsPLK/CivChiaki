const test=require('node:test'),assert=require('node:assert/strict');
const {load,fixtures}=require('./helpers.cjs');
const api=load(['app/src/fec.js']).CivChiakiFec;
test('decode all 64 upstream Chiaki captured-packet fixtures with aligned strides',()=>{
 const cases=fixtures();assert.equal(cases.length,64);const kernel=api.createKernel();
 for(const f of cases){for(const e of f.erasures)f.data.fill(0x42,e*f.stride,e*f.stride+f.unit);kernel.decode(f.data,f.unit,f.stride,f.k,f.m,f.erasures);for(let i=0;i<f.k;i++)assert.deepEqual(Buffer.from(f.data.subarray(i*f.stride,i*f.stride+f.unit)),f.raw.subarray(i*f.unit,(i+1)*f.unit));}
});
test('encoder matches received upstream parity, including non-packed strides',()=>{
 // Erased parity slots in these captures contain placeholders, not parity.
 const kernel=api.createKernel();for(const f of fixtures()){kernel.encode(f.data,f.unit,f.stride,f.k,f.m);for(let i=f.k;i<f.k+f.m;i++)if(!f.erasures.includes(i))assert.deepEqual(Buffer.from(f.data.subarray(i*f.stride,i*f.stride+f.unit)),f.raw.subarray(i*f.unit,(i+1)*f.unit));}
});
test('worker source, chunked staging, submit and copy back match upstream captures',()=>{
 const source=api.source();assert.ok(source.length<256*1024);assert.match(source,/^[\x00-\x7f]*$/);
 const isolated=load([]);require('node:vm').runInContext(source,isolated);
 const out=new Uint8Array(4194304);let busy=false;
 const worker={bytes:out.length,step(input){assert.ok(JSON.stringify(input).length<65536);isolated.civStep(JSON.parse(JSON.stringify(input)),out);},submit(input){assert.ok(JSON.stringify(input).length<=900);busy=true;isolated.civStep(JSON.parse(JSON.stringify(input)),out);},poll(){if(!busy)return null;busy=false;return {data:out};},release:async()=>{}};
 const adapter=api.create(worker),f=fixtures()[63],core={HEAPU8:new Uint8Array(f.data.length+64)};for(const e of f.erasures)f.data.fill(0x42,e*f.stride,e*f.stride+f.unit);core.HEAPU8.set(f.data,32);
 assert.equal(adapter.begin(core,32,f.unit,f.stride,f.k,f.m,f.erasures,false),1);assert.equal(adapter.begin(core,32,f.unit,f.stride,f.k,f.m,f.erasures,false),-1);assert.equal(adapter.poll(core),0);
 for(let i=0;i<f.k;i++)assert.deepEqual(Buffer.from(core.HEAPU8.subarray(32+i*f.stride,32+i*f.stride+f.unit)),f.raw.subarray(i*f.unit,(i+1)*f.unit));
});
test('bad erasures and insufficient shards fail instead of producing corrupt video',()=>{
 const k=api.createKernel();assert.throws(()=>k.decode(new Uint8Array(16),4,4,3,1,[0,1]));assert.throws(()=>k.decode(new Uint8Array(16),4,4,3,1,[4]));assert.throws(()=>k.decode(new Uint8Array(1),4,4,3,1,[0]));
});
