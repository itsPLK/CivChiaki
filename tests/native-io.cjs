/* Exercise borrowed core backing memory through the real native socket adapter. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function environment(batch=false,options={}){
 const views=[],native=Buffer.alloc(65536),owned=new Set(),calls=[],sent=[];let cursor=0x1000,blocked=false,memcopies=0,nextFd=7,freedCore=0,batchReportedCount=null,batchReportedLength=null;
 const heapBase=options.testHeapBase||0x200000000n;
 const sdk=0x10000000n,batchFunction=sdk+0x14d880n,datagrams=new Map();
 const heap=new Uint8Array(batch?262144:1024);views.push(heap);
 function range(p,n){for(let i=0;i<views.length;i++){const base=heapBase+BigInt(i)*0x100000000n;if(p>=base&&p+BigInt(n)<=base+BigInt(views[i].length))return views[i].subarray(Number(p-base),Number(p-base)+n);}assert(p>=0n&&p+BigInt(n)<=BigInt(native.length),'native range');return native.subarray(Number(p),Number(p)+n);}
 function write(p,v,n=8){const b=range(p,n);for(let i=0;i<n;i++)b[i]=Number((v>>BigInt(i*8))&255n);}
 function read(p,n=8){const b=range(p,n);let v=0n;for(let i=n-1;i>=0;i--)v=(v<<8n)|BigInt(b[i]);return v;}
 const payload=Uint8Array.from({length:30},(_,i)=>(i*27)&255);
 const scope={window:{},malloc:n=>{assert(n<2097152,'no packet scratch allocation');const p=BigInt(cursor);cursor+=n+8;owned.add(p);return p;},free:p=>assert(owned.delete(p)),memcpy_addr:'memcpy',
  read64:p=>read(p),read32:p=>p===sdk+0x153720n?0xd10203ffn:p===sdk+0x153724n?0xa9037bfdn:read(p,4),read8:p=>read(p,1),write64:(p,v)=>write(p,v),write32:(p,v)=>write(p,v,4),write_buffer:(p,b)=>range(p,b.length).set(b),
  addrof_compressed:view=>{let i=views.findIndex(v=>v.buffer===view.buffer);assert(i>=0);return BigInt(0x100+i*0x100);},
  read64_compressed:p=>heapBase+((p-0x128n)/0x100n)*0x100000000n,read32_compressed:()=>0n,
  call_rop:(name,...args)=>{
   calls.push([name,...args]);
   if(name==='memcpy'){memcopies++;range(args[0],Number(args[2])).set(range(args[1],Number(args[2])));return args[0];}
   if(name===batchFunction){
    assert.equal(args[3],0x80n);assert.equal(args[4],0n);if(batchReportedCount!==null)return BigInt(batchReportedCount);const queue=datagrams.get(Number(args[0]))||[],count=Math.min(queue.length,Number(args[2]));if(!count)return -1n;
    for(let i=0;i<count;i++){const h=args[1]+BigInt(i*56),v=read(h+16n);assert.equal(read(h+24n,4),1n);const capacity=Number(read(v+8n));assert(capacity>0&&capacity<=2048);const bytes=queue.shift();assert(bytes.length<=capacity);range(read(v),bytes.length).set(bytes);write(h+48n,BigInt(batchReportedLength===null?bytes.length:batchReportedLength),4);}return BigInt(count);
   }
   if(name.includes('socket6Socket'))return BigInt(batch?nextFd++:7);
   if(name.includes('Fcntl')||name.includes('Close'))return 0n;
   if(name.includes('GetLastErrno'))return 11n;
   if(name.includes('Recv')){
    if(blocked)return -1n;
    const length=Math.min(Number(args[2]),payload.length);range(args[1],length).set(payload.subarray(0,length));
    if(name.includes('RecvFrom')){range(args[4],16).set([16,2,0x12,0x34,192,168,1,4,0,0,0,0,0,0,0,0]);write(args[5],16n,4);}
    return BigInt(length);
   }
   if(name.includes('Send')){sent.push(Array.from(range(args[1],Number(args[2]))));return args[2];}
   if(name.includes('4Poll')){assert.equal(args[2],0n);const view=new DataView(range(args[0],Number(args[1])*8).buffer,range(args[0],Number(args[1])*8).byteOffset,Number(args[1])*8);for(let i=0;i<Number(args[1]);i++){assert.equal(view.getInt32(i*8,true),7+i);assert.equal(view.getInt16(i*8+4,true),1);view.setInt16(i*8+6,batch?0:1,true);}return batch?0n:args[1];}
   throw Error('Unexpected call '+name);
  }};
 if(batch)scope.sdk_base=sdk;
 vm.createContext(scope);vm.runInContext(fs.readFileSync('app/vendor/native-io.js','utf8'),scope);
 const io=scope.window.MoonlightStreamIO.create({resolveNativeSymbol:n=>batch&&n.includes('8RecvMMsg')?batchFunction:n},options);
 const core={HEAPU8:heap,_malloc:n=>{assert.equal(n,135680);return 4096;},_free:p=>{assert.equal(p,4096);assert.equal(freedCore++,0);}};
 return {io,core,heap,payload,calls,sent,owned,views,freedCore:()=>freedCore,corruptBatch:o=>{batchReportedCount=o.count??null;batchReportedLength=o.length??null;},enqueue:(fd,packets)=>datagrams.set(fd,packets.slice()),memcopies:()=>memcopies,setBlocked:b=>blocked=b,setTime:time=>{scope.window.performance={now:()=>time};}};
}
test('direct video batches fill owned buffers without copies, rebind after growth and reject unsafe calls',()=>{
 const e=environment(true,{directVideoBatch:true,testHeapBase:0x2ffffff00n});e.io.attachCore(e.core);e.io.io(1,[2,2,0,0,0,0],e.heap);
 const pointers=128,lengths=256,metadata=512,start=145000,view=new DataView(e.heap.buffer);
 for(let i=0;i<32;i++)view.setUint32(pointers+i*4,start+i*1456,true);
 const packets=Array.from({length:33},(_,i)=>new Uint8Array(1408).fill(i));e.enqueue(7,packets);
 const receive=heap=>e.io.receiveVideoBatch(7,pointers,lengths,metadata,32,1408,heap);
 assert.equal(receive(e.heap),32);assert.equal(e.io.stats.batchCopiedBytes,0);assert.equal(e.memcopies(),0);
 for(let i=0;i<32;i++){assert.equal(view.getUint32(lengths+i*4,true),1408);assert.equal(e.heap[start+i*1456],i);}
 const held=e.heap.slice(start,start+1456*32);
 // Give the next batch separate buffers so previously queued packets stay intact.
 for(let i=0;i<32;i++)view.setUint32(pointers+i*4,200000+i*1456,true);
 const grown=new Uint8Array(524288);grown.set(e.heap);e.views.push(grown);e.core.HEAPU8=grown;
 assert.equal(receive(grown),1);assert.equal(grown[200000],32);assert.deepEqual(grown.slice(start,start+held.length),held);
 assert.equal(receive(grown),-11);
 const before=e.calls.length;
 new DataView(grown.buffer).setUint32(pointers+31*4,grown.length-10,true);
 assert.throws(()=>receive(grown),/range/);assert.equal(e.calls.length,before);
 e.io.interrupt();assert.equal(receive(grown),-104);assert.equal(e.calls.length,before);
 e.io.close();assert.equal(e.owned.size,0);
 const fallback=environment(true);fallback.io.attachCore(fallback.core);
 assert.equal(fallback.io.receiveVideoBatch(7,0,0,0,32,1408,fallback.heap),-38);fallback.io.close();
});
test('TCP/UDP receive and send borrow core memory without intermediate payload copies',()=>{
 const e=environment();e.io.io(1,[2,2,0,0,0,0],e.heap);
 assert.equal(e.io.io(5,[7,128,50,0,0,0],e.heap),30);assert.deepEqual(e.heap.slice(128,158),e.payload);
 new DataView(e.heap.buffer).setUint32(80,16,true);
 assert.equal(e.io.io(5,[7,256,50,0,64,80],e.heap),30);assert.deepEqual(Array.from(e.heap.slice(64,72)),[2,0,0x12,0x34,192,168,1,4]);
 assert.equal(e.io.io(4,[7,256,30,0,0,0],e.heap),30);
 assert.equal(e.io.io(4,[7,256,30,0,64,16],e.heap),30);assert.deepEqual(e.sent,[Array.from(e.payload),Array.from(e.payload)]);
 assert.equal(e.memcopies(),0);assert.equal(e.io.stats.directReceivedBytes,60);assert.equal(e.io.stats.directSentBytes,60);
 e.setBlocked(true);const before=e.heap.slice();assert.equal(e.io.io(5,[7,256,50,0,0,0],e.heap),-11);assert.deepEqual(e.heap,before);assert.equal(e.io.stats.receiveWouldBlock,1);
 e.io.close();assert.equal(e.owned.size,0);
});
test('heap replacement revalidates the pointer, and invalid ranges are rejected before receiving',()=>{
 const e=environment();e.io.io(5,[7,128,30,0,0,0],e.heap);
 const larger=new Uint8Array(2048);e.views.push(larger);e.io.io(5,[7,1024,30,0,0,0],larger);assert.deepEqual(larger.slice(1024,1054),e.payload);
 const count=()=>e.calls.filter(c=>c[0].includes('Recv')).length,previous=count();
 assert.throws(()=>e.io.io(5,[7,1020,30,0,0,0],e.heap),/range/);
 assert.throws(()=>e.io.io(5,[7,128,30,0,1020,1022],e.heap),/range/);
 assert.throws(()=>e.io.io(5,[7,128,30,0,0,0],e.heap.subarray(1)),/complete/);
 assert.throws(()=>e.io.io(5,[7,128,30,0,0,0],e.heap.subarray(0,512)),/complete/);
 assert.equal(count(),previous);e.io.close();assert.equal(e.owned.size,0);
});
test('poll borrows validated pollfd memory and preserves snapshot packet counters',()=>{
 const e=environment(),view=new DataView(e.heap.buffer);e.io.io(1,[2,2,0,0,0,0],e.heap);
 for(let i=0;i<2;i++){view.setInt32(128+i*8,7+i,true);view.setInt16(132+i*8,1,true);}
 assert.equal(e.io.io(11,[128,2,0,0,0,0],e.heap),2);assert.equal(view.getInt16(134,true),1);assert.equal(view.getInt16(142,true),1);assert.equal(e.memcopies(),0);
 assert.equal(e.io.io(11,[128,65,0,0,0,0],e.heap),-22);
 const count=e.calls.length;assert.throws(()=>e.io.io(11,[1020,2,0,0,0,0],e.heap),/range/);assert.equal(e.calls.length,count);
 e.io.io(5,[7,256,30,0,0,0],e.heap);const snapshot=e.io.stats.rtpTypes;
 e.io.io(5,[7,256,30,0,0,0],e.heap);assert.equal(snapshot['0:1b'],1);assert.equal(e.io.stats.rtpTypes['0:1b'],2);e.io.close();assert.equal(e.owned.size,0);
});
test('local cancellation rejects network work immediately but leaves ownership intact until close',()=>{
 const e=environment();e.io.io(1,[2,2,0,0,0,0],e.heap);const before=e.calls.length;
 e.io.interrupt();assert.equal(e.io.isInterrupted(),true);
 for(const op of [3,4,5,11])assert.equal(e.io.io(op,[7,128,30,0,0,0],e.heap),-104);
 assert.equal(e.calls.length,before,'cancellation never waits in a native socket call');assert(e.owned.size>0,'live C tasks may still own borrowed buffers');
 assert.equal(e.io.io(10,[7,0,0,0,0,0],e.heap),0,'C teardown can still close its descriptors');
 e.io.close();assert.equal(e.owned.size,0);
});
test('shutdown grace is bounded and repeated cancellation cannot extend it',()=>{
 const e=environment();e.setTime(1000);e.io.interrupt(100);assert.equal(e.io.isInterrupted(),false);
 e.setTime(1050);e.io.interrupt(100);e.setTime(1100);
 assert.equal(e.io.isInterrupted(),true);e.io.close();assert.equal(e.owned.size,0);
});

test('batched UDP preserves packet order, peek, truncation, empty receive and cached poll readiness',()=>{
 const e=environment(true);assert.equal(e.io.attachCore(e.core),true);assert.equal(e.io.io(1,[2,2,0,0,0,0],e.heap),7);
 const packets=[Uint8Array.from({length:16},()=>1),Uint8Array.from({length:24},()=>2),new Uint8Array(0)];e.enqueue(7,packets);
 const recv=(n=64,flags=0)=>e.io.io(5,[7,128,n,flags,0,0],e.heap);
 assert.equal(recv(64,2),16);assert.deepEqual(e.heap.slice(128,144),packets[0]);assert.equal(e.io.stats.batchPackets,3);
 assert.throws(()=>e.io.io(5,[7,128,64,0,0,0],e.heap.subarray(0,e.heap.length-1)),/complete/,'cached receives reject partial heap views before consuming a datagram');
 const v=new DataView(e.heap.buffer);v.setInt32(256,7,true);v.setInt16(260,1,true);
 assert.equal(e.io.io(11,[256,1,0,0,0,0],e.heap),1);assert.equal(v.getInt16(262,true),1,'cached packets remain readable when native poll is empty');
 assert.equal(recv(),16);assert.equal(recv(12),12);assert.deepEqual(e.heap.slice(128,140),packets[1].slice(0,12));assert.equal(recv(),0);assert.equal(recv(),-11);
 assert.equal(e.io.stats.nativeReceiveCalls,2);assert.equal(e.io.stats.batchReceiveCalls,2);assert.equal(e.io.stats.batchCacheHits,3);assert.equal(e.memcopies(),0);
 e.io.close();e.io.close();assert.equal(e.freedCore(),1);assert.equal(e.owned.size,0);
});
test('batch slots stay separate, rebind on heap growth, and respect cancellation and fd reuse',()=>{
 const e=environment(true);e.io.attachCore(e.core);for(let i=0;i<3;i++)assert.equal(e.io.io(1,[2,2,0,0,0,0],e.heap),7+i);
 e.enqueue(7,[new Uint8Array(15).fill(7),new Uint8Array(17).fill(9)]);e.enqueue(8,[new Uint8Array(18).fill(8)]);
 assert.equal(e.io.io(5,[7,128,64,0,0,0],e.heap),15);assert.equal(e.io.io(5,[8,128,64,0,0,0],e.heap),18);
 const grown=new Uint8Array(262144);grown.set(e.heap);e.views.push(grown);e.core.HEAPU8=grown;
 assert.equal(e.io.io(5,[7,128,64,0,0,0],grown),17);assert.equal(grown[128],9);
 e.enqueue(7,[new Uint8Array(19).fill(10)]);assert.equal(e.io.io(5,[7,128,64,0,0,0],grown),19);assert.equal(grown[128],10,'new batch writes into the new backing store');
 assert.equal(e.io.io(5,[9,128,64,0,0,0],grown),30,'an extra UDP socket retains the single-receive fallback');
 e.io.io(10,[8,0,0,0,0,0],grown);e.enqueue(9,[new Uint8Array(20).fill(11)]);assert.equal(e.io.io(5,[9,128,64,0,0,0],grown),20,'closed descriptors release their batch slot');
 e.enqueue(7,[new Uint8Array(12),new Uint8Array(13)]);e.io.io(5,[7,128,64,0,0,0],grown);const before=e.calls.length;e.io.interrupt();assert.equal(e.io.io(5,[7,128,64,0,0,0],grown),-104);assert.equal(e.calls.length,before);
 e.io.close();assert.equal(e.freedCore(),1);assert.equal(e.owned.size,0);
});
test('batching can be disabled without allocating core scratch memory',()=>{const e=environment(true,{batchReceive:false});assert.equal(e.io.attachCore(e.core),false);assert.equal(e.io.stats.batchEnabled,false);e.io.close();assert.equal(e.freedCore(),0);});

test('invalid native batch lengths/counts are rejected before copying and still clean up',()=>{
 for(const corruption of [{count:33},{length:2049}]){
  const e=environment(true);e.io.attachCore(e.core);e.io.io(1,[2,2,0,0,0,0],e.heap);e.enqueue(7,[new Uint8Array(16).fill(7)]);e.corruptBatch(corruption);
  assert.throws(()=>e.io.io(5,[7,128,64,0,0,0],e.heap),/exceeded/);assert.equal(e.heap[128],0);e.io.close();assert.equal(e.freedCore(),1);assert.equal(e.owned.size,0);
 }
});

test('large receive batches preserve all 32 slots and fetch the next batch only after consumption',()=>{
 const e=environment(true);e.io.attachCore(e.core);e.io.io(1,[2,2,0,0,0,0],e.heap);
 e.enqueue(7,Array.from({length:33},(_,i)=>new Uint8Array(1400).fill(i)));
 for(let i=0;i<33;i++){assert.equal(e.io.io(5,[7,128,1400,0,0,0],e.heap),1400);assert.equal(e.heap[128],i);assert.equal(e.heap[1527],i);}
 assert.equal(e.io.stats.batchPackets,33);assert.equal(e.io.stats.nativeReceiveCalls,2);assert.equal(e.io.stats.batchCacheHits,31);e.io.close();assert.equal(e.freedCore(),1);assert.equal(e.owned.size,0);
});
test('full receive batches report a standing socket queue for delay-based congestion signalling',()=>{
 const e=environment(true);e.io.attachCore(e.core);e.setTime(1000);const fd=e.io.io(1,[2,2,0,0,0,0],e.heap);
 e.enqueue(fd,Array.from({length:70},(_,i)=>new Uint8Array(100).fill(i)));
 const recv=()=>e.io.io(5,[fd,8192,1500,0,0,0],e.heap);
 assert.equal(e.io.backlogMs(),0);assert.equal(recv(),100);
 e.setTime(1300);assert.equal(e.io.backlogMs(),300,'a full batch starts the backlog clock');
 for(let i=1;i<32;i++)recv();assert.equal(recv(),100);
 e.setTime(1400);assert.equal(e.io.backlogMs(),400,'consecutive full batches keep it running');
 for(let i=1;i<32;i++)recv();assert.equal(recv(),100);
 assert.equal(e.io.backlogMs(),0,'a partial batch means the queue drained');
 e.io.close();
});
