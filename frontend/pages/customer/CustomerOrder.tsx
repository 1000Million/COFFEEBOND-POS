import React, { useEffect, useMemo, useState } from 'react';
import { addDoc, collection, doc, getDoc, getDocs, query, serverTimestamp, where } from 'firebase/firestore';
import { AlertCircle, CheckCircle2, ChevronDown, Clock, Copy, Gift, Minus, Plus, Search, ShoppingBag, Sparkles, Store as StoreIcon, Trash2, X } from 'lucide-react';
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
  estimatedPrepMinutes?: number;
  storeMessage: string;
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
const CATEGORY_ORDER = ['ALL', 'Coffee', 'Cold Coffee', 'Matcha & Tea', 'Food', 'Desserts', 'Add Ons'];

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

function estimatedPrepLabel(store: Store | null): string {
  const minutes = store?.estimatedPrepMinutes || 20;
  const min = Math.max(5, minutes - 5);
  return `${min}-${minutes} min`;
}

function categoryGroupName(item: CustomerMenuItem): string {
  const raw = `${item.posCategoryName || ''} ${item.name || ''} ${item.displayName || ''}`.toLowerCase();
  if (raw.includes('add on') || raw.includes('add-ons') || raw.includes('extra') || raw.includes('bread')) return 'Add Ons';
  if (raw.includes('dessert') || raw.includes('baked') || raw.includes('ice cream') || raw.includes('brownie') || raw.includes('cookie')) return 'Desserts';
  if (raw.includes('matcha') || raw.includes('tea') || raw.includes('herbal')) return 'Matcha & Tea';
  if (raw.includes('cold brew') || raw.includes('iced') || raw.includes('vietnamese') || raw.includes('cold coffee')) return 'Cold Coffee';
  if (raw.includes('coffee') || raw.includes('latte') || raw.includes('espresso') || raw.includes('cappuccino') || raw.includes('americano') || raw.includes('mocha') || raw.includes('brew') || raw.includes('milk based') || raw.includes('black') || raw.includes('specialty')) return 'Coffee';
  return 'Food';
}

function shortDescription(item: CustomerMenuItem): string {
  if (item.description?.trim()) return item.description.trim();
  const group = categoryGroupName(item);
  if (group === 'Coffee') return 'Freshly prepared by the Coffee Bond bar.';
  if (group === 'Cold Coffee') return 'Chilled, smooth, and made for pickup.';
  if (group === 'Matcha & Tea') return 'A calm cup for a slower moment.';
  if (group === 'Food') return 'Made fresh for your order.';
  if (group === 'Desserts') return 'A sweet finish from Coffee Bond.';
  return 'Add it to your pickup basket.';
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
  const [basketOpen, setBasketOpen] = useState(false);
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
    const names = Array.from(new Set(storeItems.map(item => categoryGroupName(item))));
    return CATEGORY_ORDER.filter(name => name === 'ALL' || names.includes(name));
  }, [storeItems]);

  const visibleItems = useMemo(() => {
    const searchText = search.trim().toLowerCase();
    return storeItems.filter(item => {
      const matchesCategory = category === 'ALL' || categoryGroupName(item) === category;
      const name = `${item.displayName || item.name} ${item.code} ${item.description || ''}`.toLowerCase();
      return matchesCategory && (!searchText || name.includes(searchText));
    });
  }, [storeItems, category, search]);

  const orderableItems = useMemo(() => {
    return storeItems.filter(item => (itemAvailability[item.code] || getItemAvailability(item, selectedStoreId)).available);
  }, [storeItems, itemAvailability, selectedStoreId]);

  const popularItems = useMemo(() => {
    return [...orderableItems]
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.displayName || a.name).localeCompare(b.displayName || b.name))
      .slice(0, 6);
  }, [orderableItems]);

  const suggestedItems = useMemo(() => {
    const cartCodes = new Set(cart.map(line => line.item.code));
    return orderableItems.filter(item => !cartCodes.has(item.code)).slice(0, 4);
  }, [orderableItems, cart]);

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
        estimatedPrepMinutes: selectedStore.estimatedPrepMinutes || 20,
        storeMessage: selectedStoreMessage,
        customerName: payload.customerName,
        items: onlineItems,
        total: totals.grandTotal,
        status: 'PENDING',
      });
      setCart([]);
      setNotes('');
      setBasketOpen(false);
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

  const renderProductCard = (item: CustomerMenuItem, featured = false) => {
    const qty = cart.find(line => line.item.code === item.code)?.quantity || 0;
    const availability = itemAvailability[item.code] || getItemAvailability(item, selectedStoreId);
    const canOrder = selectedStoreOnline && availability.available;
    const groupName = categoryGroupName(item);

    return (
      <article
        key={`${featured ? 'popular' : 'menu'}-${item.code}`}
        className={`group relative flex h-full flex-col rounded-[1.75rem] border bg-white p-4 shadow-sm transition-all ${
          canOrder ? 'border-[#efe3d4] hover:-translate-y-0.5 hover:shadow-md' : 'border-neutral-200 opacity-80'
        } ${featured ? 'min-w-[260px] sm:min-w-[300px]' : ''}`}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-[#f8efe4] px-2.5 py-1 text-[10px] font-black uppercase tracking-widest text-[#8a5a33]">{groupName}</span>
              {featured && <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-black uppercase tracking-widest text-emerald-700">Popular</span>}
            </div>
            <h3 className="text-lg font-black leading-tight text-[#2d2019]">{item.displayName || item.name}</h3>
          </div>
          <span className="shrink-0 rounded-full bg-[#2d2019] px-3 py-1.5 text-sm font-black text-white">{formatMoney(toNumber(item.salePrice))}</span>
        </div>

        <p className="min-h-10 flex-1 text-sm leading-relaxed text-neutral-600">{shortDescription(item)}</p>

        {!canOrder && (
          <div className="mt-4 rounded-2xl bg-neutral-100 px-3 py-2 text-xs font-black text-neutral-600">
            Currently unavailable: {selectedStoreOnline ? availability.reason : selectedStoreMessage}
          </div>
        )}

        <div className="mt-5 flex items-center justify-between">
          {qty > 0 ? (
            <div className="inline-flex items-center rounded-full border border-[#ead8c7] bg-[#fffaf5] p-1">
              <button onClick={() => setCartQuantity(item, qty - 1)} className="rounded-full p-2 text-[#5c4033] hover:bg-white"><Minus size={15} /></button>
              <span className="min-w-8 text-center text-sm font-black text-[#3e2723]">{qty}</span>
              <button onClick={() => setCartQuantity(item, qty + 1)} className="rounded-full p-2 text-[#5c4033] hover:bg-white"><Plus size={15} /></button>
            </div>
          ) : (
            <button
              onClick={() => setCartQuantity(item, 1)}
              disabled={!canOrder}
              className="inline-flex items-center gap-2 rounded-full bg-[#5c4033] px-4 py-2.5 text-sm font-black text-white shadow-sm disabled:cursor-not-allowed disabled:bg-neutral-300"
            >
              <Plus size={16} />
              Add
            </button>
          )}
        </div>
      </article>
    );
  };

  const basketPanel = (
    <div className="flex h-full flex-col">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.22em] text-amber-700">Your Basket</p>
          <h2 className="mt-1 text-2xl font-black text-[#2d2019]">{itemCount} item{itemCount === 1 ? '' : 's'}</h2>
        </div>
        <button onClick={() => setBasketOpen(false)} className="rounded-full bg-neutral-100 p-2 text-neutral-500 lg:hidden">
          <X size={18} />
        </button>
      </div>

      {cart.length === 0 ? (
        <div className="rounded-[1.5rem] bg-[#fbf5ee] p-6 text-center">
          <ShoppingBag className="mx-auto mb-3 text-[#b98b63]" size={34} />
          <p className="font-black text-[#3e2723]">Your basket is empty</p>
          <p className="mt-1 text-sm text-neutral-500">Add your favourites and send a request to the store.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {cart.map(line => (
            <div key={line.item.code} className="rounded-2xl border border-[#f0e5d8] bg-white p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-black leading-tight text-[#2d2019]">{line.item.displayName || line.item.name}</p>
                  <p className="mt-1 text-xs font-bold text-neutral-500">{formatMoney(toNumber(line.item.salePrice))} each</p>
                </div>
                <button onClick={() => setCartQuantity(line.item, 0)} className="rounded-full bg-red-50 p-1.5 text-red-700">
                  <Trash2 size={13} />
                </button>
              </div>
              <div className="mt-3 flex items-center justify-between">
                <div className="inline-flex items-center rounded-full border border-neutral-200 p-1">
                  <button onClick={() => setCartQuantity(line.item, line.quantity - 1)} className="rounded-full p-1.5"><Minus size={13} /></button>
                  <span className="min-w-8 text-center text-sm font-black">{line.quantity}</span>
                  <button onClick={() => setCartQuantity(line.item, line.quantity + 1)} className="rounded-full p-1.5"><Plus size={13} /></button>
                </div>
                <span className="font-black text-[#3e2723]">{formatMoney(toNumber(line.item.salePrice) * line.quantity)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-5 space-y-3">
        <input value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="Your name" className="w-full rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm outline-none focus:border-[#5c4033]" />
        <input value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} placeholder="Phone number" className="w-full rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm outline-none focus:border-[#5c4033]" />
        <select value={orderType} onChange={(event) => setOrderType(event.target.value as OnlineOrderType)} className="w-full rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm font-bold outline-none focus:border-[#5c4033]">
          <option value="PICKUP">Pickup</option>
          <option value="DINE_IN">Dine in</option>
        </select>
        <textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Pickup note for the store" rows={3} className="w-full rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm outline-none focus:border-[#5c4033]" />
      </div>

      <div className="mt-5 space-y-2 border-t border-neutral-100 pt-4 text-sm">
        <div className="flex justify-between"><span>Subtotal</span><span className="font-black">{formatMoney(totals.subtotal)}</span></div>
        <div className="flex justify-between"><span>GST</span><span className="font-black">{formatMoney(totals.gstTotal)}</span></div>
        <div className="flex justify-between text-xl font-black text-[#2d2019]"><span>Total</span><span>{formatMoney(totals.grandTotal)}</span></div>
      </div>

      <button
        onClick={submitOrder}
        disabled={saving || loading || cart.length === 0 || !selectedStoreOnline}
        className="mt-5 w-full rounded-2xl bg-[#5c4033] px-4 py-4 text-sm font-black text-white shadow-sm disabled:cursor-not-allowed disabled:bg-neutral-300"
      >
        {saving ? 'Sending request...' : 'Send order request'}
      </button>
      <p className="mt-3 text-center text-xs font-medium text-neutral-500">The store will confirm your order shortly.</p>
    </div>
  );

  if (confirmation) {
    return (
      <div className="min-h-[100dvh] bg-[#f7efe5] px-4 py-6 font-sans text-neutral-900">
        <div className="mx-auto max-w-xl">
          <div className="mb-6 flex items-center justify-center">
            <img src={coffeeBondLogo} alt="Coffee Bond" className="h-20 w-20 rounded-[1.75rem] bg-white object-contain p-2 shadow-sm" />
          </div>
          <div className="rounded-[2rem] border border-emerald-200 bg-white p-6 text-center shadow-sm sm:p-8">
            <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
              <CheckCircle2 size={34} />
            </div>
            <p className="text-xs font-black uppercase tracking-[0.22em] text-amber-700">Coffee Bond</p>
            <h1 className="mt-2 text-3xl font-black text-[#2d2019]">Order request sent</h1>
            <p className="mt-3 text-sm font-medium leading-relaxed text-neutral-600">We have sent your request to the store. Please pay at the counter after the team confirms it.</p>

            <div className="mt-6 rounded-[1.5rem] bg-[#fbf5ee] p-4 text-left text-sm">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-xs font-black uppercase tracking-widest text-neutral-400">Reference</p>
                  <p className="mt-1 break-all font-black text-[#2d2019]">{confirmation.id}</p>
                </div>
                <div>
                  <p className="text-xs font-black uppercase tracking-widest text-neutral-400">Pickup from</p>
                  <p className="mt-1 font-black text-[#2d2019]">{confirmation.storeName}</p>
                </div>
                <div>
                  <p className="text-xs font-black uppercase tracking-widest text-neutral-400">Estimated prep</p>
                  <p className="mt-1 font-black text-[#2d2019]">{confirmation.estimatedPrepMinutes ? estimatedPrepLabel({ estimatedPrepMinutes: confirmation.estimatedPrepMinutes } as Store) : 'Store will confirm shortly'}</p>
                </div>
                <div>
                  <p className="text-xs font-black uppercase tracking-widest text-neutral-400">Total</p>
                  <p className="mt-1 font-black text-[#2d2019]">{formatMoney(confirmation.total)}</p>
                </div>
              </div>
              <div className="mt-4 border-t border-[#ead8c7] pt-4">
                <p className="mb-2 font-black text-[#2d2019]">Basket</p>
                <div className="space-y-2">
                  {confirmation.items.map(item => (
                    <div key={item.finishedGoodCode} className="flex justify-between gap-3">
                      <span>{item.quantity} x {item.itemName}</span>
                      <span className="font-black">{formatMoney(item.lineTotal)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <Link to={`/order/status/${confirmation.id}`} className="rounded-2xl bg-[#5c4033] px-4 py-4 text-sm font-black text-white">
                Track order
              </Link>
              <button onClick={() => copyTrackingLink(confirmation.id)} className="inline-flex items-center justify-center gap-2 rounded-2xl border border-neutral-200 bg-white px-4 py-4 text-sm font-black text-[#5c4033]">
                <Copy size={16} />
                Copy tracking link
              </button>
            </div>
            {copyMessage && <p className="mt-3 break-all rounded-xl bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">{copyMessage}</p>}
            <button
              onClick={() => {
                setConfirmation(null);
                setCopyMessage('');
              }}
              className="mt-3 w-full rounded-2xl border border-neutral-200 bg-white px-4 py-4 text-sm font-black text-[#5c4033]"
            >
              Start another basket
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-[#f7efe5] pb-24 font-sans text-neutral-900 lg:pb-0">
      <header className="sticky top-0 z-30 border-b border-[#ead8c7] bg-[#fffaf5]/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <img src={coffeeBondLogo} alt="Coffee Bond" className="h-12 w-12 rounded-2xl bg-white object-contain p-1 shadow-sm" />
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.26em] text-amber-700">Coffee Bond</p>
              <h1 className="text-base font-black text-[#2d2019] sm:text-lg">Order your Coffee Bond favourites</h1>
              <p className="hidden text-xs font-bold text-neutral-500 sm:block">Pickup from your nearest store</p>
            </div>
          </div>
          <button
            onClick={() => setBasketOpen(true)}
            className="rounded-full bg-[#2d2019] px-4 py-2 text-xs font-black text-white shadow-sm sm:text-sm"
          >
            Basket · {itemCount} item{itemCount === 1 ? '' : 's'}
          </button>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-6 px-4 py-5 lg:grid-cols-[minmax(0,1fr)_390px] lg:px-6">
        <section className="min-w-0 space-y-6">
          <div className="overflow-hidden rounded-[2rem] bg-[#2d2019] text-white shadow-sm">
            <div className="grid gap-5 p-6 sm:p-8 md:grid-cols-[1fr_auto] md:items-center">
              <div>
                <p className="mb-3 inline-flex rounded-full bg-white/10 px-3 py-1 text-xs font-black uppercase tracking-[0.22em] text-[#f3d3a6]">Pickup ordering</p>
                <h2 className="max-w-xl text-4xl font-black leading-none sm:text-5xl">Order your Coffee Bond favourites</h2>
                <p className="mt-4 max-w-lg text-sm font-medium leading-relaxed text-[#ead8c7]">Choose your store, build your basket, and the team will confirm before preparing your pickup.</p>
                <div className="mt-5 flex flex-wrap gap-2">
                  <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-2 text-xs font-black"><Gift size={14} /> Rewards coming soon</span>
                  <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-2 text-xs font-black"><Sparkles size={14} /> Freshly made</span>
                </div>
              </div>
              <img src={coffeeBondLogo} alt="" className="hidden h-36 w-36 rounded-[2rem] bg-[#fffaf5] object-contain p-3 md:block" />
            </div>
          </div>

          <div className="grid gap-4 rounded-[2rem] border border-[#ead8c7] bg-white p-4 shadow-sm md:grid-cols-[minmax(0,1fr)_minmax(220px,320px)]">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.22em] text-amber-700">Pickup from</p>
              <label className="mt-3 block">
                <span className="sr-only">Select pickup store</span>
                <span className="flex items-center gap-3 rounded-[1.25rem] border border-[#ead8c7] bg-[#fffaf5] px-4 py-3">
                  <StoreIcon size={18} className="text-[#8a5a33]" />
                  <select
                    value={selectedStoreId}
                    onChange={(event) => {
                      setSelectedStoreId(event.target.value);
                      setCart([]);
                      setCategory('ALL');
                    }}
                    className="w-full appearance-none bg-transparent text-base font-black text-[#2d2019] outline-none"
                  >
                    {stores.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}
                  </select>
                  <ChevronDown size={18} className="text-neutral-400" />
                </span>
              </label>
              {selectedStore && (
                <div className={`mt-3 rounded-2xl px-4 py-3 text-sm ${
                  selectedStoreOnline ? 'bg-emerald-50 text-emerald-900' : 'bg-red-50 text-red-900'
                }`}>
                  <p className="font-black">{selectedStoreOnline ? 'Accepting online orders' : 'Online ordering unavailable'}</p>
                  <p className="mt-1 font-medium">{selectedStoreMessage}</p>
                </div>
              )}
            </div>
            <div className="rounded-[1.5rem] bg-[#fbf5ee] p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-[#5c4033] shadow-sm">
                  <Clock size={20} />
                </div>
                <div>
                  <p className="text-xs font-black uppercase tracking-widest text-neutral-400">Estimated prep</p>
                  <p className="text-xl font-black text-[#2d2019]">{selectedStore ? estimatedPrepLabel(selectedStore) : '--'}</p>
                </div>
              </div>
              <p className="mt-4 text-sm font-medium text-neutral-600">You can add a pickup note before sending the request.</p>
            </div>
          </div>

          {error && (
            <div className="flex gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-800">
              <AlertCircle size={18} className="shrink-0" />
              {error}
            </div>
          )}

          <section>
            <div className="mb-3 flex items-end justify-between gap-3">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.22em] text-amber-700">Recommended</p>
                <h2 className="text-2xl font-black text-[#2d2019]">Popular today</h2>
              </div>
              <p className="hidden text-sm font-medium text-neutral-500 sm:block">Start with a favourite</p>
            </div>
            {loading ? (
              <div className="rounded-[2rem] bg-white p-8 text-center font-bold text-neutral-500">Loading favourites...</div>
            ) : popularItems.length === 0 ? (
              <div className="rounded-[2rem] bg-white p-8 text-center font-bold text-neutral-500">No popular items available for this store.</div>
            ) : (
              <div className="-mx-4 flex gap-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
                {popularItems.map(item => renderProductCard(item, true))}
              </div>
            )}
          </section>

          <section className="rounded-[2rem] border border-[#ead8c7] bg-white p-4 shadow-sm sm:p-5">
            <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.22em] text-amber-700">Full menu</p>
                <h2 className="text-2xl font-black text-[#2d2019]">What would you like?</h2>
              </div>
              <label className="flex items-center gap-2 rounded-full border border-[#ead8c7] bg-[#fffaf5] px-4 py-3 md:min-w-80">
                <Search size={17} className="text-neutral-400" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="w-full bg-transparent text-sm outline-none"
                  placeholder="Search coffee, food, dessert..."
                />
              </label>
            </div>

            <div className="-mx-4 mb-5 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
              {categories.map(cat => (
                <button
                  key={cat}
                  onClick={() => setCategory(cat)}
                  className={`whitespace-nowrap rounded-full px-4 py-2.5 text-sm font-black transition-colors ${
                    category === cat ? 'bg-[#5c4033] text-white shadow-sm' : 'border border-[#ead8c7] bg-white text-[#5c4033]'
                  }`}
                >
                  {cat === 'ALL' ? 'All favourites' : cat}
                </button>
              ))}
            </div>

            {loading ? (
              <div className="rounded-[1.5rem] bg-[#fbf5ee] p-10 text-center font-bold text-neutral-500">Loading menu...</div>
            ) : visibleItems.length === 0 ? (
              <div className="rounded-[1.5rem] bg-[#fbf5ee] p-10 text-center">
                <p className="font-black text-neutral-800">Nothing found here</p>
                <p className="text-sm text-neutral-500">Try another category or search.</p>
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {visibleItems.map(item => renderProductCard(item))}
              </div>
            )}
          </section>

          {suggestedItems.length > 0 && (
            <section className="rounded-[2rem] border border-[#ead8c7] bg-[#fffaf5] p-5">
              <p className="text-xs font-black uppercase tracking-[0.22em] text-amber-700">You may also like</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {suggestedItems.map(item => (
                  <button key={`suggested-${item.code}`} onClick={() => setCartQuantity(item, (cart.find(line => line.item.code === item.code)?.quantity || 0) + 1)} className="flex items-center justify-between rounded-2xl bg-white p-3 text-left shadow-sm">
                    <span>
                      <span className="block font-black text-[#2d2019]">{item.displayName || item.name}</span>
                      <span className="text-xs font-bold text-neutral-500">{formatMoney(toNumber(item.salePrice))}</span>
                    </span>
                    <Plus size={18} className="text-[#5c4033]" />
                  </button>
                ))}
              </div>
            </section>
          )}
        </section>

        <aside className="hidden h-fit max-h-[calc(100dvh-6rem)] overflow-y-auto rounded-[2rem] border border-[#ead8c7] bg-white p-5 shadow-sm lg:sticky lg:top-24 lg:block">
          {basketPanel}
        </aside>
      </main>

      <button
        onClick={() => setBasketOpen(true)}
        className="fixed inset-x-4 bottom-4 z-40 rounded-2xl bg-[#2d2019] px-5 py-4 text-sm font-black text-white shadow-[0_14px_40px_rgba(45,32,25,0.28)] lg:hidden"
      >
        View Basket · {formatMoney(totals.grandTotal)}
      </button>

      {basketOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 lg:hidden">
          <button aria-label="Close basket" className="absolute inset-0 h-full w-full cursor-default" onClick={() => setBasketOpen(false)} />
          <div className="absolute inset-x-0 bottom-0 max-h-[86dvh] overflow-y-auto rounded-t-[2rem] bg-white p-5 shadow-2xl">
            {basketPanel}
          </div>
        </div>
      )}
    </div>
  );
}
