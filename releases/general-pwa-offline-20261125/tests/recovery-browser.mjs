import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {createRequire} from 'node:module';

const root=path.resolve(import.meta.dirname,'..');
const require=createRequire(path.join(root,'staff/package.json'));
const {chromium}=createRequire('/Users/narendrashukla/.npm/_npx/e41f203b7505f1fb/package.json')('playwright');
const bundle=await require('esbuild').build({
  stdin:{contents:`
    import * as journal from './journal';
    import * as recovery from './recoveryFile';
    import * as storage from './storage';
    import {auth} from '../firebase';
    window.test={...journal,...recovery,...storage,auth};`,
    resolveDir:path.join(root,'staff/frontend/lib/offline')},
  plugins:[{name:'local-only',setup(build){
    build.onResolve({filter:/^\.\.\/firebase$|^firebase\/functions$/},args=>({path:args.path,namespace:'synthetic'}));
    build.onLoad({filter:/.*/,namespace:'synthetic'},()=>({contents:"export const auth={currentUser:{uid:'fixture-staff'}}; export const functions={}; export const httpsCallable=()=>{throw Error('No network in journal tests')};"}));
  }}],
  define:{'import.meta.env':'{}'},bundle:true,write:false,format:'iife',platform:'browser'
});
const server=http.createServer((req,res)=>{
  if(req.url==='/app.js'){res.setHeader('content-type','text/javascript');res.end(bundle.outputFiles[0].contents);}
  else {res.setHeader('content-type','text/html');res.end('<script src="/app.js"></script>');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-background-networking']});
const cases=[];
try {
 const context=await browser.newContext();
 const url='http://127.0.0.1:'+server.address().port;
 const [a,b]=await Promise.all([context.newPage(),context.newPage()]);
 await Promise.all([a.goto(url),b.goto(url)]);
 const [d1,d2]=await Promise.all([a.evaluate(()=>test.deviceIdentity()),b.evaluate(()=>test.deviceIdentity())]);
 assert.deepEqual(d1,d2);cases.push('Concurrent tabs use one durable nonextractable device key');
 const file=await a.evaluate(async()=>{
   const d=await test.getMeta('device');
   if(d.privateKey.extractable) throw Error('Private key is extractable');
   const p={storeId:'fixture',uid:'fixture-staff',id:'fixture-1',deviceId:d.id,createdAt:1200,receipt:{items:[]},totals:{grandTotal:105},paymentMethod:'CASH'};
   const signature=await test.sign(p);
   await test.transaction(['entries','closures'],'readwrite',(tx,done)=>{
     tx.objectStore('entries').add({id:p.id,payload:p,signature,status:'PENDING'});
     tx.objectStore('closures').add({id:'fixture-draft',offlineId:p.id});done();
   });
   return (await test.exportRecoveryFile('fixture')).text();
 });
 const data=JSON.parse(file);assert.deepEqual(Object.keys(data.backup).sort(),['captures','deviceId','entries','format','storeId','uid']);
 assert(!/privateKey|snapshotProof|keyFingerprint/.test(file));cases.push('Signed backup contains the original operation and capture without a device secret or new authorization');
 const result=await a.evaluate(async file=>{
   const restore=()=>test.importRecoveryFile('fixture',file);
   const erase=(stores,callback)=>test.transaction(stores,'readwrite',(tx,done)=>{callback(tx);done();});
   const same=await restore();
   await erase(['entries','closures'],tx=>{tx.objectStore('entries').delete('fixture-1');tx.objectStore('closures').put({id:'fixture-draft',offlineId:'other-op'});});
   let conflict='';try{await restore();}catch(e){conflict=e.message;}
   const atomic=(await test.entries()).length===0;
   await erase(['closures'],tx=>tx.objectStore('closures').delete('fixture-draft'));
   const count=await restore(), row=(await test.entries())[0], again=await restore();
   const changed=JSON.parse(file);changed.backup.entries[0].payload.totals.grandTotal=0;
   let invalid='';try{await test.importRecoveryFile('fixture',JSON.stringify(changed));}catch(e){invalid=e.message;}
   test.auth.currentUser={uid:'other'};
   let owner='';try{await restore();}catch(e){owner=e.message;}
   test.auth.currentUser=null;
   let loggedOut='';try{await test.exportRecoveryFile('fixture');}catch(e){loggedOut=e.message;}
   return {same,conflict,atomic,count,row,again,invalid,owner,loggedOut};
 },file);
 assert.equal(result.same,0);assert.equal(result.again,0);assert.equal(result.count,1);assert.equal(result.row.status,'UNCERTAIN');
 assert.deepEqual(result.row.payload,data.backup.entries[0].payload);assert.equal(result.row.signature,data.backup.entries[0].signature);
 assert.match(result.conflict,/another saved operation/);assert.equal(result.atomic,true);
 assert.match(result.invalid,/signature/);assert.match(result.owner,/different till, store or staff/);assert.match(result.loggedOut,/Sign in/);
 cases.push('Overlapping backups merge once; missing original enters uncertain status with its exact signature',
   'Conflicting capture aborts every staged record','Changed archive, wrong staff and signed-out export are refused');
 await a.reload();assert.equal(await a.evaluate(async()=>(await test.entries())[0].id),'fixture-1');
 const errors=await a.evaluate(async()=>{
   const oldOpen=IDBFactory.prototype.open;
   IDBFactory.prototype.open=function(){throw new DOMException('fixture denied','SecurityError');};
   let denied='';try{await test.entries();}catch(e){denied=e.message;}finally{IDBFactory.prototype.open=oldOpen;}
   const oldAdd=IDBObjectStore.prototype.add;
   IDBObjectStore.prototype.add=function(value){
     if(this.name==='entries')throw new DOMException('fixture full','QuotaExceededError');
     return oldAdd.call(this,value);
   };
   let full='';try{
     await test.transaction(['entries','closures'],'readwrite',(tx,done)=>{
       tx.objectStore('closures').add({id:'unsaved-draft',offlineId:'unsaved'});
       tx.objectStore('entries').add({id:'unsaved'});done(true);
     });
   }catch(e){full=e.message;}finally{IDBObjectStore.prototype.add=oldAdd;}
   const capture=await test.transaction(['closures'],'readonly',(tx,done)=>{const q=tx.objectStore('closures').get('unsaved-draft');q.onsuccess=()=>done(q.result||null);});
   return {denied,full,capture,size:(await test.entries()).length,persistence:await test.persistenceStatus()};
 });
 assert.match(errors.denied,/storage access was denied/);assert.match(errors.full,/storage is full/);assert.equal(errors.capture,null);assert.equal(errors.size,1);
 cases.push('Reload preserves original record and marker','Denied storage gives an actionable error','Quota failure rolls back capture and entry together');
 const independent=await browser.newContext(),c=await independent.newPage();await c.goto(url);
 const different=await c.evaluate(async file=>{await test.device();try{await test.importRecoveryFile('fixture',file);}catch(e){return e.message;}},file);
 assert.match(different,/different till/);cases.push('A second browser profile cannot restore under a different device key');
 const report={status:'PASS',cases,storagePersistence:errors.persistence,environment:'Chromium, WebCrypto, native IndexedDB, synthetic local origin',productionWrites:0};
 fs.writeFileSync(path.join(root,'evidence/journal-recovery.json'),JSON.stringify(report,null,2)+'\n');
 console.log(report);
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
