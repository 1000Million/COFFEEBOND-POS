import {useEffect,useState} from 'react';
import {listLockedDrafts} from '../lib/tables/drafts';
import {entries,type Entry} from '../lib/offline/journal';
import PosOfflineStatus from './pos/PosOfflineStatus';
export default function OfflineDraftRecovery({uid,reason}:{uid:string;reason?:string}){
 const [state]=useState(()=>{try{return {records:listLockedDrafts(uid),error:false}}catch{return {records:[],error:true}}});
 const [cashEntries,setCashEntries]=useState<Entry[]>([]);
 const [cashError,setCashError]=useState('');
 useEffect(()=>{
  let active=true;
  void entries().then(list=>{if(active)setCashEntries(list.filter(entry=>entry.payload.uid===uid));})
    .catch(()=>{if(active)setCashError('The Cash journal could not be read on this device.');});
  return()=>{active=false};
 },[uid]);
 return <main className="p-6" aria-label="Locked offline draft recovery"><h1>Offline · drafts locked</h1><p>Connect to verify your account, store, table and current menu before restoring or sending. Nothing will send automatically.</p>{state.error?<p role="alert">Browser storage is unavailable. Saved drafts cannot be verified on this device.</p>:state.records.length?<ul>{state.records.map(r=><li key={r.scope}>{r.scope} · {r.count} saved item units · references only</li>)}</ul>:<p>No readable item drafts for this account. Corrupt records are not restored.</p>}
 <p>Orders, payments, KOT, stock changes and table actions are unavailable offline.</p>
 <PosOfflineStatus online={false} cashAvailable={false} pendingCheckout={false} entries={cashEntries} syncing={false} onSync={()=>{}} notice={cashError} reason={reason}/>
 </main>
}
