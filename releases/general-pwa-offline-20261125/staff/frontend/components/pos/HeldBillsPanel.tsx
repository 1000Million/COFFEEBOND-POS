import React from 'react';
import type { HeldBill } from '../../lib/pos/posOrderLifecycle';
export interface HeldBillsPanelProps {
  heldBills: HeldBill[];
  recallHeldBill: (bill: HeldBill) => void;
  deleteHeldBill: (bill: HeldBill) => void;
}
export default function HeldBillsPanel({ heldBills, recallHeldBill, deleteHeldBill }: HeldBillsPanelProps) {
  return (
                        <div className="absolute left-0 top-[calc(100%+0.5rem)] z-30 w-72 max-w-[calc(100vw-2.5rem)] rounded-3xl border border-[#eadfd4] bg-white p-3 shadow-[0_18px_40px_rgba(62,39,35,0.14)]">
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <p className="text-[11px] font-black uppercase tracking-[0.12em] text-[#8a6a58]">Held bills</p>
                            <span className="rounded-full bg-[#f5efe7] px-2 py-0.5 text-[10px] font-black text-[#8a6a58]">
                              {heldBills.length}
                            </span>
                          </div>
                          <div className="space-y-2">
                            {heldBills.map(bill => (
                              <div key={bill.id} className="rounded-2xl border border-[#efe4d9] bg-[#fcfaf7] px-3 py-2.5">
                                <div className="min-w-0">
                                  <p className="break-words text-[12px] font-black text-neutral-800">{bill.customerName || 'Walk-in guest'}</p>
                                  <p className="mt-0.5 text-[10px] text-neutral-500">
                                    {new Date(bill.heldAtIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} • {bill.itemCount} items • ₹{bill.total.toFixed(2)}
                                  </p>
                                </div>
                                <div className="mt-2 grid grid-cols-2 gap-2">
                                  <button
                                    onClick={() => recallHeldBill(bill)}
                                    className="rounded-xl bg-[#5c4033] px-3 py-1.5 text-[11px] font-black text-white hover:bg-[#4a332a]"
                                  >
                                    Recall
                                  </button>
                                  <button
                                    onClick={() => deleteHeldBill(bill)}
                                    className="rounded-xl border border-red-100 bg-red-50 px-3 py-1.5 text-[11px] font-black text-red-600 hover:bg-red-100"
                                  >
                                    Delete
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
  );
}
