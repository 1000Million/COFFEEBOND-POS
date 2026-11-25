'use strict';
// Invoked by the emulator suite against the exact packaged public callable wrapper.
const {createRequire}=require('node:module');const path=require('node:path');const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
assert.equal(process.env.GCLOUD_PROJECT,'demo-general-pos-workflow');assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:8693');
const req=createRequire(path.resolve(process.env.TABLE_RECOVERY_PACKAGE,'package.json'));const service=req('./index.js').tableService;
const [storeId,uid,sessionId]=process.argv.slice(2);const call=(action,props={})=>service.run({auth:{uid},data:{storeId,action,opId:randomUUID(),...props}});
(async()=>{
 const board=await call('BOARD');assert.equal(board.recoveryMode,true);assert.equal(board.enableNewSessions,false);
 await assert.rejects(()=>call('OPEN',{tableId:'AVAILABLE',sessionId:randomUUID()}),e=>e.code==='failed-precondition');
 const original=await call('DETAIL',{sessionId});assert.equal(original.status,'PAYMENT_PENDING');
 const payment={sessionId,version:original.version,attemptId:original.paymentAttempt.id,opId:randomUUID(),received:true,payments:[{method:'CASH',amount:original.paymentAttempt.amount}]};
 const ack=await call('PAY_CONFIRM',payment);assert.equal(ack.status,'PAID_AWAITING_CLEAR');assert.equal((await call('PAY_CONFIRM',payment)).reconciled,true);
 const receipt=await call('DETAIL',{sessionId});assert.equal(receipt.orderId,original.orderId);assert.equal(receipt.saved.payments.filter(p=>p.method==='CASH').length,1);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>req('firebase-admin').app().delete());
