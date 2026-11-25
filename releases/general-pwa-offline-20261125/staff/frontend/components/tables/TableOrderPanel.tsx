import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {ArrowRight,CheckCircle2,Clock,Minus,Plus,Printer,Percent,StickyNote,Trash2,X} from 'lucide-react';
import type {CalculatedTotals} from '../../lib/pos/posTotals';
import type {TableDraftLine} from '../../lib/tables/drafts';
import type {MenuItem} from '../../types';
import {useAuth} from '../../contexts/AuthContext';
import {tableCall,tableError} from '../../lib/tables/api';
import type {TableOrder} from '../../lib/tables/useTableOrder';
import {buildReceiptSnapshot} from '../../lib/pos/posOrderLifecycle';
import {receiptGstSplit} from '../../lib/pos/posTax';
import {customerMobile} from '../../lib/pos/customerMobile';
import ReceiptModal from '../pos/ReceiptModal';
import TablePaymentPanel from './TablePaymentPanel';
import KitchenBadges from './KitchenBadges';
import BillItemEntry from './BillItemEntry';
import '../../pages/pos/Tables.css';
import './TableBill.css';
const labels:Record<string,string>={OCCUPIED:'Occupied',BILL_REQUESTED:'Bill requested',PAYMENT_PENDING:'Payment pending',PAID_AWAITING_CLEAR:'Paid — awaiting clearing',CLOSED:'Closed'};
const rupees=(n:number)=>'₹'+Number(n).toFixed(2);
export default function TableOrderPanel({table,search,onAdd,describeLine,onViewMenu,offlinePayment}:{table:TableOrder;search:(q:string)=>MenuItem[];onAdd:(item:MenuItem)=>void;describeLine:(line:TableDraftLine)=>{name:string;options:string;totals:CalculatedTotals}|null;onViewMenu:()=>void;offlinePayment?:(discountPercent:number)=>React.ReactNode}){
 const {staffProfile}=useAuth();const {storeId,storeName,session,board,draft,pending,busy,locked,sessionId,command,execute,setError}=table;
 const scope=`${staffProfile?.uid || ''}:${storeId}:${sessionId}:${session?.orderId || ''}`;const scopeRef=useRef(scope);scopeRef.current=scope;
 const orderingPaused=board?.recoveryMode===true;const manager=['ADMIN','STORE_MANAGER'].includes(staffProfile?.role||'');
 const [retryConfirmed,setRetryConfirmed]=useState(false);
 useEffect(()=>setRetryConfirmed(false),[table.pending?.opId]);
 const [guest,setGuest]=useState(''),[mobile,setMobile]=useState(''),[move,setMove]=useState(''),[handover,setHandover]=useState(''),[reason,setReason]=useState(''),[discount,setDiscount]=useState('0');
 const [showDiscount,setShowDiscount]=useState(false),[showNote,setShowNote]=useState(false),[kotOpen,setKotOpen]=useState(false);
 const kotDialog=useRef<HTMLDivElement>(null);
 const [people,setPeople]=useState<any[]>([]),[receipt,setReceipt]=useState<any>(null);
 useEffect(()=>{setPeople([]);setKotOpen(false);setReceipt(null);setGuest('');setMove('');setHandover('');setReason('');setDiscount('0');},[storeId,sessionId]);
 useEffect(()=>setMobile(session?.customerPhone||''),[session?.customerPhone,sessionId]);
 const readReceipt = async (settledOnly: boolean) => {
   const originalOrderId = session?.orderId;
   if (!originalOrderId) throw Error('Send a round before requesting the bill.');
   const latest = await tableCall({storeId, action:'DETAIL', sessionId});
   const saved = latest?.saved;
   if (latest.storeId !== storeId || latest.id !== sessionId || latest.orderId !== originalOrderId ||
       saved?.order?.id !== originalOrderId || saved.order.storeId !== storeId ||
       (saved.order.tableSessionId && saved.order.tableSessionId !== sessionId)) {
     throw Error('Saved bill belongs to another store, session or order.');
   }
   const settled = saved.order.paymentStatus === 'PAID' ||
     (saved.order.commercialStatus === 'COMPLIMENTARY' && saved.order.paymentStatus === 'NOT_REQUIRED');
   if (settledOnly && !settled) throw Error('The original settlement has not been confirmed.');
   const created = saved.order.createdAt;
   const createdAt = Number.isFinite(created?._seconds) ? new Date(created._seconds * 1000).toISOString() : created;
   const payments = settled ? saved.payments.filter((p:any) => p.method !== 'PAY_AT_COUNTER') : saved.payments;
   return buildReceiptSnapshot({...saved.order, createdAt}, saved.items.filter((line:any) => line.quantity > 0),
     payments, {id:storeId,name:saved.order.storeName || storeName} as any, true);
 };
 const getReceipt = () => readReceipt(true);
 const openSettledReceipt = async () => {
   try {
     const saved = await getReceipt();
     if (scopeRef.current === scope) setReceipt(saved);
   } catch {
     if (scopeRef.current === scope) setError('Check the original bill using View bill to retrieve its saved receipt.');
   }
 };
 const preview = async () => {
   if (!session?.saved) return;
   if (!locked && !pending && session.status !== 'BILL_REQUESTED') {
     const ack = await execute({action:'BILL_REQUEST',opId:crypto.randomUUID(),sessionId,version:session.version});
     if (!ack) return;
   }
   const saved = await readReceipt(false);
   if (scopeRef.current === scope) setReceipt(saved);
 };
 const maximumDiscount=staffProfile?.role==='ADMIN'?100:staffProfile?.role==='STORE_MANAGER'?20:10;
 const draftViews=draft.map(describeLine),draftReady=draftViews.every(Boolean);
 const savedOrder=session?.saved?.order;
 const sentReady=!session?.orderId||['subtotal','taxTotal','grandTotal'].every(k=>Number.isFinite(savedOrder?.[k]));
 const draftSum=(key:keyof CalculatedTotals)=>draftViews.reduce((sum,row)=>sum+(row?row.totals[key]:0),0);
 const subtotal=draftReady&&sentReady?(savedOrder?.subtotal||0)+draftSum('subtotal'):null;
 const tax=draftReady&&sentReady?(savedOrder?.taxTotal||0)+draftSum('taxTotal'):null;
 const total=draftReady&&sentReady?(savedOrder?.grandTotal||0)+draftSum('grandTotal'):null;
 const amount=(value:number|null)=>value===null?'—':rupees(value);
 const lastRound=session?.rounds?.at(-1);
 const sendAndReview=async()=>{const ack=await table.send();if(ack&&!ack.local)setKotOpen(true);};
 useEffect(()=>{if(session?.paymentAttempt?.id)document.querySelector('[aria-label="Frozen payment"]')?.scrollIntoView({block:'nearest',behavior:'smooth'});},[session?.paymentAttempt?.id]);
 useEffect(()=>{if(!kotOpen)return;const previous=document.activeElement as HTMLElement|null;kotDialog.current?.querySelector('button')?.focus();return()=>{if(previous&&!previous.hasAttribute('disabled'))previous.focus();else document.querySelector<HTMLInputElement>('.pos-bill-region .bill-item-entry input:not(:disabled)')?.focus();};},[kotOpen]);
 return <section className="table-pilot table-pos-panel table-bill" aria-label="Running table bill">
 {table.error&&<p role="alert" className="table-warning">{table.error}</p>}{table.notice&&<p role="status">{table.notice}</p>}
 {table.localPending&&<p role="status" className="table-warning">Local table changes · pending synchronization or reconciliation.</p>}
 {table.offline&&table.offlineReason&&<p role="status" className="table-warning">{table.offlineReason}</p>}
 {table.storageWarning&&<p className="table-warning" role="status">Draft storage is unavailable or unreadable. Keep this page open to retain unsent items and any pending operation.</p>}
 {table.externalLocked&&<p role="status" className="table-warning">Reconcile the counter checkout before changing this table. <button onClick={()=>table.select(null)}>Open counter checkout</button></p>}
 <fieldset disabled={table.externalLocked} className="table-order-fields">
 {pending&&!busy&&<div className="table-warning" role="status">The last {String(pending.action).toLowerCase()} has not been reconciled. Keep its original reference.<button onClick={()=>void table.reconcile()}>Reconcile previous operation</button>{table.canRetryComplimentary&&<div><p>The original request is still available on this device. No new close or authorization will be created.</p><label><input type="checkbox" checked={retryConfirmed} onChange={e=>setRetryConfirmed(e.target.checked)}/>I confirm retrying only the original operation</label><button disabled={!retryConfirmed||busy} onClick={()=>{setRetryConfirmed(false);void table.retryOriginalClose(retryConfirmed)}}>Retry original verified close</button></div>}</div>}
 {orderingPaused&&<p className="table-warning">Recovery mode · new tables and rounds are paused. Existing bills and payment reconciliation remain available.</p>}
 {table.pendingLocalCash&&<p className="table-warning" role="status">Cash was saved for this table. Check the Cash journal before collecting payment again.</p>}
 {locked&&<p className="table-warning" role="status">{session?.paymentAttempt?'Payment pending · adding, sending and corrections are locked.':savedOrder?.commercialStatus==='COMPLIMENTARY'?'Complimentary closed · no payment required. New items are locked.':'This bill is paid or closed. New items are locked.'}</p>}
 {!session&&table.selected&&!table.selected.session&&<div className="table-card"><h2>{table.selected.label} · Available</h2><p>Selecting a table has not opened a session.</p><label>Guest count (optional)<input aria-label="Guest count" type="number" min="1" max="45" value={guest} onChange={e=>setGuest(e.target.value)}/></label><button disabled={!board?.enableNewSessions||busy||!!pending||!table.operationalReady} onClick={()=>void command('OPEN',{sessionId:crypto.randomUUID(),tableId:table.selected.tableId,guestCount:guest?Number(guest):null})}>Open Table</button>{!board?.enableNewSessions&&<p>New tables are paused.</p>}</div>}
 {!session&&sessionId&&!table.error&&<p role="status">{table.offline||table.boardUnavailable?'Saved details for this table are unavailable. Reconnect to retrieve the original bill.':'Loading existing table…'}</p>}
 {!session&&<BillItemEntry search={search} onAdd={onAdd} onViewMenu={onViewMenu} disabled/>}
 {session&&<section className="table-detail" aria-label="Current table">
   <header className="bill-heading"><div><p className="bill-eyebrow">{session.tableLabel} · {labels[session.status]}</p><h2 title={savedOrder?.orderNumber} aria-label={savedOrder?.orderNumber?'Bill '+savedOrder.orderNumber:undefined}>{savedOrder?.orderNumber?'Bill #'+savedOrder.orderNumber.split('-').at(-1):'New running bill'}</h2></div><span className="bill-time"><Clock size={15} aria-hidden="true"/>{new Date(session.openedAt).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kolkata'})}</span></header>
   <div className="bill-entry-surface"><BillItemEntry search={search} onAdd={onAdd} onViewMenu={onViewMenu} disabled={!table.canEdit}/></div>
   <section className="bill-section" aria-labelledby="new-items-title">
    <header className="bill-section-heading"><h3 id="new-items-title">NEW ITEMS <span>{draft.reduce((n,l)=>n+l.quantity,0)}</span></h3><p>Subtotal {amount(draftReady?draftSum('subtotal'):null)}</p></header>
    {!draft.length&&<p className="bill-empty">{locked?'Items are locked. Review the sent round and payment status below.':'Type an item above to start the next round.'}</p>}
    {draft.map((line,i)=>{const view=draftViews[i];return <div className="bill-order-line" key={line.orderItemId}>
     <div className="bill-line-name"><strong>{view?.name||line.parentProductCode}</strong><span>{view?.options||line.optionsLabel||line.parentProductCode}</span></div>
     <strong className="bill-line-price">{amount(view?view.totals.subtotal:null)}</strong>
     <div className="bill-quantity"><button type="button" aria-label={`Decrease unsent ${i+1}`} disabled={!table.canEdit||line.quantity<=1} onClick={()=>table.setItems(draft.map(x=>x.orderItemId===line.orderItemId?{...x,quantity:x.quantity-1}:x))}><Minus size={16} aria-hidden="true"/></button><span aria-label={`Unsent quantity ${i+1}`}>{line.quantity}</span><button type="button" aria-label={`Increase unsent ${i+1}`} disabled={!table.canEdit||line.quantity>=20} onClick={()=>table.setItems(draft.map(x=>x.orderItemId===line.orderItemId?{...x,quantity:x.quantity+1}:x))}><Plus size={16} aria-hidden="true"/></button></div>
     <button type="button" className="bill-remove" aria-label={`Remove unsent ${view?.name||line.parentProductCode}`} disabled={!table.canEdit} onClick={()=>table.setItems(draft.filter(x=>x.orderItemId!==line.orderItemId))}><Trash2 size={18} aria-hidden="true"/></button>
    </div>;})}
    {draft.length>0&&<p className="bill-preview-note">Unsent · prices checked again on Send. {table.storageWarning?'Kept in memory only.':'Item references saved on this device.'}</p>}
   </section>
   <section className="bill-section bill-sent-section" aria-labelledby="sent-items-title">
    <header className="bill-section-heading"><h3 id="sent-items-title">ALREADY SENT <span>{session.lines.reduce((n:number,l:any)=>n+(l.cancelled?0:l.quantity),0)}</span></h3></header>
    {!session.rounds.length&&<p className="bill-empty">No rounds sent yet.</p>}
    {session.rounds.map((round:any,roundIndex:number)=><section className="bill-round" key={round.id} aria-label={`Sent round ${roundIndex+1}`}><h4>Round {roundIndex+1} <span>Sent · {new Date(round.sentAt).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kolkata'})}</span></h4>{session.lines.filter((l:any)=>l.roundId===round.id).map((line:any)=>{const savedLine=session.saved?.items?.find((item:any)=>item.id===line.id);return <div className="bill-order-line bill-sent-line" key={line.id}><div className="bill-line-name"><strong>{line.quantity} × {line.itemName}</strong>{line.addOns.length>0&&<span>{line.addOns.map((a:any)=>a.optionName).join(', ')}</span>}<span className="bill-sent-status"><CheckCircle2 size={14} aria-hidden="true"/>{line.cancelled?'Cancelled':table.offline&&session.localPending?'Saved on till · check print status':session.kitchenUnavailable?'Sent · kitchen updates unavailable':(session.kitchen||[]).filter((k:any)=>k.lineId===line.id).map((k:any)=>`${k.station}: ${k.status}`).join(' / ')||'Sent · no kitchen task'}</span></div><strong className="bill-line-price">{amount(Number.isFinite(savedLine?.lineSubtotal)?savedLine.lineSubtotal:null)}</strong>{manager&&!locked&&!line.cancelled&&reason.trim()&&<button disabled={busy||!!pending||!reason.trim()} onClick={()=>command('CORRECT',{lineId:line.id,reason})}>Cancel sent item</button>}</div>;})}</section>)}
   </section>
   <div className="bill-kitchen-summary"><KitchenBadges storeId={storeId} sessionId={session.id}/><button disabled={!session.orderId||busy||table.offline} onClick={()=>void preview().catch(e=>setError(tableError(e)))}>View bill</button>{lastRound&&!table.offline&&<button onClick={()=>setKotOpen(true)}>Reprint last KOT</button>}</div>
   {showDiscount&&<section className="bill-inline-editor" aria-label="Bill discount"><label>Discount %<input autoFocus aria-label="Discount percent" type="number" min="0" max={maximumDiscount} value={discount} disabled={locked} onChange={e=>setDiscount(e.target.value===''?'':String(Math.min(maximumDiscount,Math.max(0,Number(e.target.value)||0))))}/></label><p>Up to {maximumDiscount}% for your role. Applied by the server when Checkout starts.</p></section>}
   {showNote&&<section className="bill-inline-editor" aria-label="Local reminder"><label>Local note<textarea autoFocus aria-label="Local note" maxLength={240} value={table.note} disabled={!table.canEdit} onChange={e=>table.setNote(e.target.value)}/></label><p>Reference only while this page is open. Not saved, sent to the kitchen or printed.</p></section>}
   <footer className="bill-footer">
    <dl className="bill-totals"><div><dt>Subtotal</dt><dd>{amount(subtotal)}</dd></div>{savedOrder?.discountAmount>0&&<div><dt>{savedOrder.commercialStatus==='COMPLIMENTARY'?'Complimentary menu value':'Discount'}</dt><dd>−{rupees(savedOrder.discountAmount)}</dd></div>}<div><dt>GST</dt><dd>{amount(tax)}</dd></div><div className="bill-total"><dt>Total</dt><dd>{amount(total)}</dd></div></dl>
    {!!draft.length&&<p className="bill-preview-note">Preview includes unsent items · not a saved bill.</p>}
    <div className="bill-action-row"><button type="button" disabled={locked||busy||!!pending} aria-expanded={showDiscount} onClick={()=>{setShowDiscount(v=>!v);setShowNote(false);}}><Percent size={18} aria-hidden="true"/>Discount{Number(discount)>0?' '+discount+'%':''}</button><button type="button" disabled={!table.canEdit} aria-expanded={showNote} onClick={()=>{setShowNote(v=>!v);setShowDiscount(false);}}><StickyNote size={18} aria-hidden="true"/>Note{table.note?' •':''}</button><button type="button" className="bill-send" disabled={!table.operationalReady||orderingPaused||locked||busy||!draft.length||!!pending||!draftReady} onClick={()=>void sendAndReview()}><Printer size={18} aria-hidden="true"/>{busy?'Saving…':table.offline?'Save round locally':'Send / Print KOT'}</button></div>
    {session.orderId && !session.closedAt && session.status !== 'PAID_AWAITING_CLEAR' &&
      (offlinePayment
        ? offlinePayment(Number(discount))
        : <TablePaymentPanel table={table} discountPercent={Number(discount)} billTotal={total} onSettled={openSettledReceipt}/>)}
    {!!draft.length&&<p className="bill-preview-note">Send or remove new items before Checkout.</p>}
   </footer>
   {session.status==='PAID_AWAITING_CLEAR'&&<div className="table-warning"><p>Paid. Clear only after kitchen items are served or cancelled. Clearing removes the active table contact; the paid receipt stays saved.</p><button disabled={table.offline||busy||!!pending} onClick={()=>command('CLEAR')}>Clear table</button></div>}
   {table.offline?<p className="bill-preview-note">Moving, handing over, clearing and correcting sent items require a connection.</p>:<details onToggle={e=>{if(e.currentTarget.open&&manager)void tableCall({storeId,action:'STAFF'}).then(r=>{if(scopeRef.current===scope)setPeople(r.people)}).catch(e=>{if(scopeRef.current===scope)setError(tableError(e))})}}><summary>More table actions</summary><label>Optional customer mobile<input aria-label="Table customer mobile" inputMode="tel" value={mobile} disabled={locked} onChange={e=>setMobile(e.target.value)}/></label><p>Unverified · for this bill only · native POS earns zero BOND points</p><button disabled={locked||busy||!!pending||!!customerMobile(mobile).error} onClick={()=>command('CONTACT',{mobile})}>Save mobile</button><label>Move to available table<select aria-label="Move table" value={move} onChange={e=>setMove(e.target.value)}><option value="">Choose table</option>{board?.tables.filter((t:any)=>!t.session).map((t:any)=><option value={t.tableId} key={t.id}>{t.label}</option>)}</select></label><button disabled={locked||!move||busy||!!pending} onClick={()=>command('MOVE',{targetTableId:move})}>Move session</button>{manager&&<><label>Hand over to staff<select aria-label="Handover staff" value={handover} onChange={e=>setHandover(e.target.value)}><option value="">Choose authorised staff</option>{people.map(person=><option key={person.uid} value={person.uid}>{person.name} · {person.role.replace('_',' ')}</option>)}</select></label><button disabled={locked||!handover||busy||!!pending} onClick={()=>command('HANDOVER',{staffUid:handover})}>Hand over session</button><label>Reason for sent-item correction<input aria-label="Correction reason" value={reason} disabled={locked} onChange={e=>setReason(e.target.value)}/></label><p>Manager only. Unprepared items use the existing stock reversal. Prepared items are cancelled without restocking and retain a wastage audit.</p></>}{(!session.orderId||session.lines.every((l:any)=>l.cancelled))&&<button disabled={locked||busy||!!pending} onClick={()=>command('CLOSE_EMPTY',{reason})}>Close empty or cancelled session</button>}</details>}
  </section>}
  {kotOpen&&lastRound&&createPortal(<div className="kot-print-backdrop"><div ref={kotDialog} className="kot-print-sheet" role="dialog" aria-modal="true" aria-labelledby="kot-title" onKeyDown={e=>{if(e.key==='Escape')setKotOpen(false);if(e.key==='Tab'){const buttons=e.currentTarget.querySelectorAll('button');if(e.shiftKey&&document.activeElement===buttons[0]){e.preventDefault();buttons[buttons.length-1].focus();}else if(!e.shiftKey&&document.activeElement===buttons[buttons.length-1]){e.preventDefault();buttons[0].focus();}}}}><header><div><p>Server-confirmed kitchen ticket</p><h2 id="kot-title">{session.tableLabel} · Round {session.rounds.length}</h2></div><button aria-label="Close KOT preview" onClick={()=>setKotOpen(false)}><X size={22}/></button></header><p>{savedOrder?.orderNumber} · {new Date(lastRound.sentAt).toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata'})}</p>{session.lines.filter((line:any)=>line.roundId===lastRound.id).map((line:any)=><div className="kot-print-line" key={line.id}><strong>{line.cancelled?'CANCELLED · ':''}{line.quantity} × {line.itemName}</strong><span>{line.itemCode} · {line.prepStation}</span>{line.addOns.map((a:any)=><span key={a.groupId+':'+a.optionId}>{a.quantity} × {a.optionName}</span>)}</div>)}<p className="kot-print-help">This round is already sent. Printing does not send it again.</p><button className="kot-print-button" onClick={()=>window.print()}><Printer size={18}/>Print KOT</button></div></div>,document.body)}
  {receipt&&receipt.order.sourceOrderId===session?.orderId&&<ReceiptModal receiptView={receipt} unpaidPreview={receipt.order.paymentStatus!=='PAID'&&receipt.order.commercialStatus!=='COMPLIMENTARY'} closeLabel="Back to table" receiptViewTitle={receipt.order.commercialStatus==='COMPLIMENTARY'?'Complimentary receipt · no payment required':receipt.order.paymentStatus==='PAID'?'Paid receipt':'UNPAID BILL PREVIEW · NOT A PAYMENT RECEIPT'} receiptGst={receiptGstSplit(receipt.order)} showGstin={!!receipt.order.receiptLegalDetails?.gstin} showState={!!receipt.order.receiptLegalDetails?.stateName} printReceiptElement={()=>window.print()} onClose={()=>setReceipt(null)} prepareWhatsAppReceipt={receipt.order.paymentStatus==='PAID'?getReceipt:undefined}/>}
 </fieldset>
 </section>;
}
