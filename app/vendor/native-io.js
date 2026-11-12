/* Translate the generated core's wasm32 socket ABI into CivSwitch SDK calls. */
(function(global){
 "use strict";
 function create(transport,options){
  options=options||{};
  var allocations=[],descriptors=new Set(),bufferSize=2097152,heapBuffer=null,heapView=null,heapAddress=0n,socketTypes={},interruptAfter=Infinity;
  var batchCore=null,batchHeap=0,batchFunction=null,batchSlots=[],batchSockets=new Map(),batchSize=32,packetSize=2048;
  var batchSlotBytes=batchSize*(packetSize+56+16);
  var directMetadata=0,directBase=0n,directCapacity=0,backlogSince=0;
  function now(){return global.performance&&global.performance.now?global.performance.now():Date.now();}
  function isInterrupted(){return interruptAfter!==Infinity&&now()>=interruptAfter;}
  function alloc(size){var p=malloc(size);if(!p)throw Error("Native streaming allocation failed");allocations.push(p);return p;}
  function invoke(name,args){return call_rop.apply(null,[transport.resolveNativeSymbol(name)].concat((args||[]).map(BigInt)));}
  function signed(value){return Number(BigInt.asIntN(32,value));}
  function call(name,args){var result=signed(invoke("_ZN2nn6socket"+name,args));return result<0?-Number(invoke("_ZN2nn6socket12GetLastErrnoEv",[])):result;}
  function copy(pointer,length){var bytes=new Uint8Array(length),view=new DataView(bytes.buffer),i=0;for(;i+8<=length;i+=8)view.setBigUint64(i,read64(pointer+BigInt(i)),true);for(;i<length;i++)bytes[i]=Number(read8(pointer+BigInt(i)));return bytes;}
  var address=alloc(128),addressLength=alloc(8),optionBuffer=alloc(128),optionLength=alloc(8);
  var packetCounts=new Uint32Array(65536),packetTypes=[];
  var stats={calls:0,sentBytes:0,receivedBytes:0,directReceivedBytes:0,directSentBytes:0,receiveCalls:0,receiveWouldBlock:0,nativeReceiveCalls:0,batchEnabled:false,batchReceiveCalls:0,batchPackets:0,batchCacheHits:0,batchCopiedBytes:0,cachedPollHits:0,lastError:0};
  // Format diagnostic keys only when sampled, not for every received packet.
  Object.defineProperty(stats,"rtpTypes",{enumerable:true,get:function(){var result={};for(var type of packetTypes)result[(type>>>8).toString(16)+":"+(type&255).toString(16)]=packetCounts[type];return result;}});
  function bounds(heap,pointer,length){pointer=pointer>>>0;if(!Number.isInteger(length)||length<0||pointer+length>heap.length)throw Error("Streaming heap range rejected");return pointer;}
  function completeHeap(heap){
   if(heap.byteOffset!==0||heap.byteLength!==heap.buffer.byteLength)throw Error("Expected complete core heap view");
  }
  function base(heap){
   completeHeap(heap);
   if(heap.buffer===heapBuffer)return heapAddress;
   var object=addrof_compressed(heap),external=read64_compressed(object+0x28n),compressedBase=read32_compressed(object+0x30n);
   if(compressedBase!==0n||external<0x100000000n||external>=0x8000000000n)throw Error("Core heap is not a validated external buffer");
   var bytes=copy(external,32);for(var i=0;i<32;i++)if(bytes[i]!==heap[i])throw Error("Core heap pointer verification failed");
   heapBuffer=heap.buffer;heapView=new DataView(heap.buffer);heapAddress=external;return external;
  }
  function toNative(heap,pointer,length,destination){pointer=bounds(heap,pointer,length);if(length)call_rop(memcpy_addr,destination,base(heap)+BigInt(pointer),BigInt(length));}
  function fromNative(heap,pointer,length,source){pointer=bounds(heap,pointer,length);if(length)call_rop(memcpy_addr,base(heap)+BigInt(pointer),source,BigInt(length));}
  function attachCore(core){
   if(batchCore)throw Error("Receive batching already attached");
   if(options.batchReceive===false||typeof sdk_base!=="bigint")return false;
   var fn;try{fn=transport.resolveNativeSymbol("_ZN2nn6socket8RecvMMsgEiPNS0_7MMsgHdrEmNS0_7MsgFlagEPNS_8TimeSpanE");}catch(_){return false;}
   // SDK 1.0.0 layout: 56-byte MMsgHdr; iovec pointer +16, count +24,
   // received length +48. Guard the observed implementation before using it.
   if(fn!==sdk_base+0x14d880n||read32(sdk_base+0x153720n)!==0xd10203ffn||read32(sdk_base+0x153724n)!==0xa9037bfdn)return false;
   batchCore=core;batchHeap=core._malloc(2*batchSlotBytes);if(!batchHeap)throw Error("Receive batch heap allocation failed");
   bounds(core.HEAPU8,batchHeap,2*batchSlotBytes);
   for(var i=0;i<2;i++){var offset=batchHeap+i*batchSlotBytes;batchSlots.push({fd:null,offset:offset,headerOffset:offset+batchSize*packetSize,vectorOffset:offset+batchSize*(packetSize+56),base:0n,count:0,next:0,lengths:new Uint32Array(batchSize)});}
   batchFunction=fn;stats.batchEnabled=true;return true;
  }
  function receiveBatch(fd,heap,destination,capacity,peek){
   var slot=batchSockets.get(fd);
   if(!slot){slot=batchSlots.find(function(s){return s.fd===null;});if(!slot)return null;slot.fd=fd;batchSockets.set(fd,slot);}
   bounds(heap,slot.offset,batchSlotBytes);
   if(slot.next>=slot.count){
    var address=base(heap),view=heapView;
    if(slot.base!==address){
     // Keep message metadata in the borrowed heap too. Reading result lengths
     // through DataView avoids an arbitrary native-memory read per datagram.
     heap.fill(0,slot.headerOffset,slot.offset+batchSlotBytes);
     for(var i=0;i<batchSize;i++){
      var header=slot.headerOffset+i*56,vector=slot.vectorOffset+i*16;
      view.setBigUint64(header+16,address+BigInt(vector),true);view.setUint32(header+24,1,true);
      view.setBigUint64(vector,address+BigInt(slot.offset+i*packetSize),true);view.setBigUint64(vector+8,BigInt(packetSize),true);
     }
     slot.base=address;
    }
    stats.nativeReceiveCalls++;stats.batchReceiveCalls++;
    var received=signed(call_rop(batchFunction,BigInt(fd),address+BigInt(slot.headerOffset),BigInt(batchSize),0x80n,0n));
    if(received<0){backlogSince=0;return -Number(invoke("_ZN2nn6socket12GetLastErrnoEv",[]));}
    if(received>batchSize)throw Error("Native receive batch exceeded slot count");
    // A full batch means more datagrams were already waiting: a standing queue.
    if(received===batchSize){if(!backlogSince)backlogSince=now();stats.fullBatches=(stats.fullBatches||0)+1;}else backlogSince=0;
    slot.count=received;slot.next=0;
    for(var i=0;i<received;i++){var length=view.getUint32(slot.headerOffset+i*56+48,true);if(length>packetSize)throw Error("Native receive batch exceeded packet capacity");slot.lengths[i]=length;}
    stats.batchPackets+=received;if(!received)return -11;
   }else stats.batchCacheHits++;
   var length=Math.min(capacity,slot.lengths[slot.next]),source=slot.offset+slot.next*packetSize;
   heap.copyWithin(destination,source,source+length);stats.batchCopiedBytes+=length;if(!peek)slot.next++;return length;
  }
  function receiveVideoBatch(fd,pointers,lengths,metadata,count,capacity,heap){
   if(isInterrupted())return -104;
   if(!batchFunction||options.directVideoBatch!==true)return -38;
   if(!descriptors.has(fd)||socketTypes[fd]!==2)return -9;
   if(count!==32||capacity<12||capacity>2048)return -22;
   completeHeap(heap);bounds(heap,pointers,count*4);bounds(heap,lengths,count*4);bounds(heap,metadata,count*72);
   var address=base(heap),view=heapView,vectors=metadata+count*56;
   // Validate all destinations before a native call can consume any datagrams.
   for(var i=0;i<count;i++)bounds(heap,view.getUint32(pointers+i*4,true),capacity);
   if(directMetadata!==metadata||directBase!==address||directCapacity!==capacity){
    heap.fill(0,metadata,metadata+count*72);
    for(var i=0;i<count;i++){
     view.setBigUint64(metadata+i*56+16,address+BigInt(vectors+i*16),true);view.setUint32(metadata+i*56+24,1,true);
     view.setUint32(vectors+i*16+8,capacity,true);
    }
    directMetadata=metadata;directBase=address;directCapacity=capacity;
   }
   // The validated Switch heap address is below 2**39, so adding a wasm32
   // offset is exact in Number. Avoid allocating BigInts for every packet.
   var numericBase=Number(address);
   for(var i=0;i<count;i++){
    var destination=numericBase+view.getUint32(pointers+i*4,true);
    view.setUint32(vectors+i*16,destination,true);view.setUint32(vectors+i*16+4,Math.floor(destination/4294967296),true);
   }
   stats.nativeReceiveCalls++;stats.directVideoBatchCalls=(stats.directVideoBatchCalls||0)+1;
   var received=signed(call_rop(batchFunction,BigInt(fd),address+BigInt(metadata),BigInt(count),0x80n,0n));
   if(received<0){var error=Number(invoke("_ZN2nn6socket12GetLastErrnoEv",[]));stats.lastError=error;if(error===11)stats.receiveWouldBlock++;return -error;}
   if(received>count)throw Error("Direct receive exceeded slot count");
   for(var i=0;i<received;i++){
    var length=view.getUint32(metadata+i*56+48,true);if(length>capacity)throw Error("Direct receive exceeded packet capacity");
    view.setUint32(lengths+i*4,length,true);stats.receivedBytes+=length;stats.directReceivedBytes+=length;
    if(length>=12){var p=view.getUint32(pointers+i*4,true),type=(heap[p]<<8)|heap[p+1];if(!packetCounts[type])packetTypes.push(type);packetCounts[type]++;}
   }
   stats.receiveCalls+=received;stats.directVideoPackets=(stats.directVideoPackets||0)+received;return received||-11;
  }
  function inputAddress(heap,pointer,length){
   bounds(heap,pointer,length);if(length<16||heap[pointer]!==2||heap[pointer+1]!==0)return false;
   var bytes=new Uint8Array(16);bytes.set(heap.subarray(pointer,pointer+16));bytes[0]=16;bytes[1]=2;write_buffer(address,bytes);return true;
  }
  function outputAddress(heap,pointer,lengthPointer){
   if(!pointer||!lengthPointer)return;
   bounds(heap,lengthPointer,4);var view=new DataView(heap.buffer),capacity=view.getUint32(lengthPointer,true),length=Math.min(capacity,16);
   bounds(heap,pointer,length);var bytes=copy(address,16);bytes[0]=2;bytes[1]=0;heap.set(bytes.subarray(0,length),pointer);view.setUint32(lengthPointer,16,true);
  }
  function nativeOption(level,option){
   if(level===1)return [0xffff,({2:4,4:0x1007,6:0x20,7:0x1001,8:0x1002,9:8,15:0x200})[option]||option];
   if(level===0)return [0,({1:3,2:4})[option]||option];
   return [level,option];
  }
  function io(op,args,heap){
   // Stop must not wait for network recovery or reliable-send/linger timers.
   // A fatal socket result (not EINTR, which ENet retries) unwinds C callers.
   if(isInterrupted()&&(op===3||op===4||op===5||op===11))return -104;
   stats.calls++;var a=args[0],b=args[1]>>>0,c=args[2]>>>0,d=args[3],e=args[4]>>>0,f=args[5]>>>0,result;
   try{
    if(op===1){
     if(a!==2)return -97;
     result=call("6SocketEiii",[a,b,c]);
     if(result>=0){var fd=result,flags=call("5FcntlEiiz",[fd,3,0]);result=flags<0?flags:call("5FcntlEiiz",[fd,4,flags|0x800]);if(result<0)call("5CloseEi",[fd]);else{descriptors.add(fd);socketTypes[fd]=b;result=fd;}}
    }else if(op===2||op===3){
     if(!inputAddress(heap,b,c))return -97;
     result=call(op===2?"4BindEiPK8sockaddrj":"7ConnectEiPK8sockaddrj",[a,address,16]);
    }else if(op===4||op===5){
     if(c>bufferSize)return -90;bounds(heap,b,c);
     // The socket call is synchronous, so this validated backing store stays
     // alive and cannot grow while native code reads/writes its borrowed range.
     completeHeap(heap);var flags=0x80|(d&2);
     if(op===4){
      var data=base(heap)+BigInt(b);
      if(e){if(!inputAddress(heap,e,f))return -97;result=call("6SendToEiPKvmiPK8sockaddrj",[a,data,c,flags,address,16]);}
      else result=call("4SendEiPKvmi",[a,data,c,flags]);
      if(result>0){if(result>c)throw Error("Native send exceeded borrowed range");stats.sentBytes+=result;stats.directSentBytes+=result;}
     }else{
      // Reject address ranges before a receive consumes a datagram.
      if(e&&f){bounds(heap,f,4);bounds(heap,e,Math.min(new DataView(heap.buffer).getUint32(f,true),16));}
      if(e)write32(addressLength,16n);stats.receiveCalls++;
      result=batchFunction&&socketTypes[a]===2&&!e&&c<=packetSize?receiveBatch(a,heap,b,c,!!(d&2)):null;
      if(result===null){var data=base(heap)+BigInt(b);stats.nativeReceiveCalls++;result=e?call("8RecvFromEiPvmiP8sockaddrPj",[a,data,c,flags,address,addressLength]):call("4RecvEiPvmi",[a,data,c,flags]);}
      if(result>=0){if(result>c)throw Error("Native receive exceeded borrowed range");outputAddress(heap,e,f);stats.receivedBytes+=result;stats.directReceivedBytes+=result;if(socketTypes[a]===2&&result>=12){var packetType=(heap[b]<<8)|heap[b+1];if(!packetCounts[packetType])packetTypes.push(packetType);packetCounts[packetType]++;}}
      else if(result===-11)stats.receiveWouldBlock++;
     }
    }else if(op===6){
     write32(addressLength,16n);result=call(d?"11GetPeerNameEiP8sockaddrPj":"11GetSockNameEiP8sockaddrPj",[a,address,addressLength]);
     if(result>=0)outputAddress(heap,b,c);
    }else if(op===7||op===8){
     var mapped=nativeOption(b,c),length=op===7?e:(bounds(heap,e,4),new DataView(heap.buffer).getUint32(e,true));
     if(length>128)return -22;bounds(heap,d>>>0,length);
     if(op===7){if(b===1&&c===8&&length===4)stats.receiveBufferRequested=new DataView(heap.buffer).getInt32(d>>>0,true);toNative(heap,d>>>0,length,optionBuffer);result=call("10SetSockOptEiiiPKvj",[a,mapped[0],mapped[1],optionBuffer,length]);}
     else{write32(optionLength,BigInt(length));result=call("10GetSockOptEiiiPvPj",[a,mapped[0],mapped[1],optionBuffer,optionLength]);if(result>=0){var actual=Number(read32(optionLength));if(actual>length)throw Error("Native socket option overflow");fromNative(heap,d>>>0,actual,optionBuffer);new DataView(heap.buffer).setUint32(e,actual,true);}}
    }else if(op===9)result=call("8ShutdownEii",[a,b]);
    else if(op===10){if(!descriptors.has(a))return -9;descriptors.delete(a);delete socketTypes[a];var slot=batchSockets.get(a);if(slot){slot.fd=null;slot.count=slot.next=0;batchSockets.delete(a);}result=call("5CloseEi",[a]);}
    else if(op===11){
     if(b>64)return -22;bounds(heap,a>>>0,b*8);
     // A cached datagram already proves read readiness. Avoid a native poll
     // for every packet in a 32-packet batch, especially in Chiaki's stop wait.
     if(b===1&&batchSockets.size){var cachedView=new DataView(heap.buffer),cachedSlot=batchSockets.get(cachedView.getInt32(a>>>0,true));if(cachedSlot&&cachedSlot.next<cachedSlot.count&&cachedView.getInt16((a>>>0)+4,true)===1){cachedView.setInt16((a>>>0)+6,1,true);stats.cachedPollHits++;return 1;}}
     // Both ABIs use an 8-byte {int fd, short events, short revents}. Like
     // recv(), zero-timeout poll borrows the validated heap synchronously.
     result=call("4PollEP6pollfdmi",[base(heap)+BigInt(a>>>0),b,0]);
     if(result>=0&&batchSockets.size){var view=new DataView(heap.buffer);for(var i=0;i<b;i++){var offset=(a>>>0)+i*8,slot=batchSockets.get(view.getInt32(offset,true));if(slot&&slot.next<slot.count&&(view.getInt16(offset+4,true)&1)){var events=view.getInt16(offset+6,true);if(!events)result++;view.setInt16(offset+6,events|1,true);}}}
    }else result=-38;
    if(result<0)stats.lastError=-result;return result;
   }catch(error){stats.lastError=5;throw error;}
  }
  return {io:io,backlogMs:function(){return backlogSince?now()-backlogSince:0;},receiveVideoBatch:receiveVideoBatch,stats:stats,invoke:invoke,copy:copy,toNative:toNative,fromNative:fromNative,heapAddress:base,attachCore:attachCore,
   interrupt:function(graceMs){interruptAfter=Math.min(interruptAfter,now()+Math.max(0,Math.min(100,Number(graceMs)||0)));},isInterrupted:isInterrupted,
   resume:function(){interruptAfter=Infinity;},
   randomFill:function(target){var p=alloc(Math.max(1,target.length));try{invoke("_ZN2nn6crypto36GenerateCryptographicallyRandomBytesEPvm",[p,target.length]);target.set(copy(p,target.length));}finally{allocations.pop();free(p);}},
   close:function(){for(var fd of descriptors)call("5CloseEi",[fd]);descriptors.clear();batchSockets.clear();batchSlots=[];if(batchHeap){batchCore._free(batchHeap);batchHeap=0;}batchCore=null;batchFunction=null;for(var p of allocations.reverse())free(p);allocations=[];heapBuffer=null;heapView=null;}
  };
 }
 global.MoonlightStreamIO={create:create};
})(window);
