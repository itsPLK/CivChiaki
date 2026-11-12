/* Extract the pinned Forge AES module graph without modifying vendor source. */
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const acorn=require(path.join(root,'toolchains/emsdk/upstream/emscripten/node_modules/acorn'));
const source=fs.readFileSync(path.join(root,'app/vendor/forge-1.4.3.min.js'),'utf8');
if(require('node:crypto').createHash('sha256').update(source).digest('hex')!=='1166595db9f6cbc43ecc44b2657c5b83ee9603bfc0bd1d6564e22bd6a90dd82d')throw Error('Forge source digest mismatch');
const ast=acorn.parse(source,{ecmaVersion:2020});
function walk(n,fn){if(!n||typeof n!=='object')return;fn(n);for(const [k,v] of Object.entries(n)){if(k==='start'||k==='end')continue;if(Array.isArray(v))v.forEach(x=>walk(x,fn));else if(v&&typeof v==='object')walk(v,fn);}}
let modules;
walk(ast,n=>{if(n.type==='ArrayExpression'&&n.elements.length===45&&n.elements.every(x=>x&&x.type==='FunctionExpression'))modules=n.elements;});
if(!modules)throw Error('Unexpected Forge bundle; review module extraction');
const aes=modules.findIndex(n=>source.slice(n.start,n.end).includes('AES-ECB'));
if(aes<0)throw Error('AES module missing');
const included=new Set();
function include(id){if(included.has(id))return;included.add(id);const n=modules[id],requireName=n.params[2]&&n.params[2].name;walk(n,c=>{if(c.type==='CallExpression'&&c.callee.type==='Identifier'&&c.callee.name===requireName){if(c.arguments.length!==1||c.arguments[0].type!=='Literal'||!Number.isInteger(c.arguments[0].value))return;include(c.arguments[0].value);}});}
include(aes);
const functions=modules.map((n,i)=>included.has(i)?source.slice(n.start,n.end):'null');
// Force the timer branch so util never installs a page message listener or DOM observer.
const factory='function CivChiakiForgeAESFactory(){var setImmediate=function(fn){return globalThis.setTimeout(fn,0);};return (function(modules){var cache={};function require(id){if(cache[id])return cache[id].exports;var m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}require.g=globalThis;require.nmd=function(m){return m;};require('+aes+');return require(0);})(['+functions.join(',')+']);}';
const result='/* Generated from Forge 1.4.3. See forge-LICENSE and forge-NOTICE.md. */\n'+factory+'\n;(typeof window!=="undefined"?window:globalThis).CivChiakiForgeAES=CivChiakiForgeAESFactory();\n';
fs.writeFileSync(path.join(root,'app/vendor/forge-aes.js'),result);
console.log('Forge AES subset: '+Buffer.byteLength(result)+' bytes, modules '+[...included].sort((a,b)=>a-b).join(','));
