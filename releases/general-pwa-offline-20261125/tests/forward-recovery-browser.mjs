import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {stationChannel} from '../tools/coffee-bond-print-station/desktop/till-channel.mjs';
const root=path.resolve(import.meta.dirname,'..'), staff=path.join(root,'staff'), legacy=path.resolve(root,'../table-checkout-corrections-20261124/staff');
const require=createRequire(path.join(staff,'package.json'));
const {chromium}=createRequire('/Users/narendrashukla/.npm/_npx/e41f203b7505f1fb/package.json')('playwright');
const sector='L0qB13uuPxHvv089YtGQ',uid='forward-recovery-fixture',origin='http://127.0.0.1:45708',stationId='synthetic-authorized-station';
const server=crypto.generateKeyPairSync('ec',{namedCurve:'P-256'}),station=crypto.generateKeyPairSync('ed25519');
const stationPem=station.publicKey.export({type:'spki',format:'pem'}),pin=crypto.createHash('sha256').update(station.publicKey.export({type:'spki',format:'der'})).digest('hex');
const stable=v=>Array.isArray(v)?'['+v.map(stable).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}':JSON.stringify(v??null);
const ui=`
  import React,{useState,useEffect} from 'react';import {createRoot} from 'react-dom/client';
  import PosOfflineStatus from './components/pos/PosOfflineStatus';
  import {usePosOfflineCash} from './lib/offline/usePosOfflineCash';
  import * as print from './lib/offline/localPrint';import * as backup from './lib/offline/recoveryFile';
  function ManualSetupProbe(){
    const controller=usePosOfflineCash({online:true,store:{id:'${sector}',isActive:true},staffProfile:{
      uid:'${uid}',role:'STORE_MANAGER',isActive:true,assignedStoreIds:['${sector}']}});
    useEffect(()=>{if(controller.snapshot)window.fixture.manualProbe={canPrepare:controller.canPrepare,ready:controller.sessionReady};},[controller.snapshot,controller.canPrepare,controller.sessionReady]);
    return <PosOfflineStatus online={true} cashAvailable={controller.sessionReady} entries={controller.entries} pendingCheckout={false}
      syncing={false} onSync={()=>{}} prepare={controller.canPrepare?{busy:false,onPrepare:controller.prepare}:undefined}/>;
  }
  Object.assign(window.fixture,{print,backup,mountManualSetup:()=>{
    const host=document.createElement('aside');host.id='manual-setup-probe';document.body.appendChild(host);
    createRoot(host).render(<ManualSetupProbe/>);
  }});
  function Screen(){const [rows,setRows]=useState([]);const reload=async()=>setRows(await journal.entries());
    useEffect(()=>{void reload();},[]);
    return <PosOfflineStatus online={true} cashAvailable={false} pendingCheckout={false} storeId="${sector}" entries={rows}
      syncing={false} onSync={async()=>{await journal.synchronize();await reload();}} canReconcile
      onReconcile={async(e,reason)=>{await journal.reconcile(e,reason);await reload();}}/>;
  }createRoot(document.getElementById('root')).render(<Screen/>);`;
async function compile(mode){
 const env={VITE_TILL_RECOVERY_ONLY:String(mode==='recovery'),VITE_OFFLINE_LOCAL_ONLY:'true',VITE_FIREBASE_PROJECT_ID:'demo-coffee-bond-offline',
   VITE_TILL_TEST_STATION_ID:stationId,VITE_TILL_TEST_STATION_PIN:pin,VITE_TILL_TEST_PRINT_PORT:'45709'};
 const dir=mode==='legacy'?legacy:staff;
 const out=await require('esbuild').build({stdin:{contents:"import * as journal from './lib/offline/journal';window.fixture={journal};"+(mode==='legacy'?'':ui),
   resolveDir:path.join(dir,'frontend'),loader:'tsx'},jsx:'automatic',write:false,bundle:true,format:'iife',nodePaths:[path.join(staff,'node_modules')],
   define:{'import.meta.env':JSON.stringify(env),'process.env.NODE_ENV':'"production"'},plugins:[{name:'demo-callables',setup(b){
   b.onResolve({filter:/^firebase\/functions$|\/firebase$/},a=>({path:a.path,namespace:'fixture'}));
   b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const auth={currentUser:{uid:'${uid}',getIdToken:async()=>''}},functions={};export const httpsCallable=()=>async input=>({data:await window.fixtureCall(input)});`}));
 }}]});return out.outputFiles[0].text;
}
const [oldCode,activeCode,recoveryCode]=await Promise.all(['legacy','active','recovery'].map(compile));
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-background-networking']});
const cases=[];
try{
 for(const version of ['V1','legacy']){
  const page=await browser.newPage();page.setDefaultTimeout(8000);
  const errors=[],actions=[],printActions=[],wireActions=[],syncs=[],status=new Map();page.on('pageerror',e=>errors.push(e.message));
  let recovery=false,receiptId,signatureKey;
  await page.exposeFunction('fixtureCall',async data=>{
   actions.push({action:data.action,id:data.payload?.id});
   if(data.action==='PREPARE'){
    assert(!recovery);const now=Date.now();
    const snapshot={id:crypto.randomUUID(),uid,storeId:sector,storeName:'Synthetic counter',role:'STORE_MANAGER',deviceId:data.deviceId,issuedAt:now,expiresAt:now+3600000,
     discountLimit:20,excluded:[],tables:[],legal:{tradeName:'Synthetic',gstRegistered:true},gst:{mode:'GST'},
     menu:[{id:'cake',name:'Fixture cake',request:{parentProductCode:'CAKE',selectedAddOns:[]},canonical:{parentProductCode:'CAKE',baseUnitPrice:100,addOnTotal:0,addOns:[],taxRate:5}}]};
    if(version==='V1')Object.assign(snapshot,{tableWorkflowVersion:1,tableOwnership:{deviceId:data.deviceId,storeId:sector},tableBoard:{enabled:true,complete:true,enableNewSessions:true,tables:[{tableId:'table',label:'Fixture table',activeSessionId:null}]},tableSessions:[],printStationId:stationId,printStationPublicKey:stationPem});
    return {snapshot,signature:crypto.sign('sha256',Buffer.from(stable(snapshot)),{key:server.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64'),publicKey:server.publicKey.export({format:'jwk'})};
   }
   assert(recovery);assert(crypto.verify('sha256',Buffer.from(stable(data.payload)),{key:signatureKey,dsaEncoding:'ieee-p1363'},Buffer.from(data.signature,'base64')));
   if(data.action==='STATUS')return status.get(data.payload.id)||{status:'NOT_FOUND'};
   if(data.action==='SYNC'){syncs.push(data.payload.id);const result={status:'SYNCED',result:{orderId:data.payload.table?.orderId||'legacy',orderNumber:'SYNTHETIC-OK'}};status.set(data.payload.id,result);return result;}
   if(data.action==='RECONCILE'){assert.equal(version,'legacy');assert.equal(data.payload.id,receiptId);assert.equal(data.reason,'Verified synthetic receipt');return {status:'SYNCED',result:{orderNumber:'SYNTHETIC-REVIEWED'}};}
   throw Error('Unexpected operation '+data.action);
  });
  const stationWire=stationChannel({client:{state:{stationId,storeId:sector,privateKey:station.privateKey}},
   handle:async(action,nonce,body)=>{
    printActions.push(action);
    let result={state:'READY',snapshotId:body.snapshotId||body.snapshot?.id};
    if(action==='print'){
      assert(!recovery);const e=body.entry,ch=e.payload.kind==='TABLE_ROUND'?['KITCHEN','BARISTA']:['RECEIPT'];
      result={entryId:e.id,state:'OUTCOME_UNCERTAIN',jobs:ch.map(channel=>({channel,id:e.id+'-'+channel,state:channel==='KITCHEN'?'SPOOLED':'OUTCOME_UNCERTAIN'}))};
    }else assert.equal(action,'ready');
    return {result,signature:crypto.sign(null,Buffer.from(stable({protocol:'coffee-bond/till-print/1',action,nonce,result})),station.privateKey).toString('base64')};
   }});
  await page.route('**/*',async r=>{
   const u=new URL(r.request().url());if(u.port==='45709'){
    const wire=r.request().postDataJSON();wireActions.push(wire.action);
    assert.equal('body' in wire,false);
    if(wire.action!=='hello'){assert(wire.box?.ciphertext);assert(wire.box?.iv);}
    const response=await stationWire(wire);
    return r.fulfill({contentType:'application/json',headers:{'access-control-allow-origin':origin},body:JSON.stringify(response)});
   }
   assert.equal(u.origin,origin);
   return u.pathname==='/app.js'?r.fulfill({body:recovery?recoveryCode:version==='legacy'?oldCode:activeCode,contentType:'text/javascript'}):
      r.fulfill({body:'<div id="root"></div><script src="/app.js"></script>',contentType:'text/html'});
  });
  try{
   await page.goto(origin);const original=await page.evaluate(async({version,sector})=>{
    const j=fixture.journal,s=await j.prepare(sector),publicKey=(await j.getMeta('device')).publicKey;
    if(version==='legacy'){
     await j.saveCash(s,[{productId:'cake',quantity:1}],0,120,undefined,['legacy-1']);
     await j.saveCash(s,[{productId:'cake',quantity:2}],0,220,undefined,['legacy-2']);
    }else{
     await j.saveTableOperation(s,{action:'OPEN',opId:'open-original',sessionId:'sess-original',tableId:'table'});
     const round=await j.saveTableOperation(s,{action:'SEND',opId:'round-original',sessionId:'sess-original',version:1,
      draft:[{orderItemId:'line-original',parentProductId:'cake',quantity:1,selectedAddOns:[]}]});
     await fixture.print.printSavedEntry(round);
     const cash=await j.saveTableOperation(s,{action:'CASH',opId:'cash-original',sessionId:'sess-original',version:2,cashReceived:110,discountPercent:0});
     await fixture.print.printSavedEntry(cash);
    }
    return {publicKey,entries:await j.entries()};
   },{version,sector});
   signatureKey=crypto.createPublicKey({key:original.publicKey,format:'jwk'});
   const entries=original.entries.sort((a,b)=>a.payload.createdAt-b.payload.createdAt);
   status.set(entries[0].id,{status:'SYNCED',result:{orderNumber:'SYNTHETIC-ACCEPTED'}});
   receiptId=entries.at(-1).id;
   if(version==='legacy')status.set(receiptId,{status:'CONFLICT',conflicts:['FIXTURE_GST_MISMATCH']});
   const before=actions.length,printed=printActions.length;
   recovery=true;await page.reload();
   const blocked=await page.evaluate(async ({sector,version})=>{
    const j=fixture.journal,s=await j.getMeta('snapshot');
    await j.verifySnapshotForRead(s);const healthy=version==='V1'?await fixture.print.hasLocalPrintAuthority(s):null;
    const requests=[()=>j.prepare(sector),()=>j.usable(s),()=>j.saveCash(s,[{productId:'cake',quantity:1}],0,120),
     ...['OPEN','SEND','CASH'].map(action=>()=>j.saveTableOperation(s,{action,opId:'fresh-'+action,sessionId:'sess-new',tableId:'table',version:0}))];
    const failures=[];for(const req of requests)try{await req();failures.push('allowed');}catch(e){failures.push(e.message);}
    const backup=JSON.parse(await (await fixture.backup.exportRecoveryFile(sector)).text());
    return {healthy,mode:j.tillRecoveryOnly,failures,backupIds:backup.backup.entries.map(e=>e.id).sort(),entries:await j.entries()};
   },{sector,version});
   assert(blocked.mode);assert.equal(blocked.healthy,version==='V1'?true:null);
   assert(blocked.failures.every(reason=>reason.includes('paused in this recovery release')));assert.equal(actions.length,before);
   assert.equal(printActions.includes('resume'),false);assert.equal(printActions.length-printed,version==='V1'?1:0);
   assert.deepEqual(blocked.backupIds,entries.map(e=>e.id).sort());
   const immutable=rows=>rows.map(({id,payload,signature})=>({id,payload,signature})).sort((a,b)=>a.id.localeCompare(b.id));
   assert.deepEqual(immutable(blocked.entries),immutable(entries));
   await page.getByRole('button',{name:/Syncing .*|Needs reconciliation/i}).first().click();
   const row=id=>page.locator('li').filter({hasText:id});
   if(version==='V1'){
    for(const [id,tokens] of [['round-original',['KITCHEN · SPOOLED · round-original-KITCHEN','BARISTA · OUTCOME_UNCERTAIN · round-original-BARISTA']],['cash-original',['RECEIPT · OUTCOME_UNCERTAIN · cash-original-RECEIPT']]]){
     await row(id).getByText('Local print status').click();
     for(const token of tokens)await row(id).getByText(token,{exact:false}).waitFor();
    }
   }
   await row(receiptId).getByRole('button',{name:'View offline receipt'}).click();
   await page.getByText('PROVISIONAL OFFLINE CASH RECEIPT',{exact:true}).waitFor();
   assert.match(await page.locator('.offline-receipt').innerText(),new RegExp(version==='V1'?'105.00':'210.00'));
   await page.getByRole('button',{name:'Back to journal'}).click();
   await page.getByRole('button',{name:'Check status and sync'}).click();
   const waitForRows=async predicate=>{
     const until=Date.now()+8000;let rows;
     do{rows=await page.evaluate(()=>fixture.journal.entries());if(rows.length===entries.length && rows.every(predicate))return rows;
       await new Promise(resolve=>setTimeout(resolve,60));
     }while(Date.now()<until);throw Error('Original outcomes unavailable: '+JSON.stringify(rows.map(e=>[e.id,e.status,e.error])));
   };
   await waitForRows(e=>e.status==='SYNCED'||e.status==='CONFLICT');
   if(version==='legacy'){
    await row(receiptId).getByRole('button',{name:'Manager reconciliation'}).click();
    await page.getByLabel('Reason for honoring the original Cash and financial snapshot').fill('Verified synthetic receipt');
    await page.getByRole('button',{name:'Submit review'}).click();
    await waitForRows(e=>e.status==='SYNCED');
   }
   const final=await page.evaluate(()=>fixture.journal.entries());assert.deepEqual(immutable(final),immutable(entries));
   assert(!syncs.includes(entries[0].id));assert.deepEqual(syncs,version==='V1'?['round-original','cash-original']:[]);
   await page.evaluate(()=>fixture.mountManualSetup());
   await page.waitForFunction(()=>window.fixture.manualProbe!==undefined);
   assert.deepEqual(await page.evaluate(()=>fixture.manualProbe),{canPrepare:false,ready:false});
   assert.equal(await page.locator('#manual-setup-probe button').filter({hasText:'Prepare for offline Cash'}).count(),0);
   assert.equal(actions.slice(before).filter(a=>a.action==='PREPARE').length,0);
   const handshakes=wireActions.filter(a=>a==='hello').length;
   assert.equal(handshakes,printActions.length);
   assert.deepEqual(errors,[]);
   cases.push({version,originalIds:entries.map(e=>e.id),signedRowsRetained:final.length,operationsBlocked:blocked.failures.length,readyStation:blocked.healthy,
      stationResumeCalls:0,newPrepareCalls:0,authenticatedStationHandshakes:handshakes,manualPreparationOffered:false,originalLookupCalls:actions.slice(before).filter(a=>a.action==='STATUS').length,syncs,managerReconciled:version==='legacy',receipt:receiptId,individualPrintStates:version==='V1'?['KITCHEN SPOOLED','BARISTA OUTCOME_UNCERTAIN','RECEIPT OUTCOME_UNCERTAIN']:[],autoReprints:0});
   console.log('PASS',version,'producer to recovery-only cold browser');
  }catch(e){console.error(version,errors,await page.locator('body').innerText());throw e;}finally{await page.close();}
 }
 fs.writeFileSync(path.join(root,'evidence/forward-recovery-browser.json'),JSON.stringify({environment:'Cold Chromium reload. Original A legacy/B V1 code produces signed entries. Recovery build folds VITE_TILL_RECOVERY_ONLY=true; actual journal rendering, WebCrypto and IndexedDB. Fixture callables and spool outcomes; production authenticated Station channel and browser transport.',cases},null,2)+'\n');
}finally{await browser.close();}
