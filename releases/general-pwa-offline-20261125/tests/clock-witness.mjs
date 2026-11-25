import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..');
const source=fs.readFileSync(path.join(root,'continuity/extension/clock.js'),'utf8').replace(
  "import { origin, callable } from './config.js';","const origin='https://pos.coffeebond.in', callable='https://example.invalid/clock';");
const stable=v=>Array.isArray(v)?'['+v.map(stable)+']':v&&typeof v==='object'?
 '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}':JSON.stringify(v??null);
const key=crypto.generateKeyPairSync('ec',{namedCurve:'P-256'}),publicKey=key.publicKey.export({format:'jwk'});
const client={frameId:0,tab:{id:1},url:'https://pos.coffeebond.in/pos'};
const original={uid:'staff',storeId:'cafe',deviceId:'till',snapshotId:'snapshot',snapshotDigest:'a'.repeat(64)};
const cases=[];
function fixture() {
  let receive;
  const state={storage:{},ticks:1000,epoch:crypto.randomUUID(),bindAt:2000,expiresAt:5000,requests:0};
  const storage={get:async()=>structuredClone(state.storage),set:async v=>Object.assign(state.storage,structuredClone(v)),remove:async key=>delete state.storage[key]};
  const chrome={runtime:{onMessageExternal:{addListener:f=>receive=f},sendNativeMessage:async()=>({ticks:state.ticks,epoch:state.epoch})},storage:{local:storage}};
  const fetch=async(url,options)=>{
    assert.equal(url,'https://example.invalid/clock');assert.equal(options.redirect,'error');
    assert.equal(options.headers.Authorization,'Bearer synthetic-token');
    state.requests++;const {data}=JSON.parse(options.body);
    assert.equal(data.action,'CLOCK_BIND');assert.equal(data.payload.deviceId,data.deviceId);
    return {ok:state.allow!==false,json:async()=>({result:{...data.payload,nonce:state.otherNonce?'wrong':data.payload.nonce,serverTime:state.bindAt,expiresAt:state.expiresAt}})};
  };
  vm.runInNewContext(source,{chrome,fetch,crypto:crypto.webcrypto,URL,atob,TextEncoder,Uint8Array,AbortSignal,performance});
  const send=(m,sender=client)=>new Promise(r=>receive(m,sender,r));
  const sign=(p,k=key)=>crypto.sign('sha256',Buffer.from(stable(p)),{key:k.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');
  async function message(operation,scope=original) {
    const {nonce}=await send({type:'CHALLENGE',operation,scope});
    const p={action:'CLOCK_'+operation,...scope,nonce};
    return {type:'PROVE',payload:p,signature:sign(p),...(operation==='BIND'?{token:'synthetic-token',publicKey}: {})};
  }
  return {state,send,message,sign,op:async(op,scope)=>send(await message(op,scope))};
}
{
 const {state,op,send,message}=fixture();
 assert((await op('BIND')).bound);state.ticks+=100;
 const resume=await message('RESUME');assert.equal((await send(resume)).serverTime,2100);
 assert((await send(resume)).error);assert.equal(state.requests,1);
 assert(!JSON.stringify(state.storage).includes('synthetic-token'));
 assert.deepEqual(Object.keys(state.storage.lease.publicKey).sort(),['crv','kty','x','y']);
 cases.push('Online original binding, single-use challenge, no token stored, no network on resume');
 for (const field of ['uid','storeId','deviceId','snapshotId','snapshotDigest']) {
   assert((await op('RESUME',{...original,[field]:field==='snapshotDigest'?'b'.repeat(64):'other'})).error);
 }
 const forged=await message('RESUME');forged.signature='invalid';assert((await send(forged)).error);
 const tab=await message('RESUME');assert((await send(tab,{...client,tab:{id:2}})).error);
 assert((await send({type:'CHALLENGE',operation:'RESUME',scope:original},{...client,url:'https://other.invalid'})).error);
 assert((await send({type:'CHALLENGE',operation:'RESUME',scope:original},{...client,frameId:2})).error);
 cases.push('Different identities, store, snapshot, digest, signature, tab, origin and subframes rejected');
 const revoked=await message('DROP');revoked.signature='bad';assert((await send(revoked)).error);
 assert((await op('RESUME')).serverTime);assert((await op('DROP')).dropped);assert((await op('RESUME')).error);
 cases.push('Only a fresh signed original snapshot revocation clears its clock binding');
}
for(const [name,change] of [
 ['Exact expiration',s=>s.ticks+=3000],['Monotonic rollback',s=>s.ticks--],['Lock, suspend or broker replacement',s=>s.epoch=crypto.randomUUID()],
 ['Missing clock',s=>s.epoch=null]]) {
 const {state,op}=fixture();assert((await op('BIND')).bound);change(state);assert((await op('RESUME')).error);cases.push(name);
}
for(const [name,change] of [['Server policy denied',s=>s.allow=false],['Wrong online challenge',s=>s.otherNonce=true],['Expired online proof',s=>s.expiresAt=s.bindAt]]){
 const {state,op}=fixture();change(state);assert((await op('BIND')).error);assert(!state.storage.lease);cases.push(name);
}
const result={status:'PASS',cases,financialWrites:0,productionRequests:0};
fs.writeFileSync(path.join(root,'evidence/clock-witness.json'),JSON.stringify(result,null,2)+'\n');console.log(cases.length+' clock witness groups passed');
