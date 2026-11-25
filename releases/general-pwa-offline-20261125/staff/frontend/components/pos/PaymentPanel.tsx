import React from 'react';
import { Trash2 } from 'lucide-react';
import type { PaymentMethod } from '../../types';
import type { SplitPaymentRow } from '../../lib/pos/posOrderLifecycle';
export interface PaymentPanelProps {
  isSplitPayment: boolean;
  splitToggleDisabled: boolean;
  razorpayPaymentLocked: boolean;
  setupPaymentMethods: PaymentMethod[];
  paymentMethod: PaymentMethod | '';
  splitPayments: SplitPaymentRow[];
  SPLIT_PAYMENT_METHODS: PaymentMethod[];
  singleSplitRow: boolean;
  maxSplitRows?: number;
  grandTotal: number;
  splitAllocatedAmount: number;
  splitBalanceAmount: number;
  splitPaymentBalanced: boolean;
  setSplitPaymentMode: (enabled: boolean) => void;
  onSelectMethod: (method: PaymentMethod) => void;
  updateSplitPayment: (id: string, changes: Partial<SplitPaymentRow>) => void;
  removeSplitPaymentRow: (id: string) => void;
  addSplitPaymentRow: () => void;
  blurInputOnEnter: React.KeyboardEventHandler<HTMLInputElement>;
  singlePaymentDetails: React.ReactNode;
  checkoutAction: React.ReactNode;
}
export default function PaymentPanel({ isSplitPayment, splitToggleDisabled, razorpayPaymentLocked,
  setupPaymentMethods, paymentMethod, splitPayments, SPLIT_PAYMENT_METHODS, singleSplitRow, maxSplitRows, grandTotal,
  splitAllocatedAmount, splitBalanceAmount, splitPaymentBalanced, setSplitPaymentMode, onSelectMethod,
  updateSplitPayment, removeSplitPaymentRow, addSplitPaymentRow, blurInputOnEnter,
  singlePaymentDetails, checkoutAction }: PaymentPanelProps) {
  return (
          <div className="mt-2 space-y-2 border-t border-[#eadfd4] pt-2">
            <div className="flex items-center justify-between gap-2">
              <label className="block text-[10px] font-black uppercase tracking-[0.14em] text-neutral-500">Payment</label>
              <button
                aria-pressed={isSplitPayment}
                onClick={() => setSplitPaymentMode(!isSplitPayment)}
                disabled={splitToggleDisabled}
                className={`rounded-full border px-2.5 py-1 text-[10px] font-black transition-colors ${
                  isSplitPayment
                    ? 'border-[#5c4033] bg-[#5c4033] text-white'
                    : 'border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50'
                } disabled:cursor-not-allowed disabled:opacity-40`}
              >
                {isSplitPayment ? 'Single' : 'Split'}
              </button>
            </div>

            {!isSplitPayment ? (
              <>
                <div className="min-w-0">
                  <div className="flex flex-wrap gap-1.5">
                  {setupPaymentMethods.map(method => (
                    <button
                      key={method}
                      aria-pressed={paymentMethod === method}
                      onClick={() => onSelectMethod(method)}
                      disabled={razorpayPaymentLocked}
                      className={`min-h-[30px] min-w-[58px] rounded-full border px-2.5 py-1 text-[9px] font-black transition-all ${
                        paymentMethod === method
                          ? 'border-[#5c4033] bg-[#5c4033] text-white shadow-sm'
                          : 'border-[#eadfd4] bg-white text-neutral-600 hover:bg-neutral-50'
                      }`}
                    >
                      <span className="mx-auto block truncate -tracking-wider uppercase">
                        {method === 'COMPLIMENTARY' ? 'COMP' : method}
                      </span>
                    </button>
                  ))}
                  </div>
                </div>
                {singlePaymentDetails}
              </>
            ) : (
              <div className="space-y-2">
                <div className="space-y-1.5">
                  {splitPayments.map((payment, index) => (
                    <div key={payment.id} className="grid min-w-0 grid-cols-1 gap-1.5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center">
                      <select
                        value={payment.method}
                        onChange={event => updateSplitPayment(payment.id, { method: event.target.value as PaymentMethod })}
                        className="min-w-0 rounded-2xl border border-[#eadfd4] bg-white px-2.5 py-1.5 text-[11px] font-bold text-neutral-700 outline-none focus:border-[#5c4033]"
                        aria-label={`Payment method ${index + 1}`}
                      >
                        {SPLIT_PAYMENT_METHODS.map(method => (
                          <option key={method} value={method}>{method}</option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={payment.amountStr}
                        inputMode="decimal"
                        enterKeyHint="done"
                        onKeyDown={blurInputOnEnter}
                        onChange={event => updateSplitPayment(payment.id, { amountStr: event.target.value })}
                        className="min-w-0 rounded-2xl border border-[#eadfd4] bg-white px-2.5 py-1.5 text-right text-[11px] font-mono font-bold text-neutral-700 outline-none focus:border-[#5c4033]"
                        placeholder="0.00"
                        aria-label={`Payment amount ${index + 1}`}
                      />
                      <button
                        onClick={() => removeSplitPaymentRow(payment.id)}
                        disabled={singleSplitRow}
                        className={`rounded-2xl border px-2 py-1.5 text-[11px] font-black ${
                          singleSplitRow
                            ? 'cursor-not-allowed border-neutral-100 bg-neutral-50 text-neutral-300'
                            : 'border-red-100 bg-red-50 text-red-600 hover:bg-red-100'
                        }`}
                        aria-label={`Remove payment row ${index + 1}`}
                        title="Remove payment row"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  disabled={maxSplitRows !== undefined && splitPayments.length >= maxSplitRows}
                  onClick={addSplitPaymentRow}
                  className="w-full rounded-2xl border border-dashed border-[#5c4033]/40 bg-[#5c4033]/5 px-3 py-2 text-[11px] font-black text-[#5c4033] hover:bg-[#5c4033]/10"
                >
                  Add Payment Row
                </button>
                <div className="space-y-0.5 rounded-2xl bg-white px-3 py-2 text-[11px] font-bold text-neutral-600">
                  <div className="flex justify-between">
                    <span>Total Due</span>
                    <span className="font-mono">₹{grandTotal.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Amount Allocated</span>
                    <span className="font-mono">₹{splitAllocatedAmount.toFixed(2)}</span>
                  </div>
                  <div className={`flex justify-between ${splitPaymentBalanced ? 'text-emerald-700' : 'text-red-700'}`}>
                    <span>Balance Remaining</span>
                    <span className="font-mono">₹{splitBalanceAmount.toFixed(2)}</span>
                  </div>
                </div>
              </div>
            )}

            {checkoutAction}
          </div>
  );
}
