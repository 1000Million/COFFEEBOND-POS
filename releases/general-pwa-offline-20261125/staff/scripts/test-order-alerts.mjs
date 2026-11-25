// Isolated behavioral tests: production hooks/screens, fake audio and Firestore.
// No Firebase initialization, network, credentials or production writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
const root = new URL('../', import.meta.url).pathname;
const read = p => fs.readFileSync(root + p, 'utf8');
const pass = name => console.log(`${name}=PASS`);
function hooks() {
  let cursor = 0, dirty = true, tree, renderFn;
  const slots = [], effects = [];
  const changed = (a,b) => !a || a.length !== b.length || a.some((v,i) => v !== b[i]);
  const react = {
    createContext: value => ({Provider:'ContextProvider',value}),
    useContext: context => context.value,
    createElement: (type, props, ...children) => ({type, props: {...props, children: children.flat(Infinity)}}),
    useState(initial) { const i=cursor++; if(!slots[i]) slots[i]={value:typeof initial==='function'?initial():initial}; return [slots[i].value, value=>{const next=typeof value==='function'?value(slots[i].value):value;if(next!==slots[i].value){slots[i].value=next;dirty=true;}}]; },
    useRef(initial) { const i=cursor++; return slots[i] ||= {current:initial}; },
    useMemo(fn,deps) { const i=cursor++; if(!slots[i] || changed(slots[i].deps,deps))slots[i]={value:fn(),deps};return slots[i].value; },
    useEffect(fn,deps) { const i=cursor++;if(!slots[i] || changed(slots[i].deps,deps)){ const old=slots[i];slots[i]={deps,cleanup:old?.cleanup};effects.push(()=>{old?.cleanup?.();slots[i].cleanup=fn();});} },
    useSyncExternalStore(_subscribe,snapshot) { return snapshot(); },
  };
  function render(fn=renderFn) {renderFn=fn;let limit=0;do{dirty=false;cursor=0;tree=fn();while(effects.length)effects.shift()();assert(++limit<30,'render loop');}while(dirty);return tree;}
  return {react,render,unmount(){for(const slot of slots)slot?.cleanup?.();}};
}
function compile(file, imports, extras={}) {
  const module={exports:{}};
  vm.runInNewContext(transformSync(read(file),{loader:'tsx',format:'cjs',jsx:'transform'}).code,{module,exports:module.exports,require:name=>{assert(name in imports,`Unstubbed dependency: ${name}`);return imports[name];},console:{error(){}},Date,Map,Set,Symbol,Math,Float32Array,setInterval:()=>1,clearInterval(){},...extras});
  return module.exports;
}
function audioHarness() {
  const h=hooks(), events=new Map(), sources=[], contexts=[];
  class AudioContext {
    state='suspended'; currentTime=0; sampleRate=48000; destination={}; onstatechange=null;
    constructor(){contexts.push(this);}
    async resume(){if(this.rejectResume)throw Error('autoplay denied');this.state='running';this.onstatechange?.();}
    createBuffer(_channels,length,sampleRate){const samples=new Float32Array(length);return {length,sampleRate,getChannelData:()=>samples};}
    createBufferSource(){const s={connect(){},disconnect(){this.disconnected=true;},start(){this.active=true;},stop(at){if(at===undefined){this.active=false;}else this.stopAt=at;}};sources.push(s);return s;}
  }
  const win={AudioContext,addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name)};
  const mod=compile('frontend/lib/orderAlerts.tsx',{react:h.react},{window:win});
  let counts=[0,0], enabled=true;
  const render=()=>h.render(()=>{mod.useOrderAlertAudioUnlock();return counts.map(n=>mod.useRepeatingOrderAlert(n));});
  const active=()=>sources.filter(s=>s.active);
  return {h,win,events,sources,contexts,mod,active,render,setCounts:(...n)=>{counts=n;return render();},gesture:async(name='click',trusted=true)=>{events.get(name)?.({isTrusted:trusted});await Promise.resolve();return render();}};
}
const a=audioHarness();
assert(a.render()[0].audioBlocked);assert.equal(a.contexts.length,0);
await a.gesture('click',false);assert.equal(a.contexts.length,0);
await a.gesture();assert.equal(a.contexts[0].state,'running');assert(!a.render()[0].audioBlocked);assert.equal(a.active().length,0);
pass('AUDIO_UNLOCK_FIRST_INTERACTION');
a.setCounts(2,0);assert.equal(a.active().length,1);const source=a.active()[0];assert(source.loop);assert.equal(source.buffer.length/source.buffer.sampleRate,1.6);
a.setCounts(1,0);assert.equal(a.active()[0],source);a.setCounts(0,1);assert.equal(a.active().length,1);a.setCounts(0,0);assert.equal(a.active().length,0);
pass('REPEATING_LOOP_MULTI_OWNER_AND_PER_ITEM_COUNTS');
a.setCounts(2,0);a.contexts[0].state='suspended';a.contexts[0].onstatechange();assert(a.render()[0].audioBlocked);assert.equal(a.active().length,0);
a.contexts[0].rejectResume=true;await a.gesture('keydown');assert(a.render()[0].audioBlocked);
a.contexts[0].rejectResume=false;await a.gesture('touchend');assert.equal(a.active().length,1);pass('AUDIO_SUSPENSION_DENIAL_RETRY');
a.h.unmount();assert.equal(a.active().length,0);assert.equal(a.events.size,0);pass('AUDIO_CLEANUP');
const blocked=audioHarness();blocked.setCounts(1,0);const banner=blocked.mod.OrderAlertBanner({pendingCount:1,action:'Act'});assert(JSON.stringify(banner).includes('Tap to enable order alerts'));await blocked.gesture('pointerdown');assert.equal(blocked.active().length,1);pass('AUDIO_BLOCKED_VISUAL_FALLBACK');

const stamp={toDate:()=>new Date(),toMillis:()=>Date.now()};
const store={id:'QA_STORE',name:'Synthetic Cafe',code:'QA_STORE',isActive:true};
let profile={uid:'QA',name:'QA Staff',role:'ADMIN'};
let authStatus='ready';
const online=(id,paid=false)=>({id,storeId:store.id,status:paid?'PAID_PENDING_ACCEPTANCE':'PENDING',paymentProvider:paid?'RAZORPAY':'COUNTER',customerName:id,customerPhone:'',orderType:'TAKEAWAY',items:[],grandTotal:100,createdAt:stamp,trackingToken:'synthetic',publicOrderReference:id});
const kot=id=>({id,storeId:store.id,storeName:store.name,station:'KITCHEN',status:'PENDING',orderNumber:'QA-ORDER-'+id,orderType:'TAKEAWAY',itemCode:id,itemName:id,quantity:1,createdAt:stamp});
function screen(kind, initial, extraStores = []) {
  const h=hooks(), listeners=[], records=new Map(initial.map(row=>[row.id,row])), writes=[], calls=[];
  let failed=false, review=false, pendingWrites=false;
  const docs=rows=>rows.map(row=>({id:row.id,data:()=>row,exists:()=>true}));
  const matches=(row,q)=>q.filters.every(f=>f.op==='in'?f.value.includes(row[f.field]):row[f.field]===f.value);
  const emit=()=>listeners.filter(x=>x.active).forEach(x=>x.ok({metadata:{hasPendingWrites:pendingWrites},docs:docs([...records.values()].filter(row=>matches(row,x.q)))}));
  const firestore={collection:(_db,name)=>name,doc:(_db,name,id)=>({name,id}),query:(name,...filters)=>({name,filters}),where:(field,op,value)=>({field,op,value}),serverTimestamp:()=>stamp,
    getDocs:async()=>({docs:docs([store,...extraStores])}),getDoc:async()=>docs([store])[0],
    onSnapshot(q,options,ok,error){assert.equal(options.includeMetadataChanges,true);const x={q,ok,error,active:true};listeners.push(x);queueMicrotask(emit);return ()=>x.active=false;},
    async updateDoc(ref,data){if(failed)throw Error('fixture write denied');writes.push({ref,data});Object.assign(records.get(ref.id),data);emit();},
  };
  async function accept(id){calls.push(['accept',id]);if(failed)throw Error('accept failed');if(review){records.get(id).status='PAYMENT_REVIEW_REQUIRED';emit();return {reviewRequired:true};}records.get(id).status='CONVERTED';emit();return {orderNumber:id,kotCount:1,stockMovementCount:1};}
  const imports={react:h.react,'firebase/firestore':firestore,'firebase/functions':{httpsCallable:(_fn,name)=>async input=>{if(name==='acceptPaidRazorpayOrder')return {data:await accept(input.onlineOrderId)};if(name==='rejectCustomerOrder'){calls.push(['reject',input.onlineOrderId,input.reason]);if(!input.reason?.trim())throw Error('Reason required');if(failed)throw Error('reject failed');records.get(input.onlineOrderId).status='REJECTED';emit();return {data:{status:'REJECTED'}};}calls.push(['refund',input.onlineOrderId]);if(failed)throw Error('refund failed');records.get(input.onlineOrderId).status='REFUND_PENDING';emit();return {data:{}};}},
    '../../lib/firebase':{db:{},functions:{}},'../../contexts/AuthContext':{useAuth:()=>({staffProfile:profile})},'../../types':{},
    '../../lib/onlineOrderConversion':{acceptOnlineOrder:accept,isOnlineOrderAcceptError:()=>false},'../../lib/publicOrderTracking':{publicStatusMessage:()=>'',updatePublicOrderTracking:async()=>{}},
    '../../lib/connectivity':{beginCriticalOperation:()=>()=>{},requireOnlineAction:()=>true},'../../lib/posStoreAccess':{accessiblePosStores:rows=>rows,assignedStoreIdentifiers:()=>[store.id]},
    '../../lib/orderAlerts':{OrderAlertBanner:'AlertBanner'},'lucide-react':new Proxy({},{get:(_,name)=>String(name)})};
  let providerState, providerTree, providerMounted=true;
  const ph=hooks(), audioSources=[], audioContexts=[];
  class AudioContext {
    state='suspended';sampleRate=48000;destination={};
    constructor(){audioContexts.push(this);}
    async resume(){this.state='running';this.onstatechange?.();}
    createBuffer(_channels,length,sampleRate){const samples=new Float32Array(length);return {length,sampleRate,getChannelData:()=>samples};}
    createBufferSource(){const source={connect(){},disconnect(){},start(){this.active=true;},stop(){this.active=false;}};audioSources.push(source);return source;}
  }
  const audio=compile('frontend/lib/orderAlerts.tsx',{react:ph.react},{window:{AudioContext}});
  const access=compile('frontend/lib/posStoreAccess.ts',{});
  if(kind==='kot'){
    const feed=compile('frontend/lib/kotRealtimeFeed.ts',{});
    imports['../../lib/useKotRealtime']=compile('frontend/lib/useKotRealtime.ts',{
      react:h.react,'firebase/firestore':{...firestore,getDocsFromServer:async q=>({metadata:{hasPendingWrites:pendingWrites},docs:docs([...records.values()].filter(row=>matches(row,q)))})},
      '../contexts/AuthContext':{useAuth:()=>({staffProfile:profile,authStatus,firebaseUser:{uid:profile.uid}})},
      './firebase':{db:{}},'./posStoreAccess':access,'./kotRealtimeFeed':feed,
    });
  }
  const provider=compile('frontend/lib/OnlineOrderAlerts.tsx',{react:ph.react,'react-router-dom':{Link:'Link'},'firebase/firestore':firestore,
    '../contexts/AuthContext':{useAuth:()=>({staffProfile:profile,authStatus,firebaseUser:{uid:profile.uid}})},
    './firebase':{db:{}},'./posStoreAccess':access,'./orderAlerts':audio});
  function renderProvider(){if(kind!=='online'||!providerMounted)return;providerTree=ph.render(()=>{const outer=provider.OnlineOrderAlertsProvider({children:null});return typeof outer.type==='function'?outer.type(outer.props):outer;});providerState=providerTree.props.value;}
  imports['../../lib/OnlineOrderAlerts']={useOnlineOrderAlerts:()=>providerState};
  const component=compile(kind==='online'?'frontend/pages/pos/IncomingOnlineOrders.tsx':'frontend/pages/kot/KOTScreen.tsx',imports,{window:{setInterval:()=>1,clearInterval(){}}}).default;
  const render=()=>{renderProvider();return h.render(()=>component({station:'KITCHEN'}));};
  function nodes(node=render()){return !node || typeof node!=='object'?[]:[node,...(node.props?.children||[]).flatMap(x=>x===undefined?[]:nodes(x))];}
  const alert=()=>kind==='online'?(renderProvider(),providerState?.orders.length||0):nodes().find(n=>n.type==='AlertBanner').props.pendingCount;
  async function settle(){for(let i=0;i<6;i++){await Promise.resolve();render();}}
  const click=async label=>{const button=nodes().find(n=>n.type==='button' && JSON.stringify(n.props.children).includes(label));assert(button,'Missing '+label);await button.props.onClick({stopPropagation(){}});await settle();};
  const input=value=>{nodes().find(n=>n.type==='input' && n.props.placeholder==='Required only when rejecting').props.onChange({target:{value}});render();};
  return {h:{unmount(){h.unmount();ph.unmount();providerMounted=false;}},render,settle,alert,click,input,records,writes,calls,listeners,emit,nodes,provider:()=>providerState,unmountRoute:()=>h.unmount(),renderProvider,audioSources,audioContexts,enableAudio:()=>providerState.enableAudio(),fail:v=>failed=v,review:v=>review=v,pending:v=>pendingWrites=v};
}
const o=screen('online',[online('ONE',true),online('TWO')]);o.render();await o.settle();assert.equal(o.alert(),2);pass('ONLINE_ORDER_NEW_ALERT');pass('TWO_PENDING_ONLINE_ORDERS');
o.fail(true);await o.click('Accept paid order');assert.equal(o.alert(),2);o.fail(false);o.review(true);await o.click('Accept paid order');assert.equal(o.alert(),2);o.review(false);pass('FAILED_OR_BLOCKED_ACCEPTANCE_KEEPS_ALERT');
await o.click('Retry acceptance');assert.equal(o.alert(),1);pass('ONLINE_ORDER_ACCEPT_STOPS_ALERT');pass('ACCEPT_ONE_ALERT_CONTINUES');
await o.click('Reject');assert.equal(o.alert(),1);assert.equal(o.writes.length,0);o.input('Synthetic rejection');o.fail(true);await o.click('Reject');assert.equal(o.alert(),1);o.fail(false);await o.click('Reject');assert.equal(o.alert(),0);assert.equal(o.writes.length,0);assert.equal(o.calls.filter(c=>c[0]==='reject').length,2);pass('ONLINE_ORDER_REJECT_STOPS_ALERT');pass('ONLINE_REJECTION_REGRESSION');
o.records.set('THREE',online('THREE'));o.records.set('FOUR',online('FOUR',true));o.emit();await o.settle();await o.click('Accept into POS');assert.equal(o.alert(),1);await o.click('Accept paid order');assert.equal(o.alert(),0);pass('ACCEPT_ALL_ALERT_STOPS');pass('ONLINE_ACCEPTANCE_REGRESSION');
o.records.set('RECONNECT',online('RECONNECT',true));o.emit();await o.settle();o.listeners.filter(l=>l.active).forEach(l=>l.error(Error('disconnected')));await o.settle();assert.equal(o.alert(),1);await o.click('Refresh');assert.equal(o.alert(),1);o.emit();o.emit();await o.settle();assert.equal(o.alert(),1);pass('ONLINE_RECONNECT_DEDUPLICATION');
const reloaded=screen('online',[...o.records.values()]);reloaded.render();await reloaded.settle();assert.equal(reloaded.alert(),1);
const k=screen('kot',[kot('K1'),kot('K2')]);k.render();await k.settle();assert.equal(k.alert(),2);pass('KOT_NEW_ALERT');pass('TWO_PENDING_KOTS');
k.fail(true);await k.click('Start Preparing');assert.equal(k.alert(),2);k.fail(false);pass('FAILED_KOT_START_KEEPS_ALERT');
k.pending(true);k.records.get('K1').status='PREPARING';k.emit();await k.settle();assert.equal(k.alert(),2);k.records.get('K1').status='PENDING';k.pending(false);k.emit();await k.settle();pass('OPTIMISTIC_KOT_WRITE_DOES_NOT_ACKNOWLEDGE');
await k.click('Start Preparing');assert.equal(k.alert(),1);pass('KOT_ACKNOWLEDGE_STOPS_ALERT');pass('ACK_ONE_KOT_ALERT_CONTINUES');
k.nodes().find(n=>n.type==='input').props.onChange({target:{value:'nothing matches'}});assert.equal(k.alert(),1);k.nodes().find(n=>n.type==='input').props.onChange({target:{value:''}});pass('KOT_FILTER_DOES_NOT_ACKNOWLEDGE');
k.listeners.filter(l=>l.active).forEach(l=>l.error(Error('disconnected')));assert.equal(k.alert(),1);k.emit();k.emit();await k.settle();assert.equal(k.alert(),1);pass('FIRESTORE_RECONNECT_BEHAVIOUR');
await k.click('Start Preparing');assert.equal(k.alert(),0);pass('ACK_ALL_KOTS_ALERT_STOPS');
const kr=screen('kot',[...k.records.values()]);kr.render();await kr.settle();assert.equal(kr.alert(),0);pass('PAGE_RELOAD_BEHAVIOUR');
assert.equal(k.writes.length,2);assert(k.writes.every(w=>w.ref.name==='kotItems'&&w.data.status==='PREPARING'));await k.click('Mark Ready');assert.equal(k.writes.at(-1).data.status,'READY');assert(k.writes.at(-1).data.readyAt);pass('KOT_WORKFLOW_REGRESSION');
// Acceptance, paid refund and KOT handlers must remain byte-identical to baseline.
const baseline='/Users/narendrashukla/Documents/Codex/2026-09-19/architecture-canonical/releases/order-kot-alert-20260922/staff/';
for(const [file,start,end] of [['frontend/pages/pos/IncomingOnlineOrders.tsx','  const handleAccept =','  const handleReject ='],['frontend/pages/kot/KOTScreen.tsx','  const handleStatusChange =','  const selectedTicketItems =']]){
 const cut=s=>s.slice(s.indexOf(start),s.indexOf(end));assert.equal(cut(read(file)),cut(fs.readFileSync(baseline+file,'utf8')));
}
assert(!/firebase|updateDoc|setDoc|runTransaction|httpsCallable|localStorage/.test(read('frontend/lib/orderAlerts.tsx')));
pass('NO_DUPLICATE_POS');pass('NO_DUPLICATE_KOT');pass('NO_DUPLICATE_STOCK');
pass('ONLINE_ORDER_ALERT_REPEATS');pass('KOT_ALERT_REPEATS');

// Final listener guardrails: same store/equality queries, reads only, bounded
// subscriptions across refresh/store changes, ignored late callbacks, cleanup.
const otherStore={...store,id:'QA_OTHER',name:'Zeta Synthetic Cafe'};
const guard=screen('online',[online('SCOPE_A'),{...online('SCOPE_B'),storeId:otherStore.id}],[otherStore]);
guard.render();await guard.settle();
const activeListeners=()=>guard.listeners.filter(l=>l.active);
function assertQueryScope(storeId){
 assert.equal(activeListeners().length,5);
 const statuses=new Set(['PENDING','NEEDS_ATTENTION','PAID_PENDING_ACCEPTANCE','PAYMENT_REVIEW_REQUIRED','REFUND_FAILED']);
 for(const {q} of activeListeners()){
  assert.equal(q.name,'onlineOrders');assert.equal(q.filters.length,2);
  assert.equal(q.filters[0].field,'storeId');assert.equal(q.filters[0].op,'==');assert.equal(q.filters[0].value,storeId);
  assert.equal(q.filters[1].field,'status');assert.equal(q.filters[1].op,'==');assert(statuses.delete(q.filters[1].value));
 }
 assert.equal(statuses.size,0);
}
assertQueryScope(store.id);assert.equal(guard.alert(),1);
for(let n=0;n<4;n++){guard.emit();await guard.settle();await guard.click('Refresh');assertQueryScope(store.id);}
assert.equal(guard.writes.length,0);assert.equal(guard.calls.length,0);pass('INCOMING_LISTENER_READ_ONLY');
const oldListeners=[...activeListeners()];
guard.nodes().find(n=>n.type==='select').props.onChange({target:{value:otherStore.id}});await guard.settle();
assert(oldListeners.every(l=>!l.active));assertQueryScope(otherStore.id);assert.equal(guard.alert(),1);
for(const l of oldListeners)l.ok({metadata:{hasPendingWrites:false},docs:[{id:'LATE',data:()=>online('LATE')}]});
await guard.settle();assert.equal(guard.alert(),1);assert(!JSON.stringify(guard.render()).includes('LATE'));
pass('INCOMING_SAME_STORE_SCOPED_QUERIES');pass('INCOMING_NO_DUPLICATE_LISTENERS');pass('INCOMING_STORE_CHANGE_UNSUBSCRIBE');
guard.h.unmount();assert.equal(activeListeners().length,0);pass('INCOMING_UNMOUNT_UNSUBSCRIBE');

// The source of pending sound survives destruction of any route view.
const global=screen('online',[]);global.render();await global.settle();
assert.equal(global.listeners.filter(l=>l.active).length,5);
await global.enableAudio();assert.equal(global.audioContexts.length,1);
const identities=global.listeners.filter(l=>l.active);
global.unmountRoute();
for(const route of ['POS','REPORTS','ONLINE_SCREEN']){
 global.records.clear();global.emit();await global.settle();
 global.records.set(route,online(route,true));global.emit();await global.settle();
 assert.equal(global.alert(),1);assert.equal(global.audioSources.filter(s=>s.active).length,1);
 assert.deepEqual(global.listeners.filter(l=>l.active),identities);
 assert.equal(global.audioContexts.length,1);assert.equal(global.audioContexts[0].state,'running');
 pass('ONLINE_ORDER_ALERT_WHILE_ON_'+route);
}
global.records.set('SECOND',online('SECOND',true));global.emit();await global.settle();assert.equal(global.alert(),2);pass('TWO_PENDING_ORDERS');
global.records.delete('SECOND');global.emit();await global.settle();assert.equal(global.alert(),1);assert.equal(global.audioSources.filter(s=>s.active).length,1);pass('RESOLVE_ONE_ALERT_CONTINUES');
global.records.clear();global.emit();await global.settle();assert.equal(global.alert(),0);assert.equal(global.audioSources.filter(s=>s.active).length,0);pass('RESOLVE_ALL_ALERT_STOPS');
assert.equal(global.writes.length,0);assert.equal(global.calls.length,0);
pass('ROUTE_CHANGE_DOES_NOT_DISABLE_AUDIO');pass('ONE_GLOBAL_LISTENER_ONLY');pass('NO_DUPLICATE_LISTENERS');
global.provider().setSelectedStoreId('UNAUTHORIZED');await global.settle();assert.equal(global.provider().selectedStoreId,store.id);pass('UNAUTHORIZED_STORE_SELECTION_IGNORED');
global.h.unmount();assert(global.listeners.every(l=>!l.active));assert.equal(global.audioSources.filter(s=>s.active).length,0);
// Production wiring is outside Suspense; route pages only consume context.
const app=read('frontend/App.tsx');assert.equal((app.match(/<OnlineOrderAlertsProvider>/g)||[]).length,1);
assert(app.indexOf('<AuthProvider>')<app.indexOf('<OnlineOrderAlertsProvider>'));
assert(app.indexOf('<OnlineOrderAlertsProvider>')<app.indexOf('<Suspense'));
assert(app.indexOf('</OnlineOrderAlertsProvider>')>app.indexOf('</Suspense>'));
assert(!/onSnapshot|collection\(/.test(read('frontend/pages/pos/IncomingOnlineOrders.tsx')));
// KOT is composed onto the verified October3 checkout release; require exact current POS preservation.
assert.equal(read('frontend/pages/pos/POSHome.tsx'),fs.readFileSync('/Users/narendrashukla/Documents/Codex/2026-10-01/task-2/checkout-recovery-release/frontend/pages/pos/POSHome.tsx','utf8'));
assert(read('frontend/pages/kot/KOTScreen.tsx').includes('<OrderAlertBanner'));
assert(read('frontend/lib/useKotRealtime.ts').includes("scopeView === 'ACTIVE' && snapshot.metadata.hasPendingWrites"));
// Operational controls intentionally extend audio; waveform parity tested below.
const originalAudio=fs.readFileSync(baseline+'frontend/lib/orderAlerts.tsx','utf8');
const waveform=s=>s.slice(s.indexOf('  const buffer = context.createBuffer'),s.indexOf('  loop = context.createBufferSource')).split('  return buffer;')[0];
assert(read('frontend/lib/orderAlerts.tsx').includes(waveform(originalAudio)));
assert(!/updateDoc|setDoc|addDoc|deleteDoc|runTransaction|writeBatch|httpsCallable/.test(read('frontend/lib/OnlineOrderAlerts.tsx')));
pass('READ_ONLY_PROVIDER_AND_UNCHANGED_BUSINESS_KOT_AND_WAVEFORM');
for(const role of ['STORE_MANAGER','CASHIER']){
 profile={uid:'QA',name:'Staff',role,assignedStoreIds:[store.id]};
 const scoped=screen('online',[online('SCOPED'),{...online('FORBIDDEN'),storeId:'FORBIDDEN'}],[{...store,id:'FORBIDDEN'}]);scoped.render();await scoped.settle();
 assert.equal(scoped.alert(),1);assert.equal(scoped.provider().accessibleStores.length,1);assert(scoped.listeners.every(l=>l.q.filters[0].value===store.id));scoped.h.unmount();
}
pass('MANAGER_CASHIER_ASSIGNED_STORE_SCOPE');
for(const role of ['KITCHEN','BARISTA','FRANCHISE_VIEWER']){
 profile={uid:'QA',role};const denied=screen('online',[]);denied.renderProvider();assert.equal(denied.listeners.length,0);assert.equal(denied.provider(),null);denied.h.unmount();
}
profile={uid:'QA',role:'ADMIN'};
for(const status of ['signed-out','checking-profile','inactive','missing-profile','permission-error']){
 authStatus=status;const denied=screen('online',[]);denied.renderProvider();assert.equal(denied.listeners.length,0);assert.equal(denied.provider(),null);denied.h.unmount();
}
pass('AUTH_AND_NON_ONLINE_ROLE_GUARDS');

// Operational playback tests run without Firebase or business imports.
const check=audioHarness();check.render();
const tapTest=async()=>{const button=check.mod.TestAlertSoundButton();assert.equal(button.type,'button');assert(JSON.stringify(button.props.children).includes('Test alert sound'));button.props.onClick();for(let i=0;i<5;i++)await Promise.resolve();};
await tapTest();assert.equal(check.contexts[0].state,'running');assert.equal(check.active().length,1);
const previewSound=check.active()[0];assert.equal(previewSound.stopAt,2.8);assert(previewSound.loop);
pass('TEST_ALERT_BUTTON');pass('AUDIO_CONTEXT_RESUME');
await tapTest();assert(!previewSound.active);assert(previewSound.disconnected);assert.equal(check.active().length,1);
const secondPreview=check.active()[0];secondPreview.active=false;secondPreview.onended();assert(secondPreview.disconnected);assert.equal(check.active().length,0);pass('TEST_AUTOMATIC_STOP_AND_REPEAT_TAP_CLEANUP');
await check.render()[0].enableAudio();const confirmation=check.active()[0];assert.equal(confirmation.stopAt,0.5);assert.deepEqual(confirmation.buffer.getChannelData(0),previewSound.buffer.getChannelData(0));pass('ENABLE_CONFIRMATION_CHIME');
check.setCounts(2,0);assert(!confirmation.active);const productionSound=check.active()[0];assert.equal(productionSound.stopAt,undefined);assert.deepEqual(productionSound.buffer.getChannelData(0),previewSound.buffer.getChannelData(0));pass('TEST_ALERT_USES_PRODUCTION_SOUND');
await tapTest();await check.render()[0].enableAudio();assert.equal(check.active().length,1);assert.equal(check.active()[0],productionSound);check.setCounts(1,0);assert.equal(check.active()[0],productionSound);check.setCounts(0,0);assert.equal(check.active().length,0);pass('TEST_DOES_NOT_ACKNOWLEDGE_OR_INTERRUPT_PENDING_ALERT');
check.contexts[0].state='suspended';check.contexts[0].onstatechange();check.contexts[0].rejectResume=true;await tapTest();assert.equal(check.active().length,0);assert(check.render()[0].audioBlocked);check.contexts[0].rejectResume=false;await tapTest();assert.equal(check.active().length,1);pass('TEST_RESUME_FAILURE_AND_RETRY');
const providerSource=read('frontend/lib/OnlineOrderAlerts.tsx');assert(providerSource.includes('<TestAlertSoundButton />'));assert(read('frontend/components/Layout.tsx').includes('<GlobalOnlineOrderAlertBanner'));assert(!/firebase|httpsCallable|pending\.set|pending\.delete/.test(read('frontend/lib/orderAlerts.tsx').split('async function playAudioCheck')[1].split('function reconcileAudio')[0]));
pass('TEST_CONTROL_POS_ONLINE_KOT_SHARED_LAYOUT');pass('NO_FIRESTORE_ORDER_OR_KOT_STATE_MUTATIONS');

const kh=audioHarness();const kt=kh.h.render(()=>kh.mod.OrderAlertBanner({pendingCount:0,action:'Start Preparing'}));
const walk=n=>!n||typeof n!=='object'?[]:[n,...(n.props?.children||[]).flatMap(walk)];
assert(walk(kt).some(n=>n.type===kh.mod.TestAlertSoundButton));
const enableButton=walk(kt).find(n=>n.type==='button');assert.equal(typeof enableButton.props.onPointerDown,'function');enableButton.props.onPointerDown();for(let i=0;i<5;i++)await Promise.resolve();assert.equal(kh.active()[0].stopAt,0.5);pass('KITCHEN_ROLE_CONTROL_AND_POINTER_ENABLE_CONFIRMATION');
