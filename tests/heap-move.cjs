const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('frame bulk copy matches memmove for unaligned, overlapping and large ranges',()=>{
 let library;const env={LibraryManager:{library:{}},mergeInto:(_,l)=>library=l,HEAPU8:new Uint8Array(262144)};vm.runInNewContext(fs.readFileSync('app/native/platform-library.js','utf8'),env);
 for(const [dst,src,n] of [[1,3,1400],[3,1,1400],[4097,3,1400],[0,2048,120000],[262144,0,0]]){
  const h=env.HEAPU8;for(let i=0;i<h.length;i++)h[i]=(i*17+i%251)&255;const expected=h.slice();expected.set(h.slice(src,src+n),dst);library.cc_heap_move(dst,src,n);assert.deepEqual(h,expected);
 }
 for(const args of [[-1,0,1],[0,-1,1],[262143,0,2],[0,0,-1]])assert.throws(()=>library.cc_heap_move(...args),/range/);
});
