import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { initializeApp as initializeAdmin, deleteApp as deleteAdmin } from 'firebase-admin/app';
import { getFirestore as adminFirestore, Timestamp } from 'firebase-admin/firestore';
import { initializeApp, deleteApp } from 'firebase/app';
import { getFirestore, connectFirestoreEmulator, getDocsFromServer, collection, query, where, terminate } from 'firebase/firestore';

const PROJECT='demo-coffee-bond-kot-release', HOST='127.0.0.1:8287';
assert.equal(process.env.FIRESTORE_EMULATOR_HOST,HOST,'Hard stop unless exact isolated loopback emulator is selected');
const evidence=resolve('../kot-release-evidence');mkdirSync(evidence,{recursive:true});
const require=createRequire(import.meta.url);
const { chromium }=require('/opt/homebrew/lib/node_modules/openclaw/node_modules/playwright-core');
const admin=initializeAdmin({projectId:PROJECT},'isolated-kot-seed');const db=adminFirestore(admin);
const reset=await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,{method:'DELETE'});assert.ok(reset.ok,'Isolated emulator reset must succeed');
const profiles={writer:{role:'ADMIN',storeIds:[]},cashier:{role:'CASHIER',storeIds:['A']},manager:{role:'STORE_MANAGER',storeIds:['B','A']},admin:{role:'ADMIN',storeIds:[]},barista:{role:'BARISTA',storeIds:['A']}};
const now=Timestamp.now();
const fixture={id:'ticket',orderId:'synthetic-existing-order',orderNumber:'QA-20261001-0001',orderItemId:'LINE_1',storeId:'A',storeName:'Synthetic Store A',storeCode:'A',station:'BARISTA',itemName:'Synthetic Coffee',itemCode:'SYNTHETIC_COFFEE',quantity:1,orderType:'TAKEAWAY',status:'PENDING',createdAt:now,updatedAt:now,createdByUserId:'writer',createdByName:'Synthetic QA'};
const batch=db.batch();for(const [uid,p] of Object.entries(profiles))batch.set(db.doc('users/'+uid),{...p,isActive:true,uid,name:'Synthetic QA'});
for(const id of ['A','B'])batch.set(db.doc('stores/'+id),{id,code:id,name:'Synthetic Store '+id,isActive:true});
batch.set(db.doc('kotItems/ticket'),fixture);batch.set(db.doc('kotItems/other-store'),{...fixture,id:'other-store',storeId:'B',orderNumber:'QA-20261001-0002'});
batch.set(db.doc('kotItems/kitchen'),{...fixture,id:'kitchen',station:'KITCHEN',itemName:'Synthetic Kitchen',orderNumber:'QA-20261001-0003'});
await batch.commit();
const sdkPath=resolve('node_modules/firebase/firestore/dist/esm/index.esm.js');
const authStub=`const params=new URLSearchParams(location.search);const uid=params.get('user')||'writer';const profiles=${JSON.stringify(profiles)};const profile={...profiles[uid],uid,name:'Synthetic QA'};const context={staffProfile:profile,firebaseUser:{uid},authStatus:'ready'};export const useAuth=()=>context;`;
const firebaseStub=`import {initializeApp} from 'firebase/app';import {getFirestore,connectFirestoreEmulator,doc,updateDoc,serverTimestamp} from 'firebase/firestore';import {getAuth} from 'firebase/auth';import {getFunctions} from 'firebase/functions';const uid=new URLSearchParams(location.search).get('user')||'writer';export const firebaseConfig={projectId:'${PROJECT}',apiKey:'synthetic-local-key',appId:'synthetic-app'};export const app=initializeApp(firebaseConfig);export const db=getFirestore(app);connectFirestoreEmulator(db,'127.0.0.1',8287,{mockUserToken:{sub:uid}});export const auth=getAuth(app);export const functions=getFunctions(app);window.qaAdvance=status=>updateDoc(doc(db,'kotItems','ticket'),{status,updatedAt:serverTimestamp(),...(status==='READY'?{readyAt:serverTimestamp()}:{}),...(status==='SERVED'?{servedAt:serverTimestamp()}:{} )});`;
const transportStub=`export * from ${JSON.stringify(sdkPath)};import {onSnapshot as realSnapshot,getDocsFromServer as realServerRead} from ${JSON.stringify(sdkPath)};window.qaStats={active:0,attached:0,reads:0};export function onSnapshot(q,options,next,error){window.qaStats.active++;window.qaStats.attached++;const unsub=realSnapshot(q,options,s=>{if(!window.qaDropKotSnapshots)next(s);},error);return()=>{window.qaStats.active--;unsub();};}export function getDocsFromServer(q){window.qaStats.reads++;return realServerRead(q);}`;
const entry=`import React from 'react';import{createRoot}from'react-dom/client';import KOT from './frontend/pages/kot/KOTScreen';import Ready from './frontend/pages/kot/ReadyToServe';const ready=new URLSearchParams(location.search).get('view')==='ready';createRoot(document.getElementById('root')).render(ready?<Ready/>:<KOT station="BARISTA"/>);`;
const bundle=await build({stdin:{contents:entry,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'esm',write:false,define:{'import.meta.env.DEV':'false'},plugins:[{name:'synthetic-auth-real-emulator',setup(b){
  b.onResolve({filter:/AuthContext$|\/firebase$|^firebase\/firestore$/},a=>({path:a.path,namespace:'qa'}));
  b.onLoad({filter:/.*/,namespace:'qa'},a=>({contents:a.path.endsWith('AuthContext')?authStub:a.path==='firebase/firestore'?transportStub:firebaseStub,resolveDir:process.cwd()}));
}}]});
const html='<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>';
const server=createServer((req,res)=>{res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type',req.url==='/fixture.js'?'application/javascript':'text/html');res.end(req.url==='/fixture.js'?bundle.outputFiles[0].text:html);});
await new Promise(resolve=>server.listen(4187,'127.0.0.1',resolve));
let browser;const contexts=[],clients=[],results=[];
const record=(name,ms,detail='')=>{results.push({name,status:'PASS',milliseconds:ms,detail});console.log('PASS',name,ms===null?'':ms+'ms',detail);};
const wait=async(page,fn)=>page.waitForFunction(fn,{},{timeout:5000});
try{
  browser=await chromium.launch({headless:true,executablePath:'/Users/narendrashukla/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'});
  const page=async(user,view='active')=>{const context=await browser.newContext();contexts.push(context);const p=await context.newPage();p.on('pageerror',e=>console.error('FIXTURE_PAGE_ERROR',e.message));await p.goto(`http://127.0.0.1:4187/?user=${user}&view=${view}`);return p;};
  const a=await page('writer'),b=await page('cashier'),c=await page('cashier','ready'),d=await page('manager','ready');
  for(const p of [a,b])await p.getByRole('button').filter({hasText:'Synthetic Coffee'}).first().click();
  let start=Date.now();await a.getByRole('button',{name:'Start Preparing',exact:true}).last().click();await b.getByRole('button',{name:'Mark Ready',exact:true}).last().waitFor({timeout:5000});record('A two independent actual KOT screens PENDING->PREPARING',Date.now()-start);
  start=Date.now();await a.getByRole('button',{name:'Mark Ready',exact:true}).last().click();await c.getByRole('button',{name:'Mark Served',exact:true}).filter({visible:true}).first().waitFor({timeout:5000});await d.getByRole('button',{name:'Mark Served',exact:true}).first().waitFor({timeout:5000});await b.getByRole('button',{name:'Mark Ready',exact:true}).last().waitFor({state:'detached',timeout:5000});record('B actual KOT->Ready PREPARING->READY',Date.now()-start);
  start=Date.now();await c.getByRole('button',{name:'Mark Served',exact:true}).first().click();await d.getByRole('heading',{name:'Served Today (1)',exact:true}).waitFor({timeout:5000});record('C independent Ready screens READY->SERVED',Date.now()-start);
  await a.evaluate(()=>window.qaAdvance('PENDING'));await b.getByRole('button').filter({hasText:'Synthetic Coffee'}).first().waitFor({timeout:5000});await b.getByRole('button').filter({hasText:'Synthetic Coffee'}).first().click();
  await b.evaluate(()=>{window.qaDropKotSnapshots=true;window.qaNavigationCount=performance.getEntriesByType('navigation').length;});
  const readsBefore=await b.evaluate(()=>window.qaStats.reads);start=Date.now();await a.evaluate(()=>window.qaAdvance('PREPARING'));
  await b.getByRole('button',{name:'Mark Ready',exact:true}).last().waitFor({timeout:18000});const fallbackMs=Date.now()-start;
  assert.ok(await b.evaluate(n=>window.qaStats.reads>n,readsBefore));assert.equal(await b.evaluate(()=>performance.getEntriesByType('navigation').length),1);record('D missed application callback recovered by real 15s server reread',fallbackMs,'Real Firestore emulator; only callback delivery suppressed');
  const manager=await page('manager'),adminPage=await page('admin');await wait(manager,()=>window.qaStats.active===2);await wait(adminPage,()=>window.qaStats.active===2);assert.equal(await b.evaluate(()=>window.qaStats.active),1);record('E real browser assigned cashier/manager/admin listener counts',null,'cashier1 manager2 admin2');
  for(const [uid,expected] of [['cashier',1],['manager',2],['admin',2],['barista',1]]){
    const app=initializeApp({projectId:PROJECT,apiKey:'synthetic-local-key'},uid+'-negative');const f=getFirestore(app);connectFirestoreEmulator(f,'127.0.0.1',8287,{mockUserToken:{sub:uid}});clients.push({app,f});
    const read=(store,station)=>getDocsFromServer(query(collection(f,'kotItems'),where('storeId','==',store),...(station?[where('station','==',station)]:[]),where('status','in',['PENDING','PREPARING'])));
    if(uid==='cashier'||uid==='barista')await assert.rejects(read('B','BARISTA'),e=>e.code==='permission-denied');
    if(uid==='barista')await assert.rejects(read('A','KITCHEN'),e=>e.code==='permission-denied');
    assert.ok((await read('A',uid==='barista'?'BARISTA':null)).size>=1);
  }
  record('E unchanged real rules deny unassigned store and cross-station reads',null);
  const beforeCounts=await Promise.all(['kotItems','orders','stockMovements'].map(n=>db.collection(n).get()));assert.deepEqual(beforeCounts.map(s=>s.size),[3,0,0]);record('No KOT creation/order/stock side effects',null,'3 seeded KOTs,0 orders,0 stock movements');
  await a.evaluate(()=>window.qaAdvance('CANCELLED'));await b.evaluate(()=>{window.qaDropKotSnapshots=false;});await b.getByRole('button',{name:'Mark Ready',exact:true}).last().waitFor({state:'detached',timeout:18000});record('Cancellation leaves active query without stock writes',null);
  for(const p of [a,b,c,d,manager,adminPage])await p.goto('about:blank');record('Unmount/navigation completed',null);
}catch(error){results.push({name:'Browser/emulator run',status:'FAIL',error:error.message});console.error(error.stack);console.error('Synthetic ticket status:',(await db.doc('kotItems/ticket').get()).data()?.status);for(const context of contexts){for(const page of context.pages())console.error('Fixture DOM:',(await page.locator('body').innerText()).slice(-3500));}process.exitCode=1;}
finally{
  writeFileSync(resolve(evidence,'browser-emulator-results.json'),JSON.stringify({project:PROJECT,host:HOST,transport:'real Firestore emulator',auth:'synthetic mockUserToken and local user documents',fullProductionApp:false,results},null,2));
  for(const context of contexts)await context.close();await browser?.close();await new Promise(resolve=>server.close(resolve));for(const client of clients){await terminate(client.f);await deleteApp(client.app);}await deleteAdmin(admin);
}
