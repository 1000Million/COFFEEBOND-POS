import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Wifi, WifiOff } from 'lucide-react';
import { savedPrintStatus } from '../../lib/offline/localPrint';
import type { Entry } from '../../lib/offline/journal';

export interface PosOfflineStatusProps {
  online: boolean;
  cashAvailable: boolean;
  tableReady?:boolean;
  lastSuccessfulSync?:number|null;
  excludedChoices?:number;
  pendingCheckout: boolean;
  entries: readonly Entry[];
  syncing: boolean;
  onSync: () => void;
  onReconcile?: (entry: Entry, reason: string) => void;
  canReconcile?: boolean;
  notice?: string | null;
  reason?:string;
  storeId?:string;
  prepare?: { busy: boolean; onPrepare: () => void };
  receipt?: Entry | null;
  onCloseReceipt?: () => void;
}

const statusLabel: Record<Entry['status'], string> = {
  PENDING: 'Pending sync',
  UNCERTAIN: 'Outcome uncertain',
  CONFLICT: 'Reconciliation required',
  SYNCED: 'Synced',
};

const statusClass: Record<Entry['status'], string> = {
  PENDING: 'text-amber-800',
  UNCERTAIN: 'text-amber-900',
  CONFLICT: 'text-red-800',
  SYNCED: 'text-emerald-800',
};

const money = (amount: number) => `₹${Number(amount).toFixed(2)}`;
const date = new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata',
});
const minorButton = 'rounded-lg border border-[#d8c6b9] bg-white px-3 py-1.5 text-xs font-bold text-[#42291e] hover:bg-[#f9f0e7] disabled:cursor-not-allowed disabled:opacity-50';

function LocalPrintStatus({entryId}:{entryId:string}){
  const [details,setDetails]=useState('');
  return <details onToggle={event=>{if(event.currentTarget.open)void savedPrintStatus(entryId)
    .then(result=>setDetails(result ? [result.message,...(result.jobs||[]).map(j=>j.channel+' · '+j.state+' · '+j.id)].join(' · ')
      : 'Printer acknowledgement is unavailable. Check the station before any reprint.'))
    .catch(()=>setDetails('Saved printer acknowledgement could not be read.'));}}>
    <summary>Local print status</summary><p className="mt-1 break-words text-xs">{details||'Reading local acknowledgement…'}</p>
  </details>;
}

export function OfflineCashReceipt({ entry }: { entry: Entry }) {
  const payload = entry.payload;
  const receipt = payload.receipt;
  const legal = receipt.legal;
  return <article className="offline-receipt">
    <h2>{receipt.storeName}</h2>
    <strong>PROVISIONAL OFFLINE CASH RECEIPT</strong>
    {entry.status==='PENDING' && <p>Saved offline — pending sync.</p>}
    <p>Acknowledgement of Cash received. Use the confirmed sale for the official invoice.</p>
    <p>{legal.tradeName}{legal.legalName && <><br />{legal.legalName}</>}
      {legal.legalAddress && <><br />{legal.legalAddress}</>}
      {legal.gstRegistered && legal.gstin && <><br />GSTIN: {legal.gstin}</>}
    </p>
    <p>Offline reference: {entry.id}<br />{date.format(payload.createdAt)}
      {payload.table && <><br />Table {payload.table.tableId} · revision {payload.table.version}</>}
    </p>
    {receipt.items.map((item: { name: string; quantity: number; unitPrice: number }, index: number) =>
      <p key={index}>{item.quantity} × {item.name} <span>{money(item.quantity * item.unitPrice)}</span></p>)}
    <hr />
    <p>Subtotal <span>{money(payload.totals.subtotal)}</span></p>
    <p>Discount ({payload.discountPercent}%) <span>{money(payload.totals.discountAmount)}</span></p>
    {receipt.gst.mode !== 'NO_GST' && legal.gstRegistered && <p>GST <span>{money(payload.totals.taxTotal)}</span></p>}
    <p><b>Total <span>{money(payload.totals.grandTotal)}</span></b></p>
    <p>Cash received <span>{money(payload.cashReceived)}</span></p>
    <p>Change <span>{money(payload.cashReceived - payload.totals.grandTotal)}</span></p>
    {entry.status === 'SYNCED' && entry.result?.orderNumber
      ? <p>Confirmed sale: {entry.result.orderNumber}</p>
      : <p>Retain this reference until synchronization is confirmed.</p>}
  </article>;
}

function printCashReceipt(content: HTMLElement) {
  const frame = document.createElement('iframe');
  frame.title = 'Offline Cash receipt print frame';
  frame.tabIndex = -1;
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;pointer-events:none';
  document.body.append(frame);
  const printWindow = frame.contentWindow;
  const printDocument = frame.contentDocument;
  if (!printWindow || !printDocument) { frame.remove(); return false; }
  printDocument.title = 'Provisional offline Cash receipt';
  const style = printDocument.createElement('style');
  style.textContent = 'body{margin:0;padding:3mm;color:#000;font:12px monospace} article{max-width:76mm} h2{font-size:16px;margin:0 0 8px} p{overflow-wrap:anywhere;margin:7px 0} span{float:right} hr{border:0;border-top:1px dashed #000}';
  printDocument.head.append(style);
  printDocument.body.append(printDocument.importNode(content, true));
  printWindow.addEventListener('afterprint', () => frame.remove(), { once: true });
  try {
    printWindow.print();
    return true;
  } catch {
    frame.remove();
    return false;
  }
}

export default function PosOfflineStatus({
  online, cashAvailable, tableReady=cashAvailable, lastSuccessfulSync, excludedChoices=0, pendingCheckout, entries, syncing, onSync, onReconcile,
  canReconcile, notice, reason:unavailableReason, storeId, prepare, receipt, onCloseReceipt,
}: PosOfflineStatusProps) {
  const panelId = useId();
  const reasonId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const receiptRef = useRef<HTMLDivElement>(null);
  const receiptBackRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [printError, setPrintError] = useState(false);
  const pendingCount = entries.filter((entry) => entry.status === 'PENDING' || entry.status === 'UNCERTAIN').length;
  const hasSyncWork = pendingCount > 0;
  const needsReconciliation = pendingCheckout || entries.some((entry) => entry.status === 'CONFLICT'
    || (!syncing && (entry.status === 'UNCERTAIN' || (entry.status === 'PENDING' && Boolean(entry.error)))));
  const showSync = !needsReconciliation && online && hasSyncWork;
  const sortedEntries = [...entries].sort((left, right) => right.payload.createdAt - left.payload.createdAt);
  const selectedReceiptId = receiptId ?? receipt?.id;
  const shownReceipt = entries.find((entry) => entry.id === selectedReceiptId)
    ?? (receipt?.id === selectedReceiptId ? receipt : null);
  const label = needsReconciliation ? 'Needs reconciliation'
    : showSync ? `Syncing ${pendingCount} ${pendingCount === 1 ? 'bill' : 'bills'}`
    : online ? (cashAvailable ? 'Online — ready for an outage' : 'Online') : cashAvailable ? 'Offline — billing available' : 'Offline — billing unavailable';
  const tone = needsReconciliation ? 'border-red-300 bg-red-50 text-red-900'
    : online && !showSync ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
    : 'border-amber-300 bg-amber-50 text-amber-950';
  const canReview = online && canReconcile && onReconcile;

  useEffect(() => {
    if (receipt?.id) {
      setReceiptId(null);
      setPrintError(false);
      setOpen(true);
    }
  }, [receipt?.id]);
  useEffect(() => {
    if (open && shownReceipt) receiptBackRef.current?.focus();
  }, [open, shownReceipt?.id]);

  const closeReceipt = () => {
    setReceiptId(null);
    setPrintError(false);
    onCloseReceipt?.();
  };

  const toggle = () => {
    if (open) closeReceipt();
    setOpen(!open);
  };

  return <div className="relative w-fit max-w-full shrink-0" onKeyDown={(event) => {
    if (event.key !== 'Escape' || !open) return;
    event.stopPropagation();
    closeReceipt();
    setOpen(false);
    toggleRef.current?.focus();
  }}>
    <button ref={toggleRef} type="button" aria-expanded={open} aria-controls={panelId} onClick={toggle}
      className={`inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full border px-3 text-xs font-bold focus-visible:outline-2 focus-visible:outline-offset-2 ${tone}`}>
      {online ? <Wifi size={14} aria-hidden="true" /> : <WifiOff size={14} aria-hidden="true" />}
      <span aria-live="polite" aria-atomic="true">
        {label}{!showSync && hasSyncWork && <span className="whitespace-nowrap"> · {pendingCount} pending</span>}
      </span>
      <ChevronDown size={13} aria-hidden="true" className={open ? 'rotate-180' : undefined} />
    </button>

    <section id={panelId} hidden={!open} aria-label="POS connection and offline Cash journal"
      className="absolute left-0 top-full z-50 mt-2 max-h-[55vh] w-[min(23rem,calc(100vw-2rem))] overflow-auto rounded-2xl border border-[#d8c6b9] bg-white p-3 text-sm text-[#2d1c19] shadow-xl">
      <div className="flex items-start justify-between gap-2">
        <h2 className="font-black">Offline Cash journal</h2>
        {online && hasSyncWork && <button type="button" disabled={syncing} onClick={onSync} className={minorButton}>
          {syncing ? 'Checking…' : 'Check status and sync'}
        </button>}
      </div>
      <p className="mt-1 text-xs">Last successful sync: {lastSuccessfulSync?date.format(lastSuccessfulSync):'No successful sync recorded for this store.'}</p>
      {pendingCheckout && <p className="mt-1 text-xs font-bold text-amber-900">Resolve the previous checkout online before receiving Cash for this basket.</p>}
      {!pendingCheckout && !online && !cashAvailable && <p className="mt-1 text-xs text-neutral-700">{unavailableReason||'Reconnect and prepare this device before taking new Cash payments.'}</p>}
      {online && prepare && !cashAvailable && <button type="button" disabled={prepare.busy || pendingCheckout} onClick={prepare.onPrepare} className={`${minorButton} mt-2`}>
        {prepare.busy ? 'Preparing…' : 'Prepare for offline Cash'}
      </button>}
      {online && cashAvailable && <p className="mt-1 text-xs text-neutral-700">This session is ready for offline Cash.</p>}
      {cashAvailable && !tableReady && <p>Counter Cash is available. Tables are unavailable for offline changes at this store.</p>}
      {!online && excludedChoices>0 && <p>{excludedChoices} menu {excludedChoices===1?'item requires':'items require'} an online availability or options check.</p>}
      {notice && <p role="status" className="mt-2 text-xs font-bold text-[#583929]">{notice}</p>}

      <a className="mt-2 inline-block underline" href={'/offline-cash'+(storeId?'?storeId='+encodeURIComponent(storeId):'')}>Signed journal backup and recovery</a>
      {!shownReceipt && (sortedEntries.length === 0
        ? <p className="mt-3 text-xs text-neutral-700">No offline Cash bills for this staff and store.</p>
        : <ul className="mt-3 space-y-2">
          {sortedEntries.map((entry) => <li key={entry.id} className="rounded-xl border border-[#eadfd4] p-2.5">
            <div className="flex flex-wrap justify-between gap-x-2 gap-y-0.5 text-xs">
              <strong className={statusClass[entry.status]}>{statusLabel[entry.status]}</strong>
              <span className="font-mono font-bold">{entry.payload.kind==='TABLE_OPEN'?'Table opened':entry.payload.kind==='TABLE_ROUND'?'Round saved':money(entry.payload.totals.grandTotal)}</span>
            </div>
            <p className="mt-1 break-all font-mono text-[11px] text-neutral-700">{entry.id}</p>
            {entry.status === 'SYNCED' && entry.result?.orderNumber && <p className="mt-1 text-xs">Confirmed sale {entry.result.orderNumber}</p>}
            {entry.conflicts?.length ? <p className="mt-1 break-words text-xs text-red-800">{entry.conflicts.join(', ')}</p> : null}
            {entry.payload.printAuthority==='DESIGNATED_TILL'&&<LocalPrintStatus entryId={entry.id}/>}
            {entry.pendingReason && <p className="mt-1 text-xs">{entry.pendingReason}</p>}
            {entry.error && <p className="mt-1 break-words text-xs text-red-800">{entry.error}</p>}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {entry.payload.receipt&&<button type="button" className={minorButton} onClick={() => { setPrintError(false); setReceiptId(entry.id); }}>View offline receipt</button>}
              {entry.status === 'CONFLICT' && entry.payload.receipt && canReview && reviewId !== entry.id && <button type="button" className={minorButton} disabled={syncing}
                onClick={() => { setReviewId(entry.id); setReason(''); }}>Manager reconciliation</button>}
            </div>
            {entry.status === 'CONFLICT' && entry.payload.receipt && canReview && reviewId === entry.id && <form className="mt-2 grid gap-1.5" onSubmit={(event) => {
              event.preventDefault();
              if (reason.trim().length < 8 || syncing) return;
              onReconcile(entry, reason.trim());
            }}>
              <label htmlFor={reasonId} className="text-xs font-bold">Reason for honoring the original Cash and financial snapshot</label>
              <textarea id={reasonId} value={reason} onChange={(event) => setReason(event.target.value)} rows={2} required minLength={8}
                className="w-full rounded-lg border border-[#d8c6b9] px-2 py-1 text-xs" />
              <p className="text-xs text-neutral-700">Table revision and unavailable-product conflicts require separate review.</p>
              <div className="flex flex-wrap gap-1.5">
                <button type="submit" disabled={syncing || reason.trim().length < 8} className={minorButton}>Submit review</button>
                <button type="button" onClick={() => setReviewId(null)} className={minorButton}>Cancel</button>
              </div>
            </form>}
          </li>)}
        </ul>)}

      {shownReceipt && <div className="mt-3 rounded-xl border border-[#eadfd4] bg-[#fbf8f3] p-2">
        <div className="flex flex-wrap gap-1.5">
          <button ref={receiptBackRef} type="button" onClick={() => { closeReceipt(); toggleRef.current?.focus(); }} className={minorButton}>Back to journal</button>
          <button type="button" onClick={() => {
            const content = receiptRef.current?.firstElementChild;
            if (content instanceof HTMLElement) setPrintError(!printCashReceipt(content));
          }} className={minorButton}>Print offline receipt</button>
        </div>
        {printError && <p role="alert" className="mt-2 text-xs text-red-800">The browser could not open the receipt print dialog. The saved receipt is still available.</p>}
        <div ref={receiptRef}><OfflineCashReceipt entry={shownReceipt} /></div>
      </div>}
    </section>
  </div>;
}
