const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {load,fixtures}=require('./helpers.cjs');
const env=load(['app/src/worker.js','app/src/fec.js']),API=env.CivChiakiWorker;
function backend(){
 const buffers=[],copies=[],scripts=[];let bank=null,job=false,held=false,poisoned=null;
 class TrackedBuffer extends ArrayBuffer{constructor(n){super(n);buffers.push(this);}}
 const context=vm.createContext({ArrayBuffer:TrackedBuffer,Uint8Array,Uint32Array},{microtaskMode:'afterEvaluate'});
 const b={
  get busy(){return job;},get bank(){return bank;},copies,scripts,
  hold(v){held=v;},poison(){poisoned='test timeout';},
  evaluate(stage,source,limit){assert.ok(!job);assert.ok(source.length<limit);scripts.push({stage,source});return vm.runInContext(source,context,{timeout:1000});},
  locate(total){const matches=buffers.filter(x=>x.byteLength===total&&new Uint32Array(x,0,1)[0]===API.constants.MAGIC);assert.equal(matches.length,1);bank=new Uint8Array(matches[0]);return {list:'test'};},
  forgetShared(){bank=null;},
  writeShared(src,offset){assert.ok(!job);assert.ok(offset>=320&&offset+src.length<=bank.length);bank.set(src,offset);copies.push({direction:'in',bytes:src.length,offset});return .1;},
  readShared(dst,n,offset=0){assert.ok(!job);assert.ok(n<=dst.length&&offset+n<=bank.length);dst.set(bank.subarray(offset,offset+n));copies.push({direction:'out',bytes:n,offset});return .1;},
  submit(source){assert.ok(!job);scripts.push({stage:'submit',source});vm.runInContext(source,context,{timeout:1000});job=true;},
  poll(dst,_timeout,_wait,n){assert.ok(job);if(held)return null;job=false;b.readShared(dst,n);return {copyMs:.1,waitMs:1,submitMs:.2};},
  stats(){return {busy:job,poisoned};}
 };return b;
}
test('binary worker copies subarray input and only used output; buffers and source scope are reused',async()=>{
 const b=backend(),w=API.create(b);await w.load('let n=0;function civStep(meta,out,input){for(let i=0;i<meta.count;i++)out[i]=input[i]^meta.mask;n++;out[meta.count]=n;return meta.count+1;}',{bytes:4096});
 const input=new Uint8Array(100);for(let i=0;i<input.length;i++)input[i]=i;
 for(let job=1;job<=3;job++){
  b.copies.length=0;assert.equal(w.submitBinary({count:7,mask:31,label:'☃'},input.subarray(11,24)),job);assert.equal(w.busy,true);assert.throws(()=>w.submitBinary({},input),/flight/);
  const result=w.poll();assert.deepEqual(Array.from(result.data),[...Array.from(input.subarray(11,18),x=>x^31),job]);assert.equal(result.seq,job);assert.equal(result.error,null);
  assert.deepEqual(b.copies,[{direction:'in',bytes:13,offset:320},{direction:'out',bytes:320,offset:0},{direction:'out',bytes:8,offset:320}]);
 }
 assert.ok(b.scripts.filter(x=>x.stage==='submit').every(x=>/^[\x00-\x7f]*$/.test(x.source)&&x.source.length<200));assert.equal(w.stats().inputBytes,39);assert.equal(w.stats().outputBytes,24);assert.equal(w.stats().results,3);
 await w.release();assert.equal(w.released,true);assert.equal(b.bank,null);assert.throws(()=>w.submitBinary({},input),/released/);
});
test('one job retains ownership through pending polls and release timeout',async()=>{
 const b=backend(),w=API.create(b);await w.load('function civStep(m,o,i){return i.length;}',{bytes:64});b.hold(true);const input=Uint8Array.of(1,2,3);w.submitBinary(null,input);input.fill(9);assert.equal(w.poll(),null);assert.equal(w.busy,true);await assert.rejects(w.load('function civStep(){}',{bytes:64}),/flight/);await assert.rejects(w.release(0),/owns/);assert.equal(w.released,false);b.hold(false);const r=w.poll();assert.deepEqual(Array.from(r.data),[1,2,3]);await w.release();
});
test('binary FEC preserves all 64 upstream captures with one upload and one bounded result',async()=>{
 const b=backend(),w=API.create(b);await w.load(env.CivChiakiFec.source(true),{bytes:4194304});const fec=env.CivChiakiFec.create(w);
 for(const f of fixtures()){
  for(const index of f.erasures)f.data.fill(0x42,index*f.stride,index*f.stride+f.unit);
  const core={HEAPU8:new Uint8Array(f.data.length+64)};core.HEAPU8.set(f.data,32);b.copies.length=0;
  assert.equal(fec.begin(core,32,f.unit,f.stride,f.k,f.m,f.erasures,false),1);assert.equal(fec.poll(core),0);
  for(let i=0;i<f.k;i++)assert.deepEqual(Buffer.from(core.HEAPU8.subarray(32+i*f.stride,32+i*f.stride+f.unit)),f.raw.subarray(i*f.unit,(i+1)*f.unit));
  assert.deepEqual(b.copies.map(c=>c.bytes),[f.data.length,320,f.data.length]);
 }
 assert.equal(fec.stats().binary,true);assert.equal(fec.stats().jobs,64);assert.equal(w.stats().jobs,64);await fec.close();
});
test('malformed output is rejected before a payload copy and poisons the handle',async()=>{
 for(const mutate of [h=>h[6]=65,h=>h[1]++,h=>h[7]++,h=>h[8]=99,h=>h[3]=0,h=>h[5]=257]){
  const b=backend(),w=API.create(b);await w.load('function civStep(){return 0;}',{bytes:64});w.submitBinary({},Uint8Array.of(1));mutate(new Uint32Array(b.bank.buffer,0,16));b.copies.length=0;assert.throws(()=>w.poll(),/bounds|corrupt/);assert.deepEqual(b.copies.map(c=>c.bytes),[320]);assert.throws(()=>w.submitBinary({},new Uint8Array(0)),/unusable/);await w.release();
 }
});
test('worker exceptions and invalid returned lengths expose no payload and allow a subsequent job',async()=>{
 const b=backend(),w=API.create(b);await w.load('function civStep(m,o,i){if(m.fail)throw Error("expected failure");if(m.bad)return 999;return 0;}',{bytes:64});
 for(const meta of [{fail:true},{bad:true},{}]){b.copies.length=0;w.submitBinary(meta,new Uint8Array(0));const r=w.poll();assert.equal(r.data.length,0);assert.deepEqual(b.copies.map(c=>c.bytes),[0,320]);assert.equal(!!r.error,!!(meta.fail||meta.bad));}assert.equal(w.stats().errors,2);await w.release();
});
test('capacity, metadata, source and failed-load validation occur before native writes',async()=>{
 const b=backend(),w=API.create(b);for(const bytes of [0,3,4194308,NaN])await assert.rejects(w.load('function civStep(){}',{bytes}),/capacity/);
 for(const source of ['', '☃', 'a'.repeat(262145)])await assert.rejects(w.load(source,{bytes:64}),/ASCII/);
 await assert.rejects(w.load('let other=1;',{bytes:64}),/civStep/);assert.equal(w.bytes,0);await w.load('function civStep(){return 0;}',{bytes:64});b.copies.length=0;
 assert.throws(()=>w.submitBinary({},new Uint8Array(65)),/capacity/);assert.throws(()=>w.submitBinary('x'.repeat(65536),new Uint8Array(1)),/metadata/);const cyclic={};cyclic.self=cyclic;assert.throws(()=>w.submitBinary(cyclic,new Uint8Array(1)));assert.equal(b.copies.length,0);
 // Metadata larger than the old 900-byte limit is valid and contains no payload bytes.
 w.submitBinary({erasures:Array.from({length:256},(_,i)=>i)},Uint8Array.of(17));assert.equal(w.poll().error,null);await w.release();
});
test('reload starts a fresh scoped handler and a failed FEC job cannot copy truncated data',async()=>{
 const b=backend(),w=API.create(b);for(let i=0;i<2;i++){await w.load('let state=0;function civStep(m,o){o[0]=++state;return 1;}',{bytes:64});w.submitBinary({},new Uint8Array(0));assert.equal(w.poll().data[0],1);}await w.release();
 const f=env.CivChiakiFec.create({bytes:1024,submitBinary(){},poll(){return {data:new Uint8Array(1)};},release:async()=>{}});const core={HEAPU8:new Uint8Array(64)};core.HEAPU8.fill(19);assert.equal(f.begin(core,0,4,4,3,1,[0],false),1);assert.equal(f.poll(core),-1);assert.ok(core.HEAPU8.every(x=>x===19));
});
test('poll limits reject caller mistakes without corrupting a pending job',async()=>{
 const b=backend(),w=API.create(b);await w.load('function civStep(){return 0;}',{bytes:64});w.submitBinary({},new Uint8Array(0));for(const options of [{timeoutMs:Infinity},{timeoutMs:-1},{waitMs:11}])assert.throws(()=>w.poll(options),/limits/);assert.equal(w.poll().error,null);await assert.rejects(w.release(Infinity),/limits/);assert.equal(w.released,false);await w.release();
});
test('open leases one retained native backend across adapter reloads and rejects poisoned reuse',async()=>{
 const fs=require('node:fs'),g=load(['app/src/worker.js']);let creates=0;const b=backend();g.CivChiakiWorkerNative={create(){creates++;return b;}};
 const first=g.CivChiakiWorker.open();assert.throws(()=>g.CivChiakiWorker.open(),/owned/);await first.load('function civStep(){return 0;}',{bytes:64});first.submitBinary({},new Uint8Array(0));first.poll();await first.release();
 vm.runInContext(fs.readFileSync('app/src/worker.js','utf8'),g);const next=g.CivChiakiWorker.open();assert.notEqual(first,next);assert.equal(creates,1);await next.load('function civStep(){return 0;}',{bytes:64});next.submitBinary({},new Uint8Array(0));new Uint32Array(b.bank.buffer,0,16)[6]=65;assert.throws(()=>next.poll(),/bounds/);await next.release();assert.throws(()=>g.CivChiakiWorker.open(),/restart/);assert.equal(creates,1);
});
test('native backend rejects absent primitives and code mismatches before any allocation or write',()=>{
 const g=load(['app/src/worker-transfer.js','app/vendor/worker-native.js']);assert.throws(()=>g.CivChiakiWorkerNative.create(),/unavailable/);let mutations=0;const mutate=()=>{mutations++;return 0n;};assert.throws(()=>g.CivChiakiWorkerNative.create({main_base:0x100000000n,read8:()=>0n,read32:()=>0n,read64:()=>0n,write32:mutate,write64:mutate,malloc:mutate,free:mutate,addrof:()=>0n,call_rop:mutate}),/fingerprint/);assert.equal(mutations,0);
});
