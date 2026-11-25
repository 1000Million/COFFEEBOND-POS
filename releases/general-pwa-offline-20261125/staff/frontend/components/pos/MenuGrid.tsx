import React from 'react';
import { motion } from 'motion/react';
import { AlertCircle, Coffee, Plus } from 'lucide-react';
import type { MenuItem } from '../../types';
export interface MenuTileView {
  item: MenuItem;
  classification: { category: { name: string }; subcategory?: { name: string } | null };
  tone: { badge: string; icon: string };
  quantityInCart: number;
  showContext: boolean;
  breadcrumb: string;
  stationLabel: string;
}
export interface MenuGridProps {
  isMenuEmpty: boolean;
  isViewEmpty: boolean;
  menuSections: { id: string; label?: string; items: MenuTileView[] }[];
  onAddItem: (item: MenuItem) => void;
}
export default function MenuGrid({ isMenuEmpty, isViewEmpty, menuSections, onAddItem }: MenuGridProps) {
  return (
<>
            {isMenuEmpty ? (
              <div className="flex min-h-[280px] flex-col items-center justify-center rounded-[28px] border border-dashed border-[#dccfc2] bg-white px-6 py-8 text-center text-neutral-500">
                <AlertCircle size={44} className="mb-4 text-amber-500/70" />
                <p className="text-lg font-black text-neutral-700">No active menu items found</p>
                <p className="mt-2 max-w-sm text-sm font-medium text-neutral-500">
                  An Admin can restore active finished goods from Menu Management before billing starts here.
                </p>
              </div>
            ) : isViewEmpty ? (
              <div className="flex min-h-[260px] flex-col items-center justify-center rounded-[28px] border border-dashed border-[#dccfc2] bg-white px-6 py-8 text-center text-neutral-500">
                <Coffee size={42} className="mb-4 text-[#8a6a58]/70" />
                <p className="text-lg font-black text-neutral-700">No items match this view</p>
                <p className="mt-2 max-w-sm text-sm font-medium text-neutral-500">
                  Try a different category, clear the search, or review POS Readiness if this store should have more items.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {menuSections.map(section => (
                  <section key={section.id} className="space-y-2">
                    {section.label && (
                      <div className="flex items-center gap-3">
                        <h3 className="text-sm font-black text-[#2d1c19]">{section.label}</h3>
                        <div className="h-px flex-1 bg-[#e8ddd2]" />
                        <span className="text-[10px] font-bold text-neutral-400">{section.items.length}</span>
                      </div>
                    )}
                    <div className="grid min-w-0 grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                      {section.items.map(row => {
                        const { item, classification, tone, quantityInCart, showContext, breadcrumb, stationLabel } = row;
                        return (
                          <motion.button
                            key={item.id}
                            type="button"
                            aria-label={`Add ${item.name}, ₹${Number(item.price).toFixed(2)} each${quantityInCart > 0 ? `, ${quantityInCart} in current sale` : ''}`}
                            whileHover={{ scale: 1.015, y: -2 }}
                            whileTap={{ scale: 0.985 }}
                            onClick={() => onAddItem(item)}
                            className="group flex min-h-[108px] min-w-0 flex-col justify-between rounded-2xl border border-[#eadfd4] bg-white p-2.5 text-left shadow-[0_6px_16px_rgba(62,39,35,0.05)] transition-all hover:border-[#5c4033]/25 hover:bg-[#fffaf4] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#5c4033] sm:min-h-[112px] sm:p-3"
                          >
                            <div className="flex min-w-0 items-start justify-between gap-2">
                              {showContext ? (
                                <span className={`min-w-0 truncate rounded-full px-2 py-1 text-[9px] font-black ${tone.badge}`} title={breadcrumb}>
                                  {breadcrumb}
                                </span>
                              ) : (
                                <span className="text-[9px] font-black uppercase tracking-[0.08em] text-neutral-400">
                                  {classification.subcategory?.name || classification.category.name}
                                </span>
                              )}
                              <span className="flex shrink-0 items-center gap-1.5">
                              {quantityInCart > 0 && (
                                <span className="shrink-0 rounded-full bg-[#3e2723] px-2 py-1 text-[9px] font-black text-white">
                                  {quantityInCart} in sale
                                </span>
                              )}
                              <Plus aria-hidden="true" size={15} className={`shrink-0 ${tone.icon}`} strokeWidth={2.8} />
                              </span>
                            </div>
                            <div className="min-w-0 flex-1 pt-1.5 sm:pt-2">
                              <h4 className="line-clamp-2 text-[13px] font-black leading-snug text-[#2d1c19]">{item.name}</h4>
                            </div>
                            <div className="flex items-end justify-between gap-2 pt-1.5 sm:pt-2">
                              <p className="font-mono text-[15px] font-black text-[#3e2723]">₹{item.price}</p>
                              {item.prepStation && item.prepStation !== 'NONE' && (
                                <span className="rounded-full bg-neutral-100 px-2 py-1 text-[9px] font-black text-neutral-500">
                                  {stationLabel}
                                </span>
                              )}
                            </div>
                          </motion.button>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            )}
</>
  );
}
