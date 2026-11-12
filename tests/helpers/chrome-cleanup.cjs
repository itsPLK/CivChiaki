const {rm}=require('node:fs/promises');

// Observe close immediately after spawn, before a failure can end the process.
// Unlike exit, close also waits for inherited stdio held by Chrome children.
module.exports=function chromeCleanup(chrome){
 let closed=false;
 const completion=new Promise(resolve=>chrome.once('close',()=>{closed=true;resolve();}));
 function wait(ms){
  if(closed)return Promise.resolve(true);
  return new Promise(resolve=>{
   const timer=setTimeout(()=>resolve(false),ms);
   completion.then(()=>{clearTimeout(timer);resolve(true);});
  });
 }
 return async function cleanup(socket,profile){
  if(!closed){
   if(socket&&socket.readyState===1){
    try{socket.send(JSON.stringify({id:2147483647,method:'Browser.close'}));}
    catch{chrome.kill('SIGTERM');}
   }else chrome.kill('SIGTERM');
   if(!await wait(5000)){
    chrome.kill('SIGTERM');
    if(!await wait(3000)){
     chrome.kill('SIGKILL');
     if(!await wait(3000))throw Error('Chrome did not close; temporary profile retained: '+profile);
    }
   }
  }
  if(socket)socket.close();
  // Profile writers can lag the browser process; retry transient directory races.
  await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 };
};
