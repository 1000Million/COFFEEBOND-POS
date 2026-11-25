// Execute the sealed transaction and the actual new caller/repository against
// an atomic memory store. Firebase imports are replaced before evaluation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { build, transformSync } from 'esbuild';
import { extraction, restoreBundle10 } from './bundle10-test-support.mjs';
const root = new URL('../', import.meta.url).pathname;
const read = p => fs.readFileSync(root + p, 'utf8');
const page = read('frontend/pages/pos/POSHome.tsx');
const sealed = restoreBundle10(page);
const repo = read('frontend/data/orders/posOrderRepository.ts');
for (const [file, expected] of Object.entries(extraction.unchangedSourceSha256)) assert.equal(crypto.createHash('sha256').update(read(file)).digest('hex'), expected, file+' sealed identity');
const transactionEdit = extraction.edits.find(e => e.name === 'transaction');
const plain = value => JSON.parse(JSON.stringify(value));
const time = Date.parse('2026-09-20T04:00:00Z');
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [time])); } static now() { return time; } }
class Timestamp { constructor(ms) { this.ms = ms; } toMillis() { return this.ms; } }
const clone = value => value instanceof Timestamp ? new Timestamp(value.ms) : Array.isArray(value) ? value.map(clone) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k,clone(v)])) : value;
function database(initial, { retry = false, failWrite = 0 } = {}) {
  const records = new Map(Object.entries(clone(initial))), writes = [], reads = [], attempts = [];
  let queue = Promise.resolve();
  const ref = path => ({ path, id: path.split('/').at(-1) });
  const snap = (r, data) => ({ ...r, ref: r, exists: () => data.has(r.path), data: () => clone(data.get(r.path)) });
  const db = {
    async run(callback) {
      const execute = async () => {
        for (let attempt = 0; ; attempt++) {
          const view = new Map(records), pending = [], seen = [];
          const write = (method, r, data, options) => {
            if (failWrite && pending.length + 1 === failWrite) throw new Error('INJECTED_WRITE_FAILURE');
            if (method === 'update') assert(view.has(r.path), `Missing update target ${r.path}`);
            pending.push({ method, path: r.path, data: clone(data), ...(options ? {options} : {}) });
            view.set(r.path, method === 'update' || options?.merge ? {...view.get(r.path), ...clone(data)} : clone(data));
          };
          const tx = {
            get: async r => { assert.equal(pending.length, 0, 'All reads precede writes'); seen.push(r.path); return snap(r, view); },
            set: (r, d, o) => write('set', r, d, o), update: (r,d) => write('update',r,d),
          };
          const result = await callback(tx);
          attempts.push({ reads: seen, writes: pending });
          if (retry && attempt === 0) continue; // discard conflicting attempt atomically
          records.clear(); for (const entry of view) records.set(...entry);
          writes.push(...pending); reads.push(...seen); return result;
        }
      };
      const promise = queue.then(execute); queue = promise.catch(() => {}); return promise;
    },
  };
  const firestore = {
    collection: (base,...parts) => ref([base.path,...parts].filter(Boolean).join('/')),
    doc: (base,...parts) => ref([base.path,...parts].filter(Boolean).join('/')),
    serverTimestamp: () => 'SERVER_TIMESTAMP', Timestamp,
    runTransaction: (d,fn) => { assert.equal(d,db); return db.run(fn); },
  };
  return { db, firestore, records, writes, reads, attempts, ref };
}
const mock = { name:'no-production-access', setup(b) {
  b.onResolve({filter:/^firebase\/firestore$/}, () => ({path:'firestore',namespace:'mock'}));
  b.onResolve({filter:/(^|\/)firebase$/}, () => ({path:'db',namespace:'mock'}));
  b.onLoad({filter:/.*/,namespace:'mock'}, ({path}) => ({loader:'js', contents:path === 'db' ? 'export const db = globalThis.__db;' : 'const f=globalThis.__firestore; export const {doc,collection,serverTimestamp,runTransaction,Timestamp}=f;'}));
} };
async function bundle(entry) {
  return (await build({stdin:{contents:entry,resolveDir:root,loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,define:{'import.meta.env.DEV':'false'},plugins:[mock]})).outputFiles[0].text;
}
const domainCode = await bundle([
 'pos/posOrderLifecycle','pos/posPayments','pos/posTax','addOns','complimentaryOrders','compositeFulfillment','inventoryDeduction','posCheckoutAccess',
].map(p => `export * from './frontend/lib/${p}';`).join('\n'));
const repositoryCode = await bundle("export * from './frontend/data/orders/posOrderRepository';");
function exportsOf(code, globals) { const module = {exports:{}}; vm.runInNewContext(code, {...globals,module,exports:module.exports}); return module.exports; }
const helperSource = extraction.edits.find(e=>e.name==='ids').original + sealed.slice(sealed.indexOf('function normalizePrepStation'), sealed.indexOf('function readLocalStorageJson')) + sealed.slice(sealed.indexOf('class CheckoutBlockerError'),sealed.indexOf('const TAX_SETTING_DOC_IDS'));
const fnCode = after => transformSync(helperSource + '\nasync function execute(){\n' + (after ? transactionEdit.replacement : transactionEdit.original) + '\nreturn transactionResult;\n}\nglobalThis.execute=execute;', {loader:'ts',format:'cjs',define:{'import.meta.env.DEV':'false'}}).code;
const compiled = [fnCode(false),fnCode(true)];
function setup(after, options = {}) {
  const method = options.method || 'CASH', split = method === 'SPLIT', comp = method === 'COMPLIMENTARY';
  const store = {id:'NOIDA_29',code:'NOIDA_29',name:'Test store',inventoryPolicy:'ALLOW_NEGATIVE_DEFER_BOM',gstRegistered:true,gstin:'TESTGST',stateName:'Test State',stateCode:'09'};
  const bom = options.missingBom ? [] : [{componentType:'RAW_INGREDIENT',componentCode:'RAW_FIXTURE',componentName:'Ingredient',quantity:150,uom:'ML'}];
  const liveItem = {id:'COFFEE',code:'COFFEE',name:'Coffee',price:100,taxRate:5,categoryId:'DRINK',categoryName:'Drinks',prepStation:options.station || 'BOTH',itemType:'MADE_TO_ORDER',productionMode:'MADE_TO_ORDER',bom,finishedGoodCode:'COFFEE',isActive:!options.unavailable,isAvailable:true,isSellable:true,availableStoreIds:[store.id]};
  const total = comp ? 0 : 105;
  const initial = {
    'posAddOnAuthorizations/AUTH':{provider:'SERVER_CANONICAL_ADD_ONS',used:!!options.usedAuthorization,staffUid:'STAFF',storeId:store.id,orderId:'ORDER',expiresAt:new Timestamp(options.expired ? time-1 : time+60000)},
    'rawIngredients/RAW_FIXTURE':{name:'Ingredient',usageUOM:'ML',costPerUsageUnit:0.1},
    'storeStock/NOIDA_29_RAW_INGREDIENT_RAW_FIXTURE':{currentStock: options.stock ?? 1000,uom:'ML',costPerUnit:0.1},
    ...(options.counter ? {'counters/NOIDA_29_20260920':{lastSequence:4}} : {}),
    ...(options.customer ? {'customers/CUSTOMER':{name:'Existing guest',visitCount:3,totalSpend:200}} : {}),
    ...(comp ? {'complimentaryAuthorizations/COMP':{status:'VERIFIED',used:false,staffUid:'STAFF',storeId:store.id,customerPhoneE164:'+919999999999',provider:'PHONE',expiresAt:new Timestamp(time+60000)}} : {}),
    ...options.initial,
  };
  if (options.missingStock) delete initial['storeStock/NOIDA_29_RAW_INGREDIENT_RAW_FIXTURE'];
  const h = database(initial, options), trace = [];
  const globals = {__db:h.db,__firestore:h.firestore,Date:FixedDate,console:{...console,warn(){}},Timestamp};
  const deps = exportsOf(domainCode,globals);
  const context = {...globals,...deps,...h.firestore,db:h.db,
    auth:{currentUser:{uid:'STAFF'}},staffProfile:{uid:'STAFF',name:'Test staff',role:options.role || 'ADMIN'},
    newOrderRef:h.ref('orders/ORDER'),orderLineRefs:[h.ref('orders/ORDER/items/LINE')],
    custRef:options.customer || options.newCustomer ? h.ref('customers/CUSTOMER') : null,counterRef:h.ref('counters/NOIDA_29_20260920'),
    complimentaryAuthorizationRef:comp?h.ref('complimentaryAuthorizations/COMP'):null,posAddOnAuthorizationRef:h.ref('posAddOnAuthorizations/AUTH'),
    checkoutAttempt:{idempotencyKey:'KEY'},requestPayloadHash:'HASH',selectedStore:store,dateKey:'20260920',customerId:null,
    customerNameFinal:options.customer?'':'Test guest',customerPhone:comp?'9999999999':'',phoneToSearch:comp?'9999999999':'',
    trueGrandTotal:total,trueSubtotal:100,trueTaxTotal:comp?0:5,trueTaxableAmount:comp?0:100,trueDiscountPercent:comp?100:0,trueDiscount:comp?100:0,trueDiscountRatio:comp?1:0,
    isComplimentaryCheckout:comp,isSplitPayment:split,isSetupTestSale:!!options.setupTest,complimentaryReason:'Test reason',
    complimentaryVerification:comp?{authorizationId:'COMP',verifiedPhone:'+919999999999',provider:'PHONE'}:null,
    posAddOnAuthorization:{authorizationId:'AUTH',canonicalAddOnTotal:0},tableNumber:' 2 ',orderType:'DINE_IN',
    paymentRows:comp?[]:split?[{method:'CASH',amount:50},{method:'UPI',amount:55}]:[{method,amount:method==='CREDIT'?0:total}],
    selectedPaymentMethod:split?'CASH':method,selectedStoreTaxConfig:{rate:5},
    validatedCart:[{cartItem:{menuItemId:'COFFEE',name:'Coffee',quantity:1,itemType:'MADE_TO_ORDER',finishedGoodCode:'COFFEE',bom},liveItem,canonicalAddOns:[],components:[]}],
    traceCheckoutWrite:(...args)=>trace.push(args),
    persistPosOrder:exportsOf(repositoryCode,globals).persistPosOrder,
  };
  vm.runInNewContext(compiled[Number(after)],context);
  return {...h,context,trace,execute:context.execute};
}
const outcomes = {}, scenarios = [];
async function parity(name, options={}, expectedError) {
  const b = setup(false,options), a = setup(true,options);
  if(expectedError){await assert.rejects(b.execute,expectedError);await assert.rejects(a.execute,expectedError);assert.equal(a.writes.length,0);}
  else assert.deepEqual(plain(await a.execute()),plain(await b.execute()),name+' result');
  assert.deepEqual(plain(a.writes),plain(b.writes),name+' ordered writes and payloads');
  assert.deepEqual(a.reads,b.reads,name+' read sequence');
  assert.deepEqual(a.trace,b.trace,name+' diagnostic write trace');
  assert.deepEqual(plain([...a.records]),plain([...b.records]),name+' atomic state');
  assert.deepEqual(plain(a.attempts),plain(b.attempts),name+' retry attempts');
  outcomes[name]='PASS';scenarios.push({name,writes:a.writes.length,attempts:a.attempts.length});return a;
}
for(const method of ['CASH','UPI','SPLIT','CARD','CREDIT','COMPLIMENTARY']) {
 const h=await parity(method+'_ORDER_WRITE_PARITY',{method});
 const payments=[...h.records].filter(([p])=>p.startsWith('orders/ORDER/payments/')).map(([,d])=>d);
 assert.equal(payments.length,method==='COMPLIMENTARY'?0:method==='SPLIT'?2:1);
 assert.equal(payments.reduce((n,p)=>n+p.amount,0),['CREDIT','COMPLIMENTARY'].includes(method)?0:105);
 assert.equal(h.records.get('orders/ORDER').grandTotal,method==='COMPLIMENTARY'?0:105);
 assert.equal([...h.records.keys()].filter(p=>p.startsWith('kotItems/')).length,2);
}
for(const station of ['BARISTA','KITCHEN','NONE','BOTH']) {
 const h=await parity(station+'_KOT_PARITY',{station});
 const tasks=[...h.records].filter(([p])=>p.startsWith('kotItems/')).map(([,d])=>d.station).sort();
 assert.deepEqual(tasks,station==='NONE'?[]:station==='BOTH'?['BARISTA','KITCHEN']:[station]);
}
const valid=await parity('VALID_BOM_STOCK_PARITY');
assert.equal(valid.records.get('storeStock/NOIDA_29_RAW_INGREDIENT_RAW_FIXTURE').currentStock,850);
assert.equal([...valid.records.values()].filter(d=>d.movementType==='SALE_DEDUCTION').length,1);
const pending=await parity('MISSING_BOM_PENDING_PARITY',{missingBom:true});
assert.equal(pending.records.get('orders/ORDER').inventoryConsumptionStatus,'PENDING_BOM');
assert.equal([...pending.records.keys()].filter(p=>p.startsWith('pendingInventoryConsumption/')).length,1);
assert.equal([...pending.records.keys()].filter(p=>p.startsWith('stockMovements/')).length,0);
for(const options of [{customer:true},{newCustomer:true},{counter:true},{stock:0},{stock:-50},{missingStock:true},{setupTest:true},{retry:true},{retry:true,customer:true},{role:'CASHIER'}]) await parity('variation '+JSON.stringify(options),options);
for(const [name,options,pattern] of [
 ['expired auth',{expired:true},/expired, used/],['used auth',{usedAuthorization:true},/expired, used/],
 ['manual unavailable',{unavailable:true},/Checkout blocked/],['atomic failure',{failWrite:7},/INJECTED_WRITE_FAILURE/],
 ['conflicting key',{initial:{'orders/ORDER':{clientCheckoutIdempotencyKey:'OTHER',checkoutPayloadHash:'HASH'}}},/retry conflict/],
 ['conflicting payload',{initial:{'orders/ORDER':{clientCheckoutIdempotencyKey:'KEY',checkoutPayloadHash:'OTHER'}}},/retry conflict/],
]) await parity(name,options,pattern);
// Replays must neither consume auth again nor recreate orders/payments/KOT/stock/pending.
for(const missingBom of [false,true])for(const role of ['ADMIN','CASHIER']) {
 const h=await parity('replay setup '+role+' '+missingBom,{missingBom,role});const count=h.writes.length,state=plain([...h.records]);
 if(role==='ADMIN')assert.equal((await h.execute()).existingOrderId,'ORDER');
 else await assert.rejects(h.execute,/expired, used/); // cashier cannot probe a missing order; consumed auth rejects retry
 assert.equal(h.writes.length,count);assert.deepEqual(plain([...h.records]),state);
}
for(const missingBom of [false,true]) {
 const h=setup(true,{missingBom});await Promise.all([h.execute(),h.execute()]);
 assert.equal(h.writes.filter(w=>w.path==='orders/ORDER').length,1);
 assert.equal(h.writes.filter(w=>w.path.startsWith('kotItems/')).length,2);
 assert.equal(h.writes.filter(w=>w.path.startsWith('stockMovements/')).length,missingBom?0:1);
 assert.equal(h.writes.filter(w=>w.path.startsWith('pendingInventoryConsumption/')).length,missingBom?1:0);
}
Object.assign(outcomes,Object.fromEntries(['ORDER_DOCUMENT_PARITY','PAYMENT_DOCUMENT_PARITY','DUPLICATE_ORDER_BLOCKED','DUPLICATE_KOT_BLOCKED','DUPLICATE_STOCK_BLOCKED','DUPLICATE_PENDING_BLOCKED'].map(k=>[k,'PASS'])));
// Void remains outside POSHome. Execute its existing complete handler separately.
const running = read('frontend/pages/pos/RunningOrders.tsx');
const voidHelpers = running.slice(running.indexOf('function roundStock'),running.indexOf('function formatMoney'));
// Use a brace-aware TypeScript parser to select exactly the handler declaration.
const ts = (await import('typescript')).default;
const ast = ts.createSourceFile('RunningOrders.tsx',running,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let voidNode;function walk(node){if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='voidOrder')voidNode=node.initializer;ts.forEachChild(node,walk);}walk(ast);assert(voidNode);
const voidCode=transformSync(voidHelpers+'\nglobalThis.execute='+voidNode.getText(ast)+';', {loader:'ts',format:'cjs'}).code;
const reversalCode=await bundle("export * from './frontend/lib/paymentReversal';");
async function checkVoid(missingBom=false, duplicate=false, emptyReason=false) {
 const checkout=await parity('void seed '+missingBom+duplicate+emptyReason,{missingBom});
 const initial=Object.fromEntries(checkout.records);
 if(duplicate)initial['stockMovements/duplicate']={movementType:'ORDER_VOID_REVERSAL',referenceId:'ORDER'};
 const h=database(initial),events=[],store=checkout.context.selectedStore;
 const snapshots=paths=>({docs:paths.map(([p,d])=>({id:p.split('/').at(-1),ref:h.ref(p),data:()=>clone(d)}))});
 const globals={__db:h.db,__firestore:h.firestore,Date:FixedDate};
 const c={...globals,...h.firestore,...exportsOf(reversalCode,globals),db:h.db,console:{error(){}},
  auth:{currentUser:{uid:'STAFF'}},staffProfile:{name:'Test staff',email:'staff@example.invalid'},stores:[store],
  voidBundle:{order:{id:'ORDER',...initial['orders/ORDER']},payments:[]},voidReason:emptyReason?'':'Test void',voidConfirmation:'VOID ORDER',canVoidOrders:true,
  requireOnlineAction:()=>true,isOrderVisibleInRunningOrders:()=>true,effectiveOrderStatus:o=>o.status,
  beginCriticalOperation:()=>()=>{},resolveInventoryStore:async s=>s,isCapturedPosRazorpayOrder:()=>false,
  isComplimentaryOrder:o=>o.commercialStatus==='COMPLIMENTARY',
  where:(field,op,value)=>({field,value}),query:(r,...filters)=>({...r,filters}),
  getDocs:async r=>snapshots([...h.records].filter(([p,d])=>p.startsWith(r.path+'/')&&(r.filters||[]).every(f=>d[f.field]===f.value))),
  setVoiding:()=>{},setError:e=>events.push(e),setSuccess:()=>{},setVoidBundle:()=>{},setVoidReason:()=>{},setVoidConfirmation:()=>{},loadOrders:async()=>{},
 };
 vm.runInNewContext(voidCode,c);await c.execute();
 if(duplicate||emptyReason){assert.equal(h.writes.length,0);assert(events.some(e=>/already has reversal|reason is required/.test(e)));return;}
 assert.equal(h.records.get('orders/ORDER').status,'VOIDED', JSON.stringify(events));
 const reversals=[...h.records.values()].filter(d=>d.movementType==='ORDER_VOID_REVERSAL');assert.equal(reversals.length,missingBom?0:1);
 assert.equal(h.records.get('storeStock/NOIDA_29_RAW_INGREDIENT_RAW_FIXTURE').currentStock,1000);
 if(missingBom)assert([...h.records].filter(([p])=>p.startsWith('pendingInventoryConsumption/')).every(([,d])=>d.status==='CANCELLED'));
 const count=h.writes.length;await c.execute();assert.equal(h.writes.length,count);assert(events.some(e=>/already has reversal|already voided/.test(e)));
}
await checkVoid();await checkVoid(true);await checkVoid(false,true);await checkVoid(false,false,true);
Object.assign(outcomes,{VOID_ORDER_PARITY:'PASS',VOID_STOCK_REVERSAL_PARITY:'PASS',DUPLICATE_VOID_REVERSAL_BLOCKED:'PASS'});
const held=page.slice(page.indexOf('  const holdCurrentBill ='),page.indexOf('  const setSplitPaymentMode ='));
assert.equal(held,sealed.slice(sealed.indexOf('  const holdCurrentBill ='),sealed.indexOf('  const setSplitPaymentMode =')));
assert(!/persistPosOrder|runTransaction|transaction\.|setDoc|updateDoc|addDoc/.test(held));outcomes.HELD_BILL_ZERO_SERVER_WRITES='PASS';
assert(!/transaction\.(set|update|delete)\(/.test(page));
assert.equal((repo.match(/runTransaction<PosOrderWriteResult>\(/g)||[]).length,1);
for(const component of ['HeldBillsPanel','ReceiptModal','MenuGrid','CartPanel','PaymentPanel'])assert(!/firebase/.test(read(`frontend/components/pos/${component}.tsx`)));
console.log(JSON.stringify({outcomes,scenarios,scope:'mocked atomic transactions; void unchanged; no production access'},null,2));

// Logical producer routes in POS checkout + existing Running Orders. Payment
// includes the unchanged Running Orders settlement route; KOT/stock/pending
// count creation/consumption, not subsequent status/cancellation updates.
const occurrences = (text, pattern) => (text.match(pattern) || []).length;
function writePaths(checkout, running) {
  return {
    POS_ORDER: occurrences(checkout, /transaction\.set\(newOrderRef,/g),
    PAYMENT: occurrences(checkout + running, /transaction\.set\(paymentRef,/g),
    KOT: occurrences(checkout, /transaction\.set\(kotRef,/g),
    STOCK: occurrences(checkout, /transaction\.set\(movementRef,/g),
    PENDING_INVENTORY: occurrences(checkout, /transaction\.set\(pendingRef,/g),
    VOID: occurrences(running, /transaction\.update\(orderRef, \{\s*status: 'VOIDED'/g),
    VOID_REVERSAL: occurrences(running, /transaction\.set\(target\.reversalRef,/g),
  };
}
const beforePaths = writePaths(sealed,running), afterPaths = writePaths(page+repo,running);
assert.deepEqual(afterPaths,beforePaths);
assert.deepEqual(afterPaths,{POS_ORDER:1,PAYMENT:2,KOT:1,STOCK:1,PENDING_INVENTORY:1,VOID:1,VOID_REVERSAL:1});
const calls = text => occurrences(text,/transaction\.(set|update|delete)\(/g);
assert.equal(calls(sealed),14);assert.equal(calls(page),0);assert.equal(calls(repo),14);
console.log(JSON.stringify({writePathsBefore:beforePaths,writePathsAfter:afterPaths,directCallsBefore:calls(sealed),directCallsAfter:calls(page)}));
