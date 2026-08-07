import React, { useEffect, useMemo, useRef, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import {
  AlertCircle,
  CakeSlice,
  CheckCircle2,
  ChevronDown,
  Coffee,
  Copy,
  CupSoda,
  Leaf,
  MapPin,
  Minus,
  Navigation,
  Plus,
  Search,
  ShoppingBag,
  Sparkles,
  Star,
  Trash2,
  Utensils,
  X,
} from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import CustomerProductCustomizationSheet from '../../components/customer/CustomerProductCustomizationSheet';
import CustomerBasketItemCard from '../../components/customer/CustomerBasketItemCard';
import CustomerBasketEmptyState from '../../components/customer/CustomerBasketEmptyState';
import CustomerPickupSummary from '../../components/customer/CustomerPickupSummary';
import CustomerHeader from '../../components/customer/CustomerHeader';
import CustomerOtpPanel from '../../components/customer/CustomerOtpPanel';
import CustomerProductImage from '../../components/customer/CustomerProductImage';
import DietaryMarker from '../../components/customer/DietaryMarker';
import { useConnectivity } from '../../contexts/ConnectivityContext';
import {
  activeAddOnGroupsForProduct,
  addOnSelectionKey,
  addOnTaxForLine,
  addOnTotal,
  canonicalAddOnSelections,
  unitPriceWithAddOns,
} from '../../lib/addOns';
import { db, functions } from '../../lib/firebase';
import { CustomerProfile, customerFunctions, restoreCustomerProfile } from '../../lib/customerAuth';
import {
  CheckoutHydrationState,
  CustomerCheckoutDraft,
  CustomerCheckoutDraftInput,
  PersistedCheckoutAddOn,
  checkoutCatalogMarker,
  clearCustomerCheckoutDraft,
  readCustomerCheckoutDraft,
  restoreCustomerCheckoutDraft,
  writeCustomerCheckoutDraft,
} from '../../lib/customerCheckoutPersistence';
import { rememberCustomerOrder } from '../../lib/customerOrderPersistence';
import CustomerMyUsualCard from '../../components/customer/CustomerMyUsualCard';
import {
  CustomerMyUsual,
  buildMyUsualPayload,
  purgeLegacyDeviceMyUsual,
} from '../../lib/customerMyUsual';
import {
  deleteCustomerMyUsual as deleteCustomerMyUsualRequest,
  getCustomerMyUsual as getCustomerMyUsualRequest,
  saveCustomerMyUsual as saveCustomerMyUsualRequest,
} from '../../lib/customerMyUsualApi';
import { beginCriticalOperation, OFFLINE_ACTION_MESSAGE } from '../../lib/connectivity';
import {
  CUSTOMER_CATEGORY_ORDER,
  customerMenuCategory,
  trustedDietaryClassification,
} from '../../lib/customerMenuPresentation';
import { CUSTOMER_HOME_PATH, customerStatusPath, customerTrackingUrl, normalizeTrackingPath } from '../../lib/customerRoutes';
import CustomerProductCard from '../../components/customer/CustomerProductCard';
import CustomerStoreCard from '../../components/customer/CustomerStoreCard';
import CustomerCategoryRail from '../../components/customer/CustomerCategoryRail';
import CustomerBottomNav from '../../components/customer/CustomerBottomNav';
import {
  loadRazorpayCheckout,
  RazorpayCheckoutSuccess,
  RazorpayOrderResponse,
  validateRazorpayOrderResponse,
} from '../../lib/razorpayCheckout';
import {
  deriveCustomerOrderingState,
  prepWindowLabel,
  storeOnlineMessage,
} from '../../lib/customerOrderingState';
import { isGoldenISetupWarningOnly } from '../../lib/publicMenuAvailability';
import { AddOnSelection, OnlineOrderType, PaymentProvider, PublicOrderStatus, PublicOrderTrackingItem, Store } from '../../types';
import { AddOnGroup, FinishedGood } from '../../types/menu-management';

type CustomerMenuItem = FinishedGood & { id: string };

type CartLine = {
  id: string;
  item: CustomerMenuItem;
  quantity: number;
  addOns: AddOnSelection[];
};

/**
 * Confirmation dialogs owned by My Usual. Nothing here submits an order, creates a
 * payment or opens a checkout session — SIGN_IN reuses the existing customer OTP panel
 * purely to obtain the profile the usual is saved to.
 */
type MyUsualDialog =
  | null
  | { type: 'SIGN_IN' }
  | { type: 'CONFIRM_PENDING_SAVE' }
  | { type: 'SAVE_NEW' }
  | { type: 'REPLACE_USUAL' }
  | { type: 'REPLACE_BASKET'; lines: CartLine[]; intent: 'ORDER' | 'EDIT' }
  // A usual belongs to the customer, not to a store. When something in it cannot be
  // rebuilt at the CURRENTLY selected store, the customer is told exactly what and
  // offered a different store — never forced back to the store it was saved from.
  | { type: 'UNAVAILABLE'; items: string[]; addOns: { product: string; addOn: string }[] }
  | { type: 'STORE_CLOSED'; message: string }
  | { type: 'DELETE' };

type ConfirmationState = {
  id: string;
  publicOrderReference: string;
  storeName: string;
  estimatedPrepMinutes?: number;
  storeMessage: string;
  customerName: string;
  orderType: OnlineOrderType;
  tableNumber?: string | null;
  items: PublicOrderTrackingItem[];
  subtotal: number;
  gstTotal: number;
  total: number;
  status: PublicOrderStatus;
  paymentProvider: PaymentProvider;
  paymentStatus: 'NOT_STARTED';
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
  addOnGroups?: Record<string, AddOnGroup>;
};

type SubmissionLock = {
  createdAt?: number;
  clientIdempotencyKey?: string;
  trackingToken?: string;
  status?: 'SENDING' | 'SUBMITTED';
};

type SubmitCustomerOrderRequest = {
  storeCode: string;
  customerName: string;
  customerPhone: string;
  orderType: OnlineOrderType;
  tableNumber?: string | null;
  notes: string;
  items: Array<{
    itemCode: string;
    quantity: number;
    addOns?: Array<{
      groupId: string;
      optionId: string;
      quantity: number;
    }>;
  }>;
  clientIdempotencyKey: string;
  paymentProvider: PaymentProvider;
};

type SubmitCustomerOrderResponse = {
  trackingToken: string;
  publicOrderReference: string;
  storeName: string;
  orderType: OnlineOrderType;
  tableNumber?: string | null;
  items: PublicOrderTrackingItem[];
  subtotal: number;
  gstTotal: number;
  total: number;
  status: PublicOrderStatus;
  paymentProvider: PaymentProvider;
  paymentStatus: 'NOT_STARTED';
  customerStatusMessage: string;
  estimatedPrepMinutes?: number;
  storeMessage: string;
};

const submitCustomerOrderCallable = httpsCallable<SubmitCustomerOrderRequest, SubmitCustomerOrderResponse>(
  functions,
  'submitCustomerOrder',
);
const createCustomerCheckoutSession = httpsCallable<
  Omit<SubmitCustomerOrderRequest, 'customerPhone' | 'paymentProvider'> & { storeId: string },
  RazorpayOrderResponse
>(customerFunctions, 'createCustomerCheckoutSession');
const verifyCustomerRazorpayPayment = httpsCallable<
  RazorpayCheckoutSuccess & { sessionId: string },
  {
    onlineOrderId: string;
    trackingToken: string;
    trackingPath: string;
    customerStatusMessage: string;
  }
>(customerFunctions, 'verifyCustomerRazorpayPayment');

const APP_TAX_RATE_KEYS = ['defaultGstRate', 'gstRate', 'taxRate', 'defaultTaxRate', 'defaultGSTPercent', 'gstPercent', 'taxPercent'];
const STORE_TAX_RATE_KEYS = ['gstRate', 'taxRate', 'defaultGstRate', 'defaultTaxRate', 'gstPercent', 'taxPercent'];
const ITEM_TAX_RATE_KEYS = ['taxRate', 'gstRate', 'taxPercent', 'gstPercent'];
const MAX_NOTE_LENGTH = 200;
const SUBMISSION_LOCK_TTL_MS = 2 * 60 * 1000;
const DEFAULT_STORE_KEY = 'coffeeBondCustomerDefaultStoreId';

type StoreCoordinate = {
  latitude: number;
  longitude: number;
};

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

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function storeCoordinate(store: Store): StoreCoordinate | null {
  const record = store as Store & Record<string, unknown>;
  const nested = record.location || record.geoPoint || record.coordinates;
  const nestedRecord = nested && typeof nested === 'object' ? nested as Record<string, unknown> : {};
  const latitude = numberOrNull(record.latitude)
    ?? numberOrNull(record.lat)
    ?? numberOrNull(nestedRecord.latitude)
    ?? numberOrNull(nestedRecord.lat);
  const longitude = numberOrNull(record.longitude)
    ?? numberOrNull(record.lng)
    ?? numberOrNull(nestedRecord.longitude)
    ?? numberOrNull(nestedRecord.lng);
  if (latitude === null || longitude === null) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

function distanceKm(a: StoreCoordinate, b: StoreCoordinate): number {
  const earthRadiusKm = 6371;
  const lat1 = a.latitude * Math.PI / 180;
  const lat2 = b.latitude * Math.PI / 180;
  const deltaLat = (b.latitude - a.latitude) * Math.PI / 180;
  const deltaLon = (b.longitude - a.longitude) * Math.PI / 180;
  const sinLat = Math.sin(deltaLat / 2);
  const sinLon = Math.sin(deltaLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * earthRadiusKm * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function closestStoreToPosition(stores: Store[], position: StoreCoordinate): { store: Store; distanceKm: number } | null {
  return stores.reduce<{ store: Store; distanceKm: number } | null>((closest, store) => {
    const coordinate = storeCoordinate(store);
    if (!coordinate) return closest;
    const distance = distanceKm(position, coordinate);
    if (!closest || distance < closest.distanceKm) return { store, distanceKm: distance };
    return closest;
  }, null);
}

function defaultStoreIdFromStorage(stores: Store[]): string {
  try {
    const stored = window.localStorage.getItem(DEFAULT_STORE_KEY);
    if (stored && stores.some(store => store.id === stored)) return stored;
  } catch {
    // Storage is optional for public ordering.
  }
  return '';
}

function itemTaxRate(item: CustomerMenuItem, fallbackRate: number): number {
  const itemRate = pickTaxRate(item as unknown as Record<string, unknown>, ITEM_TAX_RATE_KEYS);
  return itemRate > 0 ? itemRate : fallbackRate;
}

function cartLineCatalogMarker(
  item: CustomerMenuItem,
  addOns: AddOnSelection[],
  fallbackTaxRate: number,
): string {
  return checkoutCatalogMarker([
    item.code,
    toNumber(item.salePrice),
    itemTaxRate(item, fallbackTaxRate),
    addOns
      .map(addOn => [addOn.groupId, addOn.optionId, addOn.quantity, addOn.unitPrice, addOn.taxRate])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1]))),
  ]);
}

function persistedCheckoutLines(cart: CartLine[], fallbackTaxRate: number) {
  return cart.map(line => ({
    lineId: line.id,
    productId: line.item.id,
    productCode: line.item.code,
    quantity: line.quantity,
    addOns: line.addOns.map(addOn => ({
      groupId: addOn.groupId,
      optionId: addOn.optionId,
      quantity: addOn.quantity,
    })),
    catalogMarker: cartLineCatalogMarker(line.item, line.addOns, fallbackTaxRate),
  }));
}

function isStoreAvailable(item: CustomerMenuItem, storeId: string): boolean {
  return Array.isArray(item.availableStoreIds) && item.availableStoreIds.includes(storeId);
}

function estimatedPrepLabel(store: Store | null): string {
  return prepWindowLabel(store?.estimatedPrepMinutes);
}

function categoryLabel(category: string): string {
  if (category === 'ALL') return 'All';
  if (category === 'Matcha & Tea') return 'Matcha';
  return category;
}

function shortDescription(item: CustomerMenuItem): string {
  if (item.description?.trim()) return item.description.trim();
  const group = customerMenuCategory(item);
  if (group === 'Coffee') return 'Freshly prepared by the Coffee Bond bar.';
  if (group === 'Cold Coffee') return 'Chilled, smooth, and made for pickup.';
  if (group === 'Matcha & Tea') return 'A calm cup for a slower moment.';
  if (group === 'Food' || group === 'Baked by Bond') return 'Made fresh for your order.';
  if (group === 'Desserts') return 'A sweet finish from Coffee Bond.';
  return 'Add it to your pickup basket.';
}

/**
 * Per-line quantity ceiling. Matches MAX_QUANTITY in functions/index.js so the
 * customization sheet can never build a line the order backend would reject.
 */
const CUSTOMER_MAX_LINE_QUANTITY = 20;

/**
 * Authoritative product description, or undefined. Nothing is generated: if the
 * catalogue has no description the sheet simply omits it.
 */
function cleanProductDescription(item: CustomerMenuItem): string | undefined {
  const record = item as CustomerMenuItem & Record<string, unknown>;
  for (const key of ['description', 'shortDescription', 'publicDescription']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
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
  const group = customerMenuCategory(item);
  if (group === 'Coffee') {
    return { label: 'Coffee', gradient: 'bg-[#f1dfca]', iconColor: 'text-[#6c4025]', icon: Coffee };
  }
  if (group === 'Cold Coffee') {
    return { label: 'Cold coffee', gradient: 'bg-[#dcece4]', iconColor: 'text-[#2f6b4b]', icon: CupSoda };
  }
  if (group === 'Cold Drinks') {
    return { label: 'Cold drink', gradient: 'bg-[#e5f2ec]', iconColor: 'text-[#2f6b4b]', icon: CupSoda };
  }
  if (group === 'Matcha & Tea') {
    return { label: 'Matcha', gradient: 'bg-[#e3ecd5]', iconColor: 'text-[#4d6b34]', icon: Leaf };
  }
  if (group === 'Desserts') {
    return { label: 'Dessert', gradient: 'bg-[#f3ddd3]', iconColor: 'text-[#8a4a38]', icon: CakeSlice };
  }
  if (group === 'Baked by Bond') {
    return { label: 'Baked by Bond', gradient: 'bg-[#f4e5dc]', iconColor: 'text-[#8a4a38]', icon: CakeSlice };
  }
  if (group === 'Add Ons') {
    return { label: 'Add on', gradient: 'bg-[#eee4da]', iconColor: 'text-[#705748]', icon: Sparkles };
  }
  return { label: group === 'Other' ? 'Other' : 'Food', gradient: 'bg-[#f0e0d4]', iconColor: 'text-[#7f5136]', icon: Utensils };
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

function cartSignature(
  storeId: string,
  customerPhone: string,
  orderType: OnlineOrderType,
  tableNumber: string,
  paymentProvider: PaymentProvider,
  cart: CartLine[],
): string {
  const cartParts = cart
    .map(line => `${line.item.code}:${line.quantity}:${addOnSelectionKey(line.addOns)}`)
    .sort()
    .join('|');
  return [
    storeId,
    normalizeIndianPhone(customerPhone),
    orderType,
    orderType === 'DINE_IN' ? tableNumber.trim().toUpperCase() : 'PICKUP',
    paymentProvider,
    cartParts,
  ].join('::');
}

function submissionLockKey(signature: string): string {
  return `coffeeBondOnlineOrder:${signature}`;
}

function createClientIdempotencyKey(): string {
  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function customerSubmitErrorMessage(err: unknown): string {
  const error = err as { code?: string; message?: string };
  const code = error?.code || '';
  const message = error?.message || '';
  if (code.includes('invalid-argument') || code.includes('failed-precondition') || code.includes('already-exists')) {
    return message || 'Please review your order details and try again.';
  }
  if (code.includes('unavailable') || code.includes('deadline-exceeded')) {
    return 'The store connection is busy right now. Please try again in a moment.';
  }
  return 'We could not send your order request. Please try again or call the store.';
}

export default function CustomerOrder() {
  const navigate = useNavigate();
  const { isOffline, requireOnline } = useConnectivity();
  const [stores, setStores] = useState<Store[]>([]);
  const [items, setItems] = useState<CustomerMenuItem[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('ALL');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [orderType, setOrderType] = useState<OnlineOrderType>('PICKUP');
  const [paymentProvider, setPaymentProvider] = useState<PaymentProvider>('PAY_AT_COUNTER');
  const [verifiedCustomer, setVerifiedCustomer] = useState<CustomerProfile | null>(null);
  const [tableNumber, setTableNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [gstConfig, setGstConfig] = useState<GstConfig>({ defaultRate: 0, storeOverrides: {} });
  const [publicAvailability, setPublicAvailability] = useState<PublicAvailabilitySnapshot | null>(null);
  const [pendingAddOnItem, setPendingAddOnItem] = useState<CustomerMenuItem | null>(null);
  const [editingAddOnLine, setEditingAddOnLine] = useState<CartLine | null>(null);
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [basketOpen, setBasketOpen] = useState(false);
  const [storeSelectorOpen, setStoreSelectorOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState('');
  const [confirmation, setConfirmation] = useState<ConfirmationState | null>(null);
  const [storePreferenceMessage, setStorePreferenceMessage] = useState('');
  const [locatingStore, setLocatingStore] = useState(false);
  const [checkoutHydration, setCheckoutHydration] = useState<CheckoutHydrationState>('NOT_STARTED');
  const [loadedMenuStoreId, setLoadedMenuStoreId] = useState('');
  const [checkoutDraftNotice, setCheckoutDraftNotice] = useState('');
  const [paymentNotice, setPaymentNotice] = useState('');
  const [customerAuthRestored, setCustomerAuthRestored] = useState(false);
  const [basketAnnouncement, setBasketAnnouncement] = useState('');
  const [basketBumpKey, setBasketBumpKey] = useState(0);
  // Lets the bottom-navigation Search action focus the existing menu search input
  // rather than introducing a second search control.
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const submittingRef = useRef(false);
  const userStoreChoiceRef = useRef(false);
  const triedAutoLocationRef = useRef(false);
  const pendingCheckoutDraftRef = useRef<CustomerCheckoutDraft | null>(null);
  const hydrationAppliedRef = useRef(false);

  useEffect(() => {
    if (!storePreferenceMessage) return undefined;
    const timeout = window.setTimeout(() => setStorePreferenceMessage(''), 2800);
    return () => window.clearTimeout(timeout);
  }, [storePreferenceMessage]);

  useEffect(() => {
    let active = true;
    restoreCustomerProfile().then(profile => {
      if (!active || !profile) return;
      setVerifiedCustomer(profile);
      setCustomerPhone(profile.normalisedPhone.replace('+91', ''));
      setCustomerName(current => current.trim() ? current : profile.displayName);
    }).catch(() => {
      // The OTP panel remains available when a previous customer session cannot be restored.
    }).finally(() => {
      if (active) setCustomerAuthRestored(true);
    });
    return () => {
      active = false;
    };
  }, []);

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

        const savedStoreId = defaultStoreIdFromStorage(loadedStores);
        const draftResult = readCustomerCheckoutDraft(window.localStorage);
        const draftStore = draftResult.draft
          ? loadedStores.find(store => store.id === draftResult.draft?.selectedStoreId)
          : null;
        if (draftResult.draft && draftStore) {
          triedAutoLocationRef.current = true;
          pendingCheckoutDraftRef.current = draftResult.draft;
          setCheckoutHydration('RESTORING');
        } else {
          if (draftResult.draft && !draftStore) {
            clearCustomerCheckoutDraft(window.localStorage);
            setCheckoutDraftNotice('Your saved basket used a store that is no longer available, so it was removed.');
          }
          pendingCheckoutDraftRef.current = null;
          setCheckoutHydration('RESTORED');
        }
        const initialStoreId = draftStore?.id || savedStoreId || loadedStores[0]?.id || '';
        setStores(loadedStores);
        setSelectedStoreId(prev => prev || initialStoreId);
        if (!draftStore && savedStoreId) {
          const savedStore = loadedStores.find(store => store.id === savedStoreId);
          setStorePreferenceMessage(savedStore ? `Using your default store: ${savedStore.name}.` : '');
        }
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
        setLoadedMenuStoreId('');
        return;
      }

      setLoadedMenuStoreId('');
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
        setLoadedMenuStoreId(selectedStoreId);
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

  const selectClosestStore = (options: { automatic?: boolean } = {}) => {
    if (locatingStore) return;
    if (stores.length === 0) return;
    const storesWithCoordinates = stores.filter(store => storeCoordinate(store));
    if (storesWithCoordinates.length === 0) {
      if (!options.automatic) setStorePreferenceMessage('Nearest store needs store coordinates first.');
      return;
    }
    if (!navigator.geolocation) {
      if (!options.automatic) setStorePreferenceMessage('Location is not available in this browser.');
      return;
    }

    setLocatingStore(true);
    if (!options.automatic) setStorePreferenceMessage('Finding the nearest Coffee Bond...');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocatingStore(false);
        if (options.automatic && userStoreChoiceRef.current) return;
        const closest = closestStoreToPosition(stores, {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
        if (!closest) {
          setStorePreferenceMessage('Nearest store could not be calculated yet.');
          return;
        }
        if (cart.length > 0 && closest.store.id !== selectedStoreId) {
          setStorePreferenceMessage(`${closest.store.name} is nearest, but your basket is already started.`);
          return;
        }
        if (closest.store.id !== selectedStoreId) {
          clearCustomerCheckoutDraft(window.localStorage);
          setCheckoutDraftNotice('');
        }
        setSelectedStoreId(closest.store.id);
        setCategory('ALL');
        setSearch('');
        setError(null);
        setStoreSelectorOpen(false);
        setStorePreferenceMessage(`Nearest store selected: ${closest.store.name} (${closest.distanceKm.toFixed(1)} km away).`);
      },
      (geoError) => {
        setLocatingStore(false);
        if (!options.automatic) {
          setStorePreferenceMessage(geoError.code === geoError.PERMISSION_DENIED
            ? 'Location permission was not allowed. You can still choose a store manually.'
            : 'Could not get your location. Please choose a store manually.');
        }
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 10 * 60 * 1000 },
    );
  };

  useEffect(() => {
    if (checkoutHydration !== 'RESTORED') return;
    if (stores.length === 0 || triedAutoLocationRef.current) return;
    if (defaultStoreIdFromStorage(stores)) return;
    if (!stores.some(store => storeCoordinate(store))) return;
    triedAutoLocationRef.current = true;
    selectClosestStore({ automatic: true });
  }, [checkoutHydration, stores]);

  const selectedStore = useMemo(() => stores.find(store => store.id === selectedStoreId) || null, [stores, selectedStoreId]);
  const selectedStoreTaxRate = useMemo(() => storeTaxRate(selectedStore, gstConfig), [selectedStore, gstConfig]);
  const addOnGroups = useMemo(
    () => Object.values(publicAvailability?.addOnGroups || {}),
    [publicAvailability],
  );
  const selectedStoreMessage = storeOnlineMessage(selectedStore);
  const availabilitySnapshotStale = isSnapshotStale(publicAvailability);
  const availabilityNotice = availabilitySnapshotStale
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
      const setupWarningOnly = selectedStore
        && isGoldenISetupWarningOnly(selectedStore, publicItem?.publicStatus);
      if (baseAvailability.available && publicItem?.available === false && !setupWarningOnly) {
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
  }, [storeItems, selectedStore, selectedStoreId, publicAvailability]);

  useEffect(() => {
    const draft = pendingCheckoutDraftRef.current;
    if (
      checkoutHydration !== 'RESTORING'
      || hydrationAppliedRef.current
      || !draft
      || loadedMenuStoreId !== selectedStoreId
      || draft.selectedStoreId !== selectedStoreId
    ) {
      return;
    }

    hydrationAppliedRef.current = true;
    const restored = restoreCustomerCheckoutDraft<CustomerMenuItem, AddOnSelection>(draft, checkoutRestoreOptions());
    applyRestoredDraft(draft, restored);
  }, [
    addOnGroups,
    checkoutHydration,
    itemAvailability,
    loadedMenuStoreId,
    selectedStoreId,
    selectedStoreTaxRate,
    storeItems,
  ]);

  /**
   * One definition of the product/add-on/availability/marker rules, shared by the
   * checkout-draft hydration above and by My Usual revalidation. Forking these would
   * let the two paths disagree about what is orderable.
   */
  function checkoutRestoreOptions() {
    return {
      items: storeItems,
      itemId: (item: CustomerMenuItem) => item.id,
      itemCode: (item: CustomerMenuItem) => item.code,
      isItemAvailable: (item: CustomerMenuItem) => (
        itemAvailability[item.code] || getItemAvailability(item, selectedStoreId)
      ).available,
      restoreAddOns: (item: CustomerMenuItem, savedAddOns: PersistedCheckoutAddOn[]) => {
        const activeGroups = activeAddOnGroupsForProduct(
          item.addOnGroupIds,
          item.addOnOptionIdsByGroup,
          addOnGroups,
        );
        const activeOptions = new Map(activeGroups.map(group => [
          group.id || '',
          new Set(group.options.map(option => option.id)),
        ]));
        const validAddOns = savedAddOns.filter(addOn => activeOptions.get(addOn.groupId)?.has(addOn.optionId));
        try {
          const canonical = canonicalAddOnSelections(
            item.addOnGroupIds,
            item.addOnOptionIdsByGroup,
            addOnGroups,
            validAddOns as AddOnSelection[],
            itemTaxRate(item, selectedStoreTaxRate),
          );
          return {
            addOns: canonical,
            removedCount: savedAddOns.length - validAddOns.length,
            lineValid: true,
          };
        } catch {
          return {
            addOns: [],
            removedCount: savedAddOns.length,
            lineValid: false,
          };
        }
      },
      catalogMarker: (item: CustomerMenuItem, currentAddOns: AddOnSelection[]) =>
        cartLineCatalogMarker(item, currentAddOns, selectedStoreTaxRate),
    };
  }

  /** Applies a restored checkout draft to the live cart. Unchanged behaviour. */
  function applyRestoredDraft(
    draft: CustomerCheckoutDraft,
    restored: { lines: CartLine[]; notices: { code: string; productCode: string }[] },
  ) {
    setCart(restored.lines);
    setPaymentProvider(draft.paymentProvider);
    setOrderType(draft.orderType);
    setCustomerName(draft.customerName);
    setNotes(draft.notes);
    if (draft.orderType !== 'DINE_IN') setTableNumber('');

    const removedItems = restored.notices.filter(notice => notice.code === 'ITEM_REMOVED').length;
    const removedAddOns = restored.notices.filter(notice => notice.code === 'ADD_ON_REMOVED').length;
    const changedPrices = restored.notices.filter(notice => notice.code === 'PRICE_CHANGED').length;
    const messages = [];
    if (restored.lines.length > 0) messages.push('Your basket was restored using current menu prices and availability.');
    if (removedItems > 0) messages.push(`${removedItems} unavailable item${removedItems === 1 ? ' was' : 's were'} removed.`);
    if (removedAddOns > 0) messages.push(`${removedAddOns} unavailable add-on selection${removedAddOns === 1 ? ' was' : 's were'} removed.`);
    if (changedPrices > 0) messages.push(`Current pricing changed for ${changedPrices} saved item${changedPrices === 1 ? '' : 's'}.`);
    setCheckoutDraftNotice(messages.join(' '));

    writeCustomerCheckoutDraft(window.localStorage, {
      selectedStoreId: draft.selectedStoreId,
      paymentProvider: draft.paymentProvider,
      orderType: draft.orderType,
      customerName: draft.customerName,
      notes: draft.notes,
      lines: persistedCheckoutLines(restored.lines, selectedStoreTaxRate),
    });
    pendingCheckoutDraftRef.current = null;
    setCheckoutHydration('RESTORED');
  }

  const categories = useMemo(() => {
    const names = Array.from(new Set(storeItems.map(item => customerMenuCategory(item))));
    return CUSTOMER_CATEGORY_ORDER.filter(name => name === 'ALL' || names.includes(name));
  }, [storeItems]);

  // --- My Usual (profile-synced) ---------------------------------------------
  // The authenticated Coffee Bond profile is the source of truth. Nothing about a
  // usual is persisted on the device, so signing out or switching accounts leaves
  // nothing behind for the next person to see.
  const [myUsual, setMyUsual] = useState<CustomerMyUsual | null>(null);
  const [myUsualLoading, setMyUsualLoading] = useState(false);
  const [myUsualBusy, setMyUsualBusy] = useState(false);
  const [myUsualNotice, setMyUsualNotice] = useState('');
  const [myUsualDialog, setMyUsualDialog] = useState<MyUsualDialog>(null);
  /** Memory only. A save intent must never outlive the tab or reach storage. */
  const pendingMyUsualSaveRef = useRef(false);
  /** The uid whose usual is currently on screen; guards late responses. */
  const myUsualUidRef = useRef('');
  const previousMyUsualUidRef = useRef('');
  const myUsualUid = verifiedCustomer?.customerUid || '';

  useEffect(() => {
    // A pre-release build could have left a device-local usual behind. It is not a
    // source of truth any more and must not be shown to whoever signs in next.
    purgeLegacyDeviceMyUsual(typeof window === 'undefined' ? null : window.localStorage);
  }, []);

  /**
   * Stage 4a: the mobile basket is a modal surface, so the page behind it must not
   * scroll and Escape must close it. Desktop renders the basket inline as an aside,
   * where neither applies — hence the viewport guard.
   */
  useEffect(() => {
    if (!basketOpen || typeof window === 'undefined') return undefined;
    const previousOverflow = document.body.style.overflow;
    const mobile = window.matchMedia('(max-width: 1023px)');
    // Follows the breakpoint: resizing up to the desktop layout, where the basket is
    // an inline aside rather than a modal, must release the lock again.
    const applyLock = () => {
      document.body.style.overflow = mobile.matches ? 'hidden' : previousOverflow;
    };
    applyLock();
    mobile.addEventListener('change', applyLock);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && mobile.matches) setBasketOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      mobile.removeEventListener('change', applyLock);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [basketOpen]);

  useEffect(() => {
    const previousUid = previousMyUsualUidRef.current;
    previousMyUsualUidRef.current = myUsualUid;
    myUsualUidRef.current = myUsualUid;

    // Sign-out and account switching both land here. Clear the previous customer's
    // usual BEFORE the new profile is fetched, so their data is never on screen for
    // even one frame. The server copy is untouched, and the basket is left alone.
    setMyUsual(null);
    if (previousUid && previousUid !== myUsualUid) {
      setMyUsualDialog(null);
      setMyUsualNotice('');
      pendingMyUsualSaveRef.current = false;
    }

    if (!myUsualUid) {
      setMyUsualLoading(false);
      return undefined;
    }

    let active = true;
    setMyUsualLoading(true);
    getCustomerMyUsualRequest()
      .then(response => {
        // A response that arrives after the account changed belongs to nobody here.
        if (!active || myUsualUidRef.current !== myUsualUid) return;
        setMyUsual(response.myUsual);
      })
      .catch((err: unknown) => {
        if (!active || myUsualUidRef.current !== myUsualUid) return;
        setMyUsualNotice(err instanceof Error ? err.message : 'We could not reach your Coffee Bond profile. Please try again.');
      })
      .finally(() => {
        if (active && myUsualUidRef.current === myUsualUid) setMyUsualLoading(false);
      });
    return () => {
      active = false;
    };
  }, [myUsualUid]);

  /** Live product name where this store sells it, otherwise a readable saved code. */
  const productLabel = (productCode: string) => {
    const item = storeItems.find(candidate => candidate.code === productCode);
    if (item) return item.displayName || item.name;
    return productCode.replace(/[_-]+/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  };

  /** Live add-on option name where this store still offers it, otherwise its code. */
  const addOnOptionLabel = (groupId: string, optionId: string) => {
    const option = addOnGroups
      .find(group => (group.id || '') === groupId)?.options
      .find(candidate => candidate.id === optionId);
    return option?.name || optionId.replace(/[_-]+/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  };

  /**
   * Revalidates the saved usual against the CURRENT menu using the same restore engine
   * as checkout-draft hydration. Nothing here mutates the cart — it is a pure preview.
   *
   * Unlike the checkout draft, ITEM_REMOVED / ADD_ON_REMOVED are hard blockers: a usual
   * must never be silently reduced to a partial order.
   */
  const myUsualPreview = useMemo(() => {
    if (!myUsual) return null;
    if (storeItems.length === 0 || loadedMenuStoreId !== selectedStoreId) return { state: 'LOADING' as const };

    const restored = restoreCustomerCheckoutDraft<CustomerMenuItem, AddOnSelection>({
      schemaVersion: 1,
      updatedAt: 0,
      selectedStoreId,
      paymentProvider,
      orderType: myUsual.orderType,
      customerName: '',
      notes: '',
      lines: myUsual.items,
    } as CustomerCheckoutDraft, checkoutRestoreOptions());

    const removedItems = restored.notices.filter(n => n.code === 'ITEM_REMOVED');
    const removedAddOns = restored.notices.filter(n => n.code === 'ADD_ON_REMOVED');
    const priceChanged = restored.notices.some(n => n.code === 'PRICE_CHANGED');
    const blocked = removedItems.length + removedAddOns.length > 0
      || restored.lines.length !== myUsual.items.length;

    const storeName = selectedStore?.name || 'this store';

    // Name the affected products in the CURRENT store's language. A product missing
    // from this store has no live name, so its saved code is humanised rather than
    // shown raw.
    const unavailableItems = [...new Set(removedItems.map(n => productLabel(n.productCode)))];

    /**
     * The shared restore engine reports which product lost an add-on, not which
     * option. Diffing the saved options against the ones this store still offers
     * names the missing add-on without forking that engine.
     */
    const missingAddOnsFor = (productCode: string) => {
      const savedLine = myUsual.items.find(line => line.productCode === productCode);
      const item = storeItems.find(candidate => candidate.code === productCode);
      const activeOptionIds = new Set(
        item
          ? activeAddOnGroupsForProduct(item.addOnGroupIds, item.addOnOptionIdsByGroup, addOnGroups)
            .flatMap(group => group.options.map(option => option.id))
          : [],
      );
      return (savedLine?.addOns || [])
        .filter(addOn => !activeOptionIds.has(addOn.optionId))
        .map(addOn => addOnOptionLabel(addOn.groupId, addOn.optionId));
    };

    const unavailableAddOns = removedAddOns.map(notice => ({
      product: productLabel(notice.productCode),
      addOn: missingAddOnsFor(notice.productCode).join(', ') || 'a saved add-on',
    }));

    const removedItemCodes = new Set(removedItems.map(n => n.productCode));
    const removedAddOnCodes = new Set(removedAddOns.map(n => n.productCode));

    /**
     * EVERY saved line, in saved order — including the ones this store cannot
     * fulfil. A blocked line is labelled, never dropped: hiding it would imply the
     * customer's usual had been silently reduced.
     */
    const displayLines = myUsual.items.map((saved, index) => {
      const item = storeItems.find(candidate => candidate.code === saved.productCode);
      const itemUnavailable = removedItemCodes.has(saved.productCode) || !item;
      const missingAddOns = removedAddOnCodes.has(saved.productCode)
        ? missingAddOnsFor(saved.productCode)
        : [];
      return {
        key: saved.lineId || `${saved.productCode}-${index}`,
        name: productLabel(saved.productCode),
        quantity: saved.quantity,
        addOnSummary: saved.addOns.map(addOn => addOnOptionLabel(addOn.groupId, addOn.optionId)).join(', '),
        imageUrl: item ? getItemImage(item) : null,
        isFood: item ? customerMenuCategory(item) === 'Food' : false,
        unavailableReason: itemUnavailable
          ? `Unavailable at ${storeName}`
          : missingAddOns.length > 0
            ? `${missingAddOns.join(', ')} is unavailable at ${storeName}`
            : undefined,
      };
    });

    return {
      state: 'SAVED' as const,
      lines: restored.lines,
      displayLines,
      // Only meaningful when nothing is blocked: a partial sum must never be shown
      // as the usual's total.
      totals: totalsForLines(restored.lines),
      unavailableItems,
      unavailableAddOns,
      blocked,
      blockerMessage: blocked ? 'Your usual needs a quick update.' : undefined,
      noticeMessage: priceChanged ? 'Price updated since your usual was saved.' : undefined,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myUsual, storeItems, loadedMenuStoreId, selectedStoreId, selectedStore, itemAvailability, addOnGroups, selectedStoreTaxRate, paymentProvider]);

  /**
   * Basket entry point. A signed-out customer is sent through the EXISTING customer
   * OTP flow with the basket left exactly as it is; the save intent is held in memory
   * and still requires an explicit confirmation afterwards. No order, payment or
   * checkout session is created on this path.
   */
  const requestSaveMyUsual = () => {
    if (cart.length === 0 || !selectedStoreId) return;
    if (isOffline) {
      setMyUsualNotice('Reconnect to check current prices and availability.');
      return;
    }
    if (!verifiedCustomer) {
      pendingMyUsualSaveRef.current = true;
      setMyUsualDialog({ type: 'SIGN_IN' });
      return;
    }
    setMyUsualDialog(myUsual ? { type: 'REPLACE_USUAL' } : { type: 'SAVE_NEW' });
  };

  /** Verification completed inside the My Usual sheet — never a checkout submission. */
  const handleMyUsualVerified = (profile: CustomerProfile) => {
    const wantsSave = pendingMyUsualSaveRef.current;
    pendingMyUsualSaveRef.current = false;
    setVerifiedCustomer(profile);
    setCustomerPhone(profile.normalisedPhone.replace('+91', ''));
    if (!customerName.trim() && profile.displayName) setCustomerName(profile.displayName);
    // The basket survived verification untouched; saving it still needs a yes.
    setMyUsualDialog(wantsSave && cart.length > 0 && selectedStoreId ? { type: 'CONFIRM_PENDING_SAVE' } : null);
  };

  /**
   * The only permanent save. It writes through the secured profile callable and the UI
   * is updated from the SERVER response, never from the local basket — so a failed
   * request can never look like a success. The basket itself is never modified.
   */
  const confirmSaveMyUsual = async () => {
    if (cart.length === 0 || !selectedStoreId || myUsualBusy) return;
    if (!verifiedCustomer) {
      pendingMyUsualSaveRef.current = true;
      setMyUsualDialog({ type: 'SIGN_IN' });
      return;
    }
    if (isOffline) {
      setMyUsualNotice('Reconnect to check current prices and availability.');
      return;
    }
    const uid = verifiedCustomer.customerUid;
    setMyUsualBusy(true);
    setMyUsualNotice('');
    try {
      const response = await saveCustomerMyUsualRequest(buildMyUsualPayload({
        preferredStoreId: selectedStoreId,
        orderType,
        items: persistedCheckoutLines(cart, selectedStoreTaxRate),
      }));
      if (myUsualUidRef.current !== uid) return;
      setMyUsual(response.myUsual);
      setMyUsualNotice('Saved to your Coffee Bond profile');
      setMyUsualDialog(null);
    } catch (err: unknown) {
      // Previous state is retained and the dialog stays open for a retry.
      if (myUsualUidRef.current !== uid) return;
      setMyUsualNotice(err instanceof Error ? err.message : 'We could not save My Usual. Please try again.');
    } finally {
      if (myUsualUidRef.current === uid) setMyUsualBusy(false);
    }
  };

  /** Loads validated lines into the EXISTING cart and opens the EXISTING basket. */
  const applyMyUsualToBasket = (lines: CartLine[]) => {
    setCart(lines);
    if (myUsual) setOrderType(myUsual.orderType);
    setMyUsualDialog(null);
    setBasketOpen(true);
  };

  const startMyUsualOrder = (intent: 'ORDER' | 'EDIT') => {
    if (!myUsual || myUsualBusy) return;
    if (isOffline) {
      setMyUsualNotice('Reconnect to check current prices and availability.');
      return;
    }
    setMyUsualBusy(true);
    try {
      // The usual belongs to the customer. The store selected RIGHT NOW is
      // authoritative; where it happened to be saved is not consulted at all.
      if (!customerOrderingState.canAcceptOrders) {
        setMyUsualDialog({ type: 'STORE_CLOSED', message: customerOrderingState.message });
        return;
      }
      const preview = myUsualPreview;
      if (!preview || preview.state !== 'SAVED') return;
      if (preview.blockerMessage) {
        setMyUsualDialog({
          type: 'UNAVAILABLE',
          items: preview.unavailableItems,
          addOns: preview.unavailableAddOns,
        });
        return;
      }
      if (cart.length > 0) {
        setMyUsualDialog({ type: 'REPLACE_BASKET', lines: preview.lines, intent });
        return;
      }
      applyMyUsualToBasket(preview.lines);
    } finally {
      setMyUsualBusy(false);
    }
  };

  /**
   * Removes the usual from the profile through the secured callable. The current
   * basket is deliberately untouched, and the card only clears once the server has
   * confirmed the delete.
   */
  const deleteMyUsual = async () => {
    if (!verifiedCustomer || myUsualBusy) return;
    if (isOffline) {
      setMyUsualNotice('Reconnect to check current prices and availability.');
      return;
    }
    const uid = verifiedCustomer.customerUid;
    setMyUsualBusy(true);
    setMyUsualNotice('');
    try {
      await deleteCustomerMyUsualRequest();
      if (myUsualUidRef.current !== uid) return;
      setMyUsual(null);
      setMyUsualDialog(null);
      setMyUsualNotice('My Usual deleted from your Coffee Bond profile.');
    } catch (err: unknown) {
      if (myUsualUidRef.current !== uid) return;
      setMyUsualNotice(err instanceof Error ? err.message : 'We could not delete My Usual. Please try again.');
    } finally {
      if (myUsualUidRef.current === uid) setMyUsualBusy(false);
    }
  };

  /**
   * The menu is one continuous vertical flow grouped by category. Search collapses it
   * to a single flat result list so results stay in the same vertical direction.
   * Grouping reuses the same authoritative category derivation as the rail.
   */
  const isSearching = search.trim().length > 0;
  const menuSections = useMemo(() => {
    if (isSearching) return [];
    return categories
      .filter(name => name !== 'ALL')
      .map(name => ({
        // The category name is already the canonical identifier used by the rail,
        // the section attribute and the spy — one source of truth, no mapping table.
        id: name,
        category: name,
        items: storeItems.filter(item => customerMenuCategory(item) === name),
      }))
      .filter(section => section.items.length > 0);
  }, [categories, storeItems, isSearching]);

  const visibleItems = useMemo(() => {
    const searchText = search.trim().toLowerCase();
    return storeItems.filter(item => {
      const matchesCategory = category === 'ALL' || customerMenuCategory(item) === category;
      const name = `${item.displayName || item.name} ${item.code} ${item.description || ''}`.toLowerCase();
      return matchesCategory && (!searchText || name.includes(searchText));
    });
  }, [storeItems, category, search]);

  const orderableItems = useMemo(() => {
    return storeItems.filter(item => (itemAvailability[item.code] || getItemAvailability(item, selectedStoreId)).available);
  }, [storeItems, itemAvailability, selectedStoreId]);

  /**
   * The vertical rail is a FILTER, not an in-page navigator. Selecting a category only
   * updates `category`, which the existing `visibleItems` memo already filters on — so
   * there is no scroll-spy, no IntersectionObserver, no scroll calculation and no
   * second scroll container. Active state is pure React state.
   */
  const popularItems = useMemo(() => {
    return [...orderableItems]
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.displayName || a.name).localeCompare(b.displayName || b.name))
      .slice(0, 6);
  }, [orderableItems]);

  const customerOrderingState = useMemo(() => deriveCustomerOrderingState({
    store: selectedStore,
    availabilitySnapshot: publicAvailability,
    availabilityLoading,
    orderableItemCount: orderableItems.length,
  }), [selectedStore, publicAvailability, availabilityLoading, orderableItems.length]);
  const selectedStoreOnline = customerOrderingState.canAcceptOrders;
  const storesMissingCoordinates = useMemo(() => stores.filter(store => !storeCoordinate(store)), [stores]);
  const selectedStoreHasCoordinates = selectedStore ? !!storeCoordinate(selectedStore) : false;

  /**
   * Single money calculation, used by the live basket and by My Usual previews.
   * Declared as a function so it is hoisted: the My Usual preview memo runs earlier in
   * the render and would hit the temporal dead zone with a const arrow.
   */
  function totalsForLines(lines: CartLine[]) {
    const subtotal = lines.reduce((sum, line) => (
      sum + unitPriceWithAddOns(toNumber(line.item.salePrice), line.addOns) * line.quantity
    ), 0);
    const gstTotal = lines.reduce((sum, line) => {
      const rate = itemTaxRate(line.item, selectedStoreTaxRate);
      const baseTax = toNumber(line.item.salePrice) * line.quantity * rate / 100;
      return sum + baseTax + addOnTaxForLine(line.addOns, line.quantity, 0);
    }, 0);
    return {
      subtotal,
      taxableAmount: subtotal,
      gstTotal,
      grandTotal: subtotal + gstTotal,
    };
  }

  const totals = useMemo(
    () => totalsForLines(cart),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cart, selectedStoreTaxRate],
  );

  const checkoutDraftInput = useMemo<CustomerCheckoutDraftInput>(() => ({
    selectedStoreId,
    paymentProvider,
    orderType,
    customerName,
    notes,
    lines: persistedCheckoutLines(cart, selectedStoreTaxRate),
  }), [
    cart,
    customerName,
    notes,
    orderType,
    paymentProvider,
    selectedStoreId,
    selectedStoreTaxRate,
  ]);

  useEffect(() => {
    if (
      checkoutHydration !== 'RESTORED'
      || !selectedStoreId
      || cart.length === 0
      || confirmation
    ) {
      return undefined;
    }
    const timeout = window.setTimeout(() => {
      writeCustomerCheckoutDraft(window.localStorage, checkoutDraftInput);
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [cart.length, checkoutDraftInput, checkoutHydration, confirmation, selectedStoreId]);

  const itemCount = cart.reduce((sum, line) => sum + line.quantity, 0);

  const handleStoreChange = (nextStoreId: string) => {
    if (nextStoreId === selectedStoreId) return;
    if (cart.length > 0) {
      const shouldSwitch = window.confirm('Changing store will clear your current basket so prices and availability stay correct. Continue?');
      if (!shouldSwitch) return;
    }
    userStoreChoiceRef.current = true;
    clearCustomerCheckoutDraft(window.localStorage);
    setCheckoutDraftNotice('');
    setSelectedStoreId(nextStoreId);
    setCart([]);
    setPendingAddOnItem(null);
    setEditingAddOnLine(null);
    setCategory('ALL');
    setSearch('');
    setBasketOpen(false);
    setError(null);
    setStoreSelectorOpen(false);
    const store = stores.find(item => item.id === nextStoreId);
    setStorePreferenceMessage(store ? `Selected ${store.name}.` : '');
  };

  const saveSelectedStoreAsDefault = () => {
    if (!selectedStore) return;
    try {
      window.localStorage.setItem(DEFAULT_STORE_KEY, selectedStore.id);
      setStorePreferenceMessage(`${selectedStore.name} saved as your default store.`);
    } catch {
      setStorePreferenceMessage('Could not save the default store on this device.');
    }
  };

  const handleOrderTypeChange = (nextType: OnlineOrderType) => {
    setOrderType(nextType);
    if (nextType !== 'DINE_IN') setTableNumber('');
  };

  const setLineQuantity = (lineId: string, quantity: number) => {
    setCart(current => {
      const next = quantity <= 0
        ? current.filter(line => line.id !== lineId)
        : current.map(line => line.id === lineId ? { ...line, quantity } : line);
      if (current.length > 0 && next.length === 0) {
        clearCustomerCheckoutDraft(window.localStorage);
        setCheckoutDraftNotice('');
      }
      return next;
    });
  };

  const commitCartItem = (
    item: CustomerMenuItem,
    requestedAddOns: AddOnSelection[],
    editingLineId?: string,
    // Stage 3 added a quantity control to the customization sheet. Defaults to 1 so
    // every pre-existing caller — including the direct-add path — is unchanged.
    requestedQuantity = 1,
  ) => {
    const addQuantity = Math.min(
      CUSTOMER_MAX_LINE_QUANTITY,
      Math.max(1, Math.floor(toNumber(requestedQuantity)) || 1),
    );
    const availability = itemAvailability[item.code] || getItemAvailability(item, selectedStoreId);
    if (!availability.available) {
      setError(`${item.displayName || item.name} is currently unavailable: ${availability.reason}.`);
      return;
    }

    let canonicalAddOns: AddOnSelection[];
    try {
      canonicalAddOns = canonicalAddOnSelections(
        item.addOnGroupIds,
        item.addOnOptionIdsByGroup,
        addOnGroups,
        requestedAddOns,
        itemTaxRate(item, selectedStoreTaxRate),
      );
    } catch (selectionError) {
      setError(selectionError instanceof Error ? selectionError.message : 'Selected add-ons are unavailable.');
      return;
    }

    setCart(prev => {
      // Editing updates the SAME logical line in place — never a second line.
      if (editingLineId) {
        return prev.map(line => line.id === editingLineId
          ? { ...line, addOns: canonicalAddOns, quantity: addQuantity }
          : line);
      }
      const selectionKey = addOnSelectionKey(canonicalAddOns);
      const existing = prev.find(line => (
        line.item.code === item.code && addOnSelectionKey(line.addOns) === selectionKey
      ));
      if (existing) {
        return prev.map(line => line.id === existing.id
          ? { ...line, quantity: Math.min(CUSTOMER_MAX_LINE_QUANTITY, line.quantity + addQuantity) }
          : line);
      }
      return [...prev, {
        id: createClientIdempotencyKey(),
        item,
        quantity: addQuantity,
        addOns: canonicalAddOns,
      }];
    });
    setBasketAnnouncement(editingLineId
      ? `${item.displayName || item.name} customizations updated.`
      : `${item.displayName || item.name} added to basket.`);
    setBasketBumpKey(current => current + 1);
  };

  const addItem = (item: CustomerMenuItem) => {
    const groups = activeAddOnGroupsForProduct(
      item.addOnGroupIds,
      item.addOnOptionIdsByGroup,
      addOnGroups,
    );
    if (groups.length > 0) {
      setEditingAddOnLine(null);
      setPendingAddOnItem(item);
      return;
    }
    commitCartItem(item, []);
  };

  const editLineAddOns = (line: CartLine) => {
    const groups = activeAddOnGroupsForProduct(
      line.item.addOnGroupIds,
      line.item.addOnOptionIdsByGroup,
      addOnGroups,
    );
    if (groups.length === 0) return;
    setEditingAddOnLine(line);
    setPendingAddOnItem(line.item);
  };

  const submitOrder = async () => {
    if (saving || submittingRef.current) return;
    if (!selectedStore) return setError('Please select a store.');
    if (!customerOrderingState.canAcceptOrders) return setError(customerOrderingState.message);
    if (cart.length === 0) return setError('Please add at least one item.');
    const cleanCustomerName = customerName.trim().replace(/\s+/g, ' ');
    const cleanPhone = normalizeIndianPhone(customerPhone);
    const cleanTableNumber = tableNumber.trim().replace(/\s+/g, ' ');
    const cleanNotes = notes.trim().slice(0, MAX_NOTE_LENGTH);
    if (paymentProvider === 'RAZORPAY' && !verifiedCustomer) {
      return setError('Verify your mobile number before paying online.');
    }
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

    if (!requireOnline()) {
      setError(OFFLINE_ACTION_MESSAGE);
      return;
    }

    const signature = cartSignature(selectedStore.id, cleanPhone, orderType, cleanTableNumber, paymentProvider, cart);
    const lockKey = submissionLockKey(signature);
    let clientIdempotencyKey = createClientIdempotencyKey();
    try {
      const rawLock = window.localStorage.getItem(lockKey);
      if (rawLock) {
        const lock = JSON.parse(rawLock) as SubmissionLock;
        if (lock.createdAt && Date.now() - lock.createdAt < SUBMISSION_LOCK_TTL_MS) {
          if (lock.trackingToken) {
            setError('This order was just submitted. Please use the tracking link instead of sending it again.');
            return;
          }
          if (lock.clientIdempotencyKey) {
            clientIdempotencyKey = lock.clientIdempotencyKey;
          }
        }
      }
      window.localStorage.setItem(lockKey, JSON.stringify({ createdAt: Date.now(), status: 'SENDING', clientIdempotencyKey }));
    } catch {
      // localStorage can be unavailable in private modes; the in-memory guard still prevents double taps.
    }

    submittingRef.current = true;
    const endCriticalOperation = beginCriticalOperation();
    setSaving(true);
    setError(null);
    setPaymentNotice('');
    try {
      if (paymentProvider === 'RAZORPAY') {
        const checkoutResult = (await createCustomerCheckoutSession({
          storeId: selectedStore.id,
          storeCode: selectedStore.code,
          customerName: cleanCustomerName,
          orderType,
          ...(orderType === 'DINE_IN' ? { tableNumber: cleanTableNumber } : { tableNumber: null }),
          notes: cleanNotes,
          items: cart.map(line => ({
            itemCode: line.item.code,
            parentProductId: line.item.id,
            quantity: line.quantity,
            addOns: line.addOns.map(addOn => ({
              groupId: addOn.groupId,
              optionId: addOn.optionId,
              quantity: addOn.quantity,
            })),
          })),
          clientIdempotencyKey,
        })).data;
        if (checkoutResult.alreadyPaid && checkoutResult.trackingToken) {
          const trackingPath = normalizeTrackingPath(checkoutResult.trackingPath, checkoutResult.trackingToken);
          rememberCustomerOrder(checkoutResult.trackingToken);
          clearCustomerCheckoutDraft(window.localStorage);
          setCart([]);
          navigate(trackingPath);
          return;
        }
        validateRazorpayOrderResponse(checkoutResult);
        if (!checkoutResult.sessionId) throw new Error('Secure checkout session was not returned.');
        await loadRazorpayCheckout();
        const RazorpayCheckout = window.Razorpay;
        if (!RazorpayCheckout) throw new Error('Online payment could not load. Please retry.');
        const verifiedOrder = await new Promise<Awaited<ReturnType<typeof verifyCustomerRazorpayPayment>>['data']>((resolve, reject) => {
          let settled = false;
          const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            callback();
          };
          const checkout = new RazorpayCheckout({
            key: checkoutResult.keyId,
            order_id: checkoutResult.razorpayOrderId,
            amount: checkoutResult.amount,
            currency: checkoutResult.currency,
            name: 'Coffee Bond',
            description: `Coffee Bond · ${selectedStore.name}`,
            customer_id: checkoutResult.customerId,
            remember_customer: checkoutResult.rememberCustomer,
            prefill: checkoutResult.prefill,
            readonly: checkoutResult.readonly,
            ...(checkoutResult.magicCheckoutEnabled ? {
              one_click_checkout: checkoutResult.oneClickCheckout,
              line_items: checkoutResult.lineItems,
            } : {}),
            config: {
              display: {
                blocks: {
                  preferred: {
                    name: 'Pay securely',
                    instruments: [
                      { method: 'upi' },
                      { method: 'card' },
                      { method: 'netbanking' },
                    ],
                  },
                },
                sequence: ['block.preferred'],
                preferences: { show_default_blocks: true },
              },
            },
            theme: { color: '#3b261d' },
            handler: (providerResult) => {
              verifyCustomerRazorpayPayment({
                sessionId: checkoutResult.sessionId!,
                ...providerResult,
              }).then(result => finish(() => resolve(result.data)))
                .catch(() => finish(() => reject(new Error(
                  'Payment confirmation is delayed. Your paid order will be recovered automatically.',
                ))));
            },
            modal: {
              ondismiss: () => finish(() => reject(new Error(
                'Payment cancelled. No order was placed. Your cart has been saved.',
              ))),
            },
          });
          checkout.on('payment.failed', () => finish(() => reject(new Error(
            'Payment was not completed. No order was placed. You can try again.',
          ))));
          checkout.open();
        });
        const trackingPath = normalizeTrackingPath(verifiedOrder.trackingPath, verifiedOrder.trackingToken);
        rememberCustomerOrder(verifiedOrder.trackingToken);
        clearCustomerCheckoutDraft(window.localStorage);
        setCart([]);
        setNotes('');
        setTableNumber('');
        setBasketOpen(false);
        navigate(trackingPath);
        return;
      }

      const result = await submitCustomerOrderCallable({
        storeCode: selectedStore.code,
        customerName: cleanCustomerName,
        customerPhone: cleanPhone,
        orderType,
        ...(orderType === 'DINE_IN' ? { tableNumber: cleanTableNumber } : { tableNumber: null }),
        notes: cleanNotes,
        items: cart.map(line => ({
          itemCode: line.item.code,
          quantity: line.quantity,
          addOns: line.addOns.map(addOn => ({
            groupId: addOn.groupId,
            optionId: addOn.optionId,
            quantity: addOn.quantity,
          })),
        })),
        clientIdempotencyKey,
        paymentProvider,
      });
      const submittedOrder = result.data;

      setConfirmation({
        id: submittedOrder.trackingToken,
        publicOrderReference: submittedOrder.publicOrderReference,
        storeName: submittedOrder.storeName,
        estimatedPrepMinutes: submittedOrder.estimatedPrepMinutes || selectedStore.estimatedPrepMinutes || 20,
        storeMessage: submittedOrder.storeMessage || selectedStoreMessage,
        customerName: cleanCustomerName,
        orderType: submittedOrder.orderType,
        tableNumber: submittedOrder.tableNumber,
        items: submittedOrder.items,
        subtotal: submittedOrder.subtotal,
        gstTotal: submittedOrder.gstTotal,
        total: submittedOrder.total,
        status: submittedOrder.status,
        paymentProvider: submittedOrder.paymentProvider,
        paymentStatus: submittedOrder.paymentStatus,
      });
      try {
        window.localStorage.setItem(lockKey, JSON.stringify({
          createdAt: Date.now(),
          status: 'SUBMITTED',
          trackingToken: submittedOrder.trackingToken,
          clientIdempotencyKey,
        }));
      } catch {
        // Ignore lock persistence failures after a successful server submission.
      }
      rememberCustomerOrder(submittedOrder.trackingToken);
      clearCustomerCheckoutDraft(window.localStorage);
      setCart([]);
      setNotes('');
      setTableNumber('');
      setBasketOpen(false);
    } catch (err) {
      if (import.meta.env.DEV) console.error('Failed to submit online order', err);
      const message = err instanceof Error ? err.message : '';
      if (
        message === 'Payment cancelled. No order was placed. Your cart has been saved.'
        || message === 'Payment was not completed. No order was placed. You can try again.'
      ) {
        setPaymentNotice(message);
        setError(null);
      } else {
        setError(customerSubmitErrorMessage(err));
      }
    } finally {
      submittingRef.current = false;
      setSaving(false);
      endCriticalOperation();
    }
  };

  const copyTrackingLink = async (trackingToken: string) => {
    const trackingUrl = customerTrackingUrl(trackingToken);
    try {
      await navigator.clipboard.writeText(trackingUrl);
      setCopyMessage('Tracking link copied.');
    } catch {
      setCopyMessage(trackingUrl);
    }
  };

  const renderItemThumb = (item: CustomerMenuItem, sizeClass = 'h-20 w-20', priority = false) => {
    const meta = visualMeta(item);
    const Icon = meta.icon;
    const imageUrl = getItemImage(item);

    return <CustomerProductImage
      src={imageUrl}
      alt={item.displayName || item.name}
      icon={Icon}
      iconClassName={meta.iconColor}
      className={`${sizeClass} ${meta.gradient}`}
      priority={priority}
    />;
  };

  const renderPopularCard = (item: CustomerMenuItem, index: number) => {
    const availability = itemAvailability[item.code] || getItemAvailability(item, selectedStoreId);
    const canOrder = customerOrderingState.canAcceptOrders && availability.available;

    return (
      <article key={`popular-${item.code}`} className="min-w-[158px] max-w-[158px] rounded-[20px] bg-white p-2.5 shadow-sm ring-1 ring-[#e7ddd3]">
        {renderItemThumb(item, 'aspect-[4/3] w-full', index < 3)}
        <div className="mt-2 min-h-[76px]">
          <div className="mb-1 inline-flex rounded-full bg-[#ecf8ef] px-2 py-0.5 text-[10px] font-bold text-emerald-700">Popular</div>
          <h3 className="line-clamp-2 text-sm font-black leading-tight text-[#271a16]">{item.displayName || item.name}</h3>
          {trustedDietaryClassification(item as unknown as Record<string, unknown>) && (
            <div className="mt-1">
              <DietaryMarker value={trustedDietaryClassification(item as unknown as Record<string, unknown>)!} compact />
            </div>
          )}
          <p className="mt-1 text-xs font-bold text-[#8b5e42]">{formatMoney(toNumber(item.salePrice))}</p>
        </div>
        <button
          onClick={() => addItem(item)}
          disabled={!canOrder}
          className="mt-2 flex h-11 w-full items-center justify-center gap-1 rounded-2xl bg-[#3b241c] text-xs font-black text-white disabled:bg-neutral-300"
        >
          <Plus size={14} />
          Add
        </button>
      </article>
    );
  };

  const renderMenuCard = (item: CustomerMenuItem, index = 0) => {
    // Every value below comes from the existing helpers. The card is presentation
    // only: no pricing, availability, add-on or cart logic moved into it.
    const itemLines = cart.filter(line => line.item.code === item.code);
    const qty = itemLines.reduce((sum, line) => sum + line.quantity, 0);
    const firstLine = itemLines[0];
    const availability = itemAvailability[item.code] || getItemAvailability(item, selectedStoreId);
    const canOrder = customerOrderingState.canAcceptOrders && availability.available;
    const meta = visualMeta(item);
    const opensCustomization = activeAddOnGroupsForProduct(
      item.addOnGroupIds,
      item.addOnOptionIdsByGroup,
      addOnGroups,
    ).length > 0;

    return (
      <CustomerProductCard
        key={`menu-${item.code}`}
        name={item.displayName || item.name}
        priceLabel={formatMoney(toNumber(item.salePrice))}
        imageUrl={getItemImage(item)}
        fallbackIcon={meta.icon}
        metaLabel={meta.label}
        dietary={trustedDietaryClassification(item as unknown as Record<string, unknown>)}
        quantity={qty}
        canOrder={canOrder}
        unavailableReason={availability.reason}
        priority={index < 2}
        opensCustomization={opensCustomization}
        onAdd={() => addItem(item)}
        onIncrement={() => addItem(item)}
        onDecrement={() => firstLine && setLineQuantity(firstLine.id, firstLine.quantity - 1)}
      />
    );
  };

  const basketPanel = (
    <div className="flex h-full min-h-0 flex-col">
      {/* Stage 4a header: title, count and one close action. */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id="cb-basket-heading" className="cb-customer-title text-xl font-black">Your basket</h2>
          <p className="cb-customer-muted text-sm font-bold">
            {itemCount} item{itemCount === 1 ? '' : 's'} for {orderType === 'DINE_IN' ? 'dine in' : 'pickup'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setBasketOpen(false)}
          className="cb-customer-icon-button flex h-11 w-11 items-center justify-center rounded-full lg:hidden"
          aria-label="Close basket"
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      {cart.length === 0 ? (
        <CustomerBasketEmptyState
          onBrowseMenu={() => {
            setBasketOpen(false);
            searchInputRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }}
        />
      ) : (
        <>
          {/* Pickup context, from the parent's existing store state. */}
          <CustomerPickupSummary
            contextLabel={orderType === 'DINE_IN' ? 'Dining at' : 'Pickup from'}
            storeName={selectedStore?.name || 'Choose store'}
            statusLabel={customerOrderingState.statusLabel}
            tone={customerOrderingState.tone}
            prepLabel={prepWindowLabel(selectedStore?.estimatedPrepMinutes)}
            onChangeStore={() => setStoreSelectorOpen(true)}
          />

          <ul className="mt-3 space-y-3">
            {cart.map(line => {
              const unitPrice = unitPriceWithAddOns(toNumber(line.item.salePrice), line.addOns);
              return (
                <CustomerBasketItemCard
                  key={line.id}
                  productName={line.item.displayName || line.item.name}
                  unitPriceLabel={formatMoney(unitPrice)}
                  lineTotalLabel={formatMoney(unitPrice * line.quantity)}
                  quantity={line.quantity}
                  maxQuantity={CUSTOMER_MAX_LINE_QUANTITY}
                  imageUrl={getItemImage(line.item)}
                  fallbackIcon={visualMeta(line.item).icon}
                  dietaryClassification={trustedDietaryClassification(line.item as unknown as Record<string, unknown>)}
                  addOns={line.addOns.map(addOn => ({
                    key: `${addOn.groupId}-${addOn.optionId}`,
                    name: addOn.optionName,
                    quantity: addOn.quantity,
                    priceLabel: formatMoney(addOn.totalPrice),
                  }))}
                  canEdit={activeAddOnGroupsForProduct(
                    line.item.addOnGroupIds,
                    line.item.addOnOptionIdsByGroup,
                    addOnGroups,
                  ).length > 0}
                  onQuantityChange={next => setLineQuantity(line.id, next)}
                  onEdit={() => editLineAddOns(line)}
                  onRemove={() => setLineQuantity(line.id, 0)}
                />
              );
            })}
          </ul>

          <div className="mt-4 rounded-2xl bg-[#fbf5ee] p-4 text-sm">
            <div className="flex justify-between"><span>Subtotal</span><span className="font-black">{formatMoney(totals.subtotal)}</span></div>
            <div className="mt-2 flex justify-between"><span>GST</span><span className="font-black">{formatMoney(totals.gstTotal)}</span></div>
            <div className="mt-3 border-t border-[#ead8c7] pt-3 text-lg font-black text-[#2d2019]">
              <div className="flex justify-between"><span>Total</span><span>{formatMoney(totals.grandTotal)}</span></div>
            </div>
          </div>

          {/* Save as My Usual — one small action, no basket redesign. Hidden while a
              submission or payment is in flight so it can never race checkout. */}
          {cart.length > 0 && selectedStoreId && !saving && !submittingRef.current && (
            <button
              type="button"
              onClick={requestSaveMyUsual}
              data-requires-online="true"
              disabled={myUsualBusy || isOffline}
              className="mt-3 min-h-11 w-full rounded-2xl bg-[#f5ede5] text-sm font-black text-[#3b241c] disabled:text-neutral-400"
            >
              Save as My Usual
            </button>
          )}

          <div className="mt-4 space-y-3">
            <fieldset className="rounded-2xl border border-[#e4d7c8] bg-white p-3">
              <legend className="px-1 text-xs font-black uppercase tracking-wider text-neutral-500">Payment</legend>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setPaymentProvider('PAY_AT_COUNTER');
                  }}
                  className={`min-h-12 rounded-xl px-3 py-2 text-sm font-black ${
                    paymentProvider === 'PAY_AT_COUNTER'
                      ? 'bg-[#3b261d] text-white'
                      : 'bg-[#fbf5ee] text-[#5c4033]'
                  }`}
                >
                  Pay at counter
                </button>
                <button
                  type="button"
                  onClick={() => setPaymentProvider('RAZORPAY')}
                  className={`min-h-12 rounded-xl px-3 py-2 text-sm font-black ${
                    paymentProvider === 'RAZORPAY'
                      ? 'bg-[#3b261d] text-white'
                      : 'bg-[#fbf5ee] text-[#5c4033]'
                  }`}
                >
                  Pay online
                </button>
              </div>
              <p className="mt-2 text-xs font-medium text-neutral-500">
                {paymentProvider === 'RAZORPAY'
                  ? 'Verify your mobile, then pay securely. The paid order goes straight to the store for confirmation.'
                  : 'Payment is collected at the store after acceptance.'}
              </p>
            </fieldset>
            {paymentProvider === 'RAZORPAY' && !customerAuthRestored ? (
              <div className="rounded-2xl border border-[#e4d7c8] bg-white px-4 py-3 text-sm font-bold text-neutral-500">
                Restoring your verified mobile session...
              </div>
            ) : paymentProvider === 'RAZORPAY' ? (
              <CustomerOtpPanel
                mobile={customerPhone}
                verifiedPhone={verifiedCustomer?.normalisedPhone || null}
                onMobileChange={(mobile) => {
                  setCustomerPhone(mobile);
                  setVerifiedCustomer(null);
                }}
                onVerified={(profile) => {
                  setVerifiedCustomer(profile);
                  setCustomerPhone(profile.normalisedPhone.replace('+91', ''));
                  if (!customerName.trim() && profile.displayName) setCustomerName(profile.displayName);
                  if (profile.defaultOrderType) handleOrderTypeChange(profile.defaultOrderType);
                  setError(null);
                }}
              />
            ) : (
              <input
                value={customerPhone}
                onChange={(event) => setCustomerPhone(event.target.value.replace(/\D/g, '').slice(0, 10))}
                placeholder="10-digit mobile number"
                inputMode="numeric"
                autoComplete="tel"
                className="w-full rounded-2xl border border-[#e4d7c8] bg-white px-4 py-3 text-sm outline-none focus:border-[#5c4033]"
              />
            )}
            {(paymentProvider === 'PAY_AT_COUNTER' || verifiedCustomer) && (
              <>
                <input value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="Your name" className="w-full rounded-2xl border border-[#e4d7c8] bg-white px-4 py-3 text-sm outline-none focus:border-[#5c4033]" />
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
                  placeholder={orderType === 'DINE_IN' ? 'Add a note for the store' : 'Pickup note for the store'}
                  rows={3}
                  maxLength={MAX_NOTE_LENGTH}
                  className="w-full rounded-2xl border border-[#e4d7c8] bg-white px-4 py-3 text-sm outline-none focus:border-[#5c4033]"
                />
                <p className="text-right text-[11px] font-bold text-neutral-400">{notes.length}/{MAX_NOTE_LENGTH}</p>
              </>
            )}
          </div>

          {paymentNotice && (
            <p role="status" className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold leading-relaxed text-amber-900">
              {paymentNotice}
            </p>
          )}

          <button
            onClick={submitOrder}
            data-requires-online="true"
            disabled={
              saving
              || isOffline
              || loading
              || cart.length === 0
              || !selectedStoreOnline
              || (paymentProvider === 'RAZORPAY' && !verifiedCustomer)
            }
            className="mt-4 w-full rounded-2xl bg-[#3b261d] px-4 py-4 text-sm font-black text-white shadow-sm disabled:cursor-not-allowed disabled:bg-neutral-300"
          >
            {saving
              ? paymentProvider === 'RAZORPAY' ? 'Opening secure payment...' : 'Sending request...'
              : paymentProvider === 'RAZORPAY'
                ? `Pay ${formatMoney(totals.grandTotal)} Online`
                : 'Send order request'}
          </button>
          <p className="mt-3 text-center text-xs font-medium text-neutral-500">
            {paymentProvider === 'RAZORPAY'
              ? 'Your cart clears only after payment is verified and the order is created.'
              : 'The store will confirm your order shortly.'}
          </p>
        </>
      )}
    </div>
  );

  if (confirmation) {
    return (
      <div className="min-h-[100dvh] bg-[#f8efe6] px-4 py-5 font-sans text-neutral-900">
        <div className="mx-auto max-w-md">
          <div className="-mx-4 -mt-5 mb-4">
            <CustomerHeader
              title="Order ahead"
              profile={verifiedCustomer}
              authRestored={customerAuthRestored}
              onProfileUpdated={(profile) => {
                setVerifiedCustomer(profile);
                setCustomerName(profile.displayName);
                handleOrderTypeChange(profile.defaultOrderType);
              }}
              onSignedOut={() => {
                setVerifiedCustomer(null);
                setCustomerPhone('');
              }}
            />
          </div>

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
                  {confirmation.items.map((item, index) => (
                    <div key={`${confirmation.id}-${index}-${item.itemName}`} className="flex justify-between gap-3 text-sm">
                      <div>
                        <span className="font-bold text-neutral-700">{item.quantity} x {item.itemName}</span>
                        {(item.addOns || []).map(addOn => (
                          <p key={`${addOn.groupName}-${addOn.optionName}`} className="pl-2 text-xs font-semibold text-neutral-500">
                            + {addOn.optionName}{addOn.quantity > 1 ? ` × ${addOn.quantity}` : ''}
                          </p>
                        ))}
                      </div>
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
                {confirmation.paymentProvider === 'RAZORPAY'
                  ? 'Payment: The store will review your order first. Pay Online appears on tracking after acceptance.'
                  : 'Payment: Pay at counter after the store accepts your request.'}
              </div>
            </div>

            <div className="mt-5 grid gap-3">
              <Link to={customerStatusPath(confirmation.id)} className="rounded-2xl bg-[#3b261d] px-4 py-4 text-sm font-black text-white">
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
    <div className="cb-app cb-customer-page-bottom min-h-[100dvh] min-w-0 overflow-x-hidden bg-[#fbf7f1] font-sans text-[#271a16]">
      <CustomerHeader
        sticky
        title="Order ahead"
        profile={verifiedCustomer}
        authRestored={customerAuthRestored}
        onProfileUpdated={(profile) => {
          setVerifiedCustomer(profile);
          setCustomerName(profile.displayName);
          handleOrderTypeChange(profile.defaultOrderType);
        }}
        onSignedOut={() => {
          setVerifiedCustomer(null);
          setCustomerPhone('');
        }}
        onSignedOutAccountPress={() => setBasketOpen(true)}
        rightSlot={(
          /* Desktop-only basket entry. Below lg the raised basket in the bottom
             navigation is the single basket control, so the two never coexist. */
          <button
            onClick={() => setBasketOpen(true)}
            className="relative hidden h-11 min-w-11 items-center justify-center rounded-2xl bg-[#3b241c] px-3 text-xs font-black text-white shadow-sm focus:outline-none focus:ring-2 focus:ring-[#8b5e42]/40 lg:inline-flex"
            aria-label={`Open basket with ${itemCount} item${itemCount === 1 ? '' : 's'}`}
          >
            <ShoppingBag size={15} />
            {itemCount > 0 && (
              <span key={basketBumpKey} className="absolute -right-1 -top-1 flex h-5 min-w-5 animate-[basket-bump_180ms_ease-out] items-center justify-center rounded-full bg-[#07855b] px-1 text-[10px] text-white motion-reduce:animate-none">
                {itemCount}
              </span>
            )}
          </button>
        )}
      />

      <main className="mx-auto grid w-full min-w-0 gap-5 px-4 py-4 lg:max-w-6xl lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-6 lg:px-6">
        <section className="min-w-0 space-y-4">
          <CustomerStoreCard
            contextLabel={orderType === 'DINE_IN' ? 'Dining at' : 'Pickup from'}
            storeName={selectedStore?.name || 'Choose store'}
            statusLabel={customerOrderingState.statusLabel}
            tone={customerOrderingState.tone}
            message={selectedStoreMessage}
            onOpenSelector={() => setStoreSelectorOpen(true)}
          />

          {/* My Usual sits between the store strip and search, per the approved order. */}
          <CustomerMyUsualCard
            state={
              !verifiedCustomer
                ? 'SIGNED_OUT'
                : myUsualLoading
                  ? 'LOADING'
                  : !myUsual
                    ? 'EMPTY'
                    : myUsualPreview?.state === 'SAVED' ? 'SAVED' : 'LOADING'
            }
            // Every saved line, including any this store cannot fulfil. A blocked
            // usual has no complete total, so none is offered.
            lines={myUsualPreview?.state === 'SAVED' ? myUsualPreview.displayLines : []}
            totalLabel={
              myUsualPreview?.state === 'SAVED' && !myUsualPreview.blocked
                ? formatMoney(myUsualPreview.totals.grandTotal)
                : null
            }
            blockerMessage={
              isOffline
                ? 'Reconnect to check current prices and availability.'
                : myUsualPreview?.state === 'SAVED' ? myUsualPreview.blockerMessage : undefined
            }
            noticeMessage={myUsualPreview?.state === 'SAVED' ? myUsualPreview.noticeMessage : undefined}
            busy={myUsualBusy}
            offline={isOffline}
            onSignIn={() => {
              pendingMyUsualSaveRef.current = false;
              setMyUsualDialog({ type: 'SIGN_IN' });
            }}
            onCreate={() => {
              searchInputRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
              setMyUsualNotice('Add your regular items to the basket, then choose Save as My Usual.');
            }}
            onOrder={() => startMyUsualOrder('ORDER')}
            onEdit={() => startMyUsualOrder('EDIT')}
            onDelete={() => setMyUsualDialog({ type: 'DELETE' })}
          />

          {myUsualNotice && (
            <p role="status" aria-live="polite" className="cb-customer-usual-note px-3 py-2 text-sm font-bold">
              {myUsualNotice}
            </p>
          )}

          {!customerOrderingState.canAcceptOrders && !availabilityLoading && (
            <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm font-bold leading-relaxed text-red-800">
              {customerOrderingState.message}
            </div>
          )}
          {availabilityLoading ? (
            <div className="rounded-2xl bg-[#f5ede5] px-4 py-3 text-sm font-bold text-[#71645d]">
              Checking menu availability...
            </div>
          ) : availabilityNotice ? (
            <div className="rounded-2xl bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800">
              {availabilityNotice}
            </div>
          ) : null}
          {checkoutDraftNotice && (
            <div role="status" className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold leading-relaxed text-amber-900">
              {checkoutDraftNotice}
            </div>
          )}

          <label className="flex h-12 items-center gap-3 rounded-2xl bg-white px-4 shadow-sm ring-1 ring-[#e7ddd3] focus-within:ring-2 focus-within:ring-[#8b5e42]/35">
            <Search size={18} className="shrink-0 text-[#8b5e42]" />
            <input
              ref={searchInputRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="w-full bg-transparent text-[15px] font-semibold outline-none placeholder:text-[#9a8d86]"
              placeholder="Search the menu"
              aria-label="Search the menu"
            />
          </label>

          {error && (
            <div className="flex gap-3 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-800">
              <AlertCircle size={18} className="shrink-0" />
              {error}
            </div>
          )}

          {/* Two-area menu: sticky vertical rail on the left, one continuous vertical
              content column on the right. No nested scroller, no horizontal movement. */}
          <div className="flex min-w-0 items-start gap-2 sm:gap-3">
            <CustomerCategoryRail
              categories={categories}
              selected={category}
              onSelectCategory={setCategory}
              labelFor={categoryLabel}
            />

            <div className="min-w-0 flex-1 space-y-6">
              {loading ? (
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                  {[1, 2, 3, 4].map(key => <div key={key} className="cb-customer-skeleton aspect-[4/5] animate-pulse rounded-[20px] motion-reduce:animate-none" />)}
                </div>
              ) : isSearching ? (
                /* Search collapses the menu to one flat vertical result list. */
                <section>
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h2 className="text-lg font-black text-[#271a16]">Search results</h2>
                    <p className="text-xs font-bold text-[#71645d]">{visibleItems.length} items</p>
                  </div>
                  {visibleItems.length === 0 ? (
                    <div className="rounded-3xl bg-white p-5 text-center ring-1 ring-[#e7ddd3]">
                      <p className="font-black text-[#271a16]">Nothing found here</p>
                      <p className="text-sm text-[#71645d]">Try another search.</p>
                      <button
                        type="button"
                        onClick={() => { setSearch(''); setCategory('ALL'); }}
                        className="mt-3 min-h-11 rounded-2xl bg-[#f5ede5] px-4 text-sm font-black text-[#3b241c] focus:outline-none focus:ring-2 focus:ring-[#8b5e42]/40"
                      >
                        Show full menu
                      </button>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                      {visibleItems.map((item, index) => renderMenuCard(item, index))}
                    </div>
                  )}
                </section>
              ) : category === 'ALL' ? (
                /* All: Popular first, then the whole menu grouped by category heading,
                   in one continuous vertical flow. */
                <>
                  {popularItems.length > 0 && (
                    <section>
                      <h2 className="mb-3 text-lg font-black text-[#271a16]">Popular today</h2>
                      {/* Fixed 2×2 grid — never a carousel, and never a clipped fifth card. */}
                      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                        {popularItems.slice(0, 4).map((item, index) => renderMenuCard(item, index))}
                      </div>
                    </section>
                  )}

                  {menuSections.map(section => (
                    <section key={section.id} data-customer-category={section.id}>
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <h2 className="text-lg font-black text-[#271a16]">{categoryLabel(section.category)}</h2>
                        <p className="text-xs font-bold text-[#71645d]">{section.items.length} items</p>
                      </div>
                      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                        {section.items.map((item, index) => renderMenuCard(item, index))}
                      </div>
                    </section>
                  ))}
                </>
              ) : (
                /* A specific category: one compact vertical grid of just that category. */
                <section data-customer-category={category}>
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h2 className="text-lg font-black text-[#271a16]">{categoryLabel(category)}</h2>
                    <p className="text-xs font-bold text-[#71645d]">{visibleItems.length} items</p>
                  </div>
                  {visibleItems.length === 0 ? (
                    <div className="rounded-3xl bg-white p-5 text-center ring-1 ring-[#e7ddd3]">
                      <p className="font-black text-[#271a16]">Nothing here right now</p>
                      <p className="text-sm text-[#71645d]">Try another category.</p>
                      <button
                        type="button"
                        onClick={() => setCategory('ALL')}
                        className="mt-3 min-h-11 rounded-2xl bg-[#f5ede5] px-4 text-sm font-black text-[#3b241c] focus:outline-none focus:ring-2 focus:ring-[#8b5e42]/40"
                      >
                        Show full menu
                      </button>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                      {visibleItems.map((item, index) => renderMenuCard(item, index))}
                    </div>
                  )}
                </section>
              )}
            </div>
          </div>
        </section>

        <aside className="hidden h-fit max-h-[calc(100dvh-6rem)] overflow-y-auto rounded-3xl bg-white p-5 shadow-sm ring-1 ring-[#e7ddd3] lg:sticky lg:top-24 lg:block">
          {basketPanel}
        </aside>
      </main>

      {/* Replaces the old mobile-only "View basket" bar. Every behaviour it had is
          retained by the bottom navigation: it opens the same basket sheet, shows the
          same item count, announces the same total, and bumps on a successful add.
          Unlike the old bar it is always present, so the basket is reachable even
          when the cart is empty. */}
      <CustomerBottomNav
        itemCount={itemCount}
        totalLabel={formatMoney(totals.grandTotal)}
        onOpenBasket={() => setBasketOpen(true)}
        onFocusSearch={() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }}
        onGoToMenu={() => {
          // Menu returns to the unfiltered menu at the top.
          setCategory('ALL');
          setSearch('');
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
        onOpenAccount={() => {
          // Reuse the header's existing account control rather than adding a second
          // account implementation. Signed in, it opens the account menu; signed out,
          // it raises the same verification entry the header uses.
          const headerAccount = document.querySelector<HTMLElement>(
            'header [aria-label="Open customer account"], header [aria-label="Customer account"]',
          );
          if (headerAccount) headerAccount.click();
          else setBasketOpen(true);
        }}
      />

      <p className="sr-only" role="status" aria-live="polite">{basketAnnouncement}</p>

      {/* My Usual confirmations. Every consequence is stated before it happens, and
          none of these actions submits an order, OTP or payment. */}
      {myUsualDialog && (
        <div className="cb-customer-sheet-scrim fixed inset-0 z-[70] flex items-end justify-center" role="dialog" aria-modal="true" aria-label="My Usual">
          <button type="button" className="absolute inset-0 h-full w-full" aria-label="Dismiss" onClick={() => setMyUsualDialog(null)} />
          <div className="cb-customer-sheet relative w-full max-w-md p-5">
            {myUsualDialog.type === 'SIGN_IN' && (
              <>
                <h2 className="cb-customer-title text-lg font-black">Sign in to save My Usual</h2>
                <p className="cb-customer-muted mt-1 text-sm font-bold">
                  My Usual lives in your Coffee Bond profile so it follows you across devices. Your basket is kept exactly as it is, and nothing is ordered or paid for here.
                </p>
                {/* The existing customer OTP panel — there is no second OTP path. */}
                <div className="mt-4">
                  <CustomerOtpPanel
                    mobile={customerPhone}
                    verifiedPhone={verifiedCustomer?.normalisedPhone || null}
                    onMobileChange={(mobile) => {
                      setCustomerPhone(mobile);
                      setVerifiedCustomer(null);
                    }}
                    onVerified={handleMyUsualVerified}
                  />
                </div>
              </>
            )}
            {myUsualDialog.type === 'CONFIRM_PENDING_SAVE' && (
              <>
                <h2 className="cb-customer-title text-lg font-black">Save this basket as My Usual?</h2>
                <p className="cb-customer-muted mt-1 text-sm font-bold">
                  {itemCount} item{itemCount === 1 ? '' : 's'} from {selectedStore?.name || 'this store'} will be saved to your Coffee Bond profile. Nothing is ordered.
                </p>
                <button
                  type="button"
                  onClick={confirmSaveMyUsual}
                  data-requires-online="true"
                  disabled={myUsualBusy || isOffline}
                  className="cb-customer-accent-button mt-4 min-h-11 w-full rounded-2xl text-sm font-black"
                >
                  {myUsualBusy ? 'Saving...' : 'Save My Usual'}
                </button>
              </>
            )}
            {myUsualDialog.type === 'SAVE_NEW' && (
              <>
                <h2 className="cb-customer-title text-lg font-black">Save as My Usual?</h2>
                <p className="cb-customer-muted mt-1 text-sm font-bold">
                  {itemCount} item{itemCount === 1 ? '' : 's'} from {selectedStore?.name || 'this store'} will be saved to your Coffee Bond profile.
                </p>
                <button
                  type="button"
                  onClick={confirmSaveMyUsual}
                  data-requires-online="true"
                  disabled={myUsualBusy || isOffline}
                  className="cb-customer-accent-button mt-4 min-h-11 w-full rounded-2xl text-sm font-black"
                >
                  {myUsualBusy ? 'Saving...' : 'Save My Usual'}
                </button>
              </>
            )}
            {myUsualDialog.type === 'REPLACE_USUAL' && (
              <>
                <h2 className="cb-customer-title text-lg font-black">Replace your current My Usual with this basket?</h2>
                <p className="cb-customer-muted mt-1 text-sm font-bold">Your previously saved usual will be overwritten in your Coffee Bond profile.</p>
                <button
                  type="button"
                  onClick={confirmSaveMyUsual}
                  data-requires-online="true"
                  disabled={myUsualBusy || isOffline}
                  className="cb-customer-accent-button mt-4 min-h-11 w-full rounded-2xl text-sm font-black"
                >
                  {myUsualBusy ? 'Saving...' : 'Replace My Usual'}
                </button>
              </>
            )}
            {myUsualDialog.type === 'REPLACE_BASKET' && (
              <>
                <h2 className="cb-customer-title text-lg font-black">Replace your current basket with My Usual?</h2>
                <p className="cb-customer-muted mt-1 text-sm font-bold">Your current basket items will be removed. Nothing is ordered yet.</p>
                <button
                  type="button"
                  onClick={() => applyMyUsualToBasket(myUsualDialog.lines)}
                  className="cb-customer-accent-button mt-4 min-h-11 w-full rounded-2xl text-sm font-black"
                >
                  Replace basket
                </button>
              </>
            )}
            {myUsualDialog.type === 'STORE_CLOSED' && (
              <>
                <h2 className="cb-customer-title text-lg font-black">
                  {selectedStore?.name || 'This store'} is not accepting orders right now.
                </h2>
                <p className="cb-customer-muted mt-1 text-sm font-bold">{myUsualDialog.message}</p>
                {/* Never reaches for the store the usual was saved from — the customer
                    picks, using the existing store selector. */}
                <button
                  type="button"
                  onClick={() => { setMyUsualDialog(null); setStoreSelectorOpen(true); }}
                  className="cb-customer-accent-button mt-4 min-h-11 w-full rounded-2xl text-sm font-black"
                >
                  Choose another store
                </button>
              </>
            )}
            {myUsualDialog.type === 'UNAVAILABLE' && (
              <>
                <h2 className="cb-customer-title text-lg font-black">Your usual needs a quick update</h2>
                <p className="cb-customer-muted mt-1 text-sm font-bold">
                  Some items are not available at {selectedStore?.name || 'this store'}.
                </p>
                {/* Every affected line is named. Nothing is silently dropped and a
                    partial usual is never ordered. */}
                <ul className="cb-customer-usual-blocker mt-3 space-y-1 px-3 py-2 text-[12px] font-bold">
                  {myUsualDialog.items.map(item => (
                    <li key={item}>{item} — not available here</li>
                  ))}
                  {myUsualDialog.addOns.map(entry => (
                    <li key={`${entry.product}-${entry.addOn}`}>{entry.product} — {entry.addOn} is not available here</li>
                  ))}
                </ul>
                {/* Choosing a store that can fulfil the usual keeps it intact, so it
                    leads. Editing changes the saved profile and follows. */}
                <button
                  type="button"
                  onClick={() => { setMyUsualDialog(null); setStoreSelectorOpen(true); }}
                  className="cb-customer-accent-button mt-4 min-h-11 w-full rounded-2xl text-sm font-black"
                >
                  Choose another store
                </button>
                <button
                  type="button"
                  onClick={() => { setMyUsualDialog(null); setBasketOpen(true); }}
                  className="mt-2 min-h-11 w-full rounded-2xl bg-[#f5ede5] text-sm font-black text-[#3b241c]"
                >
                  Edit My Usual
                </button>
              </>
            )}
            {myUsualDialog.type === 'DELETE' && (
              <>
                <h2 className="cb-customer-title text-lg font-black">Delete My Usual?</h2>
                <p className="cb-customer-muted mt-1 text-sm font-bold">
                  This removes the saved bundle from your Coffee Bond profile on every device. Your basket and past orders are not affected.
                </p>
                <button
                  type="button"
                  onClick={deleteMyUsual}
                  data-requires-online="true"
                  disabled={myUsualBusy || isOffline}
                  className="cb-customer-icon-button-danger mt-4 min-h-11 w-full rounded-2xl text-sm font-black"
                >
                  {myUsualBusy ? 'Deleting...' : 'Delete My Usual'}
                </button>
              </>
            )}
            {/* A failed save or delete is reported here, with the sheet still open so
                the customer can retry. Nothing claims success it did not get. */}
            {myUsualNotice && (
              <p role="status" aria-live="polite" className="cb-customer-usual-note mt-3 px-3 py-2 text-[12px] font-bold">
                {myUsualNotice}
              </p>
            )}
            <button
              type="button"
              onClick={() => setMyUsualDialog(null)}
              className="mt-2 min-h-11 w-full rounded-2xl bg-white text-sm font-black text-[#3b241c]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Stage 3 customer customization. The staff POS keeps using the shared
          components/add-ons/AddOnSelector; only this customer surface was redesigned.
          Every rule and price below still comes from the same authoritative helpers. */}
      {pendingAddOnItem && (
        <CustomerProductCustomizationSheet
          productName={pendingAddOnItem.displayName || pendingAddOnItem.name}
          description={cleanProductDescription(pendingAddOnItem)}
          categoryLabel={customerMenuCategory(pendingAddOnItem)}
          dietaryClassification={trustedDietaryClassification(pendingAddOnItem as unknown as Record<string, unknown>)}
          basePrice={toNumber(pendingAddOnItem.salePrice)}
          imageUrl={getItemImage(pendingAddOnItem)}
          fallbackIcon={visualMeta(pendingAddOnItem).icon}
          taxRate={itemTaxRate(pendingAddOnItem, selectedStoreTaxRate)}
          groups={activeAddOnGroupsForProduct(
            pendingAddOnItem.addOnGroupIds,
            pendingAddOnItem.addOnOptionIdsByGroup,
            addOnGroups,
          )}
          initialSelections={editingAddOnLine?.addOns}
          initialQuantity={editingAddOnLine?.quantity || 1}
          isEditing={Boolean(editingAddOnLine)}
          maxQuantity={CUSTOMER_MAX_LINE_QUANTITY}
          formatMoney={formatMoney}
          onCancel={() => {
            setPendingAddOnItem(null);
            setEditingAddOnLine(null);
          }}
          onConfirm={(selections, quantity) => {
            commitCartItem(pendingAddOnItem, selections, editingAddOnLine?.id, quantity);
            setPendingAddOnItem(null);
            setEditingAddOnLine(null);
          }}
        />
      )}

      {/* Stage 4a mobile basket: a near-full-height surface with one vertical scroll
          region. The underlying page is scroll-locked and the bottom navigation sits
          behind the scrim, so there is only ever one basket control in reach. */}
      {basketOpen && (
        <div className="cb-customer-sheet-scrim fixed inset-0 z-[75] lg:hidden">
          <button aria-label="Dismiss basket" className="absolute inset-0 h-full w-full cursor-default" onClick={() => setBasketOpen(false)} />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="cb-basket-heading"
            className="cb-customer-basket-sheet absolute inset-x-0 bottom-0 flex flex-col overflow-hidden"
          >
            <div className="mx-auto mt-3 mb-2 h-1.5 w-12 shrink-0 rounded-full bg-[#e0d4c7]" aria-hidden="true" />
            <div className="cb-customer-basket-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-5">
              {basketPanel}
            </div>
          </div>
        </div>
      )}

      {storeSelectorOpen && (
        <div className="fixed inset-0 z-50 bg-black/35">
          <button aria-label="Dismiss store selector" className="absolute inset-0 h-full w-full cursor-default" onClick={() => setStoreSelectorOpen(false)} />
          <section className="absolute inset-x-0 bottom-0 max-h-[88dvh] overflow-y-auto rounded-t-[28px] bg-[#fbf7f1] p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl lg:left-1/2 lg:right-auto lg:w-[430px] lg:-translate-x-1/2">
            <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-[#d9cec3]" />
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.14em] text-[#8b5e42]">Pickup store</p>
                <h2 className="mt-1 text-2xl font-black text-[#271a16]">{selectedStore?.name || 'Choose store'}</h2>
                <p className="mt-1 text-sm font-semibold text-[#71645d]">{customerOrderingState.message}</p>
              </div>
              <button onClick={() => setStoreSelectorOpen(false)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white text-[#3b241c] ring-1 ring-[#e7ddd3]" aria-label="Close store selector">
                <X size={18} />
              </button>
            </div>

            <div className="grid gap-3">
              <div className="rounded-3xl bg-white p-4 ring-1 ring-[#e7ddd3]">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-bold text-[#71645d]">Current store</p>
                    <p className="mt-1 font-black text-[#271a16]">{selectedStore?.name || 'Not selected'}</p>
                  </div>
                  <span className={`rounded-full px-3 py-1.5 text-xs font-black ${
                    customerOrderingState.tone === 'green'
                      ? 'bg-emerald-50 text-[#07855b]'
                      : customerOrderingState.tone === 'amber'
                        ? 'bg-amber-50 text-amber-800'
                        : 'bg-red-50 text-red-700'
                  }`}>
                    {customerOrderingState.statusLabel}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => selectClosestStore()}
                    disabled={locatingStore || stores.length === 0}
                    className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-2xl bg-[#3b241c] px-3 text-sm font-black text-white disabled:opacity-60"
                  >
                    <Navigation size={16} />
                    {locatingStore ? 'Finding nearest...' : 'Nearest store'}
                  </button>
                  <button
                    type="button"
                    onClick={saveSelectedStoreAsDefault}
                    disabled={!selectedStore}
                    className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-2xl bg-[#f5ede5] px-3 text-sm font-black text-[#3b241c] disabled:opacity-60"
                  >
                    <Star size={16} />
                    Save default
                  </button>
                </div>
                {!selectedStoreHasCoordinates && selectedStore && (
                  <p className="mt-3 rounded-2xl bg-amber-50 px-3 py-2 text-xs font-bold leading-relaxed text-amber-800">
                    This store needs coordinates before it can be used by the nearest-store shortcut.
                  </p>
                )}
                {storePreferenceMessage && (
                  <p className="mt-3 rounded-2xl bg-[#f5ede5] px-3 py-2 text-xs font-bold leading-relaxed text-[#71645d]">
                    {storePreferenceMessage}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                {stores.map(store => {
                  const state = deriveCustomerOrderingState({
                    store,
                    availabilitySnapshot: store.id === selectedStoreId ? publicAvailability : null,
                    availabilityLoading: store.id === selectedStoreId ? availabilityLoading : false,
                    orderableItemCount: store.id === selectedStoreId ? orderableItems.length : 1,
                    availabilityChecked: store.id === selectedStoreId,
                  });
                  const isSelected = store.id === selectedStoreId;
                  const hasCoordinates = !!storeCoordinate(store);
                  return (
                    <button
                      key={store.id}
                      type="button"
                      onClick={() => handleStoreChange(store.id)}
                      className={`flex min-h-[72px] w-full items-center justify-between gap-3 rounded-3xl p-4 text-left ring-1 transition focus:outline-none focus:ring-2 focus:ring-[#8b5e42]/40 ${
                        isSelected
                          ? 'bg-[#3b241c] text-white ring-[#3b241c]'
                          : state.canAcceptOrders
                            ? 'bg-white text-[#271a16] ring-[#e7ddd3]'
                            : 'bg-neutral-100 text-neutral-500 ring-neutral-200'
                      }`}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-base font-black">{store.name}</p>
                        <p className={`mt-1 text-xs font-bold ${isSelected ? 'text-white/75' : 'text-[#71645d]'}`}>
                          {state.statusLabel}{estimatedPrepLabel(store) ? ` · ${estimatedPrepLabel(store)}` : ''}
                          {!hasCoordinates ? ' · Coordinates needed' : ''}
                        </p>
                      </div>
                      {isSelected ? <CheckCircle2 size={20} className="shrink-0" /> : <ChevronDown size={18} className="shrink-0 rotate-[-90deg] text-[#8b5e42]" />}
                    </button>
                  );
                })}
              </div>

              {storesMissingCoordinates.length > 0 && (
                <div className="rounded-3xl bg-amber-50 p-4 text-sm font-bold leading-relaxed text-amber-800">
                  {storesMissingCoordinates.length} store{storesMissingCoordinates.length === 1 ? '' : 's'} need coordinates before nearest-store selection can include them.
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      {storePreferenceMessage && !storeSelectorOpen && (
        <div role="status" aria-live="polite" className="fixed inset-x-4 top-[calc(max(env(safe-area-inset-top),0px)+72px)] z-50 rounded-2xl bg-[#3b241c] px-4 py-3 text-center text-sm font-black text-white shadow-lg lg:left-1/2 lg:right-auto lg:w-[360px] lg:-translate-x-1/2">
          {storePreferenceMessage}
        </div>
      )}
    </div>
  );
}
