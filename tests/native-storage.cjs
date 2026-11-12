const test=require('node:test'),assert=require('node:assert/strict');const {load}=require('./helpers.cjs');
function environment(){
 const memory=Buffer.alloc(1024*1024),owned=new Set(),files=new Map(),handles=new Map(),calls=[];let cursor=16,nextHandle=1n;
 function alloc(n){const p=BigInt(cursor);cursor+=Math.ceil(n/8)*8+8;owned.add(p);return p;}
 function text(p){let n=Number(p),end=n;while(memory[end])end++;return memory.subarray(n,end).toString('utf8');}
 const g=load(['app/src/native.js'],{malloc:alloc,free:p=>assert.ok(owned.delete(p)),alloc_string:s=>{const b=Buffer.from(s+'\0');const p=alloc(b.length);memory.set(b,Number(p));return p;},read64:p=>memory.readBigUInt64LE(Number(p)),write32:(p,n)=>memory.writeUInt32LE(Number(n),Number(p)),write_buffer:(p,b)=>memory.set(b,Number(p)),read_buffer:(p,n)=>memory.subarray(Number(p),Number(p)+n),
 call_rop:(name,...a)=>{
  calls.push(name);
  if(name.includes('OpenFile')){const path=text(a[1]);if(!files.has(path))return 0x202n;const h=nextHandle++;handles.set(h,path);memory.writeBigUInt64LE(h,Number(a[0]));return 0n;}
  if(name.includes('CloseFile')){handles.delete(a[0]);return 0n;}
  if(name.includes('GetFileSize')){memory.writeBigUInt64LE(BigInt(files.get(handles.get(a[1])).length),Number(a[0]));return 0n;}
  if(name.includes('ReadFile')){memory.set(files.get(handles.get(a[0])).subarray(Number(a[1]),Number(a[1]+a[3])),Number(a[2]));return 0n;}
  if(name.includes('CreateFile')){const path=text(a[0]);if(files.has(path))return 0x402n;files.set(path,Buffer.alloc(Number(a[1])));return 0n;}
  if(name.includes('SetFileSize')){files.set(handles.get(a[0]),Buffer.alloc(Number(a[1])));return 0n;}
  if(name.includes('WriteFile')){files.get(handles.get(a[0])).set(memory.subarray(Number(a[2]),Number(a[2]+a[3])),Number(a[1]));return 0n;}
  if(name.includes('CreateDirectory')||name.includes('Commit'))return 0n;
  throw Error(name);
 }});
 return {io:g.CivChiakiNative.storage({resolveNativeSymbol:n=>n}),owned,files,handles,calls};
}
test('app-owned native storage roundtrips UTF-8 and releases handles and allocations',async()=>{
 const e=environment(),path='save:/civhomebrew/data/chiaki/state-1.json';assert.equal(await e.io.read(path,65536),null);await e.io.ensureDirectory('save:/civhomebrew/data');await e.io.ensureDirectory('save:/civhomebrew/data/chiaki');const text=JSON.stringify({name:'PS5 寝室 🎮'});await e.io.write(path,text);await e.io.commit();assert.equal(await e.io.read(path,65536),text);assert.equal(e.owned.size,0);assert.equal(e.handles.size,0);
});
test('native storage rejects launcher/game paths before touching the SDK',async()=>{
 const e=environment();for(const p of ['save:/','save:/civhomebrew/catalog-0.json','save:/civhomebrew/data/chiaki/../other','save:/civhomebrew/apps/other/manifest.json']){await assert.rejects(e.io.read(p,65536));await assert.rejects(e.io.write(p,'{}'));await assert.rejects(e.io.ensureDirectory(p));}assert.equal(e.calls.length,0);
});
test('oversized native files close their handle and free temporary buffers',async()=>{
 const e=environment(),path='save:/civhomebrew/data/chiaki/state-0.json';e.files.set(path,Buffer.alloc(65537));await assert.rejects(e.io.read(path,65536),/limit/);assert.equal(e.owned.size,0);assert.equal(e.handles.size,0);
});
