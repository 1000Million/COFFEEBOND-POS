'use strict';
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, generateKeyPairSync, sign, verify } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const backend = process.env.TILL_TEST_PACKAGE || path.join(root, 'backend/offlineCash');
const runtime = path.resolve(root,'../offline-sector51-enrollment-fix-20261105/backend/node_modules');
process.env.NODE_PATH=runtime; require('node:module').Module._initPaths();
const localRequire=createRequire(path.join(backend,'package.json'));
const project='demo-store-till-workflow', storeId='L0qB13uuPxHvv089YtGQ', code='NOIDA_51', uid='synthetic-cashier', deviceId='synthetic-till-51';
process.env.GCLOUD_PROJECT=project; process.env.FIRESTORE_EMULATOR_HOST='127.0.0.1:8682';
const admin=localRequire('firebase-admin'); admin.initializeApp({projectId:project}); const db=admin.firestore();
const offline=localRequire('./offlineCash').createOfflineCash({db,admin});
const online=localRequire('./deployed-table/tableService.js').createTableService({db,admin});
const { stableJson,contentDigest }=localRequire('./posCheckoutFinancials');
const { keyFingerprint }=localRequire('./offlinePilotPolicy');
const { tableTotals }=localRequire('./tableDomain.cjs');
const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const key=publicKey.export({format:'jwk'}), results=[];
const profile={name:'Synthetic cashier',role:'CASHIER',isActive:true,storeIds:[storeId],assignedStoreIds:[storeId]};
const policy={version:1,enabled:true,storeId,approval:{reference:'SYNTHETIC-DISPOSABLE',approvedBy:'fixture',approvedAt:Date.now()-100},
  approvedStaff:[{uid,role:profile.role}],approvedDevice:{deviceId,keyFingerprint:keyFingerprint(key)}};
const station='synthetic-station';
const route=(queue,generation)=>({queue,queueVersion:1,generation,witnessed:true});
const localPrint={enabled:true,stationId:station,receipt:route('receipt',1)};
async function seed(){
 assert.equal((await db.collection('stores').limit(1).get()).empty,true,'Use empty dedicated emulator');
 const b=db.batch();
 b.create(db.doc('stores/'+storeId),{code,name:'Synthetic Sector 51',isActive:true,posEnabled:true,gstRegistered:true,stateCode:'09',inventoryPolicy:'STRICT'});
 b.create(db.doc('users/'+uid),profile);
 b.create(db.doc('offlineDevices/'+storeId),{deviceId,publicKey:key,keyFingerprint:keyFingerprint(key),active:true});
 b.create(db.doc('appSettings/gstConfig'),{defaultGstRate:5});
 b.create(db.doc('tableServiceConfig/'+storeId),{enabled:true,enableNewSessions:true});
 for(const tableId of ['ROOM_NEW','ROOM_OTHER','ROOM_PENDING','ROOM_PARTIAL','ROOM_FREE'])b.create(db.doc('tables/'+storeId+'_'+tableId),{tableId,storeId,label:tableId,capacity:4,activeSessionId:null});
 for(const [product,price,prepStation] of [['BUN',100,'KITCHEN'],['COFFEE',80,'BARISTA'],['CUSTOM',65,'BARISTA']]){
  b.create(db.doc('finishedGoods/'+product),{name:product,code:product,isActive:true,isAvailable:true,isSellable:true,availableStoreIds:[storeId],salePrice:price,taxRate:5,itemType:'DIRECT_STOCK',productionMode:'BOUGHT_AND_SOLD',prepStation,stockUOM:'PCS',uom:'PCS',recipeCost:20,addOnGroupIds:product==='CUSTOM'?['MILK']:[],addOnOptionIdsByGroup:{},posCategoryCode:'DEMO',categoryName:'Demo'});
  b.create(db.doc('storeStock/'+storeId+'_FINISHED_GOOD_'+product),{storeId,storeCode:code,stockItemType:'FINISHED_GOOD',stockItemCode:product,currentStock:1000,costPerUnit:20,uom:'PCS'});
 }
 b.create(db.doc('printStations/'+station),{id:station,storeId,active:true,protocolVersion:2,publicKey:generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}),assignmentGenerations:{KITCHEN:3,BARISTA:2},queues:['receipt','kitchen','barista'].map(name=>({name}))});
 for(const [department,generation] of [['KITCHEN',3],['BARISTA',2]])b.create(db.doc('printAssignments/'+storeId+'_'+department),{...route(department.toLowerCase(),generation),department,storeId,stationId:station,enabled:true});
 await b.commit();
}
function call(action,payload,overrides={},handler=offline){
 const signature=sign('sha256',Buffer.from(stableJson(payload)),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');
 return handler.run({auth:{uid,token:{iat:Math.floor(Date.now()/1000)}},data:{storeId,deviceId,payload,signature,action,...overrides}});
}
const offer=()=>({action:'PREPARE',uid,storeId,deviceId,tableWorkflowVersion:1});
const tableCall=(action,data)=>online.run({auth:{uid},data:{storeId,action,opId:randomUUID(),...data}});
async function current(id){return tableCall('DETAIL',{sessionId:id});}
async function occupy(tableId){
 const id=randomUUID(); await tableCall('OPEN',{sessionId:id,tableId});
 await tableCall('SEND',{sessionId:id,version:1,items:[{orderItemId:randomUUID(),parentProductId:'BUN',parentProductCode:'BUN',quantity:1,selectedAddOns:[]}]});
 return current(id);
}
const fields=t=>({subtotal:t.subtotal,discountAmount:t.discountAmount,taxTotal:t.taxTotal,grandTotal:t.grandTotal});
function base(s){return {id:randomUUID(),uid,storeId,deviceId,snapshotId:s.id,snapshotDigest:contentDigest(s),createdAt:Date.now(),discountPercent:0};}
const counts=async(orderId)=>({
 orders:(await db.collection('orders').get()).size,
 items:(await db.doc('orders/'+orderId).collection('items').get()).size,
 payments:(await db.doc('orders/'+orderId).collection('payments').get()).docs.map(d=>[d.id,d.get('method'),d.get('amount')]),
 kots:(await db.collection('kotItems').where('orderId','==',orderId).get()).docs.map(d=>[d.id,d.get('station'),d.get('quantity'),d.get('offlinePrintAuthority')||null]),
 movements:(await db.collection('stockMovements').where('referenceId','==',orderId).get()).docs.map(d=>d.id),
 stock:(await db.collection('storeStock').get()).docs.map(d=>[d.id,d.get('currentStock')]),
});
async function run(){
 await seed();
 const other=await occupy('ROOM_OTHER'), pending=await occupy('ROOM_PENDING'), partial=await occupy('ROOM_PARTIAL');
 // A past payment receipt can exist on a table whose running-order header still reads UNPAID.
 await db.doc('orders/'+partial.orderId+'/payments/earlier-UPI').create({method:'UPI',amount:20,reference:'synthetic-receipt'});
 await tableCall('PAY_BEGIN',{sessionId:pending.id,version:pending.version,discountPercent:0});
 await assert.rejects(()=>call('PREPARE',offer()),e=>e.code==='permission-denied');
 await db.doc('offlinePilotPolicies/sector51').create({...policy,localPrint});
 const prepared=await call('PREPARE',offer()), s=prepared.snapshot;
 assert.ok(verify('sha256',Buffer.from(stableJson(s)),{key:require('node:crypto').createPublicKey({key:prepared.publicKey,format:'jwk'}),dsaEncoding:'ieee-p1363'},Buffer.from(prepared.signature,'base64')));
 assert.equal(s.tableBoard.complete,true);
 assert.equal(s.tableBoard.tables.length,5); assert.equal(s.tableSessions.length,3);
 assert.equal(s.tableSessions.find(t=>t.id===pending.id).offlineEligible,false);
 assert.equal(s.tableSessions.find(t=>t.id===partial.id).offlineEligible,false);
 assert.ok(!s.tables.some(t=>t.id===partial.id));
 assert.equal(s.tableSessions.find(t=>t.id===other.id).offlineEligible,true);
 assert.equal(s.printStationId,station);assert.equal(s.excluded.find(p=>p.id==='CUSTOM').reason,'Choose this item and its options online.');
 assert.deepEqual(s.menu.find(p=>p.id==='COFFEE').printTasks.map(p=>p.station),['BARISTA']);
 const getStored=async path=>(await db.doc(path).get()).data();
 const savedLease=await getStored('offlineSnapshots/'+s.id);
 for(const field of ['uid','role','storeId','deviceId','printStationId','printStationPublicKey','printRoutes','issuedAt','expiresAt'])assert.deepEqual(savedLease.snapshot[field],s[field],field);
 assert.equal(savedLease.snapshotDigest,contentDigest(s));
 const {readTillGrant}=await import(require('node:url').pathToFileURL(path.join(root,'backend/printStation/till-grant.mjs')));
 const grant=await readTillGrant(getStored,await getStored('printStations/'+station),{snapshotId:s.id,nonce:randomUUID()},Date.now());
 assert.equal(grant.snapshotDigest,contentDigest(s));assert.equal(grant.stationId,station);
 assert.equal(grant.uid,uid);assert.equal(grant.deviceId,deviceId);assert.deepEqual(grant.publicKey,key);
 assert.deepEqual(grant.routes,s.printRoutes);
 results.push({test:'Station reads original compact PREPARE record and grants all three witnessed routes',persistedRole:s.role,matchedSignedDigest:true,matchedDesignatedTill:true,routes:Object.keys(grant.routes).sort()});
 results.push({test:'Signed preparation includes every table lock and blocks pending or partial external payments before local billing',slots:5,sessions:3,policyOffDenied:true,existingPartialPaymentExcluded:true,excludedChoiceItem:true,printBinding:true});
 const id=randomUUID(), original='TABLE_'+id;
 const table=(version)=>({id,orderId:original,tableId:'ROOM_NEW',version});
 const open={...base(s),kind:'TABLE_OPEN',guestCount:2,predecessorId:null,items:[],table:table(0)};
 const round={...base(s),kind:'TABLE_ROUND',predecessorId:open.id,table:table(1),printAuthority:'DESIGNATED_TILL',printStationId:station};round.roundId=round.id;
 round.items=['BUN','COFFEE'].map(productId=>({productId,orderItemId:randomUUID(),quantity:1,selectedAddOns:[]}));
 round.roundLines=round.items.map(i=>{const p=s.menu.find(p=>p.id===i.productId);return {id:i.orderItemId,roundId:round.id,parentProductId:i.productId,itemName:p.name,itemCode:p.canonical.parentProductCode,baseUnitPrice:p.canonical.baseUnitPrice,taxRate:p.canonical.taxRate,quantity:i.quantity,addOns:[],cancelled:false};});
 round.totals=fields(tableTotals(round.roundLines,0));
 const early=await call('SYNC',round);assert.equal(early.status,'DEPENDENCY_PENDING');
 assert.equal((await call('STATUS',round)).status,'NOT_FOUND');
 const r=await call('SYNC',open);assert.equal(r.result.tableVersion,1);
 assert.equal((await current(id)).orderId,null);
 const synced=await call('SYNC',round);assert.equal(synced.status,'SYNCED');assert.equal(synced.result.tableVersion,2);
 assert.equal((await call('STATUS',round)).result.orderId,original);
 const before=await counts(original);assert.equal((await call('SYNC',round)).replayed,true);assert.deepEqual(await counts(original),before);
 assert.deepEqual(before.kots.map(k=>k[1]).sort(),['BARISTA','KITCHEN']);assert.ok(before.kots.every(k=>k[3]==='DESIGNATED_TILL'));assert.equal(before.movements.length,2);
 const cash={...base(s),kind:'TABLE_CASH',predecessorId:round.id,table:table(2),paymentMethod:'CASH',items:[],discountPercent:10,cashReceived:190,
  totals:fields(tableTotals(round.roundLines,10)),printAuthority:'DESIGNATED_TILL',printStationId:station};
 const out=await Promise.all([call('SYNC',cash),call('SYNC',cash)]);assert.ok(out.some(r=>r.replayed));assert.ok(out.every(r=>r.status==='SYNCED'));
 const final=await current(id), after=await counts(original);
 assert.equal(final.status,'PAID_AWAITING_CLEAR');assert.equal(final.saved.order.id,original);assert.equal(final.outstanding,0);
 assert.equal(final.saved.order.grandTotal,cash.totals.grandTotal);assert.equal(final.saved.order.gstTotal,cash.totals.taxTotal);assert.equal(final.saved.order.orderNumber,synced.result.orderNumber);
 assert.deepEqual(after.stock,before.stock);assert.deepEqual(after.movements,before.movements);assert.deepEqual(after.kots,before.kots);
 assert.equal(after.orders,before.orders);assert.equal(after.items,2);assert.equal(after.payments.filter(p=>p[1]==='CASH').length,1);
 results.push({test:'Delayed predecessor, open, signed two-station round, concurrent Cash/replay and original status',retryAfterPredecessor:true,ordersForSession:1,roundKots:2,roundStockMovements:2,extraSettlementMovements:0,extraSettlementKots:0,tenderRows:1,canonicalIdPreserved:true,subtotal:cash.totals.subtotal,discount:cash.totals.discountAmount,gst:cash.totals.taxTotal,paid:cash.totals.grandTotal});
 // Another supported online operation wins the race; the offline receipt stays unresolved.
 const cashOther={...base(s),kind:'TABLE_CASH',predecessorId:null,table:{id:other.id,orderId:other.orderId,tableId:other.tableId,version:other.version},paymentMethod:'CASH',items:[],cashReceived:105,totals:fields(tableTotals(other.lines,0))};
 await tableCall('PAY_BEGIN',{sessionId:other.id,version:other.version,discountPercent:0});
 const beforeOther=await counts(other.orderId);
 const conflict=await call('SYNC',cashOther);assert.equal(conflict.status,'CONFLICT');assert.ok(conflict.conflicts.includes('TABLE_REVISION'));
 assert.deepEqual(await counts(other.orderId),beforeOther);assert.equal((await current(other.id)).status,'PAYMENT_PENDING');
 assert.equal((await call('STATUS',cashOther)).status,'CONFLICT');
 await assert.rejects(()=>call('SYNC',open,{deviceId:'different-designated-device'}),e=>e.code==='permission-denied');
 results.push({test:'Second online operator and foreign device',otherPendingAttemptPreserved:true,offlineEntryRetained:true,additionalFinancialEffects:0});
 // Existing V3 counter handler and older PREPARE/receipt remain readable by this target.
 const counter={...base(s),paymentMethod:'CASH',table:null,items:[{productId:'COFFEE',quantity:1}],cashReceived:84,
  totals:{subtotal:80,discountAmount:0,taxTotal:4,grandTotal:84},printAuthority:'DESIGNATED_TILL',printStationId:station};
 const c=await call('SYNC',counter);assert.equal(c.status,'SYNCED');const ck=await counts(c.result.orderId);
 assert.equal(ck.kots.length,1);assert.equal(ck.kots[0][3],'DESIGNATED_TILL');assert.equal((await call('SYNC',counter)).replayed,true);
 const old=offer();delete old.tableWorkflowVersion;const legacy=(await call('PREPARE',old)).snapshot;
 assert.equal(legacy.tableWorkflowVersion,undefined);const prev={...base(legacy),paymentMethod:'CASH',table:null,items:[{productId:'BUN',quantity:1}],cashReceived:105,totals:{subtotal:100,discountAmount:0,taxTotal:5,grandTotal:105}};
 const legacyResult=await call('SYNC',prev);assert.equal(legacyResult.status,'SYNCED');assert.equal((await counts(legacyResult.result.orderId)).kots[0][3],null);
 results.push({test:'Unchanged V3 counter writer and legacy signed record',newCounterPaid:84,legacyCounterPaid:105,legacyCloudPrintUnchanged:true});
 // A second, already-served original table settles its own Cash receipt. This
 // also exercises exact package recovery while a signed v1 capture is pending.
 const served=await occupy('ROOM_FREE'), renewal=(await call('PREPARE',offer())).snapshot;
 const preserved=await counts(served.orderId), toRecover={...base(renewal),kind:'TABLE_CASH',predecessorId:null,
  table:{id:served.id,orderId:served.orderId,tableId:served.tableId,version:served.version},paymentMethod:'CASH',items:[],cashReceived:105,totals:fields(tableTotals(served.lines,0))};
 let recovering=offline;
 if(process.env.TILL_RECOVERY_PACKAGE) {
   const recoverRequire=createRequire(path.join(process.env.TILL_RECOVERY_PACKAGE,'package.json'));
   recovering=recoverRequire('./offlineCash').createOfflineCash({db,admin});
   await assert.rejects(()=>call('PREPARE',offer(),{},recovering),e=>e.code==='failed-precondition');
 }
 const recovered=await call('SYNC',toRecover,{},recovering);assert.equal(recovered.result.orderId,served.orderId);
 assert.equal((await call('STATUS',toRecover,{},recovering)).status,'SYNCED');assert.equal((await call('SYNC',toRecover,{},recovering)).replayed,true);
 const saved=await counts(served.orderId);assert.equal(saved.orders,preserved.orders);assert.deepEqual(saved.stock,preserved.stock);assert.deepEqual(saved.movements,preserved.movements);assert.deepEqual(saved.kots,preserved.kots);
 results.push({test:'Original pre-existing table cash capture survives forward recovery',recoveryPackageVerified:!!process.env.TILL_RECOVERY_PACKAGE,tableOrderCount:1,extraKots:0,extraStockMovements:0,originalId:served.orderId===recovered.result.orderId});

 const big={snapshot:{id:'big-fixture',uid,storeId,deviceId,issuedAt:0,expiresAt:10,tableWorkflowVersion:1},catalog:{bulk:randomBytes(900000).toString('base64')},store:{id:storeId}};
 const {storeLease,readLease}=localRequire('./tillSnapshot.cjs');const ref=db.doc('offlineSnapshots/big-fixture');
 await db.runTransaction(async tx=>storeLease(tx,ref,{...big,createdAt:admin.firestore.Timestamp.now()}));
 assert.ok((await ref.get()).get('chunkCount')>=3);assert.deepEqual(await db.runTransaction(tx=>readLease(tx,ref)),big);
 results.push({test:'Large native store data round trip',catalogBytes:big.catalog.bulk.length,parts:(await ref.get()).get('chunkCount')});
 fs.writeFileSync(path.join(root,'evidence/till-backend-emulator.json'),JSON.stringify({project,productionWrites:0,results},null,2)+'\n');
 console.log(JSON.stringify(results));
}
run().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>admin.app().delete());
