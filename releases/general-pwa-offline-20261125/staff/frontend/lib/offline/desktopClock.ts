import {auth} from '../firebase';
import {device, digest, sign, type Snapshot} from './journal';
import {observe, establishStationAuthority} from './authority';

const extensionId = 'obhpkahmmhfkhmdbjlhggafhfbaaaemh';
const scopeOf = async (s:Snapshot) => ({
  uid:s.uid,storeId:s.storeId,deviceId:s.deviceId,snapshotId:s.id,snapshotDigest:await digest(s),
});
async function send(message:Record<string,unknown>, timeout=2500):Promise<any> {
  const runtime = (globalThis as any).chrome?.runtime;
  if (!runtime?.sendMessage || !/^[a-p]{32}$/.test(extensionId)) throw Error('No managed session clock.');
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Session clock timed out.')),timeout);
    try {
      runtime.sendMessage(extensionId,message,(v:any)=>{
        clearTimeout(timer);
        if (runtime.lastError || !v || v.error) reject(Error('Session clock unavailable.'));
        else resolve(v);
      });
    } catch (error) { clearTimeout(timer); reject(error); }
  });
}
const recovery=import.meta.env.VITE_TILL_RECOVERY_ONLY==='true';
export async function bindDesktopClock(s:Snapshot) {
  if (recovery || auth.currentUser?.uid!==s.uid) return false;
  const scope = await scopeOf(s);
  try {
    const {nonce}=await send({type:'CHALLENGE',operation:'BIND',scope});
    if (!/^[a-f0-9-]{36}$/i.test(nonce)) return false;
    const payload={action:'CLOCK_BIND',...scope,nonce};
    const user=auth.currentUser;
    if (!user || user.uid!==s.uid) return false;
    const [signature,token,d]=await Promise.all([sign(payload),user.getIdToken(),device()]);
    if (d.id!==s.deviceId || auth.currentUser?.uid!==s.uid) return false;
    const result=await send({type:'PROVE',payload,publicKey:d.publicKey,signature,token},12500);
    return result.bound===true && result.nonce===nonce;
  } catch { return false; }
}
export async function dropDesktopClock(s:Snapshot) {
  const scope=await scopeOf(s);
  const {nonce}=await send({type:'CHALLENGE',operation:'DROP',scope});
  if (!/^[a-f0-9-]{36}$/i.test(nonce)) return;
  const payload={action:'CLOCK_DROP',...scope,nonce};
  await send({type:'PROVE',payload,signature:await sign(payload)});
}
export async function resumeDesktopClock(s:Snapshot) {
  if (recovery || auth.currentUser?.uid!==s.uid || document.visibilityState!=='visible') throw Error('Session unavailable.');
  const scope=await scopeOf(s);
  const {nonce}=await send({type:'CHALLENGE',operation:'RESUME',scope});
  if (!/^[a-f0-9-]{36}$/i.test(nonce)) throw Error('Invalid challenge.');
  const payload={action:'CLOCK_RESUME',...scope,nonce},signature=await sign(payload);
  const started=observe();
  const result=await send({type:'PROVE',payload,signature});
  if (Object.entries(scope).some(([k,v])=>result[k]!==v) || result.nonce!==nonce || result.expiresAt!==s.expiresAt ||
      auth.currentUser?.uid!==s.uid || document.visibilityState!=='visible') throw Error('Clock binding mismatch.');
  establishStationAuthority(s,started,result.serverTime);
}
