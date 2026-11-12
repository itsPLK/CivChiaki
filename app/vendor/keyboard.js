/* Blank native entry replaces a setting; cancellation keeps the saved value. */
(function(g){
 "use strict";
 function create(o){
  var editor=null,modulePromise=null;
  function node(tag,parent,style,text){if(o.layout)return o.layout.node(tag,parent,style,text);var e=document.createElement(tag);Object.assign(e.style,style||{});if(text!==undefined)e.textContent=text;if(parent)parent.appendChild(e);return e;}
  function cleanup(e){
   if(e.timer)clearTimeout(e.timer);if(e.component&&e.component.clearVirtualKeyboardCallbacks)e.component.clearVirtualKeyboardCallbacks();
   if(e.canceled){if(e.subscription&&e.subscription.clear)e.subscription.clear();else if(g.engine&&g.engine.off)g.engine.off("IMECanceled",e.canceled,e);}
   if(e.component&&e.originalCallback)e.component.onVirtualKeyboardTextEntered=e.originalCallback;
   g.removeEventListener("keydown",e.keydown,true);try{if(e.textbox&&e.textbox.loseFocus)e.textbox.loseFocus();if(e.input)e.input.blur();}catch(_){}
   if(e.node.parentNode)e.node.parentNode.removeChild(e.node);
  }
  function finish(e,value){if(editor!==e||e.finishing)return;e.finishing=true;e.timer=setTimeout(function(){if(editor!==e)return;editor=null;cleanup(e);o.focus();if(g.requestAnimationFrame)g.requestAnimationFrame(function(){if(!editor){o.focus();if(g.UI&&g.UI.refreshInput)g.UI.refreshInput();}});e.resolve(value);},0);}
  async function openNative(e){
   try{
    if(!modulePromise)modulePromise=o.loadTextbox?o.loadTextbox():import("/core/ui/components/fxs-textbox.js");await modulePromise;if(editor!==e)return;
    var textbox=node("fxs-textbox",e.panel,{display:"flex",width:"100%",height:"62px",fontSize:"28px",color:"#fff"});e.textbox=textbox;
    textbox.setAttribute("type",e.password?"password":"text");textbox.setAttribute("value","");
    var component=await new Promise(function(resolve,reject){var attempts=0;function ready(){if(editor!==e){reject(Error("Editor closed"));return;}var c;try{c=textbox.maybeComponent||textbox.component;}catch(_){}if(c){resolve(c);return;}if(++attempts>=180){reject(Error("Native keyboard did not initialize."));return;}e.timer=setTimeout(ready,16);}ready();});
    if(editor!==e)return;e.component=component;e.input=component.textInput||textbox.querySelector("input");
    if(!e.input||typeof component.onActivate!=="function")throw Error("Native keyboard is unavailable.");
    // Neither the component nor the IME receives the old setting. Keep the real
    // focused input editable; the component's enabled handler sets readOnly=true.
    component.overrideText=true;component.isPlaceholderActive=false;
    if(component.onAttributeChanged)component.onAttributeChanged("value",null,"");
    e.input.value="";e.input.maxLength=e.max;e.input.readOnly=false;
    Object.assign(e.input.style,{width:"100%",fontSize:"28px",color:"#fff",backgroundColor:"#111",padding:"12px",border:"2px solid #00efcf"});
    e.originalCallback=component.onVirtualKeyboardTextEntered;
    component.onVirtualKeyboardTextEntered=function(data){
     if(editor!==e)return;var value=data&&typeof data.data==="string"?data.data:e.input.value;
     // Element-mode completion can read the DOM instead of GenericData. Give
     // both paths exactly the new text, never an old value plus the new text.
     e.input.value=value;try{return e.originalCallback.apply(this,arguments);}finally{finish(e,value);}
    };
    e.canceled=function(){finish(e,null);};e.subscription=g.engine.on("IMECanceled",e.canceled,e);
    if(textbox.receiveFocus)textbox.receiveFocus();e.input.focus();e.input.value="";
    component.onActivate();
   }catch(error){if(editor!==e)return;finish(e,null);if(o.error)o.error(error.message);}
  }
  function edit(previous,max,password,label){
   if(editor)throw Error("Editor already open.");var resolve,result=new Promise(function(r){resolve=r;}),e={resolve:resolve,max:max,password:password};editor=e;
   if(o.native()){
    // The native applet owns visible entry. Retain only its offscreen callback
    // component; do not place an extra textbox or dialog above the keyboard.
    e.node=node("div",o.root,{position:"fixed",left:"0",top:"0",width:"1px",height:"1px",opacity:"0",pointerEvents:"none",overflow:"hidden"});e.panel=e.node;
   }else{
    e.node=node("div",o.root,{position:"absolute",left:"0",right:"0",top:"0",bottom:"0",zIndex:"8",backgroundColor:"rgba(0,0,0,0.75)"});
    e.panel=node("div",e.node,{position:"absolute",left:"160px",top:"100px",width:"960px",padding:"24px",backgroundColor:"#171b1f",border:"1px solid #465157"});
    node("div",e.panel,{fontSize:"26px",marginBottom:"16px"},"Enter new "+(label||"value"));
    node("div",e.panel,{fontSize:"18px",color:"#c8d0d2",marginBottom:"16px"},"Confirm to replace the current value. Cancel keeps it unchanged.");
   }
   e.node.id="text-editor";
   e.keydown=function(event){if(editor!==e||o.native())return;if(event.key==="Escape")finish(e,null);else if(event.key==="Enter")finish(e,e.input.value);else return;event.preventDefault();event.stopImmediatePropagation();};g.addEventListener("keydown",e.keydown,true);
   if(o.native())openNative(e);else{e.input=node("input",e.panel,{width:"100%",padding:"12px",fontSize:"28px"});e.input.type=password?"password":"text";e.input.value="";e.input.maxLength=max;e.input.focus();}return result;
  }
  return {edit:edit,active:function(){return !!editor;},action:function(){return !!editor;},cancel:function(){var e=editor;if(!e)return;editor=null;cleanup(e);e.resolve(null);}};
 }
 g.CivKeyboard={create:create};
})(typeof window!=="undefined"?window:globalThis);
