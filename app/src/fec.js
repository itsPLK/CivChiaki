/* Cauchy Reed-Solomon over GF(2^8), matching Chiaki/Jerasure's original matrix.
 * Self-contained so the same implementation runs in the worker isolate.
 */
(function(g){
 "use strict";
 function createKernel(){
  var exp=new Uint8Array(512),log=new Uint8Array(256),v=1;
  for(var i=0;i<255;i++){exp[i]=v;log[v]=i;v<<=1;if(v&256)v^=0x11d;}
  for(var i=255;i<512;i++)exp[i]=exp[i-255];
  function mul(a,b){return a&&b?exp[log[a]+log[b]]:0;}
  // One 64 KiB product table (row c<<8) instead of rebuilding a 256-entry row
  // per add(): no per-job ArrayBuffers (each was an extension node in the
  // retained worker isolate) and no 255 multiplications before every row.
  var product=new Uint8Array(65536);for(var a=1;a<256;a++)for(var b=1;b<256;b++)product[(a<<8)|b]=mul(a,b);
  var scratch=new Uint8Array(0);
  function reserve(bytes){if(scratch.length<bytes)scratch=new Uint8Array(Math.max(bytes,scratch.length*2));return scratch;}
  function inv(a){if(!a)throw Error("Singular FEC matrix");return exp[255-log[a]];}
  function coefficient(row,col,m){return inv(row^(m+col));}
  function check(data,unit,stride,k,m,erasures){
   if(!Number.isInteger(k)||k<1||!Number.isInteger(m)||m<0||k+m>256||!Number.isInteger(unit)||unit<1||unit>65536||!Number.isInteger(stride)||stride<unit||stride>65536||stride*(k+m)>data.length)throw Error("Invalid FEC geometry");
   if(erasures.length>m||new Set(erasures).size!==erasures.length||erasures.some(function(e){return !Number.isInteger(e)||e<0||e>=k+m;}))throw Error("Invalid FEC erasures");
  }
  function add(target,source,c,unit){
   if(c===0)return;
   if(c===1){for(var b=0;b<unit;b++)target[b]^=source[b];return;}
   var base=c<<8;
   for(var b=0;b<unit;b++)target[b]^=product[base|source[b]];
  }
  function decode(data,unit,stride,k,m,erasures){
   check(data,unit,stride,k,m,erasures);
   var gone=new Set(erasures),missing=erasures.filter(function(i){return i<k;}),n=missing.length;
   if(!n)return data;
   var parity=[];for(var i=0;i<m&&parity.length<n;i++)if(!gone.has(k+i))parity.push(i);
   if(parity.length<n)throw Error("Insufficient FEC shards");
   // Views into one reusable buffer: n parity rows, then the n x 2n matrix.
   var work=reserve(n*unit+n*n*2),matrix=[],rhs=[];work.fill(0,0,n*unit+n*n*2);
   for(var r=0;r<n;r++){
    var row=work.subarray(n*unit+r*n*2,n*unit+(r+1)*n*2);for(var c=0;c<n;c++)row[c]=coefficient(parity[r],missing[c],m);row[n+r]=1;matrix.push(row);
    var value=work.subarray(r*unit,(r+1)*unit);value.set(data.subarray((k+parity[r])*stride,(k+parity[r])*stride+unit));
    for(var c=0;c<k;c++)if(!gone.has(c))add(value,data.subarray(c*stride,c*stride+unit),coefficient(parity[r],c,m),unit);
    rhs.push(value);
   }
   for(var col=0;col<n;col++){
    var pivot=col;while(pivot<n&&!matrix[pivot][col])pivot++;if(pivot===n)throw Error("Singular FEC matrix");
    var tmp=matrix[col];matrix[col]=matrix[pivot];matrix[pivot]=tmp;
    var scale=inv(matrix[col][col]);for(var c=0;c<n*2;c++)matrix[col][c]=mul(matrix[col][c],scale);
    for(var r=0;r<n;r++)if(r!==col){var scale=matrix[r][col];for(var c=0;c<n*2;c++)matrix[r][c]^=mul(scale,matrix[col][c]);}
   }
   for(var r=0;r<n;r++){
    var target=data.subarray(missing[r]*stride,missing[r]*stride+unit);target.fill(0);
    for(var c=0;c<n;c++)add(target,rhs[c],matrix[r][n+c],unit);
   }return data;
  }
  function encode(data,unit,stride,k,m){
   check(data,unit,stride,k,m,[]);
   for(var r=0;r<m;r++){var target=data.subarray((k+r)*stride,(k+r)*stride+unit);target.fill(0);for(var c=0;c<k;c++)add(target,data.subarray(c*stride,c*stride+unit),coefficient(r,c,m),unit);}
   return data;
  }
  return {decode:decode,encode:encode};
 }
 function workerProgram(){
  var kernel=createKernel(),frame=null,written=0;
  function civStep(input,out){
   if(input.op==="reset"){
    if(!Number.isInteger(input.bytes)||input.bytes<1||input.bytes>out.length)throw Error("Invalid FEC staging size");
    frame=new Uint8Array(input.bytes);written=0;
   }else if(input.op==="write"){
    if(!frame||input.offset!==written||!Array.isArray(input.data)||written+input.data.length>frame.length)throw Error("FEC staging order mismatch");
    frame.set(input.data,written);written+=input.data.length;
   }else if(input.op==="run"){
    if(!frame||written!==frame.length)throw Error("FEC staging incomplete");
    if(input.encode)kernel.encode(frame,input.unit,input.stride,input.k,input.m);
    else kernel.decode(frame,input.unit,input.stride,input.k,input.m,input.erasures);
    out.set(frame);frame=null;written=0;
   }else throw Error("Unknown FEC operation");
  }
  return civStep;
 }
 function binaryWorkerProgram(){
  var kernel=createKernel();
  return function civStep(input,out,data){
   if(input.op!=="run"||data.length!==input.stride*(input.k+input.m))throw Error("FEC binary geometry mismatch");
   if(input.encode)kernel.encode(data,input.unit,input.stride,input.k,input.m);
   else kernel.decode(data,input.unit,input.stride,input.k,input.m,input.erasures);
   return data.length;
  };
 }
 function source(binary){return 'var createKernel='+createKernel.toString()+';var civStep=('+(binary?binaryWorkerProgram:workerProgram).toString()+')();';}

 function create(worker,options){
  options=options||{};var kernel=createKernel(),job=null,closed=false,stats={worker:!!worker,binary:!!(worker&&worker.submitBinary),jobs:0,failures:0,bytes:0,stageMs:0,totalMs:0,maxMs:0};
  function now(){return g.MoonlightTelemetry?g.MoonlightTelemetry.now():Date.now();}
  return {
   begin:function(core,pointer,unit,stride,k,m,erasures,encode){
    if(closed||job)return -1;
    var size=stride*(k+m);if(size<1||size>4194304||pointer<0||pointer+size>core.HEAPU8.length)return -1;
    var started=now();stats.bytes+=size;
    try{
     if(!worker){var data=core.HEAPU8.subarray(pointer,pointer+size);if(encode)kernel.encode(data,unit,stride,k,m);else kernel.decode(data,unit,stride,k,m,erasures);stats.jobs++;var elapsed=now()-started;stats.totalMs+=elapsed;stats.maxMs=Math.max(stats.maxMs,elapsed);return 0;}
     if(size>worker.bytes)return -1;
     if(worker.submitBinary){worker.submitBinary({op:"run",unit:unit,stride:stride,k:k,m:m,erasures:erasures,encode:encode},core.HEAPU8.subarray(pointer,pointer+size));}
     else{
     worker.step({op:"reset",bytes:size});
     // Maximum 16,000 byte numbers serialize below the 64 KiB step limit.
     for(var offset=0;offset<size;offset+=16000)worker.step({op:"write",offset:offset,data:Array.from(core.HEAPU8.subarray(pointer+offset,pointer+Math.min(size,offset+16000)))});
     worker.submit({op:"run",unit:unit,stride:stride,k:k,m:m,erasures:erasures,encode:encode});
     }
     stats.stageMs+=now()-started;job={pointer:pointer,size:size,started:started};stats.jobs++;return 1;
    }catch(error){stats.failures++;if(options.onError)options.onError(error);return -1;}
   },
   poll:function(core){
    if(!job)return -1;
    try{var result=worker.poll({timeoutMs:2000,waitMs:0});if(!result)return 1;var pending=job;job=null;if(result.error)throw Error(result.error);if(result.data.length<pending.size)throw Error("Truncated FEC binary result");core.HEAPU8.set(result.data.subarray(0,pending.size),pending.pointer);var elapsed=now()-pending.started;stats.totalMs+=elapsed;stats.maxMs=Math.max(stats.maxMs,elapsed);return 0;}
    catch(error){job=null;stats.failures++;if(options.onError)options.onError(error);return -1;}
   },
   close:async function(){closed=true;if(worker)await worker.release();job=null;},
   stats:function(){return Object.assign({busy:!!job,transfer:worker&&worker.stats?worker.stats():null},stats);}
  };
 }
 g.CivChiakiFec={createKernel:createKernel,source:source,create:create};
})(typeof window!=="undefined"?window:globalThis);
