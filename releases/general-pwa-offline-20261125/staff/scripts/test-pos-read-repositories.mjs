import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as esbuild from 'esbuild';
const root=new URL('../',import.meta.url).pathname;
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/pos-read-repositories.baseline.json',import.meta.url)));
const current=fs.readFileSync(root+'frontend/pages/pos/POSHome.tsx','utf8');
const beforeMode=process.argv.includes('--before');
if(beforeMode)assert.equal(crypto.createHash('sha256').update(current).digest('hex'),fixture.sourceSha256);
function load(file){const code=esbuild.buildSync({entryPoints:[root+file],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text;const c={module:{exports:{}},exports:{}};vm.runInNewContext(code,c);return c.module.exports;}
const deps={...load('frontend/lib/posStoreAccess.ts'),...load('frontend/lib/pos/posTax.ts'),...load('frontend/lib/posMenuNavigation.ts')};
const clone=x=>JSON.parse(JSON.stringify(x));
const goods=[{code:'A',name:'Alpha',isActive:true,isSellable:true,availableStoreIds:['GOLDEN_I'],salePrice:100,posCategoryCode:'ESPRESSO_BAR',posSubcategoryCode:'BLACK_COFFEE',sortOrder:2}, {code:'B',name:'Beta',isActive:false,isSellable:true},{code:'C',isActive:true,isSellable:false},{code:'D',isActive:true,isSellable:true,isAvailable:false},{code:'E',name:'Elsewhere',isActive:true,isSellable:true,availableStoreIds:['NOIDA_29']},{code:'F',name:'No stores',isActive:true,isSellable:true}];
const stores={GOLDEN_I:{code:'GOLDEN_I',isActive:true},NOIDA_29:{code:'NOIDA_29',isActive:true},INACTIVE:{isActive:false},TEST:{isActive:false,internalPosTestEnabled:true}};
async function run(after,kind,{role='ADMIN',assigned=['GOLDEN_I'],empty=false,fail='',profile=true}={}) {
 const trace=[],state={},errors=[];const snap=(id,data)=>({id,data:()=>data,exists:()=>data!==undefined});
 const api={collection:(_db,name)=>({collection:name}),doc:(_db,name,id)=>({collection:name,id}),query:(ref,...constraints)=>({...ref,constraints}),getDocs:async ref=>{trace.push(['getDocs',ref]);if(fail===ref.collection)throw {code:'permission-denied'};let data=empty?[]:ref.collection==='stores'?Object.entries(stores):ref.collection==='finishedGoods'?goods.map(x=>[x.code,x]):[['addons',{name:'Extras',isActive:true}]];return {docs:data.map(([id,d])=>snap(id,d))};},getDoc:async ref=>{trace.push(['getDoc',ref]);if(fail===ref.id)throw {code:'permission-denied'};return snap(ref.id,empty?undefined:stores[ref.id]);}};
 const context={...deps,...api,db:{},isAdmin:role==='ADMIN',staffProfile:profile?{role,assignedStoreIds:assigned}:null,console:{error:(...args)=>errors.push(args)},module:{exports:{}},exports:{}};
 for(const name of ['Loading','MenuItems','AddOnGroups','DebugCounts','Stores','SelectedStoreId'])context['set'+name]=value=>{state[name]=value};
 if(after&&!beforeMode)for(const file of ['stores/storeRepository.ts','menu/menuRepository.ts']){
  const c={...context,module:{exports:{}},exports:{},require:name=>{assert.equal(name,'firebase/firestore');return api;}};
  vm.runInNewContext(esbuild.transformSync(fs.readFileSync(root+'frontend/data/'+file,'utf8'),{loader:'ts',format:'cjs'}).code,c);Object.assign(context,c.module.exports);
 }
 const original=kind==='menu'?fixture.menu:fixture.stores;
 const start=kind==='menu'?'  const fetchMenuData = async':'  const fetchData = async';const end=kind==='menu'?'  const fetchData = async':'  const fetchTaxConfig = async';
 const source=after&&!beforeMode?current.slice(current.indexOf(start),current.indexOf(end)):original;
 vm.runInNewContext(esbuild.transformSync(fixture.normalizePrepStation+'\n'+source+'\nmodule.exports='+(kind==='menu'?'fetchMenuData':'fetchData')+';',{loader:'ts',format:'cjs'}).code,context);
 await context.module.exports();return clone({trace,state,errors});
}
let cases=0;
async function parity(kind,options={}){const b=await run(false,kind,options),a=await run(true,kind,options);assert.deepEqual(a,b,kind+' '+JSON.stringify(options));cases++;return a;}
for(const role of ['ADMIN','STORE_MANAGER','CASHIER']){
 const r=await parity('stores',{role,assigned:[' golden_i ','INACTIVE','TEST','MISSING']});
 assert.deepEqual(r.state.Stores.map(x=>x.id),role==='ADMIN'?['GOLDEN_I','NOIDA_29','TEST']:role==='STORE_MANAGER'?['GOLDEN_I','TEST']:['GOLDEN_I']);
 if(role==='ADMIN')assert.deepEqual(r.trace,[['getDocs',{collection:'stores'}]]);else assert.deepEqual(r.trace.map(x=>x[1].id),['GOLDEN_I','INACTIVE','TEST','MISSING']);
 for(const options of [{empty:true},{fail:'GOLDEN_I'},{fail:'stores'},{assigned:[]},{profile:false}])await parity('stores',{role,...options});
}
const menu=await parity('menu');assert.deepEqual(menu.trace,[['getDocs',{collection:'finishedGoods',constraints:[]}],['getDocs',{collection:'addOnGroups',constraints:[]}]]);
assert.deepEqual(menu.state.MenuItems.map(x=>x.id),['A','E','F']);assert.equal(menu.state.Loading,false);
assert.deepEqual(menu.state.DebugCounts,{total:6,activeCount:5,sellableCount:4,availableCount:3,mappedCount:3});
assert.equal(menu.state.MenuItems[0].posCategoryCode,'ESPRESSO_BAR');assert.equal(menu.state.MenuItems[0].sortOrder,2);
for(const selected of ['GOLDEN_I','NOIDA_29','UNKNOWN']){
 const actual=deps.uniqueSortedPosMenuItems(menu.state.MenuItems.filter(i=>i.isActive&&i.availableStoreIds?.includes(selected)),deps.POS_MENU_CATEGORIES);
 assert.deepEqual(actual.map(i=>i.id),selected==='GOLDEN_I'?['A']:selected==='NOIDA_29'?['E']:[]);cases++;
}
for(const options of [{empty:true},{fail:'finishedGoods'},{fail:'addOnGroups'}])await parity('menu',options);
console.log(`POS read repositories ${beforeMode?'BEFORE':'AFTER'}: PASS; ${cases} query/state/error parity cases.`);
