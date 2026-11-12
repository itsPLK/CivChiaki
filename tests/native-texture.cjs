const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const context=vm.createContext({window:{},setTimeout});
vm.runInContext(fs.readFileSync('app/vendor/native-texture.js','utf8'),context);
const convert=context.window.MoonlightNativeTexture.convertNV12;
test('NV12 respects row strides, plane offsets, alpha and limited-range luma',()=>{
 const heap=new Uint8Array(40).fill(255),base=4;
 heap.set([16,235,99,99,81,145,99,99],base+2);
 heap.set([128,128],base+14);
 const rgba=new Uint32Array(4);
 convert(heap,base,16,2,2,{yStride:4,uvStride:2,yOffset:2,uvOffset:14},rgba);
 assert.deepEqual(Array.from(rgba),[0xff000000,0xffffffff,0xff4c4c4c,0xff969696]);
});
test('NV12 chroma conversion produces saturated red',()=>{
 const rgba=new Uint32Array(4);
 convert(Uint8Array.from([81,81,81,81,90,240]),0,6,2,2,{yStride:2,uvStride:2,yOffset:0,uvOffset:4},rgba);
 for(const pixel of rgba){assert.equal(pixel>>>24,255);assert((pixel&255)>=250);assert(((pixel>>>8)&255)<=3);assert(((pixel>>>16)&255)<=3);}
});
test('NV12 rejects truncated planes and invalid coordinates before presenting',()=>{
 const fields={yStride:2,uvStride:2,yOffset:0,uvOffset:4};
 for(const [pointer,length,f] of [[0,5,fields],[1,6,fields],[0,6,{...fields,yStride:1}],[0,6,{...fields,uvOffset:-1}],[0,6,{...fields,uvStride:1}],[0,6,{...fields,yOffset:NaN}]])
  assert.throws(()=>convert(new Uint8Array(6),pointer,length,2,2,f,new Uint32Array(4)),/bounds|planes/);
 assert.throws(()=>convert(new Uint8Array(6),0,6,2,2,fields,new Uint32Array(3)),/bounds/);
});
test('fast conversion preserves luma and bounds chroma approximation error',async()=>{
 const renderer=context.window.MoonlightNativeTexture;
 await renderer.prepare();
 const heap=new Uint8Array(6),exact=new Uint32Array(4),fast=new Uint32Array(4);
 const fields={yStride:2,uvStride:2,yOffset:0,uvOffset:4};
 for(let y=0;y<256;y+=17)for(let u=0;u<256;u+=17)for(let v=0;v<256;v+=17){
  heap.fill(y,0,4);heap[4]=u;heap[5]=v;
  convert(heap,0,6,2,2,fields,exact);renderer.convertFast(heap,0,6,2,2,fields,fast);
  for(const shift of [0,8,16])assert(Math.abs(((exact[0]>>>shift)&255)-((fast[0]>>>shift)&255))<=7);
  assert.equal(fast[0]>>>24,255);
 }
 for(const y of [16,235]){
  heap.fill(y,0,4);heap[4]=heap[5]=128;renderer.convertFast(heap,0,6,2,2,fields,fast);
  assert.equal(fast[0],y===16?0xff000000:0xffffffff);
 }
 assert.throws(()=>renderer.convertFast(heap,0,5,2,2,fields,fast),/planes/);
});

function nativeGPU(){
 const memory=new Map(),calls=[],owned=new Set();let next=0x100000n,width,height;
 const main=0x10000n,sdk=0x20000n,provider=0x30000n,metadata=0x40000n,texture=0x50000n,device=0x60000n;
 function write(p,v,n=8){for(let i=0;i<n;i++)memory.set(p+BigInt(i),Number((BigInt(v)>>BigInt(i*8))&255n));}
 function read(p,n=8){let v=0n;for(let i=n-1;i>=0;i--)v=(v<<8n)|BigInt(memory.get(p+BigInt(i))||0);return v;}
 const signatures=[[0x771750n,0xa9ba7bfdn],[0x7817c0n,0xd10103ffn],[0x4bbb90n,0xd101c3ffn],[0x4bc160n,0xd10183ffn],[0x771100n,0x72003c1fn],[0x7716d0n,0x90023249n],[0x4bc7a0n,0xa9bd7bfdn],[0x4bc570n,0xa9bc7bfdn],[0x781a10n,0x92403c08n]];
 for(const [offset,word] of signatures)write(main+offset,word,4);
 write(sdk+0x168b10n,0xd40000c1n,4);write(main+0x5e7bba0n+0x180n,provider);
 write(main+0x4db9ed8n,0x70000n);write(0x70000n,device);
 const scope=vm.createContext({window:{},setTimeout,main_base:main,sdk_base:sdk,
  malloc:n=>{const p=next;next+=BigInt(n+64);owned.add(p);return p;},free:p=>{assert(owned.delete(p),'free only owned allocation once');},
  write_string:()=>{},write64:(p,v)=>write(p,v),write32:(p,v)=>write(p,v,4),
  read64:p=>read(p),read32:p=>read(p,4),read16:p=>read(p,2),
  call_rop:(fn,...args)=>{
   if(fn===sdk+0x168b0cn){write(args[0],0n);write(args[0]+8n,1n<<40n);write(args[0]+24n,7n,4);return 0n;}
   const offset=fn-main;calls.push(offset);
   if(offset===0x4bca00n)return 0n;
   if(offset===0x771750n){width=read(args[0]+0x10n,4);height=read(args[0]+0x14n,4);return 22n;}
   if(offset===0x771100n){write(metadata+4n,width,4);write(metadata+8n,height,2);write(metadata+0x20n,28n,4);return metadata;}
   if(offset===0x781a10n)return texture;
   return 1n;
  }});
 vm.runInContext(fs.readFileSync('app/vendor/native-texture.js','utf8'),scope);
 return {renderer:scope.window.MoonlightNativeTexture,calls,owned,write,main,texture,device};
}
test('GPU presenter reuses its owned 1080p texture without JS pixel buffers or CPU uploads',()=>{
 const env=nativeGPU(),presenter=env.renderer.create({toNative(){assert.fail('GPU frames must not upload CPU pixels');}},{_malloc(){assert.fail('GPU frames must not allocate a JS RGBA buffer');}},1920,1080,{gpu:true});
 const target=presenter.target();assert.equal(target.texture,env.texture);assert.equal(target.device,env.device);
 const url=presenter.presentNative();assert.match(url,/^live:\/moonlight-experiment\//);assert.equal(presenter.presentNative(),url);
 assert.equal(env.calls.filter(x=>x===0x771750n).length,1);assert.equal(env.calls.filter(x=>x===0x7716d0n).length,0);
 assert.equal(env.calls.filter(x=>x===0x4bc570n).length,2);assert.equal(presenter.stats().textureFrames,2);
 presenter.close();presenter.close();assert.equal(env.owned.size,0);
 assert(env.calls.indexOf(0x4bc160n)<env.calls.indexOf(0x7817c0n));
 assert.throws(()=>presenter.presentNative(),/unavailable/);
});
test('GPU presenter rejects a mismatched native getter and cleans its allocations',()=>{
 const env=nativeGPU(),presenter=env.renderer.create({}, {},1280,720,{gpu:true});
 env.write(env.main+0x781a10n,0n,4);assert.throws(()=>presenter.target(),/Unsupported/);
 assert.equal(env.calls.filter(x=>x===0x771750n).length,0);presenter.close();assert.equal(env.owned.size,0);
 assert.throws(()=>env.renderer.create({}, {},1921,1080,{gpu:true}),/dimensions/);
});
