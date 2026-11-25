import React from 'react';
import { customerMobile } from '../../lib/pos/customerMobile';
import { motion, AnimatePresence } from 'motion/react';
import { Trash2, Plus, Minus, MapPin, User, Phone } from 'lucide-react';
import type { CartItem, OrderType } from '../../types';
export interface CartPanelProps {
  cart: { item: CartItem; unitPrice: number; lineTotal: number }[];
  orderType: OrderType;
  isComplimentarySelected: boolean;
  tableNumber: string;
  tableNumberError: string | null;
  customerName: string;
  customerPhone: string;
  contactLocked?: boolean;
  QUICK_TABLE_CHIPS: readonly string[];
  editCartItemAddOns: (item: CartItem) => void;
  onRemove: (item: CartItem) => void;
  onDecrease: (item: CartItem) => void;
  onIncrease: (item: CartItem) => void;
  onDuplicate: (item: CartItem) => void;
  blurInputOnEnter: React.KeyboardEventHandler<HTMLInputElement>;
  onTableNumberChange: (value: string) => void;
  onTableNumberBlur: () => void;
  onTableChip: (value: string) => void;
  onTakeaway: () => void;
  onWalkIn: () => void;
  setCustomerName: (value: string) => void;
  onPhoneChange: (value: string) => void;
}
export default function CartPanel({ cart, orderType, isComplimentarySelected, tableNumber, tableNumberError,
  customerName, customerPhone, contactLocked = false, QUICK_TABLE_CHIPS, editCartItemAddOns, onRemove, onDecrease, onIncrease,
  onDuplicate, blurInputOnEnter, onTableNumberChange, onTableNumberBlur, onTableChip, onTakeaway,
  onWalkIn, setCustomerName, onPhoneChange }: CartPanelProps) {
  const mobileError = customerMobile(customerPhone).error;
  return (
    <>
          <div className="mt-3">
            {cart.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[#eadfd4] bg-[#fbf8f3] px-4 py-3 text-center">
                <p className="text-xs font-semibold text-neutral-500">Tap a tile to start.</p>
              </div>
            ) : (
              <div className="divide-y divide-[#efe4d9] border-y border-[#efe4d9]">
                <AnimatePresence initial={false} mode="popLayout">
                  {cart.map(({ item, unitPrice, lineTotal }) => (
                    <motion.div
                      key={item.id}
                      layout
                      initial={{ opacity: 0, x: 20, height: 0 }}
                      animate={{ opacity: 1, x: 0, height: "auto" }}
                      exit={{ opacity: 0, x: -20, height: 0 }}
                      transition={{ type: "spring" as const, stiffness: 500, damping: 40 }}
                      className="py-2.5"
                    >
                      <div className="flex min-w-0 items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="line-clamp-2 break-words text-[13px] font-black leading-snug text-[#2d1c19]">{item.name}</p>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-neutral-500">
                            <span>₹{unitPrice.toFixed(2)} each</span>
                            {(item.addOns || []).length > 0 && (
                              <button
                                type="button"
                                onClick={() => editCartItemAddOns(item)}
                                className="font-black text-[#8a5a44] underline underline-offset-2"
                              >
                                Edit add-ons
                              </button>
                            )}
                          </div>
                          {(item.addOns || []).length > 0 && (
                            <div className="mt-1 space-y-0.5 pl-2 text-[11px] font-semibold text-neutral-500">
                              {item.addOns!.map(addOn => (
                                <p key={`${addOn.groupId}-${addOn.optionId}`}>
                                  + {addOn.optionName}{addOn.quantity > 1 ? ` × ${addOn.quantity}` : ''} · ₹{addOn.totalPrice.toFixed(2)}
                                </p>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="font-mono text-sm font-black text-[#3e2723]">
                            ₹{lineTotal.toFixed(2)}
                          </p>
                          <button
                            onClick={() => onRemove(item)}
                            aria-label={`Remove ${item.name}`}
                            title={`Remove ${item.name}`}
                            className="mt-1 text-[11px] font-black text-red-500 transition-colors hover:text-red-600"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                        <div className="inline-flex items-center rounded-full border border-[#eadfd4] bg-white px-1 py-1 shadow-sm">
                          <button
                            onClick={() => onDecrease(item)}
                            aria-label={item.quantity === 1 ? `Remove ${item.name}` : `Decrease ${item.name}`}
                            title={item.quantity === 1 ? `Remove ${item.name}` : `Decrease ${item.name}`}
                            className="flex h-7 w-7 items-center justify-center rounded-full text-neutral-600 transition-colors hover:bg-neutral-100"
                          >
                            {item.quantity === 1 ? <Trash2 size={14} className="text-red-500" /> : <Minus size={14} />}
                          </button>
                          <span className="w-8 text-center font-mono text-sm font-black text-[#2d1c19]">{item.quantity}</span>
                          <button
                            onClick={() => onIncrease(item)}
                            aria-label={`Increase ${item.name}`}
                            title={`Increase ${item.name}`}
                            className="flex h-7 w-7 items-center justify-center rounded-full text-[#5c4033] transition-colors hover:bg-[#5c4033]/10"
                          >
                            <Plus size={14} />
                          </button>
                        </div>
                        <button
                          onClick={() => onDuplicate(item)}
                          aria-label={`Duplicate ${item.name}`}
                          title={`Duplicate ${item.name}`}
                          className="rounded-full border border-[#eadfd4] bg-white px-3 py-1.5 text-[11px] font-black text-[#5c4033] transition-colors hover:bg-[#fff8ed]"
                        >
                          x2
                        </button>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            )}
          </div>

          <div className="mt-3 border-t border-[#eadfd4] pt-3">
            {orderType === 'DINE_IN' ? (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-[#f5efe7] px-3 py-1 text-[10px] font-black uppercase tracking-[0.12em] text-[#8a6a58]">
                    Dine in
                  </span>
                  <div className={`flex min-h-[40px] min-w-[160px] flex-1 items-center gap-2 rounded-full border px-3 py-2 ${
                    tableNumberError ? 'border-red-300 bg-red-50/70' : 'border-[#eadfd4] bg-white'
                  }`}>
                    <MapPin size={14} className={tableNumberError ? 'text-red-500' : 'text-neutral-400'} />
                    <input
                      type="text"
                      placeholder="Table number"
                      value={tableNumber}
                      inputMode="numeric"
                      enterKeyHint="done"
                      onKeyDown={blurInputOnEnter}
                      onChange={e => onTableNumberChange(e.target.value)}
                      onBlur={onTableNumberBlur}
                      className="w-full bg-transparent text-sm font-medium outline-none placeholder-neutral-400"
                    />
                  </div>
                </div>
                {tableNumberError && (
                  <p className="px-1 text-[11px] font-bold text-red-600">{tableNumberError}</p>
                )}
                <div className="overflow-x-auto custom-scrollbar">
                  <div className="flex min-w-max gap-1.5 pb-1">
                    {QUICK_TABLE_CHIPS.map(tableChip => (
                      <button
                        key={tableChip}
                        type="button"
                        onClick={() => onTableChip(tableChip)}
                        className="rounded-full border border-[#eadfd4] bg-white px-3 py-1.5 text-[10px] font-black text-[#5c4033] transition hover:bg-[#fff8ed]"
                      >
                        Table {tableChip}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={onTakeaway}
                      className="rounded-full border border-[#eadfd4] bg-white px-3 py-1.5 text-[10px] font-black text-[#5c4033] transition hover:bg-[#fff8ed]"
                    >
                      Takeaway
                    </button>
                  </div>
                </div>
              </div>
            ) : !isComplimentarySelected ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[11px] font-black uppercase tracking-[0.14em] text-[#8a6a58]">Customer</p>
                  <button
                    type="button"
	                    onClick={onWalkIn}
                    className="rounded-full border border-[#eadfd4] bg-white px-3 py-1.5 text-[10px] font-black text-[#5c4033] transition hover:bg-[#fff8ed]"
                  >
                    Walk-in
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div className="flex min-h-[40px] items-center gap-2 rounded-full border border-[#eadfd4] bg-white px-3 py-2">
                    <User size={15} className="shrink-0 text-neutral-400" />
                    <input
                      type="text"
                      placeholder="Name"
                      value={customerName}
                      onChange={e => setCustomerName(e.target.value)}
                      className="w-full bg-transparent text-sm font-medium outline-none placeholder-neutral-400"
                    />
                  </div>

                </div>
              </div>
            ) : null}
            {!isComplimentarySelected && <div className="mt-3">
              <label htmlFor="pos-customer-mobile" className="mb-1 block text-xs font-bold text-[#5c4033]">Mobile (optional)</label>
              <div className="flex min-h-[44px] items-center gap-2 rounded-xl border border-[#eadfd4] bg-white px-3 py-2">
                <Phone size={15} className="shrink-0 text-neutral-500"/>
                <input id="pos-customer-mobile" disabled={contactLocked} type="tel" inputMode="tel" autoComplete="off" placeholder="+91 mobile number" value={customerPhone} onChange={e=>onPhoneChange(e.target.value)} aria-invalid={Boolean(mobileError)} aria-describedby="pos-mobile-help pos-mobile-error" className="w-full bg-transparent text-sm outline-none focus-visible:ring-2 focus-visible:ring-[#5c4033]"/>
              </div>
              <p id="pos-mobile-help" className="mt-1 text-xs text-neutral-600">Unverified · for this bill only. No loyalty or marketing permission.</p>
              {mobileError && <p id="pos-mobile-error" role="alert" className="mt-1 text-xs font-semibold text-red-700">{mobileError}</p>}
            </div>}
          </div>
    </>
  );
}
