import React, { useEffect, useMemo, useState } from 'react';
import { addDoc, collection, doc, getDoc, getDocs, query, serverTimestamp, where } from 'firebase/firestore';
import { AlertCircle, CheckCircle2, Coffee, Minus, Plus, Search, ShoppingBag, Store as StoreIcon, Trash2 } from 'lucide-react';
import { db } from '../../lib/firebase';
import { OnlineOrder, OnlineOrderItem, OnlineOrderType, Store } from '../../types';
import { FinishedGood } from '../../types/menu-management';

type CustomerMenuItem = FinishedGood & { id: string };

type CartLine = {
  item: CustomerMenuItem;
  quantity: number;
};

type GstConfig = {
  defaultRate: number;
  storeOverrides: Record<string, number>;
};

const APP_TAX_RATE_KEYS = ['defaultGstRate', 'gstRate', 'taxRate', 'defaultTaxRate', 'defaultGSTPercent', 'gstPercent', 'taxPercent'];
const STORE_TAX_RATE_KEYS = ['gstRate', 'taxRate', 'defaultGstRate', 'defaultTaxRate', 'gstPercent', 'taxPercent'];
const ITEM_TAX_RATE_KEYS = ['taxRate', 'gstRate', 'taxPercent', 'gstPercent'];

function toNumber(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function pickTaxRate(data: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const rate = toNumber(data[key]);
    if (rate > 0) return rate;
  }
  return 0;
}

function normalizeStoreOverrides(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, number>>((acc, [key, rawRate]) => {
    const rate = toNumber(rawRate);
    if (rate > 0) acc[key] = rate;
    return acc;
  }, {});
}

function storeTaxRate(store: Store | null, gstConfig: GstConfig): number {
  if (!store) return gstConfig.defaultRate;
  const override = gstConfig.storeOverrides[store.id] || gstConfig.storeOverrides[store.code];
  if (override > 0) return override;
  const storeRate = pickTaxRate(store as unknown as Record<string, unknown>, STORE_TAX_RATE_KEYS);
  return storeRate > 0 ? storeRate : gstConfig.defaultRate;
}

function itemTaxRate(item: CustomerMenuItem, fallbackRate: number): number {
  const itemRate = pickTaxRate(item as unknown as Record<string, unknown>, ITEM_TAX_RATE_KEYS);
  return itemRate > 0 ? itemRate : fallbackRate;
}

function isStoreAvailable(item: CustomerMenuItem, storeId: string): boolean {
  return Array.isArray(item.availableStoreIds) && item.availableStoreIds.includes(storeId);
}

function isClearlyUnavailable(item: CustomerMenuItem, storeId: string): boolean {
  if (!item.isActive || !item.isSellable || item.isAvailable === false || !isStoreAvailable(item, storeId)) return true;
  if (item.itemType !== 'NO_STOCK' && item.itemType !== 'DIRECT_STOCK' && (!Array.isArray(item.bom) || item.bom.length === 0)) return true;
  return false;
}

function formatMoney(value: number): string {
  return `₹${value.toFixed(2)}`;
}

export default function CustomerOrder() {
  const [stores, setStores] = useState<Store[]>([]);
  const [items, setItems] = useState<CustomerMenuItem[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('ALL');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [orderType, setOrderType] = useState<OnlineOrderType>('PICKUP');
  const [notes, setNotes] = useState('');
  const [gstConfig, setGstConfig] = useState<GstConfig>({ defaultRate: 0, storeOverrides: {} });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ id: string; storeName: string; total: number } | null>(null);

  useEffect(() => {
    let active = true;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const [storeSnap, itemSnap, gstSnap] = await Promise.all([
          getDocs(query(collection(db, 'stores'), where('isActive', '==', true))),
          getDocs(query(
            collection(db, 'finishedGoods'),
            where('isActive', '==', true),
            where('isSellable', '==', true),
            where('isAvailable', '==', true),
          )),
          getDoc(doc(db, 'appSettings', 'gstConfig')),
        ]);

        if (!active) return;

        const loadedStores = storeSnap.docs.map(storeDoc => ({ id: storeDoc.id, ...storeDoc.data() } as Store))
          .sort((a, b) => a.name.localeCompare(b.name));
        const loadedItems = itemSnap.docs.map(itemDoc => ({ id: itemDoc.id, ...itemDoc.data() } as CustomerMenuItem))
          .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.displayName || a.name).localeCompare(b.displayName || b.name));
        const gstData = gstSnap.exists() ? gstSnap.data() as Record<string, unknown> : {};

        setStores(loadedStores);
        setItems(loadedItems);
        setSelectedStoreId(prev => prev || loadedStores[0]?.id || '');
        setGstConfig({
          defaultRate: pickTaxRate(gstData, APP_TAX_RATE_KEYS),
          storeOverrides: normalizeStoreOverrides(gstData.storeOverrides),
        });
      } catch (err) {
        console.error('Failed to load customer order menu', err);
        if (active) setError('We could not load the ordering menu right now. Please try again shortly.');
      } finally {
        if (active) setLoading(false);
      }
    };

    load();
    return () => {
      active = false;
    };
  }, []);

  const selectedStore = useMemo(() => stores.find(store => store.id === selectedStoreId) || null, [stores, selectedStoreId]);
  const selectedStoreTaxRate = useMemo(() => storeTaxRate(selectedStore, gstConfig), [selectedStore, gstConfig]);

  const availableItems = useMemo(() => {
    if (!selectedStoreId) return [];
    return items.filter(item => !isClearlyUnavailable(item, selectedStoreId));
  }, [items, selectedStoreId]);

  const categories = useMemo(() => {
    const names = Array.from(new Set(availableItems.map(item => item.posCategoryName || 'Other')));
    return ['ALL', ...names.sort((a, b) => a.localeCompare(b))];
  }, [availableItems]);

  const visibleItems = useMemo(() => {
    const searchText = search.trim().toLowerCase();
    return availableItems.filter(item => {
      const matchesCategory = category === 'ALL' || (item.posCategoryName || 'Other') === category;
      const name = `${item.displayName || item.name} ${item.code} ${item.description || ''}`.toLowerCase();
      return matchesCategory && (!searchText || name.includes(searchText));
    });
  }, [availableItems, category, search]);

  const totals = useMemo(() => {
    const subtotal = cart.reduce((sum, line) => sum + toNumber(line.item.salePrice) * line.quantity, 0);
    const gstTotal = cart.reduce((sum, line) => {
      const rate = itemTaxRate(line.item, selectedStoreTaxRate);
      return sum + (toNumber(line.item.salePrice) * line.quantity * rate / 100);
    }, 0);
    return {
      subtotal,
      taxableAmount: subtotal,
      gstTotal,
      grandTotal: subtotal + gstTotal,
    };
  }, [cart, selectedStoreTaxRate]);

  const itemCount = cart.reduce((sum, line) => sum + line.quantity, 0);

  const setCartQuantity = (item: CustomerMenuItem, quantity: number) => {
    const nextQty = Math.max(0, quantity);
    setCart(prev => {
      if (nextQty === 0) return prev.filter(line => line.item.code !== item.code);
      const existing = prev.find(line => line.item.code === item.code);
      if (existing) {
        return prev.map(line => line.item.code === item.code ? { ...line, quantity: nextQty } : line);
      }
      return [...prev, { item, quantity: nextQty }];
    });
  };

  const submitOrder = async () => {
    if (!selectedStore) return setError('Please select a store.');
    if (cart.length === 0) return setError('Please add at least one item.');
    if (!customerName.trim()) return setError('Please enter your name.');
    if (!customerPhone.trim()) return setError('Please enter your phone number.');

    setSaving(true);
    setError(null);
    try {
      const onlineItems: OnlineOrderItem[] = cart.map(line => {
        const rate = itemTaxRate(line.item, selectedStoreTaxRate);
        const unitPrice = toNumber(line.item.salePrice);
        const lineSubtotal = unitPrice * line.quantity;
        const lineTax = lineSubtotal * rate / 100;
        return {
          finishedGoodCode: line.item.code,
          itemName: line.item.displayName || line.item.name,
          categoryId: line.item.posCategoryCode || 'MISC',
          categoryName: line.item.posCategoryName || 'Other',
          quantity: line.quantity,
          unitPrice,
          taxRate: rate,
          lineSubtotal,
          lineTaxable: lineSubtotal,
          lineTax,
          lineTotal: lineSubtotal + lineTax,
          prepStation: line.item.prepStation,
          itemType: line.item.itemType,
        };
      });

      const payload: Omit<OnlineOrder, 'id'> = {
        storeId: selectedStore.id,
        storeName: selectedStore.name,
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim(),
        orderType,
        notes: notes.trim(),
        items: onlineItems,
        subtotal: totals.subtotal,
        taxableAmount: totals.taxableAmount,
        gstTotal: totals.gstTotal,
        grandTotal: totals.grandTotal,
        status: 'PENDING',
        source: 'CUSTOMER_WEB',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      const orderRef = await addDoc(collection(db, 'onlineOrders'), payload);
      setConfirmation({ id: orderRef.id, storeName: selectedStore.name, total: totals.grandTotal });
      setCart([]);
      setNotes('');
    } catch (err) {
      console.error('Failed to submit online order', err);
      setError('We could not send your order request. Please try again or call the store.');
    } finally {
      setSaving(false);
    }
  };

  if (confirmation) {
    return (
      <div className="min-h-[100dvh] bg-[#f9f5f0] px-4 py-8 font-sans text-neutral-900">
        <div className="mx-auto max-w-lg rounded-3xl border border-emerald-200 bg-white p-8 shadow-sm text-center">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
            <CheckCircle2 size={30} />
          </div>
          <h1 className="text-2xl font-black text-[#3e2723]">Order request received</h1>
          <p className="mt-3 text-sm text-neutral-600">Store will confirm your order shortly. Please pay at the counter when requested.</p>
          <div className="mt-6 rounded-2xl bg-neutral-50 p-4 text-left text-sm">
            <p><span className="font-bold">Reference:</span> {confirmation.id}</p>
            <p><span className="font-bold">Store:</span> {confirmation.storeName}</p>
            <p><span className="font-bold">Total:</span> {formatMoney(confirmation.total)}</p>
          </div>
          <button
            onClick={() => setConfirmation(null)}
            className="mt-6 w-full rounded-xl bg-[#5c4033] px-4 py-3 text-sm font-black text-white"
          >
            Place another order
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-[#f9f5f0] font-sans text-neutral-900">
      <header className="border-b border-amber-100 bg-white/90 px-4 py-4 sticky top-0 z-20 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#5c4033] text-white">
              <Coffee size={22} />
            </div>
            <div>
              <h1 className="text-xl font-black text-[#3e2723]">Coffee Bond Order</h1>
              <p className="text-xs font-bold uppercase tracking-widest text-amber-700">Pickup and dine-in requests</p>
            </div>
          </div>
          <div className="rounded-full bg-amber-50 px-4 py-2 text-sm font-black text-[#5c4033]">
            {itemCount} items
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-5 px-4 py-5 lg:grid-cols-[1fr_360px]">
        <section className="space-y-4">
          <div className="grid gap-3 rounded-3xl border border-amber-100 bg-white p-4 shadow-sm md:grid-cols-[240px_1fr]">
            <label className="text-sm font-bold">
              Store
              <span className="mt-1 flex items-center gap-2 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2">
                <StoreIcon size={16} className="text-neutral-400" />
                <select
                  value={selectedStoreId}
                  onChange={(event) => {
                    setSelectedStoreId(event.target.value);
                    setCart([]);
                    setCategory('ALL');
                  }}
                  className="w-full bg-transparent text-sm font-bold outline-none"
                >
                  {stores.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}
                </select>
              </span>
            </label>
            <label className="text-sm font-bold">
              Search menu
              <span className="mt-1 flex items-center gap-2 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2">
                <Search size={16} className="text-neutral-400" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="w-full bg-transparent text-sm outline-none"
                  placeholder="Coffee, sandwich, dessert..."
                />
              </span>
            </label>
          </div>

          <div className="flex gap-2 overflow-x-auto pb-1">
            {categories.map(cat => (
              <button
                key={cat}
                onClick={() => setCategory(cat)}
                className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-black transition-colors ${
                  category === cat ? 'bg-[#5c4033] text-white' : 'bg-white text-neutral-600 border border-neutral-200'
                }`}
              >
                {cat === 'ALL' ? 'All' : cat}
              </button>
            ))}
          </div>

          {error && (
            <div className="flex gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-800">
              <AlertCircle size={18} className="shrink-0" />
              {error}
            </div>
          )}

          {loading ? (
            <div className="rounded-3xl bg-white p-10 text-center font-bold text-neutral-500">Loading menu...</div>
          ) : visibleItems.length === 0 ? (
            <div className="rounded-3xl bg-white p-10 text-center">
              <p className="font-black text-neutral-800">No available items found</p>
              <p className="text-sm text-neutral-500">Try another category or store.</p>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {visibleItems.map(item => {
                const qty = cart.find(line => line.item.code === item.code)?.quantity || 0;
                return (
                  <article key={item.code} className="rounded-2xl border border-neutral-100 bg-white p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h2 className="font-black text-neutral-900">{item.displayName || item.name}</h2>
                        <p className="mt-1 text-xs font-bold uppercase tracking-wider text-amber-700">{item.posCategoryName || 'Other'}</p>
                        {item.description && <p className="mt-2 text-sm text-neutral-500">{item.description}</p>}
                      </div>
                      <span className="shrink-0 rounded-full bg-neutral-50 px-3 py-1 text-sm font-black">{formatMoney(toNumber(item.salePrice))}</span>
                    </div>
                    <div className="mt-4 flex items-center justify-between">
                      {qty > 0 ? (
                        <div className="flex items-center gap-2">
                          <button onClick={() => setCartQuantity(item, qty - 1)} className="rounded-full border border-neutral-200 p-2 text-neutral-700"><Minus size={14} /></button>
                          <span className="w-8 text-center font-black">{qty}</span>
                          <button onClick={() => setCartQuantity(item, qty + 1)} className="rounded-full border border-neutral-200 p-2 text-neutral-700"><Plus size={14} /></button>
                        </div>
                      ) : (
                        <button onClick={() => setCartQuantity(item, 1)} className="rounded-xl bg-[#5c4033] px-4 py-2 text-sm font-black text-white">Add</button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <aside className="h-fit rounded-3xl border border-amber-100 bg-white p-5 shadow-sm lg:sticky lg:top-24">
          <div className="mb-4 flex items-center gap-2">
            <ShoppingBag size={18} className="text-[#5c4033]" />
            <h2 className="text-lg font-black text-[#3e2723]">Your Cart</h2>
          </div>

          {cart.length === 0 ? (
            <div className="rounded-2xl bg-neutral-50 p-5 text-center text-sm font-bold text-neutral-500">Add items to start your order.</div>
          ) : (
            <div className="space-y-3">
              {cart.map(line => (
                <div key={line.item.code} className="flex items-start justify-between gap-3 border-b border-neutral-100 pb-3">
                  <div className="min-w-0">
                    <p className="font-black text-neutral-900">{line.item.displayName || line.item.name}</p>
                    <p className="text-xs text-neutral-500">{line.quantity} x {formatMoney(toNumber(line.item.salePrice))}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setCartQuantity(line.item, line.quantity - 1)} className="rounded-full border border-neutral-200 p-1.5"><Minus size={12} /></button>
                    <span className="font-black">{line.quantity}</span>
                    <button onClick={() => setCartQuantity(line.item, line.quantity + 1)} className="rounded-full border border-neutral-200 p-1.5"><Plus size={12} /></button>
                    <button onClick={() => setCartQuantity(line.item, 0)} className="rounded-full bg-red-50 p-1.5 text-red-700"><Trash2 size={12} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-5 space-y-3">
            <input value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="Name" className="w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-[#5c4033]" />
            <input value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} placeholder="Phone number" className="w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-[#5c4033]" />
            <select value={orderType} onChange={(event) => setOrderType(event.target.value as OnlineOrderType)} className="w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm font-bold outline-none focus:border-[#5c4033]">
              <option value="PICKUP">Pickup</option>
              <option value="DINE_IN">Dine in</option>
            </select>
            <textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Notes for the store" rows={3} className="w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-[#5c4033]" />
          </div>

          <div className="mt-5 space-y-2 border-t border-neutral-100 pt-4 text-sm">
            <div className="flex justify-between"><span>Subtotal</span><span className="font-black">{formatMoney(totals.subtotal)}</span></div>
            <div className="flex justify-between"><span>GST</span><span className="font-black">{formatMoney(totals.gstTotal)}</span></div>
            <div className="flex justify-between text-lg font-black text-[#3e2723]"><span>Total</span><span>{formatMoney(totals.grandTotal)}</span></div>
          </div>

          <button
            onClick={submitOrder}
            disabled={saving || loading || cart.length === 0}
            className="mt-5 w-full rounded-2xl bg-[#5c4033] px-4 py-3 text-sm font-black text-white disabled:cursor-not-allowed disabled:bg-neutral-300"
          >
            {saving ? 'Sending request...' : 'Submit order request'}
          </button>
          <p className="mt-3 text-center text-xs text-neutral-500">This creates a request only. The store will confirm before preparing.</p>
        </aside>
      </main>
    </div>
  );
}
