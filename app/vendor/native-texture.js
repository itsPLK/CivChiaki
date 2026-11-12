/* Civ VII 1.0.0: owned RGBA texture presented through its live-image provider. */
(function(global){
 "use strict";
 var lookup=global.__moonlightTextureColorLookup||null,preparing=null;
 function validateNV12(heap,pointer,length,width,height,fields,rgba){
  function integer(n){return Number.isSafeInteger(n)&&n>=0;}
  if(!integer(pointer)||!integer(length)||pointer+length>heap.length||!integer(width)||!integer(height)||width<1||height<1||width>640||height>360||rgba.length<width*height)
   throw Error("Invalid native frame dimensions or bounds");
  var ys=fields.yStride,us=fields.uvStride,yo=fields.yOffset,uo=fields.uvOffset;
  if(![ys,us,yo,uo].every(integer)||ys<width||us<Math.ceil(width/2)*2||yo+(height-1)*ys+width>length||uo+(Math.ceil(height/2)-1)*us+Math.ceil(width/2)*2>length)
   throw Error("NV12 planes exceed decoded frame bounds");
 }
 function convertNV12(heap,pointer,length,width,height,fields,rgba){
  validateNV12(heap,pointer,length,width,height,fields,rgba);
  var ys=fields.yStride,us=fields.uvStride,yo=fields.yOffset,uo=fields.uvOffset;
  var out=0;
  for(var y=0;y<height;y++){
   var yp=pointer+yo+y*ys,uvp=pointer+uo+(y>>1)*us;
   for(var x=0;x<width;x++){
    var c=Math.max(0,heap[yp+x]-16),uv=uvp+(x&~1),d=heap[uv]-128,e=heap[uv+1]-128;
    var r=(298*c+409*e+128)>>8,g=(298*c-100*d-208*e+128)>>8,b=(298*c+516*d+128)>>8;
    r=r<0?0:r>255?255:r;g=g<0?0:g>255?255:g;b=b<0?0:b>255?255:b;
    rgba[out++]=(0xff000000|(b<<16)|(g<<8)|r)>>>0;
   }
  }
 }
 function prepare(){
  if(lookup)return Promise.resolve();if(preparing)return preparing;
  // Preserve all luma levels and six bits per chroma channel. This 4 MiB RAM
  // table avoids per-pixel multiplication/clamping in the jitless runtime.
  preparing=(async function(){
   var table=new Uint32Array(1<<20);
   for(var first=0;first<256;first+=4){
    for(var y=first;y<first+4;y++)for(var u=0;u<64;u++)for(var v=0;v<64;v++){
     var c=Math.max(0,y-16),d=(u===32?128:u*4+2)-128,e=(v===32?128:v*4+2)-128;
     var r=(298*c+409*e+128)>>8,g=(298*c-100*d-208*e+128)>>8,b=(298*c+516*d+128)>>8;
     r=r<0?0:r>255?255:r;g=g<0?0:g>255?255:g;b=b<0?0:b>255?255:b;
     table[(y<<12)|(u<<6)|v]=(0xff000000|(b<<16)|(g<<8)|r)>>>0;
    }
    await new Promise(function(resolve){setTimeout(resolve,0);});
   }
   lookup=table;global.__moonlightTextureColorLookup=table;
  })().catch(function(error){preparing=null;throw error;});return preparing;
 }
 function convertFast(heap,pointer,length,width,height,fields,rgba){
  if(!lookup)throw Error("Native texture colors are not prepared");
  validateNV12(heap,pointer,length,width,height,fields,rgba);
  var out=0;
  for(var y=0;y<height;y++){
   var yp=pointer+fields.yOffset+y*fields.yStride,uv=pointer+fields.uvOffset+(y>>1)*fields.uvStride;
   for(var x=0;x<width;x+=2){
    var chroma=((heap[uv+x]>>2)<<6)|(heap[uv+x+1]>>2);
    rgba[out++]=lookup[(heap[yp+x]<<12)|chroma];
    if(x+1<width)rgba[out++]=lookup[(heap[yp+x+1]<<12)|chroma];
   }
  }
 }
 function create(io,core,width,height,options){
  var gpu=!!(options&&options.gpu);
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>(gpu?1920:640)||height>(gpu?1080:360))throw Error("Unsupported native texture dimensions");
  if(global.__moonlightNativeTextureOwner)throw Error("A native stream texture is already active");
  if(!gpu&&!lookup)throw Error("Prepare native texture colors before starting a stream");
  var allocations=[],handle=0n,provider=0n,published=false,closed=false,rgbaHeap=0,frames=0,uploadMs=0,maxUploadMs=0;
  var byteLength=width*height*4,info=0n,page=0n,pixels=0n,description=0n,name=0n;
  var sequence=(global.__moonlightNativeTextureSequence||0)+1;global.__moonlightNativeTextureSequence=sequence;
  var imageName="moonlight-experiment/"+sequence,url="live:/"+imageName,owner={};
  function alloc(n){var p=malloc(n);if(!p)throw Error("Native texture allocation failed");allocations.push(p);return p;}
  function invoke(offset,args){return call_rop.apply(null,[main_base+offset].concat(args));}
  function range(p,n,permissions){
   if(call_rop(sdk_base+0x168b0cn,info,page,p)&0x3fffffn)throw Error("Native texture memory query failed");
   var base=read64(info),end=base+read64(info+8n);
   if((Number(read32(info+24n))&permissions)!==permissions||p<base||p+BigInt(n)>end)throw Error("Native texture memory range rejected");
  }
  function pointer(p){range(p,8,1);return read64(p);}
  function close(){
   if(closed)return;closed=true;
   // Gameface owns its own reference after ReceiveUserImage. Its normal cache
   // release and Civ VII's deferred renderer deletion keep in-flight draws valid.
   if(published){invoke(0x4bc160n,[provider,name]);published=false;}
   if(handle){invoke(0x7817c0n,[handle]);handle=0n;}
   if(rgbaHeap){core._free(rgbaHeap);rgbaHeap=0;}
   for(var p of allocations.reverse())free(p);allocations=[];
   if(global.__moonlightNativeTextureOwner===owner)delete global.__moonlightNativeTextureOwner;
  }
  try{
   info=alloc(64);page=alloc(8);
   if(read32(sdk_base+0x168b10n)!==0xd40000c1n)throw Error("Unsupported memory query ABI");
   for(var signature of [[0x771750n,0xa9ba7bfdn],[0x7817c0n,0xd10103ffn],[0x4bbb90n,0xd101c3ffn],[0x4bc160n,0xd10183ffn],[0x771100n,0x72003c1fn],[0x7716d0n,0x90023249n],[0x4bc7a0n,0xa9bd7bfdn],[0x4bc570n,0xa9bc7bfdn]]){
    range(main_base+signature[0],8,5);
    if(read32(main_base+signature[0])!==signature[1])throw Error("Unsupported Civ VII native texture build");
   }
   provider=pointer(main_base+0x5e7bba0n+0x180n);range(provider,64,3);
   name=alloc(128);write_string(name,imageName);
   if(invoke(0x4bca00n,[provider,name])&0xffffn)throw Error("Native stream image name is already registered");
   pixels=alloc(byteLength);description=alloc(0x448);
   write32(description,28n);write32(description+4n,0n);write32(description+8n,1n);
   write32(description+0x10n,BigInt(width));write32(description+0x14n,BigInt(height));write32(description+0x18n,1n);write64(description+0x20n,pixels);
   if(!gpu){rgbaHeap=core._malloc(byteLength);if(!rgbaHeap)throw Error("RGBA presentation allocation failed");}
   global.__moonlightNativeTextureOwner=owner;
  }catch(error){close();throw error;}
  function ensureTexture(){
   if(!handle){
    handle=invoke(0x771750n,[description,name,1n,0x4an,0n])&0xffffn;
    if(handle<22n){handle=0n;throw Error("Native renderer rejected the stream texture");}
    var metadata=invoke(0x771100n,[handle]);range(metadata,64,1);
    if(read32(metadata+4n)!==BigInt(width)||read16(metadata+8n)!==BigInt(height)||read32(metadata+0x20n)!==28n)throw Error("Native stream texture metadata mismatch");
   }
  }
  function publish(){
   if(!published){invoke(0x4bbb90n,[provider,handle,name]);published=true;if(!invoke(0x4bc7a0n,[provider,handle]))throw Error("Cannot enable dynamic stream texture");}
   invoke(0x4bc570n,[provider,handle]);
  }
  function present(heap,pointer,length,fields){
   if(closed||gpu)throw Error("CPU stream texture is unavailable");
   var begin=Date.now(),existing=!!handle;
   convertFast(heap,pointer,length,width,height,fields,new Uint32Array(core.HEAPU8.buffer,rgbaHeap,width*height));
   io.toNative(core.HEAPU8,rgbaHeap,byteLength,pixels);
   ensureTexture();
   if(existing&&!invoke(0x7716d0n,[handle,description,name,0n,0x4an,0n]))throw Error("Native texture update failed");
   publish();
   var elapsed=Date.now()-begin;frames++;uploadMs+=elapsed;maxUploadMs=Math.max(maxUploadMs,elapsed);return url;
  }
  function target(){
   if(closed||!gpu)throw Error("GPU stream texture is unavailable");
   range(main_base+0x781a10n,8,5);if(read32(main_base+0x781a10n)!==0x92403c08n)throw Error("Unsupported native texture pointer getter");
   ensureTexture();var texture=invoke(0x781a10n,[handle]);range(texture,216,3);
   var device=pointer(pointer(main_base+0x4db9ed8n));range(device,8,1);
   return {texture:texture,device:device};
  }
  function presentNative(){
   if(closed||!gpu||!handle)throw Error("GPU stream texture is unavailable");
   // The caller must complete its synchronous transfer or observe its GPU fence
   // before publishing. The texture handle stays unchanged.
   publish();frames++;return url;
  }
  return {present:present,target:target,presentNative:presentNative,close:close,stats:function(){return {textureFrames:frames,textureUploadMs:uploadMs,maxTextureUploadMs:maxUploadMs};}};
 }
 global.MoonlightNativeTexture={create:create,prepare:prepare,convertNV12:convertNV12,convertFast:convertFast};
})(window);
