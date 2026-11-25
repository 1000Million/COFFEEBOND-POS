// Local Firestore emulator only. Real callable transaction + released rules;
// no production credentials or writes, no provider/payment API calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing';
import { doc, updateDoc } from 'firebase/firestore';
const require=createRequire(import.meta.url);
const admin=require('../functions/node_modules/firebase-admin');
const {createRejectCustomerOrderFunction}=require('../functions/rejectCustomerOrder');
const {canonicalizeFrozenOrderCart}=require('../functions/posAddOnAuthorization');
const PROJECT='demo-legacy-rejection';
assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:8188','Test may only use the named localhost emulator');
const app=admin.initializeApp({projectId:PROJECT},'legacy-rejection-test');
const db=app.firestore();
const rules=fs.readFileSync(new URL('../evidence/live-firestore.rules',new URL('../',import.meta.url)),'utf8');
const env=await initializeTestEnvironment({projectId:PROJECT,firestore:{host:'127.0.0.1',port:8188,rules}});
const reject=createRejectCustomerOrderFunction({db,region:'us-central1'}).run;
const pass=name=>console.log(name+'=PASS');
const auth=uid=>({uid,token:{}});
const request=(id,uid='ADMIN',reason='Legacy order cannot be fulfilled')=>({auth:auth(uid),data:{onlineOrderId:id,reason}});
const store='QA_UDAY_PARK';
const validItem={finishedGoodCode:'QA_PRODUCT',itemName:'Synthetic legacy item',quantity:1,baseUnitPrice:100,addOnTotal:0,addOns:[],taxRate:5,lineTotal:105};
const legacyItem={...validItem,unitPrice:100};delete legacyItem.baseUnitPrice;delete legacyItem.addOnTotal;
const base={storeId:store,status:'PENDING',source:'CUSTOMER_WEB',items:[legacyItem],grandTotal:105,subtotal:100,gstTotal:5,createdAt:'2026-07-04T07:30:45.423Z'};
const current={...base,items:[validItem],paymentProvider:'PAY_AT_COUNTER',paymentMethod:'PAY_AT_COUNTER',paymentStatus:'NOT_STARTED'};
const frozen=(item,available=true)=>canonicalizeFrozenOrderCart({storeId:store,store:{id:store},requestedItems:[{orderItemId:'LINE',parentProductId:'QA_PRODUCT',parentProductCode:'QA_PRODUCT',quantity:1,selectedAddOns:[]}],sourceItems:[item],productsById:{QA_PRODUCT:{id:'QA_PRODUCT',code:'QA_PRODUCT',isActive:true,isSellable:true,isAvailable:available,availableStoreIds:[store]}}});
const snapshot=async id=>(await db.doc('onlineOrders/'+id).get()).data();
const businessCollections=['orders','kotItems','stockMovements','storeStock','storeInventory','pendingInventoryConsumption','razorpayRefunds','razorpayPaymentIntents'];
const noBusinessWrites=async()=>{for(const name of businessCollections)assert.equal((await db.collection(name).get()).size,0,name+' must remain empty');};
const financial=data=>Object.fromEntries(Object.entries(data).filter(([k])=>!['status','rejectReason','customerStatusMessage','rejectedBy','rejectedByName','rejectedAt','updatedAt'].includes(k)));
try {
 await env.clearFirestore();
 for(const [uid,profile] of Object.entries({ADMIN:{role:'ADMIN'},MANAGER:{role:'STORE_MANAGER',assignedStoreIds:[store]},CASHIER:{role:'CASHIER',storeIds:[store]},WRONG_MANAGER:{role:'STORE_MANAGER',assignedStoreIds:['OTHER']},KITCHEN:{role:'KITCHEN',assignedStoreIds:[store]},INACTIVE:{role:'ADMIN',isActive:false}}))await db.doc('users/'+uid).set({name:uid,isActive:true,...profile});
 assert.throws(()=>frozen(legacyItem),/stored online-order price snapshot is malformed/);pass('LEGACY_MALFORMED_ACCEPT_BLOCKED');
 assert.throws(()=>frozen(validItem,false),/no longer available at this store/);pass('UNAVAILABLE_FINISHED_GOOD_ACCEPT_BLOCKED');
 const canonical=frozen(validItem);assert.equal(canonical.canonicalItems.LINE.baseUnitPrice,100);pass('VALID_CURRENT_ORDER_ACCEPT_PRICING');
 for(const kind of ['MALFORMED','UNAVAILABLE']){
  for(const uid of ['ADMIN','MANAGER','CASHIER']){
   const id=kind+'_'+uid;
   const order={...base,status:kind==='UNAVAILABLE'?'NEEDS_ATTENTION':'PENDING',items:kind==='MALFORMED'?[legacyItem]:[validItem],attentionReason:kind==='UNAVAILABLE'?'Finished good unavailable':''};
   await db.doc('onlineOrders/'+id).set(order);
   const client=env.authenticatedContext(uid).firestore();
   const denial=await assertFails(updateDoc(doc(client,'onlineOrders',id),{status:'REJECTED',rejectReason:'Old direct write'}));assert.equal(denial.code,'permission-denied');
   const result=await reject(request(id,uid));assert.equal(result.status,'REJECTED');assert.equal(result.alreadyRejected,false);
   const first=await snapshot(id);assert.deepEqual(financial(first),financial(order));assert.equal(first.rejectedBy,uid);
   const retry=await reject(request(id,uid,'Different retry reason'));assert.equal(retry.alreadyRejected,true);assert.deepEqual(await snapshot(id),first);
   await noBusinessWrites();
  }
  pass(kind+'_REJECT_ALLOWED');pass(kind+'_REJECT_EXACTLY_ONCE');pass(kind+'_NO_POS_KOT_STOCK_OR_REFUND');
 }
 pass('DIRECT_WRITE_PERMISSION_DENIAL_REPRODUCED');pass('ADMIN_REJECTION');pass('MANAGER_ASSIGNED_STORE_REJECTION');pass('CASHIER_ASSIGNED_STORE_REJECTION');pass('LEGACY_COUNTER_REJECTION_NO_REFUND');
 await db.doc('onlineOrders/CURRENT').set({...current,trackingToken:'QA_TRACKING',couponCode:'UNCHANGED_COUPON',couponDiscount:5});
 await db.doc('publicOrderTracking/QA_TRACKING').set({trackingToken:'QA_TRACKING',publicStatus:'PENDING',total:'legacy monetary data',extraLegacyField:true});
 await reject(request('CURRENT'));
 assert.equal((await snapshot('CURRENT')).couponCode,'UNCHANGED_COUPON');assert.equal((await snapshot('CURRENT')).couponDiscount,5);
 assert.deepEqual((await db.doc('publicOrderTracking/QA_TRACKING').get()).data(),{trackingToken:'QA_TRACKING',publicStatus:'REJECTED',total:'legacy monetary data',extraLegacyField:true,customerStatusMessage:'Sorry, the store could not accept this order.'});
 pass('VALID_CURRENT_ORDER_REJECT');pass('TRACKING_ATOMIC_STATUS_ONLY_NO_PRICE_REPAIR');
 // Missing tracking records do not prevent status cleanup or create new historical data.
 await db.doc('onlineOrders/MISSING_TRACKING').set({...base,trackingToken:'MISSING'});await reject(request('MISSING_TRACKING'));assert.equal((await db.doc('publicOrderTracking/MISSING').get()).exists,false);pass('MISSING_TRACKING_SAFE');
 await db.doc('onlineOrders/RACE').set(current);
 const racing=await Promise.all([reject(request('RACE','ADMIN','First reason')),reject(request('RACE','MANAGER','Second reason'))]);
 assert.deepEqual(racing.map(r=>r.alreadyRejected).sort(),[false,true]);pass('CONCURRENT_REJECT_EXACTLY_ONCE');
 for(const reason of ['', '  ',null,42,'x'.repeat(501)])await assert.rejects(reject(request('RACE','ADMIN',reason)),e=>e.code==='invalid-argument');pass('REJECTION_REASON_REQUIRED');
 await db.doc('onlineOrders/PROTECTED').set(base);
 for(const uid of ['WRONG_MANAGER','KITCHEN','INACTIVE','MISSING_USER'])await assert.rejects(reject(request('PROTECTED',uid)),e=>e.code==='permission-denied');
 await assert.rejects(reject({data:{onlineOrderId:'PROTECTED',reason:'Reason'}}),e=>e.code==='unauthenticated');
 assert.equal((await snapshot('PROTECTED')).status,'PENDING');pass('AUTH_ROLE_STORE_DENIALS');
 const paidCases=[{paymentProvider:'RAZORPAY'},...['PAID','PARTIAL','REFUND_PENDING','REFUNDED','REFUND_FAILED','PAYMENT_REVIEW_REQUIRED','PAYMENT_PROCESSING','AWAITING_PAYMENT'].map(paymentStatus=>({paymentStatus})),{paymentMethod:'ONLINE'},{paymentMethod:'UPI'},{paymentProvider:'UNKNOWN'},...['paymentCapturedAt','paidAt','providerPaymentId','providerOrderId','razorpayPaymentId','razorpayOrderId','paymentIntentId','checkoutSessionId','refundStatus','refundId','refundRequestedAt'].map(k=>({[k]:'PAYMENT_MARKER'})),{paidAmount:100},{isPaid:true},{paid:true},{paymentCaptured:true}];
 for(const [i,patch] of paidCases.entries()){
  const id='PAID_'+i;await db.doc('onlineOrders/'+id).set({...base,...patch});const before=await snapshot(id);
  await assert.rejects(reject(request(id)),e=>e.code==='failed-precondition'&&e.message.includes('refund workflow'));
  assert.deepEqual(await snapshot(id),before);
 }
 pass('MALFORMED_PAID_ORDER_REFUND_SAFETY');
 for(const status of ['ACCEPTED','CONVERTED','ACCEPTED_AWAITING_PAYMENT','PAID_PENDING_ACCEPTANCE','REFUND_PENDING','PAYMENT_REVIEW_REQUIRED']){
  const id='STATUS_'+status;await db.doc('onlineOrders/'+id).set({...base,status});await assert.rejects(reject(request(id)),e=>e.code==='failed-precondition');
 }
 for(const field of ['linkedOrderId','linkedOrderNumber','acceptedAt','convertedAt']){
  const id='LINK_'+field;await db.doc('onlineOrders/'+id).set({...base,[field]:'EXISTS'});await assert.rejects(reject(request(id)),e=>e.code==='failed-precondition');
 }
 pass('ACCEPTED_AND_LINKED_ORDER_SAFETY');
 // Use the exact existing pending-query criteria; rejection removes just this order.
 await db.doc('onlineOrders/ALERT_ONE').set({...base,storeId:'QA_ALERT'});await db.doc('onlineOrders/ALERT_TWO').set({...base,storeId:'QA_ALERT'});
 const pending=()=>db.collection('onlineOrders').where('storeId','==','QA_ALERT').where('status','==','PENDING').get();
 assert.equal((await pending()).size,2);await reject(request('ALERT_ONE'));assert.equal((await pending()).size,1);await reject(request('ALERT_TWO'));assert.equal((await pending()).size,0);pass('REJECTED_ORDER_REMOVED_FROM_ALERT_SET');
 await noBusinessWrites();pass('NO_POS_CREATED');pass('NO_KOT_CREATED');pass('NO_STOCK_MOVEMENT');pass('NO_REFUND');
 const root=new URL('../',import.meta.url);const page=fs.readFileSync(new URL('frontend/pages/pos/IncomingOnlineOrders.tsx',root),'utf8');
 const previous=fs.readFileSync('/Users/narendrashukla/Documents/Codex/2026-09-23/global-online-alert/staff/frontend/pages/pos/IncomingOnlineOrders.tsx','utf8');
 const cut=(s,a,b)=>s.slice(s.indexOf(a),s.indexOf(b));
 assert.equal(cut(page,'  const handleAccept =','  const handleReject ='),cut(previous,'  const handleAccept =','  const handleReject ='));
 assert(!/updateDoc|serverTimestamp|updatePublicOrderTracking/.test(page));assert(page.includes('await rejectCustomerOrder({ onlineOrderId: order.id, reason })'));
 pass('ACCEPT_AND_REFUND_HANDLERS_UNCHANGED');pass('CLIENT_REJECTION_HAS_NO_DIRECT_WRITES');
} finally {await env.cleanup();await app.delete();}
