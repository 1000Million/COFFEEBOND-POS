import {useUpdateBlocker} from '../useUpdateBlocker';
import {requireOnlineAction,beginCriticalOperation} from '../connectivity';
import {useCallback,useEffect,useRef,useState} from 'react';
import {useSearchParams} from 'react-router-dom';
import {collection,doc,getDocFromServer,onSnapshot,query,where} from 'firebase/firestore';
import {db} from '../firebase';
import {TABLE_STORE,isLegacyTableStore,validPosStoreId,tableStoreName,tableCall,tableError} from './api';
import {draftKey,readTableDraft,writeLocalDraft,draftStatus,type TableDraft,type TableDraftLine} from './drafts';
import {cashCaptureForTable,saveTableOperation} from '../offline/journal';
import type {usePosOfflineCash} from '../offline/usePosOfflineCash';
import {printSavedEntry} from '../offline/localPrint';
import {CHECKOUT_ATTEMPT_STORAGE_KEY,withCheckoutMarkerLock} from '../pos/checkoutLock';
const isComplimentaryRecovery=(value:any)=>value?.action==='COMPLIMENTARY_CLOSE'||value?.invalidReference===true;
const referenceId=(value:any)=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(value);
export type TableContext = {storeId:string;sessionId:string|null;tableNo:string;version:number|null;paymentLock:boolean};
export function useTableOrder(uid:string,storeId:string,orderType:string,externalLocked=false,operationalBlocked=false,online=true,localCashCaptured=false,offlineCash?:ReturnType<typeof usePosOfflineCash>) {
 const [params,setParams]=useSearchParams();const sessionId=params.get('tableSession')||'';const tableId=params.get('table')||'';
 const routeStore=params.get('tableStore')||TABLE_STORE;
 const tableStoreScope=JSON.stringify([uid,storeId]);
 const [config,setConfig]=useState<{scope:string;enabled:boolean}|null>(null);
 const legacy=isLegacyTableStore(storeId);
 useEffect(()=>{
   if(!uid || !validPosStoreId(storeId) || !online || legacy || orderType!=='DINE_IN')return;
   let active=true;
   void getDocFromServer(doc(db,'tableServiceConfig',storeId)).then(snap=>{
     if(active)setConfig({scope:tableStoreScope,enabled:snap.exists() && (snap.data().enabled===true || snap.data().recoveryMode===true)});
   }).catch(()=>{if(active)setConfig(null);});
   return()=>{active=false;};
 },[tableStoreScope,online,legacy,orderType]);
 const signedBoard=offlineCash?.snapshot?.storeId===storeId && offlineCash?.tableRepository?.board;
 const supported=legacy || (online && config?.scope===tableStoreScope ? config.enabled : (signedBoard?.enabled===true || signedBoard?.recoveryMode===true));
 const enabled=!!uid&&validPosStoreId(storeId)&&supported&&orderType==='DINE_IN'&&(!(sessionId||tableId)||routeStore===storeId);
 const [readTimedOut,setReadTimedOut]=useState(false);
 const call=useCallback((data:any)=>{if(data.storeId&&data.storeId!==storeId)throw Object.assign(new Error('The original operation belongs to another store. Its reference is retained; return to that store to reconcile it.'),{code:'functions/permission-denied'});return tableCall({storeId,...data});},[storeId]);
 const active=enabled&&!!(sessionId||tableId);const scope=enabled?`${uid}:${storeId}:${sessionId}:${tableId}`:'';
 const scopeRef=useRef(scope);scopeRef.current=scope;const generation=useRef(0);const inFlight=useRef(false);
 const onlineRef=useRef(online);onlineRef.current=online;
 const wasOnline=useRef(online);
 const wasBlocked=useRef(operationalBlocked);
 const [serverVerified,setServerVerified]=useState(false);
 const originalClose=useRef<any>(null);const [retryReady,setRetryReady]=useState(false);
 const [board,setBoard]=useState<any>(null),[session,setSession]=useState<any>(null);
 const [draftLoadedKey,setDraftLoadedKey]=useState('');
 const [draft,setDraft]=useState<TableDraft>({id:'',items:[]});const draftRef=useRef(draft);
 const [pending,setPending]=useState<any>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [storageWarning,setStorageWarning]=useState(false),[leave,setLeave]=useState<null|{label:string;run:()=>void}>(null);
 // A local reminder is never persisted or included in a server command.
 const reminders=useRef(new Map<string,string>());const [note,setNoteValue]=useState('');
 const cacheKey='coffee-bond-table-command:'+uid;const key=draftKey(uid,storeId,sessionId||'unopened');
 const remember=(value:any)=>{setPending(value);try{if(value)localStorage.setItem(cacheKey,JSON.stringify(value));else localStorage.removeItem(cacheKey)}catch{setStorageWarning(true)}};
 const storeDraft=(value:TableDraft,target=key)=>{if(!writeLocalDraft(target,value))setStorageWarning(true);if(target===key){draftRef.current=value;setDraft(value);setDraftLoadedKey(target)}};
 const load=useCallback(async()=>{
  if(!enabled||!onlineRef.current||scopeRef.current!==scope)return;const current=++generation.current;setServerVerified(false);
  setReadTimedOut(false);
  let timer:number|undefined;
  try{const [b,s]=await Promise.race([Promise.all([call({action:'BOARD'}),sessionId?call({action:'DETAIL',sessionId}):Promise.resolve(null)]),
    new Promise<never>((_,reject)=>{timer=window.setTimeout(()=>reject(Error('Table service did not respond.')),8500)})]);
   if(current!==generation.current||scopeRef.current!==scope)return;if(b.storeId!==storeId||(s&&s.storeId!==storeId))throw Error('The table response belongs to another store. Nothing was sent.');setBoard(b);setSession(s);setServerVerified(true);
   // A replay may already be committed. Never keep its line references as a fresh draft.
   if(s){const saved=readTableDraft(draftKey(uid,storeId,sessionId));const sent=new Set(s.lines.map((l:any)=>l.id));const items=saved.items.filter(l=>!sent.has(l.orderItemId));if(items.length!==saved.items.length){const next={id:crypto.randomUUID(),items};writeLocalDraft(draftKey(uid,storeId,sessionId),next);draftRef.current=next;setDraft(next)}}
  }catch(e){if(current===generation.current&&scopeRef.current===scope&&onlineRef.current){setReadTimedOut(true);setError(tableError(e));}}finally{window.clearTimeout(timer)}
 },[enabled,scope,sessionId,uid,storeId,call]);
 useEffect(()=>{setBoard(null);setSession(null);setError('');setNotice('');setNoteValue(reminders.current.get(key)||'');const d=readTableDraft(key);setStorageWarning(draftStatus(key)!=='saved');draftRef.current=d;setDraft(d);setDraftLoadedKey(key);if(enabled)void load();return()=>{generation.current++}},[key,enabled,load]);
 useEffect(()=>{
  const changed=wasOnline.current!==online;wasOnline.current=online;
  const revalidated=wasBlocked.current&&!operationalBlocked;wasBlocked.current=operationalBlocked;
  if(!online){generation.current++;setServerVerified(false)}
  else if(enabled&&(changed||revalidated))void load();
 },[online,operationalBlocked,enabled,load]);
 useEffect(()=>{
  const refresh=(event?:StorageEvent)=>{
   if(event&&event.key!==cacheKey&&event.key!==null)return;
   try{
    const saved=JSON.parse(localStorage.getItem(cacheKey)||'null');
    setPending(!saved?null:isComplimentaryRecovery(saved)||typeof saved.opId==='string'
      ?{...saved,storeId:saved.storeId??TABLE_STORE}:{invalidReference:true,reconcileOnly:true});
   }catch{setStorageWarning(true);setPending({invalidReference:true,reconcileOnly:true})}
  };
  refresh();
  window.addEventListener('storage',refresh);
  return()=>window.removeEventListener('storage',refresh);
 },[cacheKey]);
 useEffect(()=>{
  if(!online||!enabled||!sessionId)return;
  return onSnapshot(query(collection(db,'kotItems'),where('storeId','==',storeId),where('tableSessionId','==',sessionId)),snapshot=>{if(scopeRef.current!==scope)return;const kitchen=snapshot.docs.map(d=>{const k=d.data();return {id:d.id,lineId:k.orderItemId,status:k.status,station:k.station,quantity:k.quantity}});setSession((s:any)=>s?.id===sessionId&&s.storeId===storeId?{...s,kitchen,kitchenUnavailable:false}:s)},()=>{if(scopeRef.current===scope)setSession((s:any)=>s?.id===sessionId&&s.storeId===storeId?{...s,kitchen:[],kitchenUnavailable:true}:s)});
 },[online,enabled,sessionId,storeId,scope]);
 const syncedTableIds=offlineCash?.entries.filter(e=>e.status==='SYNCED'&&e.payload.table?.id===sessionId).map(e=>e.id).sort().join(',') || '';
 const previousSynced=useRef(syncedTableIds);
 useEffect(()=>{
   if(previousSynced.current!==syncedTableIds && enabled && online && syncedTableIds)void load();
   previousSynced.current=syncedTableIds;
 },[syncedTableIds,enabled,online,load]);
 const local=enabled?offlineCash?.tableRepository:null;
 const localSession=local?.sessions.get(sessionId);
 const localSlot=local?.board.tables.find((t:any)=>t.tableId===(localSession?.tableId||tableId));
 const serverBoard=enabled&&board?.storeId===storeId?board:null;
 const serverSession=enabled&&session?.id===sessionId&&session.storeId===storeId?session:null;
 const localPending=!!(localSession?.localPending||localSlot?.localConflict||localSession?.localConflict);
 const currentSession=online && !localPending ? (serverSession || localSession || null) : (localSession || serverSession || null);
 const currentBoard=local && (!online||!serverBoard) ? local.board : serverBoard && local
   ? {...serverBoard,tables:serverBoard.tables.map((t:any)=>{const overlay=local.board.tables.find((v:any)=>v.tableId===t.tableId);
       return overlay?.session?.localPending||overlay?.localConflict?overlay:t})} : serverBoard;
 const serverSlot=serverBoard?.tables.find((t:any)=>t.tableId===(localSession?.tableId||tableId));
 const baseSession=offlineCash?.snapshot?.tableSessions?.find((v:any)=>v.id===sessionId);
 const baseSlot=offlineCash?.snapshot?.tableBoard?.tables?.find((v:any)=>v.tableId===(localSession?.tableId||tableId));
 const newerServerState=!!serverSlot && ((serverSlot.session?.id || null)!==(baseSlot?.activeSessionId || null)
   || (serverSlot.session && baseSession && serverSlot.session.version>baseSession.version)
   || (serverSession?.paymentAttempt && !baseSession?.paymentAttempt));
 const localEligible=Boolean(!online && offlineCash?.tableReady && !newerServerState && !localSlot?.localConflict
    && !localSession?.localConflict && (localSession ? localSession.offlineEligible===true : localSlot && !localSlot.activeSessionId));
 const locked=!!currentSession?.paymentAttempt||currentSession?.status==='PAID_AWAITING_CLEAR'||!!currentSession?.closedAt;
 const pendingLocalCash=localCashCaptured&&!locked;
 const ready=online ? serverVerified&&!operationalBlocked&&!localPending : localEligible;
 const canEdit=active&&!!currentSession&&ready&&!externalLocked&&!locked&&!pendingLocalCash&&!busy&&!pending&&!currentBoard?.recoveryMode;
 const setItems=(items:TableDraftLine[])=>{if(canEdit)storeDraft({...draftRef.current,id:draftRef.current.id||crypto.randomUUID(),items})};
 const setNote=(value:string)=>{if(canEdit){reminders.current.set(key,value);setNoteValue(value)}};
 const addItem=(item:any,options:any[])=>{
  if(!canEdit){setError(session?'New items are locked. Check the table or reconcile the pending operation.':'Open an available table or select an occupied table first.');return;}
  if(!item.tableProductId){setError('This catalogue item has no verified product reference. Ask a manager to check its setup.');return;}
  setItems([...draftRef.current.items,{orderItemId:crypto.randomUUID(),parentProductId:item.tableProductId,parentProductCode:item.code,quantity:1,selectedAddOns:options.map(a=>({groupId:a.groupId,optionId:a.optionId,quantity:a.quantity})),label:item.name,optionsLabel:options.map(a=>a.optionName).join(', '),price:Number(item.price)}]);
 };
 const requestLeave=(run:()=>void)=>{if(busy||pending){setError('Reconcile the previous operation before changing tables or service.');return;}if(draftRef.current.items.length||note.trim())setLeave({label:session?.tableLabel||'this table',run});else run()};
 const select=(t:any)=>requestLeave(()=>setParams(t?.session?{tableStore:storeId,tableSession:t.session.id}:t?{tableStore:storeId,table:t.tableId}:{tableStore:storeId}));
 useUpdateBlocker(!!draft.items.length||!!note.trim()||!!pending||busy||locked||externalLocked||operationalBlocked);
 const confirmComplimentary=async(reference:any,result:any)=>{
  if(result.sessionId!==reference.sessionId||result.status!=='CLOSED')throw Error('Original close not confirmed.');
  const detail=await call({action:'DETAIL',sessionId:reference.sessionId});
  if(detail.storeId!==storeId||detail.id!==reference.sessionId||detail.orderId!==reference.orderId||detail.status!=='CLOSED'||!detail.closedAt||detail.saved?.order.commercialStatus!=='COMPLIMENTARY'||detail.saved?.order.paymentStatus!=='NOT_REQUIRED')throw Error('Original bill outcome needs reconciliation.');
 };
 const execute=async(input:any)=>{
  const command={...input,storeId:input?.storeId??storeId};
  if(command.storeId!==storeId||!enabled){setError('The original operation belongs to another store. Its reference is retained; return to that store to reconcile it.');return;}
  if(command?.action==='COMPLIMENTARY_CLOSE'&&(!referenceId(command.authorizationId)||!command.customerName||!command.customerPhone||!command.reason||command.reconcileOnly)){setError('Use Reconcile previous operation to check the original close. Nothing was resent.');return;}

  if(!onlineRef.current){
    if(!['OPEN','SEND'].includes(command.action)){setError('This table action requires a connection. The local bill is kept.');return;}
    if(!localEligible||!offlineCash?.snapshot||externalLocked||pending||busy||inFlight.current||locked||pendingLocalCash){setError('This table is unavailable for offline changes. Review the current session and journal.');return;}
    if(command.action==='SEND' && note.trim()){setError('This till cannot send a note to the kitchen offline. Keep it for online service or clear the local note before saving this round.');return;}
    const originalScope=scope, snapshot=offlineCash.snapshot;
    inFlight.current=true;setBusy(true);setError('');const finish=beginCriticalOperation();
    try{
      const entry=await withCheckoutMarkerLock(async()=>{
        if(scopeRef.current!==originalScope||onlineRef.current||localStorage.getItem(cacheKey)
           ||localStorage.getItem('coffeeBondPos:pendingRazorpaySession:v1')||localStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY))
          throw Error('The checkout context changed. Review the original bill.');
        return saveTableOperation(snapshot,{action:command.action,opId:command.opId,sessionId:command.sessionId,
          tableId:command.tableId,version:command.version,guestCount:command.guestCount,draft:draftRef.current.items});
      });
      if(command.action==='SEND'){
        const target=draftKey(uid,storeId,command.sessionId),sent=new Set(entry.payload.items.map((l:any)=>l.orderItemId));
        const next={id:crypto.randomUUID(),items:readTableDraft(target).items.filter(l=>!sent.has(l.orderItemId))};
        if(!writeLocalDraft(target,next))setStorageWarning(true);
        if(scopeRef.current===originalScope)storeDraft(next,target);
      }
      const printing=command.action==='SEND'?printSavedEntry(entry):null;
      await offlineCash.refresh();
      const printed=await printing;
      if(scopeRef.current===originalScope){
        if(command.action==='OPEN')setParams({tableStore:storeId,tableSession:entry.payload.table.id});
        else if(printed) setNotice('Round saved on this till · pending sync. '+printed.message);
      }
      return {local:true,sessionId:entry.payload.table.id};
    }catch(e){setError(e instanceof Error?e.message:'Local save failed. Keep the draft and retry.');}
    finally{inFlight.current=false;setBusy(false);finish();}
    return;
  }
  if(localPending){setError('This table has local changes awaiting synchronization or reconciliation.');return;}
  if(!requireOnlineAction())return;
  if(operationalBlocked||!serverVerified){setError('Reconnect checks are incomplete. Review the current table and menu before submitting. Nothing was sent.');return;} 
  if(externalLocked){setError('Reconcile the counter checkout before changing this table.');return;}
  if(inFlight.current)return;inFlight.current=true;const endCritical=beginCriticalOperation();setBusy(true);setError('');setNotice('');
  // Complimentary customer details/verification stay in memory. Only the
  // original operation identity is durable, for a read-only status lookup.
  const safePending=command.action==='COMPLIMENTARY_CLOSE'?{action:command.action,opId:command.opId,sessionId:command.sessionId,orderId:session?.id===command.sessionId?session.orderId:null,storeId,staffUid:uid,version:command.version,reconcileOnly:true}:command;
  const operationScope=scope;
  const coordinated=Boolean(command.sessionId);
  const serialized=JSON.stringify(safePending);
  const clearSubmitted=async()=>{
   if(!coordinated){remember(null);return;}
   await withCheckoutMarkerLock(()=>{
    const current=localStorage.getItem(cacheKey);
    if(current===serialized){localStorage.removeItem(cacheKey);setPending(null);}
    else {
     try{setPending(current?JSON.parse(current):null)}
     catch{setPending({invalidReference:true,reconcileOnly:true})}
    }
   });
  };
  let submitted=false;
  try{
   if(coordinated){
    await withCheckoutMarkerLock(async()=>{
     const capture=await cashCaptureForTable(storeId,command.sessionId);
     const confirmedCashClear=command.action==='CLEAR'&&session?.status==='PAID_AWAITING_CLEAR'
       &&(session.offlineId===capture||session.saved?.order.offlineId===capture);
     if(capture&&!confirmedCashClear)throw Error('Cash was already saved for this table. Check its original bill in the Cash journal.');
     const stored=JSON.parse(localStorage.getItem(cacheKey)||'null');
     if(stored&&stored.opId!==safePending.opId)throw Error('A table operation is already protected on this device. Check its original reference.');
     if(scopeRef.current!==operationScope||!onlineRef.current)throw Error('The table or connection changed. Nothing was submitted.');
     localStorage.setItem(cacheKey,serialized);
     setPending(safePending);
    });
   }else remember(safePending);
   submitted=true;
   const result=await call(command);
   if(command.action==='SEND'){const target=draftKey(uid,storeId,command.sessionId);const d=readTableDraft(target);const ids=new Set(command.items.map((l:any)=>l.orderItemId));const next={id:crypto.randomUUID(),items:d.items.filter(l=>!ids.has(l.orderItemId))};writeLocalDraft(target,next);if(scopeRef.current===operationScope)storeDraft(next,target)}
   if(scopeRef.current!==operationScope)return result;if(command.action==='COMPLIMENTARY_CLOSE'){await confirmComplimentary(safePending,result);if(scopeRef.current!==operationScope)return result;originalClose.current=null;setRetryReady(false)}await clearSubmitted();setNotice(command.action==='SEND'?'Sent · server confirmed':command.action==='COMPLIMENTARY_CLOSE'?'Complimentary closed · server confirmed':'Saved · server confirmed');
   if(command.action==='OPEN')setParams({tableStore:storeId,tableSession:result.sessionId});else await load();return result;
  }catch(e){if(scopeRef.current===operationScope){setError(!submitted&&e instanceof Error?e.message:tableError(e));if(submitted&&command.action!=='COMPLIMENTARY_CLOSE'&&['functions/aborted','functions/permission-denied','functions/invalid-argument','functions/failed-precondition','functions/already-exists','functions/not-found'].includes((e as any).code)){await clearSubmitted();if((e as any).code==='functions/aborted'){await load();setNotice('Table updated from the server. Your unsent items are kept; review before sending again.')}}}}
  finally{setBusy(false);inFlight.current=false;endCritical()}
 };
 const reconcile=async()=>{
  if(!pending)return;
  const pendingStore=pending.storeId??TABLE_STORE;
  if(pendingStore!==storeId){setError('The original operation belongs to another store. Its reference is retained; return to that store to reconcile it.');return;}
  if(!isComplimentaryRecovery(pending))return execute({...pending,storeId:pendingStore});
  if(busy||inFlight.current||!onlineRef.current||!requireOnlineAction())return;
  if(!referenceId(pending.opId)||!referenceId(pending.sessionId)||!Number.isInteger(pending.version)||pending.version<1){setError('The original close reference is missing or unreadable. Keep this page and ask a manager for support. Do not start another close.');return;}
  if((pending.storeId&&pending.storeId!==storeId)||(pending.staffUid&&pending.staffUid!==uid)){setError('The original close belongs to another store or staff account. Sign in with the original authorised account; nothing was resent.');return;}
  setBusy(true);inFlight.current=true;const endCritical=beginCriticalOperation(),operationScope=scope;
  try{
   // Read the actual bill first. Older metadata may be completed only from
   // this server relationship; never derive a bill ID from a naming pattern.
   const detail=await call({action:'DETAIL',sessionId:pending.sessionId});
   if(scopeRef.current!==operationScope)return;
   if(detail.id!==pending.sessionId||detail.storeId!==storeId||!referenceId(detail.orderId)||(pending.orderId&&pending.orderId!==detail.orderId))throw Error('Original bill identity cannot be established.');
   const reference={action:'COMPLIMENTARY_CLOSE',opId:pending.opId,sessionId:pending.sessionId,orderId:detail.orderId,storeId,staffUid:uid,version:pending.version,reconcileOnly:true};
   const updateReference=async(clear:boolean)=>{
    await withCheckoutMarkerLock(()=>{
     const stored=JSON.parse(localStorage.getItem(cacheKey)||'null');
     if(stored?.opId!==reference.opId||stored?.sessionId!==reference.sessionId||stored?.storeId!==storeId
       ||(stored?.staffUid&&stored.staffUid!==uid)||stored?.version!==reference.version||stored?.action!==reference.action
       ||(stored.orderId&&stored.orderId!==reference.orderId))throw Error('The original table operation changed.');
     if(clear)localStorage.removeItem(cacheKey);
     else localStorage.setItem(cacheKey,JSON.stringify(reference));
     setPending(clear?null:reference);
    });
   };
   await updateReference(false);
   const result=await call({action:'OPERATION_STATUS',opId:reference.opId,sessionId:reference.sessionId});
   if(scopeRef.current!==operationScope)return;
   if(result.committed){await confirmComplimentary(reference,result);if(scopeRef.current!==operationScope)return;await updateReference(true);originalClose.current=null;setRetryReady(false);if(sessionId!==reference.sessionId)setParams({tableStore:storeId,tableSession:reference.sessionId});else await load();setError('');setNotice('Original complimentary close confirmed · no operation was resent.');}
   else {setRetryReady(detail.version===reference.version&&!detail.closedAt&&!detail.paymentAttempt&&['OCCUPIED','BILL_REQUESTED'].includes(detail.status)&&detail.saved?.order.paymentStatus==='UNPAID');setError('The original close is not confirmed. Its reference is retained and this operation stays locked. Ask a manager to reconcile before any retry; nothing was resent.');await load();return 'UNCONFIRMED';}
  }catch{if(scopeRef.current===operationScope)setError('The original close could not be confirmed. Its reference is retained. Ask a manager to reconcile the original operation; do not start another close.');}
  finally{inFlight.current=false;setBusy(false);endCritical();}
 };
 const canRetryComplimentary=!!retryReady&&!!pending&&(pending.storeId??TABLE_STORE)===storeId&&originalClose.current?.command.opId===pending.opId&&originalClose.current.expiresAt>Date.now();
 const retryOriginalClose=async(confirmed:boolean)=>{
  if(confirmed!==true||!canRetryComplimentary||busy)return;
  const original=originalClose.current;
  if(await reconcile()!=='UNCONFIRMED')return;
  if(originalClose.current!==original||original.expiresAt<=Date.now()){setError('The original phone verification is no longer available. Keep its reference and ask a manager to reconcile; no new close was created.');return;}
  setRetryReady(false);return execute(original.command);
 };
 const command=(action:string,extra:any={},verificationExpiresAt?:string)=>{if(pending||busy){setError('Reconcile the previous operation first.');return;}const request={storeId,action,opId:action==='SEND'?draftRef.current.id:crypto.randomUUID(),sessionId,version:currentSession?.version,...extra};if(action==='COMPLIMENTARY_CLOSE')originalClose.current={command:request,expiresAt:Date.parse(verificationExpiresAt||'')};return execute(request)};
 const send=()=>{if(canEdit&&draftRef.current.items.length)return command('SEND',{items:draftRef.current.items.map(({label,optionsLabel,price,...line})=>line)})};
 useEffect(()=>{const warn=(e:BeforeUnloadEvent)=>{if(draft.items.length||pending||note.trim()){e.preventDefault();e.returnValue=''}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn)},[draft.items.length,pending,note]);
 const selected=currentBoard?.tables.find((t:any)=>t.tableId===tableId||t.session?.id===sessionId);
 const context:TableContext|null=active?{storeId,sessionId:sessionId||null,tableNo:currentSession?.tableLabel||selected?.label||tableId,version:currentSession?.version??null,paymentLock:locked}:null;
 return {storeId,complimentarySupported:legacy,storeName:(offlineCash?.snapshot?.storeId===storeId && offlineCash.snapshot.storeName) || tableStoreName(storeId),active,enabled,externalLocked,offline:!online,localPending,boardUnavailable:!currentBoard&&(!enabled||!online||readTimedOut),
   offlineReason:newerServerState?'The online table changed after preparation. Reconnect to refresh its snapshot.':localSession?.unavailableReason||offlineCash?.unavailableReason,operationalReady:ready,context,board:currentBoard,session:currentSession,draft:draftLoadedKey===key?draft.items:[],pending,busy,error,notice,storageWarning,leave,setLeave,requestLeave,select,selected,locked,pendingLocalCash,canEdit,addItem,setItems,note:draftLoadedKey===key?note:'',setNote,load,execute,reconcile,canRetryComplimentary,retryOriginalClose,command,send,sessionId,setError};
}
export type TableOrder = ReturnType<typeof useTableOrder>;
