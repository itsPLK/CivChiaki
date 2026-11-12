mergeInto(LibraryManager.library, {
  cc_heap_move: function(destination,source,length) {
    destination>>>=0;source>>>=0;length>>>=0;
    if(destination+length>HEAPU8.length||source+length>HEAPU8.length)throw Error('Frame copy range rejected');
    HEAPU8.copyWithin(destination,source,source+length);
  },
  cc_receive_backlog_ms: function() {
    var p=Module['chiakiPlatform'];try{return p&&p.receiveBacklogMs?Math.min(2147483647,Math.max(0,p.receiveBacklogMs()))|0:0;}catch(e){return 0;}
  },
  cc_io: function(op,a,b,c,d,e,f) {
    var p=Module['chiakiPlatform'];return p&&p.io?p.io(op,[a,b,c,d,e,f],HEAPU8)|0:-38;
  },
  cc_random_fill: function(pointer,length) {
    var p=Module['chiakiPlatform'];
    try { if(!p||!p.randomFill)return -1;p.randomFill(HEAPU8.subarray(pointer,pointer+length));return 0; } catch(e) { return -1; }
  },
  cc_log__deps: ['$UTF8ToString'],
  cc_log: function(level,pointer) { var p=Module['chiakiPlatform'];if(p&&p.log)p.log(level,UTF8ToString(pointer)); },
  cc_event__deps: ['$UTF8ToString'],
  cc_event: function(type,a,b,text) { var p=Module['chiakiPlatform'];if(p&&p.event)p.event(type,a,b,text?UTF8ToString(text):null); },
  cc_registered__deps: ['$UTF8ToString'],
  cc_registered: function(target,nickname,mac,key,morning) {
    var p=Module['chiakiPlatform'];if(p&&p.registered)p.registered(target,UTF8ToString(nickname),HEAPU8.slice(mac,mac+6),HEAPU8.slice(key,key+16),HEAPU8.slice(morning,morning+16));
  },
  cc_video: function(pointer,length,lost,recovered) { var p=Module['chiakiPlatform'];return p&&p.video?p.video(pointer,length,lost,recovered,HEAPU8)|0:0; },
  cc_audio_header: function(rate,channels,samples) { var p=Module['chiakiPlatform'];if(p&&p.audioHeader)p.audioHeader(rate,channels,samples); },
  cc_audio: function(pointer,length) { var p=Module['chiakiPlatform'];if(p&&p.audio)p.audio(pointer,length,HEAPU8); },
  cc_discovered__deps: ['$UTF8ToString'],
  cc_discovered: function(target,address,name,state) { var p=Module['chiakiPlatform'];if(p&&p.discovered)p.discovered(target,UTF8ToString(address),UTF8ToString(name),state); },
  cc_fec_begin: function(pointer,unit,stride,k,m,erasures,count,encode) {
    var p=Module['chiakiPlatform'];if(!p||!p.fec)return -1;
    var e=[];for(var i=0;i<count;i++)e.push(HEAPU32[(erasures>>>2)+i]);
    return p.fec.begin(Module,pointer,unit,stride,k,m,e,!!encode)|0;
  },
  cc_fec_poll: function() { var p=Module['chiakiPlatform'];return p&&p.fec?p.fec.poll(Module)|0:-1; },
  cc_xor_bytes: function(data,key,length) {
    var p=Module['chiakiPlatform'];if(!p||!p.crypto||!p.crypto.xor)return 1;try{return p.crypto.xor(data,key,length,HEAPU8)|0;}catch(error){if(p.log)p.log(1,'XOR provider failed');return -1;}
  },
  cc_key_stream: function(key,iv,low,high,data,length) {
    var p=Module['chiakiPlatform'];if(!p||!p.crypto||!p.crypto.keyStream)return 1;try{return p.crypto.keyStream(key,iv,low,high,data,length,HEAPU8)|0;}catch(error){if(p.log)p.log(1,'Key stream provider failed');return -1;}
  },
  cc_aes_ecb: function(key,data,length) {
    var p=Module['chiakiPlatform'];if(!p||!p.crypto)return 1;try{return p.crypto.ecb(key,data,length,HEAPU8)|0;}catch(error){if(p.log)p.log(1,'AES provider failed');return -1;}
  },
  cc_gmac: function(key,iv,data,length,output) {
    var p=Module['chiakiPlatform'];if(!p||!p.crypto)return 1;try{return p.crypto.gmac(key,iv,data,length,output,HEAPU8)|0;}catch(error){if(p.log)p.log(1,'GMAC provider failed');return -1;}
  }
});
