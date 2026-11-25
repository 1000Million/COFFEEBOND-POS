import { useState } from 'react';

export default function PosOfflineCashPayment({ total, busy, onSave }: {
  total: number;
  busy: boolean;
  onSave: (cashReceived: number) => void;
}) {
  const [cash, setCash] = useState('');
  const received = Number(cash);
  const valid = cash !== '' && Number.isFinite(received) && received >= total - 0.000001;

  return (
    <section aria-label="Offline Cash payment" className="my-2 space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
      <div className="flex justify-between gap-2 font-bold"><span>Offline Cash due</span><span>₹{total.toFixed(2)}</span></div>
      <label className="flex flex-wrap items-center justify-between gap-2">
        Cash received
        <input className="w-28 rounded-md border border-amber-300 bg-white px-2 py-1.5 text-right"
          type="number" inputMode="decimal" min="0" step="0.01" value={cash}
          disabled={busy} onChange={event => setCash(event.target.value)} />
      </label>
      {valid && <p className="text-xs">Change ₹{Math.max(0, received - total).toFixed(2)}</p>}
      <p className="text-xs">Confirm only after receiving Cash. UPI, Card, Razorpay, split payments and Complimentary approval require a connection. The provisional receipt stays on this device until synced.</p>
      <button type="button" disabled={busy || !valid}
        className="w-full rounded-xl bg-[#3e2723] px-3 py-2 font-bold text-white disabled:bg-neutral-200 disabled:text-neutral-600"
        onClick={() => onSave(received)}>
        {busy ? 'Saving Cash bill…' : 'Cash received · Save bill'}
      </button>
    </section>
  );
}
