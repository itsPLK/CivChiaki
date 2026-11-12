/* Resolve the SDK ABI used by the Moonlight media/input adapters. */
(function(g){
 "use strict";
 var available=typeof sdk_base!=="undefined"&&typeof call_rop==="function";
 function create(){
  if(!available)throw Error("Launch Chiaki from CivHomebrew on the console.");
  var cache={},mod=sdk_base+read32(sdk_base+4n);
  if(read32(mod)!==0x30444f4dn)throw Error("Unsupported SDK module");
  var dynamic=mod+BigInt.asIntN(32,read32(mod+4n)),tags={};
  for(var i=0;i<128;i++){var tag=Number(read64(dynamic+BigInt(i*16)));if(!tag)break;var value=read64(dynamic+BigInt(i*16+8));tags[tag]=value<sdk_base?sdk_base+value:value;}
  var table=tags[4],strings=tags[5],symbols=tags[6];if(!table||!strings||!symbols)throw Error("SDK export table unavailable");
  var buckets=Number(read32(table)),count=Number(read32(table+4n));
  if(buckets<1||buckets>1000000||count<1||count>1000000)throw Error("Invalid SDK export bounds");
  function resolve(name){
   if(cache[name])return cache[name];var hash=0;
   for(var j=0;j<name.length;j++){hash=((hash<<4)+name.charCodeAt(j))>>>0;var high=hash&0xf0000000;if(high)hash^=high>>>24;hash=(hash&~high)>>>0;}
   var index=Number(read32(table+8n+BigInt((hash%buckets)*4)));
   for(var k=0;index&&k<count;k++){
    if(index>=count)throw Error("Invalid SDK symbol chain");
    var symbol=symbols+BigInt(index*24),p=strings+read32(symbol),text="";
    for(var n=0;n<512;n++){var c=Number(read8(p+BigInt(n)));if(!c)break;text+=String.fromCharCode(c);}
    if(text===name){var offset=read64(symbol+8n);if(offset)return cache[name]=sdk_base+offset;break;}
    index=Number(read32(table+8n+BigInt((buckets+index)*4)));
   }throw Error("Missing SDK export: "+name);
  }
  return {resolveNativeSymbol:resolve};
 }
 function storage(transport){
  transport=transport||create();var ROOT="save:/civhomebrew/data/chiaki";
  function resolve(name){return transport.resolveNativeSymbol("_ZN2nn2fs"+name);}
  function call(name,args){return call_rop.apply(null,[resolve(name)].concat((args||[]).map(BigInt)));}
  function code(value){return Number(value&0x3fffffn);}
  function checked(name,args){var result=call(name,args);if(code(result))throw Error("Chiaki storage error 0x"+code(result).toString(16));}
  function file(path){if(path!==ROOT+"/state-0.json"&&path!==ROOT+"/state-1.json")throw Error("Refusing a path outside Chiaki state files");}
  function take(owned,n){var p=malloc(n);if(!p)throw Error("Chiaki save allocation failed");owned.push(p);return p;}
  function pathBuffer(owned,path){var p=alloc_string(path);if(!p)throw Error("Chiaki path allocation failed");owned.push(p);return p;}
  return {
   read:async function(path,limit){
    file(path);if(!Number.isInteger(limit)||limit<1||limit>65536)throw Error("Invalid Chiaki read limit");
    var owned=[],opened=false,handle;
    try{
     var p=pathBuffer(owned,path);handle=take(owned,8);var size=take(owned,8),r=code(call("8OpenFileEPNS0_10FileHandleEPKci",[handle,p,1]));
     if(r===0x202)return null;if(r)throw Error("Chiaki save open failed: 0x"+r.toString(16));opened=true;
     checked("11GetFileSizeEPlNS0_10FileHandleE",[size,read64(handle)]);var n=Number(read64(size));
     if(!Number.isSafeInteger(n)||n<0||n>limit)throw Error("Chiaki state file exceeds its limit");if(!n)return "";
     var buffer=take(owned,n);checked("8ReadFileENS0_10FileHandleElPvm",[read64(handle),0,buffer,n]);
     var bytes=read_buffer(buffer,n),text="";for(var i=0;i<bytes.length;i++)text+=String.fromCharCode(Number(bytes[i]));return decodeURIComponent(escape(text));
    }finally{try{if(opened)call("9CloseFileENS0_10FileHandleE",[read64(handle)]);}finally{owned.reverse().forEach(free);}}
   },
   write:async function(path,text){
    file(path);if(typeof text!=="string")throw Error("Expected Chiaki state text");var encoded=unescape(encodeURIComponent(text));if(encoded.length>65536)throw Error("Chiaki state file exceeds its limit");
    var bytes=new Uint8Array(encoded.length);for(var i=0;i<bytes.length;i++)bytes[i]=encoded.charCodeAt(i);
    var owned=[],opened=false,handle;
    try{
     var p=pathBuffer(owned,path),r=code(call("10CreateFileEPKcl",[p,bytes.length]));if(r&&r!==0x402)throw Error("Chiaki save create failed: 0x"+r.toString(16));
     handle=take(owned,8);var option=take(owned,8),buffer=take(owned,Math.max(1,bytes.length));
     checked("8OpenFileEPNS0_10FileHandleEPKci",[handle,p,6]);opened=true;checked("11SetFileSizeENS0_10FileHandleEl",[read64(handle),bytes.length]);write32(option,1n);write_buffer(buffer,bytes);
     checked("9WriteFileENS0_10FileHandleElPKvmRKNS0_11WriteOptionE",[read64(handle),0,buffer,bytes.length,option]);
    }finally{try{if(opened)call("9CloseFileENS0_10FileHandleE",[read64(handle)]);}finally{owned.reverse().forEach(free);}}
   },
   ensureDirectory:async function(path){
    if(path!=="save:/civhomebrew/data"&&path!==ROOT)throw Error("Refusing a directory outside Chiaki data");
    var p=alloc_string(path);try{var r=code(call("15CreateDirectoryEPKc",[p]));if(r&&r!==0x402)throw Error("Chiaki directory create failed: 0x"+r.toString(16));}finally{free(p);}
   },
   commit:async function(){var p=alloc_string("save");try{checked("6CommitEPKc",[p]);}finally{free(p);}}
  };
 }
 g.CivChiakiNative={available:available,create:create,storage:storage};
 // The retained Moonlight adapters depend on this public entry point.
 g.MoonlightNative=g.CivChiakiNative;
})(typeof window!=="undefined"?window:globalThis);
