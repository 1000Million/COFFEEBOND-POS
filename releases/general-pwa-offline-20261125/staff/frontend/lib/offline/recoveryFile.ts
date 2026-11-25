import {auth} from '../firebase';
import {getMeta, sign, stable, type Entry} from './journal';
import {transaction} from './storage';

type Capture = {id:string; offlineId:string; [key:string]:unknown};
interface RecoveryFile {
  format:'coffee-bond-till-journal/1';
  storeId:string;
  uid:string;
  deviceId:string;
  entries:Entry[];
  captures:Capture[];
}

async function context(storeId:string) {
  const uid=auth.currentUser?.uid;
  const device=await getMeta('device');
  if (!uid || !storeId || !device?.id || !device.publicKey || !device.privateKey)
    throw Error('Sign in on the original enrolled till and choose its store.');
  return {uid,device};
}

export async function exportRecoveryFile(storeId:string) {
  const {uid,device}=await context(storeId);
  const {entries,captures}=await transaction<{entries:Entry[];captures:Capture[]}>(
    ['entries','closures'],'readonly',(tx,done)=>{
      const all=tx.objectStore('entries').getAll(), markers=tx.objectStore('closures').getAll();
      markers.onsuccess=()=>{
        const entries=(all.result as Entry[]).filter(e=>e.payload.uid===uid && e.payload.storeId===storeId && e.payload.deviceId===device.id);
        const ids=new Set(entries.map(e=>e.id));
        done({entries,captures:markers.result.filter(c=>ids.has(c.offlineId))});
      };
    });
  if(!entries.length) throw Error('There are no signed records for this staff member and store.');
  if(auth.currentUser?.uid!==uid) throw Error('The staff session changed. Open the journal again.');
  // Use the same canonical encoding as each original record, including explicit nulls.
  const backup:RecoveryFile=JSON.parse(stable({format:'coffee-bond-till-journal/1',storeId,uid,deviceId:device.id,entries,captures}));
  const signature=await sign(backup);
  return new Blob([JSON.stringify({backup,signature})],{type:'application/json'});
}

export async function importRecoveryFile(storeId:string, data:string) {
  const {uid,device}=await context(storeId);
  const {backup,signature}=JSON.parse(data) as {backup:RecoveryFile;signature:string};
  if(backup?.format!=='coffee-bond-till-journal/1' || backup.storeId!==storeId || backup.uid!==uid || backup.deviceId!==device.id
     || !Array.isArray(backup.entries) || !Array.isArray(backup.captures)) throw Error('This file belongs to a different till, store or staff member.');
  const key=await crypto.subtle.importKey('jwk',device.publicKey,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
  const verify=(value:unknown,sig:string)=>crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,
    Uint8Array.from(atob(sig),ch=>ch.charCodeAt(0)), new TextEncoder().encode(stable(value)));
  if(!await verify(backup,signature)) throw Error('The recovery file signature did not match the enrolled till.');
  const ids=new Set<string>();
  for(const entry of backup.entries){
    const p=entry.payload;
    if(!p || !entry.id || ids.has(entry.id) || entry.id!==p.id || p.storeId!==storeId || p.uid!==uid || p.deviceId!==device.id
       || !['PENDING','SYNCED','UNCERTAIN','CONFLICT'].includes(entry.status) || !await verify(p,entry.signature))
      throw Error('A signed record failed verification. The journal was kept.');
    ids.add(entry.id);
  }
  if(backup.captures.some(c=>typeof c.id!=='string'||!ids.has(c.offlineId)) || new Set(backup.captures.map(c=>c.id)).size!==backup.captures.length)
    throw Error('The recovery file contains an invalid operation reference.');
  let mismatch='';
  try {
    return await transaction<number>(['entries','closures'],'readwrite',(tx,done)=>{
      let count=0;
      const abort=(message:string)=>{mismatch=message;tx.abort();};
      const entries=tx.objectStore('entries'),closures=tx.objectStore('closures');
      if(auth.currentUser?.uid!==uid){abort('The staff session changed.');return;}
      for(const e of backup.entries){
        const get=entries.get(e.id);
        get.onsuccess=()=>{
          const current=get.result;
          if(current){
            if(stable(current.payload)!==stable(e.payload)||current.signature!==e.signature)
              abort('An original operation already has different contents. Keep both copies for reconciliation.');
            return;
          }
          entries.add({...e,status:e.status==='PENDING'?'UNCERTAIN':e.status});
          done(++count);
        };
      }
      for(const c of backup.captures){
        const get=closures.get(c.id);
        get.onsuccess=()=>{
          if(get.result && stable(get.result)!==stable(c)){abort('A table or bill reference already belongs to another saved operation.');return;}
          if(!get.result)closures.add(c);
        };
      }
      done(count);
    });
  } catch(error){if(mismatch)throw Error(mismatch);throw error;}
}
