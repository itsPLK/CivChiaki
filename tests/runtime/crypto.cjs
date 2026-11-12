/* Protocol crypto vectors from upstream test/rpcrypt.c and test/gkcrypt.c. */
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const Core=require('../../dist/runtime/chiaki-core.js');
async function setup(){
 const c=await Core({chiakiPlatform:{randomFill:a=>crypto.randomFillSync(a)}}),owned=[];
 function alloc(n){const p=c._malloc(n);assert.ok(p);owned.push(p);c.HEAPU8.fill(0,p,p+n);return p;}
 function hex(s){const a=Buffer.from(s,'hex'),p=alloc(a.length);c.HEAPU8.set(a,p);return p;}
 function out(p,n){return Buffer.from(c.HEAPU8.subarray(p,p+n));}
 return {c,alloc,hex,out,close:()=>owned.forEach(p=>c._free(p))};
}
test('real Mbed TLS secp256k1 exchange derives the same secret on both peers',async()=>{
 const {c,alloc,hex,out,close}=await setup(),a=alloc(4096),b=alloc(4096),handshake=hex('fc5d4ba03a353abb6a7fac791b17bb34');
 assert.equal(c._chiaki_ecdh_init(a),0);assert.equal(c._chiaki_ecdh_init(b),0);
 try{
  function pub(ctx){const key=alloc(128),len=alloc(4),sig=alloc(32),sl=alloc(4);c.HEAPU32[len>>>2]=128;c.HEAPU32[sl>>>2]=32;assert.equal(c._chiaki_ecdh_get_local_pub_key(ctx,key,len,handshake,sig,sl),0);assert.equal(c.HEAPU32[len>>>2],65);assert.equal(c.HEAPU32[sl>>>2],32);return {key,sig};}
  const pa=pub(a),pb=pub(b),sa=alloc(32),sb=alloc(32);
  assert.equal(c._chiaki_ecdh_derive_secret(a,sa,pb.key,65,handshake,pb.sig,32),0);assert.equal(c._chiaki_ecdh_derive_secret(b,sb,pa.key,65,handshake,pa.sig,32),0);assert.deepEqual(out(sa,32),out(sb,32));assert.notDeepEqual(out(sa,32),Buffer.alloc(32));
 }finally{c._chiaki_ecdh_fini(a);c._chiaki_ecdh_fini(b);close();}
});
test('registration/authentication IVs match upstream including a counter beyond 32 bits',async()=>{
 const {c,alloc,hex,out,close}=await setup(),ctx=alloc(64),nonce=hex('430967ae364b1c452662377abf3fe939'),morning=hex('d2789f5185a799a24452779c2b83cf07'),iv=alloc(16);
 c._chiaki_rpcrypt_init_auth(ctx,900,nonce,morning);assert.equal(c._chiaki_rpcrypt_generate_iv(ctx,iv,0,0),0);assert.equal(out(iv,16).toString('hex'),'0629be04e9911c48b45c026db7b78846');assert.equal(c._chiaki_rpcrypt_generate_iv(ctx,iv,0x05060708,0x01020304),0);assert.equal(out(iv,16).toString('hex'),'3fd0830ac730fc56752dbeb82c68a704');close();
});
test('Takion key stream matches upstream vectors at low and high key positions',async()=>{
 const {c,alloc,hex,out,close}=await setup(),ctx=alloc(4096),log=alloc(128),handshake=hex('83cf931a6aa769a6c4485d19c15ccc52'),secret=hex('73c8d549c4d9db502ec044ea33648c6ac9f36c41b6a0504fe093defb619b0973'),buf=alloc(32);
 c._chiaki_log_init(log,0,0,0);assert.equal(c._chiaki_gkcrypt_init(ctx,log,0,42,handshake,secret),0);
 try{assert.equal(c._chiaki_gkcrypt_gen_key_stream(ctx,0x30,0,buf,32),0);assert.equal(out(buf,32).toString('hex'),'0f6d89855ba786745ba1fe5c81196cd554c41ccaf6e934a4892698b06212b31a');assert.equal(c._chiaki_gkcrypt_gen_key_stream(ctx,0x420,1,buf,32),0);assert.equal(out(buf,32).toString('hex'),'14319ff8be0817a4fc28490b1e5f7b7efae914dec6dfe75dd69c753f9462d52c');}finally{c._chiaki_gkcrypt_fini(ctx);close();}
});
