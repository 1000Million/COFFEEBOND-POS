'use strict';
// New boundary only: existing online V3 writers, rules and payment-first handlers stay unchanged.
const {onCall,HttpsError}=require('firebase-functions/v2/https');
const {randomUUID,createPublicKey,createPrivateKey,generateKeyPairSync,sign,verify}=require('node:crypto');
const {contentDigest,stableJson,authorizeFinancials,ROLE_LIMITS}=require('./posCheckoutFinancials');
const {canonicalizeRequestedCart}=require('./posAddOnAuthorization');
const {isAuthorizedStaffProfile,isAuthorizedStaffForStorePair,assignedStoreIds}=require('./complimentaryAuthorizationPolicy');
const {resolveGstStore,legalDetails,treatment}=require('./storeGstTreatment');
const {expandCompositeInventoryLines}=require('./compositeFulfillment');
const {planOnlineOrderInventory}=require('./onlineOrderInventory');
const {writeCanonicalSale}=require('./posCheckoutCommit');
const {tableTotals,tableLineTotals}=require('./tableDomain.cjs');
const {prepareTables,printTasks,storeLease,readLease}=require('./tillSnapshot.cjs');
const till=require('./tillOperations.cjs');
const {allowNewTableSnapshots}=require('./tillReleaseMode.cjs');
const fail=(code,message)=>{throw new HttpsError(code,message)};
const ident=v=>{if(typeof v!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(v))fail('invalid-argument','Invalid reference');return v};
const clean=v=>JSON.parse(JSON.stringify(v));
const MAX_AGE=8*60*60*1000;
const {keyFingerprint,approved,resolveGrant}=require('./offlinePilotPolicy');
function createOfflineCash({db,admin}) {
 const stamp=()=>admin.firestore.FieldValue.serverTimestamp();
 async function storeGrant(tx,profile,uid,storeId,deviceId,publicKey,offlineId,recovery=false,requiredVersion=0){
  if(!assignedStoreIds(profile).has(storeId))return null;
  const grant=await resolveGrant(tx,db,recovery?'offlinePilotRecovery':'offlinePilotPolicies',storeId);
  if(requiredVersion&&grant.version!==requiredVersion)return null;
  return approved(grant.policy,{uid,role:profile.role,storeId,deviceId,publicKey,offlineId,recovery},grant.version)?grant:null;
 }
 const grantDenied=()=>fail('permission-denied','Offline billing is not enabled for this staff, store, and designated device. Existing journal entries are retained.');
 async function access(tx,uid,storeId){
  const [p,s]=await Promise.all([tx.get(db.doc('users/'+uid)),tx.get(db.doc('stores/'+storeId))]);
  const profile=p.data(),raw=s.data();
  if(!isAuthorizedStaffProfile(profile,storeId)||!raw||raw.isActive!==true||raw.posEnabled===false)fail('permission-denied','Current active staff/store authorization required. Cash journal is retained.');
  const store=await resolveGstStore({...raw,id:storeId},async id=>{const s=await tx.get(db.doc('stores/'+ident(id)));return s.exists?{...s.data(),id:s.id}:null});
  if(!isAuthorizedStaffForStorePair(profile,storeId,store.inventoryStoreId||storeId))fail('permission-denied','Inventory-store authorization required.');
  return {profile,store};
 }
 async function catalog(tx,store){
  const [ps,gs,gst,stocks]=await Promise.all([tx.get(db.collection('finishedGoods')),tx.get(db.collection('addOnGroups')),tx.get(db.doc('appSettings/gstConfig')),tx.get(db.collection('storeStock').where('storeId','==',store.inventoryStoreId||store.id))]);
  const products=Object.fromEntries(ps.docs.map(p=>[p.id,{...p.data(),id:p.id}])),groups=Object.fromEntries(gs.docs.map(p=>[p.id,{...p.data(),id:p.id}]));
  const stock=Object.fromEntries(stocks.docs.map(s=>[s.id,{currentStock:s.data().currentStock,costPerUnit:s.data().costPerUnit??null}]));
  return {products,groups,gst:gst.data()||{},stock};
 }
 function canonical(store,c,requestedItems){return canonicalizeRequestedCart({storeId:store.id,store,gstConfig:c.gst,requestedItems,productsById:c.products,groupsById:c.groups,componentProductsById:c.products})}
 function signature(d,device){
  try{if(!verify('sha256',Buffer.from(stableJson(d.payload)),{key:createPublicKey({key:device.publicKey,format:'jwk'}),dsaEncoding:'ieee-p1363'},Buffer.from(d.signature,'base64')))throw Error();}
  catch{fail('permission-denied','Designated device signature is invalid.')}
 }
 async function run(request){
  const uid=request.auth?.uid,d=request.data||{};if(!uid)fail('unauthenticated','Sign in again before synchronizing.');
  // A refreshed Auth token is required on every reconnect, including status queries.
  if(!Number.isFinite(request.auth.token?.iat)||Date.now()/1000-request.auth.token.iat>300)fail('unauthenticated','Refresh sign-in before synchronization.');
  const storeId=ident(d.storeId),deviceId=ident(d.deviceId),deviceRef=db.doc('offlineDevices/'+storeId);
  if(d.action==='REGISTER')return db.runTransaction(async tx=>{
   const {profile}=await access(tx,uid,storeId);
   if(profile.role!=='ADMIN'||!assignedStoreIds(profile).has(storeId))fail('permission-denied','An active assigned Admin must enroll the approved offline device.');
   const enrollment=await resolveGrant(tx,db,'offlineEnrollmentPolicies',storeId),enrollmentPolicy=enrollment.policy;
   if(!approved(enrollmentPolicy,{uid,role:profile.role,storeId,deviceId,publicKey:d.publicKey},enrollment.version))fail('permission-denied','Separate owner-approved device enrollment is disabled or does not match this Admin/device/key. Billing authorization is unchanged.');
   const fingerprint=keyFingerprint(d.publicKey);
   if(d.payload?.action!=='REGISTER'||d.payload.uid!==uid||d.payload.storeId!==storeId||d.payload.deviceId!==deviceId||d.payload.keyFingerprint!==fingerprint)fail('permission-denied','Signed enrollment request identity mismatch.');
   signature(d,{publicKey:d.publicKey});
   const current=await tx.get(deviceRef),auditRef=db.doc('offlineEnrollmentAudit/'+storeId),audit=await tx.get(auditRef);
   if(current.exists){
    if(current.data().active!==true)fail('permission-denied','This device enrollment is revoked. Registration cannot reactivate it. Preserve its pending journal.');
    if(current.data().deviceId!==deviceId||keyFingerprint(current.data().publicKey)!==fingerprint)fail('already-exists','One offline device is already designated. Reconcile its journal before any separately approved replacement.');
    return {registered:true,replayed:true,keyFingerprint:fingerprint};
   }
   if(audit.exists)fail('failed-precondition','Prior enrollment audit exists. Device replacement requires separate owner review.');
   const approval={reference:enrollmentPolicy.approval.reference,approvedBy:enrollmentPolicy.approval.approvedBy,approvedAt:enrollmentPolicy.approval.approvedAt};
   tx.create(deviceRef,{deviceId,publicKey:d.publicKey,keyFingerprint:fingerprint,active:true,registeredBy:uid,registeredAt:stamp(),enrollmentApproval:approval});
   tx.create(auditRef,{storeId,deviceId,keyFingerprint:fingerprint,actorUid:uid,action:'DEVICE_ENROLLED',approval,createdAt:stamp()});
   return {registered:true,replayed:false,keyFingerprint:fingerprint};
  });
  if(d.action==='PREPARE')return db.runTransaction(async tx=>{
   const {profile,store}=await access(tx,uid,storeId),device=(await tx.get(deviceRef)).data();
   if(!device?.active||device.deviceId!==deviceId)fail('permission-denied','Use the designated offline device.');signature(d,device);
   const grant=await storeGrant(tx,profile,uid,storeId,deviceId,device.publicKey);
   if(!grant)grantDenied();
   if(d.payload?.action!=='PREPARE'||d.payload.uid!==uid||d.payload.storeId!==storeId||d.payload.deviceId!==deviceId)fail('permission-denied','Snapshot request identity mismatch.');
   const signingRef=db.doc('offlineSigningKeys/v1'),signingDoc=await tx.get(signingRef);let signing=signingDoc.data();
   if(!signing){const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});signing={privateKey:keys.privateKey.export({format:'jwk'}),publicKey:keys.publicKey.export({format:'jwk'})};}
   const withTables=d.payload.tableWorkflowVersion===1;
   if(grant.version===2&&!withTables)fail('failed-precondition','Update the POS before preparing this store-authorized till. Existing signed records remain recoverable.');
   if(withTables&&!allowNewTableSnapshots)fail('failed-precondition','New store-till preparation is paused. Keep signed records for original-operation synchronization.');
   const prepared=withTables?await prepareTables(tx,db,store,deviceId,grant.version):null;
   const c=await catalog(tx,store),menu=[],excluded=[];
   for(const p of Object.values(c.products)){
    if(p.isActive!==true||p.isSellable!==true||p.isAvailable===false||!p.availableStoreIds?.includes(storeId))continue;
    if(withTables && (p.addOnGroupIds?.length || Object.values(p.addOnOptionIdsByGroup||{}).some(options=>options?.length))) {
     excluded.push({id:p.id,reason:'Choose this item and its options online.'});continue;
    }
    const item={orderItemId:'UNIT',parentProductId:p.id,parentProductCode:p.code||p.id,quantity:1,selectedAddOns:[]};
    try{const value=canonical(store,c,[item]).canonicalItems.UNIT;menu.push({id:p.id,name:p.displayName||p.name||p.code,request:item,canonical:value,...(withTables?{printTasks:printTasks(p,value)}:{})});}catch(e){excluded.push({id:p.id,reason:e.message})}
   }
   const tables=[];
   if(withTables){
    for(const s of prepared.tableSessions)if(s.offlineEligible&&s.status==='OCCUPIED'&&s.orderId&&s.lines.some(l=>!l.cancelled)) {
     tables.push({id:s.id,tableId:s.tableId,version:s.version,orderId:s.orderId,lines:s.lines.filter(l=>!l.cancelled),total:s.total,legal:s.legal,gst:s.gst});
    }
   }else{
   const sessions=await tx.get(db.collection('tableSessions').where('storeId','==',storeId));
   for(const snap of sessions.docs){const s=snap.data();if(s.closedAt||s.status!=='OCCUPIED'||s.paymentAttempt||!s.orderId||!s.lines?.some(l=>!l.cancelled))continue;
    const order=(await tx.get(db.doc('orders/'+ident(s.orderId)))).data();if(!order||order.paymentStatus!=='UNPAID')continue;
    tables.push({id:snap.id,tableId:s.tableId,version:s.version,orderId:s.orderId,lines:s.lines.filter(l=>!l.cancelled),total:s.total,legal:order.receiptLegalDetails||legalDetails(store),gst:order.gstTreatmentSnapshot||treatment(store)});
   }
   }
   const now=Date.now(),snapshot={id:randomUUID(),uid,deviceId,storeId,storeName:store.name,role:profile.role,discountLimit:ROLE_LIMITS[profile.role],issuedAt:now,expiresAt:now+MAX_AGE,menu,excluded,tables,...prepared,...(grant.version===2?{offlinePolicyVersion:2}:{}),legal:legalDetails(store),gst:treatment(store)};
   // Full catalog/stock evidence stays server-only; browser receives only approved display/canonical lines.
   if(!signingDoc.exists)tx.create(signingRef,signing);
   const leaseRef=db.doc('offlineSnapshots/'+snapshot.id),lease={snapshot,catalog:c,store,createdAt:stamp()};
   if(withTables)storeLease(tx,leaseRef,lease);else tx.create(leaseRef,lease);
   return {snapshot,publicKey:signing.publicKey,signature:sign('sha256',Buffer.from(stableJson(snapshot)),{key:createPrivateKey({key:signing.privateKey,format:'jwk'}),dsaEncoding:'ieee-p1363'}).toString('base64')};
  });
  if(d.action==='CLOCK_BIND')return db.runTransaction(async tx=>{
   if(!allowNewTableSnapshots)fail('failed-precondition','New offline clock binding is paused.');
   const {profile}=await access(tx,uid,storeId);
   const device=(await tx.get(deviceRef)).data(),p=d.payload;
   if(device?.active!==true||device.deviceId!==deviceId)fail('permission-denied','The designated offline device is required.');
   signature(d,device);
   if(p?.action!=='CLOCK_BIND'||p.uid!==uid||p.storeId!==storeId||p.deviceId!==deviceId||
      typeof p.nonce!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(p.nonce)||
      typeof p.snapshotDigest!=='string'||!/^[0-9a-f]{64}$/.test(p.snapshotDigest))
    fail('invalid-argument','The signed clock challenge must match the original session and device.');
   if(!await storeGrant(tx,profile,uid,storeId,deviceId,device.publicKey,undefined,false,2))grantDenied();
   const lease=await readLease(tx,db.doc('offlineSnapshots/'+ident(p.snapshotId))),s=lease?.snapshot;
   const serverTime=Date.now();
   if(!s||s.id!==p.snapshotId||s.uid!==uid||s.role!==profile.role||s.storeId!==storeId||s.deviceId!==deviceId||
      s.offlinePolicyVersion!==2||contentDigest(s)!==p.snapshotDigest||!Number.isFinite(s.issuedAt)||
      !Number.isFinite(s.expiresAt)||s.expiresAt-s.issuedAt>MAX_AGE||serverTime<s.issuedAt||serverTime>=s.expiresAt)
    fail('permission-denied','The original signed session is unavailable, expired, or no longer matches.');
   return {uid,storeId,deviceId,snapshotId:s.id,snapshotDigest:p.snapshotDigest,nonce:p.nonce,serverTime,expiresAt:s.expiresAt};
  });
  const payload=d.payload,offlineId=ident(payload?.id),entryRef=db.doc('offlineTransactions/'+offlineId);
  return db.runTransaction(async tx=>{
   const {profile,store}=await access(tx,uid,storeId),device=(await tx.get(deviceRef)).data();
   if(!device?.active||device.deviceId!==deviceId)fail('permission-denied','Offline device registration changed. Cash journal is retained.');signature(d,device);
   const tableStep=till.types.has(payload.kind),isEdit=['TABLE_OPEN','TABLE_ROUND'].includes(payload.kind);
   if(payload.kind!=null&&!tableStep)fail('invalid-argument','Unrecognized saved operation type. Retain the original journal.');
   if((payload.uid!==uid&&(!['ADMIN','STORE_MANAGER'].includes(profile.role)||!['STATUS','RECONCILE'].includes(d.action)))||payload.storeId!==storeId||payload.deviceId!==deviceId||(isEdit?payload.paymentMethod!=null:payload.paymentMethod!=='CASH'))fail('permission-denied','Offline cash identity mismatch.');
   // A newly scoped store cannot use an unrelated administrator's access to inspect a
   // cashier's journal. Cross-staff status/reconciliation needs the exact recovery ID.
   if(payload.uid!==uid||!assignedStoreIds(profile).has(storeId)){
    const metadata=(await tx.get(db.doc('offlineSnapshots/'+ident(payload.snapshotId)))).get('snapshot');
    if(metadata?.offlinePolicyVersion===2&&(!assignedStoreIds(profile).has(storeId)||
       !await storeGrant(tx,profile,uid,storeId,deviceId,device.publicKey,offlineId,true,2)))
     fail('permission-denied','Only the original staff member or the assigned recovery supervisor may inspect this saved operation.');
   }
   const digest=contentDigest(payload),old=(await tx.get(entryRef)).data();
   if(old&&(old.digest!==digest||old.uid!==payload.uid))fail('already-exists','Immutable offline ID was reused with different content.');
   if(d.action==='STATUS')return old?{status:old.status,result:old.result||null,conflicts:old.conflicts||[]}:{status:'NOT_FOUND'};
   if(!['SYNC','RECONCILE'].includes(d.action))fail('invalid-argument','Unknown offline action');
   if(old?.status==='SYNCED')return {status:'SYNCED',result:old.result,replayed:true};
   if(old?.status==='CONFLICT'&&d.action!=='RECONCILE')return {status:'CONFLICT',conflicts:old.conflicts};
   const lease=await readLease(tx,db.doc('offlineSnapshots/'+ident(payload.snapshotId)));
   const snap=lease?.snapshot;
   if(!snap||snap.uid!==payload.uid||snap.deviceId!==deviceId||snap.storeId!==storeId||payload.snapshotDigest!==contentDigest(snap))fail('permission-denied','Approved offline snapshot does not match.');
   if(snap.offlinePolicyVersion===2 && payload.table && !tableStep)fail('invalid-argument','The signed table operation must preserve its original operation type.');
   const requiredVersion=snap.offlinePolicyVersion===2?2:0;
   let pilotAllowed=Boolean(await storeGrant(tx,profile,uid,storeId,deviceId,device.publicKey,undefined,false,requiredVersion));
   // Recovery approval is a separate server-only, exact-ID grant; it never enables enrollment or preparation.
   if(!pilotAllowed&&d.action==='RECONCILE'&&old?.status==='CONFLICT')pilotAllowed=Boolean(await storeGrant(tx,profile,uid,storeId,deviceId,device.publicKey,offlineId,true,requiredVersion));
   const captureTimeUncertain=!Number.isFinite(payload.createdAt)||payload.createdAt<snap.issuedAt||payload.createdAt>snap.expiresAt||payload.createdAt>Date.now()+60000;
   const discount=payload.discountPercent;if(!Number.isFinite(discount)||discount<0||discount>Math.min(snap.discountLimit,ROLE_LIMITS[profile.role]))fail('permission-denied','Discount exceeds original or current staff permission.');
   const progressRef=db.doc('offlineLeaseProgress/'+snap.id),progress=(await tx.get(progressRef)).data();
   let currentCatalog;const conflicts=[];if(!pilotAllowed)conflicts.push('PILOT_NOT_AUTHORIZED');if(Date.now()>=snap.expiresAt)conflicts.push('OFFLINE_AUTH_EXPIRED');if(captureTimeUncertain)conflicts.push('CAPTURE_TIME_UNCERTAIN');if((store.inventoryStoreId||storeId)!==(lease.store.inventoryStoreId||storeId))conflicts.push('INVENTORY_STORE_CHANGED');let original,financials,requested,table,session,order,tableRef,sessionRef,orderRef;
   if(tableStep)return till.applyTableOperation({tx,db,admin,uid,profile,store,lease,payload,entryRef,digest,progressRef,progress,conflicts,catalog,canonical,stamp,action:d.action,reason:d.reason,old,pilotAllowed});
   const marker=till.printMarker(snap,payload);
   if(payload.table){
    table=snap.tables.find(t=>t.id===payload.table.id&&t.version===payload.table.version&&t.orderId===payload.table.orderId&&t.tableId===payload.table.tableId);
    if(!table)fail('invalid-argument','Original table/revision reference is required.');
    if(payload.items?.length)fail('invalid-argument','A cached table may only settle its original sent lines.');
    original=tableTotals(table.lines,discount);sessionRef=db.doc('tableSessions/'+table.id);orderRef=db.doc('orders/'+table.orderId);tableRef=db.doc('tables/'+storeId+'_'+table.tableId);
    const [ss,os,ts]=await Promise.all([tx.get(sessionRef),tx.get(orderRef),tx.get(tableRef)]);session=ss.data();order=os.data();
    if(!session||session.version!==table.version||session.tableId!==table.tableId||session.orderId!==table.orderId||session.closedAt||session.paymentAttempt||session.status!=='OCCUPIED'||ts.data()?.activeSessionId!==table.id||order?.paymentStatus!=='UNPAID'||contentDigest(session.lines.filter(l=>!l.cancelled))!==contentDigest(table.lines))conflicts.push('TABLE_REVISION');
   }else{
    if(!Array.isArray(payload.items)||!payload.items.length||payload.items.length>30||new Set(payload.items.map(i=>i.productId)).size!==payload.items.length)fail('invalid-argument','Use 1–30 unique approved items.');
    requested=payload.items.map((i,index)=>{const p=snap.menu.find(p=>p.id===i.productId);if(!p||!Number.isInteger(i.quantity)||i.quantity<1||i.quantity>20)fail('invalid-argument','Invalid approved item or quantity.');return {...p.request,orderItemId:'LINE_'+index,quantity:i.quantity}});
    const c=canonical(lease.store,lease.catalog,requested);financials=authorizeFinancials({canonicalItems:c.canonicalItems,orderId:'OFF_'+offlineId,role:snap.role,discountPercent:discount,paymentMethod:'CASH'});original=financials;
    const current=await catalog(tx,store);currentCatalog=current;
    try{if(contentDigest(canonical(store,current,requested))!==contentDigest(c))conflicts.push('PRICE_OR_PRODUCT')}catch{conflicts.push('PRODUCT_UNAVAILABLE')}
    // Recipe/routing/inventory context changes must be reviewed even when prices match.
    for(const item of requested)if(contentDigest(current.products[item.parentProductId])!==contentDigest(lease.catalog.products[item.parentProductId])&&!conflicts.includes('PRICE_OR_PRODUCT'))conflicts.push('PRODUCT_OR_RECIPE');
    if(contentDigest(current.stock)!==contentDigest(progress?.stock||lease.catalog.stock))conflicts.push('STOCK_CHANGED');
    if(contentDigest(current.gst)!==contentDigest(lease.catalog.gst))conflicts.push('GST_CHANGED');
   }
   if(contentDigest(treatment(store))!==contentDigest(snap.gst)||contentDigest(legalDetails(store))!==contentDigest(snap.legal))conflicts.push('GST_OR_LEGAL_CHANGED');
   if(original.grandTotal<=0)fail('failed-precondition','Zero-payable / complimentary bills require the online verified complimentary workflow. No offline Cash bill is accepted.');
   if(!payload.totals||Math.abs(payload.totals.grandTotal-original.grandTotal)>0.000001||contentDigest(payload.totals)!==contentDigest({subtotal:original.subtotal,discountAmount:original.discountAmount,taxTotal:original.taxTotal??original.gstTotal,grandTotal:original.grandTotal}))fail('invalid-argument','Offline totals differ from the approved financial snapshot.');
   if(typeof payload.cashReceived!=='number'||!Number.isFinite(payload.cashReceived)||payload.cashReceived+0.00001<original.grandTotal)fail('invalid-argument','Cash received must cover the original payable.');
   const reconciling=d.action==='RECONCILE';
   if(reconciling&&(!['ADMIN','STORE_MANAGER'].includes(profile.role)||typeof d.reason!=='string'||d.reason.trim().length<8||!old||old.status!=='CONFLICT'))fail('permission-denied','A manager must record an explicit reconciliation reason.');
   // A manager may reconcile the original expired capture. Current ownership, product,
   // legal/tax amounts, timestamps and stock discrepancies remain protected in v2.
   const blockedStoreConflict=snap.offlinePolicyVersion===2&&conflicts.some(code=>code!=='OFFLINE_AUTH_EXPIRED');
   if(conflicts.length&&(!pilotAllowed||!reconciling||blockedStoreConflict||conflicts.includes('TABLE_REVISION')||conflicts.includes('PRODUCT_UNAVAILABLE'))){
    tx.set(entryRef,{uid:payload.uid,storeId,deviceId,digest,payload,status:'CONFLICT',conflicts,updatedAt:stamp()},{merge:true});return {status:'CONFLICT',conflicts};
   }
   const staff={uid,name:profile.displayName||profile.name||'Staff'};let result;
   if(table){
    const paymentId='OFF_'+offlineId,paymentRef=orderRef.collection('payments').doc(paymentId);if((await tx.get(paymentRef)).exists)fail('already-exists','Original payment requires reconciliation.');
    for(const line of table.lines)tx.update(orderRef.collection('items').doc(line.id),tableLineTotals(line,discount));
    tx.create(paymentRef,{method:'CASH',amount:original.grandTotal,paymentIndex:1,offlineId,createdAt:stamp(),settledBy:uid});
    tx.update(orderRef,{...original,paymentStatus:'PAID',paymentMethod:'CASH',isSplitPayment:false,paymentBreakdown:[{method:'CASH',amount:original.grandTotal}],offlineId,offlineFinancialSnapshot:payload,settledAt:stamp(),settledBy:uid,updatedAt:stamp()});
    // Kitchen/clear safeguards remain with the normal table service; do not release a live table lock offline.
    tx.update(sessionRef,{status:'PAID_AWAITING_CLEAR',version:session.version+1,outstanding:0,paymentAttempt:null,discountPercent:discount,paidAt:Date.now(),payments:[{method:'CASH',amount:original.grandTotal}],offlineId});
    result={orderId:orderRef.id,orderNumber:order.orderNumber,tableStatus:'PAID_AWAITING_CLEAR',grandTotal:original.grandTotal};
   }else{
    orderRef=db.doc('orders/OFF_'+offlineId);if((await tx.get(orderRef)).exists)fail('already-exists','Original sale exists without its offline acknowledgement. Reconcile; do not retry with a new ID.');
    const c=canonical(lease.store,lease.catalog,requested),canonicalItems=c.canonicalItems,productsById=lease.catalog.products;
    const expandedInventoryLines=expandCompositeInventoryLines(financials.itemIds.map(lineId=>({lineKey:lineId,quantity:canonicalItems[lineId].quantity,finishedGood:productsById[canonicalItems[lineId].parentProductId],addOns:canonicalItems[lineId].addOns,components:canonicalItems[lineId].components||[]})),storeId);
    const dateKey=new Date().toISOString().slice(0,10).replace(/-/g,''),counterRef=db.doc('counters/'+store.code+'_'+dateKey),counter=await tx.get(counterRef),sequence=(counter.data()?.lastSequence||0)+1;
    if(!Number.isSafeInteger(sequence)||sequence<1)fail('failed-precondition','Order sequence requires reconciliation.');
    const orderNumber=`CB-${store.code}-${dateKey}-${String(sequence).padStart(4,'0')}`;
    const inventoryPlan=await planOnlineOrderInventory({transaction:tx,db,admin,store:{...store,inventoryPolicy:'ALLOW_NEGATIVE_DEFER_BOM'},orderId:orderRef.id,orderNumber,orderType:'TAKEAWAY',businessDate:dateKey,staff,lines:expandedInventoryLines,requireAvailableStock:false,deferIncompleteBom:true,aggregateLineConsumption:true,source:'POS'});
    if(inventoryPlan.blockers.length){tx.set(entryRef,{uid:payload.uid,storeId,deviceId,digest,payload,status:'CONFLICT',conflicts:['INVENTORY_CONFIGURATION'],updatedAt:stamp()},{merge:true});return {status:'CONFLICT',conflicts:['INVENTORY_CONFIGURATION']}}
    const orderData={orderNumber,storeId,storeCode:store.code,storeName:store.name,source:'POS',orderType:'TAKEAWAY',tableNumber:null,customerId:null,customerName:null,customerPhone:null,createdByUserId:uid,createdByName:staff.name,status:'COMPLETED',...Object.fromEntries(['subtotal','discountPercent','discountAmount','taxableAmount','taxTotal','gstTotal','grandTotal','paymentStatus','commercialStatus','paymentMethod','isSplitPayment'].map(k=>[k,financials[k]])),discountTotal:financials.discountAmount,discount:financials.discountAmount,addOnAuthorizationId:'OFFLINE_'+snap.id,addOnTotal:c.canonicalAddOnTotal,cogsTotal:inventoryPlan.totalCogs,inventoryConsumptionStatus:inventoryPlan.pendingConsumptionPayloads.length?'PENDING_BOM':'APPLIED',stockMovementCount:inventoryPlan.movementPayloads.length,financialAuthorizationVersion:3,financialItemIds:financials.itemIds,financialPaymentIds:financials.paymentIds,clientCheckoutIdempotencyKey:offlineId,checkoutPayloadHash:digest,checkoutContentDigest:digest,gstTreatmentSnapshot:snap.gst,receiptLegalDetails:snap.legal,offlineId,offlineFinancialSnapshot:payload,offlineCapturedAt:payload.createdAt,createdAt:stamp(),updatedAt:stamp()};
    const localPrint=marker?till.stagedTransaction(tx,marker):null;
    writeCanonicalSale(localPrint?.staged||tx,{db,admin,orderRef,orderData,canonicalItems,financials,productsById,expandedInventoryLines,inventoryPlan,staff,selectedStore:store});
    localPrint?.flush();
    const stock={...currentCatalog.stock};for(const update of inventoryPlan.stockUpdates)stock[update.ref.id]={currentStock:update.newQty,costPerUnit:stock[update.ref.id]?.costPerUnit??update.seedData?.costPerUnit??null};
    tx.set(progressRef,{stock,lastOfflineId:offlineId,updatedAt:stamp()});tx.set(counterRef,{lastSequence:sequence,storeCode:store.code,dateKey,updatedAt:stamp()},{merge:true});
    result={orderId:orderRef.id,orderNumber,grandTotal:financials.grandTotal};
   }
   tx.set(entryRef,{uid:payload.uid,storeId,deviceId,digest,payload,status:'SYNCED',result,conflicts,reconciliation:reconciling?{uid,reason:d.reason.trim(),at:Date.now()}:null,synchronizedAt:stamp()});return {status:'SYNCED',result};
  });
 }
 return {run};
}
module.exports={createOfflineCash,createOfflineCashFunction:({admin,db,region})=>onCall({region},createOfflineCash({admin,db}).run)};
