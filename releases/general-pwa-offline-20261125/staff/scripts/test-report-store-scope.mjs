import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { transformSync } from 'esbuild';
const root = new URL('../', import.meta.url).pathname;
const source = fs.readFileSync(root + 'frontend/pages/reports/DayClose.tsx', 'utf8');
const repository = fs.readFileSync(root + 'frontend/data/stores/storeRepository.ts', 'utf8');
const ids = ['GOLDEN_I', 'NOIDA_29', 'NOIDA_51', 'UDAY_PARK', 'TASTING_ROOM_29'];
const records = Object.fromEntries(ids.map(id => [id, {name:id, isActive:true}]));
records.INACTIVE = {name:'Inactive', isActive:false};
const plain = x => JSON.parse(JSON.stringify(x));
function compile(text, context) { vm.runInNewContext(transformSync(text, {loader:'ts', format:'cjs'}).code, context); }
function loaderBlock(name, end) { const start=source.indexOf(`    const ${name} = async`); assert(start>=0); return source.slice(start, source.indexOf(end,start)); }
async function exercise(role, assigned=['GOLDEN_I'], {fail=false, legacy=false, selected}={}) {
 const trace=[], state={};
 const profile={role, [legacy?'storeIds':'assignedStoreIds']:assigned};
 const snap=(id,data)=>({id, exists:()=>data!==undefined, data:()=>data});
 const api={
  collection:(_db,name)=>({collection:name}), doc:(_db,name,id)=>({collection:name,id}),
  where:(field,op,value)=>({field,op,value}), query:(ref,...constraints)=>({...ref,constraints}),
  Timestamp:{fromDate:d=>d},
  getDocs:async ref=>{ trace.push(ref); if(ref.collection==='stores') {
   if(role!=='ADMIN'||fail)throw new Error('Missing or insufficient permissions.');
   return {docs:Object.entries(records).filter(([,v])=>!ref.constraints?.length||v.isActive).map(([id,v])=>snap(id,v))};
  }
  const store=ref.constraints.find(c=>c.field==='storeId')?.value;
  if(role!=='ADMIN'&&!assigned.includes(store))throw new Error('Missing or insufficient permissions.');
  return {docs:[]}; },
  getDoc:async ref=>{trace.push(ref);if(fail|| (role!=='ADMIN'&&ref.collection==='stores'&&!assigned.includes(ref.id)))throw new Error('Missing or insufficient permissions.');return snap(ref.id,ref.collection==='stores'?records[ref.id]:undefined);}
 };
 const c={...api, db:{}, staffProfile:profile, active:true, dateStr:'2026-09-20', console:{error:()=>{}}, dayClosingId:(id,date)=>id+'_'+date, module:{exports:{}},exports:{},require:()=>api};
 for(const name of ['Loading','Error','Stores','Orders','OnlineOrders','ExistingClosing','ActualCash','Notes','Message'])c['set'+name]=v=>{state[name]=v};
 compile(repository,c);Object.assign(c,c.module.exports);
 compile(loaderBlock('loadStores','    loadStores();')+'\nmodule.exports=loadStores;',c);await c.module.exports();
 c.stores=state.Stores||[];
 const memo=source.slice(source.indexOf('  const accessibleStores = useMemo'),source.indexOf('  const summary = useMemo'));
 c.useMemo=fn=>fn();c.selectedStoreId=selected??c.stores[0]?.id??'';
 compile(memo+'\nmodule.exports={accessibleStores,selectedStore};',c);const scope=c.module.exports;c.selectedStore=scope.selectedStore;
 const storeState=plain(state);const storeTrace=plain(trace);trace.length=0;
 compile(loaderBlock('loadDayCloseData','    loadDayCloseData();')+'\nmodule.exports=loadDayCloseData;',c);await c.module.exports();
 return plain({storeState,storeTrace,scope,dataTrace:trace,state});
}
let passed=0;const check=(name,fn)=>Promise.resolve().then(fn).then(()=>{passed++;console.log('PASS '+name)});
if(process.argv.includes('--reproduce-baseline')){
 const r=await exercise('STORE_MANAGER');assert.match(r.storeState.Error,/insufficient permissions/);assert.equal(r.storeTrace[0].collection,'stores');assert(!r.storeTrace[0].id);console.log('BASELINE BUG REPRODUCED: Manager all-active-store query denied');process.exit(0);
}
await check('Admin five active stores and switching',async()=>{for(const id of ids){const r=await exercise('ADMIN',[],{selected:id});assert.deepEqual(r.scope.accessibleStores.map(s=>s.id),ids);assert.equal(r.scope.selectedStore.id,id);assert.equal(r.dataTrace.length,3);assert(r.dataTrace.slice(0,2).every(q=>q.constraints.find(c=>c.field==='storeId').value===id));assert.deepEqual(r.storeTrace[0].constraints,[{field:'isActive',op:'==',value:true}]);}});
for(const role of ['STORE_MANAGER','CASHIER']) {
 await check(role+' assigned document only and report reads',async()=>{const r=await exercise(role);assert.equal(r.storeState.Error,null);assert.deepEqual(r.scope.accessibleStores.map(s=>s.id),['GOLDEN_I']);assert.deepEqual(r.storeTrace,[{collection:'stores',id:'GOLDEN_I'}]);assert.equal(r.dataTrace.length,3);});
 await check(role+' unrelated selection does not query reports',async()=>{const r=await exercise(role,['GOLDEN_I'],{selected:'NOIDA_29'});assert.equal(r.scope.selectedStore,null);assert.deepEqual(r.dataTrace,[])});
 await check(role+' legacy assignment fallback',async()=>{const r=await exercise(role,['GOLDEN_I'],{legacy:true});assert.equal(r.scope.selectedStore.id,'GOLDEN_I')});
 await check(role+' no assignment makes no query',async()=>{const r=await exercise(role,[]);assert.deepEqual(r.storeTrace,[]);assert.deepEqual(r.dataTrace,[]);assert.equal(r.storeState.Error,null)});
 await check(role+' missing and inactive stores excluded',async()=>{const r=await exercise(role,['MISSING','INACTIVE']);assert.deepEqual(r.scope.accessibleStores,[]);assert.deepEqual(r.dataTrace,[])});
 await check(role+' malformed assignment safely excluded',async()=>{const r=await exercise(role,['','bad/path']);assert.deepEqual(r.storeTrace,[]);assert.deepEqual(r.scope.accessibleStores,[])});
 await check(role+' permission denial remains error, not no assignment',async()=>{const r=await exercise(role,['GOLDEN_I'],{fail:true});assert.match(r.storeState.Error,/Failed to load stores: Missing or insufficient permissions/);assert.deepEqual(r.dataTrace,[])});
}
await check('Cashier selector remains disabled and writes stay in DayClose',()=>{assert(source.includes("disabled={staffProfile.role === 'CASHIER'}"));assert(!/setDoc|updateDoc|deleteDoc/.test(repository));assert(source.includes('await setDoc(closingRef, payload, { merge: false });'))});
await check('store-error and no-assignment states have different text',()=>{assert(source.includes("error ? 'Unable to load stores' : 'No store available'"));assert(source.includes("error ? 'Store access could not be verified. Please retry or contact an Admin.' : 'Your profile does not have a store assigned for day closing.'"))});
console.log(`REPORT_STORE_SCOPE=PASS; ${passed} focused cases`);
