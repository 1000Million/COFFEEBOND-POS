import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const root=path.resolve(import.meta.dirname,'..'),staff=path.join(root,'staff'),require=createRequire(path.join(staff,'package.json'));
const {chromium}=createRequire('/Users/narendrashukla/.npm/_npx/e41f203b7505f1fb/package.json')('playwright');
const stub={
 firebase:"export const auth={currentUser:{uid:'fixture',getIdToken:async()=>null}},functions={},db={};window.fixtureAuth=auth;",
 functions:"export const httpsCallable=(_,name)=>async input=>({data:await window.fake(name,input)});",
 firestore:"export const where=()=>{},query=()=>{},collection=()=>{},onSnapshot=()=>()=>{},doc=()=>{},getDocFromServer=async()=>({exists:()=>true,data:()=>({enabled:true})});",
 AuthContext:"export const useAuth=()=>({staffProfile:{uid:'fixture',role:'CASHIER'}});",
 KitchenBadges:"export default ()=>null;",
 complimentaryPhoneVerification:"export const complimentaryRecaptchaContainerId=()=>'fixture',disposeComplimentaryPhoneVerification=()=>{},complimentaryPhoneErrorMessage=e=>e.message,complimentaryPhoneErrorCode=()=>'',sendComplimentaryPhoneOtp=()=>{throw Error('Online only')},verifyComplimentaryPhoneOtp=()=>{throw Error('Online only')};",
};
const bundle=await require('esbuild').build({entryPoints:[path.join(import.meta.dirname,'table-journal-fixture.tsx')],bundle:true,jsx:'automatic',write:false,nodePaths:[path.join(staff,'node_modules')],loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{}'},plugins:[{name:'fake-transports',setup(build){
 build.onResolve({filter:/^firebase\/(firestore|functions)$|\/(firebase|AuthContext|KitchenBadges|complimentaryPhoneVerification)$/},args=>({path:args.path.split('/').pop(),namespace:'fixture'}));
 build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:stub[args.path]}));
}}]});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-background-networking']});
const page=await browser.newPage(),cases=[],errors=[];
page.setDefaultTimeout(7000);page.on('pageerror',e=>{errors.push(e.message);console.log(e.message);});
const origin='http://127.0.0.1:45703';
const worker=fs.readFileSync(path.join(staff,'public/sw.js'),'utf8');
const updateAllowed=()=>page.evaluate(source=>new Function('self',source+';return journalAllowsUpdate();')({addEventListener(){}}),worker);
await page.route('**/*',r=>{const u=new URL(r.request().url());assert.equal(u.origin,origin);
 return u.pathname==='/app.js'?r.fulfill({body:bundle.outputFiles[0].text,contentType:'text/javascript'}):r.fulfill({body:'<main id="root"></main><script src="/app.js"></script>',contentType:'text/html'});
});
const mark=n=>{cases.push(n);console.log('PASS',n);};
const select=async name=>{const input=page.getByRole('combobox',{name:'Choose table'});await input.click();await page.getByRole('option',{name:new RegExp(name)}).click();};
try{
 await page.goto(origin);await page.waitForFunction(()=>window.fixture?.cash?.tableReady);
 assert.equal(await page.evaluate(()=>fixture.calls.filter(c=>c.action==='PREPARE').length),1);
 assert(!await page.evaluate(()=>fixture.calls.some(c=>['DETAIL','REGISTER'].includes(c.action))));
 assert.equal(await updateAllowed(),true);
 const prepared=await page.evaluate(()=>({preparedAt:fixture.cash.snapshot.issuedAt,lastSync:fixture.cash.lastSuccessfulSync,scope:fixture.cash.snapshot.storeId}));
 assert.equal(prepared.scope,'fixture-general-store-42');assert.equal(prepared.lastSync,prepared.preparedAt);
 mark('Auto-PREPARE of signed general store, displayed last sync is the successful preparation; no enrollment or individual detail reads');
 await select('Online policy');await page.waitForFunction(()=>fixture.table.session?.id==='online-test'&&fixture.table.operationalReady);
 for(const tender of ['CASH','UPI','CARD','Split'])await page.getByRole('button',{name:tender,exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'COMP',exact:true}).count(),0);
 assert.equal(await page.evaluate(()=>fixture.table.complimentarySupported),false);
 mark('General online configured table displays actually permitted manual tenders and split without an unsupported complimentary grant');
 await page.getByRole('button',{name:'Simulate outage'}).click();await page.getByText('Offline ready',{exact:true}).waitFor();
 await select('Incomplete');await page.getByText(/Saved details for this table are unavailable/).waitFor();
 assert.equal(await page.getByRole('button',{name:'Open Table'}).count(),0);
 await select('Uncertain');assert(await page.getByRole('combobox',{name:'Type item name or code'}).isDisabled());
 assert.equal(await page.getByRole('region',{name:'Offline Cash payment'}).count(),0);
 mark('Missing detail remains occupied, existing uncertain payment blocks Cash and edits');
 await select('Openable');await page.getByRole('button',{name:'Open Table'}).click();
 await page.waitForFunction(()=>fixture.table.session?.localPending);
 const id=await page.evaluate(()=>fixture.table.session.id);
 const item=page.getByRole('combobox',{name:'Type item name or code'});await item.fill('Cake');await page.getByRole('option',{name:/Fixture Cake/}).click();
 await page.getByRole('button',{name:'Increase unsent 1'}).click();
 await page.getByRole('button',{name:'Note',exact:true}).click();await page.getByLabel('Local note',{exact:true}).fill('synthetic kitchen reminder');
 await page.getByRole('button',{name:'Save round locally'}).click();await page.getByText(/This till cannot send a note/).waitFor();
 assert.equal((await page.evaluate(()=>fixture.journal.entries())).length,1);
 assert.equal(await page.getByLabel('Local note',{exact:true}).inputValue(),'synthetic kitchen reminder');
 await page.getByLabel('Local note',{exact:true}).fill('');await page.getByRole('button',{name:'Save round locally'}).click();
 mark('Unsupported kitchen note stays in the editor and blocks offline Send');
 await page.waitForFunction(()=>fixture.table.session?.outstanding===210);
 const events=await page.evaluate(()=>fixture.journal.entries());
 const opened=events.find(e=>e.payload.kind==='TABLE_OPEN'),round=events.find(e=>e.payload.kind==='TABLE_ROUND');
 assert.equal(round.payload.predecessorId,opened.id);assert.deepEqual(round.payload.table,{id,orderId:'TABLE_'+id,tableId:'t1',version:1});
 assert.equal(round.payload.roundLines[0].quantity,2);assert.equal(round.payload.totals.taxTotal,10);
 mark('Open and edit a new running bill; signed round retains original item, order, version and GST');
 const protections=await page.evaluate(async()=>{
  const {cash,table,journal,repo}=fixture, snapshot=cash.snapshot,session=table.session,draft={orderItemId:'x',parentProductId:'fixture-cake',quantity:1,selectedAddOns:[]};
  const opts={action:'SEND',sessionId:session.id,version:2,opId:'invalid',draft:[{...draft,selectedAddOns:[{groupId:'g',optionId:'o',quantity:1}]}]};
  const reject=async task=>{try{await task();return false;}catch{return true;}};
  const rows=await journal.entries(),conflicted=rows.map(e=>e.payload.kind==='TABLE_ROUND'?{...e,status:'CONFLICT'}:e);
  const view=repo.projectTables(snapshot,conflicted).sessions.get(session.id);
  return {stale:await reject(()=>journal.saveTableOperation(snapshot,{...opts,version:1,draft:[draft]})),
   addOn:await reject(()=>journal.saveTableOperation(snapshot,opts)),cash:await reject(()=>journal.saveCash(snapshot,[],11,210,session)),
   conflict:view.localConflict&&view.outstanding===210,empty:repo.projectTables({...snapshot,tableBoard:{...snapshot.tableBoard,tables:[]}},[]).board.tables.length,
   incomplete:repo.projectTables({...snapshot,tableBoard:{...snapshot.tableBoard,complete:false}},[])};
 });
 assert.deepEqual(protections,{stale:true,addOn:true,cash:true,conflict:true,empty:0,incomplete:null});
 mark('Stale version, add-on and over-limit discount rejected; conflict preserves local line totals; genuine empty board distinguished');
 await page.getByLabel('Cash received',{exact:true}).fill('220');await page.getByRole('button',{name:'Cash received · Save bill'}).click();
 await page.waitForFunction(()=>fixture.table.session?.localCash);
 const saved=await page.evaluate(async()=>{const rows=await fixture.journal.entries();return rows.find(e=>e.payload.kind==='TABLE_CASH');});
 assert.equal(saved.payload.totals.grandTotal,210);assert.equal(saved.payload.receipt.items[0].quantity,2);assert.equal(saved.payload.predecessorId,round.id);
 assert.equal(saved.payload.table.orderId,'TABLE_'+id);assert.equal(await page.evaluate(()=>fixture.calls.filter(c=>c.method==='tableService'&&!['BOARD','DETAIL'].includes(c.action)).length),0);
 assert.equal(await updateAllowed(),false);
 mark('Cash settlement uses original round, signed provisional receipt, zero cloud writes');
 await page.evaluate(()=>fixture.setStore('foreign-store'));
 await page.waitForFunction(()=>!fixture.cash.snapshot && !fixture.cash.entries.length);
 await page.evaluate(()=>fixture.setStore(fixture.storeId));await page.waitForFunction(()=>fixture.cash.snapshot?.storeId===fixture.storeId);
 await page.evaluate(()=>{fixtureAuth.currentUser.uid='other-cashier';fixture.setUid('other-cashier');});
 await page.waitForFunction(()=>!fixture.cash.snapshot && !fixture.cash.entries.length);
 await page.evaluate(()=>{fixtureAuth.currentUser.uid='fixture';fixture.setUid('fixture');});
 await page.waitForFunction(()=>fixture.cash.entries.length===3);
 mark('Changing the selected store or signed-in user does not disclose the other scope’s journal or signed menu');
 await page.reload();await page.waitForFunction(()=>fixture.table.session?.localCash);
 assert(await page.getByRole('combobox',{name:'Type item name or code'}).isDisabled());assert.equal(await page.evaluate(()=>fixture.cash.tableReady),false);
 assert.equal((await page.evaluate(()=>fixture.journal.entries())).length,3);
 assert.equal(await updateAllowed(),false);
 mark('Restart recovers signed operations and projected receipt; new billing remains locked');
 const syncOutcomes=await page.evaluate(async()=>{
   const ack=new Map(),submitted=[];
   let mode='dependency';
   window.fake=async(method,req)=>{
     if(method!=='offlineCash')throw Error('Unexpected transport');
     const id=req.payload.id;
     if(req.action==='STATUS')return ack.get(id)||{status:'NOT_FOUND'};
     if(req.action!=='SYNC')throw Error('Unexpected command');
     submitted.push(id);
     if(mode==='dependency')return {status:'DEPENDENCY_PENDING'};
     if(mode==='unknown')return {status:'UNRECOGNIZED_FIXTURE'};
     const result={status:'SYNCED',result:{orderId:req.payload.table.orderId}};ack.set(id,result);return result;
   };
   await fixture.journal.synchronize();
   const waiting=(await fixture.journal.entries()).find(e=>e.payload.kind==='TABLE_OPEN');
   mode='unknown';await fixture.journal.synchronize();
   const uncertain=(await fixture.journal.entries()).find(e=>e.payload.kind==='TABLE_OPEN');
   mode='accepted';await fixture.journal.synchronize();
   return {waiting:waiting.status,waitReason:!!waiting.pendingReason,unknown:uncertain.status,unknownReason:!!uncertain.error,
    states:(await fixture.journal.entries()).map(e=>e.status),submitted};
 });
 assert.equal(syncOutcomes.waiting,'PENDING');assert(syncOutcomes.waitReason);assert.equal(syncOutcomes.unknown,'UNCERTAIN');
 assert(syncOutcomes.unknownReason);assert(syncOutcomes.states.every(status=>status==='SYNCED'));
 assert.deepEqual(syncOutcomes.submitted,[opened.id,opened.id,opened.id,round.id,saved.id]);
 mark('Dependency delays and unknown server replies preserve allowable states and replay original open, round and Cash in order');
 assert.equal(await updateAllowed(),true);mark('Waiting worker checks persisted entries before explicit takeover, including after browser restart');
 assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(root,'evidence/table-journal-browser.json'),JSON.stringify({environment:'Synthetic Chromium, real React components, IndexedDB, Web Locks, Web Crypto; callable transports stubbed',cases},null,2)+'\n');
}catch(e){console.error(await page.locator('body').innerText().catch(()=>''));throw e;}finally{await browser.close();}
