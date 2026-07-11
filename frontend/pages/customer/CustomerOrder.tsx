import React, { useEffect, useMemo, useRef, useState } from 'react';
import { collection, doc, getDoc, getDocs, query, serverTimestamp, where, writeBatch } from 'firebase/firestore';
import {
  AlertCircle,
  CakeSlice,
  CheckCircle2,
  ChevronDown,
  Clock,
  Coffee,
  Copy,
  CupSoda,
  Leaf,
  Minus,
  Plus,
  Search,
  ShoppingBag,
  Sparkles,
  Store as StoreIcon,
  Trash2,
  Utensils,
  X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { db } from '../../lib/firebase';
import { OnlineOrder, OnlineOrderItem, OnlineOrderType, Store } from '../../types';
import { FinishedGood } from '../../types/menu-management';
import coffeeBondLogo from '../../assets/coffee-bond-logo.png';
import { buildInitialPublicTrackingDoc, buildPublicOrderReference, generateTrackingToken, publicTrackingDocRef } from '../../lib/publicOrderTracking';

type CustomerMenuItem = FinishedGood & { id: string };

type CartLine = {
  item: CustomerMenuItem;
  quantity: number;
};

type ConfirmationState = {
  id: string;
  publicOrderReference: string;
  storeName: string;
  estimatedPrepMinutes?: number;
  storeMessage: string;
  customerName: string;
  orderType: OnlineOrderType;
  tableNumber?: string | null;
  items: OnlineOrderItem[];
  subtotal: number;
  gstTotal: number;
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
  fromSnapshot?: boolean;
};

type IconComponent = React.ComponentType<{ size?: number; className?: string }>;

type PublicAvailabilityItem = {
  itemCode?: string;
  fgCode?: string;
  available?: boolean;
  publicStatus?: 'AVAILABLE' | 'CURRENTLY_UNAVAILABLE' | 'STORE_DISABLED' | 'SETUP_INCOMPLETE';
  publicMessage?: string;
};

type PublicAvailabilitySnapshot = {
  storeId?: string;
  storeCode?: string;
  storeName?: string;
  updatedAt?: unknown;
  expiresAt?: unknown;
  items?: Record<string, PublicAvailabilityItem>;
  menuItems?: Record<string, CustomerMenuItem>;
};

const APP_TAX_RATE_KEYS = ['defaultGstRate', 'gstRate', 'taxRate', 'defaultTaxRate', 'defaultGSTPercent', 'gstPercent', 'taxPercent'];
const STORE_TAX_RATE_KEYS = ['gstRate', 'taxRate', 'defaultGstRate', 'defaultTaxRate', 'gstPercent', 'taxPercent'];
const ITEM_TAX_RATE_KEYS = ['taxRate', 'gstRate', 'taxPercent', 'gstPercent'];
const CATEGORY_ORDER = ['ALL', 'Coffee', 'Cold Coffee', 'Matcha & Tea', 'Food', 'Desserts', 'Add Ons'];
const MAX_NOTE_LENGTH = 200;
const SUBMISSION_LOCK_TTL_MS = 2 * 60 * 1000;

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

function prepWindowLabel(minutes?: number | null): string {
  const safeMinutes = minutes && minutes > 0 ? minutes : 20;
  const min = Math.max(5, safeMinutes - 5);
  return `${min}-${safeMinutes} min`;
}

function estimatedPrepLabel(store: Store | null): string {
  return prepWindowLabel(store?.estimatedPrepMinutes);
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

function categoryLabel(category: string): string {
  if (category === 'ALL') return 'All';
  if (category === 'Matcha & Tea') return 'Matcha';
  return category;
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

function getItemImage(item: CustomerMenuItem): string | null {
  const record = item as CustomerMenuItem & Record<string, unknown>;
  for (const key of ['imageUrl', 'image', 'photoUrl', 'photo', 'thumbnailUrl', 'thumbnail']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function visualMeta(item: CustomerMenuItem): {
  label: string;
  gradient: string;
  iconColor: string;
  icon: IconComponent;
} {
  const group = categoryGroupName(item);
  if (group === 'Coffee') {
    return { label: 'Coffee', gradient: 'from-[#f7eadc] to-[#ead0ad]', iconColor: 'text-[#6c4025]', icon: Coffee };
  }
  if (group === 'Cold Coffee') {
    return { label: 'Cold coffee', gradient: 'from-[#eef6f1] to-[#cfe7dc]', iconColor: 'text-[#2f6b4b]', icon: CupSoda };
  }
  if (group === 'Matcha & Tea') {
    return { label: 'Matcha', gradient: 'from-[#eef3e5] to-[#dce8cb]', iconColor: 'text-[#4d6b34]', icon: Leaf };
  }
  if (group === 'Desserts') {
    return { label: 'Dessert', gradient: 'from-[#f9ece6] to-[#f2d2c4]', iconColor: 'text-[#8a4a38]', icon: CakeSlice };
  }
  if (group === 'Add Ons') {
    return { label: 'Add on', gradient: 'from-[#f7efe9] to-[#e9dfd2]', iconColor: 'text-[#705748]', icon: Sparkles };
  }
  return { label: 'Food', gradient: 'from-[#f8efe8] to-[#ecd8c9]', iconColor: 'text-[#7f5136]', icon: Utensils };
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
    return { available: false, reason: 'Currently unavailable' };
  }
  if (!['BARISTA', 'KITCHEN', 'BOTH', 'NONE'].includes(item.prepStation)) {
    return { available: false, reason: 'Currently unavailable' };
  }
  const explicitReason = itemRecord.customerUnavailableReason;
  if (typeof explicitReason === 'string' && explicitReason.trim()) {
    return { available: false, reason: explicitReason.trim() };
  }
  return { available: true, reason: '' };
}

function dateFromFirestoreValue(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof value === 'object' && 'toDate' in value && typeof (value as { toDate: () => Date }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate();
  }
  return null;
}

function isSnapshotStale(snapshot: PublicAvailabilitySnapshot | null): boolean {
  const expiresAt = dateFromFirestoreValue(snapshot?.expiresAt);
  return !!expiresAt && expiresAt.getTime() < Date.now();
}

function formatMoney(value: number): string {
  return `₹${value.toFixed(2)}`;
}

function normalizeIndianPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

function isValidIndianPhone(value: string): boolean {
  return /^[6-9]\d{9}$/.test(normalizeIndianPhone(value));
}

function cartSignature(storeId: string, customerPhone: string, orderType: OnlineOrderType, tableNumber: string, cart: CartLine[]): string {
  const cartParts = cart
    .map(line => `${line.item.code}:${line.quantity}`)
    .sort()
    .join('|');
  return [
    storeId,
    normalizeIndianPhone(customerPhone),
    orderType,
    orderType === 'DINE_IN' ? tableNumber.trim().toUpperCase() : 'PICKUP',
    cartParts,
  ].join('::');
}

function submissionLockKey(signature: string): string {
  return `coffeeBondOnlineOrder:${signature}`;
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
  const [tableNumber, setTableNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [gstConfig, setGstConfig] = useState<GstConfig>({ defaultRate: 0, storeOverrides: {} });
  const [publicAvailability, setPublicAvailability] = useState<PublicAvailabilitySnapshot | null>(null);
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [basketOpen, setBasketOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState('');
  const [confirmation, setConfirmation] = useState<ConfirmationState | null>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    let active = true;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const [storeSnap, gstSnap] = await Promise.all([
          getDocs(query(collection(db, 'stores'), where('isActive', '==', true))),
          getDoc(doc(db, 'appSettings', 'gstConfig')),
        ]);

        if (!active) return;

        const loadedStores = storeSnap.docs.map(storeDoc => ({ id: storeDoc.id, ...storeDoc.data() } as Store))
          .sort((a, b) => a.name.localeCompare(b.name));
        const gstData = gstSnap.exists() ? gstSnap.data() as Record<string, unknown> : {};

        setStores(loadedStores);
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

  useEffect(() => {
    let active = true;

    const loadAvailability = async () => {
      if (!selectedStoreId) {
        setPublicAvailability(null);
        return;
      }

      setAvailabilityLoading(true);
      try {
        const selectedStore = stores.find(store => store.id === selectedStoreId);
        if (!selectedStore) {
          setPublicAvailability(null);
          setItems([]);
          return;
        }

        const snap = await getDoc(doc(db, 'publicMenuAvailability', selectedStore.code));
        if (!active) return;
        const snapshot = snap.exists() ? snap.data() as PublicAvailabilitySnapshot : null;
        setPublicAvailability(snapshot);
        const publicItems = Object.values(snapshot?.menuItems || {})
          .map(item => ({ ...item, bom: [], bomVersion: 0, recipeCost: 0, grossMargin: 0, cogsPercent: 0 } as CustomerMenuItem))
          .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.displayName || a.name).localeCompare(b.displayName || b.name));
        setItems(publicItems);
      } catch (err) {
        console.warn('Customer menu availability snapshot is unavailable; the store will confirm availability.', err);
        if (active) setPublicAvailability(null);
        if (active) setItems([]);
      } finally {
        if (active) setAvailabilityLoading(false);
      }
    };

    loadAvailability();
    return () => {
      active = false;
    };
  }, [selectedStoreId, stores]);

  const selectedStore = useMemo(() => stores.find(store => store.id === selectedStoreId) || null, [stores, selectedStoreId]);
  const selectedStoreTaxRate = useMemo(() => storeTaxRate(selectedStore, gstConfig), [selectedStore, gstConfig]);
  const selectedStoreOnline = isStoreOnlineEnabled(selectedStore);
  const selectedStoreMessage = storeOnlineMessage(selectedStore);
  const availabilitySnapshotMissing = !!selectedStoreId && !availabilityLoading && !publicAvailability;
  const availabilitySnapshotStale = isSnapshotStale(publicAvailability);
  const availabilityNotice = availabilitySnapshotMissing || availabilitySnapshotStale
    ? 'Availability will be confirmed by the store.'
    : '';

  const storeItems = useMemo(() => {
    if (!selectedStoreId) return [];
    return items.filter(item => isStoreAvailable(item, selectedStoreId));
  }, [items, selectedStoreId]);

  const itemAvailability = useMemo(() => {
    return storeItems.reduce<Record<string, ItemAvailability>>((acc, item) => {
      const baseAvailability = getItemAvailability(item, selectedStoreId);
      const publicItem = publicAvailability?.items?.[item.code];
      if (baseAvailability.available && publicItem?.available === false) {
        acc[item.code] = {
          available: false,
          reason: publicItem.publicMessage || 'Currently unavailable',
          fromSnapshot: true,
        };
      } else {
        acc[item.code] = baseAvailability;
      }
      return acc;
    }, {});
  }, [storeItems, selectedStoreId, publicAvailability]);

  const categories = useMemo(() => {
    const names = Array.from(new Set(storeItems.map(item => categoryGroupName(item))));
    return CATEGORY_ORDER.filter(name => name === 'ALL' || names.includes(name));
  }, [storeItems]);

  const visibleItems = useMemo(() => {
    const searchText = search.trim().toLowerCase();
    return storeItems.filter(item => {
      const availability = itemAvailability[item.code] || getItemAvailability(item, selectedStoreId);
      if (!availability.available) return false;
      const matchesCategory = category === 'ALL' || categoryGroupName(item) === category;
      const name = `${item.displayName || item.name} ${item.code} ${item.description || ''}`.toLowerCase();
      return matchesCategory && (!searchText || name.includes(searchText));
    });
  }, [storeItems, itemAvailability, selectedStoreId, category, search]);

  const orderableItems = useMemo(() => {
    return storeItems.filter(item => (itemAvailability[item.code] || getItemAvailability(item, selectedStoreId)).available);
  }, [storeItems, itemAvailability, selectedStoreId]);

  const popularItems = useMemo(() => {
    return [...orderableItems]
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.displayName || a.name).localeCompare(b.displayName || b.name))
      .slice(0, 6);
  }, [orderableItems]);

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

  const handleStoreChange = (nextStoreId: string) => {
    if (nextStoreId === selectedStoreId) return;
    if (cart.length > 0) {
      const shouldSwitch = window.confirm('Changing store will clear your current basket so prices and availability stay correct. Continue?');
      if (!shouldSwitch) return;
    }
    setSelectedStoreId(nextStoreId);
    setCart([]);
    setCategory('ALL');
    setSearch('');
    setBasketOpen(false);
    setError(null);
  };

  const handleOrderTypeChange = (nextType: OnlineOrderType) => {
    setOrderType(nextType);
    if (nextType !== 'DINE_IN') setTableNumber('');
  };

  const setCartQuantity = (item: CustomerMenuItem, quantity: number) => {
    const availability = itemAvailability[item.code] || getItemAvailability(item, selectedStoreId);
    const currentQty = cart.find(line => line.item.code === item.code)?.quantity || 0;
    if (quantity > currentQty && !availability.available) {
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
    if (saving || submittingRef.current) return;
    if (!selectedStore) return setError('Please select a store.');
    if (!selectedStoreOnline) return setError(selectedStoreMessage);
    if (cart.length === 0) return setError('Please add at least one item.');
    const cleanCustomerName = customerName.trim().replace(/\s+/g, ' ');
    const cleanPhone = normalizeIndianPhone(customerPhone);
    const cleanTableNumber = tableNumber.trim().replace(/\s+/g, ' ');
    const cleanNotes = notes.trim().slice(0, MAX_NOTE_LENGTH);
    if (!cleanCustomerName) return setError('Please enter your name.');
    if (!isValidIndianPhone(customerPhone)) return setError('Please enter a valid 10-digit Indian mobile number.');
    if (orderType === 'DINE_IN' && !cleanTableNumber) return setError('Please enter your table number for dine in.');

    const blockedLine = cart.find(line => {
      const currentItem = storeItems.find(item => item.code === line.item.code);
      if (!currentItem) return true;
      return !(itemAvailability[line.item.code] || getItemAvailability(currentItem, selectedStore.id)).available;
    });
    if (blockedLine) {
      const currentItem = storeItems.find(item => item.code === blockedLine.item.code);
      const availability = currentItem
        ? itemAvailability[blockedLine.item.code] || getItemAvailability(currentItem, selectedStore.id)
        : { available: false, reason: 'Currently unavailable', fromSnapshot: true };
      return setError(availability.fromSnapshot
        ? 'Some items are currently unavailable. Please remove them from your basket.'
        : `${blockedLine.item.displayName || blockedLine.item.name} is currently unavailable: ${availability.reason}.`);
    }

    const signature = cartSignature(selectedStore.id, cleanPhone, orderType, cleanTableNumber, cart);
    const lockKey = submissionLockKey(signature);
    try {
      const rawLock = window.localStorage.getItem(lockKey);
      if (rawLock) {
        const lock = JSON.parse(rawLock) as { createdAt?: number; trackingToken?: string; status?: string };
        if (lock.createdAt && Date.now() - lock.createdAt < SUBMISSION_LOCK_TTL_MS) {
          setError(lock.trackingToken
            ? 'This order was just submitted. Please use the tracking link instead of sending it again.'
            : 'This order is already being sent. Please wait a moment.');
          return;
        }
      }
      window.localStorage.setItem(lockKey, JSON.stringify({ createdAt: Date.now(), status: 'SENDING' }));
    } catch {
      // localStorage can be unavailable in private modes; the in-memory guard still prevents double taps.
    }

    submittingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const trackingToken = generateTrackingToken();
      const publicOrderReference = buildPublicOrderReference(trackingToken);
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
        customerName: cleanCustomerName,
        customerPhone: cleanPhone,
        orderType,
        ...(orderType === 'DINE_IN' ? { tableNumber: cleanTableNumber } : {}),
        notes: cleanNotes,
        items: onlineItems,
        subtotal: totals.subtotal,
        taxableAmount: totals.taxableAmount,
        gstTotal: totals.gstTotal,
        grandTotal: totals.grandTotal,
        status: 'PENDING',
        source: 'CUSTOMER_WEB',
        trackingToken,
        publicOrderReference,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      const orderRef = doc(collection(db, 'onlineOrders'));
      const batch = writeBatch(db);
      batch.set(orderRef, payload);
      batch.set(publicTrackingDocRef(trackingToken), buildInitialPublicTrackingDoc({
        onlineOrder: payload,
        trackingToken,
        publicOrderReference,
      }));
      await batch.commit();

      setConfirmation({
        id: trackingToken,
        publicOrderReference,
        storeName: selectedStore.name,
        estimatedPrepMinutes: selectedStore.estimatedPrepMinutes || 20,
        storeMessage: selectedStoreMessage,
        customerName: payload.customerName,
        orderType,
        tableNumber: payload.tableNumber,
        items: onlineItems,
        subtotal: totals.subtotal,
        gstTotal: totals.gstTotal,
        total: totals.grandTotal,
        status: 'PENDING',
      });
      try {
        window.localStorage.setItem(lockKey, JSON.stringify({ createdAt: Date.now(), status: 'SUBMITTED', trackingToken }));
      } catch {
        // Ignore lock persistence failures after a successful Firestore write.
      }
      setCart([]);
      setNotes('');
      setTableNumber('');
      setBasketOpen(false);
    } catch (err) {
      console.error('Failed to submit online order', err);
      try {
        window.localStorage.removeItem(lockKey);
      } catch {
        // Ignore localStorage cleanup failures.
      }
      setError('We could not send your order request. Please try again or call the store.');
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  };

  const copyTrackingLink = async (trackingToken: string) => {
    const trackingUrl = `${window.location.origin}/order/status/${trackingToken}`;
    try {
      await navigator.clipboard.writeText(trackingUrl);
      setCopyMessage('Tracking link copied.');
    } catch {
      setCopyMessage(trackingUrl);
    }
  };

  const renderItemThumb = (item: CustomerMenuItem, sizeClass = 'h-20 w-20') => {
    const meta = visualMeta(item);
    const Icon = meta.icon;
    const imageUrl = getItemImage(item);

    return (
      <div className={`${sizeClass} shrink-0 overflow-hidden rounded-2xl bg-[#f5eadf]`}>
        {imageUrl ? (
          <img src={imageUrl} alt={item.displayName || item.name} className="h-full w-full object-cover" />
        ) : (
          <div className={`flex h-full w-full items-center justify-center bg-gradient-to-br ${meta.gradient}`}>
            <Icon size={24} className={meta.iconColor} />
          </div>
        )}
      </div>
    );
  };

  const renderPopularCard = (item: CustomerMenuItem) => {
    const qty = cart.find(line => line.item.code === item.code)?.quantity || 0;
    const availability = itemAvailability[item.code] || getItemAvailability(item, selectedStoreId);
    const canOrder = selectedStoreOnline && availability.available;

    return (
      <article key={`popular-${item.code}`} className="min-w-[144px] max-w-[144px] rounded-2xl bg-white p-2.5 shadow-sm ring-1 ring-[#eadfd2]">
        {renderItemThumb(item, 'h-24 w-full')}
        <div className="mt-2 min-h-[78px]">
          <div className="mb-1 inline-flex rounded-full bg-[#ecf8ef] px-2 py-0.5 text-[10px] font-bold text-emerald-700">Popular</div>
          <h3 className="line-clamp-2 text-sm font-black leading-tight text-[#2d2019]">{item.displayName || item.name}</h3>
          <p className="mt-1 text-xs font-bold text-[#5c4033]">{formatMoney(toNumber(item.salePrice))}</p>
        </div>
        <button
          onClick={() => setCartQuantity(item, qty + 1)}
          disabled={!canOrder}
          className="mt-2 flex h-9 w-full items-center justify-center gap-1 rounded-full bg-[#3b261d] text-xs font-black text-white disabled:bg-neutral-300"
        >
          <Plus size={14} />
          Add
        </button>
      </article>
    );
  };

  const renderMenuCard = (item: CustomerMenuItem) => {
    const qty = cart.find(line => line.item.code === item.code)?.quantity || 0;
    const availability = itemAvailability[item.code] || getItemAvailability(item, selectedStoreId);
    const canOrder = selectedStoreOnline && availability.available;
    const meta = visualMeta(item);

    return (
      <article key={`menu-${item.code}`} className={`flex gap-3 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-[#eadfd2] ${canOrder ? '' : 'opacity-75'}`}>
        {renderItemThumb(item)}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[11px] font-bold text-[#a06f48]">{meta.label}</p>
              <h3 className="line-clamp-2 text-sm font-black leading-tight text-[#2d2019]">{item.displayName || item.name}</h3>
            </div>
            {qty > 0 ? (
              <div className="inline-flex shrink-0 items-center rounded-full border border-[#ead8c7] bg-[#fffaf5] p-0.5">
                <button onClick={() => setCartQuantity(item, qty - 1)} className="rounded-full p-1.5 text-[#5c4033]"><Minus size={13} /></button>
                <span className="min-w-5 text-center text-xs font-black">{qty}</span>
                <button onClick={() => setCartQuantity(item, qty + 1)} className="rounded-full p-1.5 text-[#5c4033]"><Plus size={13} /></button>
              </div>
            ) : (
              <button
                onClick={() => setCartQuantity(item, 1)}
                disabled={!canOrder}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#3b261d] text-white disabled:bg-neutral-300"
                aria-label={`Add ${item.displayName || item.name}`}
              >
                <Plus size={16} />
              </button>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-neutral-500">{shortDescription(item)}</p>
          <div className="mt-2 flex items-center justify-between">
            <p className="text-sm font-black text-[#2d2019]">{formatMoney(toNumber(item.salePrice))}</p>
            {!canOrder && <p className="text-[11px] font-bold text-red-700">{availability.reason}</p>}
          </div>
        </div>
      </article>
    );
  };

  const basketPanel = (
    <div className="flex h-full flex-col">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-black text-[#2d2019]">Your basket</h2>
          <p className="text-sm font-medium text-neutral-500">{itemCount} item{itemCount === 1 ? '' : 's'} for pickup</p>
        </div>
        <button onClick={() => setBasketOpen(false)} className="rounded-full bg-[#f8efe6] p-2 text-[#5c4033] lg:hidden">
          <X size={18} />
        </button>
      </div>

      {cart.length === 0 ? (
        <div className="rounded-2xl bg-[#fbf5ee] p-4 text-center">
          <ShoppingBag className="mx-auto mb-2 text-[#9b6a43]" size={28} />
          <p className="font-black text-[#2d2019]">Basket is empty</p>
          <p className="mt-1 text-sm text-neutral-500">Add your favourites to continue.</p>
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {cart.map(line => (
              <div key={line.item.code} className="flex gap-3 rounded-2xl bg-[#fffaf5] p-3">
                {renderItemThumb(line.item, 'h-14 w-14')}
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="line-clamp-2 text-sm font-black leading-tight text-[#2d2019]">{line.item.displayName || line.item.name}</p>
                      <p className="mt-1 text-xs font-bold text-neutral-500">{formatMoney(toNumber(line.item.salePrice))} each</p>
                    </div>
                    <button onClick={() => setCartQuantity(line.item, 0)} className="rounded-full bg-red-50 p-1.5 text-red-700">
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <div className="mt-3 flex items-center justify-between">
                    <div className="inline-flex items-center rounded-full border border-[#ead8c7] bg-white p-0.5">
                      <button onClick={() => setCartQuantity(line.item, line.quantity - 1)} className="rounded-full p-1.5"><Minus size={13} /></button>
                      <span className="min-w-7 text-center text-xs font-black">{line.quantity}</span>
                      <button onClick={() => setCartQuantity(line.item, line.quantity + 1)} className="rounded-full p-1.5"><Plus size={13} /></button>
                    </div>
                    <span className="text-sm font-black text-[#2d2019]">{formatMoney(toNumber(line.item.salePrice) * line.quantity)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 rounded-2xl bg-[#fbf5ee] p-4 text-sm">
            <div className="flex justify-between"><span>Subtotal</span><span className="font-black">{formatMoney(totals.subtotal)}</span></div>
            <div className="mt-2 flex justify-between"><span>GST</span><span className="font-black">{formatMoney(totals.gstTotal)}</span></div>
            <div className="mt-3 border-t border-[#ead8c7] pt-3 text-lg font-black text-[#2d2019]">
              <div className="flex justify-between"><span>Total</span><span>{formatMoney(totals.grandTotal)}</span></div>
            </div>
          </div>

          <div className="mt-4 space-y-3">
            <input value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="Your name" className="w-full rounded-2xl border border-[#e4d7c8] bg-white px-4 py-3 text-sm outline-none focus:border-[#5c4033]" />
            <input
              value={customerPhone}
              onChange={(event) => setCustomerPhone(event.target.value.replace(/\D/g, '').slice(0, 10))}
              placeholder="10-digit mobile number"
              inputMode="numeric"
              autoComplete="tel"
              className="w-full rounded-2xl border border-[#e4d7c8] bg-white px-4 py-3 text-sm outline-none focus:border-[#5c4033]"
            />
            <select value={orderType} onChange={(event) => handleOrderTypeChange(event.target.value as OnlineOrderType)} className="w-full rounded-2xl border border-[#e4d7c8] bg-white px-4 py-3 text-sm font-bold outline-none focus:border-[#5c4033]">
              <option value="PICKUP">Takeaway / pickup</option>
              <option value="DINE_IN">Dine in</option>
            </select>
            {orderType === 'DINE_IN' && (
              <input
                value={tableNumber}
                onChange={(event) => setTableNumber(event.target.value.slice(0, 20))}
                placeholder="Table number"
                className="w-full rounded-2xl border border-[#e4d7c8] bg-white px-4 py-3 text-sm outline-none focus:border-[#5c4033]"
              />
            )}
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value.slice(0, MAX_NOTE_LENGTH))}
              placeholder="Pickup note for the store"
              rows={3}
              maxLength={MAX_NOTE_LENGTH}
              className="w-full rounded-2xl border border-[#e4d7c8] bg-white px-4 py-3 text-sm outline-none focus:border-[#5c4033]"
            />
            <p className="text-right text-[11px] font-bold text-neutral-400">{notes.length}/{MAX_NOTE_LENGTH}</p>
          </div>

          <button
            onClick={submitOrder}
            disabled={saving || loading || cart.length === 0 || !selectedStoreOnline}
            className="mt-4 w-full rounded-2xl bg-[#3b261d] px-4 py-4 text-sm font-black text-white shadow-sm disabled:cursor-not-allowed disabled:bg-neutral-300"
          >
            {saving ? 'Sending request...' : 'Send order request'}
          </button>
          <p className="mt-3 text-center text-xs font-medium text-neutral-500">The store will confirm your order shortly.</p>
        </>
      )}
    </div>
  );

  if (confirmation) {
    return (
      <div className="min-h-[100dvh] bg-[#f8efe6] px-4 py-5 font-sans text-neutral-900">
        <div className="mx-auto max-w-md">
          <header className="mb-4 flex items-center gap-3">
            <img src={coffeeBondLogo} alt="Coffee Bond" className="h-10 w-10 rounded-xl bg-white object-contain p-1 shadow-sm" />
            <div>
              <p className="text-xs font-black tracking-[0.18em] text-[#9a6a45]">COFFEE BOND</p>
              <h1 className="text-lg font-black text-[#2d2019]">Order ahead</h1>
            </div>
          </header>

          <div className="rounded-3xl bg-white p-5 text-center shadow-sm ring-1 ring-[#eadfd2]">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
              <CheckCircle2 size={34} />
            </div>
            <h2 className="text-2xl font-black text-[#2d2019]">Order request sent</h2>
            <p className="mt-2 text-sm leading-relaxed text-neutral-600">Thank you. The store will review and confirm your order shortly.</p>

            <div className="mt-5 space-y-3 rounded-2xl bg-[#fbf5ee] p-4 text-left">
              <div>
                <p className="text-xs font-bold text-neutral-500">Reference</p>
                <p className="mt-1 break-all font-black text-[#2d2019]">{confirmation.publicOrderReference}</p>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-xl bg-white p-3">
                  <p className="text-xs font-bold text-neutral-500">Store</p>
                  <p className="mt-1 font-black text-[#2d2019]">{confirmation.storeName}</p>
                </div>
                <div className="rounded-xl bg-white p-3">
                  <p className="text-xs font-bold text-neutral-500">Prep time</p>
                  <p className="mt-1 font-black text-[#2d2019]">{prepWindowLabel(confirmation.estimatedPrepMinutes)}</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-xl bg-white p-3">
                  <p className="text-xs font-bold text-neutral-500">Customer</p>
                  <p className="mt-1 font-black text-[#2d2019]">{confirmation.customerName}</p>
                </div>
                <div className="rounded-xl bg-white p-3">
                  <p className="text-xs font-bold text-neutral-500">Order type</p>
                  <p className="mt-1 font-black text-[#2d2019]">
                    {confirmation.orderType === 'DINE_IN' ? `Dine in${confirmation.tableNumber ? ` · ${confirmation.tableNumber}` : ''}` : 'Takeaway'}
                  </p>
                </div>
              </div>
              <div className="rounded-xl bg-white p-3">
                <p className="mb-2 text-xs font-bold text-neutral-500">Items</p>
                <div className="space-y-2">
                  {confirmation.items.map(item => (
                    <div key={`${confirmation.id}-${item.finishedGoodCode}`} className="flex justify-between gap-3 text-sm">
                      <span className="font-bold text-neutral-700">{item.quantity} x {item.itemName}</span>
                      <span className="font-black text-[#2d2019]">{formatMoney(item.lineTotal)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-xl bg-white p-3 text-sm">
                <div className="flex justify-between"><span className="font-bold text-neutral-600">Subtotal</span><span className="font-black text-[#2d2019]">{formatMoney(confirmation.subtotal)}</span></div>
                <div className="mt-2 flex justify-between"><span className="font-bold text-neutral-600">GST</span><span className="font-black text-[#2d2019]">{formatMoney(confirmation.gstTotal)}</span></div>
                <div className="mt-3 border-t border-[#ead8c7] pt-3 text-base font-black text-[#2d2019]">
                  <div className="flex justify-between"><span>Total</span><span>{formatMoney(confirmation.total)}</span></div>
                </div>
              </div>
              <div className="rounded-xl bg-amber-50 p-3 text-sm font-bold text-amber-900">
                Payment: Pay at counter after the store accepts your request.
              </div>
            </div>

            <div className="mt-5 grid gap-3">
              <Link to={`/order/status/${confirmation.id}`} className="rounded-2xl bg-[#3b261d] px-4 py-4 text-sm font-black text-white">
                Track your order
              </Link>
              <button onClick={() => copyTrackingLink(confirmation.id)} className="inline-flex items-center justify-center gap-2 rounded-2xl border border-[#e4d7c8] bg-white px-4 py-4 text-sm font-black text-[#5c4033]">
                <Copy size={16} />
                Copy tracking link
              </button>
              <button
                onClick={() => {
                  setConfirmation(null);
                  setCopyMessage('');
                }}
                className="rounded-2xl bg-[#fbf5ee] px-4 py-4 text-sm font-black text-[#5c4033]"
              >
                Start another order
              </button>
            </div>

            {copyMessage && <p className="mt-3 break-all rounded-xl bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">{copyMessage}</p>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] min-w-0 overflow-x-hidden bg-[#f8efe6] pb-24 font-sans text-neutral-900 lg:pb-8">
      <header className="sticky top-0 z-30 border-b border-[#eadfd2] bg-[#fffaf5]/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-md min-w-0 items-center justify-between gap-3 lg:max-w-6xl">
          <div className="flex min-w-0 items-center gap-3">
            <img src={coffeeBondLogo} alt="Coffee Bond" className="h-10 w-10 rounded-xl bg-white object-contain p-1 shadow-sm" />
            <div className="min-w-0">
              <p className="text-xs font-black tracking-[0.18em] text-[#9a6a45]">COFFEE BOND</p>
              <h1 className="truncate text-lg font-black text-[#2d2019]">Order ahead</h1>
            </div>
          </div>
          <button
            onClick={() => setBasketOpen(true)}
            className="inline-flex items-center gap-2 rounded-full bg-[#3b261d] px-3 py-2 text-xs font-black text-white shadow-sm"
          >
            <ShoppingBag size={15} />
            {itemCount}
          </button>
        </div>
      </header>

      <main className="mx-auto grid max-w-md min-w-0 gap-5 px-4 py-4 lg:max-w-6xl lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6 lg:px-6">
        <section className="min-w-0 space-y-4">
          <section className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-[#eadfd2]">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold text-neutral-500">Pickup from</p>
                <label className="mt-1 flex items-center gap-2">
                  <StoreIcon size={16} className="text-[#9a6a45]" />
                  <select
                    value={selectedStoreId}
                    onChange={(event) => handleStoreChange(event.target.value)}
                    className="max-w-[210px] appearance-none bg-transparent text-base font-black text-[#2d2019] outline-none"
                    aria-label="Select pickup store"
                  >
                    {stores.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}
                  </select>
                  <ChevronDown size={16} className="text-neutral-400" />
                </label>
              </div>
              <div className="rounded-full bg-[#fbf5ee] px-3 py-2 text-xs font-black text-[#5c4033]">
                {selectedStore ? estimatedPrepLabel(selectedStore) : '--'}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-black ${
                selectedStoreOnline ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
              }`}>
                <CheckCircle2 size={13} />
                {selectedStoreOnline ? 'Accepting orders' : 'Unavailable'}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[#fbf5ee] px-3 py-1.5 text-xs font-bold text-[#5c4033]">
                <Clock size={13} />
                Pickup
              </span>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-neutral-600">{selectedStoreMessage}</p>
            {availabilityLoading ? (
              <p className="mt-3 rounded-2xl bg-[#fbf5ee] px-3 py-2 text-xs font-bold text-[#7b5a42]">
                Checking item availability...
              </p>
            ) : availabilityNotice ? (
              <p className="mt-3 rounded-2xl bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">
                {availabilityNotice}
              </p>
            ) : null}
          </section>

          <label className="flex h-12 items-center gap-2 rounded-2xl bg-white px-4 shadow-sm ring-1 ring-[#eadfd2]">
            <Search size={18} className="text-neutral-400" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="w-full bg-transparent text-sm outline-none"
              placeholder="Search coffee, food, desserts..."
            />
          </label>

          <nav className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
            {categories.map(cat => (
              <button
                key={cat}
                onClick={() => setCategory(cat)}
                className={`shrink-0 rounded-full px-4 py-2 text-sm font-black transition-colors ${
                  category === cat ? 'bg-[#3b261d] text-white' : 'bg-white text-[#5c4033] ring-1 ring-[#eadfd2]'
                }`}
              >
                {categoryLabel(cat)}
              </button>
            ))}
          </nav>

          {error && (
            <div className="flex gap-3 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-800">
              <AlertCircle size={18} className="shrink-0" />
              {error}
            </div>
          )}

          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xl font-black text-[#2d2019]">Popular today</h2>
              <p className="text-xs font-bold text-neutral-500">Quick add</p>
            </div>
            {loading ? (
              <div className="rounded-2xl bg-white p-5 text-center text-sm font-bold text-neutral-500">Loading favourites...</div>
            ) : popularItems.length === 0 ? (
              <div className="rounded-2xl bg-white p-5 text-center text-sm font-bold text-neutral-500">No popular items available.</div>
            ) : (
              <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-2">
                {popularItems.map(item => renderPopularCard(item))}
              </div>
            )}
          </section>

          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xl font-black text-[#2d2019]">Explore the menu</h2>
              <p className="text-xs font-bold text-neutral-500">{visibleItems.length} items</p>
            </div>
            {loading ? (
              <div className="rounded-2xl bg-white p-5 text-center text-sm font-bold text-neutral-500">Loading menu...</div>
            ) : visibleItems.length === 0 ? (
              <div className="rounded-2xl bg-white p-5 text-center">
                <p className="font-black text-neutral-800">Nothing found here</p>
                <p className="text-sm text-neutral-500">Try another category or search.</p>
              </div>
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                {visibleItems.map(item => renderMenuCard(item))}
              </div>
            )}
          </section>
        </section>

        <aside className="hidden h-fit max-h-[calc(100dvh-6rem)] overflow-y-auto rounded-3xl bg-white p-5 shadow-sm ring-1 ring-[#eadfd2] lg:sticky lg:top-24 lg:block">
          {basketPanel}
        </aside>
      </main>

      <button
        onClick={() => setBasketOpen(true)}
        className="fixed inset-x-4 bottom-4 z-40 flex items-center justify-between rounded-2xl bg-[#3b261d] px-5 py-4 text-sm font-black text-white shadow-[0_14px_40px_rgba(45,32,25,0.25)] lg:hidden"
      >
        <span>View basket · {itemCount} item{itemCount === 1 ? '' : 's'}</span>
        <span>{formatMoney(totals.grandTotal)}</span>
      </button>

      {basketOpen && (
        <div className="fixed inset-0 z-50 bg-black/35 lg:hidden">
          <button aria-label="Close basket" className="absolute inset-0 h-full w-full cursor-default" onClick={() => setBasketOpen(false)} />
          <div className="absolute inset-x-0 bottom-0 max-h-[88dvh] overflow-y-auto rounded-t-3xl bg-white p-4 shadow-2xl sm:p-5">
            <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-neutral-200" />
            {basketPanel}
          </div>
        </div>
      )}
    </div>
  );
}
