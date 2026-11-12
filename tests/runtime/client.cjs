const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const Core=require('../../dist/runtime/chiaki-core.js');const {load}=require('../helpers.cjs');
const g=load(['app/vendor/forge-aes.js','app/src/crypto.js','app/src/store.js','app/src/fec.js','app/src/h264.js','app/src/client.js']);
const host={address:'192.168.1.133',target:1000100,name:'PS5',key:Buffer.from('1234abcd\0\0\0\0\0\0\0\0').toString('hex'),morning:'11'.repeat(16),mac:'ff'.repeat(6)};
async function setup(connectError=111,options={}){
 let pointer=20,core,platform,neutralCalls=[],input=null,mediaClosed=0,resumed=0;
 const media={videoSetup:()=>0,videoFrame:()=>0,audioSetup(){throw Error('test audio device unavailable');},close:()=>{mediaClosed++;},drainAudio(){},drainVideo(){},finishVideo(){},stats:()=>({})};
 const client=await g.CivChiakiClient.create({transport:{},worker:false,io:{randomFill:a=>crypto.randomFillSync(a),close(){},resume(){resumed++;},interrupt(){},io(op,args){if(op===1)return pointer++;if([2,7,9,10,11].includes(op))return 0;if(op===3)return -connectError;return -11;}},
  factory:async options=>{platform=options.chiakiPlatform;core=await Core(options);const original=core._cc_controller;core._cc_controller=(...args)=>{neutralCalls.push(args);return original(...args);};return core;},
  controller:{poll:()=>input,stopRumble(){},close(){}},mediaFactory:()=>media,...options});
 return {client,get core(){return core;},get platform(){return platform;},set input(v){input=v;},get calls(){return neutralCalls;},get mediaClosed(){return mediaClosed;},get resumed(){return resumed;}};
}
test('client handles repeated refused connections without retaining native media or interruption state',async()=>{
 const s=await setup();for(let i=0;i<3;i++){s.client.connect(host,{resolution:3,fps:60,bitrate:15000});const deadline=Date.now()+2000;while(s.client.state().mode){s.client.tick();await new Promise(r=>setTimeout(r,2));assert.ok(Date.now()<deadline);}await s.client.stop();assert.equal(s.core._cc_runtime_tasks(),0);}
 assert.equal(s.mediaClosed,3);assert.equal(s.resumed,3);assert.equal(s.client.state().host,null);await s.client.close();
});
test('controller positions become PlayStation buttons and vertical stick directions',async()=>{
 const s=await setup();s.client.connect(host,{resolution:3,fps:60,bitrate:15000});s.input={state:[0x1000|0x10|1,255,128,1000,2000,-3000,-4000],exit:false};s.client.tick();assert.deepEqual(s.calls[0],[1|4096|64,255,128,1000,-2000,-3000,4000]);await s.client.close();
});
test('media callback exceptions are queued and cannot unwind upstream C fibers',async()=>{
 const s=await setup();s.client.connect(host,{resolution:3,fps:60,bitrate:15000});assert.doesNotThrow(()=>s.platform.audioHeader(44100,2,960));assert.ok(s.client.events().some(e=>e.type==='error'&&e.data.includes('audio device unavailable')));await s.client.close();assert.equal(s.core._cc_runtime_tasks(),0);
});
test('account ID is canonical eight-byte Base64 and the displayed PSN name is rejected',()=>{
 assert.equal(g.CivChiakiClient.account('AQIDBAUGBwg=').length,8);assert.throws(()=>g.CivChiakiClient.account('MyPSNName'));assert.throws(()=>g.CivChiakiClient.account('AQIDBAUGBwh='));
});
test('account ID decoding works without browser atob/btoa in Gameface',()=>{
 const scope=load(['app/src/client.js'],{atob:undefined,btoa:undefined});assert.deepEqual(Array.from(scope.CivChiakiClient.account('AQIDBAUGBwg=')),[1,2,3,4,5,6,7,8]);
});
test('PS/touchpad menu buttons remain held across feedback dispatch before releasing',async()=>{
 const s=await setup(115);s.client.connect(host,{resolution:3,fps:60,bitrate:15000});s.input={state:[0,0,0,0,0,0,0],exit:false};s.client.pause();s.client.button(1<<15);s.client.resume();s.client.tick();assert.equal(s.calls.at(-1)[0],1<<15);await new Promise(r=>setTimeout(r,110));s.client.tick();assert.equal(s.calls.at(-1)[0],0);await s.client.close();
});

test('stop clears the live image and waits for renderer frames before releasing media',async()=>{
 const steps=[],s=await setup(115,{onImage:url=>steps.push(url===null?'image-cleared':'image'),onStage:async name=>{if(name==='media-close-begin')steps.push('media-close');}});
 s.client.connect(host,{resolution:3,fps:30,bitrate:8000});s.client.tick();await s.client.stop();assert.deepEqual(steps,['image-cleared','media-close']);assert.equal(s.mediaClosed,1);await s.client.close();assert.equal(s.mediaClosed,1);
});
test('client defaults to the owned binary worker and loads its three-argument handler',async()=>{
 const previous=g.CivChiakiWorker;let opened=0,released=0,source;
 const worker={submitBinary(){},load:async(s,config)=>{source=s;assert.equal(config.bytes,4194304);},release:async()=>{released++;},stats:()=>({binary:true})};
 g.CivChiakiWorker={open(){opened++;return worker;}};
 try{const s=await setup(111,{worker:undefined});assert.equal(opened,1);const isolated=load([]);require('node:vm').runInContext(source,isolated);assert.equal(isolated.civStep.length,3);assert.equal(s.client.state().worker.binary,true);await s.client.close();assert.equal(released,1);}finally{g.CivChiakiWorker=previous;}
});

 test('client installs the cache on the C platform and supports disabling it for comparison',async()=>{
  const a=await setup(),b=await setup(111,{keyStreamCache:false});
  try{assert.equal(a.platform.crypto.stats().keyStreamHits,0);assert.equal(a.client.state().crypto.keyStreamMisses,0);assert.equal(b.platform.crypto.stats().keyStreamHits,undefined);}
  finally{await a.client.close();await b.client.close();}
 });
