/* Existing movie/Opus/AudioOut functions; all pointers refer to owned buffers. */
(function(global){
 "use strict";
 // Keep at most two decoder slots while draining; every acquisition is released
 // exactly once, including when format lookup or presentation fails.
 function drainLatest(options){
  var held=new Set(),latest=null,failure=null;
  function release(frame){options.release(frame);held.delete(frame.index);}
  try{
   for(var attempt=0;attempt<32;attempt++){
    var frame=options.acquire();if(!frame)break;
    if(held.has(frame.index))throw Error("Decoder returned an already acquired output slot");
    held.add(frame.index);options.decoded(frame);
    if(!frame.displayable){release(frame);continue;}
    if(!latest)latest=frame;
    else if(frame.timestamp>=latest.timestamp){release(latest);latest=frame;options.superseded();}
    else{release(frame);options.superseded();}
   }
   // An asynchronous presenter can explicitly take over the selected slot.
   if(latest)options.present(latest,function(){held.delete(latest.index);});
  }catch(error){failure=error;}
  finally{held.forEach(function(index){try{options.release({index:index});}catch(error){if(!failure)failure=error;}});}
  if(failure)throw failure;
 }
 function createGpuPipeline(options){
  var pending=null,failure=null;
  function submit(frame){
   if(pending||failure)throw Error("GPU transfer already pending or failed");pending=frame;
   try{options.submit(frame);}catch(error){failure=error;throw error;}
  }
  function finish(publish){
   if(failure)throw failure;if(!pending)return false;
   var ready;try{ready=options.ready();}catch(error){failure=error;throw error;}
   if(!ready)return false;
   var frame=pending,presentationFailure=null;pending=null;
   try{if(publish!==false)options.present(frame);}catch(error){presentationFailure=error;}
   try{options.release(frame);}catch(error){failure=error;throw error;}
   if(presentationFailure)throw presentationFailure;return true;
  }
  return {submit:submit,finish:finish,pending:function(){return !!pending;},close:function(){if(!finish(false)&&pending)throw Error("GPU transfer is still pending; native media retained");}};
 }
 function finishGpu(pipeline,clock,deadline){
  if(!pipeline)return false;
  if(pipeline.finish())return true;
  if(!Number.isFinite(deadline))return false;
  // Only nonblocking fence queries. Bound both elapsed time and query count;
  // a stalled clock or GPU never turns this into an unbounded render wait.
  for(var attempt=0;attempt<32&&pipeline.pending()&&clock()<deadline;attempt++)if(pipeline.finish())return true;
  return false;
 }
 function createVideoPacer(clock,period){
  var queue=[],primed=false,firstAt=null,last=null,lastTimestamp=-Infinity;
  function releaseAll(){var first=null;while(queue.length){try{last.release(queue.shift());}catch(error){if(!first)first=error;}}if(first)throw first;}
  function discard(reason){last.release(queue.shift());last.superseded(reason);}
  return {pending:function(){return queue.length;},close:releaseAll,drain:function(options){
   last=options;
   try{
    for(var attempt=0;attempt<32;attempt++){
     var frame=options.acquire();if(!frame)break;
     if(queue.some(function(f){return f.index===frame.index;}))throw Error("Decoder returned an already retained output slot");
     queue.push(frame);frame.queuedAt=clock();options.decoded(frame);
     if(!frame.displayable){queue.pop();options.release(frame);continue;}
     if(frame.timestamp<=lastTimestamp){queue.pop();options.release(frame);options.superseded();continue;}
     queue.sort(function(a,b){return a.timestamp-b.timestamp;});
     while(queue.length>2)discard("backlog");
    }
    // Bound waiting after decode. Hardware decode latency is already paid:
    // treating it as queue age can discard every picture on a slow decoder.
    while(queue.length&&clock()-queue[0].queuedAt>period*2)discard("age");
    if(!queue.length)return;
    if(firstAt===null)firstAt=clock();
    if(!primed&&queue.length<2&&clock()-firstAt<period)return;
    primed=true;var selected=queue.shift(),owned=true;lastTimestamp=selected.timestamp;
    try{options.present(selected,function(){owned=false;});}finally{if(owned)options.release(selected);}
   }catch(error){try{releaseAll();}catch(_){}throw error;}
  }};
 }
 function create(io,core,options){
  options=options||{};var owned=[],objects=[],decoder=0n,started=false,configured=false,outputStorage=0n,outputLength=0,outputHeap=0,width=0,height=0,fields=null;
  var movie=null,audio=null,texture=null,gpu=false,frameInterval=0,lastPreview=0,videoSubmitted=0,videoDecoded=0,presented=0,conversionMs=0,maxConversionMs=0;
  var pendingFrames=new Map(),decodeSamples=0,decodeMs=0,maxDecodeMs=0,lastPresentedAt=null,intervalCount=0,intervalMs=0,intervalSquaredMs=0,maxIntervalMs=0;
  var videoSuperseded=0,videoDeferredTicks=0,videoExpired=0,videoBacklogDrops=0,audioBatchSamples=960,audioPoolSize=2;
  var gpuTransfers=0,gpuTransferMs=0,nativePublishMs=0,gpuPolls=0,gpuPendingPolls=0,gpuPollMs=0,gpuTailChecks=0,gpuTailCompleted=0,gpuTailMs=0;
  var movieBase=0n,gpuFence=null,gpuPipeline=null,gpuSubmissionAt=0,gpuCompletionSamples=0,gpuCompletionMs=0,gpuSubmitCost=0,videoPacer=null,presentAgeMs=0,presentAgeSamples=0;
  function now(){return global.MoonlightTelemetry?global.MoonlightTelemetry.now():Date.now();}
  function presentedFrame(frame){var time=now();if(frame&&frame.submittedAt!==undefined){presentAgeMs+=time-frame.submittedAt;presentAgeSamples++;}if(lastPresentedAt!==null){var delta=time-lastPresentedAt;intervalCount++;intervalMs+=delta;intervalSquaredMs+=delta*delta;maxIntervalMs=Math.max(maxIntervalMs,delta);}lastPresentedAt=time;presented++;}
  function alloc(n){var p=malloc(n);if(!p)throw Error("Native media allocation failed");owned.push(p);return p;}
  function number(v){return Number(BigInt.asIntN(32,v));}
  function sdk(name,args){return io.invoke(name,args);}
  function findMovie(){
   if(movie)return;
   var info=alloc(64),page=alloc(8);
   if(read32(sdk_base+0x168b10n)!==0xd40000c1n)throw Error("Unsupported memory query ABI");
   function query(address){if(call_rop(sdk_base+0x168b0cn,info,page,address)&0x3fffffn)return null;return {base:read64(info),size:read64(info+8n),permissions:Number(read32(info+24n))};}
   function readable(address,length){var cursor=address,end=address+BigInt(length);for(var i=0;i<32&&cursor<end;i++){var q=query(cursor);if(!q||!(q.permissions&1)||q.base+q.size<=cursor)return false;cursor=q.base+q.size;}return cursor>=end;}
   var cursor=0n;
   for(var region=0;region<512&&cursor<0x8000000000n;region++){
    var q=query(cursor);if(!q||!q.size||q.base+q.size<=cursor)break;cursor=q.base+q.size;var base=q.base;
    if((q.permissions&5)!==5||base===main_base||base===sdk_base||!readable(base,8))continue;
    var offset=read32(base+4n);if(offset<1n||offset>0x10000000n)continue;
    var mod=base+offset;if(!readable(mod,8)||read32(mod)!==0x30444f4dn)continue;
    var dynamic=mod+BigInt.asIntN(32,read32(mod+4n)),tags={};
    for(var i=0;i<128;i++){var entry=dynamic+BigInt(i*16);if(!readable(entry,16))break;var tag=Number(read64(entry));if(!tag)break;tags[tag]=read64(entry+8n);}
    if(!tags[4]||!tags[5]||!tags[6])continue;for(var tag of [4,5,6])if(tags[tag]<base)tags[tag]+=base;
    var count=Number(read32(tags[4]+4n)),size=Number(tags[10]);
    if(count<1||count>10000||size<1||size>1048576||!readable(tags[6],count*24)||!readable(tags[5],size))continue;
    var symbols=io.copy(tags[6],count*24),strings=io.copy(tags[5],size),view=new DataView(symbols.buffer),exports={};
    for(var i=0;i<count;i++){var start=view.getUint32(i*24,true),name="";for(var j=start;j<strings.length&&j<start+4096&&strings[j];j++)name+=String.fromCharCode(strings[j]);var address=view.getBigUint64(i*24+8,true);if(address)exports[name]=base+address;}
    if(exports._ZN5movie7DecoderC1ENS_11DecoderTypeENS_19DecoderOutputFormatE){movie=exports;movieBase=base;break;}
   }
   if(!movie)throw Error("Native movie module unavailable");
  }
  function call(name,args){if(!movie[name])throw Error("Missing native movie function "+name);return call_rop.apply(null,[movie[name]].concat((args||[]).map(BigInt)));}
  function ok(name,args){var result=number(call(name,args));if(result)throw Error("Native video error 0x"+result.toString(16));}
  function object(type){var p=alloc(128);call("_ZN5movie"+type+"C1Ev",[p]);objects.push({type:type,p:p});return p;}
  function createGpuFence(device){
   var info=alloc(64),page=alloc(8);
   function range(p,n,permissions){if(call_rop(sdk_base+0x168b0cn,info,page,p)&0x3fffffn)throw Error("GPU sync memory query failed");if((Number(read32(info+24n))&permissions)!==permissions||p<read64(info)||p+BigInt(n)>read64(info)+read64(info+8n))throw Error("GPU sync pointer range rejected");}
   function resolve(offset){var cell=movieBase+BigInt(offset);range(cell,8,1);var pointer=read64(cell);range(pointer,8,1);var target=read64(pointer);range(target,16,5);return target;}
   var initialize=resolve(0x4038698),finalize=resolve(0x4038610),wait=resolve(0x4038720);
   if(read32(initialize)!==0xf900181fn||read32(initialize+4n)!==0xa9017c1fn||read32(finalize)!==0xb9400808n||read32(wait)!==0xd503237fn)throw Error("Unsupported GPU sync ABI");
   var pointer=alloc(256);if(!call_rop(initialize,pointer,device))throw Error("GPU sync initialization failed");
   return {pointer:pointer,ready:function(){var begin=now(),result=number(call_rop(wait,pointer,0n));gpuPolls++;gpuPollMs+=now()-begin;if(result===2){gpuPendingPolls++;return false;}if(result!==0&&result!==1)throw Error("GPU completion failed: "+result);return true;},close:function(){call_rop(finalize,pointer);}};
  }
  function integer(metadata,key){var k=alloc_string(key),v=alloc(8);try{if(!call("_ZNK5movie9MediaData9FindInt32EPKcPi",[metadata,k,v]))throw Error("Missing video format "+key);return number(read32(v));}finally{owned.pop();free(v);free(k);}}
  var config,input,output,format,index,available,pts,flags,size,alignment,spsNative,ppsNative;
  function videoSetup(videoFormat,w,h,fps){
   gpu=!!global.MoonlightNativeTexture&&options.renderer!=="png"&&options.renderer!=="native-texture";
   if(videoFormat!==1||w<64||h<64||w>(gpu?1920:640)||h>(gpu?1080:360))throw Error("Unsupported H.264 renderer dimensions");
   findMovie();width=w;height=h;frameInterval=gpu?0:Math.max(1,Math.floor(1000/fps));
   // The decoder installs allocator callbacks. Construct it before MediaData or
   // owned Buffer allocations so creation and destruction use the same allocator.
   decoder=alloc(1024);call("_ZN5movie7DecoderC1ENS_11DecoderTypeENS_19DecoderOutputFormatENS_11DecoderModeEi",[decoder,1,gpu?3:4,gpu?2:1,number(call("_ZN5movie17GetThreadPriorityEv",[]))]);
   objects.push({type:"7Decoder",p:decoder});if(!read64(decoder+8n))throw Error("Native decoder initialization failed");
   config=object("9MediaData");format=object("9MediaData");input=object("6Buffer");output=object("6Buffer");
   index=alloc(8);available=alloc(8);pts=alloc(8);flags=alloc(8);size=alloc(8);alignment=alloc(8);spsNative=alloc(65536);ppsNative=alloc(65536);
   if(global.MoonlightNativeTexture&&options.renderer!=="png")texture=global.MoonlightNativeTexture.create(io,core,w,h,{gpu:gpu});
   if(gpu){var target=texture.target();call("_ZN5movie6Buffer18SetDataAndCapacityEPvm",[output,target.texture,8]);call("_ZN5movie6Buffer9SetNvnDevEPv",[output,target.device]);}
   if(gpu&&!options.synchronousGpu){
    if(fps===60&&options.smoothVideo!==false)videoPacer=createVideoPacer(now,1000/fps);
    gpuFence=createGpuFence(target.device);call("_ZN5movie6Buffer10SetNvnSyncEPv",[output,gpuFence.pointer]);
    gpuPipeline=createGpuPipeline({
     submit:function(frame){var begin=now();ok("_ZN5movie7Decoder15GetOutputBufferEiPNS_6BufferE",[decoder,frame.index,output]);gpuSubmissionAt=now();gpuSubmitCost=gpuSubmissionAt-begin;gpuTransferMs+=gpuSubmitCost;conversionMs+=gpuSubmitCost;gpuTransfers++;},
     ready:gpuFence.ready,
     present:function(frame){var begin=now();gpuCompletionSamples++;gpuCompletionMs+=begin-gpuSubmissionAt;var url=texture.presentNative(),elapsed=now()-begin;nativePublishMs+=elapsed;conversionMs+=elapsed;maxConversionMs=Math.max(maxConversionMs,gpuSubmitCost+elapsed);if(options.onImage)options.onImage(url);lastPreview=begin;presentedFrame(frame);},
     release:function(frame){ok("_ZN5movie7Decoder24ReleaseOutputBufferIndexEi",[decoder,frame.index]);}
    });
   }
   if(options.onStatus)options.onStatus("Video decoder ready: "+w+"×"+h+" at "+fps+" fps");return 0;
  }
  function rawNal(heap,pointer,length){if(length>=4&&heap[pointer]===0&&heap[pointer+1]===0){if(heap[pointer+2]===1)return [pointer+3,length-3];if(heap[pointer+2]===0&&heap[pointer+3]===1)return [pointer+4,length-4];}return [pointer,length];}
  function videoFrame(pointer,length,kind,presentation,sps,spsLength,pps,ppsLength,heap){
   if(!decoder)return -1;
   if(!configured){
    if(!sps||!pps)return -1;var a=rawNal(heap,sps,spsLength),b=rawNal(heap,pps,ppsLength);if(a[1]<4||b[1]<1||a[1]>65536||b[1]>65536)return -1;
    io.toNative(heap,a[0],a[1],spsNative);io.toNative(heap,b[0],b[1],ppsNative);
    if(!call("_ZN5movie34CreateH264DecoderConfigurationDataEPKhmS1_mPNS_9MediaDataE",[spsNative,a[1],ppsNative,b[1],config]))throw Error("Native H.264 configuration failed");
    var key=alloc_string("max-input-size");try{call("_ZN5movie9MediaData8SetInt32EPKci",[config,key,width>1280||height>720?1048576:262144]);}finally{free(key);}
    ok("_ZN5movie7Decoder9ConfigureEPNS_9MediaDataE",[decoder,config]);ok("_ZN5movie7Decoder5StartEv",[decoder]);configured=started=true;
   }
   var result=number(call("_ZN5movie7Decoder23AcquireInputBufferIndexEPiS1_",[decoder,index,available]));if(result===0x1011)return -1;if(result)throw Error("Video input acquisition failed: "+result);
   var slot=number(read32(index));if(slot<0)return -1;
   ok("_ZN5movie7Decoder14GetInputBufferEiPNS_6BufferE",[decoder,slot,input]);
   var capacity=Number(call("_ZNK5movie6Buffer8CapacityEv",[input])),data=call("_ZNK5movie6Buffer4DataEv",[input]);if(!data||length<1||length>capacity)throw Error("Compressed video exceeds native input buffer");
   io.toNative(heap,pointer,length,data);var submittedAt=now();ok("_ZN5movie7Decoder24SendInputBufferForDecodeEiiilj",[decoder,slot,0,length,Math.round(presentation),0]);
   pendingFrames.set(String(Math.round(presentation)),submittedAt);if(pendingFrames.size>256)pendingFrames.delete(pendingFrames.keys().next().value);
   videoSubmitted++;return 0;
  }
  function drainVideo(){
   if(!started)return false;
   // A retained transfer owns this tick even if its fence completes here.
   if(gpuPipeline&&gpuPipeline.pending()){videoDeferredTicks++;gpuPipeline.finish();return true;}
   var priorTransfers=gpuTransfers,priorPresented=presented;
   var drain=videoPacer?videoPacer.drain:drainLatest;
   drain({
    acquire:function(){
     var result=number(call("_ZN5movie7Decoder24AcquireOutputBufferIndexEPiPlPjS1_",[decoder,index,pts,flags,available]));if(result===0x100e)return null;if(result)throw Error("Video output acquisition failed: "+result);
     var slot=number(read32(index));if(slot<0)return null;
     return {index:slot,timestamp:Number(BigInt.asIntN(64,read64(pts))),displayable:!(Number(read32(flags))&4)};
    },
    release:function(frame){ok("_ZN5movie7Decoder24ReleaseOutputBufferIndexEi",[decoder,frame.index]);},
    superseded:function(reason){videoSuperseded++;if(reason==="age")videoExpired++;if(reason==="backlog")videoBacklogDrops++;},
    decoded:function(frame){
     var stamp=String(frame.timestamp),submittedAt=pendingFrames.get(stamp);
     if(submittedAt!==undefined){frame.submittedAt=submittedAt;var delay=now()-submittedAt;decodeSamples++;decodeMs+=delay;maxDecodeMs=Math.max(maxDecodeMs,delay);pendingFrames.delete(stamp);}
     videoDecoded++;
    },
    present:function(frame,adopt){
     if(now()-lastPreview<(texture?frameInterval:200)||(options.canPresent&&!options.canPresent()))return;
     var slot=frame.index;
     if(!fields){
      ok("_ZN5movie7Decoder15GetOutputFormatEPNS_9MediaDataE",[decoder,format]);
      fields={width:integer(format,"width"),height:integer(format,"height")};
      if(fields.width!==width||fields.height!==height)throw Error("Unexpected stream output dimensions");
     }
     if(!gpu&&!outputStorage){
      Object.assign(fields,{yStride:integer(format,"nv12-y-stride"),uvStride:integer(format,"nv12-uv-stride"),yOffset:integer(format,"nv12-y-offset"),uvOffset:integer(format,"nv12-uv-offset")});
      ok("_ZN5movie7Decoder19GetOutputBufferSizeEPiS1_",[decoder,size,alignment]);outputLength=number(read32(size));if(outputLength<1||outputLength>4194304)throw Error("Invalid video output capacity");
      outputStorage=(alloc(outputLength+4096)+4095n)&~4095n;outputHeap=core._malloc(outputLength);if(!outputHeap)throw Error("Cannot allocate video presentation buffer");
      call("_ZN5movie6Buffer18SetDataAndCapacityEPvm",[output,outputStorage,outputLength]);
     }
     if(gpu){
       if(gpuPipeline){adopt();gpuPipeline.submit(frame);return;}
       var begin=now();ok("_ZN5movie7Decoder15GetOutputBufferEiPNS_6BufferE",[decoder,slot,output]);
       var copied=now(),url=texture.presentNative(),published=now(),elapsed=published-begin;gpuTransfers++;gpuTransferMs+=copied-begin;nativePublishMs+=published-copied;conversionMs+=elapsed;maxConversionMs=Math.max(maxConversionMs,elapsed);
       if(options.onImage)options.onImage(url);lastPreview=begin;presentedFrame(frame);
       return;
     }
     ok("_ZN5movie7Decoder15GetOutputBufferEiPNS_6BufferE",[decoder,slot,output]);
      var data=call("_ZNK5movie6Buffer4DataEv",[output]),used=Number(call("_ZNK5movie6Buffer4SizeEv",[output]));if(!data||used>outputLength||used<1)throw Error("Invalid decoded frame bounds");
      io.fromNative(core.HEAPU8,outputHeap,used,data);
      var begin=now(),url;
      if(texture)url=texture.present(core.HEAPU8,outputHeap,used,fields);
      else if(global.MoonlightPreview)url=global.MoonlightPreview.encode(core.HEAPU8,outputHeap,used,width,height,fields.yStride,fields.uvStride,fields.yOffset,fields.uvOffset);
      else {var encoded=core._ml_png_nv12(outputHeap,used,width,height,fields.yStride,fields.uvStride,fields.yOffset,fields.uvOffset);if(!encoded)throw Error("Frame presentation conversion failed");url="data:image/png;base64,"+core.UTF8ToString(encoded);}
      var elapsed=now()-begin;conversionMs+=elapsed;maxConversionMs=Math.max(maxConversionMs,elapsed);
      if(options.onImage)options.onImage(url);lastPreview=begin;presentedFrame(frame);
    }
   });
   return gpuTransfers!==priorTransfers||presented!==priorPresented;
  }
  function audioSetup(rate,channels,streams,coupled,samples){
   if(rate!==48000||channels!==2||streams!==1||coupled!==1)throw Error("First audio adapter supports stereo Opus at 48 kHz");
   var stateBytes=number(sdk("nncodecLibopus_opus_decoder_get_size",[2]));if(stateBytes<1||stateBytes>1048576)throw Error("Invalid Opus state size");
   if(!Number.isInteger(samples)||samples<120||samples>5760||samples%120)throw Error("Invalid negotiated Opus frame duration");
   audio={state:alloc(stateBytes),packet:alloc(65536),staging:alloc((5760+audioBatchSamples)*4),pending:alloc(audioBatchSamples*4),pendingSamples:0,stagedSamples:0,frameSamples:samples,concealed:0,concealedSamples:0,decodedSamples:0,out:alloc(1024),parameter:alloc(64),buffers:[],opened:false,started:false,decoded:0,queued:0,dropped:0,catchups:0,discardedSamples:0,emptyEpisodes:0,emptySince:null,emptyMs:0};
   if(number(sdk("nncodecLibopus_opus_decoder_init",[audio.state,48000,2])))throw Error("Opus decoder initialization failed");
   sdk("_ZN2nn5audio27InitializeAudioOutParameterEPNS0_17AudioOutParameterE",[audio.parameter]);write32(audio.parameter,48000n);write16(audio.parameter+4n,2n);
   var result=sdk("_ZN2nn5audio19OpenDefaultAudioOutEPNS0_8AudioOutERKNS0_17AudioOutParameterE",[audio.out,audio.parameter]);if(result&0x3fffffn)throw Error("AudioOut failed: 0x"+(result&0x3fffffn).toString(16));audio.opened=true;
   for(var i=0;i<audioPoolSize;i++)audio.buffers.push({node:alloc(64),data:(alloc(0x7000)+4095n)&~4095n,inUse:false,samples:0});
   // Prime both 20 ms buffers before starting the device. This is a one-time
   // startup cushion, not a larger steady-state queue or a restart on starvation.
   return 0;
  }
  function reclaimAudio(){
   if(!audio.started)return;
   for(var i=0;i<audio.buffers.length;i++){
    var released=sdk("_ZN2nn5audio25GetReleasedAudioOutBufferEPNS0_8AudioOutE",[audio.out]);if(!released)break;
    var item=audio.buffers.find(function(item){return item.node===released;});if(!item||!item.inUse)throw Error("AudioOut returned an unowned buffer");item.inUse=false;
   }
   // Observed queue-empty periods are starvation indicators, not exact DSP
   // underrun durations: reclamation itself is sampled by the JS scheduler.
   if(!audio.buffers.some(function(item){return item.inUse;})&&audio.emptySince===null){audio.emptySince=now();audio.emptyEpisodes++;}
  }
  function queueAudio(buffer,source){
   var bytes=audioBatchSamples*4;
   call_rop(memcpy_addr,buffer.data,source,BigInt(bytes));
   sdk("_ZN2nn2os14FlushDataCacheEPKvm",[buffer.data,bytes]);write64(buffer.node,0n);write64(buffer.node+0x20n,0n);
   sdk("_ZN2nn5audio21SetAudioOutBufferInfoEPNS0_14AudioOutBufferEPvmm",[buffer.node,buffer.data,0x6000,bytes]);
   if(!sdk("_ZN2nn5audio20AppendAudioOutBufferEPNS0_8AudioOutEPNS0_14AudioOutBufferE",[audio.out,buffer.node]))throw Error("Native audio queue rejected PCM");
   buffer.inUse=true;buffer.samples=audioBatchSamples;audio.queued++;
   if(audio.emptySince!==null){audio.emptyMs+=Math.max(0,now()-audio.emptySince);audio.emptySince=null;}
   if(!audio.started&&audio.buffers.every(function(item){return item.inUse;})){
    var result=sdk("_ZN2nn5audio13StartAudioOutEPNS0_8AudioOutE",[audio.out]);
    if(result&0x3fffffn)throw Error("AudioOut start failed: 0x"+(result&0x3fffffn).toString(16));audio.started=true;
   }
  }
  function discardPendingAudio(){
   if(!audio.pendingSamples)return;
   audio.discardedSamples+=audio.pendingSamples;audio.dropped++;audio.catchups++;audio.pendingSamples=0;
  }
  function drainAudio(){
   if(!audio||!audio.opened)return;
   reclaimAudio();if(!audio.pendingSamples)return;var buffer=audio.buffers.find(function(item){return !item.inUse;});
   if(buffer){queueAudio(buffer,audio.pending);audio.pendingSamples=0;}
  }
  function audioFrame(pointer,length,heap){
   if(!audio||!audio.opened)return;
   // The retained partial chunk is below 960 samples; staging reserves a full
   // 5760-sample decode after it. Decode there directly instead of copying PCM
   // through an intermediate allocation on every Opus packet.
   // A lost Chiaki packet is a NULL/zero-length callback. PLC must generate
   // exactly its negotiated duration, rather than the 120 ms decode capacity.
   if(length)io.toNative(heap,pointer,length,audio.packet);var samples=number(sdk("nncodecLibopus_opus_decode",[audio.state,length?audio.packet:0n,length,audio.staging+BigInt(audio.stagedSamples*4),length?5760:audio.frameSamples,0]));if(samples<0)throw Error("Native Opus decode failed: "+samples);audio.decoded++;audio.decodedSamples+=samples;if(!length){audio.concealed++;audio.concealedSamples+=samples;}
   if(samples>5760)throw Error("Native Opus output exceeds PCM capacity");
   audio.stagedSamples+=samples;
   // Two 20 ms native buffers plus one replaceable latest chunk. Keep Opus
   // state and active AudioOut buffers intact; drop only stale software PCM.
   var consumed=0;
   while(audio.stagedSamples-consumed>=audioBatchSamples){
    reclaimAudio();var buffer=audio.buffers.find(function(item){return !item.inUse;}),source=audio.staging+BigInt(consumed*4);consumed+=audioBatchSamples;
    // Preserve continuity when reclaimed capacity can hold the waiting chunk.
    // Replace it only when the native queue really has no room.
    if(buffer&&audio.pendingSamples){queueAudio(buffer,audio.pending);audio.pendingSamples=0;buffer=audio.buffers.find(function(item){return !item.inUse;});}
    if(buffer)queueAudio(buffer,source);
    else{discardPendingAudio();call_rop(memcpy_addr,audio.pending,source,BigInt(audioBatchSamples*4));audio.pendingSamples=audioBatchSamples;}
   }
   if(consumed){audio.stagedSamples-=consumed;if(audio.stagedSamples)call_rop(memcpy_addr,audio.staging,audio.staging+BigInt(consumed*4),BigInt(audio.stagedSamples*4));}
  }

  function close(){
   if(gpuPipeline)gpuPipeline.close();
   if(videoPacer){videoPacer.close();videoPacer=null;}
   if(audio&&audio.opened){if(audio.started)sdk("_ZN2nn5audio12StopAudioOutEPNS0_8AudioOutE",[audio.out]);sdk("_ZN2nn5audio20FlushAudioOutBuffersEPNS0_8AudioOutE",[audio.out]);sdk("_ZN2nn5audio13CloseAudioOutEPNS0_8AudioOutE",[audio.out]);}
   if(started)call("_ZN5movie7Decoder4StopEv",[decoder]);
   for(var entry of objects.reverse())call("_ZN5movie"+entry.type+"D1Ev",[entry.p]);objects=[];
   if(gpuFence){gpuFence.close();gpuFence=null;}gpuPipeline=null;
   if(texture){texture.close();texture=null;}
   if(outputHeap)core._free(outputHeap);outputHeap=0;if(core._ml_png_release)core._ml_png_release();
   for(var p of owned.reverse())free(p);owned=[];started=false;configured=false;decoder=0n;audio=null;pendingFrames.clear();
  }
  return {videoSetup:videoSetup,videoFrame:videoFrame,audioSetup:audioSetup,audioFrame:audioFrame,drainVideo:drainVideo,finishVideo:function(deadline){var tail=Number.isFinite(deadline)&&gpuPipeline&&gpuPipeline.pending(),begin=tail?now():0,result=finishGpu(gpuPipeline,now,deadline);if(tail){gpuTailChecks++;if(result)gpuTailCompleted++;gpuTailMs+=now()-begin;}return result;},drainAudio:drainAudio,close:close,
   stats:function(){return Object.assign({renderer:texture?(gpu?"native-gpu-texture":"native-texture"):"png",submitted:videoSubmitted,decoded:videoDecoded,presented:presented,videoSuperseded:videoSuperseded,videoDeferredTicks:videoDeferredTicks,videoExpired:videoExpired,videoBacklogDrops:videoBacklogDrops,gpuTransfers:gpuTransfers,gpuTransferMs:gpuTransferMs,nativePublishMs:nativePublishMs,gpuPolls:gpuPolls,gpuPendingPolls:gpuPendingPolls,gpuPollMs:gpuPollMs,gpuTailChecks:gpuTailChecks,gpuTailCompleted:gpuTailCompleted,gpuTailMs:gpuTailMs,gpuCompletionSamples:gpuCompletionSamples,gpuCompletionMs:gpuCompletionMs,videoPacerPending:videoPacer?videoPacer.pending():0,presentAgeMs:presentAgeMs,presentAgeSamples:presentAgeSamples,conversionMs:conversionMs,maxConversionMs:maxConversionMs,decodeSamples:decodeSamples,decodeMs:decodeMs,maxDecodeMs:maxDecodeMs,decoderPending:Math.max(0,videoSubmitted-videoDecoded),intervalCount:intervalCount,intervalMs:intervalMs,intervalSquaredMs:intervalSquaredMs,maxIntervalMs:maxIntervalMs,audioBufferedMsUpperBound:audio?(audio.stagedSamples+audio.pendingSamples+audio.buffers.reduce(function(sum,item){return sum+(item.inUse?item.samples:0);},0))/48:0,audioQueueLimitMs:audioBatchSamples*(audioPoolSize+1)/48,audioCatchups:audio?audio.catchups:0,audioDiscardedMs:audio?audio.discardedSamples/48:0,audioFrameSamples:audio?audio.frameSamples:0,audioConcealed:audio?audio.concealed:0,audioConcealedSamples:audio?audio.concealedSamples:0,audioDecodedSamples:audio?audio.decodedSamples:0,audioDecoded:audio?audio.decoded:0,audioQueued:audio?audio.queued:0,audioDropped:audio?audio.dropped:0,audioPrimed:!!(audio&&audio.started),audioPrefillMs:audioBatchSamples*audioPoolSize/48,audioEmptyEpisodes:audio?audio.emptyEpisodes:0,audioEmptyMs:audio?audio.emptyMs+(audio.emptySince===null?0:Math.max(0,now()-audio.emptySince)):0},texture?texture.stats():{});}};
 }
 global.MoonlightStreamMedia={create:create,drainLatest:drainLatest,createGpuPipeline:createGpuPipeline,finishGpu:finishGpu,createVideoPacer:createVideoPacer};
})(window);
