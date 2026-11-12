const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('app/vendor/controller-input.js','utf8');
function load(scope={}){const context=vm.createContext({window:{},...scope});vm.runInContext(source,context);return context.window.MoonlightControllerInput;}
const input=load();
const list=x=>Array.from(x.state);
test('native buttons follow standard positions and keep B available during play',()=>{
 const expected=[0x2000,0x1000,0x8000,0x4000,0x40,0x80,0x100,0x200,0,0,0x10,0x20,4,1,8,2];
 expected.forEach((flag,bit)=>{const value=input.fromNpad(1<<bit,0,0,0,0);assert.equal(value.state[0],flag);assert.equal(value.exit,false);});
 assert.equal(input.fromNpad(1<<8,0,0,0,0).state[1],255);assert.equal(input.fromNpad(1<<9,0,0,0,0).state[2],255);
 assert.equal(input.fromNpad(0xc00,0,0,0,0).exit,true);
 assert.equal(input.fromNpad((1<<16)|(1<<17),0,0,0,0).state[0],0,'stick direction pseudo-buttons are not D-pad presses');
});
test('both native sticks preserve orientation, dead zone and bounds',()=>{
 assert.deepEqual(list(input.fromNpad(0,-32768,32767,32767,-32768)),[0,0,0,-32767,32767,32767,-32767]);
 assert.deepEqual(list(input.fromNpad(0,100,-100,NaN,Infinity)),[0,0,0,0,0,0,0]);
});
test('browser and native physical layouts agree, including triggers and exit chord',()=>{
 const pad={mapping:'standard',connected:true,buttons:Array.from({length:17},()=>({pressed:false,value:0})),axes:[1,-1,-1,1]};
 pad.buttons[0].pressed=true;pad.buttons[6].value=.5;pad.buttons[7].value=2;
 assert.deepEqual(list(input.fromBrowser(pad)),[0x1000,128,255,32767,32767,-32767,-32767]);
 pad.buttons[8].pressed=true;assert.equal(input.fromBrowser(pad).exit,false);pad.buttons[9].pressed=true;assert.equal(input.fromBrowser(pad).exit,true);
 pad.connected=false;assert.equal(input.fromBrowser(pad),null);pad.connected=true;pad.mapping='';assert.equal(input.fromBrowser(pad),null);
});
test('native adapter polls connected styles, handles disconnects, and frees only its buffers',()=>{
 const memory=new Map(),owned=new Set(),addresses=new Map();let next=0x1000n,connected=true;
 const write=(p,v,n=8)=>{for(let i=0;i<n;i++)memory.set(p+BigInt(i),Number((BigInt(v)>>BigInt(8*i))&255n));};
 const read=(p,n=8)=>{let v=0n;for(let i=n-1;i>=0;i--)v=(v<<8n)|BigInt(memory.get(p+BigInt(i))||0);return v;};
 const window={MoonlightNative:{available:true,create:()=>({resolveNativeSymbol:name=>{const p=BigInt(addresses.size+1);addresses.set(p,name);return p;}})}};
 const adapter=load({window,malloc:n=>{const p=next;next+=BigInt(n+16);owned.add(p);return p;},free:p=>assert(owned.delete(p)),write32:(p,v)=>write(p,v,4),read32:p=>read(p,4),read64:p=>read(p),call_rop:(p,...args)=>{
  const name=addresses.get(p);assert(name);
  if(name.includes('GetNpadStyleSet')){write(args[0],connected&&read(args[1],4)===32n?2n:0n,4);return 0n;}
  assert(name.includes('GetNpadStates'));assert.equal(args[2],1n);
  write(args[0],1n,4);const out=args[1];write(out+8n,2n);write(out+16n,32767n,4);write(out+32n,connected?1n:0n,4);return 0n;
 }}).createNative();
 assert.deepEqual(list(adapter.poll()),[0x1000,0,0,32767,0,0,0]);connected=false;assert.equal(adapter.poll(),null);
 adapter.close();adapter.close();assert.equal(owned.size,0);assert.equal(adapter.poll(),null);
});

function rumbleDevice(){
 const memory=new Map(),owned=new Set(),addresses=new Map(),sends=[],initializations=[],errors=[],enumerations=[];
 let next=0x1000n;
 const device={connected:true,id:32,style:2,now:10000,fail:false,failInit:false};
 const write=(p,v,n=8)=>{for(let i=0;i<n;i++)memory.set(p+BigInt(i),Number((BigInt(v)>>BigInt(8*i))&255n));};
 const read=(p,n=8)=>{let v=0n;for(let i=n-1;i>=0;i--)v=(v<<8n)|BigInt(memory.get(p+BigInt(i))||0);return v;};
 const window={MoonlightNative:{available:true,create:()=>({resolveNativeSymbol:name=>{const p=BigInt(addresses.size+1);addresses.set(p,name);return p;}})}};
 const adapter=load({window,Date:{now:()=>device.now},malloc:n=>{const p=next;next+=BigInt(n+16);owned.add(p);return p;},free:p=>assert(owned.delete(p)),write32:(p,v)=>write(p,v,4),read32:p=>read(p,4),read64:p=>read(p),call_rop:(p,...a)=>{
  const name=addresses.get(p);assert(name);
  if(name.includes('GetNpadStyleSet')){write(a[0],device.connected&&Number(read(a[1],4))===device.id?BigInt(device.style):0n,4);return 0n;}
  if(name.includes('GetNpadStates')){write(a[0],1n,4);write(a[1]+32n,device.connected?1n:0n,4);return 0n;}
  if(name.includes('GetVibrationDeviceHandles')){assert.equal(a[2],2n);enumerations.push([Number(a[3]),Number(a[4])]);write(a[0],0x1234n,4);write(a[0]+4n,0x5678n,4);write(a[1],2n,4);return 0n;}
  if(name.includes('InitializeVibrationDevice')){initializations.push(Number(read(a[0],4)));return device.failInit?1n:0n;}
  assert(name.includes('SendVibrationValues'));assert.equal(a[2],2n);
  const values=[];for(let i=0;i<2;i++){const buffer=new ArrayBuffer(16),v=new DataView(buffer);for(let j=0;j<16;j+=4)v.setUint32(j,Number(read(a[1]+BigInt(i*16+j),4)),true);values.push(Array.from({length:4},(_,k)=>v.getFloat32(k*4,true)));}
  sends.push(values);return device.fail?1n:0n;
 }}).createNative({onRumbleError:error=>errors.push(error.message)});
 return {adapter,device,sends,initializations,errors,enumerations,owned};
}
test('native rumble maps both uint16 bands to HD vibration and stops before freeing',()=>{
 const d=rumbleDevice(),a=d.adapter;
 assert.equal(a.rumbleSupported,true);assert.equal(a.rumble(0,65535,32768),false,'no output before a controller is selected');
 a.poll();assert.equal(a.rumble(1,65535,65535),false,'unmapped host controllers are ignored');
 assert.equal(a.rumble(0,NaN,0),false);assert.equal(d.sends.length,0);
 assert.equal(a.rumble(0,65535,32768),true);
 assert.deepEqual(d.enumerations,[[32,2]]);assert.deepEqual(d.initializations,[0x1234,0x5678]);
 assert.equal(d.sends[0][0][0],1);assert.equal(d.sends[0][0][1],160);assert(Math.abs(d.sends[0][0][2]-32768/65535)<1e-7);assert.equal(d.sends[0][0][3],320);
 assert.deepEqual(d.sends[0][0],d.sends[0][1]);
 a.rumble(0,65535,32768);assert.equal(d.sends.length,1,'unchanged levels do not cause redundant native calls');
 a.stopRumble();assert.deepEqual(d.sends.at(-1),[[0,160,0,320],[0,160,0,320]]);
 a.rumble(0,-1,99999);assert.deepEqual(d.sends.at(-1)[0],[0,160,1,320]);
 a.close();assert.deepEqual(d.sends.at(-1)[0],[0,160,0,320]);a.close();assert.equal(d.owned.size,0);assert.equal(a.rumble(0,1,1),false);
});
test('disconnect silences the old controller; vibration failures do not disable input',()=>{
 const d=rumbleDevice(),a=d.adapter;a.poll();a.rumble(0,100,200);
 d.device.connected=false;assert.equal(a.poll(),null);assert.deepEqual(d.sends.at(-1)[0],[0,160,0,320]);
 d.device.connected=true;d.device.id=0;d.device.style=1;
 assert.equal(a.rumble(0,100,200),false);d.device.now+=501;assert(a.poll());
 assert.equal(a.rumble(0,300,400),true);assert.deepEqual(d.enumerations,[[32,2],[0,1]],"rumble follows the newly selected controller and style");
 a.close();assert.equal(d.owned.size,0);
 const failed=rumbleDevice();failed.adapter.poll();failed.device.fail=true;
 assert.equal(failed.adapter.rumble(0,200,300),false);assert.equal(failed.errors.length,1);
 assert(failed.adapter.poll(),'input polling survives a vibration error');
 assert.equal(failed.adapter.rumble(0,200,300),false);assert.equal(failed.errors.length,1);
 failed.adapter.close();assert.equal(failed.owned.size,0);
 const init=rumbleDevice();init.adapter.poll();init.device.failInit=true;
 assert.equal(init.adapter.rumble(0,1,1),false);assert.equal(init.sends.length,0);assert(init.adapter.poll());init.adapter.close();assert.equal(init.owned.size,0);
});
