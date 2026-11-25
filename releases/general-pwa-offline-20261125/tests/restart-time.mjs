import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {createRequire} from 'node:module';
const root=path.resolve(import.meta.dirname,'..'),req=createRequire(path.join(root,'staff/package.json'));
const src=fs.readFileSync(path.join(root,'staff/frontend/lib/offline/authority.ts'),'utf8');
const {code}=await req('esbuild').transform(src,{loader:'ts',format:'cjs'});
const lease={id:'lease',uid:'staff',deviceId:'till',issuedAt:1000,expiresAt:6000};
const cases=[];
function fresh(){
 const time={wall:1000000,mono:200};
 const module={exports:{}};vm.runInNewContext(code,{Date:{now:()=>time.wall},performance:{now:()=>time.mono},module});
 return {a:module.exports,t:time};
}
for(const [name,serverTime,rtt,wallShift] of [
 ['Expired lease',6000,0,0],['Before original issue',999,0,0],['Round trip crosses expiry',5900,101,0],
 ['Slow station response',1600,2001,0],['Browser time rolls back',2000,200,-3000]]){
 const {a,t}=fresh(),start=a.observe();t.mono+=rtt;t.wall+=rtt+wallShift;
 assert.throws(()=>a.establishStationAuthority(lease,start,serverTime));assert.throws(()=>a.authorizedTime(lease));cases.push(name);
}
{
 const {a,t}=fresh(),start=a.observe();t.mono+=20;t.wall+=20;a.establishStationAuthority(lease,start,3000);
 assert.equal(a.authorizedTime(lease),3000);assert(!a.mayResumeAfterRestart());assert.throws(()=>a.establishStationAuthority(lease,start,3000));
 t.mono+=2979;t.wall+=2979;assert.equal(a.authorizedTime(lease),5979);t.mono++;t.wall++;
 assert.throws(()=>a.authorizedTime(lease));cases.push('Station-derived remaining lifetime includes request latency and cannot be replayed to extend billing');
}
{
 const {a,t}=fresh(),start=a.observe();a.establishStationAuthority(lease,start,2400);t.mono+=200;t.wall-=1800;
 assert.throws(()=>a.authorizedTime(lease));assert(!a.mayResumeAfterRestart());cases.push('Browser clock discontinuity invalidates the active authorization');
}
{
 const {a}=fresh();a.invalidateAuthority('permission withdrawn');assert(!a.mayResumeAfterRestart());assert.throws(()=>a.establishStationAuthority(lease,a.observe(),2300));cases.push('Explicit invalidation blocks local resume in the same process');
}
{
 const listeners={},module={exports:{}},document={visibilityState:'visible',addEventListener:(name,handler)=>listeners[name]=handler};
 vm.runInNewContext(code,{Date:{now:()=>1000},performance:{now:()=>100},module,
   window:{addEventListener:(name,handler)=>listeners[name]=handler},document,setInterval:()=>0});
 const a=module.exports, scoped={...lease,storeId:'cafe'};
 a.establishAuthority(scoped,a.observe());document.visibilityState='hidden';listeners.visibilitychange();
 assert.throws(()=>a.authorizedTime(scoped));assert(a.mayResumeAfterRestart());
 document.visibilityState='visible';a.establishStationAuthority(scoped,a.observe(),2000);assert.equal(a.authorizedTime(scoped),2000);
 a.invalidateScope('staff','other');assert.equal(a.authorizedTime(scoped),2000);
 a.invalidateScope('staff','cafe');listeners.pagehide();assert(!a.mayResumeAfterRestart());
 assert.throws(()=>a.establishStationAuthority(scoped,a.observe(),2001));
 cases.push('Hiding drops browser authority. Fresh independent time restores only the original grant. An explicit scoped revocation survives page hiding.');
 a.establishAuthority(scoped,a.observe());assert.throws(()=>a.authorizedTime({...scoped,storeId:'other'}));
 cases.push('An identical lease identifier cannot authorize another store.');
}
fs.writeFileSync(path.join(root,'evidence/restart-clock.json'),JSON.stringify({status:'PASS',cases},null,2)+'\n');console.log(cases);
