/* Retain SPS/PPS across header-only callbacks; forward complete access units. */
(function(g){
 "use strict";
 function nals(bytes){
  var starts=[];
  for(var i=0;i+3<=bytes.length;i++){
   if(bytes[i]!==0||bytes[i+1]!==0)continue;
   var n=bytes[i+2]===1?3:i+3<bytes.length&&bytes[i+2]===0&&bytes[i+3]===1?4:0;
   if(n){starts.push({offset:i,start:i+n});i+=n-1;}
  }
  return starts.map(function(s,i){return {type:bytes[s.start]&31,start:s.start,end:i+1<starts.length?starts[i+1].offset:bytes.length};}).filter(function(s){return s.end>s.start;});
 }
 // Parameter sets precede slices in an Annex B access unit. Stop scanning at
 // the first slice: its compressed payload can be large.
 function headers(bytes){
  var units=[],current=null;
  for(var i=0;i+3<=bytes.length;i++){
   if(bytes[i]!==0||bytes[i+1]!==0)continue;
   var n=bytes[i+2]===1?3:i+3<bytes.length&&bytes[i+2]===0&&bytes[i+3]===1?4:0;
   if(!n)continue;
   if(current){current.end=i;if(current.end>current.start)units.push(current);}
   var start=i+n;if(start>=bytes.length)return {units:units,vcl:false};
   var type=bytes[start]&31;if(type===1||type===5)return {units:units,vcl:true};
   current={type:type,start:start,end:bytes.length};i+=n-1;
  }
  if(current&&current.end>current.start)units.push(current);
  return {units:units,vcl:false};
 }
 function create(core,media,fps){
  var sps=core._malloc(65536),pps=core._malloc(65536),sl=0,pl=0,sequence=0,closed=false;
  if(!sps||!pps){if(sps)core._free(sps);if(pps)core._free(pps);throw Error("H.264 header allocation failed");}
  return {push:function(pointer,length,lost,recovered,heap){
   if(closed||length<1||pointer<0||pointer+length>heap.length)return false;
   var bytes=heap.subarray(pointer,pointer+length),parsed=headers(bytes),units=parsed.units,vcl=parsed.vcl;
   if(!units.length&&!vcl)return false;
   for(var u of units){
    if(u.type===7||u.type===8){var size=u.end-u.start;if(size>65536)return false;core.HEAPU8.set(bytes.subarray(u.start,u.end),u.type===7?sps:pps);if(u.type===7)sl=size;else pl=size;}
   }
   if(!vcl)return true;if(!sl||!pl)return false;
   var pts=Math.round(sequence++*1000000/fps);
   return media.videoFrame(pointer,length,0,pts,sps,sl,pps,pl,core.HEAPU8)===0;
  },close:function(){if(closed)return;closed=true;core._free(sps);core._free(pps);}};
 }
 g.CivChiakiH264={nals:nals,create:create};
})(typeof window!=="undefined"?window:globalThis);
