import assert from 'node:assert/strict';
import { build } from 'esbuild';

let slots=[],cursor=0,effects=[],dirty=false,auth={},subscriptions=0,cleanups=0,failStores=false;
const listeners=new Set(),timers=new Map();let timerId=0;
const stores=[{id:'A',code:'A',isActive:true},{id:'B',code:'B',isActive:true},{id:'DRAFT',code:'DRAFT',isActive:false,internalPosTestEnabled:true}];
const snap=data=>({id:data.id,data:()=>data,exists:()=>true});
globalThis.__kotHookHarness={
  setInterval(callback){const id=++timerId;timers.set(id,callback);return id;},clearInterval(id){timers.delete(id);},
  useState(initial){const i=cursor++;if(!slots[i])slots[i]={value:initial};return[slots[i].value,v=>{const next=typeof v==='function'?v(slots[i].value):v;if(!Object.is(next,slots[i].value)){slots[i].value=next;dirty=true;}}];},
  useRef(initial){const i=cursor++;if(!slots[i])slots[i]={current:initial};return slots[i];},
  useEffect(run,deps){const i=cursor++,old=slots[i];if(!old||deps.some((v,j)=>!Object.is(v,old.deps[j]))){effects=effects.filter(effect=>effect.index!==i);effects.push({index:i,run:()=>{old?.cleanup?.();slots[i]={deps,cleanup:run()};}});}},
  useAuth:()=>auth,
  collection:(_,name)=>({name}),doc:(_,name,id)=>({name,id}),where:(field,op,value)=>({field,op,value}),query:(collection,...constraints)=>({collection,constraints}),
  async getDoc(ref){if(failStores)throw{code:'permission-denied'};const row=stores.find(x=>x.id===ref.id);return row?snap(row):{exists:()=>false};},
  async getDocs(){if(failStores)throw{code:'permission-denied'};return{docs:stores.map(snap)};},
  async getDocsFromServer(){return{docs:[],metadata:{hasPendingWrites:false}};},
  onSnapshot(query,options,next,error){assert.equal(options.includeMetadataChanges,true);subscriptions++;const deliver=s=>next({metadata:{hasPendingWrites:false},...s});const entry={query,next:deliver,error};listeners.add(entry);deliver({docs:[]});return()=>{cleanups++;listeners.delete(entry);};},
};
const m='globalThis.__kotHookHarness';
const bundle=await build({entryPoints:['frontend/lib/useKotRealtime.ts'],bundle:true,format:'esm',platform:'node',write:false,define:{setInterval:'globalThis.__kotHookHarness.setInterval',clearInterval:'globalThis.__kotHookHarness.clearInterval'},plugins:[{
  name:'isolated-auth-firestore-hooks',setup(b){
    b.onResolve({filter:/^(react|firebase\/firestore)$|AuthContext$|^\.\/firebase$/},args=>({path:args.path,namespace:'mock'}));
    b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:args.path==='react'
      ?`export const useEffect=${m}.useEffect,useRef=${m}.useRef,useState=${m}.useState;`
      :args.path.endsWith('AuthContext')?`export const useAuth=${m}.useAuth;`
      :args.path==='./firebase'?'export const db={};'
      :['collection','doc','getDoc','getDocs','getDocsFromServer','onSnapshot','query','where'].map(n=>`export const ${n}=${m}.${n};`).join('\n')}));
  },
}]});
const {useKotRealtime}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
let view='ACTIVE',station='BARISTA',result,checks=0;
async function render(){for(let i=0;i<12;i++){cursor=0;dirty=false;result=useKotRealtime(view,station);const pending=effects;effects=[];pending.forEach(effect=>effect.run());await Promise.resolve();await Promise.resolve();if(!dirty&&effects.length===0)break;}return result;}
const profile=(role,ids,uid='staff')=>({staffProfile:{uid,role,storeIds:ids},firebaseUser:{uid},authStatus:'ready'});
const constraint=(entry,field)=>entry.query.constraints.find(x=>x.field===field)?.value;
const test=async(name,fn)=>{await fn();checks++;console.log('PASS',name);};
await test('delayed auth and mismatched UID produce zero queries',async()=>{
  auth={authStatus:'checking-auth',staffProfile:null,firebaseUser:null};await render();assert.equal(listeners.size,0);
  auth={...profile('CASHIER',['A']),firebaseUser:{uid:'other'}};await render();assert.equal(listeners.size,0);
});
await test('cashier one-store and duplicate assignments yield one station-scoped listener',async()=>{
  auth=profile('CASHIER',['A','A']);await render();assert.equal(listeners.size,1);
  const entry=[...listeners][0];assert.equal(constraint(entry,'storeId'),'A');assert.equal(constraint(entry,'station'),'BARISTA');assert.deepEqual(constraint(entry,'status'),['PENDING','PREPARING']);
});
await test('cosmetic profile/store order changes cause zero listener churn',async()=>{
  const count=subscriptions;auth={...profile('CASHIER',['A']),staffProfile:{...profile('CASHIER',['A']).staffProfile,name:'Changed name',assignedStoreIds:['A']}};await render();assert.equal(subscriptions,count);
});
await test('optimistic active writes do not acknowledge pending alerts',async()=>{
  const entry=[...listeners][0];entry.next({docs:[snap({id:'pending',status:'PENDING'})]});await render();
  entry.next({docs:[],metadata:{hasPendingWrites:true}});await render();assert.equal(result.items[0].id,'pending');
  entry.next({docs:[]});await render();assert.deepEqual(result.items,[]);
});
await test('manager reads only assigned active/test stores; query IDs stable and sorted',async()=>{
  auth=profile('STORE_MANAGER',['B','A','B','DRAFT']);await render();assert.deepEqual([...listeners].map(x=>constraint(x,'storeId')),['A','B','DRAFT']);
  const count=subscriptions;auth=profile('STORE_MANAGER',['DRAFT','A','B']);await render();assert.equal(subscriptions,count);
});
await test('admin multistore retains existing active/setup visibility',async()=>{
  auth=profile('ADMIN',[]);await render();assert.deepEqual([...listeners].map(x=>constraint(x,'storeId')),['A','B','DRAFT']);
});
await test('ready cashier queries READY/SERVED without widening station staff permissions',async()=>{
  view='READY';auth=profile('CASHIER',['B']);await render();let entry=[...listeners][0];assert.equal(constraint(entry,'storeId'),'B');assert.equal(constraint(entry,'station'),undefined);assert.deepEqual(constraint(entry,'status'),['READY','SERVED']);
  auth=profile('KITCHEN',['A']);await render();entry=[...listeners][0];assert.equal(constraint(entry,'station'),'KITCHEN');
});
await test('READY remains ready; served history excludes previous days',async()=>{
  const entry=[...listeners][0],today={toDate:()=>new Date()},old={toDate:()=>new Date(0)};
  entry.next({docs:[snap({id:'r',status:'READY'}),snap({id:'s',status:'SERVED',servedAt:today}),snap({id:'old',status:'SERVED',servedAt:old})]});await render();assert.deepEqual(result.items.map(x=>x.id),['r','s']);
});
await test('account change immediately removes previous scope; old callback cannot leak rows',async()=>{
  const entry=[...listeners][0];auth=profile('CASHIER',['B'],'new-staff');cursor=0;dirty=false;result=useKotRealtime(view,station);assert.deepEqual(result.items,[]);await render();
  entry.next({docs:[snap({id:'old-user',status:'READY'})]});await render();assert.deepEqual(result.items,[]);assert.equal(listeners.size,1);
});
await test('store permission failure reports error rather than empty successful loading',async()=>{
  failStores=true;auth=profile('CASHIER',['A'],'third-staff');await render();assert.match(result.error,/authorized ticket stores/);assert.equal(result.loading,false);assert.equal(listeners.size,0);
});
await test('failed store discovery retries at the 15-second scheduler without reload',async()=>{failStores=false;for(const callback of [...timers.values()])callback();await render();assert.equal(result.error,'');assert.equal(listeners.size,1);});
await test('signout/unmount clean every listener and timer',async()=>{
  failStores=false;auth=profile('ADMIN',[]);await render();auth={authStatus:'signed-out',staffProfile:null,firebaseUser:null};await render();assert.equal(listeners.size,0);
  slots.forEach(slot=>slot?.cleanup?.());assert.equal(cleanups,subscriptions);assert.equal(timers.size,0);
});
console.log(`${checks}/${checks} actual-hook lifecycle checks PASS with mocked React/Auth/Firestore. No real browser/emulator claims.`);
