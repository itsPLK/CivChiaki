/* Controller 0: native Npad samples on Switch, standard browser pads elsewhere. */
(function(global){
 "use strict";
 function axis(value,scale,invert){
  value=Number(value);if(!Number.isFinite(value))return 0;
  value=Math.max(-1,Math.min(1,value/scale));if(Math.abs(value)<.12)return 0;
  return Math.max(-32768,Math.min(32767,Math.round(value*(invert?-32767:32767))));
 }
 function fromNpad(buttons,lx,ly,rx,ry){
  buttons=Number(buttons)>>>0;var flags=0;
  // Match standard gamepad positions: Nintendo B/A/Y/X -> Xbox A/B/X/Y.
  var mapping=[[0,0x2000],[1,0x1000],[2,0x8000],[3,0x4000],[4,0x40],[5,0x80],[6,0x100],[7,0x200],[10,0x10],[11,0x20],[12,4],[13,1],[14,8],[15,2]];
  for(var entry of mapping)if(buttons&(1<<entry[0]))flags|=entry[1];
  return {state:[flags,buttons&0x100?255:0,buttons&0x200?255:0,axis(lx,32767,false),axis(ly,32767,false),axis(rx,32767,false),axis(ry,32767,false)],exit:(buttons&0xc00)===0xc00};
 }
 function fromBrowser(pad){
  if(!pad||pad.connected===false||pad.mapping!=="standard")return null;
  var flags=[0x1000,0x2000,0x4000,0x8000,0x100,0x200,0,0,0x20,0x10,0x40,0x80,1,2,4,8],buttons=0;
  function pressed(i){return !!(pad.buttons[i]&&pad.buttons[i].pressed);}
  for(var i=0;i<flags.length;i++)if(pressed(i))buttons|=flags[i];
  function trigger(i){var n=Number(pad.buttons[i]&&pad.buttons[i].value);return Number.isFinite(n)?Math.round(Math.max(0,Math.min(1,n))*255):0;}
  return {state:[buttons,trigger(6),trigger(7),axis(pad.axes[0],1,false),axis(pad.axes[1],1,true),axis(pad.axes[2],1,false),axis(pad.axes[3],1,true)],exit:pressed(8)&&pressed(9)};
 }
 function createNative(options){
  if(typeof call_rop!=="function"||typeof malloc!=="function"||!global.MoonlightNative||!global.MoonlightNative.available)return null;
  options=options||{};
  var transport=global.MoonlightNative.create(),owned=[],closed=false,selected=null,nextScan=0;
  var vibration=null,vibrationApi=null,vibrationFailed=false,handles=0n,values=0n;
  function vibrationError(error){var first=!vibrationFailed;vibrationFailed=true;if(first&&options.onRumbleError)try{options.onRumbleError(error);}catch(_){} }
  try{
   vibrationApi={
    handles:transport.resolveNativeSymbol("_ZN2nn3hid7utility25GetVibrationDeviceHandlesEPNS0_21VibrationDeviceHandleEPiijNS_4util10BitFlagSetILi32ENS0_12NpadStyleTagEEE"),
    initialize:transport.resolveNativeSymbol("_ZN2nn3hid6detail25InitializeVibrationDeviceERKNS0_21VibrationDeviceHandleE"),
    send:transport.resolveNativeSymbol("_ZN2nn3hid6detail19SendVibrationValuesEPKNS0_21VibrationDeviceHandleEPKNS0_14VibrationValueEi")
   };
  }catch(error){vibrationError(error);}
  function alloc(n){var p=malloc(n);if(!p)throw Error("Controller buffer allocation failed");owned.push(p);return p;}
  var prefix="_ZN2nn3hid6detail",styles=transport.resolveNativeSymbol(prefix+"15GetNpadStyleSetEPNS_4util10BitFlagSetILi32ENS0_12NpadStyleTagEEERKj");
  var getters=[{bit:2,name:"17NpadHandheldState"},{bit:1,name:"16NpadFullKeyState"},{bit:4,name:"16NpadJoyDualState"}].map(function(type){return {bit:type.bit,address:transport.resolveNativeSymbol(prefix+"13GetNpadStatesEPiPNS0_"+type.name+"EiRKj")};});
  var id=0n,style=0n,count=0n,sample=0n;
  function checkedVibration(address,args){var result=call_rop.apply(null,[address].concat(args));if(result&0x3fffffn)throw Error("Native vibration failed: 0x"+(result&0x3fffffn).toString(16));}
  var vibrationBytes=new DataView(new ArrayBuffer(16));
  function sendVibration(low,high){
   vibrationBytes.setFloat32(0,low/65535,true);vibrationBytes.setFloat32(4,160,true);
   vibrationBytes.setFloat32(8,high/65535,true);vibrationBytes.setFloat32(12,320,true);
   for(var i=0;i<vibration.count;i++)for(var j=0;j<16;j+=4)write32(values+BigInt(i*16+j),BigInt(vibrationBytes.getUint32(j,true)));
   if(low||high)vibration.dirty=true;
   checkedVibration(vibrationApi.send,[handles,values,BigInt(vibration.count)]);
   vibration.low=low;vibration.high=high;vibration.dirty=!!(low||high);
  }
  function stopRumble(){
   if(vibration&&vibration.dirty)try{sendVibration(0,0);}catch(error){vibrationError(error);}
  }
  function close(){if(closed)return;stopRumble();closed=true;for(var p of owned.reverse())free(p);owned=[];vibration=null;}
  try{id=alloc(8);style=alloc(8);count=alloc(8);sample=alloc(64);}catch(error){close();throw error;}
  function read(controller,getter){
   write32(id,BigInt(controller));write32(count,0n);
   var result=call_rop(getter.address,count,sample,1n,id);
   if(result&0x3fffffn)throw Error("Native controller state read failed: 0x"+(result&0x3fffffn).toString(16));
   if(read32(count)!==1n||!(read32(sample+32n)&1n))return null;
   function signed(offset){return Number(BigInt.asIntN(32,read32(sample+BigInt(offset))));}
   return fromNpad(read64(sample+8n),signed(16),signed(20),signed(24),signed(28));
  }
  return {poll:function(){
   if(closed)return null;
   if(selected){var value=read(selected.id,selected.getter);if(value)return value;stopRumble();vibration=null;selected=null;nextScan=0;}
   if(Date.now()<nextScan)return null;nextScan=Date.now()+500;
   for(var controller of [32,0,1,2,3,4,5,6,7]){
    write32(id,BigInt(controller));write32(style,0n);
    var result=call_rop(styles,style,id);if(result&0x3fffffn)throw Error("Native controller style read failed");
    var bits=Number(read32(style));
    for(var getter of getters)if(bits&getter.bit){var value=read(controller,getter);if(value){selected={id:controller,getter:getter};return value;}}
   }
   return null;
  },rumbleSupported:!!vibrationApi&&!vibrationFailed,rumble:function(controller,low,high){
   if(closed||vibrationFailed||!vibrationApi||!selected||controller!==0)return false;
   if(!Number.isFinite(low)||!Number.isFinite(high))return false;
   low=Math.round(Math.max(0,Math.min(65535,low)));high=Math.round(Math.max(0,Math.min(65535,high)));
   try{
    if(!vibration){
     if(!low&&!high)return true;
     if(!handles)handles=alloc(8);if(!values)values=alloc(32);
     write32(count,0n);
     checkedVibration(vibrationApi.handles,[handles,count,2n,BigInt(selected.id),BigInt(selected.getter.bit)]);
     var total=Number(read32(count));if(total<1||total>2)throw Error("Unexpected vibration device count");
     for(var i=0;i<total;i++)checkedVibration(vibrationApi.initialize,[handles+BigInt(i*4)]);
     vibration={count:total,low:0,high:0};
    }
    if(vibration.low!==low||vibration.high!==high)sendVibration(low,high);
    return true;
   }catch(error){stopRumble();vibrationError(error);return false;}
  },stopRumble:stopRumble,close:close};
 }
 global.MoonlightControllerInput={fromNpad:fromNpad,fromBrowser:fromBrowser,createNative:createNative};
})(window);
