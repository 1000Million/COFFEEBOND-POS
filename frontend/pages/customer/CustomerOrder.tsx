import React, { useEffect, useMemo, useState } from 'react';
import { addDoc, collection, doc, getDoc, getDocs, query, serverTimestamp, where } from 'firebase/firestore';
import { AlertCircle, CheckCircle2, Clock, Copy, Minus, Plus, Search, ShoppingBag, Store as StoreIcon, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { db } from '../../lib/firebase';
import { OnlineOrder, OnlineOrderItem, OnlineOrderType, Store } from '../../types';
import { FinishedGood } from '../../types/menu-management';
import coffeeBondLogo from '../../assets/coffee-bond-logo.png';

type CustomerMenuItem = FinishedGood & { id: string };

type CartLine = {
  item: CustomerMenuItem;
  quantity: number;
};

type ConfirmationState = {
  id: string;
  storeName: string;
  customerName: string;
  items: OnlineOrderItem[];
  total: number;
  status: OnlineOrder['status'];
};

type GstConfig = {
  defaultRate: number;
  storeOverrides: Record<string, number>;
};

type ItemAvailability = {
  available: boolean;
  reason: string;
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

function isStoreOnlineEnabled(store: Store | null): boolean {
  return !!store && store.onlineOrderingEnabled !== false;
}

function storeOnlineMessage(store: Store | null): string {
  if (!store) return 'Select a store to start your order.';
  if (!isStoreOnlineEnabled(store)) return 'Online ordering is currently unavailable for this store.';
  if (store.onlineOrderingMessage?.trim()) return store.onlineOrderingMessage.trim();
  if (store.estimatedPrepMinutes && store.estimatedPrepMinutes > 0) {
    const min = Math.max(5, store.estimatedPrepMinutes - 5);
    return `Pickup available in ${min}-${store.estimatedPrepMinutes} minutes`;
  }
  return 'Pickup available soon after store confirmation.';
}

function getItemAvailability(item: CustomerMenuItem, storeId: string): ItemAvailability {
  const itemRecord = item as CustomerMenuItem & Record<string, unknown>;
  if (!storeId || !isStoreAvailable(item, storeId)) {
    return { available: false, reason: 'Not available at this store' };
  }
  if (!item.isActive || !item.isSellable || item.isAvailable === false) {
    return { available: false, reason: 'Currently unavailable' };
  }
  if (itemRecord.onlineOrderingEnabled === false || itemRecord.customerOrderingEnabled === false) {
    return { available: false, reason: 'Not available for online ordering' };
  }
  if (toNumber(item.salePrice) <= 0) {
    return { available: false, reason: 'Price setup incomplete' };
  }
  if (item.itemType !== 'NO_STOCK' && item.itemType !== 'DIRECT_STOCK' && (!Array.isArray(item.bom) || item.bom.length === 0)) {
    return { available: false, reason: 'Recipe/BOM setup incomplete' };
  }
  if (!['BARISTA', 'KITCHEN', 'BOTH', 'NONE'].includes(item.prepStation)) {
    return { available: false, reason: 'Preparation station setup incomplete' };
  }
  const explicitReason = itemRecord.customerUnavailableReason;
  if (typeof explicitReason === 'string' && explicitReason.trim()) {
    return { available: false, reason: explicitReason.trim() };
  }
  return { available: true, reason: '' };
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
  const [copyMessage, setCopyMessage] = useState('');
  const [confirmation, setConfirmation] = useState<ConfirmationState | null>(null);

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
  const selectedStoreOnline = isStoreOnlineEnabled(selectedStore);
  const selectedStoreMessage = storeOnlineMessage(selectedStore);

  const storeItems = useMemo(() => {
    if (!selectedStoreId) return [];
    return items.filter(item => isStoreAvailable(item, selectedStoreId));
  }, [items, selectedStoreId]);

  const itemAvailability = useMemo(() => {
    return storeItems.reduce<Record<string, ItemAvailability>>((acc, item) => {
      acc[item.code] = getItemAvailability(item, selectedStoreId);
      return acc;
    }, {});
  }, [storeItems, selectedStoreId]);

  const categories = useMemo(() => {
    const names = Array.from(new Set(storeItems.map(item => item.posCategoryName || 'Other')));
    return ['ALL', ...names.sort((a, b) => a.localeCompare(b))];
  }, [storeItems]);

  const visibleItems = useMemo(() => {
    const searchText = search.trim().toLowerCase();
    return storeItems.filter(item => {
      const matchesCategory = category === 'ALL' || (item.posCategoryName || 'Other') === category;
      const name = `${item.displayName || item.name} ${item.code} ${item.description || ''}`.toLowerCase();
      return matchesCategory && (!searchText || name.includes(searchText));
    });
  }, [storeItems, category, search]);

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
    const availability = itemAvailability[item.code] || getItemAvailability(item, selectedStoreId);
    if (quantity > 0 && !availability.available) {
      setError(`${item.displayName || item.name} is currently unavailable: ${availability.reason}.`);
      return;
    }
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
    if (!selectedStoreOnline) return setError(selectedStoreMessage);
    if (cart.length === 0) return setError('Please add at least one item.');
    if (!customerName.trim()) return setError('Please enter your name.');
    if (!customerPhone.trim()) return setError('Please enter your phone number.');
    const blockedLine = cart.find(line => !(itemAvailability[line.item.code] || getItemAvailability(line.item, selectedStore.id)).available);
    if (blockedLine) {
      const availability = itemAvailability[blockedLine.item.code] || getItemAvailability(blockedLine.item, selectedStore.id);
      return setError(`${blockedLine.item.displayName || blockedLine.item.name} is currently unavailable: ${availability.reason}.`);
    }

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
      setConfirmation({
        id: orderRef.id,
        storeName: selectedStore.name,
        customerName: payload.customerName,
        items: onlineItems,
        total: totals.grandTotal,
        status: 'PENDING',
      });
      setCart([]);
      setNotes('');
    } catch (err) {
      console.error('Failed to submit online order', err);
      setError('We could not send your order request. Please try again or call the store.');
    } finally {
      setSaving(false);
    }
  };

  const copyTrackingLink = async (onlineOrderId: string) => {
    const trackingUrl = `${window.location.origin}/order/status/${onlineOrderId}`;
    try {
      await navigator.clipboard.writeText(trackingUrl);
      setCopyMessage('Tracking link copied.');
    } catch {
      setCopyMessage(trackingUrl);
    }
  };

  if (confirmation) {
    return (
      <div className="min-h-[100dvh] bg-[#f9f5f0] px-4 py-6 font-sans text-neutral-900">
        <div className="mx-auto mb-5 flex max-w-lg items-center gap-3">
          <img src={coffeeBondLogo} alt="Coffee Bond" className="h-14 w-14 rounded-2xl bg-white object-contain p-1 shadow-sm" />
          <div>
            <p className="text-xs font-black uppercase tracking-[0.22em] text-amber-700">Coffee Bond</p>
            <h1 className="text-2xl font-black text-[#3e2723]">Order Confirmation</h1>
          </div>
        </div>
        <div className="mx-auto max-w-lg rounded-3xl border border-emerald-200 bg-white p-6 text-center shadow-sm sm:p-8">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
            <CheckCircle2 size={30} />
          </div>
          <h2 className="text-2xl font-black text-[#3e2723]">Order request received</h2>
          <p className="mt-3 text-sm text-neutral-600">Store will confirm your order shortly. Please pay at the counter when requested.</p>
          <div className="mt-6 rounded-2xl bg-neutral-50 p-4 text-left text-sm">
            <p><span className="font-bold">Reference:</span> {confirmation.id}</p>
            <p><span className="font-bold">Store:</span> {confirmation.storeName}</p>
            <p><span className="font-bold">Customer:</span> {confirmation.customerName}</p>
            <p><span className="font-bold">Status:</span> {confirmation.status}</p>
            <div className="mt-3 border-t border-neutral-200 pt-3">
              <p className="mb-2 font-bold">Items</p>
              <div className="space-y-1">
                {confirmation.items.map(item => (
                  <div key={item.finishedGoodCode} className="flex justify-between gap-3">
                    <span>{item.quantity} x {item.itemName}</span>
                    <span className="font-bold">{formatMoney(item.lineTotal)}</span>
                  </div>
                ))}
              </div>
            </div>
            <p><span className="font-bold">Total:</span> {formatMoney(confirmation.total)}</p>
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <Link
              to={`/order/status/${confirmation.id}`}
              className="rounded-xl bg-[#5c4033] px-4 py-3 text-sm font-black text-white"
            >
              Track Order
            </Link>
            <button
              onClick={() => copyTrackingLink(confirmation.id)}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm font-black text-[#5c4033]"
            >
              <Copy size={16} />
              Copy Link
            </button>
          </div>
          {copyMessage && <p className="mt-3 break-all rounded-xl bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">{copyMessage}</p>}
          <button
            onClick={() => {
              setConfirmation(null);
              setCopyMessage('');
            }}
            className="mt-3 w-full rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm font-black text-[#5c4033]"
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
            <img src={coffeeBondLogo} alt="Coffee Bond" className="h-12 w-12 rounded-2xl bg-[#f9f5f0] object-contain p-1 shadow-sm" />
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.24em] text-amber-700">Coffee Bond</p>
              <h1 className="text-xl font-black text-[#3e2723]">Order ahead</h1>
            </div>
          </div>
          <div className="rounded-full bg-amber-50 px-3 py-2 text-xs font-black text-[#5c4033] sm:px-4 sm:text-sm">
            {itemCount} item{itemCount === 1 ? '' : 's'}
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-5 px-3 py-4 sm:px-4 lg:grid-cols-[1fr_380px]">
        <section className="space-y-4">
          <div className="grid gap-3 rounded-3xl border border-amber-100 bg-white p-4 shadow-sm md:grid-cols-[260px_1fr]">
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

          {selectedStore && (
            <div className={`flex gap-3 rounded-3xl border p-4 text-sm shadow-sm ${
              selectedStoreOnline ? 'border-emerald-100 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-900'
            }`}>
              {selectedStoreOnline ? <Clock size={19} className="mt-0.5 shrink-0" /> : <AlertCircle size={19} className="mt-0.5 shrink-0" />}
              <div>
                <p className="font-black">{selectedStore.name}</p>
                <p className="font-medium">{selectedStoreMessage}</p>
              </div>
            </div>
          )}

          <div className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-1 sm:mx-0 sm:px-0">
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
                const availability = itemAvailability[item.code] || getItemAvailability(item, selectedStoreId);
                const canOrder = selectedStoreOnline && availability.available;
                return (
                  <article key={item.code} className={`rounded-2xl border bg-white p-4 shadow-sm ${canOrder ? 'border-neutral-100' : 'border-neutral-200 opacity-80'}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="font-black text-neutral-900">{item.displayName || item.name}</h2>
                        <p className="mt-1 text-xs font-bold uppercase tracking-wider text-amber-700">{item.posCategoryName || 'Other'}</p>
                        {item.description && <p className="mt-2 text-sm text-neutral-500">{item.description}</p>}
                      </div>
                      <span className="shrink-0 rounded-full bg-neutral-50 px-3 py-1 text-sm font-black">{formatMoney(toNumber(item.salePrice))}</span>
                    </div>
                    {!canOrder && (
                      <div className="mt-3 rounded-xl bg-neutral-100 px-3 py-2 text-xs font-black text-neutral-600">
                        Currently unavailable: {selectedStoreOnline ? availability.reason : selectedStoreMessage}
                      </div>
                    )}
                    <div className="mt-4 flex items-center justify-between">
                      {qty > 0 ? (
                        <div className="flex items-center gap-2">
                          <button onClick={() => setCartQuantity(item, qty - 1)} className="rounded-full border border-neutral-200 p-2 text-neutral-700"><Minus size={14} /></button>
                          <span className="w-8 text-center font-black">{qty}</span>
                          <button onClick={() => setCartQuantity(item, qty + 1)} className="rounded-full border border-neutral-200 p-2 text-neutral-700"><Plus size={14} /></button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setCartQuantity(item, 1)}
                          disabled={!canOrder}
                          className="rounded-xl bg-[#5c4033] px-4 py-2 text-sm font-black text-white disabled:cursor-not-allowed disabled:bg-neutral-300"
                        >
                          {canOrder ? 'Add' : 'Unavailable'}
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <aside className="sticky bottom-0 z-30 -mx-3 max-h-[78dvh] overflow-y-auto rounded-t-3xl border border-amber-100 bg-white p-5 shadow-[0_-12px_30px_rgba(62,39,35,0.12)] sm:mx-0 lg:top-24 lg:h-fit lg:max-h-[calc(100dvh-7rem)] lg:rounded-3xl lg:shadow-sm">
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
            disabled={saving || loading || cart.length === 0 || !selectedStoreOnline}
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
