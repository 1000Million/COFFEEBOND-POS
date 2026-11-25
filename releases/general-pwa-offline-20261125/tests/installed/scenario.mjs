import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {assignedStore,otherStore,sessionId} from './fixture.mjs';
const {chromium}=createRequire('/Users/narendrashukla/.npm/_npx/e41f203b7505f1fb/package.json')('playwright');
const evidence=process.env.QUAL_EVIDENCE_DIR || path.resolve(import.meta.dirname,'../../evidence/installed-pwa');
async function until(fn,label,ms=30000){
 const stop=Date.now()+ms;
 while(Date.now()<stop){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,150));}
 throw Error('Timed out checking '+label);
}
const readDB=async (p,store,key)=>p.evaluate(async ({store,key})=>{
 const db=await new Promise((r,j)=>{const req=indexedDB.open('coffee-bond-offline-cash-v1',1);req.onsuccess=()=>r(req.result);req.onerror=()=>j(req.error);});
 try{return await new Promise((r,j)=>{const s=db.transaction(store).objectStore(store),q=key?s.get(key):s.getAll();q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});}finally{db.close();}
},{store,key});
const entryRows=p=>readDB(p,'entries');
const button=(p,name)=>p.getByRole('button',{name,exact:typeof name==='string'}).first();
const info=p=>p.context().newCDPSession(p);
async function launched(context,cdp,url){
 await cdp.send('PWA.changeAppUserSettings',{manifestId:url,displayMode:'standalone'});
 const {targetId}=await cdp.send('PWA.launch',{manifestId:url});
 assert.equal((await cdp.send('Target.getTargetInfo',{targetId})).targetInfo.type,'tab');
 const page=await until(async()=>{
   for(const p of context.pages()){
     try{if(p.url().startsWith(new URL(url).origin) && await p.evaluate(()=>matchMedia('(display-mode: standalone)').matches))return p;}catch{}
   }
 },'installed manifest target');
 await page.waitForURL(u=>u.origin===new URL(url).origin);
 await page.bringToFront();return {page,targetId};
}
export async function run(r,mode='browser'){
 assert(['browser','managed'].includes(mode));
 const managed=mode==='managed';
 const cases=[], events=[], pageErrors=[],blockedRequests=new Set(),tabIds=new WeakMap();
 let nextTab=1;
 const startedAtUTC=new Date().toISOString();
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'cb-synthetic-installed-'));
 let context,p,cdp,clockFixture,installed=false,reachable=true,loseAck=true,phase='build';
 const setPhase=name=>{phase=name;console.log('PWA',name);};
 const mark=(test,actual)=>{cases.push({test,actual});console.log('PASS',test);};
 try{
   delete process.env.VITE_TILL_TEST_PRINT_PORT;
   delete process.env.VITE_TILL_TEST_STATION_ID;
   delete process.env.VITE_TILL_TEST_STATION_PIN;
   if(managed){
     const {prepareClockProfile}=await import('./clock-profile.mjs');
     clockFixture=await prepareClockProfile(profile,r.url,'http://127.0.0.1:'+r.ports.functions);
   }
   await r.build();
   async function openBrowser(witness=managed){
   const extensionArgs=managed&&witness?['--load-extension='+clockFixture.extensionDir,'--disable-extensions-except='+clockFixture.extensionDir]:[];
   const start=()=>chromium.launchPersistentContext(profile,{channel:managed?'chromium':'chrome',headless:false,viewport:null,env:{...process.env,CFFIXED_USER_HOME:profile},
     ...(extensionArgs.length?{ignoreDefaultArgs:['--disable-extensions']}:{}),
     args:[...extensionArgs,'--window-size=1560,1050','--disable-background-networking','--disable-component-update','--disable-sync','--no-default-browser-check','--no-proxy-server','--disk-cache-dir='+path.join(profile,'browser-cache'),'--disk-cache-size=2097152','--media-cache-size=1048576','--disable-gpu-shader-disk-cache','--disable-component-extensions-with-background-pages','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']});
   // Chrome performs a few macOS boot-volume allocations after its old browser process
   // exits. Retry only the clean launch when the OS explicitly reports a temporary disk error.
   const launchDeadline=Date.now()+120000;
   for(;;){
     try{context=await start();break;}
     catch(error){if(!/No space left on device|Failed to create socket directory/.test(String(error))||Date.now()>=launchDeadline)throw error;
       await new Promise(resolve=>setTimeout(resolve,2000));}
   }
   const ports=new Set([r.ports.app,r.ports.auth,r.ports.firestore,r.ports.functions].map(String));
   await context.route('**/*',async route=>{
     const req=route.request(),u=new URL(req.url());
     if(u.hostname!=='127.0.0.1'||!ports.has(u.port)){blockedRequests.add(u.hostname+':'+u.port);return route.abort();}
     if(!reachable && (u.port!==String(r.ports.app)||req.isNavigationRequest()))return route.abort('connectionfailed');
     if(req.method()==='POST' && u.pathname.endsWith('/offlineCash')){
       const data=req.postDataJSON()?.data;
       let tab='worker';try{const page=req.frame().page();if(!tabIds.has(page))tabIds.set(page,'tab-'+nextTab++);tab=tabIds.get(page);}catch{}
       events.push({action:data?.action,id:data?.payload?.id,tab});
       if(loseAck && data?.action==='SYNC' && data.payload?.kind==='TABLE_ROUND'){
         const response=await route.fetch();
         if((await response.json()).result?.status==='SYNCED'){loseAck=false;events.push({action:'FIXTURE_LOST_ACCEPTED_ACK',id:data.payload.id});return route.abort('connectionclosed');}
         return route.fulfill({response});
       }
     }
     return route.continue();
   });
   context.on('page',page=>page.on('pageerror',e=>pageErrors.push(e.message)));
   p=context.pages()[0];p.setDefaultTimeout(18000);
   }
   await openBrowser();
   const url=r.url+'/pos',account=r.accounts.CASHIER;
   setPhase('sign in and install');
   await p.goto(url);
   await p.getByLabel('Email Address').fill(account.email);await p.getByLabel('Password',{exact:true}).fill(account.password);
   await button(p,'Sign In to POS').click();await p.waitForURL(u=>u.pathname!='/login');
   await p.goto(url);await p.getByLabel('Select POS store').waitFor();
   cdp=await info(p);await cdp.send('PWA.install',{manifestId:url,installUrlOrBundleUrl:url});installed=true;
   const app=await launched(context,cdp,url);const installationPage=p;p=app.page;p.setDefaultTimeout(18000);await installationPage.goto('about:blank');
   const standalone=await p.evaluate(()=>matchMedia('(display-mode: standalone)').matches);
   const browserState=await cdp.send('PWA.getOsAppState',{manifestId:url});
   await p.evaluate(async()=>{await navigator.serviceWorker.ready;});
   mark('Installed and launched Staff manifest',{targetId:app.targetId,standalone,osState:browserState,platform:process.platform,chrome:(await cdp.send('Browser.getVersion')).product});
   setPhase('provision synthetic till');
   await p.goto(r.url+'/offline-cash?storeId='+assignedStore);
   await button(p,'Create / show device identity').click();
   await p.getByText('Device identity for approval',{exact:true}).waitFor();
   const identity=await p.evaluate(async()=>{
     const open=indexedDB.open('coffee-bond-offline-cash-v1',1),d=await new Promise((res,rej)=>{open.onsuccess=()=>{const db=open.result,get=db.transaction('meta').objectStore('meta').get('device');get.onsuccess=()=>{db.close();res(get.result.value);};get.onerror=()=>rej(get.error);};});
     const key=await crypto.subtle.importKey('jwk',d.publicKey,{name:'ECDSA',namedCurve:'P-256'},true,['verify']);
     const hash=await crypto.subtle.digest('SHA-256',await crypto.subtle.exportKey('spki',key));
     return {deviceId:d.id,keyFingerprint:[...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,'0')).join(''),publicKey:d.publicKey};
   });
   const {publicKey,...approvedDevice}=identity;
   await r.db.doc('offlinePilotPolicies/'+assignedStore).set({version:2,storeId:assignedStore,enabled:true,approval:{reference:'LOCAL-FIXTURE',approvedBy:'LOCAL-ONLY',approvedAt:Date.now()-1000},approvedStaff:[{uid:account.uid,role:'CASHIER'}],approvedDevice});
   await r.db.doc('offlineDevices/'+assignedStore).set({...identity,active:true,registeredBy:account.uid});
   await p.goto(url);
   await p.getByLabel('Select POS store').selectOption(assignedStore);
   await button(p,/Online — ready for an outage/).waitFor();
   const snapshot=(await readDB(p,'meta','snapshot')).value;
   assert(snapshot.tableSessions.some(s=>s.id===sessionId&&s.offlineEligible));assert.equal(snapshot.printStationId,undefined);assert.equal(snapshot.offlinePolicyVersion,2);assert.equal(snapshot.storeId,assignedStore);
   if(managed){
     const binding=await until(async()=>{
       const extension=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'+clockFixture.extensionId+'/'));
       if(!extension)return null;
       return extension.evaluate(async()=>{const {lease}=await chrome.storage.local.get('lease');return lease&&{snapshotId:lease.snapshotId,uid:lease.uid,storeId:lease.storeId,deviceId:lease.deviceId};}).catch(()=>null);
     },'authenticated clock binding in installed managed extension',25000);
     assert.deepEqual(binding,{snapshotId:snapshot.id,uid:snapshot.uid,storeId:snapshot.storeId,deviceId:snapshot.deviceId});
     mark('Real macOS clock broker bound to the server-prepared snapshot',{binding,extensionId:clockFixture.extensionId});
   }
   mark('Automatic preparation from normal POS',{storeId:assignedStore,policyVersion:snapshot.offlinePolicyVersion,station:snapshot.printStationId||null,menu:snapshot.menu.length,tables:snapshot.tableBoard.tables.length,sessionOpenedIndividually:false});
   setPhase('backend outage and hold');
   await p.getByLabel('Order type',{exact:true}).selectOption('TAKEAWAY');
   reachable=false;r.setReachable(false);
   const status=button(p,/Offline — billing available/);await status.waitFor({timeout:33000});
   assert.equal(await p.evaluate(()=>navigator.onLine),true);
   const count=async c=>(await r.db.collection(c).get()).size;
   const counts=()=>Promise.all(['orders','kotItems','stockMovements','offlineTransactions'].map(count));
   const before=await counts();
   await button(p,/^Add Cappuccino/).click();await button(p,'Hold').click();await button(p,/^Recall/).click();
   await p.getByRole('button',{name:'Recall',exact:true}).last().click();
   await p.getByText('Takeaway · 1 item',{exact:true}).first().waitFor();
   assert.deepEqual(await counts(),before);assert.equal((await entryRows(p)).length,0);
   mark('Saved menu and hold/recall with Wi-Fi still up',{before,after:await counts(),browserOnline:true});
   await p.getByLabel('Cash received',{exact:true}).fill('200');
   await button(p,/Cash received · Save bill/).click();
   const counter=await until(async()=>(await entryRows(p)).find(e=>!e.payload.table&&e.payload.paymentMethod==='CASH'),'durable counter cash');
   assert.equal(counter.payload.totals.subtotal,185);assert.equal(counter.payload.totals.grandTotal,194.25);
   assert.equal(counter.payload.cashReceived,200);assert.equal(counter.payload.printAuthority,undefined);
   assert.deepEqual(await counts(),before);
   mark('New counter Cash bill saved without station',{id:counter.id,subtotal:counter.payload.totals.subtotal,tax:counter.payload.totals.taxTotal,total:counter.payload.totals.grandTotal,status:counter.status});
   const initialReceipt=p.locator('article.offline-receipt');await initialReceipt.waitFor();
   assert((await initialReceipt.innerText()).includes(counter.id));assert((await initialReceipt.innerText()).includes('Saved offline — pending sync.'));
   await button(p,'Back to journal').click();await button(p,/Offline — billing available/).click();
   if(managed){
     const target=await info(p),{windowId}=await target.send('Browser.getWindowForTarget');
     await p.evaluate(()=>{window.__qualificationVisibility=[document.visibilityState];
       document.addEventListener('visibilitychange',()=>window.__qualificationVisibility.push(document.visibilityState));});
     await target.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'minimized'}});
     const minimized=await target.send('Browser.getWindowBounds',{windowId});
     const nativeHidden=await until(()=>p.evaluate(()=>document.visibilityState==='hidden'),'native minimized installed window',2000).catch(()=>false);
     await target.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'normal'}});
     await p.bringToFront();
     await until(()=>p.evaluate(()=>document.visibilityState==='visible'),'restored installed window',5000);
     await status.waitFor({timeout:25000});
     const visibility=await p.evaluate(()=>window.__qualificationVisibility);
     assert.equal(visibility.at(-1),'visible');
     const restored=(await entryRows(p)).find(e=>e.id===counter.id);assert.equal(restored.payload.totals.grandTotal,194.25);
     mark('Native window restored with retained original receipt and billing availability',{
       nativeWindowState:minimized.bounds.windowState,visibility,documentHiddenObserved:!!nativeHidden,
       freshAuthorityProvedByThisGesture:!!nativeHidden,offlineReference:counter.id,status:await status.innerText()});
   }
   await button(p,'Dine In').click();
   const tablePicker=p.getByRole('combobox',{name:'Choose table'});await tablePicker.fill('Fixture patio');
   const patio=p.getByRole('option',{name:/Fixture patio/});await patio.waitFor();
   assert((await patio.innerText()).includes('Occupied'));await p.screenshot({path:path.join(evidence,mode+'-offline-table.png')});await tablePicker.press('Enter');
   await p.getByRole('region',{name:'Current table'}).waitFor();
   setPhase('saved table round and receipt');
   for(const name of ['Butter Croissant','Flat White']){
     await p.getByRole('combobox',{name:'Type item name or code'}).fill(name);await p.getByRole('option',{name:new RegExp(name)}).click();
   }
   await button(p,'Save round locally').click();
   const round=await until(async()=>(await entryRows(p)).find(e=>e.payload.kind==='TABLE_ROUND'),'durable round');
   assert.equal(round.payload.table.id,sessionId);assert.equal(round.payload.roundLines.length,2);
   await p.getByLabel('Cash received',{exact:true}).fill('600');
   await button(p,/Cash received · Save bill/).click();
   const cash=await until(async()=>(await entryRows(p)).find(e=>e.payload.kind==='TABLE_CASH'),'durable Cash');
   assert.equal(cash.payload.table.orderId,'TABLE_'+sessionId);assert.equal(cash.payload.totals.grandTotal,572.25);
   assert.deepEqual(await counts(),before);
   assert.equal(cash.payload.printAuthority,undefined);assert.equal(round.payload.printAuthority,undefined);
   mark('Previously unopened table: two new lines and original bill paid offline',{round:round.id,cash:cash.id,order:cash.payload.table.orderId,totals:cash.payload.totals,printStation:null});
   await p.locator('article.offline-receipt').waitFor();await button(p,'Back to journal').click();await status.click();
   await p.getByLabel('Order type',{exact:true}).selectOption('TAKEAWAY');
   await button(p,/^Add Flat White/).click();await button(p,'Hold').click();await button(p,/^Recall/).waitFor();
   const heldKey=await p.evaluate(()=>Object.keys(localStorage).find(k=>localStorage.getItem(k)?.includes('"heldByUid"')&&localStorage.getItem(k)?.includes('Flat White')));
   assert(heldKey,'held draft exists in original persistent POS store');
   const heldBefore=await p.evaluate(k=>localStorage.getItem(k),heldKey);
   assert.deepEqual(await counts(),before);
   async function verifyReceipts(page,expected){
     const toggle=button(page,/Offline — billing (available|unavailable)/);
     const journal=page.getByRole('region',{name:'POS connection and offline Cash journal'});
     for(const entry of expected){
       const row=journal.getByRole('listitem').filter({has:page.getByText(entry.id,{exact:true})});
       await until(async()=>{
         if(!await journal.isVisible() && await toggle.isVisible()){await toggle.click();return false;}
         return row.isVisible();
       },'journal row '+entry.id,18000);
       await row.getByRole('button',{name:'View offline receipt',exact:true}).click();
       const receipt=journal.locator('article.offline-receipt');await receipt.waitFor();
       const text=await receipt.innerText();assert(text.includes(entry.id));
       assert(text.includes(entry.payload.totals.grandTotal.toFixed(2)));assert(text.includes(entry.payload.receipt.items[0].name));
       if(entry.payload.receipt.legal.gstRegistered){assert(text.includes('GST'));assert(text.includes(entry.payload.totals.taxTotal.toFixed(2)));}
       if(entry.id===cash.id)await page.screenshot({path:path.join(evidence,mode+'-restored-receipt.png')});
       await button(page,'Back to journal').click();
     }
     if(await journal.isVisible())await toggle.click();
   }
   setPhase('offline restart');
   const extraCash=[];
   async function postRestartCash(reason,price,amount){
     const prior=new Set((await entryRows(p)).map(e=>e.id));
     await p.getByLabel('Cash received',{exact:true}).fill(String(amount));
     await button(p,/Cash received · Save bill/).click();
     const saved=await until(async()=>(await entryRows(p)).find(e=>!prior.has(e.id)&&e.payload.paymentMethod==='CASH'),'new payment after '+reason);
     assert.equal(saved.payload.totals.grandTotal,price);assert.equal(saved.payload.printAuthority,undefined);
     const receipt=p.locator('article.offline-receipt');await receipt.waitFor();assert((await receipt.innerText()).includes(saved.id));
     extraCash.push(saved);await button(p,'Back to journal').click();await button(p,/Offline — billing available/).click();
     mark(reason,{offlineId:saved.id,total:price,serverCounts:await counts(),authority:mode});
   }
   // Close and re-launch the actual installed application target while the backend is inaccessible.
   r.setReachable(false);await p.close();const restart=await launched(context,cdp,url);p=restart.page;p.setDefaultTimeout(18000);
   const authState=button(p,/Offline — billing (available|unavailable)/);await authState.waitFor({timeout:45000});
   assert.equal((await entryRows(p)).length,3);
   await verifyReceipts(p,[counter,cash]);
   mark('Installed window relaunch recovers both provisional receipts',{counter:counter.id,table:cash.id,status:await authState.innerText(),worker:await p.evaluate(()=>!!navigator.serviceWorker.controller)});
   assert.equal(await p.evaluate(k=>localStorage.getItem(k),heldKey),heldBefore);
   if(managed){
     await button(p,/Offline — billing available/).waitFor();
     await button(p,/^Recall/).click();await p.getByRole('button',{name:'Recall',exact:true}).last().click();
     await postRestartCash('New Cash recorded from restored hold after standalone-window relaunch',204.75,210);
   }else{
     await button(p,/Offline — billing unavailable/).waitFor();assert.equal(await p.getByRole('button',{name:/Cash received · Save bill/}).count(),0);
   }
   await context.close();await openBrowser();cdp=await info(p);
   const cold=await launched(context,cdp,url);p=cold.page;p.setDefaultTimeout(18000);
   const coldState=button(p,managed?/Offline — billing available/:/Offline — billing unavailable/);await coldState.waitFor({timeout:45000});
   await verifyReceipts(p,[counter,cash,...extraCash]);assert.equal((await entryRows(p)).length,3+extraCash.length);
   if(!managed)assert.equal(await p.evaluate(k=>localStorage.getItem(k),heldKey),heldBefore);
   mark('Full Chrome process restart recovers signed operations and receipts',{counter:counter.id,table:cash.id,status:await coldState.innerText(),heldDraftPreserved:true,standalone:await p.evaluate(()=>matchMedia('(display-mode: standalone)').matches)});
   if(managed){
     await button(p,/Offline — billing available/).waitFor();await button(p,/^Add Double Espresso/).click();
     await postRestartCash('New Cash recorded after full Chrome process restart using same-boot OS authority',147,150);
     await context.close();await clockFixture.stop();await openBrowser();cdp=await info(p);
     p=(await launched(context,cdp,url)).page;p.setDefaultTimeout(18000);
     await button(p,/Offline — billing unavailable/).waitFor({timeout:45000});
     await verifyReceipts(p,[counter,cash,...extraCash]);assert.equal(await p.getByRole('button',{name:/Cash received · Save bill/}).count(),0);
     mark('Managed witness removed, receipts preserved and fresh capture fenced',{retained:3+extraCash.length});
   }else{
     await button(p,/Offline — billing unavailable/).waitFor();
     assert.equal(await p.getByRole('button',{name:/Cash received · Save bill/}).count(),0);
     mark('Full restart without surviving worker or managed witness fences new Cash',{retained:3+extraCash.length});
   }
   setPhase('reconnect and recover original');
   // A second POS window in the same browser receives the same connectivity transition.
   const other=await context.newPage();await other.goto(url,{waitUntil:'domcontentloaded'});await other.getByLabel('Select POS store').waitFor();
   assert.equal((await entryRows(other)).length,3+extraCash.length);assert.equal((await entryRows(p)).length,3+extraCash.length);
   reachable=true;r.setReachable(true);
   await until(async()=>(await entryRows(p)).every(e=>e.status==='SYNCED'),'status after lost acknowledgement',85000);
   assert(events.some(e=>e.action==='FIXTURE_LOST_ACCEPTED_ACK' && e.id===round.id));
   const order=r.db.doc('orders/'+cash.payload.table.orderId),sale=(await order.get()).data();
   const payments=(await order.collection('payments').get()).docs.filter(d=>d.get('method')==='CASH');
   assert.equal(payments.length,1);assert.equal(payments[0].get('amount'),572.25);assert.equal(sale.grandTotal,572.25);
   const after=await counts();assert.deepEqual(after,[before[0]+1+extraCash.length,before[1]+3+extraCash.length,before[2]+3+extraCash.length,before[3]+3+extraCash.length]);
   const counterOrder=r.db.doc('orders/OFF_'+counter.id);
   const counterSale=(await counterOrder.get()).data();assert.equal(counterSale.grandTotal,counter.payload.totals.grandTotal);
   const counterPayments=(await counterOrder.collection('payments').get()).docs;assert.equal(counterPayments.length,1);assert.equal(counterPayments[0].get('amount'),194.25);
   const finalTable=(await r.db.doc('tableSessions/'+sessionId).get()).data();assert.equal(finalTable.orderId,cash.payload.table.orderId);assert.equal(finalTable.outstanding,0);
   const expectedStock={PREVIEW_CAPPUCCINO:998,PREVIEW_FLAT_WHITE:managed?998:999,PREVIEW_CROISSANT:999,PREVIEW_ESPRESSO:managed?999:1000};
   for(const [id,quantity] of Object.entries(expectedStock)){const actual=(await r.db.doc('storeStock/'+assignedStore+'_FINISHED_GOOD_'+id).get()).get('currentStock');assert.equal(actual,quantity,id);}
   for(const entry of extraCash){const order=r.db.doc('orders/OFF_'+entry.id);assert.equal((await order.get()).get('grandTotal'),entry.payload.totals.grandTotal);
     const payments=(await order.collection('payments').get()).docs;assert.equal(payments.length,1);assert.equal(payments[0].get('amount'),entry.payload.totals.grandTotal);}
   for(const entry of [counter,round,cash,...extraCash])assert.equal((await r.db.doc('offlineTransactions/'+entry.id).get()).get('status'),'SYNCED');
   await other.reload({waitUntil:'domcontentloaded'});await other.getByLabel('Select POS store').waitFor();
   reachable=false;r.setReachable(false);await button(other,/Offline — billing/).waitFor({timeout:45000});
   reachable=true;r.setReachable(true);await button(other,/Online/).waitFor({timeout:45000});
   assert.deepEqual(await counts(),after);assert.equal((await counterOrder.collection('payments').get()).size,1);
   const ledgerAfter=await r.db.collection('offlineTransactions').get();
   const effects={};
   for(const e of [counter,round,cash,...extraCash]){
     const ledger=ledgerAfter.docs.find(doc=>doc.id===e.id);assert(ledger);
     effects[e.id]={status:ledger.get('status'),orderId:ledger.get('result.orderId')??null,kind:e.payload.kind||'COUNTER_CASH'};
   }
   const acceptedIndex=events.findIndex(e=>e.action==='FIXTURE_LOST_ACCEPTED_ACK'&&e.id===round.id);
   assert(acceptedIndex>=0&&events.slice(acceptedIndex+1).some(e=>e.action==='STATUS'&&e.id===round.id));
   await other.close();
   mark('Reconnect, interrupted acknowledgement, exact original-order effects',{before,after,subtotal:sale.subtotal,tax:sale.taxTotal??sale.gstTotal,total:sale.grandTotal,cash:payments[0].get('amount'),counterTotal:counterSale.grandTotal,stockMovementDelta:3+extraCash.length,expectedStock,concurrentPwaTabs:2,heldDraftsSaved:1,effects});
   setPhase('store and user isolation');
   await p.bringToFront();await p.getByLabel('Select POS store').selectOption(otherStore);
   assert.equal(await p.getByLabel('Select POS store').inputValue(),otherStore);
   reachable=false;r.setReachable(false);
   await button(p,/Offline — billing unavailable/).waitFor({timeout:45000});
   await button(p,/Offline — billing unavailable/).click();assert.equal(await p.getByRole('button',{name:'View offline receipt'}).count(),0);
   assert.equal(await p.getByRole('button',{name:/Cash received · Save bill/}).count(),0);
   mark('Same cashier in an assigned store without an offline grant cannot reuse the former store lease or journal',{store:otherStore});
   reachable=true;r.setReachable(true);
   await p.goto(r.url+'/offline-cash?storeId='+assignedStore);await button(p,'Sign out').click();await button(p,'Sign out').waitFor({state:'hidden'});
   await p.goto(url);const manager=r.accounts.STORE_MANAGER;
   await p.getByLabel('Email Address').fill(manager.email);await p.getByLabel('Password',{exact:true}).fill(manager.password);await button(p,'Sign In to POS').click();
   await p.waitForURL(u=>u.pathname!='/login');await p.goto(url);await p.getByLabel('Select POS store').selectOption(assignedStore);
   reachable=false;r.setReachable(false);await button(p,/Offline — billing unavailable/).waitFor({timeout:45000});await button(p,/Offline — billing unavailable/).click();
   assert.equal(await p.getByRole('button',{name:'View offline receipt'}).count(),0);assert.equal(await p.getByRole('button',{name:/Cash received · Save bill/}).count(),0);
   assert.equal((await entryRows(p)).length,3+extraCash.length);
   mark('Assigned manager without an offline grant cannot use cashier authority or see its receipts',{store:assignedStore,receiptsHidden:true,originalEntriesRetained:3+extraCash.length});
   assert.deepEqual(await counts(),after);
   assert.deepEqual(pageErrors,[]);
   fs.writeFileSync(path.join(evidence,'acceptance-'+mode+'.json'),JSON.stringify({status:'PASS',mode,startedAtUTC,completedAtUTC:new Date().toISOString(),networkGates:r.gateEvents,cases,events,pageErrors,blockedForeignBrowserDestinations:[...blockedRequests],productionWrites:0,physicalPrints:0},null,2)+'\n');
 }catch(error){
   console.error('FAILED',phase,error.stack);
   const body=await p?.locator('body').innerText({timeout:3000}).catch(()=>'');
   fs.writeFileSync(path.join(evidence,'latest-run-'+mode+'.json'),JSON.stringify({phase,cases,events,pageErrors,body,error:String(error.stack)},null,2)+'\n');
   throw error;
 }finally{
   reachable=true;r.setReachable(true);
   if(installed)await cdp?.send('PWA.uninstall',{manifestId:r.url+'/pos'}).catch(()=>{});
   if(context)await context.close();if(clockFixture)await clockFixture.close();fs.rmSync(profile,{recursive:true,force:true});
 }
}
