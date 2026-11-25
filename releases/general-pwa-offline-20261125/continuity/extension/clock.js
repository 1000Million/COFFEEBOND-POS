import { origin, callable } from './config.js';

const nativeHost = 'in.coffeebond.session_clock';
const maxLease = 8 * 60 * 60 * 1000;
const pending = new Map();
const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}'
  : JSON.stringify(value ?? null);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const same = (a,b) => ['uid','storeId','deviceId','snapshotId','snapshotDigest'].every(key => a[key] === b[key]);
let serial = Promise.resolve();

async function sample() {
  const value = await chrome.runtime.sendNativeMessage(nativeHost, {action:'SAMPLE'});
  if (!value || !/^[A-Fa-f0-9-]{36}$/.test(value.epoch) || !Number.isFinite(value.ticks) || value.ticks <= 0)
    throw Error('The local session clock is unavailable.');
  return value;
}

async function verifySignature(jwk, payload, signature) {
  const key = await crypto.subtle.importKey('jwk', jwk, {name:'ECDSA', namedCurve:'P-256'}, false, ['verify']);
  const valid = await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'}, key,
    Uint8Array.from(atob(signature), ch => ch.charCodeAt(0)), new TextEncoder().encode(stable(payload)));
  if (!valid) throw Error('Device signature mismatch.');
}

async function handle(m, sender) {
  if (!sender.url || new URL(sender.url).origin !== origin || sender.frameId !== 0) throw Error('Origin mismatch.');
  if (m?.type === 'CHALLENGE') {
    const scope = Object.fromEntries(['uid','storeId','deviceId','snapshotId','snapshotDigest'].map(k=>[k,m.scope?.[k]]));
    if (!['BIND','RESUME','DROP'].includes(m.operation) ||
      !['uid','storeId','deviceId','snapshotId'].every(k=>validId(scope[k])) || !/^[a-f0-9]{64}$/.test(scope.snapshotDigest))
      throw Error('Invalid session.');
    const now = performance.now();
    for (const [key, row] of pending) if (row.deadline < now) pending.delete(key);
    if (pending.size >= 32) throw Error('Too many pending requests.');
    const nonce = crypto.randomUUID();
    pending.set(nonce, {operation:m.operation, scope, tab:sender.tab?.id, deadline:now + 15000});
    return {nonce};
  }
  const p = m?.payload, ticket = p && pending.get(p.nonce);
  if (!ticket) throw Error('Fresh challenge required.');
  pending.delete(p.nonce);
  if (performance.now() > ticket.deadline || ticket.tab !== sender.tab?.id ||
      !same(p,ticket.scope) || p.action !== 'CLOCK_' + ticket.operation) throw Error('Session mismatch.');
  if (ticket.operation === 'BIND') {
    if (typeof m.token !== 'string' || !m.token || m.token.length > 16384) throw Error('Fresh authentication is required.');
    const {kty,crv,x,y}=m.publicKey || {};
    if (kty!=='EC'||crv!=='P-256'||![x,y].every(v=>typeof v==='string' && /^[a-zA-Z0-9_-]{43}$/.test(v))) throw Error('Invalid device key.');
    const publicKey={kty,crv,x,y};
    await verifySignature(publicKey, p, m.signature);
    const before = await sample();
    const response = await fetch(callable, {method:'POST', redirect:'error', cache:'no-store', credentials:'omit',
      signal:AbortSignal.timeout(10000), headers:{'Content-Type':'application/json', Authorization:'Bearer ' + m.token},
      body:JSON.stringify({data:{action:'CLOCK_BIND',storeId:p.storeId,deviceId:p.deviceId,payload:p,signature:m.signature}})});
    if (!response.ok) throw Error('Online clock binding was declined.');
    const proof = (await response.json()).result;
    const after = await sample();
    if (!proof || !same(proof,p) || proof.nonce !== p.nonce || before.epoch !== after.epoch ||
       after.ticks < before.ticks || after.ticks-before.ticks > 10000 ||
       !Number.isSafeInteger(proof.serverTime) || !Number.isSafeInteger(proof.expiresAt) ||
       proof.serverTime >= proof.expiresAt || proof.expiresAt-proof.serverTime > maxLease) throw Error('Clock proof mismatch.');
    // Anchor before the online round trip. This deliberately spends the latency out of the original lease.
    await chrome.storage.local.set({lease:{...ticket.scope,publicKey,serverTime:proof.serverTime,
      expiresAt:proof.expiresAt,epoch:before.epoch,ticks:before.ticks}});
    return {bound:true,nonce:p.nonce};
  }
  const {lease} = await chrome.storage.local.get('lease');
  if (!lease || !same(lease,p)) throw Error('The original clock binding is unavailable.');
  await verifySignature(lease.publicKey,p,m.signature);
  if (ticket.operation==='DROP') {
    await chrome.storage.local.remove('lease');
    return {dropped:true,nonce:p.nonce};
  }
  const current = await sample(), elapsed = current.ticks-lease.ticks;
  const serverTime = Math.ceil(lease.serverTime+elapsed);
  if (current.epoch !== lease.epoch || elapsed < 0 || serverTime >= lease.expiresAt) throw Error('Original clock grant expired or interrupted.');
  return {nonce:p.nonce,...ticket.scope,serverTime,expiresAt:lease.expiresAt};
}

chrome.runtime.onMessageExternal.addListener((message,sender,respond) => {
  const run = serial.then(()=>handle(message,sender));
  serial = run.catch(()=>{});
  run.then(value=>respond(value),()=>respond({error:'Clock authority unavailable.'}));
  return true;
});
