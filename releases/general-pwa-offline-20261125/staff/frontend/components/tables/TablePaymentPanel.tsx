import { useState } from 'react';
import type { PaymentMethod } from '../../types';
import type { SplitPaymentRow } from '../../lib/pos/posOrderLifecycle';
import { paymentRowsAllocated, paymentBalance } from '../../lib/pos/posPayments';
import type { TableOrder } from '../../lib/tables/useTableOrder';
import PaymentPanel from '../pos/PaymentPanel';
import TableComplimentaryClosing from './TableComplimentaryClosing';

const TABLE_TENDERS: PaymentMethod[] = ['CASH', 'UPI', 'CARD'];
const TABLE_METHODS: PaymentMethod[] = [...TABLE_TENDERS, 'COMPLIMENTARY'];

interface Props {
  table: TableOrder;
  discountPercent: number;
  billTotal: number | null;
  onSettled: () => Promise<void>;
}

export default function TablePaymentPanel({ table, discountPercent, billTotal, onSettled }: Props) {
  const { session, pending, busy, draft } = table;
  const attempt = session.paymentAttempt;
  const methods = attempt || table.complimentarySupported===false ? TABLE_TENDERS : TABLE_METHODS;
  const [choice, setChoice] = useState<PaymentMethod | ''>('');
  const [split, setSplit] = useState(false);
  const [rows, setRows] = useState<SplitPaymentRow[]>([]);
  // A confirmation belongs to one server attempt and one exact allocation.
  const [confirmedAllocation, setConfirmedAllocation] = useState('');
  const [cancelAttempt, setCancelAttempt] = useState('');
  const method = choice && methods.includes(choice) ? choice : '';
  const due = attempt ? Number(attempt.amount) : billTotal;
  const validDue = due !== null && Number.isFinite(due) && due >= 0;
  const allocated = paymentRowsAllocated(rows);
  const tenderRows = split ? rows.map(row => ({ method: row.method, amount: Number(row.amountStr) }))
    : method ? [{ method, amount: due }] : [];
  const balanced = validDue && (split ? rows.length > 0 && rows.length <= 6
    && rows.every(row => TABLE_TENDERS.includes(row.method) && /^\d+(\.\d{1,2})?$/.test(row.amountStr) && Number(row.amountStr) > 0)
    && rows.reduce((p, r) => p + Math.round(Number(r.amountStr) * 100), 0) === Math.round(due * 100)
    : TABLE_TENDERS.includes(method as PaymentMethod));
  const allocationKey = JSON.stringify([attempt?.id, tenderRows]);
  const received = confirmedAllocation === allocationKey;
  const noPayment = Boolean(attempt && cancelAttempt === attempt.id);
  const locked = !table.operationalReady || table.pendingLocalCash || table.externalLocked || busy || !!pending
    || !!draft.length || !session.orderId || !!session.closedAt || session.status === 'PAID_AWAITING_CLEAR';
  const addRow = (amount: number): SplitPaymentRow => ({
    id: crypto.randomUUID(), method: rows.length ? 'UPI' : 'CASH',
    amountStr: amount > 0 ? amount.toFixed(2) : '',
  });
  function selectSplit(next: boolean) {
    setSplit(next);
    setConfirmedAllocation('');
    if (next && !rows.length) setRows([addRow(due || 0)]);
  }
  async function confirmPayment() {
    if (locked || !attempt || !received || noPayment || !balanced) return;
    const ack = await table.command('PAY_CONFIRM', { orderId: session.orderId, attemptId: attempt.id, received: true, payments: tenderRows });
    if (ack) await onSettled();
  }
  const complimentary = !split && method === 'COMPLIMENTARY';
  return (
    <fieldset disabled={locked} aria-label={attempt ? 'Frozen payment' : 'Table payment'}>
      {attempt && <p className="bill-preview-note">Payment pending · ₹{Number(attempt.amount).toFixed(2)}. Check the original tender before confirming or cancelling.</p>}
      <PaymentPanel isSplitPayment={split} splitToggleDisabled={false}
        razorpayPaymentLocked={false} setupPaymentMethods={methods} paymentMethod={method}
        splitPayments={rows} SPLIT_PAYMENT_METHODS={TABLE_TENDERS} singleSplitRow={rows.length <= 1}
        grandTotal={due ?? 0} splitAllocatedAmount={allocated} splitBalanceAmount={paymentBalance(due ?? 0, allocated)}
        splitPaymentBalanced={balanced} setSplitPaymentMode={selectSplit}
        onSelectMethod={next => { setChoice(next); setConfirmedAllocation(''); }}
        updateSplitPayment={(id, changes) => {setRows(previous => previous.map(row => row.id === id ? {...row, ...changes} : row)); setConfirmedAllocation('');}}
        removeSplitPaymentRow={id => {setRows(previous => previous.filter(row => row.id !== id)); setConfirmedAllocation('');}}
        addSplitPaymentRow={() => {if (rows.length < 6) setRows([...rows, addRow(Math.max(0, (due ?? 0) - allocated))]); setConfirmedAllocation('');}}
        maxSplitRows={6}
        blurInputOnEnter={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
        singlePaymentDetails={complimentary ? <TableComplimentaryClosing key={session.version} table={table} onSettled={onSettled}/> : null}
        checkoutAction={complimentary ? null : attempt ? (
          <>
            <label><input type="checkbox" checked={received} disabled={!balanced || noPayment}
              onChange={event => setConfirmedAllocation(event.target.checked ? allocationKey : '')}/> I confirm the payment was received</label>
            <button className="bill-checkout" type="button" disabled={!received || !balanced || noPayment} onClick={() => void confirmPayment()}>
              Confirm received payment · ₹{Number(attempt.amount).toFixed(2)}
            </button>
            <label><input type="checkbox" checked={noPayment} disabled={received}
              onChange={event => setCancelAttempt(event.target.checked ? attempt.id : '')}/> No payment was received</label>
            <button type="button" disabled={!noPayment || received} onClick={() => void table.command('PAY_CANCEL', {
              orderId: session.orderId, attemptId: attempt.id, confirmNoPaymentReceived: true,
            })}>Cancel unpaid attempt</button>
          </>
        ) : (
          <>
            {discountPercent !== Number(session.saved?.order?.discountPercent || 0) && <p className="bill-preview-note">
              The server applies the selected discount when checkout starts. Review the final amount before collecting payment.
            </p>}
            <button className="bill-checkout" type="button" disabled={!balanced}
              onClick={() => void table.command('PAY_BEGIN', { orderId: session.orderId, discountPercent })}>Checkout · review amount</button>
          </>
        )}
      />
    </fieldset>
  );
}
