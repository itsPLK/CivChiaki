const test=require('node:test'),assert=require('node:assert/strict');const {load}=require('./helpers.cjs');
const api=load(['app/src/store.js']).CivChiakiStore;
function io(){const data=new Map();return {data,read:async p=>data.get(p)??null,write:async(p,v)=>data.set(p,v),commit:async()=>{},ensureDirectory:async p=>assert.ok(p.startsWith('save:/civhomebrew/'))};}
const host={address:'192.168.1.2',target:1000100,name:'PS5',key:'00'.repeat(16),morning:'11'.repeat(16),mac:'ff'.repeat(6)};
test('registration survives reload and settings survive console removal',async()=>{
 const disk=io(),store=api.create(disk);await store.saveHost(host);await store.saveSettings({resolution:4,fps:30,bitrate:20000});const reopened=api.create(disk);assert.equal((await reopened.load()).hosts[0].key,host.key);await reopened.removeHost(host.address);const saved=await api.create(disk).load();assert.equal(saved.hosts.length,0);assert.equal(saved.settings.bitrate,20000);
});
test('interrupted newest record falls back to previous committed record',async()=>{
 const disk=io(),store=api.create(disk);await store.saveHost(host);await store.saveSettings({resolution:4,fps:30,bitrate:20000});disk.data.set(api.root+'/state-0.json','{');const recovered=await api.create(disk).load();assert.equal(recovered.hosts.length,1);assert.equal(recovered.settings.resolution,3);
});
test('unreadable records are preserved; failed readback is reported',async()=>{
 const disk=io();disk.data.set(api.root+'/state-0.json','{}');await assert.rejects(api.create(disk).load(),/unreadable/);assert.equal(disk.data.size,1);
 const broken=io();broken.write=async()=>{};await assert.rejects(api.create(broken).saveHost(host),/verification/);
});
test('serialized mutations preserve concurrent changes; invalid host/codec settings rejected',async()=>{
 const store=api.create(io());await Promise.all([store.saveHost(host),store.saveSettings({resolution:4,fps:60,bitrate:30000})]);const v=await store.load();assert.equal(v.hosts.length,1);assert.equal(v.settings.bitrate,30000);await assert.rejects(store.saveHost({...host,address:'../apps'}));await assert.rejects(store.saveSettings({resolution:3,fps:60,bitrate:500}));
});
test('Auto bitrate follows resolution and frame rate; choices cycle; overlay flag is optional',async()=>{
 assert.equal(api.defaults.bitrate,0);assert.equal(api.defaults.overlay,false);
 assert.equal(api.bitrateFor({resolution:3,fps:30,bitrate:0}),10000);assert.equal(api.bitrateFor({resolution:3,fps:60,bitrate:0}),15000);
 assert.equal(api.bitrateFor({resolution:4,fps:60,bitrate:0}),20000);assert.equal(api.bitrateFor({resolution:1,fps:30,bitrate:0}),2000);
 assert.equal(api.bitrateFor({resolution:4,fps:60,bitrate:12000}),12000,'explicit choices are kept');
 let b=0;const seen=[];do{seen.push(b);b=api.nextBitrate(b);}while(b!==0&&seen.length<50);
 assert.deepEqual(seen,Array.from(api.bitrateChoices));assert.equal(api.nextBitrate(16000),0,'unknown saved values return to Auto');
 assert.ok(api.validSettings({resolution:4,fps:60,bitrate:0}));assert.ok(api.validSettings({resolution:4,fps:60,bitrate:0,overlay:true}));
 assert.ok(!api.validSettings({resolution:4,fps:60,bitrate:20}),'Kbps typos stay invalid');assert.ok(!api.validSettings({resolution:4,fps:60,bitrate:0,overlay:'yes'}));assert.ok(api.validSettings({resolution:4,fps:60,bitrate:0,swapButtons:true}));assert.ok(!api.validSettings({resolution:4,fps:60,bitrate:0,swapButtons:1}));
 const store=api.create(io());const saved=await store.saveSettings({resolution:4,fps:60,bitrate:0,overlay:true});assert.equal(saved.settings.overlay,true);
});
test('left/right bitrate steps clamp at Auto and 50 Mbps',()=>{
 assert.equal(api.stepBitrate(0,-1),0);assert.equal(api.stepBitrate(0,1),2000);assert.equal(api.stepBitrate(15000,-1),12000);assert.equal(api.stepBitrate(15000,1),20000);
 assert.equal(api.stepBitrate(50000,1),50000);assert.equal(api.stepBitrate(16000,1),2000,'an unknown saved value steps from Auto');
});
