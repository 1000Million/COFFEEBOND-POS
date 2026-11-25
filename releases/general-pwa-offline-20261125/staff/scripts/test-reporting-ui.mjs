// Focused synthetic checks using the existing Node/esbuild test tools. No network or production writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const baseline = process.env.REPORTING_BASELINE;
assert(baseline && path.isAbsolute(baseline), 'Set REPORTING_BASELINE to the verified deployed STAFF source');

// Integrity pins come from the verified 31 October 467-file STAFF manifest
// (tree 7a271e62...). Derivatives require the exact reviewed current Cashier
// or combined POSHome/core pair, with all current sources also pinned below.
// No general exemption is granted for JSX, UI, or financial changes.
const protectedReportingBaseline = Object.freeze({
  "frontend/pages/reports/DayClose.tsx": "8d5d0be8e66de0dccba6a5db5a9c45c44b5520a34fcdfbd0cdd6d5b2cd53ae0a",
  "functions/reporting.js": "b40301373b08cb07308d68a3e5f349524e919c0ba68dd0ca999585f8f3bb33f7",
  "functions/reportingCore.mjs": "47670f4f049dd2f1b6d677a989ce3c71187b81ce4abb5275d24507c4e4361c70",
  "frontend/App.tsx": "08e7da713a682d3aeb880c6e439b1fdf7316f82915f1c18a5bed63956a04ce2b",
  "frontend/lib/reportExports.ts": "9b7bba8918dffae2efb4c48f3b8a0c41e698df74d5d08e8eb28e0809f484463d",
  "firestore.rules": "48a68809a1e36a9e084bdd82c52831493581e3ec9c03ee0bb66e5e5d346b0a78",
  "firestore.indexes.json": "9e01af52031d3b3b05334ea1f0d756c556aecb39bad408b736c7bf5eea8324d7",
  "frontend/pages/pos/POSHome.tsx": "5f73a6568acda6189110f2f6aa8e540689ea6dc26f408c07aedba5b0e8471489"
});
const posHomePath = 'frontend/pages/pos/POSHome.tsx';
const reviewedPhase1PosHome = '058f363aac13f9026e0b73730cf5544fb0dcd2392c24834d838860d358820718';
const reviewedCombinedPosHome = '9cbb21aaf91ed912da97a0a11b337283a4071bceaad015432c7690690b1530fa';
// Exact GST derivatives reviewed against the deployed combined source; historical pins remain below.
const APPROVED_GST_PINS = Object.freeze({
  "frontend/App.tsx": "d0c42e8686fe391cb9042f613d199a286eebba850e095c5e32f2d72158e91f5a",
  "frontend/components/customer/CustomerCheckoutTotalsPanel.tsx": "7a63dbe8861b3752778f62ca66874b82df7b5e670fbc5038331718ba02736fa2",
  "frontend/components/customer/CustomerTrackingScreen.tsx": "d6cdc47733ae75045e63f55dc0b0abdf9f65631940741ed75b087837fdc9fed6",
  "frontend/components/pos/ReceiptModal.tsx": "68d72532230e4c3211d868503e945e1ac69b3538d3a7eca158106c853c71dffa",
  "frontend/lib/pos/posOrderLifecycle.ts": "cad9088a374840d1abba864b7afe429878e879a45eb96b996ba736586fc5575b",
  "frontend/lib/pos/posTax.ts": "74ecf71f3ea2404e030a42b0c635cde8740896b958dd4af72dc4b49bab2765fc",
  "frontend/lib/pos/posTotals.ts": "dc654d47aa19ebc9d76f159dbf00100498161bc18c279a70288d7924fbbf9a3e",
  "frontend/lib/pos/whatsAppReceipt.ts": "0aa60ca0f6549282702537e8d2d1933e3081a78d8baf4247de7089e2cea866d4",
  "frontend/lib/posRazorpay.ts": "f751a17eaf0e93c4f4dfacdf243e7b3c3f723edd0273375700d30be0a392ee33",
  "frontend/lib/storeGstTreatment.ts": "03b80280af69906ce58ce0e06c2122a8ee5bb83f927b34e079bc2bbee3155244",
  "frontend/pages/admin/LocationManagement.tsx": "865bcf4e6a3b893e65cc7e0648fd9333e53fde10b97af9f1b445a1e605572c89",
  "frontend/pages/admin/StoreGstSettings.tsx": "042ccd292ab3031b0ea6bdf3436313e5c74e35f9f4a70e73cd81d2352bb257cf",
  "frontend/pages/customer/CustomerOrder.tsx": "f074c8ec156fe028124bdd1db630867b22e6c402abfae1e2e93a333083940114",
  "frontend/pages/pos/POSHome.tsx": "da59b799321fccda3818b872519a498cd7d2b3fc6a77ed3ce8a05e07f5c147f6",
  "frontend/pages/pos/RunningOrders.tsx": "82e634c60efa10c04b4ef5afbd6e15ef7107b6b624b75eb3a4afcedeebd7264a",
  "frontend/types.ts": "e6f0f567cfdf5af6fc13a948bbf469239353f48cb1124d9823d44ebce808c2c4"
});
const approvedFinancialCore = '165e86a782e0ffcee81acfc1c222ae1619a9067d7b80a6832be078a257d99b15';
const sourceHash = source => createHash('sha256').update(source).digest('hex');
const readReportingSources = root => Object.fromEntries(Object.keys(protectedReportingBaseline)
  .map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
function assertVerifiedReportingBaseline(sources) {
  for (const [file, hash] of Object.entries(protectedReportingBaseline)) {
    assert.equal(sourceHash(sources[file]), hash, `Unverified reporting baseline: ${file}`);
  }
}
function assertReportingSourceIntegrity(current, verifiedBaseline) {
  assertVerifiedReportingBaseline(verifiedBaseline);
  for (const file of Object.keys(protectedReportingBaseline)) {
    if (file === 'frontend/App.tsx' && sourceHash(current[file]) === APPROVED_GST_PINS[file]) continue;
    if (file !== posHomePath && file !== 'functions/reportingCore.mjs') assert.equal(current[file], verifiedBaseline[file], file);
  }
  const posHomeHash = sourceHash(current[posHomePath]);
  const coreHash = sourceHash(current['functions/reportingCore.mjs']);
  const originalPair = coreHash === protectedReportingBaseline['functions/reportingCore.mjs']
    && (posHomeHash === protectedReportingBaseline[posHomePath] || posHomeHash === reviewedPhase1PosHome);
  const combinedPair = coreHash === approvedFinancialCore && (posHomeHash === reviewedCombinedPosHome || posHomeHash === APPROVED_GST_PINS[posHomePath]);
  assert.ok(originalPair || combinedPair,
    'Unreviewed POSHome change: expected an exact approved POSHome/reporting-core pair');
}
// Validate before importing the reference core. REPORTING_BASELINE=candidate
// must not turn financial parity and source checks into vacuous self-comparison.
const verifiedBaselineSources = readReportingSources(baseline);
assertVerifiedReportingBaseline(verifiedBaselineSources);

// Retain historical live-a443 pins and exact financial composition derivatives.
// The reviewed GST derivatives are explicit exact hashes; no general UI exemption.
const LIVE_CASHIER_PINS = Object.freeze({
  "frontend/components/pos/MenuGrid.tsx": "2378fe0597c66cac9ffffd1410be2f811b54c8cc74d23868422487ba5726aba6",
  "frontend/components/pos/PopularItems.tsx": "0eff20541aef88f8fb2f0ad382bec970b64912088fb5dca906769146d3811565",
  "frontend/components/pos/CartPanel.tsx": "d72c1b7e4fe8fb93a5e7de59e3c163843c4fead1d066930bfbbc6d5a91416897",
  "frontend/components/pos/PaymentPanel.tsx": "8d77ab7dc30f64d37498b402b99d8bc4230dccc844c98313f77a3b5a9e5bfa04",
  "frontend/components/pos/ReceiptModal.tsx": "3e14592c9f02208eef23500bdd126591d44b7e0a2da4b8a8ae8a87f9bb5fd0c8",
  "frontend/pages/admin/StaffManagement.tsx": "f0779a3739acf1db529bad7aa8015e9d424e409cceea94079765adc513e22bdc",
  "frontend/lib/staffAccess.ts": "a6d6433319f22a38113393dbf56536a42f03fa4acdeded2a2b21ba559e5cae9c",
  "frontend/contexts/AuthContext.tsx": "aaffe26a1082e216d849d7bdfafb5ddf41b77719218033c10ce0fce545f56460",
  "frontend/components/Layout.tsx": "b4494a5ca57296e05895509eec349758299de72fd6b5e2a6aced530b8a3c334e",
  "frontend/pages/MyAccount.tsx": "76e79b337e8dcb18a1224a324aca2305f0e70e29ea2399c27f355fceab6f4bac",
  "frontend/lib/printStation.ts": "b9add46d0d5a0e62cfa98b8c24996a1c4f51cce09387a4cbeac454007710b78a",
  "frontend/pages/settings/KotPrinters.tsx": "4f80084f99cb2eeadda8dcf93fe3f97bb090f990dce29c1e314a0132d68c0fd8",
  "frontend/lib/useKotRealtime.ts": "bf379535526946c1834c941d123cc8b8acb8ad58fd866d4213635e354809f1dc",
  "frontend/pages/kot/KOTScreen.tsx": "75891fd2b3b5cfdaaa7ceea8beeb80e7b0f1f9d47628ac4103768d52bdd37e64",
  "scripts/test-pos-responsive-layout.ts": "e04c9c1060a603bfbb5dc1d87de7d55210175c7a46f0d61af9bdf89baeb600d0",
  "scripts/test-counter-financial-parity.ts": "ef9fdfce056c3e7fd7693012eeb275e0d9a158de1ae458a12df8c863618300da"
});
const APPROVED_SECTOR51_PINS = Object.freeze({
  "frontend/lib/printStation.ts": "f8600b6cc82ded3968299dbe56a264734b07347bf61bc098f8229ecef04e301d",
  "frontend/pages/settings/KotPrinters.tsx": "76bbe2659266fc60b23ef30287b480012a5fda4b00a1a6bfa487c1be31002f13"
});
const APPROVED_COMBINED_PINS = Object.freeze({
  ...protectedReportingBaseline,
  ...LIVE_CASHIER_PINS,
  ...{
  "frontend/data/orders/posOrderRepository.ts": "21ff02fb4d4e3d0a7e089cd07aa9c5f04ab16e5a55c8a1330d8444aecd69bd20",
  "frontend/lib/onlineOrderConversion.ts": "3acab2c83c283119f0e1f5823dd8d04cdd077d30a1cff860ec6cbf56f28a3a9a",
  "frontend/lib/pos/posFinancialResult.ts": "7a5e956f9af2ea19c0c1ea782d4f03ec8fa7af313c25d77092afc15863148cf5",
  "frontend/pages/pos/RunningOrders.tsx": "76a7112248b9957878bc22bd1a292b1ca45473177f0502acd81d34b5372b19d5",
  "frontend/lib/inventory/stockReversal.ts": "c3b9f723dec6986fcb334558630a2caf284616d429ca9375f878e19fb9e711af"
},
  'functions/reportingCore.mjs': approvedFinancialCore,
  [posHomePath]: reviewedCombinedPosHome,
  ...APPROVED_GST_PINS,
  ...APPROVED_SECTOR51_PINS,
});
function readPinnedSources(root, pins) {
  return Object.fromEntries(Object.keys(pins).map(file => {
    const absolute = path.join(root, file);
    assert(fs.lstatSync(absolute).isFile(), 'Expected regular protected source: ' + file);
    return [file, fs.readFileSync(absolute, 'utf8')];
  }));
}
function assertPinnedSources(sources, pins, label) {
  for (const [file, expected] of Object.entries(pins)) {
    assert.equal(sourceHash(sources[file]), expected, label + ' unreviewed source: ' + file);
  }
}
const compositionRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const liveManifest = JSON.parse(fs.readFileSync(path.join(compositionRoot, 'evidence/baseline-source-manifest.json'), 'utf8'));
assert.equal(liveManifest.count, 467);
assert.equal(sourceHash(Object.keys(liveManifest.files).sort().map(file => `${liveManifest.files[file]}  ${file}\n`).join('')),
  'a443ac6967d48658bf2e019143deac5e918da29a296a9a720573abda322e8cfb', 'Unverified current Cashier baseline');
for (const [file, expected] of Object.entries(LIVE_CASHIER_PINS)) assert.equal(liveManifest.files[file], expected, file);
const combinedSources = readPinnedSources(process.cwd(), APPROVED_COMBINED_PINS);
assertPinnedSources(combinedSources, APPROVED_COMBINED_PINS, 'Exact combined frontend');
assertReportingSourceIntegrity(readReportingSources(process.cwd()), verifiedBaselineSources);

// Reuse the exact financial proof reader against its unchanged external source,
// not against the combined frontend or its reference-only embedded rules.
const financialRoot = path.resolve(compositionRoot, '../financial-integrity-repair-20261101');
const supportPath = path.join(financialRoot, 'candidate/staff/scripts/financial-integrity-repair-test-support.mjs');
assert.equal(sourceHash(fs.readFileSync(supportPath)), 'd7772a4b83ef0864d1f88bc863ab06ee2222507f0d6ebd1e94b881f34738a2c4',
  'Unreviewed frozen financial proof reader');
const support = await import(pathToFileURL(supportPath));
const repairAuthority = support.verifyFinancialRepairAuthority({
  sourceRoot: path.join(financialRoot, 'candidate/staff'), referenceRoot: baseline, repairRoot: financialRoot,
});
const nativeProof = support.verifyNativeFinancialQualification(repairAuthority);
assert.equal(nativeProof.historicalFull.passed, 102);
assert.equal(nativeProof.finalTargeted.passed, 26);
assert.equal(sourceHash(fs.readFileSync(path.join(repairAuthority.backendRoot, 'reportingCore.mjs'))), approvedFinancialCore);
assert.equal(sourceHash(fs.readFileSync(path.join(process.cwd(), 'functions/reportingCore.mjs'))), approvedFinancialCore);
// Validate all source before executing candidate or reference financial modules.
const core = await import(pathToFileURL(path.resolve('functions/reportingCore.mjs')));

const old = await import(pathToFileURL(path.join(baseline,'functions/reportingCore.mjs')));
const today=core.dateKey(new Date());
const mk=(id,extra={},payments=[])=>({order:{id,orderNumber:'QA-'+id,storeId:'A',storeName:'Synthetic A',createdAt:new Date(today+'T06:30:00Z'),status:'COMPLETED',paymentStatus:'PAID',paymentMethod:'CASH',subtotal:100,taxableAmount:100,gstTotal:5,grandTotal:105,...extra},items:[{itemCode:'COFFEE',itemName:'Synthetic Coffee',categoryName:'Coffee',quantity:1,lineSubtotal:100,lineTaxable:100,lineTax:5,lineTotal:105}],payments});
const fixtures=[mk('split',{isSplitPayment:true,paymentBreakdown:[{method:'CASH',amount:40},{method:'UPI',amount:65}]},[{method:'UPI',amount:999}]),mk('discount',{discountAmount:10,taxableAmount:90,gstTotal:4.5,grandTotal:94.5}),mk('comp',{isComplimentary:true,paymentMethod:'COMPLIMENTARY',paymentStatus:'COMPLIMENTARY',grandTotal:0}),mk('unpaid',{paymentMethod:'PAY_AT_COUNTER',paymentStatus:'UNPAID'}),...['REFUNDED','REFUND_PENDING','MANUAL_REFUND_REQUIRED'].map(s=>mk(s,{status:'VOIDED',paymentReversalStatus:s,paymentReversalBreakdown:[{method:'CASH',originalAmount:105,amount:105,reversalStatus:s}]})),mk('B',{storeId:'B',storeName:'Synthetic B'})];
const online=[{id:'linked',storeId:'A',createdAt:fixtures[0].order.createdAt,paymentProvider:'RAZORPAY',paymentStatus:'PAID',linkedOrderId:'split',grandTotal:105},{id:'unlinked',storeId:'A',createdAt:fixtures[0].order.createdAt,paymentProvider:'RAZORPAY',paymentStatus:'PAID',status:'PAID_PENDING_ACCEPTANCE',grandTotal:210}];
let passed=0;const check=async(name,fn)=>{await fn();passed++;console.log('PASS',name)};
const outputs=[];
await check('Baseline/candidate every report and filtered financial dataset exactly equal in paise',()=>{
 for(const report of core.REPORT_REGISTRY)for(const filters of [{},{storeIds:['A']},{paymentMethod:'UPI'},{commercialStatus:'COMPLIMENTARY'},{orderStatus:'VOIDED'}]){
  const context={filters,onlineOrders:['online-order','customer-order','payment-collection','refund-reversal'].includes(report.reportId)?online:[]};
  const before=old.buildReportDataset(report.reportId,fixtures,context),after=core.buildReportDataset(report.reportId,fixtures,context);assert.deepEqual(after,before);
  const financial=Object.fromEntries(Object.entries(after.summary).filter(([k,v])=>typeof v==='number' && !/Count$/.test(k)).map(([k,v])=>[k,Math.round(v*100)]));outputs.push({reportId:report.reportId,filters,financialPaise:financial,paymentBreakdownPaise:Object.fromEntries(Object.entries(after.summary.paymentBreakdown).map(([k,v])=>[k,Math.round(v*100)]))});
 }
 const moneySummary=core.buildReportDataset('payment-collection',fixtures).summary;assert.equal(moneySummary.refundedOrReversedPayments,105);assert.equal(moneySummary.refundPendingPayments,105);assert.equal(moneySummary.manualRefundRequiredPayments,105);
 const split=core.buildReportDataset('split-payment-detail',fixtures).rows.filter(r=>r.orderNumber==='QA-split');assert.deepEqual(split.map(r=>[r.tender,r.amount]),[['CASH',40],['UPI',65]]);
 const pos=core.buildReportDataset('payment-collection',fixtures).summary,combined=core.buildReportDataset('payment-collection',fixtures,{onlineOrders:online}).summary;assert.equal(combined.netCollections-pos.netCollections,210);
});
const compiled=await build({entryPoints:['frontend/lib/reportingUi.ts'],bundle:true,platform:'node',format:'cjs',write:false});const module={exports:{}};vm.runInNewContext(compiled.outputFiles[0].text,{module,exports:module.exports,URLSearchParams,Date,Intl});const ui=module.exports;
await check('IST day boundaries, range validation, retained filters/page, and exact status distinctions',()=>{
 assert.equal(ui.reportingToday(new Date('2026-10-17T18:29:59Z')),'2026-10-17');assert.equal(ui.reportingToday(new Date('2026-10-17T18:30:00Z')),'2026-10-18');
 assert.match(ui.reportingRangeError('2026-01-01','2026-02-02',31),/31 days/);assert.equal(ui.reportingRangeError('2026-02-30','2026-03-02',31),'Choose valid start and end dates.');
 const p=ui.reportingParams({storeIds:['A'],startDate:today,endDate:today,page:2,filters:{paymentMethod:'UPI'}},new URLSearchParams('q=QA-split&bill=QA-split'));assert.equal(p.get('q'),'QA-split');assert.equal(p.get('paymentMethod'),'UPI');assert.equal(p.get('page'),'2');
 assert.equal(ui.reportCell('VOIDED / REFUND PENDING','paymentStatus'),'Refund pending');assert.equal(ui.reportCell('VOIDED / CASH REFUNDED','paymentStatus'),'Refund completed (cash)');assert.equal(ui.reportCell('VOIDED / PAYMENT REVIEW','paymentOutcome'),'Voided · payment review required');
 assert.throws(()=>ui.ensureCompleteReportingExport({rows:[{}],totalRows:2}),/completeness/);assert.throws(()=>ui.ensureCompleteReportingExport({rows:[{}]}),/completeness/);ui.ensureCompleteReportingExport({rows:[{}],totalRows:1});
 assert.notEqual(ui.reportingAccessKey({uid:'a',role:'STORE_MANAGER',assignedStoreIds:['A']}),ui.reportingAccessKey({uid:'b',role:'STORE_MANAGER',assignedStoreIds:['A']}));
});
class HttpsError extends Error{constructor(code,message){super(message);this.code=code}}
let source=fs.readFileSync('functions/reporting.js','utf8').replace("return import('./reportingCore.mjs');",'return Promise.resolve(__core);');
const sandbox={module:{exports:{}},exports:{},__core:core,console:{error:()=>{}},require:name=>{if(name==='firebase-functions/v2/https')return{onCall:(_o,fn)=>fn,HttpsError};if(name==='firebase-admin/firestore')return{Timestamp:{fromDate:d=>d},FieldValue:{serverTimestamp:()=>new Date()}};throw Error(name)}};
vm.runInNewContext(source,sandbox);
let raw=fixtures;const audit=[];const profiles={admin:{uid:'admin',role:'ADMIN',isActive:true},manager:{uid:'manager',role:'STORE_MANAGER',isActive:true,assignedStoreIds:['A']},cashier:{uid:'cashier',role:'CASHIER',isActive:true,assignedStoreIds:['A']},viewer:{uid:'viewer',role:'FRANCHISE_VIEWER',isActive:true,assignedStoreIds:['A']},inactive:{role:'ADMIN',isActive:false}};
const stores=['A','B'].map(id=>({id,name:'Synthetic '+id,isActive:true,timezone:'Asia/Kolkata'}));
const snap=(id,data)=>({id,exists:data!==undefined,data:()=>data});
function collection(name,constraints=[],cap=Infinity){return{where:(f,op,v)=>collection(name,[...constraints,[f,op,v]],cap),orderBy:()=>collection(name,constraints,cap),limit:n=>collection(name,constraints,n),doc:id=>({get:async()=>snap(id,name==='users'?profiles[id]:name==='stores'?stores.find(s=>s.id===id):undefined),collection:child=>({get:async()=>({docs:(raw.find(r=>r.order.id===id)?.[child]||[]).map((r,i)=>snap(String(i),r))})})}),get:async()=>{let values=name==='stores'?stores:name==='orders'?raw.map(r=>r.order):name==='onlineOrders'?online:[];values=values.filter(r=>constraints.every(([f,op,v])=>op==='=='?r[f]===v:op==='>='?r[f]>=v:op==='<'?r[f]<v:true));return{docs:values.slice(0,cap).map(r=>snap(r.id,r))}},add:async value=>audit.push(value)}};
const db={app:{options:{projectId:'coffee-bond-pos'}},collection,getAll:async(...refs)=>Promise.all(refs.map(r=>r.get()))};
const api=sandbox.module.exports.createReportingFunctions({admin:{},db,region:'synthetic'});
const req=(uid,extra={})=>({auth:uid?{uid}:undefined,data:{reportId:'orders-master',storeIds:['A'],startDate:today,endDate:today,...extra}});
const denied=(fn,code)=>assert.rejects(fn,e=>e.code===code);
await check('Actual backend role/assignment/date/export guards reject unauthorized synthetic requests',async()=>{
 await denied(()=>api.getReportingRows(req(null)),'unauthenticated');await denied(()=>api.getReportingRows(req('inactive')),'permission-denied');await denied(()=>api.getReportingRows(req('viewer')),'permission-denied');await denied(()=>api.getReportingRows(req('manager',{storeIds:['B']})),'permission-denied');await denied(()=>api.getReportingRows(req('cashier')),'permission-denied');await denied(()=>api.getReportingRows(req('cashier',{reportId:'payment-collection',storeIds:['A','B']})),'permission-denied');await denied(()=>api.getReportingRows(req('cashier',{reportId:'payment-collection',startDate:'2026-01-01'})),'permission-denied');await denied(()=>api.exportReportingData(req('cashier',{reportId:'payment-collection'})),'permission-denied');await denied(()=>api.getReportingRows(req('manager',{startDate:'2026-01-01'})),'invalid-argument');
 assert((await api.getReportingRows(req('manager'))).rows.length>0);assert((await api.getReportingRows(req('admin',{storeIds:['B']}))).rows.every(r=>r.store==='Synthetic B'));
});
await check('Actual backend full-scope totals/pagination, no source truncation, and export cap',async()=>{
 const data=await api.getReportingRows(req('admin',{page:1,pageSize:10}));const exported=await api.exportReportingData(req('admin'));assert.deepEqual(data.summary,exported.summary);assert.equal(exported.totalRows,exported.rows.length);
 raw=Array.from({length:10001},(_,i)=>mk('summary-limit-'+i));await denied(()=>api.getReportingRows(req('admin',{reportId:'all-restaurant-sales'})),'resource-exhausted');
 raw=Array.from({length:2501},(_,i)=>mk('limit-'+i));await denied(()=>api.getReportingRows(req('admin')),'resource-exhausted');
 raw=Array.from({length:2000},(_,i)=>({...mk('export-'+i),items:Array.from({length:3},()=>mk('item').items[0])}));await denied(()=>api.exportReportingData(req('admin',{reportId:'order-item-wise'})),'resource-exhausted');
 raw=Array.from({length:63},(_,i)=>mk('page-'+i));const first=await api.getReportingRows(req('admin',{page:1,pageSize:50})),second=await api.getReportingRows(req('admin',{page:2,pageSize:50}));assert.equal(first.rows.length,50);assert.equal(second.rows.length,13);assert.deepEqual(first.summary,second.summary);assert.equal(second.pagination.hasNextPage,false);
});
await check('Preserved online-filter contract limitation reproduced separately',async()=>{
 raw=fixtures;const r=await api.getReportingSummary(req('admin',{reportId:'payment-collection',filters:{paymentMethod:'CASH'}}));const pos=core.buildReportDataset('payment-collection',fixtures,{filters:{storeIds:['A'],paymentMethod:'CASH'}}).summary;assert.equal(r.summary.netCollections-pos.netCollections,210);console.log('INHERITED LIMITATION: CASH filter still includes unlinked RAZORPAY 21000 paise; backend unchanged, UI labels POS-only filtering.');
});
await check('Actual backend IST inclusive start/exclusive next midnight boundaries',async()=>{
 raw=[mk('before',{createdAt:new Date(today+'T00:00:00+05:30')-1}),mk('start',{createdAt:new Date(today+'T00:00:00+05:30')}),mk('end',{createdAt:new Date(new Date(today+'T00:00:00+05:30').getTime()+86400000-1)}),mk('next',{createdAt:new Date(new Date(today+'T00:00:00+05:30').getTime()+86400000)})];const r=await api.getReportingRows(req('admin'));assert.deepEqual(Array.from(r.rows,row=>row.orderNumber),['QA-start','QA-end']);
});
await check('Current Cashier/UI/Staff sources exact; combined POSHome and frontend V3 core are reviewed derivatives',()=>{
 assertReportingSourceIntegrity(readReportingSources(process.cwd()), verifiedBaselineSources);
 assertPinnedSources(readPinnedSources(process.cwd(), APPROVED_COMBINED_PINS), APPROVED_COMBINED_PINS, 'Exact combined frontend');
});
await check('Source integrity rejects protected-file mutations and unverified or self-comparison baselines',()=>{
 const current = readReportingSources(process.cwd());
 assertReportingSourceIntegrity(verifiedBaselineSources, verifiedBaselineSources);
 assertReportingSourceIntegrity(current, verifiedBaselineSources);
 for (const file of Object.keys(protectedReportingBaseline)) {
  assert.throws(() => assertReportingSourceIntegrity({...current, [file]: current[file] + '\n// unreviewed change'}, verifiedBaselineSources));
  assert.throws(() => assertReportingSourceIntegrity(current, {...verifiedBaselineSources, [file]: verifiedBaselineSources[file] + '\n// baseline drift'}), /Unverified reporting baseline/);
  const missing = {...current}; delete missing[file];
  assert.throws(() => assertReportingSourceIntegrity(missing, verifiedBaselineSources));
 }
 // Exercise the reviewed POSHome's actual financial and UI bytes, rather than
 // weakening the sentinel to selected handlers or stripping render callbacks.
 for (const [from, to] of [["createSafeClientId('pos-checkout')", "createSafeClientId('changed-identity')"],
   ['const cartTotals = useMemo(', 'const cartTotals = useCallback('],
   ['const maxDiscountPercent = getMaxDiscountPercent(', 'const maxDiscountPercent = Number('],
   ['persistPosOrder({', 'unreviewedPersistPosOrder({'],
   ['const splitBalanceAmount = paymentBalance(', 'const splitBalanceAmount = Number('],
   ['Current Sale', 'Unreviewed UI change']]) {
  assert(current[posHomePath].includes(from), `Mutation fixture token missing: ${from}`);
  assert.throws(() => assertReportingSourceIntegrity({...current, [posHomePath]: current[posHomePath].replace(from, to)}, verifiedBaselineSources), /Unreviewed POSHome change/);
 }
 for (const file of Object.keys(APPROVED_COMBINED_PINS)) {
  assert.throws(() => assertPinnedSources({...combinedSources, [file]: combinedSources[file] + '\n// unreviewed drift'}, APPROVED_COMBINED_PINS, 'Exact combined frontend'));
  const missing = {...combinedSources}; delete missing[file];
  assert.throws(() => assertPinnedSources(missing, APPROVED_COMBINED_PINS, 'Exact combined frontend'));
 }
 if (sourceHash(current[posHomePath]) !== protectedReportingBaseline[posHomePath]) {
  assert.throws(() => assertReportingSourceIntegrity(current, current), /Unverified reporting baseline/);
 }
});
const repairGolden={legacyFixtures:0,legacyFullReportDatasets:0,v3Cases:4};
await check('Every legacy report dataset unchanged and V3 actual collections exclude retained debt',()=>{
 const legacy=[];
 for(const status of ['COMPLETED','VOIDED'])for(const paymentStatus of ['PAID','UNPAID','PARTIAL'])for(const method of ['CASH','UPI','CARD','CREDIT','PAY_AT_COUNTER','RAZORPAY'])for(const discount of [0,10,20]){
  const taxable=100-discount,tax=taxable*.05,total=taxable+tax,amount=paymentStatus==='PAID'?total:paymentStatus==='PARTIAL'?50:0;
  legacy.push(mk('legacy-'+legacy.length,{status,paymentStatus,paymentMethod:method,discountPercent:discount,discountAmount:discount,discountTotal:discount,discount,taxableAmount:taxable,taxTotal:tax,gstTotal:tax,grandTotal:total,commercialStatus:'SALE',...(status==='VOIDED'?{paymentReversalStatus:'REFUNDED',paymentReversalTotal:amount,paymentReversalBreakdown:[{method,amount,originalAmount:amount,reversalStatus:'REFUNDED'}]}:{})},[{method,amount}]));
 }
 assert.deepEqual(core.normalizeRecords(legacy),old.normalizeRecords(legacy));assert.deepEqual(core.summarizeReportingRecords(legacy),old.summarizeReportingRecords(legacy));
 for(const definition of old.REPORT_REGISTRY){assert.deepEqual(core.buildReportDataset(definition.reportId,legacy),old.buildReportDataset(definition.reportId,legacy),definition.reportId);repairGolden.legacyFullReportDatasets++;}
 repairGolden.legacyFixtures=legacy.length;assert.equal(repairGolden.legacyFullReportDatasets,29);
 const cash={method:'CASH',amount:50},credit={method:'CREDIT',amount:55},upi={method:'UPI',amount:55};
 const v3=(status,paymentStatus,payments,reversals)=>mk('v3',{financialAuthorizationVersion:3,status,paymentStatus,paymentMethod:'CASH',isSplitPayment:true,paymentBreakdown:payments,...(reversals?{paymentReversalBreakdown:reversals}:{})},payments);
 const summary=record=>core.summarizeReportingRecords([record]);
 const partial=summary(v3('COMPLETED','PARTIAL',[cash,credit]));assert.equal(partial.netSales,0);assert.equal(partial.totalCollected,50);assert.equal(partial.grossPaymentsReceived,50);assert.equal(partial.netCollections,50);
 const partialVoid=summary(v3('VOIDED','PARTIAL',[cash,credit],[{method:'CASH',amount:50,originalAmount:50,reversalStatus:'REFUNDED'},{method:'CREDIT',amount:55,originalAmount:55,reversalStatus:'REVERSED'}]));assert.equal(partialVoid.grossPaymentsReceived,50);assert.equal(partialVoid.voidedPaymentTotal,50);assert.equal(partialVoid.netCollections,0);
 const settled=summary(v3('COMPLETED','PAID',[cash,credit,upi]));assert.equal(settled.netSales,105);assert.equal(settled.totalCollected,105);assert.equal(settled.grossPaymentsReceived,105);
 const settledVoid=summary(v3('VOIDED','PAID',[cash,credit,upi],[{method:'CASH',amount:50,originalAmount:50,reversalStatus:'REFUNDED'},{method:'UPI',amount:55,originalAmount:55,reversalStatus:'MANUAL_REFUND_REQUIRED'}]));assert.equal(settledVoid.grossPaymentsReceived,105);assert.equal(settledVoid.voidedPaymentTotal,105);assert.equal(settledVoid.netCollections,0);
});

await check('Actual Day Close frontend import retains approved V3 partial and settled collections',()=>{
 const dayClose = fs.readFileSync('frontend/pages/reports/DayClose.tsx', 'utf8');
 assert(dayClose.includes("from '../../../functions/reportingCore.mjs'"));
 const financialCore = support.APPROVED_BACKEND_PINS['reportingCore.mjs'];
 assert.equal(sourceHash(fs.readFileSync('functions/reportingCore.mjs')), financialCore);
 const row = (paymentStatus, payments) => ({order:{financialAuthorizationVersion:3,status:'COMPLETED',paymentStatus,paymentMethod:'CASH',isSplitPayment:true,paymentBreakdown:payments,commercialStatus:'SALE',subtotal:100,taxableAmount:100,taxTotal:5,gstTotal:5,grandTotal:105},items:[],payments:[]});
 const partial=core.summarizeReportingRecords([row('PARTIAL',[{method:'CASH',amount:50},{method:'CREDIT',amount:55}])]);
 const settled=core.summarizeReportingRecords([row('PAID',[{method:'CASH',amount:50},{method:'CREDIT',amount:55},{method:'UPI',amount:55}])]);
 assert.equal(partial.grossPaymentsReceived,50);assert.equal(partial.netCollections,50);
 assert.equal(settled.grossPaymentsReceived,105);assert.equal(settled.netCollections,105);
});
if(process.env.REPORTING_EVIDENCE)fs.writeFileSync(path.join(process.env.REPORTING_EVIDENCE,'financial-parity.json'),JSON.stringify({baseline,candidate:process.cwd(),cases:outputs.length,outputs,repairGolden,nativeProof,protectedCombinedFiles:Object.keys(APPROVED_COMBINED_PINS).length},null,2));
console.log(`REPORTING_UI_CONTRACTS=PASS; ${passed} groups; ${outputs.length} original full-dataset comparisons; ${repairGolden.legacyFullReportDatasets} additional full legacy datasets; ${repairGolden.v3Cases} V3 collection cases; protected combined files ${Object.keys(APPROVED_COMBINED_PINS).length}`);
