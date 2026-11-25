import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import vm from 'node:vm';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname,'..'), b=path.resolve(root,'../store-till-20261124'), pos='frontend/pages/pos/POSHome.tsx';
const hash=value=>createHash('sha256').update(value).digest('hex'), read=p=>fs.readFileSync(p,'utf8');
const before=read(path.join(b,'staff',pos)),current=read(path.join(root,'staff',pos));
const pinned=JSON.parse(read(path.join(import.meta.dirname,'general-pos-reviewed-delta.json')));
assert.equal(hash(before),pinned.baselineSha256);
assert.equal(hash(current),pinned.candidateSha256,'Unreviewed POS source changes');
const backwards=()=>{let result=current;for(const d of [...pinned.edits].reverse()){
 assert.equal(result.slice(d.afterOffset,d.afterOffset+d.after.length),d.after);
 result=result.slice(0,d.afterOffset)+d.before+result.slice(d.afterOffset+d.after.length);}
 return result;
};
assert.equal(backwards(),before);
const ts=createRequire(path.join(root,'staff/package.json'))('typescript');
function declarations(source){
 const tree=ts.createSourceFile(pos,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),map=new Map();
 function visit(node){if((ts.isFunctionDeclaration(node)||ts.isVariableDeclaration(node))&&node.name)map.set(node.name.getText(tree),node.getText(tree));ts.forEachChild(node,visit);}
 visit(tree);return map;
}
const beforeFunctions=declarations(before),afterFunctions=declarations(current);
for(const name of ['ownsCheckoutContext','sameCheckoutAttempt','verifiedCheckoutContext','handleSendComplimentaryOtp','handleVerifyComplimentaryOtp','recoverCapturedRazorpayOrder','refreshRazorpayStatus','cancelRazorpayPayment','setSplitPaymentMode','pendingOfflineSettlement']){
 assert(beforeFunctions.get(name),'missing '+name);assert.equal(beforeFunctions.get(name).replaceAll('writeLocalStorageJson(LAST_RECEIPT_STORAGE_KEY, receipt)','writeLocalStorageJson(lastReceiptKey, receipt)'),afterFunctions.get(name),name);
}
const writer=beforeFunctions.get('writeCheckoutAttempt');
assert.equal(afterFunctions.get('writeCheckoutAttempt'),writer.replace('if (!expected && attempt.ownership!.storeId === SECTOR51_TABLE_STORE)','if (!expected)'));
const transpile=(name)=>ts.transpileModule('const '+afterFunctions.get(name)+';globalThis.subject='+name+';',{
 compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const sampleHeld=[{id:'mine',storeId:'west',heldByUid:'alice'},{id:'other-operator',storeId:'west',heldByUid:'bob'},
 {id:'other-store',storeId:'east',heldByUid:'alice'},{id:'legacy',storeId:'west'}];
function visibleHolds(posOnline){
 const context={allHeldBills:sampleHeld,uid:'alice',selectedStoreId:'west',posOnline};vm.runInNewContext(transpile('heldBills'),context);
 return Array.from(context.subject,b=>b.id);
}
assert.deepEqual(visibleHolds(false),['mine']);assert.deepEqual(visibleHolds(true),['mine','legacy']);
async function heldChange(caseName){
 const owned={uid:'alice',storeId:'west',draftKey:'draft',ready:true,saving:false,paymentPending:false,reference:'{"cart":[1]}',fingerprint:'exact'};
 const values=new Map([['draft',owned.reference]]),ctx={auth:{currentUser:{uid:'alice'}},checkoutContextRef:{current:owned},
  POS_RAZORPAY_SESSION_STORAGE_KEY:'provider',loadStoredHeldBills:()=>sampleHeld,loadCheckoutAttempt:()=>null,
  setCheckoutError:()=>{},localStorage:{getItem:k=>values.get(k)},stableJson:JSON.stringify};
 let recover=false,run;
 ctx.withCheckoutMarkerLock=fn=>{run=Promise.resolve().then(fn);return run;};
 vm.runInNewContext(transpile('coordinateHeldChange'),ctx);ctx.subject(()=>{recover=true;},sampleHeld[0]);
 if(caseName==='foreign')ctx.auth.currentUser.uid='bob';
 if(caseName==='other-store')ctx.checkoutContextRef.current={...owned,storeId:'east'};
 if(caseName==='prior-order')ctx.loadCheckoutAttempt=()=>({orderId:'original'});
 if(caseName==='captured')values.set('provider','awaiting-reconciliation');
 if(caseName==='stale-draft')values.set('draft','{}');
 if(caseName==='already-recalled')ctx.loadStoredHeldBills=()=>[];
 await run.catch(()=>{});return recover;
}
for(const example of ['owned','foreign','other-store','prior-order','captured','stale-draft','already-recalled'])
 assert.equal(await heldChange(example),example==='owned',example);
const originalTests=path.join(b,'release-qualification/source-guard-overlay/scripts');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'general-pos-guard-'));
try{
 const scripts=path.join(temp,'scripts');fs.cpSync(originalTests,scripts,{recursive:true});
 for(const f of ['node_modules','frontend','functions','package.json'])fs.symlinkSync(path.join(root,'staff',f),path.join(temp,f));
 const promotionFile=path.join(scripts,'fixtures/checkout-recovery/pos-home-promotions-20261116.json');
 const old=read(promotionFile),data=JSON.parse(old);assert.equal(data.promotions.at(-1).candidateSha256,hash(before));
 data.promotions.push(pinned);const next=JSON.stringify(data);fs.writeFileSync(promotionFile,next);
 const helper=path.join(scripts,'bundle10-test-support.mjs');fs.writeFileSync(helper,read(helper).replace(hash(old),hash(next)));
 const tests='test-checkout-recovery.mjs';assert.equal(hash(read(path.join(scripts,tests))),hash(read(path.join(root,'staff/scripts',tests))));
 const result=spawnSync(process.execPath,[path.join(scripts,tests)],{encoding:'utf8'});
 fs.writeFileSync(path.join(root,'evidence/general-checkout-recovery.log'),result.stdout+result.stderr);assert.equal(result.status,0,result.stderr);
 assert.equal(result.stdout.split('\n').filter(l=>l.startsWith('PASS ')).length,25);
 const {restoreBundle10}=await import(pathToFileURL(helper));assert.throws(()=>restoreBundle10(current+'\n// unreviewed\n'),/Unreviewed POSHome drift/);
 fs.writeFileSync(path.join(root,'evidence/general-checkout-recovery.json'),JSON.stringify({status:'PASS',unchangedOriginalCases:25,negativeSourceCheck:true,
   originalB:hash(before),candidate:hash(current),guardedEditGroups:pinned.edits.length,originalTest:hash(read(path.join(scripts,tests))),heldBillScopeAndConcurrencyChecks:9,
   preserved:['uncertain order','Razorpay recovery, refresh and cancellation','Complimentary OTP','split payment','original checkout marker and basket capture at any store']},null,2)+'\n');
 console.log('PASS 25 original checkout and recovery cases on the reviewed general POS source');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
