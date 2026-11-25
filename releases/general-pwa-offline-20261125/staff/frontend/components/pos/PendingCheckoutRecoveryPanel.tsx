import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PendingCheckoutResolution, PendingCheckoutReview } from '../../lib/pos/pendingCheckoutRecovery';

export default function PendingCheckoutRecoveryPanel({ orderId, resolution, busy, paymentPending, canReviewAbsent, canFinishSaved, reviewContext,
  onCheck, onReceipt, onSeparateBill, onRetryOriginalReference, onRetire }: {
  orderId: string;
  resolution: PendingCheckoutResolution | null;
  busy: boolean;
  paymentPending: boolean;
  canReviewAbsent: boolean;
  canFinishSaved: boolean;
  reviewContext: string;
  onCheck: () => void;
  onReceipt: () => void;
  onSeparateBill: () => void;
  onRetryOriginalReference: () => void;
  onRetire: (review: PendingCheckoutReview) => void;
}) {
  const [kind, setKind] = useState<'NO_PAYMENT_REVIEWED' | 'PAID_REPLACEMENT'>('PAID_REPLACEMENT');
  const [replacementOrderId, setReplacementOrderId] = useState('');
  const [reviewed, setReviewed] = useState(false);
  useEffect(() => setReviewed(false), [reviewContext]);
  return <section aria-label="Previous checkout recovery" className="mt-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
    <p className="font-black">Check the previous checkout</p>
    <p className="mt-1">Your current basket is kept. Do not collect payment again for the earlier bill.</p>
    {resolution?.status === 'COMMITTED'
      ? <p className="mt-2">The earlier bill is saved. View its receipt and finish this original checkout without collecting payment again.</p>
      : resolution?.status === 'DISMISSED'
      ? <p className="mt-2">The server retired this reference. Its original staff account and unchanged basket must be verified before the protected basket can be cleared.</p>
      : resolution?.status === 'NOT_SAVED'
      ? <p className="mt-2">No saved POS order was found. This does not confirm whether payment was collected. Ask an Admin to review the earlier tender and any paid replacement bill. A server review is required before this reference can be retired.</p>
      : <p className="mt-2">The earlier bill is not yet reconciled. Check again online, or ask an Admin to review Running Orders and the payment outcome.</p>}
    {resolution?.status === 'NOT_SAVED' && !canReviewAbsent && <p className="mt-2 font-bold">Only the original staff member with an active Admin account and this unchanged basket can retire this reference. You can still check for the saved original sale.</p>}
    <p className="mt-2 break-all font-mono text-xs">Previous order reference: {orderId}</p>
    {paymentPending && <p className="mt-2 font-bold">Review the saved Razorpay request in the payment panel before starting another bill.</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" disabled={busy} onClick={onCheck} className="rounded-lg bg-amber-900 px-3 py-2 font-bold text-white disabled:opacity-50">{busy ? 'Checking previous checkout…' : 'Check previous checkout'}</button>
      {resolution?.status === 'COMMITTED' && canFinishSaved && <>
        <button type="button" disabled={busy} onClick={onReceipt} className="rounded-lg border border-amber-900 px-3 py-2 font-bold disabled:opacity-50">View saved receipt</button>
        <button type="button" disabled={busy || paymentPending} onClick={onSeparateBill} className="rounded-lg border border-amber-900 px-3 py-2 font-bold disabled:opacity-50">Finish saved checkout and clear original basket</button>
      </>}
      {resolution?.status === 'NOT_SAVED' && canReviewAbsent && <button type="button" disabled={busy || paymentPending} onClick={onRetryOriginalReference} className="rounded-lg border border-amber-900 px-3 py-2 font-bold disabled:opacity-50">Admin: retry unchanged basket with original sale reference</button>}
      <Link to="/pos/running-orders" target="_blank" rel="noopener noreferrer" className="rounded-lg border border-amber-900 px-3 py-2 font-bold">Open Running Orders in a new tab</Link>
    </div>
    {resolution?.status === 'NOT_SAVED' && canReviewAbsent && <fieldset disabled={busy || paymentPending} className="mt-4 space-y-3 rounded-lg border border-amber-300 p-3">
      <legend className="px-1 font-bold">Admin: retire the previous reference</legend>
      <p>This closes the failed reference without creating a sale or collecting payment. The basket reviewed here is cleared only after the server confirms retirement.</p>
      <label className="block">Review outcome
        <select value={kind} onChange={event => { setKind(event.target.value as typeof kind); setReviewed(false); }} className="mt-1 block w-full rounded border border-amber-400 bg-white p-2">
          <option value="PAID_REPLACEMENT">This customer bill was already paid under another POS order</option>
          <option value="NO_PAYMENT_REVIEWED">No payment was collected; discard this failed basket</option>
        </select>
      </label>
      {kind === 'PAID_REPLACEMENT' && <label className="block">Exact paid replacement POS order reference
        <input value={replacementOrderId} maxLength={180} placeholder="POS_…" onChange={event => { setReplacementOrderId(event.target.value); setReviewed(false); }} className="mt-1 block w-full rounded border border-amber-400 bg-white p-2" />
      </label>}
      <label className="flex items-start gap-2"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} className="mt-1" /><span>I reviewed the original tender, any replacement receipt, and the basket shown here. No payment is uncertain or outstanding. Clear this reviewed basket when retirement is confirmed.</span></label>
      <button type="button" disabled={busy || paymentPending || !reviewed || (kind === 'PAID_REPLACEMENT' && !/^POS_[A-Za-z0-9_-]+$/.test(replacementOrderId.trim()))} onClick={() => onRetire(kind === 'NO_PAYMENT_REVIEWED'
        ? { reason: 'REVIEWED_NO_PAYMENT', resolution: { kind } }
        : { reason: 'VERIFIED_PAID_REPLACEMENT', resolution: { kind, replacementOrderId: replacementOrderId.trim() } })} className="rounded-lg bg-amber-900 px-3 py-2 font-bold text-white disabled:opacity-50">Retire reference and clear reviewed basket</button>
    </fieldset>}
  </section>;
}
