'use strict';
const {treatment}=require('./storeGstTreatment');
const {createHash}=require('node:crypto');
const {HttpsError}=require('firebase-functions/v2/https');
const {FieldValue}=require('firebase-admin/firestore');
const {canonicalizeRequestedCart,sanitizeCartItems}=require('./posAddOnAuthorization');
const {collectRequiredComponentFinishedGoodIds}=require('./compositeProductPolicy');
const {planPosInventory}=require('./posInventory.cjs');
const {expandCompositeInventoryLines,buildKotTasks,summarizeParentInventory}=require('./compositeFulfillment');
const {tableTotals,tableLineTotals,customerMobile,buildVoidStockReversal,deterministicVoidReversalMovementId,effectiveInventoryPolicy}=require('./domain.cjs');
const STORE='HCLGB7BRuIxp9gLjDdca';
const TABLE_STORES=Object.freeze({
 [STORE]:{code:'UDAY_PARK',name:'Uday Park'},
 L0qB13uuPxHvv089YtGQ:{code:'NOIDA_51',name:'Noida Sector 51'},
});
const fail=(code,message)=>{throw new HttpsError(code,message)};
const clean=(v,n=120)=>String(v??'').trim().slice(0,n);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const key=v=>/^[A-Za-z0-9_-]{1,120}$/.test(String(v));
const money=v=>Math.round((Number(v)+Number.EPSILON)*100)/100;
const activeLines=s=>s.lines.filter(l=>!l.cancelled);
const allowed=(p,storeId,roles=['ADMIN','STORE_MANAGER','CASHIER'])=>p?.isActive===true&&roles.includes(p.role)&&(p.role==='ADMIN'||[...(p.storeIds||[]),...(p.assignedStoreIds||[])].includes(storeId));
function createTableService({db,admin,pauseNewScopedOrders=false}) {
 const timestamp=()=>FieldValue.serverTimestamp();
 const dateKey=()=>new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'}).replace(/-/g,'');
 async function identity(request,storeId) {
  if(!request.auth?.uid)fail('unauthenticated','Staff sign-in is required.');
  if(typeof storeId!=='string'||!key(storeId))fail('permission-denied','A valid table store is required.');
  const snap=await db.doc('users/'+request.auth.uid).get();const profile=snap.data();
  if(!allowed(profile,storeId))fail('permission-denied','This account cannot access tables at this store.');
  return {...profile,uid:request.auth.uid,name:clean(profile.displayName||profile.name||'Staff')};
 }
 async function run(request) {
  // Every store reference belongs to this request; concurrent stores share no mutable scope.
  const STORE=request.data?.storeId,staff=await identity(request,STORE),d=request.data,action=d.action;
  const legacyStore=Object.hasOwn(TABLE_STORES,STORE),pausedByRecovery=pauseNewScopedOrders&&!legacyStore;
  let storeScope=legacyStore?TABLE_STORES[STORE]:null;
  if(!legacyStore){
   const [storeDoc,configDoc]=await Promise.all([db.doc('stores/'+STORE).get(),db.doc('tableServiceConfig/'+STORE).get()]);
   const store=storeDoc.data(),config=configDoc.data();
   if(store?.isActive!==true||store.posEnabled===false||typeof store.code!=='string'||!key(store.code))fail('permission-denied','This store is not active for POS.');
   if(!config||(config.enabled!==true&&config.recoveryMode!==true)){
    if(action==='BOARD')return {storeId:STORE,enabled:false,recoveryMode:false,enableNewSessions:false,serverTime:Date.now(),tables:[]};
    if(['STAFF','MENU'].includes(action))fail('failed-precondition','Table service is not enabled at this store.');
    // Mutations check the current configuration transactionally after lookup of an existing original acknowledgement.
   }
   storeScope={name:store.name||store.code,code:store.code};
  }
  const uday=STORE==='HCLGB7BRuIxp9gLjDdca';
  const validTableId=id=>typeof id==='string'&&(uday?/^T(0[1-9]|1[0-9]|20)$/.test(id):key(id));
  const configuredTable=(snap,id)=>snap.exists&&snap.data().storeId===STORE&&(uday||snap.data().tableId===id);
  const tableNumber=id=>uday||/^T[0-9]+$/.test(id)?id.slice(1):id;
  if(action==='STAFF') {
   if(!['ADMIN','STORE_MANAGER'].includes(staff.role))fail('permission-denied','Only a manager may choose a staff handover.');
   const people=(await db.collection('users').where('isActive','==',true).limit(100).get()).docs.map(s=>({uid:s.id,...s.data()})).filter(p=>allowed(p,STORE));
   return{people:people.map(p=>({uid:p.uid,name:clean(p.displayName||p.name),role:p.role})),coverage:`Up to100 active staff records; only authorised ${storeScope.name} staff are listed.`};
  }
  if(action==='BOARD') {
   const config=(await db.doc('tableServiceConfig/'+STORE).get()).data()||{};
   const definitions=db.collection('tables').where('storeId','==',STORE);
   const tables=(await(uday?definitions.limit(20):definitions).get()).docs.filter(x=>uday||(validTableId(x.data().tableId)&&x.id===STORE+'_'+x.data().tableId&&configuredTable(x,x.data().tableId))).map(x=>({...x.data(),id:x.id}));
   if(!uday)tables.sort((a,b)=>a.tableId.localeCompare(b.tableId,'en',{numeric:true}));
   const ids=tables.map(t=>t.activeSessionId).filter(Boolean);
   const sessions=ids.length?(await db.getAll(...ids.map(id=>db.doc('tableSessions/'+id)))).filter(s=>s.exists).map(s=>s.data()).filter(s=>s.storeId===STORE):[];
   // A board is a summary, never a customer contact/history download.
   return {storeId:STORE,enabled:config.enabled===true,recoveryMode:pausedByRecovery||config.recoveryMode===true,enableNewSessions:config.enabled===true&&config.enableNewSessions===true&&config.recoveryMode!==true&&!pausedByRecovery,serverTime:Date.now(),tables:tables.map(t=>{const s=sessions.find(s=>s.id===t.activeSessionId);return{id:t.id,tableId:t.tableId,label:t.label,capacity:t.capacity??null,session:s?{id:s.id,version:s.version,status:s.status,total:s.total,outstanding:s.outstanding,openedAt:s.openedAt,assignedStaff:s.assignedStaff,guestCount:s.guestCount,rounds:s.rounds.length}:null}})};
  }
  if(action==='MENU') {
   const products=(await db.collection('finishedGoods').where('isActive','==',true).limit(200).get()).docs.map(s=>({id:s.id,...s.data()})).filter(p=>p.isSellable===true&&p.isAvailable!==false&&(!p.availableStoreIds?.length||p.availableStoreIds.includes(STORE)));
   const groupIds=[...new Set(products.flatMap(p=>p.addOnGroupIds||[]))];
   const groups=groupIds.length?(await db.getAll(...groupIds.map(id=>db.doc('addOnGroups/'+id)))).filter(s=>s.exists).map(s=>({id:s.id,...s.data()})):[];
   return{products:products.map(({id,code,displayName,name,salePrice,taxRate,addOnGroupIds,addOnOptionIdsByGroup})=>({id,code,name:displayName||name,salePrice:salePrice??0,taxRate:taxRate??0,addOnGroupIds:addOnGroupIds||[],addOnOptionIdsByGroup:addOnOptionIdsByGroup||{}})),groups,coverage:'Up to200 active products; existing counter menu remains available.'};
  }
  if(action==='DETAIL') {
   if(!key(d.sessionId))fail('invalid-argument','Select a table session.');
   const s=(await db.doc('tableSessions/'+d.sessionId).get()).data();
   if(!s||s.storeId!==STORE)fail('not-found','Table session is unavailable.');
   const tasks=(await db.collection('kotItems').where('tableSessionId','==',s.id).limit(240).get()).docs.map(x=>({id:x.id,...x.data()}));
   const result={...s,kitchen:tasks.filter(t=>t.storeId===STORE).map(t=>({id:t.id,lineId:t.orderItemId,status:t.status,station:t.station,quantity:t.quantity}))};
   if(s.orderId){const ref=db.doc('orders/'+s.orderId);const [order,items,payments]=await Promise.all([ref.get(),ref.collection('items').get(),ref.collection('payments').get()]);if(order.get('storeId')!==STORE||order.get('tableSessionId')!==s.id)fail('failed-precondition','The original table order requires reconciliation.');result.saved={order:{id:ref.id,...order.data()},items:items.docs.map(x=>({id:x.id,...x.data()})),payments:payments.docs.map(x=>({id:x.id,...x.data()}))}}
   return result;
  }
  if(action==='OPERATION_STATUS') {
   if(!key(d.opId)||!key(d.sessionId))fail('invalid-argument','The original operation and table references are required.');
   const op=await db.doc('tableOperations/'+hash([staff.uid,d.opId])).get();
   if(!op.exists)return{committed:false};
   if(op.data().storeId!==STORE||op.data().staffUid!==staff.uid||op.data().sessionId!==d.sessionId)fail('permission-denied','This operation belongs to another table or staff session.');
   return{committed:true,...op.data().result,reconciled:true};
  }
  if(!key(d.opId))fail('invalid-argument','An operation reference is required.');
  const requestHash=hash(d),opRef=db.doc('tableOperations/'+hash([staff.uid,d.opId]));
  return db.runTransaction(async tx=>{
   const [op,profileSnap,storeSnap,configSnap]=await Promise.all([tx.get(opRef),tx.get(db.doc('users/'+staff.uid)),tx.get(db.doc('stores/'+STORE)),tx.get(db.doc('tableServiceConfig/'+STORE))]);
   if(!allowed(profileSnap.data(),STORE))fail('permission-denied','Your table access changed. Sign in again.');
   if(op.exists){if(op.data().hash!==requestHash)fail('already-exists','This operation reference belongs to a different request.');return{...op.data().result,reconciled:true}}
   // Reconcile an existing acknowledgement above before applying the ordering pause.
   if(!legacyStore&&configSnap.get('enabled')!==true&&configSnap.get('recoveryMode')!==true)fail('failed-precondition','Table service is not enabled at this store.');
   if((pausedByRecovery||configSnap.data()?.recoveryMode===true)&&['OPEN','SEND'].includes(action))fail('failed-precondition','Recovery mode: new tables and new rounds are paused. Existing bills, kitchen work and payment reconciliation remain available.');
   const store={...storeSnap.data(),id:STORE,inventoryPolicy:effectiveInventoryPolicy(storeSnap.data())};if(!storeSnap.exists||store.code!==storeScope.code||store.isActive!==true||store.posEnabled===false)fail('failed-precondition',`${storeScope.name} is not active for POS.`);
   const businessDate=dateKey();
   let s,ref,order,orderRef,lock,lockRef;
   const saveOp=result=>{tx.create(opRef,{hash:requestHash,storeId:STORE,staffUid:staff.uid,sessionId:result.sessionId,action,result,createdAt:timestamp()});return result};
   if(action==='CAPACITY') {
    if(!allowed(profileSnap.data(),STORE,['ADMIN','STORE_MANAGER']))fail('permission-denied','A manager is required to set seats.');
    if(!validTableId(d.tableId))fail('invalid-argument','Choose a configured table.');
    const capacity=d.capacity==null?null:Number(d.capacity);if(capacity!==null&&(!Number.isInteger(capacity)||capacity<1||capacity>45))fail('invalid-argument','Use1 to45 seats or leave the capacity unset.');
    const target=db.doc('tables/'+STORE+'_'+d.tableId),table=await tx.get(target);if(!configuredTable(table,d.tableId))fail('not-found','This table is not configured.');tx.update(target,{capacity});return saveOp({sessionId:null,tableId:d.tableId,capacity});
   }
   if(action==='OPEN') {
    if(configSnap.data()?.enabled!==true||configSnap.data()?.enableNewSessions!==true)fail('failed-precondition','New tables are disabled. Existing sessions remain recoverable.');
    if(!key(d.sessionId)||!validTableId(d.tableId))fail('invalid-argument','Choose a configured table.');
    ref=db.doc('tableSessions/'+d.sessionId);lockRef=db.doc('tables/'+STORE+'_'+d.tableId);
    const [existing,table]=await Promise.all([tx.get(ref),tx.get(lockRef)]);
    if(!configuredTable(table,d.tableId))fail('not-found','This table is not configured.');
    if(existing.exists||table.data().activeSessionId)fail('already-exists','This table is already occupied. Refresh the board.');
    const guestCount=d.guestCount==null?null:Number(d.guestCount);if(guestCount!==null&&(!Number.isInteger(guestCount)||guestCount<1||guestCount>45))fail('invalid-argument','Use a guest count from1 to45 or leave it blank.');
    s={id:d.sessionId,storeId:STORE,tableId:d.tableId,tableLabel:table.data().label,version:1,status:'OCCUPIED',total:0,outstanding:0,openedAt:Date.now(),assignedStaff:{uid:staff.uid,name:staff.name},guestCount,lines:[],rounds:[],orderId:null,customerPhone:null,paymentAttempt:null,closedAt:null};
    tx.create(ref,s);tx.update(lockRef,{activeSessionId:s.id});return saveOp({sessionId:s.id,version:1,status:s.status});
   }
   if(!key(d.sessionId))fail('invalid-argument','Select a table session.');
   ref=db.doc('tableSessions/'+d.sessionId);const snap=await tx.get(ref);s=snap.data();
   if(!s||s.storeId!==STORE)fail('not-found','Table session is unavailable.');
   if(s.version!==d.version)fail('aborted','This table changed on another device. Refresh; your unsent draft is still local.');
   if(s.closedAt)fail('failed-precondition','This session is closed. Open a new table session.');
   lockRef=db.doc('tables/'+STORE+'_'+s.tableId);lock=(await tx.get(lockRef)).data();if(lock?.activeSessionId!==s.id||(!uday&&(lock?.storeId!==STORE||lock?.tableId!==s.tableId)))fail('failed-precondition','Table assignment changed. Refresh before continuing.');
   orderRef=db.doc('orders/'+(s.orderId||'TABLE_'+s.id));order=(await tx.get(orderRef)).data();
   if(s.paymentAttempt&& !['PAY_CONFIRM','PAY_CANCEL'].includes(action))fail('failed-precondition','Payment is pending. Reconcile or explicitly cancel that attempt before editing.');
   if(s.status==='PAID_AWAITING_CLEAR'&&action!=='CLEAR')fail('failed-precondition','This bill is paid. Clear the table before opening a new session.');
   const patch={};const audit={storeId:STORE,sessionId:s.id,action,staffUid:staff.uid,staffName:staff.name,createdAt:timestamp()};
   if(action==='SEND') {
    const requested=sanitizeCartItems(d.items);if(s.lines.length+requested.length>120)fail('resource-exhausted','This pilot allows120 lines per table bill. Ask a manager to finish the bill.');
    if(requested.some(l=>!key(l.orderItemId)||s.lines.some(old=>old.id===l.orderItemId)))fail('already-exists','These line references were already sent or are invalid. Refresh and reconcile the original Send.');
    const [gst,products,counter]=await Promise.all([tx.get(db.doc('appSettings/gstConfig')),tx.getAll(...requested.map(l=>db.doc('finishedGoods/'+l.parentProductId))),tx.get(db.doc('counters/'+store.code+'_'+businessDate))]);
    const byId=Object.fromEntries(products.filter(p=>p.exists).map(p=>[p.id,{id:p.id,...p.data()}]));
    const groupIds=[...new Set(Object.values(byId).flatMap(p=>p.addOnGroupIds||[]))];
    const groups=groupIds.length?await tx.getAll(...groupIds.map(id=>db.doc('addOnGroups/'+id))):[];
    const groupsById=Object.fromEntries(groups.filter(g=>g.exists).map(g=>[g.id,{id:g.id,...g.data()}]));
    const componentIds=collectRequiredComponentFinishedGoodIds({products:byId,groupsById});
    const components=componentIds.length?await tx.getAll(...componentIds.map(id=>db.doc('finishedGoods/'+id))):[];
    const componentProductsById={...byId,...Object.fromEntries(components.filter(p=>p.exists).map(p=>[p.id,{id:p.id,...p.data()}]))};
    const canonical=canonicalizeRequestedCart({storeId:STORE,store,gstConfig:gst.data(),requestedItems:requested,productsById:byId,groupsById,componentProductsById});
    const roundId=d.opId;
    const lines=requested.map(l=>{const p=byId[l.parentProductId],c=canonical.canonicalItems[l.orderItemId];return{id:l.orderItemId,roundId,productId:p.id,itemCode:p.code,itemName:p.displayName||p.name,categoryId:p.posCategoryCode||p.categoryId||'MISC',categoryName:p.categoryName||'Misc',quantity:l.quantity,baseUnitPrice:c.baseUnitPrice,unitPrice:c.baseUnitPrice,taxRate:c.taxRate,addOns:c.addOns,components:c.components||[],prepStation:p.prepStation||'NONE',sentAt:Date.now(),sentBy:staff.uid,sentByName:staff.name,finishedGood:p,cancelled:false}});
    const seq=(counter.data()?.lastSequence||0)+1,orderNumber=order?.orderNumber||`CB-${store.code}-${businessDate}-${String(seq).padStart(4,'0')}`;
    const expanded=expandCompositeInventoryLines(lines.map(l=>({lineKey:l.id,quantity:l.quantity,finishedGood:l.finishedGood,components:l.components,addOns:l.addOns})),STORE);
    if(store.inventoryStoreId&&store.inventoryStoreId!==STORE&&!allowed(profileSnap.data(),store.inventoryStoreId))fail('permission-denied','Inventory-store access is required for this round.');
    const inventory=await planPosInventory({transaction:tx,db,admin,store,orderId:orderRef.id,orderNumber,orderType:'DINE_IN',businessDate:businessDate,staffProfile:staff,lines:expanded,source:'POS'});
    if(inventory.blockers.length)fail('failed-precondition','Inventory setup needs attention before this round can be sent. No round was saved.');
    const existingTasks=await tx.get(db.collection('kotItems').where('tableSessionId','==',s.id).limit(241));
    const newTaskCount=lines.reduce((n,l)=>n+buildKotTasks({quantity:l.quantity,finishedGood:l.finishedGood,components:l.components}).length,0);
    if(existingTasks.size+newTaskCount>240||inventory.stockUpdates.length+inventory.movementPayloads.length+inventory.pendingConsumptionPayloads.length+lines.length+newTaskCount>440)fail('resource-exhausted','This round exceeds the pilot transaction limit. Send a smaller new round.');
    // Planner may resolve another physical inventory store; preserve existing dual-store access.
    for(const row of [...inventory.stockUpdates,...inventory.pendingConsumptionPayloads]){const id=row.seedData?.storeId||row.inventoryStoreId;if(id&&id!==STORE&&!allowed(profileSnap.data(),id))fail('permission-denied','Inventory-store access is required for this round.')}
    for(const update of inventory.stockUpdates)tx.set(update.ref,{...(update.existed?{}:{...update.seedData,createdAt:timestamp()}),currentStock:update.newQty,updatedAt:timestamp()},{merge:true});
    const movementIds=[];for(const [i,m] of inventory.movementPayloads.entries()){const id=orderRef.id+'_'+roundId+'_'+i;tx.create(db.doc('stockMovements/'+id),{...m,tableSessionId:s.id,tableRoundId:roundId});movementIds.push(id)}
    for(const p of inventory.pendingConsumptionPayloads)tx.create(db.doc('pendingInventoryConsumption/'+p.idempotencyKey),{...p,tableSessionId:s.id,tableRoundId:roundId});
    for(const line of lines){const inv=summarizeParentInventory({parentLineKey:line.id,expandedLines:expanded,perLineCogs:inventory.perLineCogs,perLineConsumptionStatus:inventory.perLineConsumptionStatus});Object.assign(line,inv,{movementIds:movementIds.filter((_,i)=>{const key=inventory.movementPayloads[i].orderLineKey;return key===line.id||key.startsWith(line.id+'__COMP_')})});delete line.finishedGood;
     const amounts=tableLineTotals(line,0);tx.create(orderRef.collection('items').doc(line.id),{...line,...amounts,menuItemId:line.productId,tableSessionId:s.id,sourceSystem:'FINISHED_GOODS',status:'PENDING',createdAt:timestamp()});
     for(const task of buildKotTasks({quantity:line.quantity,finishedGood:{code:line.itemCode,name:line.itemName,prepStation:line.prepStation},components:line.components})){tx.create(db.doc('kotItems/'+orderRef.id+'_'+line.id+'_'+task.taskKey),{orderId:orderRef.id,orderNumber,orderItemId:line.id,storeId:STORE,storeCode:store.code,storeName:store.name,station:task.station,itemName:task.itemName,itemCode:task.itemCode,quantity:task.quantity,addOns:line.addOns,...(task.component?{component:task.component}:{}),tableSessionId:s.id,tableRoundId:roundId,orderType:'DINE_IN',tableNumber:tableNumber(s.tableId),tablePreparationStarted:false,tablePreparationStartedAt:null,status:'PENDING',createdAt:timestamp(),updatedAt:timestamp(),createdByUserId:staff.uid,createdByName:staff.name})}
    }
    patch.lines=[...s.lines,...lines];patch.rounds=[...s.rounds,{id:roundId,lineIds:lines.map(l=>l.id),sentAt:Date.now(),sentBy:staff.name}];patch.orderId=orderRef.id;patch.status='OCCUPIED';patch.total=tableTotals(patch.lines).grandTotal;patch.outstanding=patch.total;
    tx.set(orderRef,{...(order||{}),...tableTotals(patch.lines),tableSessionId:s.id,orderNumber,storeId:STORE,storeCode:store.code,storeName:store.name,source:'POS',orderType:'DINE_IN',tableNumber:tableNumber(s.tableId),createdByUserId:order?.createdByUserId||staff.uid,createdByName:order?.createdByName||staff.name,status:'COMPLETED',commercialStatus:'SALE',paymentStatus:'UNPAID',paymentMethod:'PAY_AT_COUNTER',customerId:null,customerPhone:s.customerPhone,customerPhoneVerification:'UNVERIFIED',customerContactSource:'STAFF_ENTERED',customerMarketingConsent:false,bondPointsEarned:0,createdAt:order?.createdAt||timestamp(),updatedAt:timestamp(),cogsTotal:money((order?.cogsTotal||0)+inventory.totalCogs),inventoryConsumptionStatus:inventory.pendingConsumptionPayloads.length?'PENDING_BOM':order?.inventoryConsumptionStatus||'APPLIED',stockMovementCount:(order?.stockMovementCount||0)+movementIds.length,gstTreatmentSnapshot:treatment(store),receiptLegalDetails:{tradeName:store.tradeName||'Coffee Bond',legalName:store.legalName||null,legalAddress:store.legalAddress||store.address||null,gstin:store.gstin||null,gstRegistered:store.gstRegistered===true,stateName:store.stateName||null,stateCode:store.stateCode||null}});
    if(!order){tx.set(db.doc('counters/'+store.code+'_'+businessDate),{storeCode:store.code,dateKey:businessDate,lastSequence:seq,updatedAt:timestamp()},{merge:true});tx.create(orderRef.collection('payments').doc('PAY_AT_COUNTER'),{method:'PAY_AT_COUNTER',amount:0,paymentIndex:0,createdAt:timestamp()})}
   }else if(action==='MOVE') {
    if(!validTableId(d.targetTableId)||d.targetTableId===s.tableId)fail('invalid-argument','Choose another available table.');
    const target=db.doc('tables/'+STORE+'_'+d.targetTableId),t=await tx.get(target);const tasks=await tx.get(db.collection('kotItems').where('tableSessionId','==',s.id));
    if(!configuredTable(t,d.targetTableId)||t.data().activeSessionId)fail('already-exists','The destination table is no longer available.');
    patch.tableId=d.targetTableId;patch.tableLabel=t.data().label;tx.update(lockRef,{activeSessionId:null});tx.update(target,{activeSessionId:s.id});if(order)tx.update(orderRef,{tableNumber:tableNumber(patch.tableId)});for(const k of tasks.docs)tx.update(k.ref,{tableNumber:tableNumber(patch.tableId),updatedAt:timestamp()});Object.assign(audit,{fromTable:s.tableId,toTable:patch.tableId});
   }else if(action==='HANDOVER') {
    if(!allowed(profileSnap.data(),STORE,['ADMIN','STORE_MANAGER']))fail('permission-denied','A manager is required for staff handover.');
    if(!key(d.staffUid))fail('invalid-argument','Choose an authorised staff member.');const person=(await tx.get(db.doc('users/'+d.staffUid))).data();if(!allowed(person,STORE))fail('permission-denied',`The new staff member must have ${storeScope.name} access.`);patch.assignedStaff={uid:d.staffUid,name:clean(person.displayName||person.name)};Object.assign(audit,{fromStaff:s.assignedStaff.uid,toStaff:d.staffUid});
   }else if(action==='CONTACT') {
    const phone=customerMobile(clean(d.mobile,30));if(phone.error)fail('invalid-argument',phone.error);patch.customerPhone=phone.normalized;if(order)tx.update(orderRef,{customerPhone:phone.normalized,customerPhoneVerification:'UNVERIFIED',customerContactSource:'STAFF_ENTERED',customerMarketingConsent:false,bondPointsEarned:0});
   }else if(action==='BILL_REQUEST') {if(!order)fail('failed-precondition','Send at least one round before requesting a bill.');patch.status='BILL_REQUESTED';
   }else if(action==='COMPLIMENTARY_CLOSE') {
    if(!order||order.storeId!==STORE||order.tableSessionId!==s.id||!order.orderNumber||!activeLines(s).length||!['OCCUPIED','BILL_REQUESTED'].includes(s.status)||order.status!=='COMPLETED'||order.paymentStatus!=='UNPAID'||order.paymentMethod!=='PAY_AT_COUNTER'||order.commercialStatus!=='SALE')fail('failed-precondition','Only an eligible, confirmed-unpaid running bill can close as complimentary. Reconcile any payment first.');
    const name=clean(d.customerName,120),phone=clean(d.customerPhone,10),reason=clean(d.reason,240);
    if(!name||!reason||!/^[6-9][0-9]{9}$/.test(phone)||!key(d.authorizationId))fail('invalid-argument','Customer name, phone, reason and successful OTP authorization are required.');
    const authRef=db.doc('complimentaryAuthorizations/'+d.authorizationId);
    const [authorization,payments,tasks,items]=await Promise.all([tx.get(authRef),tx.get(orderRef.collection('payments')),tx.get(db.collection('kotItems').where('tableSessionId','==',s.id)),tx.get(orderRef.collection('items'))]);
    const a=authorization.data();
    if(!a||a.status!=='TABLE_VERIFIED'||a.used!==false||a.staffUid!==staff.uid||a.storeId!==STORE||a.tableSessionId!==s.id||a.orderId!==orderRef.id||a.tableVersion!==s.version||a.provider!=='FIREBASE_PHONE_AUTH'||a.customerPhoneE164!=='+91'+phone||typeof a.expiresAt?.toMillis!=='function'||a.expiresAt.toMillis()<=Date.now())fail('failed-precondition','Complimentary verification is expired, used or does not match this staff member and exact bill. Verify the phone again.');
    if((order.amountPaid!==undefined&&order.amountPaid!==0)||(order.paymentBreakdown!==undefined&&(!Array.isArray(order.paymentBreakdown)||order.paymentBreakdown.length))||order.tablePaymentAttemptId||order.razorpayPaymentId||order.razorpayOrderId||payments.docs.some(p=>p.id!=='PAY_AT_COUNTER'||p.data().method!=='PAY_AT_COUNTER'||p.data().amount!==0||(p.data().reference!=null&&p.data().reference!=='')))fail('failed-precondition','A payment record or uncertain payment exists. Reconcile it separately; this bill cannot be converted to complimentary.');
    if(tasks.docs.some(k=>!['SERVED','CANCELLED'].includes(k.data().status)))fail('failed-precondition','Kitchen items are still active. Mark served or reconcile cancellations before closing the table.');
    if(items.size!==s.lines.length||s.lines.some(l=>!items.docs.some(i=>i.id===l.id)))fail('failed-precondition','Saved bill lines are incomplete. Reconcile the bill before closing.');
    const canonical=tableTotals(s.lines),menuValue=canonical.subtotal;
    // Match the existing complimentary record/receipt representation. This is
    // not PAY_BEGIN with a100% discount and never creates a tender or payment.
    tx.update(orderRef,{...canonical,menuValue,discountPercent:100,discountAmount:menuValue,discountTotal:menuValue,discount:menuValue,complimentaryDiscount:menuValue,taxableAmount:0,taxTotal:0,gstTotal:0,grandTotal:0,payable:0,amountPaid:0,commercialStatus:'COMPLIMENTARY',paymentStatus:'NOT_REQUIRED',paymentMethod:'COMPLIMENTARY',paymentMethodLabel:'COMPLIMENTARY',isSplitPayment:false,paymentBreakdown:[],customerName:name,customerPhone:phone,customerPhoneVerification:'VERIFIED',complimentaryReason:reason,complimentaryAuthorizationId:authRef.id,complimentaryOtpVerified:true,complimentaryVerifiedPhone:phone,complimentaryOtpProvider:a.provider,complimentaryAuthorisedByUid:staff.uid,complimentaryAuthorisedByName:staff.name,complimentaryAuthorisedAt:timestamp(),settledAt:timestamp(),settledBy:staff.uid,settledByName:staff.name,tableClosingOperationId:d.opId,updatedAt:timestamp()});
    for(const item of items.docs){const line=item.data();const value=line.cancelled?0:line.lineSubtotal;tx.update(item.ref,{lineDiscount:value,lineTaxable:0,lineTax:0,lineTotal:0});}
    for(const payment of payments.docs)tx.delete(payment.ref); // validated zero placeholder only
    tx.update(authRef,{used:true,usedAt:timestamp(),usedByOrderId:orderRef.id,usedByOrderNumber:order.orderNumber,usedByTableSessionId:s.id,usedByOperationId:d.opId});
    tx.update(lockRef,{activeSessionId:null});
    Object.assign(patch,{status:'CLOSED',closedAt:Date.now(),outstanding:0,total:0,paymentAttempt:null,customerPhone:null,commercialStatus:'COMPLIMENTARY',paymentStatus:'NOT_REQUIRED',closingOperationId:d.opId});
    Object.assign(audit,{reason,orderId:orderRef.id,authorizationId:authRef.id,commercialStatus:'COMPLIMENTARY',menuValue});
   }else if(action==='PAY_BEGIN') {
    if(!order||!activeLines(s).length)fail('failed-precondition','There are no payable sent items.');const discount=Number(d.discountPercent||0),maximum={CASHIER:10,STORE_MANAGER:20,ADMIN:100}[profileSnap.data().role];if(!Number.isFinite(discount)||discount<0||discount>maximum)fail('permission-denied',`Your discount limit is ${maximum}%.`);
    const totals=tableTotals(s.lines,discount);patch.paymentAttempt={id:d.opId,frozenVersion:s.version,amount:totals.grandTotal,discountPercent:discount,startedAt:Date.now(),startedBy:staff.uid,totals};patch.status='PAYMENT_PENDING';patch.total=totals.grandTotal;patch.outstanding=totals.grandTotal;
    tx.update(orderRef,{...totals,updatedAt:timestamp()});for(const l of s.lines)tx.update(orderRef.collection('items').doc(l.id),tableLineTotals(l,discount));
   }else if(action==='PAY_CONFIRM') {
    const attempt=s.paymentAttempt;if(!attempt||attempt.id!==d.attemptId)fail('failed-precondition','Reconcile the existing payment attempt.');if(d.received!==true)fail('failed-precondition','Confirm the actual tender was received before marking paid.');
    if(!Array.isArray(d.payments)||d.payments.length<1||d.payments.length>6)fail('invalid-argument','Choose Cash, UPI, Card or split tenders.');const payments=d.payments.map(p=>({method:p.method,amount:money(p.amount)}));if(payments.some(p=>!['CASH','UPI','CARD'].includes(p.method)||!Number.isFinite(p.amount)||p.amount<0||(p.amount===0&&attempt.amount!==0))||Math.abs(payments.reduce((t,p)=>t+p.amount,0)-attempt.amount)>.009)fail('invalid-argument','Received tenders must equal the frozen amount exactly.');
    const totals=attempt.totals;for(const l of s.lines)tx.update(orderRef.collection('items').doc(l.id),tableLineTotals(l,attempt.discountPercent));
    payments.forEach((p,i)=>tx.create(orderRef.collection('payments').doc('TABLE_'+attempt.id+'_'+i),{...p,reference:null,paymentIndex:i+1,settledBy:staff.uid,settledByName:staff.name,createdAt:timestamp()}));
    tx.update(orderRef,{...totals,paymentStatus:'PAID',paymentMethod:payments.length>1?'SPLIT':payments[0].method,isSplitPayment:payments.length>1,paymentBreakdown:payments,paymentMethodLabel:payments.map(p=>p.method).join(' + '),settledAt:timestamp(),settledBy:staff.uid,settledByName:staff.name,tablePaymentAttemptId:attempt.id,updatedAt:timestamp()});patch.status='PAID_AWAITING_CLEAR';patch.outstanding=0;patch.paymentAttempt=null;patch.paidAt=Date.now();patch.payments=payments;patch.discountPercent=attempt.discountPercent;
   }else if(action==='PAY_CANCEL') {
    if(!s.paymentAttempt||s.paymentAttempt.id!==d.attemptId||d.confirmNoPaymentReceived!==true)fail('failed-precondition','Confirm no tender was received before cancelling the pending attempt.');patch.paymentAttempt=null;patch.status='BILL_REQUESTED';patch.total=tableTotals(s.lines).grandTotal;patch.outstanding=patch.total;Object.assign(audit,{attemptId:s.paymentAttempt.id,outcome:'NO_TENDER_RECEIVED'});
    tx.update(orderRef,{...tableTotals(s.lines),updatedAt:timestamp()});for(const l of s.lines)tx.update(orderRef.collection('items').doc(l.id),tableLineTotals(l,0));
   }else if(action==='CORRECT') {
    if(!allowed(profileSnap.data(),STORE,['ADMIN','STORE_MANAGER']))fail('permission-denied','Only Admin or Store Manager can cancel sent items.');const reason=clean(d.reason,240);if(!reason)fail('invalid-argument','A cancellation reason is required.');const line=s.lines.find(l=>l.id===d.lineId);if(!line||line.cancelled)fail('failed-precondition','This sent item is unavailable or already cancelled.');
    const tasks=await tx.get(db.collection('kotItems').where('tableSessionId','==',s.id));const lineTasks=tasks.docs.filter(k=>k.data().orderItemId===line.id);const prepared=lineTasks.some(k=>k.data().tablePreparationStarted===true||k.data().status!=='PENDING');
    const pending=await tx.get(db.collection('pendingInventoryConsumption').where('orderId','==',orderRef.id));const linePending=pending.docs.filter(p=>p.data().orderLineId===line.id||String(p.data().orderLineId||'').startsWith(line.id+'__COMP_'));
    if(prepared&&linePending.some(p=>p.data().status==='PENDING_BOM'))fail('failed-precondition','Prepared item has unresolved BOM consumption. Resolve its inventory record before cancellation. No stock was changed.');
    const originalMovements=await tx.get(db.collection('stockMovements').where('referenceId','==',orderRef.id));
    const movements=originalMovements.docs.filter(m=>m.data().movementType==='SALE_DEDUCTION'&&(m.data().orderLineKey===line.id||String(m.data().orderLineKey||'').startsWith(line.id+'__COMP_')));
    const currentLine=(await tx.get(orderRef.collection('items').doc(line.id))).data();
    if((line.movementIds||[]).some(id=>!movements.some(m=>m.id===id)))fail('failed-precondition','Original stock evidence is incomplete. Reconcile this item before cancellation.');
    const actualCogs=Number(currentLine?.cogsAmount??line.cogsAmount);if(!Number.isFinite(actualCogs))fail('failed-precondition','Item cost evidence is unavailable. Reconcile inventory before cancellation.');
    const stocks=new Map();for(const m of movements){if(!m.exists)fail('failed-precondition','Original stock evidence is missing.');const value=m.data(),id=value.stockDocId||`${value.storeId}_${value.stockItemType}_${value.stockItemCode}`;if(!stocks.has(id))stocks.set(id,await tx.get(db.doc('storeStock/'+id)));}
    const reversals=movements.length?await tx.getAll(...movements.map(m=>db.doc('stockMovements/'+deterministicVoidReversalMovementId(m.id)))):[];if(reversals.some(r=>r.exists))fail('failed-precondition','This item already has a stock reversal. Reconcile before continuing.');
    const balances=new Map([...stocks].map(([id,snap])=>[id,Number(snap.data()?.currentStock)]));
    if(!prepared)for(const m of movements){const movement={id:m.id,...m.data()},id=movement.stockDocId||`${movement.storeId}_${movement.stockItemType}_${movement.stockItemCode}`,payload=buildVoidStockReversal({movement,order:{id:orderRef.id,...order},store,inventoryStore:store,currentStock:balances.get(id),staffUid:staff.uid,staffName:staff.name,reason,timestamp:timestamp()});balances.set(id,payload.stockAfter);tx.update(db.doc('storeStock/'+id),{currentStock:payload.stockAfter,updatedAt:timestamp()});tx.create(db.doc('stockMovements/'+deterministicVoidReversalMovementId(m.id)),{...payload,tableSessionId:s.id,tableCorrectionId:d.opId})}
    if(!prepared)for(const p of linePending)if(p.data().status==='PENDING_BOM')tx.update(p.ref,{status:'CANCELLED',reason:'Table item cancelled before preparation: '+reason,resolvedAt:timestamp(),resolvedBy:staff.uid});
    for(const task of lineTasks)tx.update(task.ref,{status:'CANCELLED',voidReason:reason,updatedAt:timestamp(),handledByUserId:staff.uid,handledByName:staff.name});
    patch.lines=s.lines.map(l=>l.id===line.id?{...l,cancelled:true,cancelReason:reason,cancelledBy:staff.uid,cancelledAt:Date.now()}:l);patch.total=tableTotals(patch.lines).grandTotal;patch.outstanding=patch.total;
    tx.update(orderRef.collection('items').doc(line.id),{quantity:0,cancelledQuantity:line.quantity,status:'CANCELLED',...tableLineTotals({...line,cancelled:true},0),cogsAmount:0,cancellationReason:reason});
    tx.update(orderRef,{...tableTotals(patch.lines),cogsTotal:money(Math.max(0,(order.cogsTotal||0)-actualCogs)),updatedAt:timestamp()});
    Object.assign(audit,{lineId:line.id,reason,inventoryTreatment:prepared?'PREPARED_NO_RESTOCK':'EXISTING_VOID_REVERSAL',wastageCost:prepared?actualCogs:0,reversalCount:prepared?0:movements.length});
   }else if(action==='CLOSE_EMPTY') {
    if(activeLines(s).length)fail('failed-precondition','This session has active sent items. Settle the bill or use a manager correction.');
    if(order){if(!allowed(profileSnap.data(),STORE,['ADMIN','STORE_MANAGER'])||!clean(d.reason,240))fail('permission-denied','A manager and reason are required to close a cancelled bill.');tx.update(orderRef,{status:'VOIDED',voidReason:clean(d.reason,240),voidedBy:staff.uid,voidedByName:staff.name,voidedAt:timestamp(),updatedAt:timestamp()})}
    tx.update(lockRef,{activeSessionId:null});patch.status='CLOSED';patch.closedAt=Date.now();patch.customerPhone=null;
   }else if(action==='CLEAR') {
    if(s.status!=='PAID_AWAITING_CLEAR'||s.outstanding!==0||s.paymentAttempt)fail('failed-precondition','Only a paid, resolved table may be cleared.');const tasks=await tx.get(db.collection('kotItems').where('tableSessionId','==',s.id));if(tasks.docs.some(k=>!['SERVED','CANCELLED'].includes(k.data().status)))fail('failed-precondition','Kitchen items are still active. Mark served or reconcile cancellations before clearing.');tx.update(lockRef,{activeSessionId:null});patch.status='CLOSED';patch.closedAt=Date.now();patch.customerPhone=null;
   }else fail('invalid-argument','Unknown table action.');
   const next={...patch,version:s.version+1};tx.update(ref,next);tx.create(db.doc('tableAudit/'+hash([staff.uid,d.opId])),audit);return saveOp({sessionId:s.id,version:next.version,status:next.status||s.status});
  });
 }
 return {run,STORE};
}
module.exports={createTableService,STORE};
