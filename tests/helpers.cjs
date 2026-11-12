const fs=require('node:fs');
const vm=require('node:vm');
function load(files,extra={}){
 const context={Uint8Array,Uint32Array,ArrayBuffer,DataView,Set,Map,console,atob,btoa,Date,setTimeout,clearTimeout,...extra};
 context.window=context;context.globalThis=context;vm.createContext(context);
 for(const file of files)vm.runInContext(fs.readFileSync(file,'utf8'),context,{filename:file});
 return context;
}
function fixtures(){
 const source=fs.readFileSync('tests/fixtures/fec_test_cases.inl','utf8'),re=/\{\s*(\d+),\s*(\d+),\s*\{([^}]+)\},\s*((?:"[^"]*"\s*)+),\s*(\d+)\s*\}/g;
 return [...source.matchAll(re)].map(match=>{
  const k=+match[1],m=+match[2],unit=+match[5],stride=Math.ceil(unit/16)*16,erasures=match[3].split(',').map(x=>+x.trim()).filter(x=>x>=0);
  const raw=Buffer.from([...match[4].matchAll(/"([^"]*)"/g)].map(x=>x[1]).join(''),'base64'),data=new Uint8Array(stride*(k+m));
  for(let i=0;i<k+m;i++)data.set(raw.subarray(i*unit,(i+1)*unit),i*stride);
  return {k,m,unit,stride,erasures,raw,data};
 });
}
module.exports={load,fixtures};
