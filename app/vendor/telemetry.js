/* Interval statistics. Texture submissions are not display scanout timestamps. */
(function(global){
 "use strict";
 function now(){return global.performance&&typeof global.performance.now==="function"?global.performance.now():Date.now();}
 function readCore(core){
  if(!core._ml_session_metrics)return null;
  var p=core._ml_session_metrics();if(!p)return null;
  if(p%8||p<0||p+176>core.HEAPU8.length)throw Error("Invalid core metrics range");
  var v=Array.from(new Float64Array(core.HEAPU8.buffer,p,22));if(v[0]!==1||!v.every(Number.isFinite))throw Error("Invalid core metrics schema");return v;
 }
 function readFec(core){
  if(!core._ml_fec_metrics)return null;
  var p=core._ml_fec_metrics();if(p%8||p<=0||p+56>core.HEAPU8.length)throw Error("Invalid FEC metrics range");
  var v=Array.from(new Float64Array(core.HEAPU8.buffer,p,7));if(v[0]!==2||!v.every(Number.isFinite))throw Error("Invalid FEC metrics schema");
  return {calls:v[1],totalWallMs:v[2],maxWallMs:v[3],failed:v[4],shardBytes:v[5],budgetYields:v[6]};
 }
 function readPacketPool(core){
  if(!core._ml_packet_pool_metrics)return null;
  var p=core._ml_packet_pool_metrics();if(p%8||p<=0||p+64>core.HEAPU8.length)throw Error("Invalid packet pool metrics range");
  var v=Array.from(new Float64Array(core.HEAPU8.buffer,p,8));if(v[0]!==1||!v.every(Number.isFinite))throw Error("Invalid packet pool metrics schema");
  return {packetBytes:v[1],capacity:v[2],inUse:v[3],peak:v[4],hits:v[5],misses:v[6],reallocMoves:v[7]};
 }
 function create(clock){
  clock=clock||now;var previous=null;
  function sample(s,protocol){
   var time=clock(),old=previous,seconds=old?Math.max(0,(time-old.time)/1000):0;
   function delta(name){return Math.max(0,(s[name]||0)-(old?old.stats[name]||0:0));}
   function mean(total,count){var n=delta(count);return n?delta(total)/n:null;}
   function coreMean(total,count){var n=protocol?protocol[count]-(old&&old.protocol?old.protocol[count]:0):0;return n>0?(protocol[total]-(old&&old.protocol?old.protocol[total]:0))/n:null;}
   var interval=mean("intervalMs","intervalCount"),interval2=mean("intervalSquaredMs","intervalCount"),net=s.network||{};
   var rumble=s.rumble||{},oldRumble=old&&old.stats.rumble||{},rumbleUpdates=Math.max(0,(rumble.updates||0)-(oldRumble.updates||0));
   var value={decodedFps:seconds?delta("decoded")/seconds:null,textureFps:seconds?delta("presented")/seconds:null,
    receivedMbps:seconds?Math.max(0,(net.receivedBytes||0)-(old?old.stats.network.receivedBytes||0:0))*8/seconds/1000000:null,
    rttMs:protocol&&protocol[9]?protocol[10]:null,rttVariationMs:protocol&&protocol[9]?protocol[11]:null,
    frameReceiveMs:coreMean(2,1),coreQueueMs:coreMean(4,1),hostProcessingMs:coreMean(7,6),
    decodeReadyMs:mean("decodeMs","decodeSamples"),copyPresentMs:mean("conversionMs","presented"),
    gpuTransferMs:mean("gpuTransferMs","gpuTransfers"),nativePublishMs:mean("nativePublishMs","gpuTransfers"),
    gpuCompletionMs:mean("gpuCompletionMs","gpuCompletionSamples"),gpuPollMs:mean("gpuPollMs","gpuPolls"),gpuPendingPolls:s.gpuPendingPolls||0,
    presentAgeMs:mean("presentAgeMs","presentAgeSamples"),videoPacerPending:s.videoPacerPending||0,
    frameIntervalMs:interval,frameJitterMs:interval===null?null:Math.sqrt(Math.max(0,interval2-interval*interval)),
    loopHz:seconds?delta("iterations")/seconds:null,pumpAvgMs:mean("pumpMs","iterations"),drainAvgMs:mean("drainMs","iterations"),
    serviceHz:seconds?delta("serviceIterations")/seconds:null,servicePumpAvgMs:mean("servicePumpMs","serviceIterations"),serviceDrainAvgMs:mean("serviceDrainMs","serviceIterations"),
    decoderPending:s.decoderPending||0,videoSuperseded:s.videoSuperseded||0,audioBufferedMsUpperBound:s.audioBufferedMsUpperBound||0,audioQueueLimitMs:s.audioQueueLimitMs||0,audioCatchups:s.audioCatchups||0,audioDiscardedMs:s.audioDiscardedMs||0,audioDropped:s.audioDropped||0,
    audioPrimed:!!s.audioPrimed,audioPrefillMs:s.audioPrefillMs||0,audioEmptyEpisodes:s.audioEmptyEpisodes||0,audioEmptyMs:s.audioEmptyMs||0,
    videoFrameGaps:protocol?protocol[20]:null,decoderRejected:protocol?protocol[21]:null,audioRecovered:protocol?protocol[18]:null,audioFecFailed:protocol?protocol[19]:null,
    rumbleAvgMs:rumbleUpdates?Math.max(0,(rumble.totalMs||0)-(oldRumble.totalMs||0))/rumbleUpdates:null,rumbleMaxMs:rumble.maxMs||0,
    directReceivedBytes:net.directReceivedBytes||0};
   previous={time:time,stats:Object.assign({},s,{network:Object.assign({},net)}),protocol:protocol&&protocol.slice()};return value;
  }
  return {sample:sample};
 }
 // Ten minutes of one-second samples, kept only in RAM. A rare stall can be
 // inspected after play without TCP logging in the render/input loop.
 function createHistory(){
  var samples=[];
  function copy(value){return value?Object.assign({},value):null;}
  return {samples:samples,reset:function(){samples.length=0;},record:function(stats){
   var net=stats.network||{};
   samples.push({time:Date.now(),mode:copy(stats.mode),telemetry:copy(stats.telemetry),clock:copy(stats.clock),fec:copy(stats.fec),input:copy(stats.input),rumble:copy(stats.rumble),packetPool:copy(stats.packetPool),referenceRecovery:!!stats.referenceRecovery,
    network:{receivedBytes:net.receivedBytes||0,sentBytes:net.sentBytes||0,directVideoPackets:net.directVideoPackets||0,batchCopiedBytes:net.batchCopiedBytes||0,receiveWouldBlock:net.receiveWouldBlock||0},
    videoExpired:stats.videoExpired||0,videoBacklogDrops:stats.videoBacklogDrops||0,maxPumpMs:stats.maxPumpMs||0,maxDrainMs:stats.maxDrainMs||0,maxServiceMs:stats.maxServiceMs||0});
   if(samples.length>600)samples.shift();
  }};
 }
 function format(stats){
  var t=stats.telemetry||{},m=stats.mode||{};function f(v,digits){return typeof v==="number"&&Number.isFinite(v)?v.toFixed(digits===undefined?1:digits):"—";}
  return [m.width+" × "+m.height+" · "+m.fps+" FPS · "+f(m.bitrate/1000)+" Mbps requested",
   "Decoded "+f(t.decodedFps)+" · Texture "+f(t.textureFps)+" FPS",
   "Network RX "+f(t.receivedMbps,2)+" Mbps · RTT "+f(t.rttMs)+" ms",
   "RTT variation "+f(t.rttVariationMs)+" ms · Frame receive "+f(t.frameReceiveMs)+" ms",
   "Host processing "+f(t.hostProcessingMs)+" ms · Core queue "+f(t.coreQueueMs)+" ms",
   "Decode ready "+f(t.decodeReadyMs)+" ms · Copy/present "+f(t.copyPresentMs)+" ms",
   "GPU submit "+f(t.gpuTransferMs)+" ms · Decoder → texture "+f(t.presentAgeMs)+" ms",
   "Texture interval "+f(t.frameIntervalMs)+" ± "+f(t.frameJitterMs)+" ms",
   "Loop "+f(t.loopHz)+" Hz · Pump "+f(t.pumpAvgMs)+" ms · Drain "+f(t.drainAvgMs)+" ms",
   "Between frames "+f(t.serviceHz)+" Hz · Pump "+f(t.servicePumpAvgMs)+" ms · Audio "+f(t.serviceDrainAvgMs)+" ms",
   "Rumble "+f(t.rumbleAvgMs)+" ms avg · "+f(t.rumbleMaxMs)+" ms max",
   "Decoder "+f(t.decoderPending,0)+" frames · Audio ≤ "+f(t.audioBufferedMsUpperBound,0)+" ms",
   "Audio queue empty (observed) "+f(t.audioEmptyEpisodes,0)+" × / "+f(t.audioEmptyMs,0)+" ms",
   "Video gaps "+f(t.videoFrameGaps,0)+" · Stale skipped "+f(t.videoSuperseded,0)+" · Rejects "+f(t.decoderRejected,0),
   "Audio FEC "+f(t.audioRecovered,0)+" recovered / "+f(t.audioFecFailed,0)+" blocks failed · Skipped "+f(t.audioDiscardedMs,0)+" ms",
   "Texture timing excludes display scanout. − +: Exit"].join("\n");
 }
 global.MoonlightTelemetry={now:now,readCore:readCore,readFec:readFec,readPacketPool:readPacketPool,create:create,createHistory:createHistory,format:format};
})(typeof window!=="undefined"?window:globalThis);
