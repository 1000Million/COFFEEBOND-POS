import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { restoreBundle10 } from './bundle10-test-support.mjs';
const require=createRequire(import.meta.url),ts=require('typescript');
const root=new URL('../',import.meta.url),page=fs.readFileSync(new URL('frontend/pages/pos/POSHome.tsx',root),'utf8');
const result=await build({entryPoints:[new URL('frontend/lib/pos/pendingCheckoutRecovery.ts',root).pathname],bundle:true,platform:'node',format:'cjs',write:false});
const helperModule={exports:{}};vm.runInNewContext(result.outputFiles[0].text,{module:helperModule,exports:helperModule.exports});
const {reconcilePendingCheckout,hasBoundCheckoutAttempt,resolvePendingCheckoutStatus,checkoutDiagnostic,hasCheckoutOwnership,bindingMatchesCheckout,sameCheckoutRecoveryBinding,checkoutBasketIdentity}=helperModule.exports;
const originalCart=[{id:'line-original',menuItemId:'COOKIE',quantity:2,addOns:[]}];
const originalReference=JSON.stringify({cart:originalCart.map(row=>({addOns:row.addOns,id:row.id,menuItemId:row.menuItemId,quantity:row.quantity})),orderType:'DINE_IN',schemaVersion:2});
const recoveryBinding={version:1,staffUid:'staff',storeId:'GOLDEN_I',orderId:'POS_OLD',authorizationId:'AUTH_OLD',basketIdentity:checkoutBasketIdentity(originalCart),basketFingerprint:'a'.repeat(64),sourceVersionHash:'b'.repeat(64)};
const attempt={orderId:'POS_OLD',idempotencyKey:'OLD',payloadHash:'A',createdAt:0,ownership:{version:1,staffUid:'staff',storeId:'GOLDEN_I',orderId:'POS_OLD',draftKey:'scoped-current',reference:originalReference},recoveryBinding};
const order={id:'POS_OLD',clientCheckoutIdempotencyKey:'OLD',checkoutPayloadHash:'A',storeId:'GOLDEN_I'};
let count=0;const test=async(name,fn)=>{await fn();count++;console.log('PASS '+name);};
const plain=v=>JSON.parse(JSON.stringify(v));
await test('matching server record is committed',async()=>assert.equal((await reconcilePendingCheckout(attempt,async()=>order)).status,'COMMITTED'));
await test('confirmed absence is not a no-payment assertion',async()=>assert.deepEqual(plain(await reconcilePendingCheckout(attempt,async()=>null)),{status:'NOT_SAVED'}));
await test('offline and permission errors remain uncertain',async()=>{for(const code of ['unavailable','permission-denied'])assert.equal((await reconcilePendingCheckout(attempt,async()=>{throw Error(code);})).status,'UNCERTAIN');});
await test('different key or hash is never accepted',async()=>{for(const changed of [{clientCheckoutIdempotencyKey:'OTHER'},{checkoutPayloadHash:'OTHER'}])assert.equal((await reconcilePendingCheckout(attempt,async()=>({...order,...changed}))).status,'UNCERTAIN');});
const ast=ts.createSourceFile('POSHome.tsx',page,ts.ScriptTarget.ES2022,true,ts.ScriptKind.TSX);
function declaration(name,sourceAst=ast){let found;const visit=node=>{if(ts.isVariableDeclaration(node)&&node.name.getText(sourceAst)===name)found='const '+node.getText(sourceAst)+';';if(ts.isFunctionDeclaration(node)&&node.name?.text===name)found=node.getText(sourceAst);ts.forEachChild(node,visit);};visit(sourceAst);assert(found,name);return ts.transpileModule(found+'\nglobalThis.subject='+name,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;}
const sourceAst=file=>ts.createSourceFile(file,fs.readFileSync(new URL(file,root),'utf8'),ts.ScriptTarget.ES2022,true,ts.ScriptKind.TS);
const repositoryAst=sourceAst('frontend/data/orders/posOrderRepository.ts');
const lifecycleAst=sourceAst('frontend/lib/pos/posOrderLifecycle.ts');
function context(changes={}){
  const writes=[],state={},markerKey='coffeeBondPos:pendingCheckoutAttempt:v1';
  const records=new Map([[markerKey,JSON.stringify(attempt)],['scoped-current',originalReference],['held','held-sentinel'],['offline','offline-sentinel']]);
  const resolution={status:'COMMITTED',order,staffUid:'staff',recoveryBinding};
  const ctx={exports:{},CHECKOUT_ATTEMPT_STORAGE_KEY:markerKey,pendingRecovery:{attempt,resolution},counterDraftConflict:false,recoveryBusy:false,isSaving:false,razorpaySession:null,staffProfile:{role:'ADMIN'},auth:{currentUser:{uid:'staff'}},checkoutAttemptRef:{current:{...attempt}},
    checkoutContextRef:{current:{uid:'staff',storeId:'GOLDEN_I',draftKey:'scoped-current',ready:true,saving:false,paymentPending:false,reference:originalReference,fingerprint:'original-fingerprint'}},
    hasBoundCheckoutAttempt,hasCheckoutOwnership,bindingMatchesCheckout,sameCheckoutRecoveryBinding,
    window:{confirm:()=>true,localStorage:{getItem:key=>records.get(key)??null,removeItem:key=>{writes.push({key,removed:true});records.delete(key);}}},
    loadCheckoutAttempt:()=>records.has(markerKey)?JSON.parse(records.get(markerKey)):null,
    withCheckoutMarkerLock:async mutation=>mutation(),
    readLocalStorageJson:()=>[],writeLocalStorageJson:(key,value)=>writes.push({key,value}),
    writeCheckoutAttempt:async(value,expected)=>{assert.equal(JSON.stringify(JSON.parse(records.get(markerKey))),JSON.stringify(expected));writes.push({key:markerKey,value});records.set(markerKey,JSON.stringify(value));},
    writeLocalDraft:(key,value)=>{writes.push({key,value});records.set(key,JSON.stringify(value));return true;},
    createCheckoutAttempt:()=>({orderId:'POS_NEW',idempotencyKey:'NEW',createdAt:1}),
    setPendingRecovery:value=>state.recovery=value,setCheckoutError:value=>state.error=value,setReceiptView:value=>state.receipt=value,
    checkPendingCheckout:async()=>resolution,clearCart:()=>{ctx.cart=[];},...changes};
  if(!ctx.window.localStorage)ctx.window.localStorage={getItem:key=>records.get(key)??null,removeItem:key=>{writes.push({key,removed:true});records.delete(key);}};
  records.set(markerKey,JSON.stringify(ctx.checkoutAttemptRef.current));
  vm.createContext(ctx);
  for(const[name,tree]of [['stableJson',lifecycleAst],['sameCheckoutAttempt',ast],['hasPendingCheckoutGuard',ast],['ownsCheckoutContext',ast],['verifiedCheckoutContext',ast],['completeSavedCheckout',ast]]){vm.runInContext('(function(){'+declaration(name,tree)+'})()',ctx);ctx[name]=ctx.subject;}
  return{ctx,writes,state,records};
}
await test('server-verified separate-sale action clears only original basket before removing its marker',async()=>{const{ctx,writes,records}=context({cart:originalCart});vm.runInContext(declaration('startSeparateBill'),ctx);await ctx.subject();assert.equal(ctx.checkoutAttemptRef.current,null);assert.equal(writes[0].key,'scoped-current');assert.deepEqual(plain(writes[0].value),{cart:[],orderType:'DINE_IN'});assert.equal(writes[1].key,'coffeeBondPos:pendingCheckoutAttempt:v1');assert.equal(writes[1].removed,true);assert.deepEqual(plain(ctx.cart),[]);assert.equal(records.get('held'),'held-sentinel');assert.equal(records.get('offline'),'offline-sentinel');});
await test('cancel confirmation retains old key',async()=>{const{ctx,writes}=context({window:{confirm:()=>false}});vm.runInContext(declaration('startSeparateBill'),ctx);await ctx.subject();assert.equal(ctx.checkoutAttemptRef.current.orderId,'POS_OLD');assert.equal(writes.length,0);});
await test('absence or read failure never rotates key',async()=>{for(const status of ['NOT_SAVED','UNCERTAIN']){const{ctx,writes}=context({checkPendingCheckout:async()=>({status})});vm.runInContext(declaration('startSeparateBill'),ctx);await ctx.subject();assert.equal(ctx.checkoutAttemptRef.current.orderId,'POS_OLD');assert.equal(writes.length,0);}});
await test('saved Razorpay request blocks separate-sale action',async()=>{const{ctx,writes}=context({razorpaySession:{status:'PAYMENT_CAPTURED'}});vm.runInContext(declaration('startSeparateBill'),ctx);await ctx.subject();assert.equal(writes.length,0);});
await test('auth switch or attempt change during reconciliation rejects result',async()=>{for(const mode of ['auth','attempt']){const{ctx,writes}=context();ctx.checkPendingCheckout=async()=>{if(mode==='auth')ctx.auth.currentUser.uid='other';else ctx.checkoutAttemptRef.current.orderId='OTHER';return{status:'COMMITTED',order};};vm.runInContext(declaration('startSeparateBill'),ctx);await ctx.subject();assert.equal(writes.length,0);}});
await test('all valid legacy markers survive expiry and fail closed without ownership',async()=>{const ctx={hasBoundCheckoutAttempt,Date:{now:()=>7200001},CHECKOUT_ATTEMPT_TTL_MS:7200000,sanitizeFirestoreId:v=>v};vm.createContext(ctx);vm.runInContext(declaration('validStoredCheckoutAttempt'),ctx);assert.equal(ctx.subject(attempt).orderId,'POS_OLD');assert.equal(ctx.subject({...attempt,payloadHash:undefined,ownership:undefined,recoveryBinding:undefined}).orderId,'POS_OLD');});
await test('mismatch reconciles before order transaction instead of throwing',async()=>{const start=page.indexOf('if (checkoutAttempt.payloadHash && checkoutAttempt.payloadHash !== requestPayloadHash)');const end=page.indexOf('const payloadAttempt = { ...checkoutAttempt, payloadHash: requestPayloadHash };',start);assert(end>start);const block=page.slice(start,end);assert.match(block,/await checkPendingCheckout\(checkoutAttempt\)/);assert(!block.includes('throw new Error'));assert(start<page.indexOf('const transactionResult = await persistPosOrder'));});
await test('pending store/hold/recall/clear cannot discard unresolved bound key',async()=>{for(const name of ['handleStoreChange','holdCurrentBill','recallHeldBill','clearCart'])assert.match(declaration(name),/checkPendingCheckout/);});
await test('Admin-confirmed exact original basket reuses identity and preserves earlier hash',async()=>{const{ctx,writes}=context({checkPendingCheckout:async()=>({status:'NOT_SAVED',staffUid:'staff',recoveryBinding}),cart:originalCart});vm.runInContext(declaration('retryOriginalReference'),ctx);await ctx.subject();assert.equal(ctx.checkoutAttemptRef.current.orderId,'POS_OLD');assert.equal(ctx.checkoutAttemptRef.current.idempotencyKey,'OLD');assert.equal(ctx.checkoutAttemptRef.current.payloadHash,undefined);assert.deepEqual(plain(ctx.checkoutAttemptRef.current.previousPayloadHashes),['A']);assert.equal(writes.length,1);assert.deepEqual(plain(ctx.cart),originalCart);assert(ctx.sameCheckoutAttempt(ctx.checkoutAttemptRef.current,ctx.loadCheckoutAttempt()));});
await test('manual retry refuses non-Admin, payment request, unconfirmed or uncertain outcome',async()=>{for(const changes of [{staffProfile:{role:'CASHIER'}},{razorpaySession:{status:'WAITING_FOR_PAYMENT'}},{window:{confirm:()=>false}},{checkPendingCheckout:async()=>({status:'UNCERTAIN'})},{checkPendingCheckout:async()=>({status:'COMMITTED',order})}]){const{ctx,writes}=context({checkPendingCheckout:async()=>({status:'NOT_SAVED',staffUid:'staff',recoveryBinding}),...changes});vm.runInContext(declaration('retryOriginalReference'),ctx);await ctx.subject();assert.equal(writes.length,0);assert.equal(ctx.checkoutAttemptRef.current.orderId,'POS_OLD');}});
await test('late original commit reconciles using preserved prior hash',async()=>assert.equal((await reconcilePendingCheckout({...attempt,payloadHash:'B',previousPayloadHashes:['A']},async()=>order)).status,'COMMITTED'));
await test('prior hash remains bound after confirmation even before next Charge',async()=>assert.equal(hasBoundCheckoutAttempt({...attempt,payloadHash:undefined,previousPayloadHashes:['A']}),true));
await test('actual store/hold/recall/clear handlers retain draft and reconcile before mutation',async()=>{for(const identity of [attempt,{...attempt,payloadHash:undefined,previousPayloadHashes:['A']}])for(const name of ['handleStoreChange','holdCurrentBill','recallHeldBill','clearCart']){let checks=0;const draft=[{item:'edited'}];const{ctx}=context({hasBoundCheckoutAttempt,cart:draft,selectedStoreId:'GOLDEN_I',checkoutAttemptRef:{current:{...identity}},checkPendingCheckout:async()=>{checks++;return{status:'UNCERTAIN'};}});vm.runInContext(declaration(name),ctx);await ctx.subject(name==='handleStoreChange'?{target:{value:'GOLDEN_I'}}:name==='clearCart'?false:{storeId:'OTHER'});assert.equal(checks,1);assert.equal(ctx.cart,draft);assert.equal(ctx.checkoutAttemptRef.current.orderId,'POS_OLD');}});
// Extract the actual navigation, request payload and identity functions. Only
// the callable transport and storage effects are synthetic; no Firebase starts.
function navigationContext({identity=attempt,status='UNCERTAIN',change=()=>{}}={}){
  identity=plain({...identity,ownership:{...identity.ownership,storeId:'OTHER',draftKey:'scoped-target'},recoveryBinding:{...identity.recoveryBinding,storeId:'OTHER'}});
  const markerKey='coffeeBondPos:pendingCheckoutAttempt:v1',draftKey='scoped-current',targetKey='scoped-target';
  const draft=[{menuItemId:'COOKIE',quantity:2}],records=new Map([[markerKey,JSON.stringify(identity)],[draftKey,'original-current-draft'],[targetKey,'original-target-draft'],['held','held-sentinel'],['offline','offline-sentinel']]);
  const before=[...records],requests=[],draftWrites=[],pending=[];let endings=0;
  const{ctx,state}=context({exports:{},hasBoundCheckoutAttempt,resolvePendingCheckoutStatus,checkoutDiagnostic,cart:draft,orderType:'DINE_IN',selectedStoreId:'GOLDEN_I',stores:[{id:'GOLDEN_I'},{id:'OTHER'}],
    checkoutAttemptRef:{current:{...identity}},checkoutContextRef:{current:{uid:'staff',storeId:'GOLDEN_I',draftKey,ready:true,saving:false,paymentPending:false,fingerprint:'original-fingerprint'}},
    recoveryGenerationRef:{current:0},recoveryInFlightRef:{current:false},setRecoveryBusy:value=>{ctx.recoveryBusy=value;},requireOnlineAction:()=>true,beginCriticalOperation:()=>()=>{endings++;},
    window:{localStorage:{getItem:key=>records.get(key)??null}},loadCheckoutAttempt:()=>JSON.parse(records.get(markerKey)),
    writeLocalDraft:(key,value)=>{draftWrites.push({key,value:plain(value)});records.set(key,JSON.stringify(value));return true;},setSelectedStoreId:value=>{ctx.selectedStoreId=value;},
    recoverCheckout:async payload=>{requests.push(plain(payload));assert.equal(payload.operation,'RECOVERY_STATUS');change(ctx,records);return{data:{status,orderId:identity.orderId,storeId:'OTHER',staffUid:'staff',recoveryBinding:identity.recoveryBinding}};},
  });
  for(const[name,tree]of [['stableJson',lifecycleAst],['sameCheckoutAttempt',ast],['requestPendingCheckoutRecovery',repositoryAst],['recoverCheckoutStore',ast]]){vm.runInContext('(function(){'+declaration(name,tree)+'})()',ctx);ctx[name]=ctx.subject;}
  const navigate=ctx.recoverCheckoutStore;ctx.recoverCheckoutStore=target=>{const promise=navigate(target);pending.push(promise);return promise;};
  return{ctx,state,records,before,requests,draftWrites,draft,markerKey,draftKey,targetKey,get endings(){return endings;},async run(){vm.runInContext(declaration('handleStoreChange'),ctx);await ctx.subject({target:{value:'OTHER'}});await Promise.all(pending);}};
}
await test('actual cross-store handler refuses uncertain status and preserves marker, scoped drafts, held/offline state',async()=>{for(const identity of [attempt,{...attempt,payloadHash:undefined,previousPayloadHashes:['A']}]){const h=navigationContext({identity});await h.run();assert.equal(h.requests.length,1);assert.equal(h.requests[0].storeId,'OTHER');assert.equal(h.requests[0].payloadHash,'A');assert.equal(h.ctx.selectedStoreId,'GOLDEN_I');assert.equal(h.ctx.cart,h.draft);assert.deepEqual([...h.records],h.before);assert.equal(h.draftWrites.length,0);assert.equal(h.endings,1);}});
await test('actual cross-store handler navigates only after verified status without checkout or retirement',async()=>{const h=navigationContext({status:'REVIEW_REQUIRED'});await h.run();assert.equal(h.requests.length,1);assert.equal(h.requests[0].operation,'RECOVERY_STATUS');assert.equal(h.requests[0].orderId,'POS_OLD');assert.equal(h.ctx.selectedStoreId,'OTHER');assert.equal(h.draftWrites.length,1);assert.equal(h.draftWrites[0].key,h.draftKey);assert.deepEqual(h.draftWrites[0].value,{cart:h.draft,orderType:'DINE_IN'});for(const[key,value]of h.before)if(key!==h.draftKey)assert.equal(h.records.get(key),value);assert.equal(h.ctx.checkoutAttemptRef.current.orderId,'POS_OLD');assert.equal(h.endings,1);});
await test('actual cross-store handler rejects stale account/store/basket/marker/draft and concurrent operation changes',async()=>{for(const change of [ctx=>{ctx.auth.currentUser.uid='other';},ctx=>{ctx.checkoutContextRef.current.storeId='different';},ctx=>{ctx.checkoutContextRef.current.fingerprint='edited';},ctx=>{ctx.checkoutContextRef.current.draftKey='different';},ctx=>{ctx.checkoutAttemptRef.current.orderId='POS_OTHER';},(ctx,records)=>{records.set('coffeeBondPos:pendingCheckoutAttempt:v1',JSON.stringify({...attempt,orderId:'POS_OTHER'}));},(ctx,records)=>{records.set('scoped-current','other-window-edit');},ctx=>{ctx.checkoutContextRef.current.saving=true;},ctx=>{ctx.checkoutContextRef.current.paymentPending=true;},ctx=>{ctx.checkoutContextRef.current.ready=false;}]){const h=navigationContext({status:'REVIEW_REQUIRED',change});await h.run();assert.equal(h.ctx.selectedStoreId,'GOLDEN_I');assert.equal(h.draftWrites.length,0);assert.equal(h.records.get(h.targetKey),'original-target-draft');assert.equal(h.records.get('held'),'held-sentinel');assert.equal(h.records.get('offline'),'offline-sentinel');assert.equal(h.requests.length,1);assert.equal(h.endings,1);}});
await test('actual cleanup refuses wrong staff/store/basket/reference/binding and preserves every marker',async()=>{
  for(const mutate of [
    ctx=>{ctx.auth.currentUser.uid='other';},ctx=>{ctx.checkoutContextRef.current.uid='other';},
    ctx=>{ctx.checkoutContextRef.current.storeId='OTHER';},ctx=>{ctx.checkoutContextRef.current.draftKey='unrelated-draft';},
    ctx=>{ctx.checkoutContextRef.current.reference=originalReference+' ';},ctx=>{ctx.checkoutAttemptRef.current={...attempt,orderId:'POS_OTHER'};},
    ctx=>{ctx.pendingRecovery.resolution={...ctx.pendingRecovery.resolution,staffUid:'other'};},
    ctx=>{ctx.pendingRecovery.resolution={...ctx.pendingRecovery.resolution,recoveryBinding:{...recoveryBinding,basketFingerprint:'c'.repeat(64)}};},
    ctx=>{ctx.checkoutContextRef.current.ready=false;},ctx=>{ctx.checkoutContextRef.current.paymentPending=true;},ctx=>{ctx.counterDraftConflict=true;},
  ]){const h=context({cart:originalCart});const before=[...h.records],checked={...h.ctx.checkoutContextRef.current};mutate(h.ctx);assert.equal(await h.ctx.completeSavedCheckout(attempt,h.ctx.pendingRecovery.resolution,checked),false);assert.deepEqual([...h.records],before);assert.equal(h.writes.length,0);}
});
await test('actual cleanup refuses malformed legacy ownership and unknown server outcome',async()=>{
  for(const resolution of [{status:'UNCERTAIN',reason:'READ_FAILED'},{status:'NOT_SAVED',staffUid:'staff',recoveryBinding}]){const h=context({cart:originalCart});assert.equal(await h.ctx.completeSavedCheckout(attempt,resolution,{...h.ctx.checkoutContextRef.current}),false);assert.equal(h.writes.length,0);}
  const legacy={...attempt,ownership:undefined,recoveryBinding:undefined};const h=context({checkoutAttemptRef:{current:legacy}});assert.equal(await h.ctx.completeSavedCheckout(legacy,h.ctx.pendingRecovery.resolution,{...h.ctx.checkoutContextRef.current}),false);assert.equal(h.writes.length,0);
});
await test('actual cleanup rejects persisted draft/marker races and failed draft persistence',async()=>{
  for(const mutate of [h=>{h.records.set('scoped-current','other-window-edit');},h=>{h.records.set('coffeeBondPos:pendingCheckoutAttempt:v1',JSON.stringify({...attempt,payloadHash:'OTHER'}));},h=>{h.ctx.writeLocalDraft=()=>false;}]){const h=context({cart:originalCart});mutate(h);const before=[...h.records];assert.equal(await h.ctx.completeSavedCheckout(attempt,h.ctx.pendingRecovery.resolution,{...h.ctx.checkoutContextRef.current}),false);assert.deepEqual([...h.records],before);assert.equal(h.writes.length,0);}
});
await test('authoritative resolver rejects wrong original staff/store/reference/basket binding',async()=>{
  const base={status:'REVIEW_REQUIRED',orderId:attempt.orderId,storeId:'GOLDEN_I',staffUid:'staff',recoveryBinding};
  assert.equal((await resolvePendingCheckoutStatus(attempt,base,'GOLDEN_I')).status,'NOT_SAVED');
  for(const change of [{staffUid:'other'},{storeId:'OTHER'},{orderId:'POS_OTHER'},{recoveryBinding:{...recoveryBinding,basketIdentity:'different basket'}},{recoveryBinding:{...recoveryBinding,basketFingerprint:'c'.repeat(64)}},{recoveryBinding:{...recoveryBinding,sourceVersionHash:'c'.repeat(64)}},{recoveryBinding:undefined}])assert.equal((await resolvePendingCheckoutStatus(attempt,{...base,...change},'GOLDEN_I')).status,'UNCERTAIN');
});
await test('legacy adapter retains actual recovery handlers and rejects unreviewed source drift',async()=>{assert.match(restoreBundle10(page).slice(restoreBundle10(page).indexOf('  const holdCurrentBill =')),/checkPendingCheckout/);const drift=page.replace('return 100;', 'return 99;');assert.notEqual(drift,page);assert.throws(()=>restoreBundle10(drift),/Unreviewed POSHome drift/);});
console.log('Checkout recovery tests: '+count+'/'+count+' PASS; isolated synthetic state, no Firebase initialization/network.');
