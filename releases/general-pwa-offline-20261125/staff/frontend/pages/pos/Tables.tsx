import {useEffect,useState} from 'react';
import {Link,Navigate,useParams,useSearchParams} from 'react-router-dom';
import {useAuth} from '../../contexts/AuthContext';
import {TABLE_STORE,validPosStoreId,tableStoreName} from '../../lib/tables/api';
import {useTableOrder} from '../../lib/tables/useTableOrder';
import {usePosOnline} from '../../lib/pos/usePosOnline';
import {usePosOfflineCash} from '../../lib/offline/usePosOfflineCash';
import {getMeta,verifySnapshotForRead} from '../../lib/offline/journal';
import KitchenBadges from '../../components/tables/KitchenBadges';
import './Tables.css';
export function TableSessionRoute(){const {sessionId}=useParams();const [params]=useSearchParams();return <Navigate replace to={'/pos?tableStore='+encodeURIComponent(params.get('tableStore')||TABLE_STORE)+'&tableSession='+encodeURIComponent(sessionId||'')}/>}
export default function Tables(){const [params]=useSearchParams();const session=params.get('session'),storeId=params.get('tableStore')||TABLE_STORE;return !validPosStoreId(storeId)?<Navigate replace to="/pos"/>:session?<Navigate replace to={'/pos?tableStore='+encodeURIComponent(storeId)+'&tableSession='+encodeURIComponent(session)}/>:<TableBoard key={storeId} storeId={storeId}/>}
function TableBoard({storeId}:{storeId:string}){
 const {staffProfile}=useAuth();const online=usePosOnline();
 const [verifiedKey,setVerifiedKey]=useState('');
 const ownerKey=JSON.stringify([staffProfile?.uid || '',storeId]);
 useEffect(()=>{let active=true;void getMeta('snapshot').then(async snap=>{
   if(snap?.storeId!==storeId||snap.uid!==staffProfile?.uid)return;
   await verifySnapshotForRead(snap);if(active)setVerifiedKey(ownerKey);
 }).catch(()=>{});return()=>{active=false;};},[ownerKey]);
 const offlineCash=usePosOfflineCash({staffProfile,online,store:verifiedKey===ownerKey?{id:storeId,isActive:true}:null});
 const table=useTableOrder(staffProfile?.uid||'',storeId,'DINE_IN',false,!online,online,false,offlineCash);const [capacity,setCapacity]=useState(''),[target,setTarget]=useState('');
 const storeQuery='tableStore='+encodeURIComponent(storeId);
 const manager=['ADMIN','STORE_MANAGER'].includes(staffProfile?.role||'');
 return <section className="table-pilot" aria-label={`${tableStoreName(storeId)} tables`}><header className="table-heading"><div><p className="table-eyebrow">{tableStoreName(storeId)} · running-table pilot</p><h1>Table overview</h1><p>Choose a table to continue in the normal POS.</p></div><div className="table-actions"><Link to={'/pos?'+storeQuery}>Counter POS</Link><button onClick={()=>void table.load()} disabled={table.busy}>Refresh tables</button></div></header>
 {table.error&&<p role="alert" className="table-warning">{table.error}</p>}
 {table.pending&&<p role="status" className="table-warning">An operation needs reconciliation. <Link to={'/pos?tableStore='+encodeURIComponent(table.pending.storeId||TABLE_STORE)+'&tableSession='+encodeURIComponent(table.pending.sessionId)}>Review original table</Link></p>}
 {table.board?.recoveryMode&&<p className="table-warning">Recovery mode · new tables and rounds are paused. Existing bills remain available.</p>}
 {!table.board&&!table.error&&<p role="status">{table.boardUnavailable?'A complete saved table list is unavailable. Reconnect to refresh.':'Loading tables…'}</p>}
 {table.board&&<><div className="table-summary"><strong>Outstanding ₹{table.board.tables.reduce((n:number,t:any)=>n+Number(t.session?.outstanding||0),0).toFixed(2)}</strong><span>Unpaid table amounts · separate from collected money</span></div>{!table.board.tables.length&&<p role="status">No tables configured for this store. New tables are unavailable.</p>}<div className="table-board">{table.board.tables.map((t:any)=><article className="table-card" key={t.id}><h2>{t.label}</h2><p>{t.localConflict?'Needs reconciliation':t.session?.localPending?'Saved locally · pending sync':t.session?t.session.status.replaceAll('_',' '):'Available'}</p>{t.session?<><p>Outstanding ₹{Number(t.session.outstanding).toFixed(2)}</p>{online&&<KitchenBadges storeId={storeId} sessionId={t.session.id}/>}</>:<p>{t.capacity?`${t.capacity} seats`:'Seats not set'}</p>}<Link to={t.session?'/pos?'+storeQuery+'&tableSession='+encodeURIComponent(t.session.id):'/pos?'+storeQuery+'&table='+encodeURIComponent(t.tableId)}>{t.session?'Continue':'Select'} {t.label}</Link>{online&&manager&&!t.session&&<button onClick={()=>{setTarget(t.tableId);setCapacity(t.capacity??'')}}>Set seats (optional)</button>}</article>)}</div></>}
 {manager&&target&&<div className="table-card"><label>Seats · {target}<input aria-label="Table seats" type="number" min="1" max="45" value={capacity} onChange={e=>setCapacity(e.target.value)}/></label><button disabled={table.busy||!!table.pending} onClick={()=>{void table.command('CAPACITY',{tableId:target,capacity:capacity?Number(capacity):null});setTarget('')}}>Save seats</button><button onClick={()=>setTarget('')}>Cancel</button></div>}
 </section>;
}
