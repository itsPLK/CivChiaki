const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const Core=require('../../dist/runtime/chiaki-core.js');const {load,fixtures}=require('../helpers.cjs');
async function runtime(connectError=111){
 const events=[],logs=[],sockets=new Set();let next=20;
 const core=await Core({chiakiPlatform:{randomFill:a=>crypto.randomFillSync(a),event:(...a)=>events.push(a),log:(level,text)=>logs.push(text),io:(op,args,heap)=>{
  if(op===1){let fd=next++;sockets.add(fd);return fd;}
  if(op===2||op===7||op===9)return 0;
  if(op===10){sockets.delete(args[0]);return 0;}
  if(op===3)return -connectError;
  if(op===11){const view=new DataView(heap.buffer);for(let i=0;i<args[1];i++)view.setInt16(args[0]+i*8+6,0,true);return 0;}
  return -11;
 }}});assert.equal(core._cc_init(),0);
 return {core,events,logs,sockets};
}
function bytes(c,data){const p=c._malloc(data.length+1);c.HEAPU8.set(data,p);c.HEAPU8[p+data.length]=0;return p;}
async function drain(c){const until=Date.now()+2000;while(c._cc_mode()){c._cc_tick(5);if(Date.now()>until)throw Error('Core failed to clean up');await new Promise(r=>setTimeout(r,2));}assert.equal(c._cc_runtime_tasks(),0);}
test('real wasm2js Chiaki PS4 and PS5 failures unwind sessions, sockets and fibers; reconnect works',async()=>{
 const {core:c,events,sockets}=await runtime();const host=bytes(c,Buffer.from('192.168.1.22')),key=bytes(c,new Uint8Array(16)),morning=bytes(c,new Uint8Array(16));
 for(const ps5 of [1,0,1]){assert.equal(c._cc_connect(host,ps5,key,morning,3,60,15000),0);await drain(c);assert.equal(sockets.size,0);}
 assert.equal(events.filter(e=>e[0]===9).length,3);assert.ok(events.filter(e=>e[0]===9).every(e=>e[1]===3));for(const p of [host,key,morning])c._free(p);
});
test('cancel a pending nonblocking connect without waiting for its network timeout',async()=>{
 const {core:c,sockets}=await runtime(115),host=bytes(c,Buffer.from('192.168.1.22')),key=bytes(c,new Uint8Array(16));
 assert.equal(c._cc_connect(host,1,key,key,3,60,15000),0);c._cc_tick(5);assert.equal(c._cc_mode(),2);c._cc_stop();await drain(c);assert.equal(sockets.size,0);
});
test('registration cancellation joins the upstream registration worker and closes its socket',async()=>{
 const {core:c,sockets}=await runtime(),host=bytes(c,Buffer.from('192.168.1.22')),id=bytes(c,new Uint8Array(8));
 assert.equal(c._cc_register(host,1000100,id,12345678),0);c._cc_tick(5);c._cc_stop();await drain(c);assert.equal(sockets.size,0);
});
test('C FEC ABI forwards the real upstream shard layouts through the JS implementation',async()=>{
 const fec=load(['app/src/fec.js']).CivChiakiFec.create(null),c=await Core({chiakiPlatform:{fec,randomFill:a=>crypto.randomFillSync(a)}});
 for(const f of fixtures()){
  for(const e of f.erasures)f.data.fill(0x42,e*f.stride,e*f.stride+f.unit);
  const p=bytes(c,f.data),e=c._malloc(f.erasures.length*4);new Uint32Array(c.HEAPU8.buffer,e,f.erasures.length).set(f.erasures);
  assert.equal(c._chiaki_fec_decode(p,f.unit,f.stride,f.k,f.m,e,f.erasures.length),0);
  for(let i=0;i<f.k;i++)assert.deepEqual(Buffer.from(c.HEAPU8.subarray(p+i*f.stride,p+i*f.stride+f.unit)),f.raw.subarray(i*f.unit,(i+1)*f.unit));c._free(p);c._free(e);
 }
});
test('core rejects invalid stream profiles before opening sockets',async()=>{
 const {core:c,sockets}=await runtime(),host=bytes(c,Buffer.from('192.168.1.22')),key=bytes(c,new Uint8Array(16));assert.notEqual(c._cc_connect(host,1,key,key,5,60,15000),0);assert.notEqual(c._cc_connect(host,1,key,key,3,120,15000),0);assert.equal(sockets.size,0);
});
