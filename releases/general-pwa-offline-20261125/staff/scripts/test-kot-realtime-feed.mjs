import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const bundled = await build({ entryPoints: ['frontend/lib/kotRealtimeFeed.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { createKotRealtimeFeed, KOT_RESYNC_INTERVAL_MS } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
let checks = 0;
const test = async (name, fn) => { await fn(); checks++; console.log('PASS', name); };
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
function harness(extra = {}) {
  const listeners = new Map(), history = [], timers = [];
  let reads = 0, subscriptions = 0, cleanups = 0;
  const options = {
    queries: [{ storeId: 'B', query: 'B' }, { storeId: 'A', query: 'A' }, { storeId: 'A', query: 'A' }],
    subscribe(query, next, error) { subscriptions++; const entry={ next,error }; listeners.set(query,entry); return () => { cleanups++; if(listeners.get(query)===entry) listeners.delete(query); }; },
    async readServer(query) { reads++; return [{ id: query+'-server' }]; },
    publish(items,state) { history.push({ items,state }); },
    schedule(callback, milliseconds) { assert.equal(milliseconds,15000); const timer={ callback,active:true }; timers.push(timer); return () => { timer.active=false; }; },
    ...extra,
  };
  const feed=createKotRealtimeFeed(options);
  return { feed,listeners,history,timers,get reads(){return reads;},get subscriptions(){return subscriptions;},get cleanups(){return cleanups;} };
}
await test('sorted deduplicated stores have exactly one listener; cleanup stops every listener/timer', () => {
  const h=harness();assert.deepEqual([...h.listeners.keys()],['A','B']);assert.equal(h.subscriptions,2);
  h.feed.dispose();assert.equal(h.cleanups,2);assert.equal(h.timers[0].active,false);
});
await test('multi-store snapshots retain rows and loading until each store has responded', () => {
  const h=harness();h.listeners.get('B').next([{id:'B'}]);assert.equal(h.history.at(-1).state.loading,true);
  h.listeners.get('A').next([{id:'A'}]);assert.deepEqual(h.history.at(-1).items.map(x=>x.id),['A','B']);assert.equal(h.history.at(-1).state.loading,false);h.feed.dispose();
});
await test('15 second missed-listener fallback reads server and publishes both stores atomically', async () => {
  const a=deferred(),b=deferred();const h=harness({readServer:q=>q==='A'?a.promise:b.promise});
  const before=h.history.length;h.timers[0].callback();await Promise.resolve();a.resolve([{id:'new-A'}]);await Promise.resolve();
  assert.equal(h.history.length,before);b.resolve([{id:'new-B'}]);await h.feed.resync();
  assert.deepEqual(h.history.at(-1).items.map(x=>x.id),['new-A','new-B']);h.feed.dispose();
});
await test('manual and periodic resync coalesce, no overlapping reads', async () => {
  const d=deferred();let calls=0;const h=harness({readServer:()=>{calls++;return d.promise;}});
  const p=h.feed.resync();assert.equal(h.feed.resync(),p);h.timers[0].callback();await Promise.resolve();assert.equal(calls,2);
  d.resolve([]);await p;h.feed.dispose();
});
await test('new listener snapshot cannot be overwritten by an older read', async () => {
  const d=deferred();const h=harness({queries:[{storeId:'A',query:'A'}],readServer:()=>d.promise});
  const p=h.feed.resync();await Promise.resolve();h.listeners.get('A').next([{id:'new',status:'READY'}]);
  d.resolve([{id:'old',status:'PREPARING'}]);await p;assert.equal(h.history.at(-1).items[0].status,'READY');h.feed.dispose();
});
await test('late old-scope reads/callbacks cannot publish; shared gate prevents overlap across scopes', async () => {
  const gate={busy:false},d=deferred();const h=harness({readGate:gate,readServer:()=>d.promise});
  const p=h.feed.resync();await Promise.resolve();const old=h.listeners.get('A'),count=h.history.length;h.feed.dispose();
  const newer=harness({readGate:gate});await newer.feed.resync();assert.equal(newer.reads,0);
  old.next([{id:'forbidden'}]);d.resolve([{id:'forbidden'}]);await p;assert.equal(h.history.length,count);
  await newer.feed.resync();assert.equal(newer.reads,2);newer.feed.dispose();
});
await test('permission/index/network errors preserve last rows and are not empty success', async () => {
  for(const code of ['permission-denied','failed-precondition','unavailable']) {
    const h=harness({queries:[{storeId:'A',query:'A'}],readServer:()=>Promise.reject({code})});
    h.listeners.get('A').next([{id:'retained'}]);h.listeners.get('A').error({code,message:'private text'});
    assert.match(h.history.at(-1).state.error,new RegExp(code));assert.doesNotMatch(h.history.at(-1).state.error,/private text/);
    await h.feed.resync();assert.equal(h.history.at(-1).items[0].id,'retained');assert.match(h.history.at(-1).state.error,new RegExp(code));h.feed.dispose();
  }
});
await test('failed listener reattaches once; queued obsolete callback is ignored', async () => {
  const h=harness({queries:[{storeId:'A',query:'A'}]});const old=h.listeners.get('A');old.error({code:'unavailable'});
  await h.feed.resync();assert.equal(h.subscriptions,2);assert.equal(h.cleanups,1);
  const count=h.history.length;old.next([{id:'stale'}]);assert.equal(h.history.length,count);
  h.listeners.get('A').next([{id:'recovered'}]);assert.equal(h.history.at(-1).state.error,'');h.feed.dispose();
});
await test('empty scope creates no timer, listener or read',async()=>{const h=harness({queries:[]});await h.feed.resync();assert.equal(h.subscriptions,0);assert.equal(h.reads,0);assert.equal(h.timers.length,0);h.feed.dispose();});
await test('two independent mocked views see all three transitions without refresh',()=>{
  let rows=[{id:'ticket',storeId:'A',station:'BARISTA',status:'PENDING'}];const observers=[];
  const view=statuses=>harness({queries:[{storeId:'A',query:statuses}],subscribe:(statuses,next)=>{const fn=()=>next(rows.filter(r=>statuses.includes(r.status)));observers.push(fn);fn();return()=>{observers.splice(observers.indexOf(fn),1);};},readServer:async statuses=>rows.filter(r=>statuses.includes(r.status))});
  const activeA=view(['PENDING','PREPARING']),activeB=view(['PENDING','PREPARING']),readyA=view(['READY','SERVED']),readyB=view(['READY','SERVED']);
  for(const status of ['PREPARING','READY','SERVED']) {
    rows=[{...rows[0],status}];observers.forEach(fn=>fn());
    if(status==='PREPARING')for(const h of [activeA,activeB])assert.equal(h.history.at(-1).items[0].status,status);
    else {for(const h of [activeA,activeB])assert.equal(h.history.at(-1).items.length,0);for(const h of [readyA,readyB])assert.equal(h.history.at(-1).items[0].status,status);}
  }
  rows=[{...rows[0],status:'CANCELLED'}];observers.forEach(fn=>fn());for(const h of [activeA,activeB,readyA,readyB]){assert.equal(h.history.at(-1).items.length,0);h.feed.dispose();}
});
await test('query filters shared and no write/reload APIs in read controller/hook',()=>{
  const controller=readFileSync('frontend/lib/kotRealtimeFeed.ts','utf8'),hook=readFileSync('frontend/lib/useKotRealtime.ts','utf8');
  assert.doesNotMatch(controller+hook,/updateDoc|setDoc|addDoc|runTransaction|location\.reload/);
  assert.match(hook,/getDocsFromServer\(readQuery\)/);assert.match(hook,/onSnapshot\(readQuery/);
  assert.match(hook,/\['PENDING', 'PREPARING'\]/);assert.match(hook,/\['READY', 'SERVED'\]/);assert.equal(KOT_RESYNC_INTERVAL_MS,15000);
});
console.log(`${checks}/${checks} read-only realtime feed tests PASS. Mocked independent contexts; no browser/emulator timing claimed.`);
