import { resumeOfflineSession } from './restart';
import {bindDesktopClock,dropDesktopClock} from './desktopClock';
import { transaction, persistenceStatus } from './storage';
import {observe,establishAuthority,authorizedTime,invalidateAuthority,invalidateScope,mayResumeAfterRestart} from './authority';
import {tableTotals} from '../tables/domain';
import {approvedRoundLines, hasTableAuthority, supportedOfflineSnapshot, isTableStep, projectTables} from './tableRepository';
import {hasLocalPrintAuthority} from './localPrint';
import type {TableDraftLine} from '../tables/drafts';
import {httpsCallable} from 'firebase/functions';
import {auth,functions} from '../firebase';
export type Snapshot={offlinePolicyVersion?:number;tableWorkflowVersion?:number;tableOwnership?:{deviceId:string;storeId:string};tableBoard?:any;tableSessions?:any[];printStationId?:string;printRoutes?:any;id:string;uid:string;deviceId:string;storeId:string;storeName:string;role:string;discountLimit:number;issuedAt:number;expiresAt:number;menu:any[];excluded:any[];tables:any[];legal:any;gst:any};
export type Entry={id:string;payload:any;signature:string;status:'PENDING'|'UNCERTAIN'|'CONFLICT'|'SYNCED';conflicts?:string[];result?:any;error?:string;pendingReason?:string;syncedAt?:number};
export async function getMeta(id:string):Promise<any>{return transaction(['meta'],'readonly',(tx,done)=>{const q=tx.objectStore('meta').get(id);q.onsuccess=()=>done(q.result?.value)})}
export async function putMeta(id:string,value:any){return transaction(['meta'],'readwrite',(tx,done)=>{tx.objectStore('meta').put({id,value});done(undefined)})}
export async function entries():Promise<Entry[]>{return transaction(['entries'],'readonly',(tx,done)=>{const q=tx.objectStore('entries').getAll();q.onsuccess=()=>done(q.result)})}
const draftCaptureKey = (storeId:string, lineId:string) =>
 `counter:${JSON.stringify([storeId, lineId])}`;

async function cashCapture(keys:string[]):Promise<string|null>{
 if(!keys.length)return null;
 return transaction(['closures'],'readonly',(tx,done)=>{
  const store=tx.objectStore('closures');
  let remaining=keys.length;
  let found:string|null=null;
  for(const key of keys){
   const request=store.get(key);
   request.onsuccess=()=>{
    found ??= request.result?.offlineId ?? null;
    if(--remaining===0)done(found);
   };
  }
 });
}
export const cashCaptureForBasket = (storeId:string, lineIds:string[]) =>
 cashCapture(lineIds.map(lineId=>draftCaptureKey(storeId,lineId)));
export const cashCaptureForTable = (storeId:string, sessionId:string) =>
 cashCapture([storeId+':'+sessionId]);
export const stable=(v:any):string=>Array.isArray(v)?`[${v.map(stable).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')}}`:JSON.stringify(v??null);
export async function digest(v:any){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(stable(v))))).map(v=>v.toString(16).padStart(2,'0')).join('')}
export async function device() {
 const existing = await getMeta('device');
 if (existing) return existing;
 const keys = await crypto.subtle.generateKey({name:'ECDSA', namedCurve:'P-256'}, false, ['sign','verify']);
 const candidate = {id:crypto.randomUUID(), privateKey:keys.privateKey, publicKey:await crypto.subtle.exportKey('jwk',keys.publicKey)};
 return transaction<any>(['meta'],'readwrite',(tx,done)=>{
  const store=tx.objectStore('meta'), read=store.get('device');
  read.onsuccess=()=>{
   if(read.result) {done(read.result.value);return;}
   store.add({id:'device',value:candidate});done(candidate);
  };
 });
}
export async function deviceIdentity(){const d=await device();const key=await crypto.subtle.importKey('jwk',d.publicKey,{name:'ECDSA',namedCurve:'P-256'},true,['verify']);const spki=await crypto.subtle.exportKey('spki',key);const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',spki))).map(v=>v.toString(16).padStart(2,'0')).join('');return {deviceId:d.id,keyFingerprint:fingerprint}}
export async function sign(payload:any){const d=await device(),signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},d.privateKey,new TextEncoder().encode(stable(payload)));return btoa(String.fromCharCode(...new Uint8Array(signature)))}
export async function call(action:string,storeId:string,extra:any={}){if(!navigator.onLine)throw Error('Offline: the cash journal remains on this device.');const user=auth.currentUser;if(!user)throw Error('Sign in again to synchronize.');await user.getIdToken(true);const d=await device();return (await httpsCallable(functions,'offlineCash')({action,storeId,deviceId:d.id,...extra})).data as any}
export async function register(storeId:string){const d=await device(),identity=await deviceIdentity(),payload={action:'REGISTER',uid:auth.currentUser?.uid,storeId,deviceId:d.id,keyFingerprint:identity.keyFingerprint};return call('REGISTER',storeId,{publicKey:d.publicKey,payload,signature:await sign(payload)})}
export const tillRecoveryOnly=import.meta.env.VITE_TILL_RECOVERY_ONLY==='true';
const assertCaptureEnabled=()=>{if(tillRecoveryOnly)throw Error('New offline billing is paused in this recovery release. Saved references can still synchronize.');};
export async function prepare(storeId:string):Promise<Snapshot>{
 assertCaptureEnabled();
 const d=await device(), uid=auth.currentUser?.uid;
 const original=await getMeta('snapshot') as Snapshot|undefined;
 const payload={action:'PREPARE',uid,storeId,deviceId:d.id,tableWorkflowVersion:1};
 const signature=await sign(payload), started=observe();
 let response;
 try { response=await call('PREPARE',storeId,{payload,signature}); }
 catch(error:any) {
  if (uid && ['functions/permission-denied','functions/unauthenticated','functions/failed-precondition'].includes(error?.code)) {
    invalidateScope(uid,storeId);
    if(original?.uid===uid && original.storeId===storeId){
     await transaction(['meta'],'readwrite',(tx,done)=>{
      const meta=tx.objectStore('meta'),read=meta.get('snapshot');
      read.onsuccess=()=>{
       if(read.result?.value?.id===original.id) meta.put({...read.result,captureBlocked:true});
       done(undefined);
      };
     });
     void dropDesktopClock(original).catch(()=>{});
    }
  }
  throw error;
 }
 const snapshot=response.snapshot as Snapshot;
 const key=await crypto.subtle.importKey('jwk',response.publicKey,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
 const sig=Uint8Array.from(atob(response.signature),(c:string)=>c.charCodeAt(0));
 if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,sig,new TextEncoder().encode(stable(snapshot)))
    || !uid || auth.currentUser?.uid!==uid || snapshot.uid!==uid || snapshot.deviceId!==d.id || snapshot.storeId!==storeId) {
   invalidateAuthority('Signed store authorization did not match the active till. Reconnect and prepare again.');
   throw Error('Approved snapshot identity or signature failed.');
 }
 // A refresh either installs the entire matching proof and catalogue or retains the previous pair.
 let pendingWork=false;
 try {
  await transaction(['meta','entries'],'readwrite',(tx,done)=>{
   const records=tx.objectStore('entries').openCursor();
   records.onsuccess=()=>{
    const row=records.result;
    if(row){
     if(row.value.status!=='SYNCED'){pendingWork=true;tx.abort();return;}
     row.continue();return;
    }
    if(auth.currentUser?.uid!==uid){tx.abort();return;}
    const meta=tx.objectStore('meta');
    meta.put({id:'snapshotProof',value:{key,signature:response.signature}});
    meta.put({id:'snapshot',value:snapshot});done(undefined);
   };
  });
 } catch(error) {
  if(pendingWork)throw Error('Synchronize or reconcile saved work before replacing its authorized snapshot.');
  throw error;
 }
 if(auth.currentUser?.uid!==uid || document.visibilityState==='hidden') throw Error('Return to the signed-in till to prepare it.');
 establishAuthority(snapshot,started);
 // The current session may bill immediately even if the optional clock is unavailable.
 void bindDesktopClock(snapshot).catch(()=>false);
 void persistenceStatus(true);
 return snapshot;
}
export async function verifySnapshotForRead(snapshot:Snapshot) {
 const [device,proof]=await Promise.all([getMeta('device'),getMeta('snapshotProof')]);
 if (!device || !proof || !await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},proof.key,
   Uint8Array.from(atob(proof.signature),(ch:string)=>ch.charCodeAt(0)),new TextEncoder().encode(stable(snapshot))))
   throw Error('Cached authorization signature failed. Reconnect on the enrolled till.');
 if (!supportedOfflineSnapshot(snapshot) || !auth.currentUser || auth.currentUser.uid!==snapshot.uid || device.id!==snapshot.deviceId) {
   invalidateAuthority();
   throw Error('Only the previously authorized staff member may use this offline session.');
 }
}
export async function usable(snapshot:Snapshot) {
 assertCaptureEnabled();
 await verifySnapshotForRead(snapshot);
 const record=await transaction<any>(['meta'],'readonly',(tx,done)=>{
  const req=tx.objectStore('meta').get('snapshot');req.onsuccess=()=>done(req.result);
 });
 if(record?.value?.id!==snapshot.id || record.captureBlocked) throw Error('This session was replaced or withdrawn. Prepare online before recording Cash.');
 if(mayResumeAfterRestart()) await resumeOfflineSession(snapshot);
 return authorizedTime(snapshot);
}
export function totals(s:Snapshot,items:{productId:string;quantity:number}[],discount:number,table?:any){
 if(!Number.isFinite(discount)||discount<0||discount>s.discountLimit)throw Error(`Discount limit ${s.discountLimit}%`);
 let subtotal=0,taxTotal=0;const ratio=discount/100;
 if(table){const t=tableTotals(table.lines,discount) as unknown as {subtotal:number;discountAmount:number;taxTotal:number;grandTotal:number};return {subtotal:t.subtotal,discountAmount:t.discountAmount,taxTotal:t.taxTotal,grandTotal:t.grandTotal}}
 for(const i of items){const p=s.menu.find(p=>p.id===i.productId)?.canonical;if(!p||!Number.isInteger(i.quantity)||i.quantity<1||i.quantity>20)throw Error('Invalid cached item quantity');subtotal+=(p.baseUnitPrice+p.addOnTotal)*i.quantity}
 const discountAmount=subtotal*ratio,r=subtotal>0?discountAmount/subtotal:0;
 for(const i of items){const p=s.menu.find(p=>p.id===i.productId).canonical;const base=p.baseUnitPrice*i.quantity;taxTotal+=Math.max(0,base-base*r)*p.taxRate/100+(p.addOns||[]).reduce((n:number,a:any)=>n+Math.max(0,a.totalPrice*i.quantity*(1-r))*Math.max(0,a.taxRate)/100,0)}
 return {subtotal,discountAmount,taxTotal,grandTotal:Math.max(0,subtotal-discountAmount)+taxTotal};
}
async function printBinding(snapshot:Snapshot) {
 return snapshot.printStationId && await hasLocalPrintAuthority(snapshot).catch(()=>false)
   ? {printAuthority:'DESIGNATED_TILL',printStationId:snapshot.printStationId} : {};
}

async function appendTableEntry(snapshot:Snapshot, payload:any, captures:string[]) {
 const signed:Entry={id:payload.id,payload,signature:await sign(payload),status:'PENDING'};
 if(auth.currentUser?.uid!==snapshot.uid)throw Error('Staff identity changed. Nothing was saved.');
 authorizedTime(snapshot);
 await transaction(['entries','closures','meta'],'readwrite',(tx,done)=>{
   const check=tx.objectStore('meta').get('snapshot');
   check.onsuccess=()=>{
     if(check.result?.value?.id!==snapshot.id || check.result.captureBlocked || auth.currentUser?.uid!==snapshot.uid){tx.abort();return;}
     const store=tx.objectStore('closures');
     const ref=payload.table;
     const step='table-step:'+JSON.stringify([snapshot.storeId,ref.tableId,ref.id,ref.version]);
     for(const id of [step,...captures])store.add({id,offlineId:signed.id,version:ref.version});
     tx.objectStore('entries').add(signed);done(undefined);
   };
 });
 return signed;
}

export async function saveTableOperation(snapshot:Snapshot,
 command:{action:'OPEN'|'SEND'|'CASH';sessionId:string;tableId?:string;version?:number;opId:string;guestCount?:number|null;
   draft?:TableDraftLine[];discountPercent?:number;cashReceived?:number}) {
 const createdAt=await usable(snapshot);
 if(!hasTableAuthority(snapshot))throw Error('This till has no signed offline table assignment.');
 const existing=await entries();
 const board=projectTables(snapshot,existing)!;
 const session=board.sessions.get(command.sessionId);
 const slot=board.board.tables.find((t:any)=>t.tableId===(session?.tableId || command.tableId));
 if(!slot || slot.localConflict || session?.localConflict)throw Error('Table ownership is missing or needs reconciliation.');
 if(!command.opId || !command.sessionId)throw Error('An original table operation identifier is required.');
 const earlier=existing.find(e=>e.id===command.opId);
 if(earlier){
   if(earlier.payload.uid===snapshot.uid && earlier.payload.deviceId===snapshot.deviceId && earlier.payload.table?.id===command.sessionId &&
      earlier.payload.kind===(command.action==='OPEN'?'TABLE_OPEN':command.action==='SEND'?'TABLE_ROUND':'TABLE_CASH'))return earlier;
   throw Error('This operation identifier belongs to another bill.');
 }
 if(command.action==='OPEN'){
   if(!board.board.enableNewSessions || board.board.recoveryMode || session || slot.activeSessionId)throw Error('This table cannot be opened offline.');
   if(command.guestCount!=null && (!Number.isInteger(command.guestCount)||command.guestCount<1||command.guestCount>45)) throw Error('Guest count must be 1–45.');
 }else if(!session || slot.activeSessionId!==session.id || session.offlineEligible!==true || session.version!==command.version
    || session.paymentAttempt || session.closedAt || !['OCCUPIED','BILL_REQUESTED'].includes(session.status)){
   throw Error(session?.unavailableReason || 'This table version or payment cannot be changed offline.');
 }
 const predecessor=session?.predecessorId ? existing.find(e=>e.id===session.predecessorId):null;
 if(predecessor && predecessor.payload.snapshotId!==snapshot.id && predecessor.status!=='SYNCED')throw Error('Synchronize prior rounds from this table before using the refreshed menu.');
 const base={id:command.opId,uid:snapshot.uid,deviceId:snapshot.deviceId,storeId:snapshot.storeId,snapshotId:snapshot.id,
   snapshotDigest:await digest(snapshot),createdAt,predecessorId:predecessor?.id||null,table:{id:command.sessionId,
     orderId:session?.orderId||'TABLE_'+command.sessionId,tableId:slot.tableId,version:session?.version||0}};
 if(command.action==='OPEN')return appendTableEntry(snapshot,{...base,kind:'TABLE_OPEN',guestCount:command.guestCount??null,items:[],discountPercent:0},
   ['table-open:'+JSON.stringify([snapshot.storeId,slot.tableId,snapshot.id])]);
 if(command.action==='SEND'){
   if(board.board.recoveryMode || board.board.enabled===false)throw Error('New rounds are paused.');
   const lines=approvedRoundLines(snapshot,command.draft||[],command.opId);
   const money=totals(snapshot,[],0,{lines});
   return appendTableEntry(snapshot,{...base,kind:'TABLE_ROUND',roundId:command.opId,discountPercent:0,totals:money,
     items:lines.map(l=>({productId:l.parentProductId,quantity:l.quantity,orderItemId:l.id,selectedAddOns:[]})),
     roundLines:lines,...await printBinding(snapshot)},[]);
 }
 const discountPercent=Number(command.discountPercent), cashReceived=Number(command.cashReceived);
 const money=totals(snapshot,[],discountPercent,session);
 if(!session.orderId || !Number.isFinite(cashReceived) || money.grandTotal<=0 || cashReceived<money.grandTotal)throw Error('Cash received must cover the positive saved table total.');
 const items=session.lines.filter((l:any)=>!l.cancelled).map((l:any)=>({name:l.itemName,quantity:l.quantity,
   unitPrice:l.baseUnitPrice+(l.addOns||[]).reduce((n:number,a:any)=>n+Number(a.totalPrice||0),0)}));
 return appendTableEntry(snapshot,{...base,kind:'TABLE_CASH',paymentMethod:'CASH',items:[],discountPercent,cashReceived,totals:money,
   receipt:{storeName:snapshot.storeName,legal:session.legal||snapshot.legal,gst:session.gst||snapshot.gst,items},...await printBinding(snapshot)},
   [snapshot.storeId+':'+session.id]);
}

export async function saveCash(s:Snapshot,items:{productId:string;quantity:number}[],discountPercent:number,cashReceived:number,table?:any,draftLineIds?:string[]){
 if(table && hasTableAuthority(s))return saveTableOperation(s,{action:'CASH',sessionId:table.id,version:table.version,opId:crypto.randomUUID(),discountPercent,cashReceived});
 const capturedAt=await usable(s);if(!table&&(!items.length||items.length>30))throw Error('Add 1–30 items');const money=totals(s,items,discountPercent,table);if(money.grandTotal<=0)throw Error('Zero-payable / complimentary bills require the online verified complimentary workflow.');if(!Number.isFinite(cashReceived)||cashReceived<money.grandTotal-0.000001)throw Error('Cash received must cover the total');
 if(draftLineIds&&(table||draftLineIds.length<items.length||new Set(draftLineIds).size!==draftLineIds.length||draftLineIds.some(id=>!id)))throw Error('The draft identity could not be verified.');
 const payload={...await printBinding(s),id:crypto.randomUUID(),uid:s.uid,deviceId:s.deviceId,storeId:s.storeId,snapshotId:s.id,snapshotDigest:await digest(s),createdAt:capturedAt,paymentMethod:'CASH',items:table?[]:items,discountPercent,cashReceived,totals:money,table:table?{id:table.id,version:table.version,orderId:table.orderId,tableId:table.tableId}:null,receipt:{storeName:s.storeName,legal:table?.legal||s.legal,gst:table?.gst||s.gst,items:table?table.lines.map((l:any)=>({name:l.itemName,quantity:l.quantity,unitPrice:l.baseUnitPrice??l.unitPrice})):items.map(i=>{const p=s.menu.find(p=>p.id===i.productId);return {name:p.name,quantity:i.quantity,unitPrice:p.canonical.baseUnitPrice+p.canonical.addOnTotal}})}};
 const entry:Entry={id:payload.id,payload,signature:await sign(payload),status:'PENDING'};
 // Bind the local draft to the signed entry before its basket can be cleared.
 // The local references are never sent as part of the signed payload.
 if(auth.currentUser?.uid!==s.uid)throw Error('The signed-in staff member changed.');
 authorizedTime(s);
 await transaction(['entries','closures','meta'],'readwrite',(tx,done)=>{
  const current=tx.objectStore('meta').get('snapshot');
  current.onsuccess=()=>{
   if(current.result?.value?.id!==s.id||current.result.captureBlocked||auth.currentUser?.uid!==s.uid){tx.abort();return;}
   const captures=tx.objectStore('closures');
   if(table)captures.add({id:s.storeId+':'+table.id,offlineId:entry.id,version:table.version});
   for(const lineId of draftLineIds??[])captures.add({id:draftCaptureKey(s.storeId,lineId),offlineId:entry.id});
   tx.objectStore('entries').add(entry);done(undefined);
  };
 });return entry;
}
async function state(id:string,patch:Partial<Entry>){return transaction(['entries'],'readwrite',(tx,done)=>{const st=tx.objectStore('entries'),q=st.get(id);q.onsuccess=()=>{if(!q.result){tx.abort();return}st.put({...q.result,...patch,id,payload:q.result.payload,signature:q.result.signature});done(undefined)}})}
function terminalResult(reply:any):Partial<Entry> {
 if(reply?.status!=='SYNCED' && reply?.status!=='CONFLICT')throw Error('The server has not confirmed the original operation. Check its status again.');
 return {status:reply.status,result:reply.result,conflicts:reply.conflicts,error:undefined,pendingReason:undefined,...(reply.status==='SYNCED'?{syncedAt:Date.now()}:{})};
}

let syncing=false;
export async function synchronize(onChange:()=>void=()=>{},storeScope?:string){
 if(syncing||!navigator.onLine||!auth.currentUser)return;syncing=true;
 try{
  const rows=await entries();
  rows.sort((a,b)=>a.payload.createdAt-b.payload.createdAt || (a.payload.table?.version||0)-(b.payload.table?.version||0));
  const completed=new Set(rows.filter(e=>e.status==='SYNCED').map(e=>e.id));
  for(const e of rows){
  if(e.status==='SYNCED'||e.status==='CONFLICT'||e.payload.uid!==auth.currentUser?.uid || (storeScope && e.payload.storeId!==storeScope))continue;
  if(isTableStep(e) && e.payload.predecessorId && !completed.has(e.payload.predecessorId))continue;
  try{
   // Always query original ID first, even after a crash between send and response.
   const status=await call('STATUS',e.payload.storeId,{payload:e.payload,signature:e.signature});
   const waiting={status:'PENDING' as const,pendingReason:'Waiting for the original earlier operation to synchronize.',error:undefined};
   if(status?.status==='DEPENDENCY_PENDING'){await state(e.id,waiting);onChange();continue;}
   if(status?.status==='SYNCED'||status?.status==='CONFLICT'){await state(e.id,terminalResult(status));if(status.status==='SYNCED')completed.add(e.id);onChange();continue}
   if(status?.status!=='NOT_FOUND')throw Error('Original transaction status is unresolved');
   await state(e.id,{status:'UNCERTAIN',error:undefined,pendingReason:undefined});onChange();
   const result=await call('SYNC',e.payload.storeId,{payload:e.payload,signature:e.signature});
   if(result?.status==='DEPENDENCY_PENDING'){await state(e.id,waiting);}
   else {await state(e.id,terminalResult(result));if(result.status==='SYNCED')completed.add(e.id);}
  }catch(error:any){await state(e.id,{error:error.message});}onChange();
 }}finally{syncing=false}
}
export async function reconcile(e:Entry,reason:string){const result=await call('RECONCILE',e.payload.storeId,{payload:e.payload,signature:e.signature,reason});await state(e.id,terminalResult(result));return result}
