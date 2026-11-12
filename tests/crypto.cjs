const test=require('node:test'),assert=require('node:assert/strict'),nodeCrypto=require('node:crypto');const {load}=require('./helpers.cjs');
const env=load(['app/vendor/forge-aes.js','app/src/crypto.js']),forge=env.CivChiakiForgeAES,api=env.CivChiakiCrypto;
test('bulk JS AES preserves exact no-padding ECB semantics at multiple heap offsets',()=>{
 const provider=api.create(forge),heap=new Uint8Array(10000),key=Buffer.from('000102030405060708090a0b0c0d0e0f','hex');heap.set(key,1);
 for(const offset of [32,33,37])for(const size of [16,32,4096]){const plain=Buffer.from(Array.from({length:size},(_,i)=>(i*19)&255));heap.set(plain,offset);const c=nodeCrypto.createCipheriv('aes-128-ecb',key,null);c.setAutoPadding(false);const expected=Buffer.concat([c.update(plain),c.final()]);assert.equal(provider.ecb(1,offset,size,heap),0);assert.deepEqual(Buffer.from(heap.subarray(offset,offset+size)),expected);}
 provider.close();assert.throws(()=>provider.ecb(1,32,16,heap),/closed/);
});
test('32-bit GMAC tags with a 16-byte IV match an independent crypto implementation',()=>{
 const p=api.create(forge),heap=new Uint8Array(6000),key=Buffer.from('000102030405060708090a0b0c0d0e0f','hex'),iv=Buffer.from('f0e1d2c3b4a5968778695a4b3c2d1e0f','hex');heap.set(key,1);heap.set(iv,17);
 for(const size of [0,1,15,16,17,31,32,1500,4096]){const aad=Buffer.from(Array.from({length:size},(_,i)=>(i*23)&255));heap.set(aad,65);const c=nodeCrypto.createCipheriv('aes-128-gcm',key,iv,{authTagLength:4});c.setAAD(aad);c.final();p.gmac(1,17,65,size,5000,heap);assert.deepEqual(Buffer.from(heap.subarray(5000,5004)),c.getAuthTag());}
 assert.equal(p.stats().gmacCalls,9);p.close();assert.equal(p.stats().cachedKeys,0);
});
test('word-wise counter formatting matches a 128-bit oracle through all carry boundaries',()=>{
 const h=new Uint8Array(5200),modulus=1n<<128n;
 for(const iv of ['00000000000000000000000000000000','ffffffffffffffffffffffffffffffff','ffffffffff00000000000000ffffffff','90abcdef12ffffffffffffffffffffff'])for(const [low,high] of [[0,0],[0xfffffff0,0],[0xfffffff0,0xffffffff],[0xffffffff,0x87654321]]){
  // Offset 64 takes the aligned bulk-replication path; 65 the general path.
  for(const [data,length] of [[65,4096],[64,4096],[64,16],[64,48],[1024,1424]]){
  const bytes=Buffer.from(iv,'hex');h.fill(0xa5);h.set(bytes,17);api.fillCounter(0,17,low,high,data,length,h);
  const base=BigInt('0x'+Buffer.from(bytes).reverse().toString('hex'))+(BigInt(high)<<32n)+BigInt(low);
  for(let i=0;i<length/16;i++){const expected=Buffer.from(((base+BigInt(i))%modulus).toString(16).padStart(32,'0'),'hex').reverse();assert.deepEqual(Buffer.from(h.subarray(data+i*16,data+16+i*16)),expected);}
  assert.equal(h[data-1],0xa5);assert.equal(h[data+length],0xa5);
  }
 }
});
