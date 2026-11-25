import { restoreBundle10 } from './bundle10-test-support.mjs';
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {buildSync,transformSync} from 'esbuild';
const root=new URL('../',import.meta.url).pathname;
const fixture=JSON.parse(fs.readFileSync(root+'scripts/fixtures/pos-order-lifecycle.baseline.json'));
const before=process.argv.includes('--before');
const current=restoreBundle10(fs.readFileSync(root+'frontend/pages/pos/POSHome.tsx','utf8'),{includeRecoveryHandlers:!before});
if(before)assert.equal(crypto.createHash('sha256').update(current).digest('hex'),fixture.sourceSha256);
const plain=x=>JSON.parse(JSON.stringify(x));
const fixed='2026-09-20T04:00:00.000Z';
class FixedDate extends Date {constructor(...args){super(...(args.length?args:[fixed]))} static now(){return new Date(fixed).getTime()}}
function compile(text,c){vm.runInNewContext(transformSync(text,{loader:'ts',format:'cjs'}).code,c)}
function load(file){const c={module:{exports:{}},exports:{},Date:FixedDate};vm.runInNewContext(buildSync({entryPoints:[root+file],bundle:true,write:false,format:'cjs',platform:'node'}).outputFiles[0].text,c);return c.module.exports}
const deps={...load('frontend/lib/pos/posTax.ts'),...load('frontend/lib/pos/posPayments.ts'),...load('frontend/lib/addOns.ts'),...load('frontend/lib/complimentaryOrders.ts'),...load('frontend/lib/pos/pendingCheckoutRecovery.ts')};
const lifecycle=before?{}:load('frontend/lib/pos/posOrderLifecycle.ts');
const slice=(a,b)=>{const i=current.indexOf(a);assert(i>=0,a);return current.slice(i,current.indexOf(b,i))};
function context(extra={}) {return {...deps,...lifecycle,checkoutAttemptRef:{current:null},Date:FixedDate,module:{exports:{}},exports:{},...extra}}
const cart=[{menuItemId:'COOKIE',name:'Cookie',quantity:2,price:100,taxRate:5,addOns:[]}];
const store={id:'GOLDEN_I',name:'Golden I',code:'GOLDEN_I',isActive:true};
const bill={id:'held-1',storeId:'GOLDEN_I',storeName:'Golden I',orderType:'TAKEAWAY',tableNumber:'',customerName:'QA',customerPhone:'',cart,discountPercentStr:'10',isSplitPayment:true,splitPayments:[{id:'split-1',method:'CASH',amountStr:'189'}],heldAtIso:fixed,itemCount:2,total:189};
function held(after,actions,options={}){
 const events=[],writes=[];const c=context({cart:plain(cart),stores:[store],selectedStoreId:store.id,orderType:'TAKEAWAY',tableNumber:'',customerName:'QA',customerPhone:'',discountPercentStr:'10',isSplitPayment:true,splitPayments:plain(bill.splitPayments),heldBills:[],cartTotals:{grandTotal:189},razorpayPaymentLocked:false,createSafeClientId:()=> 'held-1',requireOnlineAction:()=>options.online!==false,alert:message=>events.push(['alert',message]),window:{confirm:message=>{events.push(['confirm',message]);return options.confirm!==false}},...options});
 const names=['SelectedStoreId','OrderType','TableNumber','CustomerName','CustomerPhone','Cart','DiscountPercentStr','IsSplitPayment','SplitPayments','PaymentMethod','CheckoutError','TableNumberError','IsRecallMenuOpen','IsMobileCartOpen'];
 for(const n of names)c['set'+n]=value=>{c[n[0].toLowerCase()+n.slice(1)]=value;events.push(['set'+n,plain(value)])};
 c.persistHeldBills=value=>{c.heldBills=value;writes.push(plain(value))};c.clearCart=value=>{events.push(['clearCart',value]);c.cart=[]};
 compile((after&&!before?slice('  const holdCurrentBill =','  const setSplitPaymentMode ='):fixture.held)+'\nmodule.exports={holdCurrentBill,recallHeldBill,deleteHeldBill};',c);
 for(const action of actions)c.module.exports[action](plain(options.bill||bill));
 return plain({events,writes,cart:c.cart,heldBills:c.heldBills,splitPayments:c.splitPayments});
}
let cases=0;
function parity(name,fn){const b=fn(false),a=fn(true);assert.deepEqual(a,b,name);cases++;return a}
const validHold=parity('valid hold',a=>held(a,['holdCurrentBill']));assert.equal(validHold.writes.length,1);assert.equal(validHold.writes[0][0].total,189);assert.deepEqual(validHold.cart,[]);
assert(!fixture.held.includes('transaction.')&&!fixture.held.includes('buildKotTasks')&&!fixture.held.includes('planInventoryDeduction'));cases+=2;
for(const options of [{cart:[]},{razorpayPaymentLocked:true},{stores:[]},{online:false}])parity('hold eligibility '+JSON.stringify(options),a=>held(a,['holdCurrentBill'],options));
for(const actions of [['recallHeldBill'],['recallHeldBill','recallHeldBill'],['deleteHeldBill'],['deleteHeldBill','deleteHeldBill']]){
 const r=parity(actions.join(','),a=>held(a,actions,{heldBills:[plain(bill)]}));assert.deepEqual(r.heldBills,[]);if(actions[0]==='recallHeldBill')assert.equal(r.cart.length,1);
}
for(const options of [{stores:[]},{confirm:false},{online:false},{razorpayPaymentLocked:true},{bill:{...bill,isSplitPayment:undefined,splitPayments:undefined,orderType:'DINE_IN'}}])parity('recall guards/fallback',a=>held(a,['recallHeldBill'],options));
parity('delete nonexistent',a=>held(a,['deleteHeldBill'],{heldBills:[]}));
parity('delete cancelled',a=>held(a,['deleteHeldBill'],{heldBills:[bill],confirm:false}));
function preflight(after,options){const events=[];const c=context({cart,selectedStoreId:'GOLDEN_I',isSplitPayment:false,selectedPaymentMethod:'CASH',splitPayments:[],alert:s=>events.push(s),...options});const body=after&&!before?slice('    const checkoutPreconditionError =','    if (isSetupTestSale &&'):fixture.preconditions;compile('function run(){'+body+';return "ALLOWED";} module.exports=run;',c);return plain({result:c.module.exports()||null,events})}
for(const [name,options,allowed] of [['empty',{cart:[]},false],['missing store',{selectedStoreId:''},false],['missing payment',{selectedPaymentMethod:''},false],['missing split',{isSplitPayment:true},false],['cash',{},true],['upi',{selectedPaymentMethod:'UPI'},true],['split',{isSplitPayment:true,splitPayments:bill.splitPayments},true]]){const r=parity(name,a=>preflight(a,options));assert.equal(r.result==='ALLOWED',allowed)}
function payments(after,rows,total=189){const c=context({isComplimentaryCheckout:false,isSplitPayment:true,splitPayments:rows,trueGrandTotal:total,selectedPaymentMethod:'CASH'});try{compile((after&&!before?slice('      const paymentRows: ReceiptPaymentSnapshot[]','      const requestPayloadHash ='):fixture.paymentPreparation)+'\nmodule.exports=paymentRows;',c);return plain(c.module.exports)}catch(e){return e.message}}
for(const rows of [[{method:'CASH',amountStr:'100'},{method:'UPI',amountStr:'89'}],[{method:'CASH',amountStr:'188'}],[{method:'CASH',amountStr:'190'}],[{method:'CASH',amountStr:'0'}]])parity('complete payment precondition',a=>payments(a,rows));
function receipt(after,order,items,payments){const c=context();if(!after||before)compile(fixture.functions.buildReceiptSnapshot+'\nmodule.exports=buildReceiptSnapshot;',c);else c.module.exports=lifecycle.buildReceiptSnapshot;return plain(c.module.exports(order,items,payments,store))}
for(const commercialStatus of ['SALE','COMPLIMENTARY'])for(const payments of [[],[{method:'CASH',amount:189}],[{method:'CASH',amount:100},{method:'UPI',amount:89}],[{method:'CREDIT',amount:0}]]){
 const order={orderNumber:'QA',createdByName:'QA',orderType:'TAKEAWAY',subtotal:200,discount:20,taxTotal:9,grandTotal:189,commercialStatus};parity('receipt '+commercialStatus,a=>receipt(a,order,[{itemName:'Cookie',quantity:2,unitPrice:100,addOns:[]}],payments));
}
const helperNames=Object.keys(fixture.functions).filter(n=>n!=='buildReceiptSnapshot');
const b=context();compile(helperNames.map(n=>fixture.functions[n]).join('\n')+'\nmodule.exports={'+helperNames.join(',')+'};',b);
const helperInputs={sanitizeFirestoreId:[' a/b # C ',8],stableJson:[{z:null,a:[2,1]}],shortHash:[{z:2,a:1}],cartLineIdentity:[cart[0],{id:'COOKIE',code:'CK'},[]],deterministicOrderItemId:['ORDER',{productCode:'CK'},2],deterministicKotId:['ORDER','LINE','BARISTA'],deterministicPaymentId:['ORDER',{method:'UPI',amount:189},1],deterministicStockMovementId:['ORDER',{stockDocId:'STOCK',movementType:'SALE_DEDUCTION'}],checkoutPayloadHash:[{cart,payments:[{method:'CASH',amount:189}]}]};
for(const [n,args]of Object.entries(helperInputs)){const a=before?b.module.exports[n]:lifecycle[n]||b.module.exports[n];assert.deepEqual(plain(a(...args)),plain(b.module.exports[n](...args)),n);cases++}
const tx=slice('      const transactionResult = await runTransaction','      const recoveredResult =');assert.equal(tx,fixture.transaction,'Entire transaction body, order/payment payloads, KOT, stock and retry decision must remain byte-identical');
assert.equal(slice('        const paymentStatus: Order','        if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction: saving order data'),fixture.orderPayload);
assert.equal(slice('        const paymentsToWrite:','        if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction write phase complete'),fixture.paymentPayload);cases+=3;
const count=s=>({POS_ORDER:(s.match(/transaction\.set\(newOrderRef,/g)||[]).length,KOT:(s.match(/transaction\.set\(kotRef,/g)||[]).length,STOCK:(s.match(/transaction\.(?:set|update)\((?:update.stockRef|movementRef|pendingRef),/g)||[]).length});
assert.deepEqual(count(tx),count(fixture.transaction));assert.deepEqual(count(tx),{POS_ORDER:1,KOT:1,STOCK:4});
const heldCount=s=>(s.match(/persistHeldBills\(/g)||[]).length;assert.equal(heldCount(slice('  const holdCurrentBill =','  const setSplitPaymentMode =')),heldCount(fixture.held));
if(!before){const module=fs.readFileSync(root+'frontend/lib/pos/posOrderLifecycle.ts','utf8');assert(!/firebase|localStorage|transaction\.|setDoc|updateDoc|deleteDoc|runTransaction/.test(module),'Lifecycle module must not introduce write paths')}
console.log(`POS_ORDER_LIFECYCLE_${before?'BEFORE':'AFTER'}=PASS; ${cases} cases; order/payment transaction byte parity PASS`);
console.log(JSON.stringify({writePathsBefore:count(fixture.transaction),writePathsAfter:count(tx),heldPathsBefore:heldCount(fixture.held),heldPathsAfter:heldCount(slice('  const holdCurrentBill =','  const setSplitPaymentMode ='))}));
