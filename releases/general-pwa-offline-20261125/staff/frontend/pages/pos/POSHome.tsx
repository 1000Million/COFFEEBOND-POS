import { gstSourceStore, storeGstTreatment } from '../../lib/storeGstTreatment';
import {OnlineOrderSoundControl} from '../../lib/OnlineOrderAlerts';
import TableSelector, {TableDraftSwitch} from '../../components/tables/TableSelector';
import TableOrderPanel from '../../components/tables/TableOrderPanel';
import InlineItemEntry from '../../components/tables/InlineItemEntry';
import BillItemEntry from '../../components/tables/BillItemEntry';
import {useTableOrder} from '../../lib/tables/useTableOrder';
import {TABLE_STORE,validPosStoreId} from '../../lib/tables/api';
import {assertCounterContext,draftKey,readLocalDraft,writeLocalDraft,draftStatus,sanitizeDraft} from '../../lib/tables/drafts';
import { persistPosOrder, requestPendingCheckoutRecovery } from '../../data/orders/posOrderRepository';
import { assertRecoveredFinancialResult } from '../../lib/pos/posFinancialResult';
import PaymentPanel from '../../components/pos/PaymentPanel';
import CartPanel from '../../components/pos/CartPanel';
import MenuGrid from '../../components/pos/MenuGrid';
import ReceiptModal from '../../components/pos/ReceiptModal';
import PopularItems from '../../components/pos/PopularItems';
import { usePosPopularity } from '../../lib/pos/usePosPopularity';
import { customerMobile } from '../../lib/pos/customerMobile';
import PendingCheckoutRecoveryPanel from '../../components/pos/PendingCheckoutRecoveryPanel';
import { hasBoundCheckoutAttempt, resolvePendingCheckoutStatus, checkoutDiagnostic, checkoutServerMessage, type PendingCheckoutResolution, type PendingCheckoutReview, type PendingCheckoutOwnership, type CheckoutRecoveryBinding, hasCheckoutOwnership, bindingMatchesCheckout, sameCheckoutRecoveryBinding, checkoutBasketIdentity } from '../../lib/pos/pendingCheckoutRecovery';
import HeldBillsPanel from '../../components/pos/HeldBillsPanel';
import { type ReceiptLineSnapshot, type ReceiptOrderSnapshot, type ReceiptPaymentSnapshot, type ReceiptSnapshot, type SplitPaymentRow, type HeldBill, sanitizeFirestoreId, stableJson, shortHash, cartLineIdentity, deterministicOrderItemId, checkoutPayloadHash, buildReceiptSnapshot, heldBillValidationError, createHeldBillSnapshot, recallHeldBillDraft, withoutHeldBill, heldBillDeleteLabel, checkoutPreconditionMessage } from '../../lib/pos/posOrderLifecycle';
import { loadPosStoreRecords } from '../../data/stores/storeRepository';
import { loadPosMenuSources } from '../../data/menu/menuRepository';
import { classifyMenuItems, countMenuCategories, rankFastMenuItems, filterMenuCategory, groupMenuSections, menuTileTone } from '../../lib/pos/posCategoryFilters';
import { normalizePaymentAmount, paymentRowsAllocated, paymentRowsAreBalanced, splitPaymentStatus, normalizedSplitPayments, paymentTotal, paymentBalance, validateSplitPayments } from '../../lib/pos/posPayments';
import { GST_CONFIG_DOC_ID, APP_TAX_RATE_KEYS, toFiniteNumber, normalizeTaxRate, pickTaxConfig, normalizeStoreOverrides, pickItemTaxRate, getItemTaxRate, receiptGstSplit, resolveStoreTaxConfig, type AppGstConfig, type TaxConfig } from '../../lib/pos/posTax';
import { calculateTotals, clampDiscountPercent } from '../../lib/pos/posTotals';
import React, { useState, useEffect, useMemo, useRef } from 'react';
import QRCode from 'react-qr-code';
import { collection, query, getDocs, getDocsFromServer, where, doc, getDoc, getDocFromServer, onSnapshot, Timestamp } from 'firebase/firestore';
import type { ConfirmationResult } from 'firebase/auth';
import { Link, useSearchParams } from 'react-router-dom';
import { auth, db } from '../../lib/firebase';
import { useAuth } from '../../contexts/AuthContext';
import { AddOnSelection, Store, MenuItem, CartItem, OrderType, PaymentMethod, Order, OrderItem, OrderPayment, PrepStation, ReceiptLegalDetails, type StaffProfile } from '../../types';
import type { AddOnGroup } from '../../types/menu-management';
import { InventoryDeductionBlocker, planInventoryDeductionForSale } from '../../lib/inventoryDeduction';
import {
  activeAddOnGroupsForProduct,
  addOnTaxForLine,
  addOnTotal,
  canonicalAddOnSelections,
  unitPriceWithAddOns,
} from '../../lib/addOns';
import {
  authorizePosAddOns,
  selectedAddOnIds,
} from '../../lib/posAddOnAuthorization';
import {
  expandCompositeInventoryLines,
  summarizeParentInventory,
} from '../../lib/compositeFulfillment';
import {
  cancelPosRazorpaySession,
  createPosRazorpaySession,
  getPosRazorpayStatus,
  isPosRazorpaySessionLocked,
  posRazorpayStatusLabel,
  PosRazorpaySession,
} from '../../lib/posRazorpay';
import AddOnSelector from '../../components/add-ons/AddOnSelector';
import {
  buildComplimentaryTotals,
  ComplimentaryOtpVerification,
  isComplimentaryVerificationExpired,
  isValidIndianMobile,
  receiptLegalDetailsFromStore,
  retainVerificationForPhone,
  validateComplimentaryCheckout,
} from '../../lib/complimentaryOrders';
import {
  complimentaryPhoneErrorCode,
  complimentaryPhoneErrorMessage,
  complimentaryRecaptchaContainerId,
  disposeComplimentaryPhoneVerification,
  sendComplimentaryPhoneOtp,
  verifyComplimentaryPhoneOtp,
} from '../../lib/complimentaryPhoneVerification';
import { Loader2, Plus, Minus, Trash2, Search, Store as StoreIcon, User, Phone, MapPin, SearchX, Coffee, CheckCircle, Printer, AlertCircle, AlertTriangle, X, Copy, ExternalLink, RefreshCw, Zap, LayoutGrid } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import {useUpdateBlocker,usePosUpdateBoundary} from '../../lib/useUpdateBlocker';
import { beginCriticalOperation, OFFLINE_ACTION_MESSAGE, requireOnlineAction } from '../../lib/connectivity';
import { usePosOnline } from '../../lib/pos/usePosOnline';
import { CHECKOUT_ATTEMPT_STORAGE_KEY, withCheckoutMarkerLock } from '../../lib/pos/checkoutLock';
import { cashCaptureForBasket, cashCaptureForTable, entries as readOfflineCashEntries, getMeta, verifySnapshotForRead, saveCash, totals as offlineCashTotals, type Entry as OfflineCashEntry } from '../../lib/offline/journal';
import {isCashEntry} from '../../lib/offline/tableRepository';
import {printSavedEntry} from '../../lib/offline/localPrint';
import { usePosOfflineCash } from '../../lib/offline/usePosOfflineCash';
import { findStartupDraftStoreIds, nearbyPosStore, rememberedPosStore, rememberPosStore, requestPosLocation, soleAssignedPosStore } from '../../lib/pos/startupStore';
import PosOfflineStatus from '../../components/pos/PosOfflineStatus';
import PosOfflineCashPayment from '../../components/pos/PosOfflineCashPayment';
import { accessiblePosStores, assignedStoreIdentifiers } from '../../lib/posStoreAccess';
import {
  canReadMissingCheckoutOrder,
  canTreatCheckoutOrderReadAsMissing,
  isCheckoutPermissionError,
} from '../../lib/posCheckoutAccess';
import {
  classifyPosMenuItemWithCategories,
  finishedGoodTaxonomyFields,
  NEEDS_CLASSIFICATION_CATEGORY,
  posMenuNavigationCategories,
  quickPicksInRankOrder,
  searchPosMenuItems,
  uniqueSortedPosMenuItems,
} from '../../lib/posMenuNavigation';
import { usePosMenuTaxonomy } from '../../lib/usePosMenuTaxonomy';

type CheckoutError = {
  message: string;
  details?: string;
  blockers?: CheckoutBlocker[];
  supportReference?: string;
};

type CheckoutBlocker = InventoryDeductionBlocker;
type PosMenuItem = MenuItem & { tableProductId: string };
type CheckoutWriteTrace = {
  step: string;
  operation: 'create' | 'set' | 'update';
  path: string;
};

type ComplimentaryOtpStatus = 'IDLE' | 'SENDING' | 'CODE_SENT' | 'VERIFYING' | 'VERIFIED' | 'EXPIRED' | 'ERROR';

type CheckoutAttempt = {
  idempotencyKey: string;
  orderId: string;
  createdAt: number;
  payloadHash?: string;
  previousPayloadHashes?: string[];
  ownership?: PendingCheckoutOwnership;
  recoveryBinding?: CheckoutRecoveryBinding;
};

class CheckoutBlockerError extends Error {
  blockers: CheckoutBlocker[];

  constructor(blockers: CheckoutBlocker[]) {
    super('Checkout blocked by stock/BOM readiness checks.');
    this.name = 'CheckoutBlockerError';
    this.blockers = blockers;
  }
}

const TAX_SETTING_DOC_IDS = [GST_CONFIG_DOC_ID, 'tax', 'taxSettings', 'posSettings', 'settings'];

const LAST_RECEIPT_STORAGE_KEY = 'coffeeBondPos:lastReceipt:v1';
const HELD_BILLS_STORAGE_KEY = 'coffeeBondPos:heldBills:v1';
const RECENT_ITEMS_STORAGE_KEY = 'coffeeBondPos:recentItems:v1';
const POS_RAZORPAY_SESSION_STORAGE_KEY = 'coffeeBondPos:pendingRazorpaySession:v1';
const POS_REVALIDATION_MESSAGE = 'Reconnect checks are incomplete. Verify your account, store and current menu before submitting. Nothing was sent automatically.';
const RECENT_ITEMS_LIMIT = 8;
const PAYMENT_METHODS: PaymentMethod[] = ['CASH', 'UPI', 'CARD', 'RAZORPAY', 'SWIGGY', 'ZOMATO', 'CREDIT', 'COMPLIMENTARY'];
const SPLIT_PAYMENT_METHODS = PAYMENT_METHODS.filter(method => !['COMPLIMENTARY', 'RAZORPAY'].includes(method));
const COMPLIMENTARY_OTP_RESEND_SECONDS = 30;
const COMPLIMENTARY_RECAPTCHA_CONTAINER_ID = complimentaryRecaptchaContainerId();
const ORDER_TYPE_LABELS: Record<OrderType, string> = {
  DINE_IN: 'Dine In',
  TAKEAWAY: 'Takeaway',
  DELIVERY: 'Delivery',
};
const QUICK_TABLE_CHIPS = ['1', '2', '3', '4'];

function getMaxDiscountPercent(role?: string): number {
  if (role === 'ADMIN') return 100;
  if (role === 'STORE_MANAGER') return 20;
  return 10;
}

function createSafeClientId(prefix: string): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return randomUuid;

  const randomPart = globalThis.crypto?.getRandomValues
    ? globalThis.crypto.getRandomValues(new Uint32Array(2)).join('-')
    : Math.random().toString(36).slice(2);

  return `${prefix}-${Date.now()}-${randomPart}`;
}

function createCheckoutAttempt(): CheckoutAttempt {
  const idempotencyKey = sanitizeFirestoreId(createSafeClientId('pos-checkout'), 120);
  return {
    idempotencyKey,
    orderId: sanitizeFirestoreId(`POS_${idempotencyKey}`, 180),
    createdAt: Date.now(),
  };
}

function validStoredCheckoutAttempt(value: unknown): CheckoutAttempt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const attempt = value as CheckoutAttempt;
  // Never age out, sanitize, or adopt a financial recovery marker, including a legacy unbound marker.
  if (typeof attempt.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(attempt.idempotencyKey)
    || typeof attempt.orderId !== 'string' || !/^POS_[A-Za-z0-9_-]{1,176}$/.test(attempt.orderId)
    || !Number.isFinite(attempt.createdAt)) return null;
  return attempt;
}

function sameCheckoutAttempt(left: CheckoutAttempt | null | undefined, right: CheckoutAttempt | null | undefined): boolean {
  return Boolean(left && right && stableJson(left) === stableJson(right));
}
const hasPendingCheckoutGuard = (attempt: CheckoutAttempt | null | undefined) => Boolean(attempt);
const unreadableCheckoutAttempt = (): CheckoutAttempt => ({ orderId: 'UNVERIFIED_LOCAL_CHECKOUT', idempotencyKey: 'UNVERIFIED_LOCAL_CHECKOUT', createdAt: 0 });
function loadCheckoutAttempt(): CheckoutAttempt | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY);
    if (raw === null) return null;
    return validStoredCheckoutAttempt(JSON.parse(raw)) || unreadableCheckoutAttempt();
  } catch { return unreadableCheckoutAttempt(); }
}

async function writeCheckoutAttempt(attempt: CheckoutAttempt, expected: CheckoutAttempt | null): Promise<void> {
  await withCheckoutMarkerLock(async () => {
    const stored = loadCheckoutAttempt();
    if (expected ? !sameCheckoutAttempt(stored, expected) : stored !== null) throw new Error('The checkout reference changed in another window. Keep the basket and check the previous checkout.');
    if (!hasCheckoutOwnership(attempt) || auth.currentUser?.uid !== attempt.ownership!.staffUid
      || (expected && stableJson(expected.ownership) !== stableJson(attempt.ownership))) throw new Error('The original checkout ownership could not be verified.');
    const draft = window.localStorage.getItem(attempt.ownership!.draftKey);
    if (!draft || stableJson(JSON.parse(draft)) !== attempt.ownership!.reference) throw new Error('The original basket changed in another window. Keep its checkout guard.');
    if (!expected) {
      const lineIds = (JSON.parse(draft).cart as { id: string }[]).map(line => line.id);
      const existing = await cashCaptureForBasket(attempt.ownership!.storeId, lineIds);
      if (existing) throw Object.assign(new Error('Cash was already saved for this basket. Check the original bill in the Cash journal before collecting again.'), { code: 'client/cash-already-saved' });
      if (auth.currentUser?.uid !== attempt.ownership!.staffUid || window.localStorage.getItem(attempt.ownership!.draftKey) !== draft) {
        throw new Error('The original checkout context changed. Nothing was submitted.');
      }
    }
    window.localStorage.setItem(CHECKOUT_ATTEMPT_STORAGE_KEY, JSON.stringify(attempt));
  });
}

function timestampMillis(value: any): number {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value?.toDate) return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value.seconds === 'number') return value.seconds * 1000 + Math.floor(Number(value.nanoseconds || 0) / 1000000);
  return 0;
}

function activePosLaunchException(store?: Store | null): boolean {
  return store?.posLaunchException?.enabled === true
    && timestampMillis(store.posLaunchException.expiresAt) > Date.now();
}

function prepStationLabel(prepStation?: string | null): string {
  const normalized = normalizePrepStation(prepStation);
  if (normalized === 'BARISTA') return 'Barista';
  if (normalized === 'KITCHEN') return 'Kitchen';
  if (normalized === 'BOTH') return 'Bar + Kitchen';
  return 'Ready to bill';
}

function normalizePrepStation(value: unknown): PrepStation {
  const normalized = String(value || 'NONE').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (normalized === 'BARISTA' || normalized === 'BAR') return 'BARISTA';
  if (normalized === 'KITCHEN' || normalized === 'KITCHEN_KOT') return 'KITCHEN';
  if (normalized === 'BOTH' || normalized === 'BARISTA_KITCHEN' || normalized === 'BAR_AND_KITCHEN') return 'BOTH';
  return 'NONE';
}

function readLocalStorageJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch (error) {
    console.warn(`Unable to read ${key} from localStorage`, error);
    return fallback;
  }
}

function writeLocalStorageJson<T>(key: string, value: T) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn(`Unable to write ${key} to localStorage`, error);
  }
}

function loadStoredHeldBills(): HeldBill[] {
  const bills = readLocalStorageJson<HeldBill[]>(HELD_BILLS_STORAGE_KEY, []);
  return Array.isArray(bills) ? bills : [];
}

function loadStoredRecentItems(): Record<string, string[]> {
  const recentItems = readLocalStorageJson<Record<string, string[]>>(RECENT_ITEMS_STORAGE_KEY, {});
  return recentItems && typeof recentItems === 'object' && !Array.isArray(recentItems) ? recentItems : {};
}

async function loadExistingCheckoutResult(
  orderRef: ReturnType<typeof doc>,
  attempt: CheckoutAttempt,
  expectedPayloadHash: string,
): Promise<{ savedOrder: Order; savedItems: OrderItem[]; savedPayments: OrderPayment[] } | null> {
  const orderSnap = await getDoc(orderRef);
  if (!orderSnap.exists()) return null;
  const order = { id: orderSnap.id, ...orderSnap.data() } as Order;
  const storedKey = String((order as Order & Record<string, unknown>).clientCheckoutIdempotencyKey || '');
  if (storedKey !== attempt.idempotencyKey) {
    throw new Error('Checkout retry conflict: an order already exists for this generated sale ID with a different idempotency key.');
  }
  if (String(order.checkoutPayloadHash || '') !== expectedPayloadHash) {
    throw new Error('Checkout retry conflict: an existing order has a different checkout payload.');
  }
  const [itemSnap, paymentSnap] = await Promise.all([
    getDocs(collection(orderRef, 'items')),
    getDocs(collection(orderRef, 'payments')),
  ]);
  const result = {
    savedOrder: order,
    savedItems: itemSnap.docs.map((itemDoc) => ({ id: itemDoc.id, ...itemDoc.data() } as OrderItem)),
    savedPayments: paymentSnap.docs.map((paymentDoc) => ({ id: paymentDoc.id, ...paymentDoc.data() } as OrderPayment)),
  };
  const savedRecord = order as Order & Record<string, unknown>;
  if (savedRecord.financialAuthorizationVersion === 3) {
    const authorizationId = String(savedRecord.addOnAuthorizationId || '');
    if (!authorizationId || savedRecord.createdByUserId !== auth.currentUser?.uid) throw new Error('This checkout must be recovered by its original signed-in staff account.');
    const authorization = await getDoc(doc(db, 'posAddOnAuthorizations', authorizationId));
    const plan = authorization.data()?.financials;
    if (!authorization.exists() || plan?.version !== 3) throw new Error('The saved checkout financial authorization requires review.');
    assertRecoveredFinancialResult(plan, savedRecord,
      result.savedItems as unknown as Array<Record<string, unknown>>,
      result.savedPayments as unknown as Array<Record<string, unknown>>);
  }
  return result;
}

function printReceiptElement() {
  const content = document.getElementById('receipt-area')?.innerHTML;
  if (!content) return;

  const printWin = window.open('', '', 'width=400,height=600');
  printWin?.document.write(`
    <html>
      <head>
        <title>Print Receipt</title>
        <style>
          body { font-family: monospace; padding: 20px; color: #000; }
          * { margin: 0; padding: 0; box-sizing: border-box; }
          .text-center { text-align: center; }
          .flex { display: flex; }
          .justify-between { justify-content: space-between; }
          .font-bold { font-weight: bold; }
          .font-black { font-weight: 900; }
          .uppercase { text-transform: uppercase; }
          .mb-1 { margin-bottom: 4px; }
          .mb-2 { margin-bottom: 8px; }
          .mb-3 { margin-bottom: 12px; }
          .mb-6 { margin-bottom: 24px; }
          .pb-1 { padding-bottom: 4px; }
          .pb-2 { padding-bottom: 8px; }
          .pb-6 { padding-bottom: 24px; }
          .pt-1 { padding-top: 4px; }
          .pt-4 { padding-top: 16px; }
          .mt-1 { margin-top: 4px; }
          .mt-2 { margin-top: 8px; }
          .mt-3 { margin-top: 12px; }
          .text-xs { font-size: 10px; }
          .text-sm { font-size: 12px; }
          .text-lg { font-size: 18px; }
          .text-xl { font-size: 20px; }
          .border-b { border-bottom: 1px solid #ccc; }
          .border-t { border-top: 1px solid #ccc; }
          .border-dashed { border-style: dashed; }
          .text-neutral-500 { color: #666; }
          .text-neutral-600 { color: #444; }
          .text-red-500 { color: red; }
        </style>
      </head>
      <body>${content}</body>
    </html>
  `);
  printWin?.document.close();
  printWin?.focus();
  printWin?.print();
  printWin?.close();
}

function formatQuantity(value: number | undefined, unit?: string): string {
  if (value === undefined || Number.isNaN(value)) return 'n/a';
  return `${value.toFixed(2)}${unit ? ` ${unit}` : ''}`;
}

function formatCheckoutBlockerDetails(blockers: CheckoutBlocker[]): string {
  return blockers.map((blocker, index) => {
    const component = blocker.componentCode
      ? `${blocker.componentType || 'COMPONENT'} / ${blocker.componentCode} (${blocker.componentName || 'Unnamed'})`
      : 'Item-level setup';

    return [
      `${index + 1}. ${blocker.itemName}`,
      `Item code: ${blocker.itemCode}`,
      `Finished goods code: ${blocker.finishedGoodCode || blocker.itemCode}`,
      `Blocker: ${blocker.blockerType}`,
      `Component: ${component}`,
      `Required: ${formatQuantity(blocker.requiredQuantity, blocker.unit)}`,
      `Available: ${formatQuantity(blocker.availableQuantity, blocker.unit)}`,
      `confirmedZero: ${blocker.confirmedZero === undefined ? 'n/a' : String(blocker.confirmedZero)}`,
      `Store: ${blocker.storeName}`,
      `Suggested action: ${blocker.suggestedAdminAction}`,
    ].join('\n');
  }).join('\n\n');
}

function buildCheckoutError(error: unknown): CheckoutError {
  if (error instanceof Error && (error as Error & {code?:string}).code === 'client/cash-already-saved') {
    return { message: error.message };
  }
  const supportReference = checkoutDiagnostic(error);
  if (error instanceof CheckoutBlockerError) {
    return {
      message: 'This item is not ready for billing because stock/BOM setup is incomplete. Please ask an Admin or Store Manager to check POS Readiness.',
      details: formatCheckoutBlockerDetails(error.blockers),
      blockers: error.blockers,
    };
  }

  const serverMessage = checkoutServerMessage(error);
  if (serverMessage) return { message: serverMessage, supportReference };
  const serverError = Boolean((error as { code?: unknown })?.code);
  const details = serverError ? supportReference || 'The server could not confirm this checkout.'
    : error instanceof Error ? error.message : 'Unknown checkout error';
  const lower = details.toLowerCase();

  if (
    lower.includes('insufficient stock')
    || lower.includes('recipe/bom')
    || lower.includes('checkout blocked')
    || lower.includes('required stock')
  ) {
    return {
      message: 'This item is not ready for billing because stock/BOM setup is incomplete. Please ask an Admin or Store Manager to check POS Readiness.',
      details,
      supportReference,
    };
  }

  if (lower.includes('discount') && lower.includes('limit')) {
    return {
      message: details,
      details,
      supportReference,
    };
  }

  if (lower.includes('split payment') || lower.includes('allocated')) {
    return {
      message: details,
      details,
      supportReference,
    };
  }

  if (lower.includes('permission') || lower.includes('permission-denied')) {
    return {
      message: 'This checkout could not be saved because your account does not have permission for this action. Please contact an Admin.',
      details,
      supportReference,
    };
  }

  return {
    message: 'Checkout could not be confirmed. Keep this checkout reference and check the previous checkout before collecting payment again.',
    details,
    supportReference,
  };
}

function isExpectedCheckoutValidationError(error: unknown): boolean {
  if (error instanceof CheckoutBlockerError) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error || '').toLowerCase();
  return (
    (message.includes('discount') && message.includes('limit'))
    || message.includes('split payment')
    || message.includes('allocated')
  );
}

export default function POSHome({offlineProfile}:{offlineProfile?:StaffProfile}={}) {
  const { firebaseUser, staffProfile } = useAuth();
  const offlineOnly=Boolean(offlineProfile && firebaseUser?.uid===offlineProfile.uid);
  return <POSWorkspace key={firebaseUser?.uid} staffProfile={offlineOnly?offlineProfile!:staffProfile} offlineOnly={offlineOnly}/>;
}

function POSWorkspace({ staffProfile, offlineOnly }: { staffProfile: StaffProfile | null; offlineOnly:boolean }) {
  const uid = staffProfile?.uid || '';
  const storeAccessKey = stableJson([uid, staffProfile?.role, (staffProfile as {staffAccessVersion?:unknown} | null)?.staffAccessVersion,
    assignedStoreIdentifiers(staffProfile).sort()]);
  const storeAccessRef = useRef(storeAccessKey);
  storeAccessRef.current = storeAccessKey;
  const [tableParams,setTableParams] = useSearchParams();
  const tableQueryRef = useRef(tableParams.toString());
  tableQueryRef.current = tableParams.toString();
  const localTableNavigation = useRef<string|null>(null);
  const clearTableRoute = () => {
    localTableNavigation.current = tableQueryRef.current;
    setTableParams({});
  };
  const tableRouteRequested = Boolean(tableParams.get('tableSession') || tableParams.get('table'));
  const tableTargetStore = tableParams.get('tableStore') || (tableRouteRequested ? TABLE_STORE : '');
  const { categories: posMenuCategories } = usePosMenuTaxonomy();
  const isAdmin = staffProfile?.role === 'ADMIN';
  const canViewCheckoutDebug = staffProfile?.role === 'ADMIN' || staffProfile?.role === 'STORE_MANAGER';

  const [stores, setStores] = useState<Store[]>([]);
  const [storeRead, setStoreRead] = useState<{key:string; locations:Store[]; verified:boolean; failed:boolean}>({key:'',locations:[],verified:false,failed:false});
  const [startupNotice,setStartupNotice] = useState('');
  const [startupWorkChecked,setStartupWorkChecked] = useState(false);
  const startupChosen = useRef(false);
  const locationRequest = useRef<ReturnType<typeof requestPosLocation> | null>(null);
  const [serverMenuItems, setMenuItems] = useState<PosMenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [appGstConfig, setAppGstConfig] = useState<AppGstConfig>({
    defaultRate: 0,
    defaultSource: 'No app GST fallback configured',
    storeOverrides: {},
  });

  const [selectedStoreId, setSelectedStoreId] = useState<string>('');
  const selectedStoreRef = useRef(selectedStoreId);
  selectedStoreRef.current = selectedStoreId;
  const selectStartupStore = (storeId:string) => {
    startupChosen.current = true;
    selectedStoreRef.current = storeId;
    setSelectedStoreId(storeId);
    setStartupNotice('');
  };
  const storeAccessReady = storeRead.key === storeAccessKey && !storeRead.failed;
  const selectedStoreAuthorized = storeAccessReady && stores.some(store=>store.id===selectedStoreId);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('ALL');
  const [selectedSubcategoryId, setSelectedSubcategoryId] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchInputFocused, setIsSearchInputFocused] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const recallMenuRef = useRef<HTMLDivElement | null>(null);
  const checkoutAttemptRef = useRef<CheckoutAttempt | null>(loadCheckoutAttempt());
  const [pendingRecovery, setPendingRecovery] = useState<{ attempt: CheckoutAttempt; resolution: PendingCheckoutResolution | null } | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const recoveryGenerationRef = useRef(0);
  const recoveryInFlightRef = useRef(false);
  const razorpayStatusInFlightRef = useRef(false);

  const [orderType, setOrderType] = useState<OrderType>('DINE_IN');
  const [tableNumber, setTableNumber] = useState('');
  const [tableNumberError, setTableNumberError] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [complimentaryReason, setComplimentaryReason] = useState('');
  const [complimentaryVerification, setComplimentaryVerification] = useState<ComplimentaryOtpVerification | null>(null);
  const [complimentaryConfirmationResult, setComplimentaryConfirmationResult] = useState<ConfirmationResult | null>(null);
  const [complimentaryOtpCode, setComplimentaryOtpCode] = useState('');
  const [complimentaryOtpStatus, setComplimentaryOtpStatus] = useState<ComplimentaryOtpStatus>('IDLE');
  const [complimentaryOtpMessage, setComplimentaryOtpMessage] = useState<string | null>(null);
  const [complimentaryResendSeconds, setComplimentaryResendSeconds] = useState(0);
  const [complimentaryExpiryClock, setComplimentaryExpiryClock] = useState(0);

  const [cart, setCart] = useState<CartItem[]>([]);
  const [addOnGroups, setAddOnGroups] = useState<AddOnGroup[]>([]);
  const [pendingAddOnItem, setPendingAddOnItem] = useState<MenuItem | null>(null);
  const [editingAddOnCartItem, setEditingAddOnCartItem] = useState<CartItem | null>(null);
  const [discountPercentStr, setDiscountPercentStr] = useState<string>('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | ''>('');
  const [isSplitPayment, setIsSplitPayment] = useState(false);
  const [splitPayments, setSplitPayments] = useState<SplitPaymentRow[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [checkoutError, setCheckoutError] = useState<CheckoutError | null>(null);
  const [lastReceipt, setLastReceipt] = useState<ReceiptSnapshot | null>(null);
  const [receiptView, setReceiptView] = useState<ReceiptSnapshot | null>(null);
  const [receiptViewTitle, setReceiptViewTitle] = useState('Order Saved');
  const [razorpaySession, setRazorpaySession] = useState<PosRazorpaySession | null>(() => (
    readLocalStorageJson<PosRazorpaySession | null>(POS_RAZORPAY_SESSION_STORAGE_KEY, null)
  ));
  const [razorpayActionLoading, setRazorpayActionLoading] = useState(false);
  const [razorpayNow, setRazorpayNow] = useState(Date.now());
  const [allHeldBills, setHeldBills] = useState<HeldBill[]>([]);
  const [recentItemIdsByStore, setRecentItemIdsByStore] = useState<Record<string, string[]>>({});
  const popularity = usePosPopularity(selectedStoreId, JSON.stringify([staffProfile?.uid, staffProfile?.role, assignedStoreIdentifiers(staffProfile)]));

  const posSource = 'FINISHED_GOODS' as const;
  const razorpayPaymentLocked = isPosRazorpaySessionLocked(razorpaySession);
  const razorpaySecondsRemaining = razorpaySession?.expiresAt
    ? Math.max(0, Math.ceil((new Date(razorpaySession.expiresAt).getTime() - razorpayNow) / 1000))
    : 0;
  const razorpayExpiryLabel = `${String(Math.floor(razorpaySecondsRemaining / 60)).padStart(2, '0')}:${String(razorpaySecondsRemaining % 60).padStart(2, '0')}`;

  const [revalidationRequired,setRevalidationRequired]=useState(false);
  const [revalidationAttempt,setRevalidationAttempt]=useState(0);
  const [serverCatalogueReady,setCatalogueReady]=useState(false);
  const reachable = usePosOnline();
  const posOnline = reachable && !offlineOnly;
  const heldBills = allHeldBills.filter(b=>b.storeId===selectedStoreId && (b.heldByUid===uid || (posOnline && !b.heldByUid)));
  const offlineCash = usePosOfflineCash({ store: selectedStoreAuthorized ? stores.find(store => store.id === selectedStoreId) : null, staffProfile, online: posOnline });
  const menuItems = useMemo(() => posOnline || !offlineCash.snapshot ? serverMenuItems : offlineCash.snapshot.menu
    .filter(p=>p.canonical && !p.canonical.addOns?.length && !p.request?.selectedAddOns?.length)
    .map((p):PosMenuItem => {
      const prior=serverMenuItems.find(i=>i.tableProductId===p.id);
      const code=p.request.parentProductCode;
      return {...prior,id:code,tableProductId:p.id,code,name:p.name,price:p.canonical.baseUnitPrice,taxRate:p.canonical.taxRate,
        categoryId:prior?.categoryId||'',categoryCode:prior?.categoryCode||'',categoryName:prior?.categoryName||'Offline menu',
        description:prior?.description||'',prepStation:p.canonical.prepStation||p.printTasks?.[0]?.station||prior?.prepStation,
        availableStoreIds:[offlineCash.snapshot!.storeId],isActive:true,addOnGroupIds:[],addOnOptionIdsByGroup:{},createdAt:null,updatedAt:null};
    }),[posOnline,offlineCash.snapshot,serverMenuItems]);
  const catalogueReady=posOnline?serverCatalogueReady:Boolean(offlineCash.snapshot);
  const localTableCapture = offlineCash.entries.find(entry => isCashEntry(entry) && entry.payload.table?.id === tableParams.get('tableSession'));
  const table = useTableOrder(uid, selectedStoreAuthorized ? selectedStoreId : '', orderType, isSaving || razorpayPaymentLocked || hasPendingCheckoutGuard(checkoutAttemptRef.current), revalidationRequired || !posOnline, posOnline, Boolean(localTableCapture), offlineCash);
  const tableOrderMode = (table.active || (tableRouteRequested && tableTargetStore === selectedStoreId))
    && !hasPendingCheckoutGuard(checkoutAttemptRef.current);
  const offlineSaving = useRef(false);
  const [offlineReceipt, setOfflineReceipt] = useState<OfflineCashEntry | null>(null);
  const [offlineNotice, setOfflineNotice] = useState('');
  const offlineReconnectPending = useRef(!posOnline);
  const offlineContext = useRef({ posOnline, table });
  offlineContext.current = { posOnline, table };

  useEffect(() => {
    if (posOnline && localTableCapture?.status === 'SYNCED') void table.load();
  }, [posOnline, localTableCapture?.id, localTableCapture?.status, table.load]);

  useEffect(() => {
    setOfflineReceipt(null);
    setOfflineNotice('');
  }, [selectedStoreId, staffProfile?.uid]);
  // Optional browsing belongs to one store/service/table. A history/deep-link
  // change must reveal its bill immediately, even before the effect runs.
  const fullMenuContext = `${selectedStoreId}:${orderType}:${tableParams.get('tableSession') || ''}:${tableParams.get('table') || ''}`;
  const [openMenuContext,setOpenMenuContext]=useState<string|null>(null);
  const fullMenuOpen = table.enabled && openMenuContext === fullMenuContext;
  const fullMenuRef=useRef<HTMLDivElement>(null);
  const menuReturnFocus=useRef<HTMLElement|null>(null);
  const openFullMenu=()=>{menuReturnFocus.current=document.activeElement as HTMLElement;setOpenMenuContext(fullMenuContext);};
  const closeFullMenu=()=>{setOpenMenuContext(null);requestAnimationFrame(()=>menuReturnFocus.current?.isConnected&&menuReturnFocus.current.focus());};
  useEffect(()=>{setOpenMenuContext(null);},[table.enabled,fullMenuContext]);
  useEffect(()=>{if(fullMenuOpen)fullMenuRef.current?.querySelector<HTMLInputElement>('input')?.focus();},[fullMenuOpen]);
  const changeOrderType=(type:OrderType)=>{
    if(type===orderType)return;
    const change=()=>{clearTableRoute();setOrderType(type);setPendingAddOnItem(null);if(type!=='DINE_IN')setTableNumberError(null);};
    if(table.active)table.requestLeave(change);else change();
  };

  const counterDraftKey = draftKey(staffProfile?.uid || '', selectedStoreId, null);
  const [counterDraftLoaded,setCounterDraftLoaded] = useState('');
  const [counterStorageWarning,setCounterStorageWarning] = useState(false);
  const [counterDraftConflict,setCounterDraftConflict] = useState(false);
  // Persist references only; the full transient fingerprint detects edits while awaiting the server.
  const basketReference = stableJson({ schemaVersion: 2, orderType, cart: cart.map(item => ({ id: item.id,
    menuItemId: item.menuItemId, quantity: item.quantity,
    addOns: (item.addOns || []).map(option => ({ groupId: option.groupId, optionId: option.optionId, quantity: option.quantity })) })) });
  const checkoutContextRef = useRef({ uid: '', storeId: '', draftKey: '', ready: false, saving: false, paymentPending: false, reference: '', fingerprint: '' });
  checkoutContextRef.current = { uid: staffProfile?.uid || '', storeId: selectedStoreId, draftKey: counterDraftKey,
    ready: selectedStoreAuthorized && counterDraftLoaded === counterDraftKey && !tableOrderMode, saving: isSaving, paymentPending: Boolean(razorpaySession),
    reference: basketReference,
    fingerprint: stableJson({ cart, orderType, tableNumber, customerName, customerPhone, complimentaryReason,
      discountPercentStr, paymentMethod, isSplitPayment, splitPayments, tableOrderMode, razorpaySession }) };

  const ownsCheckoutContext = (attempt: CheckoutAttempt, context = checkoutContextRef.current) => hasCheckoutOwnership(attempt)
    && attempt.ownership!.staffUid === context.uid && attempt.ownership!.storeId === context.storeId
    && attempt.ownership!.draftKey === context.draftKey && attempt.ownership!.reference === context.reference
    && attempt.ownership!.orderId === attempt.orderId && auth.currentUser?.uid === context.uid;
  const verifiedCheckoutContext = (attempt: CheckoutAttempt, resolution?: PendingCheckoutResolution | null, context = checkoutContextRef.current) =>
    ownsCheckoutContext(attempt, context) && bindingMatchesCheckout(attempt)
    && (!resolution || ('staffUid' in resolution && resolution.staffUid === attempt.ownership!.staffUid
      && sameCheckoutRecoveryBinding(resolution.recoveryBinding, attempt.recoveryBinding)));
  const chargeRecoveryBlocked = counterDraftConflict || Boolean(checkoutAttemptRef.current && (!ownsCheckoutContext(checkoutAttemptRef.current)
    || !bindingMatchesCheckout(checkoutAttemptRef.current) || checkoutAttemptRef.current.payloadHash
    || staffProfile?.role !== 'ADMIN' || !checkoutAttemptRef.current.previousPayloadHashes?.length));

  usePosUpdateBoundary();
  useUpdateBlocker(!!cart.length||!!customerName||!!customerPhone||!!tableNumber||isSaving||razorpayPaymentLocked||recoveryBusy||hasPendingCheckoutGuard(checkoutAttemptRef.current)||revalidationRequired);
  useEffect(() => {
    if(!selectedStoreAuthorized||!catalogueReady||counterDraftLoaded===counterDraftKey)return;
    const saved=readLocalDraft<any>(counterDraftKey,null);
    setCounterStorageWarning(draftStatus(counterDraftKey)!=='saved');
    const restored:CartItem[]=[];let unavailable=false;
    for(const ref of saved?.cart||[]){
      const item=menuItems.find(i=>i.id===ref.menuItemId&&i.isActive&&i.availableStoreIds?.includes(selectedStoreId));
      if(!item){unavailable=true;continue}
      try{
        const addOns=canonicalAddOnSelections(item.addOnGroupIds,item.addOnOptionIdsByGroup,addOnGroups,ref.addOns,getItemTaxRate(item,resolveStoreTaxConfig(stores,selectedStoreId,appGstConfig)));
        const refs=(values:any[])=>JSON.stringify(values.map(a=>[a.groupId,a.optionId,a.quantity]).sort());
        if(refs(addOns)!==refs(ref.addOns))throw Error('Saved option unavailable');
        const extra=addOnTotal(addOns);
        restored.push({id:ref.id,menuItemId:item.id,menuItemCode:item.code,name:item.name,price:item.price,taxRate:item.taxRate,prepStation:normalizePrepStation(item.prepStation),quantity:ref.quantity,sourceSystem:posSource,itemType:(item as any).itemType,finishedGoodCode:(item as any).finishedGoodCode,bom:(item as any).bom,addOns,baseUnitPrice:item.price,addOnTotal:extra,unitPriceWithAddOns:item.price+extra});
      }catch{unavailable=true}
    }
    if(unavailable){setCheckoutError({message:'Some saved item references are no longer available. Draft recovery is locked; ask a manager to review the current menu.'});setRevalidationRequired(true);return}
    setCart(restored);setCustomerName('');setCustomerPhone('');setTableNumber('');
    if(!tableOrderMode&&saved?.orderType)setOrderType(saved.orderType);
    setCounterDraftLoaded(counterDraftKey);
  },[counterDraftKey,selectedStoreAuthorized,selectedStoreId,catalogueReady,menuItems,addOnGroups,counterDraftLoaded,tableOrderMode]);
  useEffect(()=>{
    if(counterDraftConflict||counterDraftLoaded!==counterDraftKey||!selectedStoreAuthorized||tableOrderMode)return;
    // Contacts and labels remain in component memory; persist references only.
    if(draftStatus(counterDraftKey)==='corrupt'&&!cart.length)return;
    setCounterStorageWarning(!writeLocalDraft(counterDraftKey,{cart,orderType}));
  },[counterDraftLoaded,counterDraftKey,cart,orderType,tableOrderMode,counterDraftConflict,selectedStoreAuthorized]);
  useEffect(()=>{
    if (!posOnline) {
      offlineReconnectPending.current = true;
      setRevalidationRequired(true);
      return;
    }
    if (!offlineReconnectPending.current || !staffProfile?.uid || !selectedStoreId) return;
    let active = true;
    let retry: number | undefined;
    const revalidate = async()=>{
      try{
        const profile=await getDocFromServer(doc(db,'users',staffProfile.uid));
        if (!active) return;
        const data=profile.data();
        if(!data||data.isActive!==true||!['ADMIN','STORE_MANAGER','CASHIER'].includes(data.role)||!(data.role==='ADMIN'||assignedStoreIdentifiers(data).includes(selectedStoreId)))throw Error('Access must be verified');
        const ready=await fetchMenuData(false, () => active);
        if(!ready)throw Error('Menu must be verified');
        if(active){
          offlineReconnectPending.current=false;
          setRevalidationRequired(false);
          setCheckoutError(previous => previous?.message === POS_REVALIDATION_MESSAGE ? null : previous);
        }
      }catch(error){
        if(!active)return;
        setCheckoutError({message:POS_REVALIDATION_MESSAGE});
        const code=String((error as { code?: string })?.code || '').split('/').at(-1);
        if(code==='unavailable'||code==='deadline-exceeded')retry=window.setTimeout(revalidate,5000);
      }
    };
    void revalidate();
    return()=>{active=false;window.clearTimeout(retry)};
  },[posOnline,staffProfile?.uid,selectedStoreId,revalidationAttempt]);

  const [debugCounts, setDebugCounts] = useState<any>(null);
  const [isMobileCartOpen, setIsMobileCartOpen] = useState(false);
  const [isRecallMenuOpen, setIsRecallMenuOpen] = useState(false);

  useEffect(() => {
    fetchMenuData();
    fetchTaxConfig();
  }, []);

  useEffect(() => {
    let active=true;
    const loadStores=async()=>{
      if(!staffProfile||!uid)return;
      try {
        if(!posOnline) {
          const retained=storeRead.key===storeAccessKey && !storeRead.failed ? stores : [];
          if(retained.length && retained.some(s=>s.id===selectedStoreRef.current)){
            setStoreRead({key:storeAccessKey,locations:retained,verified:false,failed:false});
            return;
          }
          const snapshot=await getMeta('snapshot');
          if(snapshot && snapshot.uid===uid && snapshot.role===staffProfile.role && assignedStoreIdentifiers(staffProfile).includes(snapshot.storeId)){
            await verifySnapshotForRead(snapshot);
            if(!active||storeAccessRef.current!==storeAccessKey)return;
            const cached={id:snapshot.storeId,code:snapshot.storeId,name:snapshot.storeName,isActive:true,posEnabled:true} as Store;
            setStores([cached]);setStoreRead({key:storeAccessKey,locations:[cached],verified:false,failed:false});
            return;
          }
        }
        const {stores:fetched,verified}=await loadPosStoreRecords(db,isAdmin?undefined:assignedStoreIdentifiers(staffProfile));
        if(!active||storeAccessRef.current!==storeAccessKey)return;
        const allowed=accessiblePosStores(fetched,staffProfile);
        setStores(allowed);
        setStoreRead({ key:storeAccessKey,locations:fetched,verified,failed:false });
      } catch {
        if(active&&storeAccessRef.current===storeAccessKey)setStoreRead({key:storeAccessKey,locations:[],verified:false,failed:true});
      }
    };
    void loadStores();
    return ()=>{active=false};
  }, [storeAccessKey,posOnline]);

  useEffect(()=>{
    if(!uid||!staffProfile||!storeAccessReady||!stores.length||selectedStoreId||startupChosen.current)return;
    let active=true;
    const canSelect=()=>active&&storeAccessRef.current===storeAccessKey&&auth.currentUser?.uid===uid
      &&!selectedStoreRef.current&&!startupChosen.current;
    const inspectWork=async():Promise<{ storeId?: string; tableSessionId?: string; notice?: string }>=>{
      const allowed=(id:unknown):id is string=>typeof id==='string'&&stores.some(store=>store.id===id);
      const pending=loadCheckoutAttempt();
      // The exact counter reference outranks location, a preference and a different table link.
      if(pending){
        if(hasCheckoutOwnership(pending)&&pending.ownership!.staffUid===uid&&allowed(pending.ownership!.storeId)){
          return {storeId:pending.ownership!.storeId};
        }
        return {notice:'Choose an authorized store to review the previous checkout. Its original reference is protected.'};
      }
      const previousPayment=readLocalStorageJson<PosRazorpaySession | null>(POS_RAZORPAY_SESSION_STORAGE_KEY,null);
      if(isPosRazorpaySessionLocked(previousPayment)||previousPayment?.status==='PAYMENT_CAPTURED'){
        return {notice:'Choose an authorized store to review the previous payment before starting a new bill.'};
      }
      const savedTable=localStorage.getItem('coffee-bond-table-command:'+uid);
      if(savedTable!==null){
        const pendingTable=JSON.parse(savedTable);
        const storeId=pendingTable?.storeId??TABLE_STORE;
        if(typeof pendingTable?.opId==='string'&&(!pendingTable.staffUid||pendingTable.staffUid===uid)
          &&validPosStoreId(storeId)&&allowed(storeId)){
          const tableSessionId=typeof pendingTable.sessionId==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(pendingTable.sessionId)
            ? pendingTable.sessionId : undefined;
          return {storeId,tableSessionId};
        }
        return {notice:'Choose your store to review the previous table operation. Its original reference is protected.'};
      }
      if(tableTargetStore){
        if(validPosStoreId(tableTargetStore)&&allowed(tableTargetStore))return {storeId:tableTargetStore};
        if(tableRouteRequested)return {notice:'This table belongs to a store outside your current access.'};
      }
      const openStores=new Set(findStartupDraftStoreIds(uid));
      let timer: number | undefined;
      const journal=await Promise.race([
        readOfflineCashEntries(),
        new Promise<never>((_,reject)=>{timer=window.setTimeout(()=>reject(Error('Cash journal unavailable')),2500)}),
      ]).finally(()=>window.clearTimeout(timer));
      for(const entry of journal){
        if(entry.status!=='SYNCED'&&entry.payload?.uid===uid&&typeof entry.payload.storeId==='string')openStores.add(entry.payload.storeId);
      }
      if([...openStores].some(storeId=>!allowed(storeId)))return {notice:'Saved work belongs to a store outside your current access. Its records are kept.'};
      if(openStores.size===1)return {storeId:[...openStores][0]};
      if(openStores.size>1)return {notice:'Choose the store whose saved bill or table you want to resume.'};
      return {};
    };
    const applyWork=(work:Awaited<ReturnType<typeof inspectWork>>)=>{
      if(work.storeId){
        if(work.tableSessionId&&(tableTargetStore!==work.storeId||tableParams.get('tableSession')!==work.tableSessionId)){
          setTableParams({tableStore:work.storeId,tableSession:work.tableSessionId});
        }
        selectStartupStore(work.storeId);
        return true;
      }
      if(work.notice){setStartupNotice(work.notice);return true;}
      return false;
    };
    const resolve=async()=>{
      try{
        const protectedWork=await inspectWork();
        if(!canSelect())return;
        setStartupWorkChecked(true);
        if(applyWork(protectedWork))return;
        if(!posOnline && stores.length===1 && validPosStoreId(stores[0].id)){selectStartupStore(stores[0].id);return;}
        if(!storeRead.verified){
          setStartupNotice('Some store details could not be verified. Choose an authorized store to continue.');
          return;
        }
        const sole=soleAssignedPosStore(stores,staffProfile);
        if(sole){selectStartupStore(sole);return;}
        setStartupNotice('Checking for a nearby store…');
        locationRequest.current??=requestPosLocation();
        const position=await locationRequest.current;
        if(!canSelect())return;
        // A protected reference can appear in another tab while permission or GPS is pending.
        const latestWork=await inspectWork();
        if(!canSelect())return;
        if(applyWork(latestWork))return;
        const selected=nearbyPosStore(stores,position,storeRead.locations)??rememberedPosStore(uid,stores);
        if(selected)selectStartupStore(selected);
        else setStartupNotice('');
      }catch{
        if(canSelect()){
          setStartupWorkChecked(true);
          setStartupNotice('Saved POS activity could not be checked on this browser. Choose your store to continue.');
        }
      }
    };
    void resolve();
    return()=>{active=false};
  },[uid,posOnline,storeAccessKey,storeAccessReady,stores,storeRead.locations,storeRead.verified,tableTargetStore,tableRouteRequested,selectedStoreId]);

  useEffect(() => {
    // Explicit store/service changes may render before the router clears the
    // old query. Do not treat that retiring link as a new navigation request.
    if (localTableNavigation.current !== null) {
      if (localTableNavigation.current === tableParams.toString()) return;
      localTableNavigation.current = null;
    }
    if (!selectedStoreAuthorized || !tableTargetStore || !validPosStoreId(tableTargetStore)
      || !stores.some(store => store.id === tableTargetStore)) return;
    const changeStore = tableTargetStore !== selectedStoreId;
    const changeService = tableRouteRequested && orderType !== 'DINE_IN';
    if (!changeStore && !changeService) return;
    const originalSession = tableParams.get('tableSession');
    const returningToOriginal = !!table.pending && !!originalSession && !tableParams.get('table')
      && (table.pending.storeId ?? TABLE_STORE) === tableTargetStore
      && table.pending.sessionId === originalSession;
    if ((table.pending && !returningToOriginal) || table.busy || isSaving || razorpayPaymentLocked || hasPendingCheckoutGuard(checkoutAttemptRef.current) || (changeStore&&cart.length>0)) {
      setCheckoutError({message:'Reconcile the current operation before opening a table at another store. Its original reference is retained.'});
      return;
    }
    if (changeStore) setSelectedStoreId(tableTargetStore);
    if (tableRouteRequested) setOrderType('DINE_IN');
  }, [tableTargetStore,tableRouteRequested,tableParams,stores,selectedStoreId,selectedStoreAuthorized,orderType,table.pending,table.busy,isSaving,razorpayPaymentLocked,cart.length]);

  useEffect(() => {
    const refresh = (event?: StorageEvent) => {
      if (event && event.key !== CHECKOUT_ATTEMPT_STORAGE_KEY && event.key !== counterDraftKey) return;
      const stored = loadCheckoutAttempt();
      checkoutAttemptRef.current = stored;
      setPendingRecovery(stored ? { attempt: stored, resolution: { status: 'UNCERTAIN', reason: 'READ_FAILED' } } : null);
      if (event?.key === counterDraftKey) { setCounterDraftConflict(true); setRevalidationRequired(true); }
    };
    refresh();
    window.addEventListener('storage', refresh);
    return () => window.removeEventListener('storage', refresh);
  }, [counterDraftKey]);

  const lastReceiptKey=LAST_RECEIPT_STORAGE_KEY+':'+JSON.stringify([uid,selectedStoreId]);
  useEffect(()=>{
    let active=true;
    const scoped=uid && selectedStoreId ? readLocalStorageJson<ReceiptSnapshot|null>(lastReceiptKey,null):null;
    setLastReceipt(scoped);
    // Old saved receipts did not carry a trusted staff/store scope. Recover them
    // only after checking their original order, without exposing another till's receipt.
    const prior=!scoped && posOnline && uid && selectedStoreAuthorized
      ?readLocalStorageJson<ReceiptSnapshot|null>(LAST_RECEIPT_STORAGE_KEY,null):null;
    const orderId=prior?.order.sourceOrderId;
    if(prior && orderId && !orderId.includes('/'))void getDocFromServer(doc(db,'orders',orderId)).then(original=>{
      if(!active || auth.currentUser?.uid!==uid || !original.exists())return;
      const data=original.data();
      if(data.storeId===selectedStoreId && data.createdByUserId===uid && data.orderNumber===prior.order.orderNumber){
        writeLocalStorageJson(lastReceiptKey,prior);setLastReceipt(prior);
      }
    }).catch(()=>{});
    return()=>{active=false;};
  },[uid,selectedStoreId,selectedStoreAuthorized,lastReceiptKey,posOnline]);
  useEffect(() => {
    const updateHeld=(event:StorageEvent)=>{if(event.key===HELD_BILLS_STORAGE_KEY||event.key===null)setHeldBills(loadStoredHeldBills());};
    window.addEventListener('storage',updateHeld);
    setHeldBills(loadStoredHeldBills());
    setRecentItemIdsByStore(loadStoredRecentItems());
    return ()=>window.removeEventListener('storage',updateHeld);
  }, []);

  useEffect(() => {
    if (razorpaySession) writeLocalStorageJson(POS_RAZORPAY_SESSION_STORAGE_KEY, razorpaySession);
    else if (typeof window !== 'undefined') { try { window.localStorage.removeItem(POS_RAZORPAY_SESSION_STORAGE_KEY); } catch { /* optional local storage */ } }
  }, [razorpaySession]);

  useEffect(() => {
    if (!razorpaySession || !['CREATING', 'WAITING_FOR_PAYMENT', 'RECOVERING'].includes(razorpaySession.status)) return;
    const timer = window.setInterval(() => setRazorpayNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [razorpaySession]);

  useEffect(() => {
    return () => {
      void disposeComplimentaryPhoneVerification();
    };
  }, []);

  useEffect(() => {
    if (complimentaryResendSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setComplimentaryResendSeconds(current => Math.max(0, current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [complimentaryResendSeconds]);

  useEffect(() => {
    if (!complimentaryVerification) return;
    const timer = window.setInterval(() => setComplimentaryExpiryClock(current => current + 1), 1000);
    return () => window.clearInterval(timer);
  }, [complimentaryVerification]);

  useEffect(() => {
    if (!complimentaryVerification || !isComplimentaryVerificationExpired(complimentaryVerification)) return;
    setComplimentaryVerification(null);
    setComplimentaryOtpStatus('EXPIRED');
    setComplimentaryOtpMessage('Verification expired. Send a new OTP.');
  }, [complimentaryExpiryClock, complimentaryVerification]);

  useEffect(() => {
    setComplimentaryVerification(null);
    setComplimentaryConfirmationResult(null);
    setComplimentaryOtpCode('');
    setComplimentaryOtpStatus('IDLE');
    setComplimentaryOtpMessage(null);
    setComplimentaryResendSeconds(0);
    void disposeComplimentaryPhoneVerification();
  }, [selectedStoreId]);

  useEffect(() => {
    if (!loading && window.matchMedia('(min-width: 1280px)').matches) {
      const timer = window.setTimeout(() => table.enabled ? document.querySelector<HTMLInputElement>('.pos-bill-region [role=combobox]:not(:disabled)')?.focus() : searchInputRef.current?.focus(), 100);
      return () => window.clearTimeout(timer);
    }
  }, [loading, selectedStoreId, table.enabled]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!recallMenuRef.current) return;
      if (recallMenuRef.current.contains(event.target as Node)) return;
      setIsRecallMenuOpen(false);
    };

    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, []);

  useEffect(() => {
    if (orderType !== 'DINE_IN') {
      setTableNumberError(null);
      return;
    }
    if (tableNumber.trim()) {
      setTableNumberError(null);
    }
  }, [orderType, tableNumber]);

  useEffect(() => {
    if (heldBills.length === 0) {
      setIsRecallMenuOpen(false);
    }
  }, [heldBills.length]);

  const fetchMenuData = async (initial = true, isCurrent = () => true) => {
    if (initial) setLoading(true);
    try {
      const [fgSnap, addOnGroupSnap] = await loadPosMenuSources(db);
      if (!isCurrent()) return false;

      let total = 0;
      let activeCount = 0;
      let sellableCount = 0;
      let availableCount = 0;

      const mappedItems: (PosMenuItem & { itemType: string, bom: any[], finishedGoodCode: string })[] = [];

      fgSnap.docs.forEach(d => {
         const data = d.data();
         total++;

         if (!data.isActive) return;
         activeCount++;

         if (!data.isSellable) return;
         sellableCount++;

         if (data.isAvailable === false) return;
         availableCount++;

         mappedItems.push({
           id: data.code,
           tableProductId: d.id,
           name: data.displayName || data.name,
           code: data.code,
           ...finishedGoodTaxonomyFields(data),
           categorySortOrder: typeof data.categorySortOrder === 'number' ? data.categorySortOrder : null,
           subcategorySortOrder: typeof data.subcategorySortOrder === 'number' ? data.subcategorySortOrder : null,
           sortOrder: typeof data.sortOrder === 'number' ? data.sortOrder : null,
           aliases: Array.isArray(data.aliases) ? data.aliases : [],
           searchAliases: Array.isArray(data.searchAliases) ? data.searchAliases : [],
           sku: data.sku || '',
           description: data.description || '',
           price: data.salePrice || 0,
           taxRate: pickItemTaxRate(data),
           prepStation: normalizePrepStation(data.prepStation),
           isActive: data.isActive,
           availableStoreIds: data.availableStoreIds || [],
           itemType: data.itemType,
           bom: data.bom || [],
           finishedGoodCode: data.code,
           addOnGroupIds: Array.isArray(data.addOnGroupIds) ? data.addOnGroupIds : [],
           addOnOptionIdsByGroup: data.addOnOptionIdsByGroup || {},
           createdAt: data.createdAt,
           updatedAt: data.updatedAt
         } as any);
      });

      setMenuItems(mappedItems);
      setAddOnGroups(addOnGroupSnap.docs.map(groupDoc => ({
        id: groupDoc.id,
        ...(groupDoc.data() as Omit<AddOnGroup, 'id'>),
      })));
      setDebugCounts({ total, activeCount, sellableCount, availableCount, mappedCount: mappedItems.length });
      setCatalogueReady(true);return true;
    } catch (e: any) {
      if (!initial) throw e;
      console.error(e);setCatalogueReady(false);
      return false;
    } finally {
      if (initial) setLoading(false);
    }
  }

  const fetchTaxConfig = async () => {
    try {
      let defaultConfig: TaxConfig | null = null;
      let storeOverrides: Record<string, number> = {};

      for (const docId of TAX_SETTING_DOC_IDS) {
        const snap = await getDoc(doc(db, 'appSettings', docId));
        if (!snap.exists()) continue;

        const data = snap.data() as Record<string, unknown>;
        if (docId === GST_CONFIG_DOC_ID) {
          storeOverrides = normalizeStoreOverrides(data.storeOverrides);
        }

        const picked = pickTaxConfig(data, `appSettings/${docId}`, APP_TAX_RATE_KEYS);
        if (picked) {
          defaultConfig = picked;
          break;
        }
      }

      setAppGstConfig({
        defaultRate: defaultConfig?.rate || 0,
        defaultSource: defaultConfig?.source || 'No app GST fallback configured',
        storeOverrides,
      });
    } catch (error) {
      console.warn('Unable to load POS tax fallback config', error);
      setAppGstConfig({
        defaultRate: 0,
        defaultSource: 'GST fallback config unavailable',
        storeOverrides: {},
      });
    }
  };

  const recoverCheckoutStore = async (targetStoreId: string) => {
    const attempt = checkoutAttemptRef.current;
    const context = { ...checkoutContextRef.current };
    if (!attempt || !hasPendingCheckoutGuard(attempt) || !context.ready || context.saving || context.paymentPending
      || recoveryInFlightRef.current || recoveryBusy || !context.uid || auth.currentUser?.uid !== context.uid
      || targetStoreId === context.storeId || !stores.some(store => store.id === targetStoreId)
      || !sameCheckoutAttempt(loadCheckoutAttempt(), attempt) || !requireOnlineAction()) return;
    const generation = ++recoveryGenerationRef.current;
    recoveryInFlightRef.current = true;
    setRecoveryBusy(true);
    const endCriticalOperation = beginCriticalOperation();
    try {
      const savedDraft = window.localStorage.getItem(context.draftKey);
      // Navigation is allowed only when the server binds this exact pending reference
      // to the requested accessible store. This does not retire or retry a checkout.
      const result = await requestPendingCheckoutRecovery(attempt, targetStoreId);
      const resolution = await resolvePendingCheckoutStatus(attempt, result, targetStoreId);
      const current = checkoutContextRef.current;
      if (generation !== recoveryGenerationRef.current || auth.currentUser?.uid !== context.uid
        || current.uid !== context.uid || current.storeId !== context.storeId || current.draftKey !== context.draftKey
        || !current.ready || current.fingerprint !== context.fingerprint || current.saving || current.paymentPending
        || !sameCheckoutAttempt(checkoutAttemptRef.current, attempt)
        || !sameCheckoutAttempt(loadCheckoutAttempt(), attempt)) return;
      if (resolution.status === 'UNCERTAIN') {
        setCheckoutError({ message: 'The server could not verify this store for the previous checkout. Your basket and reference are kept. Ask an Admin to review the original store and payment outcome.' });
        return;
      }
      // Persist the current scoped draft before loading the original store's draft.
      // The global pending reference, held bills and offline journals stay intact.
      if (window.localStorage.getItem(context.draftKey) !== savedDraft) {
        setCheckoutError({ message: 'This basket changed in another window. The store, saved drafts and previous checkout reference are kept. Review the basket before checking again.' });
        return;
      }
      if (!writeLocalDraft(context.draftKey, { cart, orderType })) {
        setCheckoutError({ message: 'This browser could not preserve the current basket. The store and previous checkout reference are kept.' });
        return;
      }
      setPendingRecovery(null);
      setCheckoutError(null);
      setSelectedStoreId(targetStoreId);
    } catch (error) {
      if (generation === recoveryGenerationRef.current && auth.currentUser?.uid === context.uid
        && sameCheckoutAttempt(checkoutAttemptRef.current, attempt)) {
        setCheckoutError({ message: 'The original checkout store could not be verified. Your basket and reference are kept. Reconnect and check again.', supportReference: checkoutDiagnostic(error) });
      }
    } finally {
      recoveryInFlightRef.current = false;
      if (generation === recoveryGenerationRef.current) setRecoveryBusy(false);
      endCriticalOperation();
    }
  };

  const handleStoreChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    if (hasPendingCheckoutGuard(checkoutAttemptRef.current)) {
      if (e.target.value !== selectedStoreId) void recoverCheckoutStore(e.target.value);
      else void checkPendingCheckout(checkoutAttemptRef.current!);
      return;
    }
    if (razorpayPaymentLocked) {
      alert('Cancel the active Razorpay payment request before changing stores.');
      return;
    }
    const storeId = e.target.value;
    if (!storeAccessReady || !stores.some(store => store.id === storeId)) return;
    if (cart.length > 0 && !window.confirm("Changing store will clear your current cart. Proceed?")) return;
    if (cart.length > 0) setCart([]);
    setPendingAddOnItem(null);
    setEditingAddOnCartItem(null);
    setCheckoutError(null);
    setTableNumberError(null);
    setIsRecallMenuOpen(false);
    setCustomerName(''); setCustomerPhone(''); resetComplimentaryOtp();
    clearTableRoute();
    selectStartupStore(storeId);
    rememberPosStore(uid, storeId);
  };

  useEffect(() => {
    if (!selectedStoreId) return;
    const sourceId = stores.find(store => store.id === selectedStoreId)?.legalAndGstSourceStoreId;
    const subscriptions = [...new Set([selectedStoreId, sourceId].filter(Boolean))].map(id => onSnapshot(doc(db, 'stores', id!), snapshot => {
      if (snapshot.exists()) setStores(current => current.map(store => store.id === snapshot.id ? { ...store, ...snapshot.data() } as Store : store));
    }, () => setCheckoutError({ message: 'Unable to refresh store GST settings. Verify connectivity before checkout.' })));
    return () => subscriptions.forEach(unsubscribe => unsubscribe());
  }, [selectedStoreId, stores.find(store => store.id === selectedStoreId)?.legalAndGstSourceStoreId]);

  const selectedStoreTaxConfig = useMemo(() => !posOnline && offlineCash.snapshot
    ? {rate:0,mode:'ITEM_WISE' as const,source:'Signed per-item tax'} : resolveStoreTaxConfig(stores, selectedStoreId, appGstConfig),
    [posOnline,offlineCash.snapshot,stores,selectedStoreId,appGstConfig]);

  const availableMenuItems = useMemo(() => {
    return uniqueSortedPosMenuItems(
      menuItems.filter(item => item.isActive && item.availableStoreIds?.includes(selectedStoreId)),
      posMenuCategories,
    );
  }, [menuItems, posMenuCategories, selectedStoreId]);

  const classificationByItemId = useMemo(() => classifyMenuItems(availableMenuItems, posMenuCategories), [availableMenuItems, posMenuCategories]);

  const categoryItemCounts = useMemo(() => {
    return countMenuCategories(availableMenuItems, classificationByItemId);
  }, [availableMenuItems, classificationByItemId]);

  const unclassifiedItemCount = categoryItemCounts.get(NEEDS_CLASSIFICATION_CATEGORY.code) || 0;
  const navigationCategories = useMemo(
    () => posMenuNavigationCategories(posMenuCategories, unclassifiedItemCount),
    [posMenuCategories, unclassifiedItemCount],
  );

  const fastItems = useMemo(() => {
    return rankFastMenuItems(availableMenuItems);
  }, [availableMenuItems]);

  const topFeaturedItems = useMemo(() => {
    return quickPicksInRankOrder(
      availableMenuItems,
      [],
      fastItems,
      4,
    );
  }, [availableMenuItems, fastItems]);


  const selectedCategory = navigationCategories.find(category => category.code === selectedCategoryId) || null;

  useEffect(() => {
    const isValid = selectedCategoryId === 'ALL'
      || selectedCategoryId === 'QUICK_PICKS'
      || navigationCategories.some(category => category.code === selectedCategoryId);
    if (!isValid) setSelectedCategoryId('ALL');
  }, [navigationCategories, selectedCategoryId]);

  useEffect(() => {
    if (!selectedCategory || selectedCategory.subcategories.length === 0) {
      setSelectedSubcategoryId('ALL');
      return;
    }
    const isValid = selectedSubcategoryId === 'ALL'
      || selectedCategory.subcategories.some(subcategory => subcategory.code === selectedSubcategoryId);
    if (!isValid) setSelectedSubcategoryId('ALL');
  }, [selectedCategory, selectedSubcategoryId]);

  const filteredMenuItems = useMemo(() => {
    if (searchQuery.trim()) {
      return searchPosMenuItems(availableMenuItems, searchQuery, posMenuCategories);
    }
    return filterMenuCategory(availableMenuItems, classificationByItemId, selectedCategoryId, selectedSubcategoryId, topFeaturedItems);
  }, [
    availableMenuItems,
    classificationByItemId,
    posMenuCategories,
    searchQuery,
    selectedCategoryId,
    selectedSubcategoryId,
    topFeaturedItems,
  ]);

  const menuSections = useMemo(() => {
    return groupMenuSections(filteredMenuItems, classificationByItemId, searchQuery, selectedCategoryId, selectedSubcategoryId, selectedCategory);
  }, [
    classificationByItemId,
    filteredMenuItems,
    searchQuery,
    selectedCategory,
    selectedCategoryId,
    selectedSubcategoryId,
  ]);

  const rememberRecentItem = (itemId: string) => {
    if (!selectedStoreId || !itemId) return;

    setRecentItemIdsByStore(prev => {
      const currentStoreItems = prev[selectedStoreId] || [];
      const nextStoreItems = [itemId, ...currentStoreItems.filter(id => id !== itemId)].slice(0, RECENT_ITEMS_LIMIT);
      const next = { ...prev, [selectedStoreId]: nextStoreItems };
      writeLocalStorageJson(RECENT_ITEMS_STORAGE_KEY, next);
      return next;
    });
  };

  // --- Cart Operations ---
  const addOnSelectionKey = (addOns: AddOnSelection[] = []) => JSON.stringify(
    addOns.map(addOn => [addOn.groupId, addOn.optionId, addOn.quantity]).sort(),
  );

  const commitItemToCart = (item: any, selectedAddOns: AddOnSelection[], editingCartItemId?: string) => {
    if (razorpayPaymentLocked) return;
    setCheckoutError(null);
    const itemId = String(item?.id || item?.code || item?.finishedGoodCode || '').trim();
    const itemCode = String(item?.code || item?.finishedGoodCode || itemId).trim();
    const itemName = String(item?.name || itemCode || '').trim();
    const itemPrice = toFiniteNumber(item?.price);

    if (!itemId || !itemCode || !itemName || itemPrice === null || itemPrice < 0) {
      setCheckoutError({
        message: 'This item cannot be added because its billing setup is incomplete.',
        details: [
          `Name: ${item?.name || 'missing'}`,
          `Code: ${item?.code || item?.finishedGoodCode || 'missing'}`,
          `Price: ${item?.price ?? 'missing'}`,
          'Suggested action: ask an Admin or Store Manager to check Menu Management for this item.',
        ].join('\n'),
      });
      return;
    }

    rememberRecentItem(itemId);
    const canonicalAddOns = canonicalAddOnSelections(
      item.addOnGroupIds,
      item.addOnOptionIdsByGroup,
      addOnGroups,
      selectedAddOns,
      getItemTaxRate(item, selectedStoreTaxConfig),
    );
    const itemAddOnTotal = addOnTotal(canonicalAddOns);

    if(tableOrderMode){
      if(!table.active){setCheckoutError({message:'This table link requires authorised Dine In access to its original store.'});return;}
      table.addItem(item,canonicalAddOns);return;
    }

    setCart(prev => {
      if (editingCartItemId) {
        return prev.map(cartItem => cartItem.id === editingCartItemId ? {
          ...cartItem,
          addOns: canonicalAddOns,
          baseUnitPrice: itemPrice,
          addOnTotal: itemAddOnTotal,
          unitPriceWithAddOns: itemPrice + itemAddOnTotal,
        } : cartItem);
      }
      const selectedKey = addOnSelectionKey(canonicalAddOns);
      const existing = prev.find(ci => (
        ci.menuItemId === itemId
        && addOnSelectionKey(ci.addOns) === selectedKey
      ));
      if (existing) {
        return prev.map(ci => ci.id === existing.id ? { ...ci, quantity: ci.quantity + 1 } : ci);
      }
      return [...prev, {
        id: createSafeClientId('cart-item'),
        menuItemId: itemId,
        menuItemCode: itemCode,
        name: itemName,
        price: itemPrice,
        taxRate: item.taxRate,
        prepStation: normalizePrepStation(item.prepStation),
        quantity: 1,
        sourceSystem: posSource,
        itemType: item.itemType,
        finishedGoodCode: item.finishedGoodCode,
        bom: item.bom,
        addOns: canonicalAddOns,
        baseUnitPrice: itemPrice,
        addOnTotal: itemAddOnTotal,
        unitPriceWithAddOns: itemPrice + itemAddOnTotal,
      }];
    });
  };

  const addToCart = (item: any) => {
    if (razorpayPaymentLocked || isSaving || (tableOrderMode && !table.canEdit)) return;
    const groups = activeAddOnGroupsForProduct(
      item?.addOnGroupIds,
      item?.addOnOptionIdsByGroup,
      addOnGroups,
    );
    if (groups.length > 0) {
      setEditingAddOnCartItem(null);
      setPendingAddOnItem(item as MenuItem);
      return;
    }
    commitItemToCart(item, []);
  };

  const editCartItemAddOns = (cartItem: CartItem) => {
    if (razorpayPaymentLocked) return;
    const menuItem = menuItems.find(item => item.id === cartItem.menuItemId);
    if (!menuItem) return;
    const groups = activeAddOnGroupsForProduct(
      menuItem.addOnGroupIds,
      menuItem.addOnOptionIdsByGroup,
      addOnGroups,
    );
    if (groups.length === 0) return;
    setEditingAddOnCartItem(cartItem);
    setPendingAddOnItem(menuItem);
  };

  const updateQuantity = (cartItemId: string, delta: number) => {
    if (razorpayPaymentLocked) return;
    setCheckoutError(null);
    setCart(prev => prev.map(ci => {
      if (ci.id === cartItemId) {
        const newQty = Math.max(0, ci.quantity + delta);
        return { ...ci, quantity: newQty };
      }
      return ci;
    }).filter(ci => ci.quantity > 0));
  };

  const removeCartItem = (cartItemId: string) => {
    if (razorpayPaymentLocked) return;
    setCheckoutError(null);
    setCart(prev => prev.filter(ci => ci.id !== cartItemId));
  };

  const resetComplimentaryOtp = (status: ComplimentaryOtpStatus = 'IDLE', message: string | null = null) => {
    setComplimentaryVerification(null);
    setComplimentaryConfirmationResult(null);
    setComplimentaryOtpCode('');
    setComplimentaryOtpStatus(status);
    setComplimentaryOtpMessage(message);
    setComplimentaryResendSeconds(0);
    void disposeComplimentaryPhoneVerification();
  };

  const handleComplimentaryPhoneChange = (nextPhone: string) => {
    const normalized = nextPhone.replace(/[^0-9]/g, '').slice(0, 10);
    if (normalized !== customerPhone.trim()) {
      setComplimentaryVerification(current => retainVerificationForPhone(current, normalized));
      setComplimentaryConfirmationResult(null);
      setComplimentaryOtpCode('');
      setComplimentaryOtpStatus('IDLE');
      setComplimentaryOtpMessage(null);
      setComplimentaryResendSeconds(0);
      void disposeComplimentaryPhoneVerification();
    }
    setCustomerPhone(normalized);
  };

  const handleSendComplimentaryOtp = async () => {
    if (revalidationRequired || counterDraftLoaded!==counterDraftKey) {setCheckoutError({message:'Reconnect checks are incomplete. Nothing has been submitted.'});return;}
    if (!requireOnlineAction()) {
      setComplimentaryOtpStatus('ERROR');
      setComplimentaryOtpMessage(OFFLINE_ACTION_MESSAGE);
      return;
    }
    if (!selectedStoreId) {
      setComplimentaryOtpStatus('ERROR');
      setComplimentaryOtpMessage('Select a store before sending the OTP.');
      return;
    }
    if (!isValidIndianMobile(customerPhone)) {
      setComplimentaryOtpStatus('ERROR');
      setComplimentaryOtpMessage('Enter a valid Indian 10-digit mobile number.');
      return;
    }
    if (complimentaryResendSeconds > 0 || complimentaryOtpStatus === 'SENDING') return;

    setComplimentaryVerification(null);
    setComplimentaryConfirmationResult(null);
    setComplimentaryOtpCode('');
    setComplimentaryOtpStatus('SENDING');
    setComplimentaryOtpMessage('An SMS verification code is being sent to this number.');
    try {
      const confirmationResult = await sendComplimentaryPhoneOtp(customerPhone);
      setComplimentaryConfirmationResult(confirmationResult);
      setComplimentaryOtpStatus('CODE_SENT');
      setComplimentaryOtpMessage('Enter the 6-digit code sent by SMS.');
      setComplimentaryResendSeconds(COMPLIMENTARY_OTP_RESEND_SECONDS);
    } catch (error) {
      setComplimentaryOtpStatus('ERROR');
      setComplimentaryOtpMessage(complimentaryPhoneErrorMessage(error));
    }
  };

  const handleVerifyComplimentaryOtp = async () => {
    if (revalidationRequired || counterDraftLoaded!==counterDraftKey) {setCheckoutError({message:'Reconnect checks are incomplete. Nothing has been submitted.'});return;}
    if (!requireOnlineAction()) {
      setComplimentaryOtpStatus('ERROR');
      setComplimentaryOtpMessage(OFFLINE_ACTION_MESSAGE);
      return;
    }
    if (!complimentaryConfirmationResult) {
      setComplimentaryOtpStatus('ERROR');
      setComplimentaryOtpMessage('Send an OTP before verifying.');
      return;
    }
    if (!/^[0-9]{6}$/.test(complimentaryOtpCode)) {
      setComplimentaryOtpStatus('CODE_SENT');
      setComplimentaryOtpMessage('Enter the complete 6-digit OTP.');
      return;
    }

    setComplimentaryOtpStatus('VERIFYING');
    setComplimentaryOtpMessage('Verifying the customer phone securely...');
    try {
      const verification = await verifyComplimentaryPhoneOtp({
        confirmationResult: complimentaryConfirmationResult,
        code: complimentaryOtpCode,
        expectedPhone: customerPhone,
        storeId: selectedStoreId,
      });
      setComplimentaryVerification(verification);
      setComplimentaryConfirmationResult(null);
      setComplimentaryOtpCode('');
      setComplimentaryOtpStatus('VERIFIED');
      setComplimentaryOtpMessage('Customer phone verified.');
      setComplimentaryResendSeconds(0);
    } catch (error) {
      const message = complimentaryPhoneErrorMessage(error);
      const code = complimentaryPhoneErrorCode(error);
      const expired = code === 'auth/code-expired' || message.toLowerCase().includes('expired');
      const requiresResend = expired || code.startsWith('functions/');
      setComplimentaryOtpStatus(expired ? 'EXPIRED' : requiresResend ? 'ERROR' : 'CODE_SENT');
      setComplimentaryOtpMessage(message);
      if (requiresResend) setComplimentaryConfirmationResult(null);
    }
  };

  const completeSavedCheckout = async (
    attempt: CheckoutAttempt,
    resolution: PendingCheckoutResolution,
    checkedContext: typeof checkoutContextRef.current,
  ): Promise<boolean> => {
    if (!['COMMITTED', 'DISMISSED'].includes(resolution.status)) return false;
    try {
      return await withCheckoutMarkerLock(() => {
        const context = checkoutContextRef.current;
        if (counterDraftConflict || !verifiedCheckoutContext(attempt, resolution, context) || !context.ready || context.paymentPending
          || context.uid !== checkedContext.uid || context.storeId !== checkedContext.storeId || context.draftKey !== checkedContext.draftKey
          || context.reference !== checkedContext.reference || context.fingerprint !== checkedContext.fingerprint
          || !sameCheckoutAttempt(checkoutAttemptRef.current, attempt) || !sameCheckoutAttempt(loadCheckoutAttempt(), attempt)) return false;
        const rawDraft = window.localStorage.getItem(attempt.ownership!.draftKey);
        if (!rawDraft || stableJson(JSON.parse(rawDraft)) !== attempt.ownership!.reference) return false;
        // The immutable original owner's exact persisted basket is cleared before its guard.
        if (!writeLocalDraft(attempt.ownership!.draftKey, { cart: [], orderType: 'DINE_IN' })) return false;
        if (!sameCheckoutAttempt(loadCheckoutAttempt(), attempt)) return false;
        window.localStorage.removeItem(CHECKOUT_ATTEMPT_STORAGE_KEY);
        checkoutAttemptRef.current = null;
        clearCart(true);
        return true;
      });
    } catch { return false; }
  };

  const finishCommittedCheckout = async (attempt: CheckoutAttempt, context: typeof checkoutContextRef.current) => {
    try {
      const result = await requestPendingCheckoutRecovery(attempt, attempt.ownership?.storeId || context.storeId);
      const resolution = await resolvePendingCheckoutStatus(attempt, result, context.storeId);
      if (resolution.status === 'COMMITTED' && await completeSavedCheckout(attempt, resolution, context)) return true;
    } catch { /* The saved receipt can be shown while its unresolved local guard is retained. */ }
    setCheckoutError({ message: 'The sale is saved. Its original basket and checkout guard are retained because this account, basket, or acknowledgement could not be reconciled. Check previous checkout; do not charge again.' });
    return false;
  };

  const applyDismissedCheckout = async (
    attempt: CheckoutAttempt,
    resolution: Extract<PendingCheckoutResolution, { status: 'DISMISSED' }>,
    checkedContext: typeof checkoutContextRef.current,
  ): Promise<boolean> => {
    const cleared = await completeSavedCheckout(attempt, resolution, checkedContext);
    if (!cleared) setCheckoutError({ message: 'The retired reference does not match this original account and basket, or another window changed it. The checkout guard and basket remain protected.' });
    return cleared;
  };

  const checkPendingCheckout = async (attempt: CheckoutAttempt): Promise<PendingCheckoutResolution> => {
    if (recoveryInFlightRef.current) return { status: 'UNCERTAIN', reason: 'READ_FAILED' };
    const checkedContext = { ...checkoutContextRef.current };
    if (!checkedContext.ready || !checkedContext.uid || auth.currentUser?.uid !== checkedContext.uid
      || !sameCheckoutAttempt(checkoutAttemptRef.current, attempt)) return { status: 'UNCERTAIN', reason: 'READ_FAILED' };
    const generation = ++recoveryGenerationRef.current;
    recoveryInFlightRef.current = true;
    const endCriticalOperation = beginCriticalOperation();
    setRecoveryBusy(true);
    setPendingRecovery({ attempt, resolution: null });
    try {
      const result = await requestPendingCheckoutRecovery(attempt, checkedContext.storeId);
      const serverResolution = await resolvePendingCheckoutStatus(attempt, result, checkedContext.storeId);
      const resolution: PendingCheckoutResolution = ownsCheckoutContext(attempt, checkedContext) ? serverResolution : { status: 'UNCERTAIN', reason: 'ORDER_MISMATCH' };
      const context = checkoutContextRef.current;
      if (generation !== recoveryGenerationRef.current || auth.currentUser?.uid !== checkedContext.uid
        || context.uid !== checkedContext.uid || context.storeId !== checkedContext.storeId
        || !sameCheckoutAttempt(checkoutAttemptRef.current, attempt)) return { status: 'UNCERTAIN', reason: 'READ_FAILED' };
      setPendingRecovery({ attempt, resolution });
      setCheckoutError(null);
      if (resolution.status === 'DISMISSED') await applyDismissedCheckout(attempt, resolution, checkedContext);
      return resolution;
    } catch (error) {
      const resolution: PendingCheckoutResolution = { status: 'UNCERTAIN', reason: 'READ_FAILED' };
      if (generation === recoveryGenerationRef.current && auth.currentUser?.uid === checkedContext.uid
        && checkoutContextRef.current.storeId === checkedContext.storeId
        && sameCheckoutAttempt(checkoutAttemptRef.current, attempt)) {
        setPendingRecovery({ attempt, resolution });
        setCheckoutError({ message: 'The previous checkout could not be verified. Your basket and reference are kept. Reconnect and check again, or ask an Admin.', supportReference: checkoutDiagnostic(error) });
      }
      return resolution;
    } finally {
      recoveryInFlightRef.current = false;
      if (generation === recoveryGenerationRef.current) setRecoveryBusy(false);
      endCriticalOperation();
    }
  };

  const retirePendingCheckout = async (review: PendingCheckoutReview) => {
    if (staffProfile?.role !== 'ADMIN' || !pendingRecovery || pendingRecovery.resolution?.status !== 'NOT_SAVED'
      || recoveryInFlightRef.current || recoveryBusy || isSaving || razorpaySession || !requireOnlineAction()) return;
    const checkedContext = { ...checkoutContextRef.current };
    if (!checkedContext.ready || !checkedContext.uid || auth.currentUser?.uid !== checkedContext.uid) return;
    const attempt = pendingRecovery.attempt;
    if (!verifiedCheckoutContext(attempt, pendingRecovery.resolution, checkedContext)
      || !sameCheckoutAttempt(checkoutAttemptRef.current, attempt) || !sameCheckoutAttempt(loadCheckoutAttempt(), attempt)) return;
    const generation = ++recoveryGenerationRef.current;
    recoveryInFlightRef.current = true;
    const endCriticalOperation = beginCriticalOperation();
    setRecoveryBusy(true);
    setPendingRecovery({ attempt, resolution: null });
    setCheckoutError(null);
    try {
      const result = await requestPendingCheckoutRecovery(attempt, checkedContext.storeId, review);
      const serverResolution = await resolvePendingCheckoutStatus(attempt, result, checkedContext.storeId);
      const resolution: PendingCheckoutResolution = ownsCheckoutContext(attempt, checkedContext) ? serverResolution : { status: 'UNCERTAIN', reason: 'ORDER_MISMATCH' };
      if (generation !== recoveryGenerationRef.current || auth.currentUser?.uid !== checkedContext.uid
        || checkoutContextRef.current.uid !== checkedContext.uid || checkoutContextRef.current.storeId !== checkedContext.storeId
        || !sameCheckoutAttempt(checkoutAttemptRef.current, attempt)) return;
      setPendingRecovery({ attempt, resolution });
      if (resolution.status === 'DISMISSED') await applyDismissedCheckout(attempt, resolution, checkedContext);
      else setCheckoutError({ message: 'The server did not retire this reference. Your basket is kept. Check the original sale and payment outcome before continuing.' });
    } catch (error) {
      if (auth.currentUser?.uid === checkedContext.uid && checkoutContextRef.current.storeId === checkedContext.storeId
        && sameCheckoutAttempt(checkoutAttemptRef.current, attempt)) {
        setPendingRecovery({ attempt, resolution: { status: 'UNCERTAIN', reason: 'READ_FAILED' } });
        setCheckoutError({ message: 'Retirement could not be confirmed. Your basket and reference are kept. Check previous checkout to recover the server outcome; do not charge again.', supportReference: checkoutDiagnostic(error) });
      }
    } finally {
      recoveryInFlightRef.current = false;
      setRecoveryBusy(false);
      endCriticalOperation();
    }
  };

  useEffect(() => {
    const attempt = checkoutAttemptRef.current;
    if (hasPendingCheckoutGuard(attempt) && catalogueReady && checkoutContextRef.current.ready
      && auth.currentUser?.uid === staffProfile?.uid && !isSaving && !recoveryInFlightRef.current) {
      void checkPendingCheckout(attempt!);
    }
  }, [staffProfile?.uid, selectedStoreId, counterDraftLoaded, catalogueReady]);

  const viewPendingReceipt = async () => {
    if (!pendingRecovery || recoveryBusy || isSaving) return;
    const checkedUid = auth.currentUser?.uid;
    const { attempt } = pendingRecovery;
    const resolution = await checkPendingCheckout(attempt);
    if (resolution.status !== 'COMMITTED') return;
    try {
      const order = resolution.order as unknown as Order;
      const receiptStore = stores.find(store => store.id === order.storeId);
      if (!receiptStore) throw new Error('The saved order store is not available in this staff session.');
      const orderRef = doc(db, 'orders', attempt.orderId);
      const [items, payments] = await Promise.all([
        getDocsFromServer(collection(orderRef, 'items')),
        getDocsFromServer(collection(orderRef, 'payments')),
      ]);
      if (auth.currentUser?.uid !== checkedUid || checkoutAttemptRef.current?.orderId !== attempt.orderId) return;
      const receipt = buildReceiptSnapshot(order,
        items.docs.map(item => ({ id: item.id, ...item.data() } as OrderItem)),
        payments.docs.map(payment => ({ id: payment.id, ...payment.data() } as OrderPayment)), receiptStore);
      setReceiptViewTitle('Previously Saved Order');
      setReceiptView(receipt);
    } catch {
      setCheckoutError({ message: 'The earlier sale is saved, but its receipt could not be loaded. Check Running Orders or ask an Admin. Your basket is kept.' });
    }
  };

  const startSeparateBill = async () => {
    if (!pendingRecovery || recoveryBusy || isSaving || razorpaySession) return;
    const { attempt } = pendingRecovery;
    const checkedContext = { ...checkoutContextRef.current };
    if (!verifiedCheckoutContext(attempt, pendingRecovery.resolution, checkedContext)) return;
    const resolution = await checkPendingCheckout(attempt);
    if (resolution.status !== 'COMMITTED') return;
    if (!window.confirm('Finish the saved original checkout and clear its original basket? Do not collect payment again for this bill.')) return;
    if (!await completeSavedCheckout(attempt, resolution, checkedContext)) setCheckoutError({ message: 'The original account, basket, or reference changed. Your checkout guard is kept; check the original checkout again.' });
  };

  const retryOriginalReference = async () => {
    if (staffProfile?.role !== 'ADMIN' || !pendingRecovery || recoveryBusy || isSaving || razorpaySession) return;
    const { attempt } = pendingRecovery;
    const checkedContext = { ...checkoutContextRef.current };
    if (!verifiedCheckoutContext(attempt, pendingRecovery.resolution, checkedContext)) return;
    const resolution = await checkPendingCheckout(attempt);
    if (resolution.status !== 'NOT_SAVED' || !verifiedCheckoutContext(attempt, resolution, checkedContext)) return;
    if (!window.confirm('ADMIN CHECK REQUIRED: Confirm no payment was collected and no payment request is outstanding. Retry the unchanged original basket with the SAME sale reference. Cancel if any outcome is uncertain.')) return;
    const { payloadHash: previousHash, ...retainedAttempt } = attempt;
    const next: CheckoutAttempt = { ...retainedAttempt,
      previousPayloadHashes: [...new Set([...(attempt.previousPayloadHashes || []), previousHash].filter((hash): hash is string => Boolean(hash)))].slice(-10),
    };
    try {
      if (!ownsCheckoutContext(attempt, checkedContext) || checkoutContextRef.current.fingerprint !== checkedContext.fingerprint) return;
      await writeCheckoutAttempt(next, attempt);
      if (!sameCheckoutAttempt(checkoutAttemptRef.current, attempt)) return;
      checkoutAttemptRef.current = next;
      setPendingRecovery(null);
      setCheckoutError(null);
    } catch { setCheckoutError({ message: 'The original reference changed or could not be protected. Nothing was submitted; check the previous checkout.' }); }
  };

  const clearCart = (skipConfirm: boolean = false) => {
    // Generic cart actions never retire financial markers, including legacy/pre-authorization markers.
    const stored = loadCheckoutAttempt();
    if (checkoutAttemptRef.current || stored) {
      checkoutAttemptRef.current = stored || checkoutAttemptRef.current;
      if (checkoutAttemptRef.current) void checkPendingCheckout(checkoutAttemptRef.current);
      return;
    }
    if (razorpayPaymentLocked && skipConfirm !== true) {
      alert('Cancel the active Razorpay payment request before clearing the cart.');
      return;
    }
    if (skipConfirm === true || window.confirm("Clear the entire cart?")) {
      setCart([]);
      setPendingAddOnItem(null);
      setEditingAddOnCartItem(null);
      setCheckoutError(null);
      setIsRecallMenuOpen(false);
      setDiscountPercentStr('');
      setPaymentMethod('');
      setIsSplitPayment(false);
      setSplitPayments([]);
      setCustomerName('');
      setCustomerPhone('');
      setComplimentaryReason('');
      resetComplimentaryOtp();
      setTableNumber('');
      setTableNumberError(null);
      setOrderType('DINE_IN');
      checkoutAttemptRef.current = null;
      setPendingRecovery(null);
    }
  };

  const cartTotals = useMemo(() => {
    return calculateTotals(
      cart.map(item => ({
        price: item.baseUnitPrice ?? item.price,
        quantity: item.quantity,
        taxRate: item.taxRate,
        addOns: item.addOns,
      })),
      discountPercentStr,
      selectedStoreTaxConfig,
    );
  }, [cart, discountPercentStr, selectedStoreTaxConfig]);
  const isComplimentarySelected = !isSplitPayment && paymentMethod === 'COMPLIMENTARY';
  useEffect(() => {
    if (!isComplimentarySelected) return;
    const normalized = customerMobile(customerPhone).normalized;
    if (normalized && customerPhone !== normalized.slice(3)) handleComplimentaryPhoneChange(normalized.slice(3));
  }, [isComplimentarySelected]);
  const displayedCartTotals = useMemo(() => {
    return isComplimentarySelected ? buildComplimentaryTotals(cartTotals.subtotal) : cartTotals;
  }, [cartTotals, isComplimentarySelected]);

  const pendingOfflineSettlement = Boolean(checkoutAttemptRef.current || razorpaySession || table.pending || table.session?.paymentAttempt);
  const offlineSnapshot = offlineCash.snapshot;
  const canCoordinateOfflineCash = typeof navigator.locks?.request === 'function';
  const canReceiveOfflineCash = offlineCash.cashAvailable && !pendingOfflineSettlement
    && !recoveryBusy && !table.pendingLocalCash
    && canCoordinateOfflineCash;
  const counterCashItems = useMemo(() => {
    const quantities = new Map<string, number>();
    for (const line of cart) {
      const productId = menuItems.find(item => item.id === line.menuItemId)?.tableProductId || '';
      quantities.set(productId, (quantities.get(productId) || 0) + line.quantity);
    }
    return Array.from(quantities, ([productId, quantity]) => ({ productId, quantity }));
  }, [cart, menuItems]);
  const offlineCounterLinesMatch=Boolean(offlineSnapshot && cart.every(line=>{
    const product=menuItems.find(item=>item.id===line.menuItemId)?.tableProductId;
    const approved=offlineSnapshot.menu.find(item=>item.id===product)?.canonical;
    return approved && !line.addOns?.length && !approved.addOns?.length
      && Number(line.price)===Number(approved.baseUnitPrice) && Number(line.taxRate)===Number(approved.taxRate);
  }));
  const savedTable=offlineCash.tableRepository?.sessions.get(table.sessionId);
  const legacySettlement=offlineSnapshot && !offlineCash.tableRepository && offlineSnapshot.tables.find(item=>item.id===table.sessionId
    && item.tableId===table.session?.tableId && item.orderId===table.session?.orderId && item.version===table.session?.version);
  const cashTable = table.active && !table.session?.localConflict && !table.session?.paymentAttempt && (table.operationalReady || (offlineCash.cashAvailable && legacySettlement))
    && ['OCCUPIED','BILL_REQUESTED'].includes(table.session?.status) && table.session?.orderId
    ? (savedTable?.offlineEligible && savedTable.version===table.session.version ? savedTable :
      offlineSnapshot?.tables.find(item => item.id === table.sessionId && item.tableId === table.session.tableId
        && item.orderId === table.session.orderId && item.version === table.session.version)) : undefined;
  const cashUnavailable = (message: string) => <p role="status" className="mt-2 text-xs font-semibold text-amber-900">{message}</p>;
  const offlinePendingMessage = 'Check the previous checkout before receiving Cash. Its reference and payment status are protected.';

  const receiveOfflineCash = async (cashReceived: number, discount: number, forTable?: NonNullable<typeof cashTable>) => {
    if (offlineSaving.current || isSaving || !offlineSnapshot || !canReceiveOfflineCash || posOnline) return;
    const original = { ...checkoutContextRef.current };
    const lineIds = cart.map(line => line.id);
    offlineSaving.current = true;
    setIsSaving(true);
    setOfflineNotice('');
    const end = beginCriticalOperation();
    try {
      const entry = await withCheckoutMarkerLock(async () => {
        const current = checkoutContextRef.current;
        if (auth.currentUser?.uid !== original.uid || current.uid !== original.uid
          || current.storeId !== original.storeId || offlineSnapshot.storeId !== original.storeId
          || current.fingerprint !== original.fingerprint || offlineContext.current.posOnline) {
          throw Error('The connection or bill changed. Review the current bill before receiving Cash.');
        }
        if (loadCheckoutAttempt() || localStorage.getItem(POS_RAZORPAY_SESSION_STORAGE_KEY)
          || localStorage.getItem('coffee-bond-table-command:' + original.uid)) throw Error(offlinePendingMessage);
        if (forTable) {
          const existing = await cashCaptureForTable(original.storeId, forTable.id);
          if (existing) throw Error('Cash was already saved for this table. Check ' + existing + ' in the Cash journal.');
          const activeTable = offlineContext.current.table;
          const savedDraft = localStorage.getItem(draftKey(original.uid, original.storeId, forTable.id));
          const storedItems = savedDraft === null ? [] : JSON.parse(savedDraft).items;
          if (activeTable.sessionId !== forTable.id || activeTable.session?.version !== forTable.version
            || activeTable.pending || activeTable.busy || activeTable.locked || activeTable.draft.length
            || !Array.isArray(storedItems) || storedItems.length) {
            throw Error('The original table or its unsent items changed. Keep the table open for review.');
          }
          return saveCash(offlineSnapshot, [], discount, cashReceived, forTable);
        }
        if(!offlineCounterLinesMatch)throw Error('An item price, option or GST differs from the signed menu. Keep the basket for online review.');
        const storedDraft = localStorage.getItem(original.draftKey);
        if (!original.ready || !storedDraft || stableJson(JSON.parse(storedDraft)) !== original.reference) {
          throw Error('The saved basket changed in another window. Keep the basket and check before collecting Cash.');
        }
        const existing = await cashCaptureForBasket(original.storeId, lineIds);
        if (existing) throw Error('Cash was already saved for this basket. Check the original bill in the Cash journal.');
        if (localStorage.getItem(original.draftKey) !== storedDraft) throw Error('The saved basket changed in another window.');
        const saved = await saveCash(offlineSnapshot, counterCashItems, discount, cashReceived, undefined, lineIds);
        // The signed entry is durable even if the matching draft cannot be cleared.
        try {
          if (checkoutContextRef.current.fingerprint === original.fingerprint
            && checkoutContextRef.current.draftKey === original.draftKey
            && localStorage.getItem(original.draftKey) === storedDraft) {
            if (writeLocalDraft(original.draftKey, { cart: [], orderType: 'TAKEAWAY' })) {
              clearCart(true);
              setOrderType('TAKEAWAY');
            } else {
              setCounterStorageWarning(true);
              setCounterDraftConflict(true);
            }
          }
        } catch {
          setCounterStorageWarning(true);
          setCounterDraftConflict(true);
        }
        return saved;
      });
      setOfflineReceipt(entry);
      setOfflineNotice('Saved offline — pending sync.');
      void printSavedEntry(entry).then(result=>setOfflineNotice('Saved offline — pending sync. '+result.message));
      setIsMobileCartOpen(false);
      void offlineCash.refresh();
    } catch (error) {
      setOfflineNotice(error instanceof Error ? error.message : 'The Cash bill could not be verified. Review the journal before receiving Cash again.');
    } finally {
      offlineSaving.current = false;
      setIsSaving(false);
      end();
    }
  };

  const renderOfflineCashPayment = (discount: number, forTable?: NonNullable<typeof cashTable>) => {
    if (pendingOfflineSettlement) return cashUnavailable(offlinePendingMessage);
    if (table.pendingLocalCash) return null;
    if (!canReceiveOfflineCash || !offlineSnapshot) return cashUnavailable(offlineCash.unavailableReason || 'Offline billing is unavailable for this session. Your draft stays open.');
    if (tableOrderMode && (!forTable || table.draft.length || table.locked || table.busy)) {
      return cashUnavailable('Offline Cash requires an unchanged, approved open table with no unsent items.');
    }
    if (!tableOrderMode) {
      if (!cart.length) return null;
      if (orderType !== 'TAKEAWAY') return cashUnavailable('Offline counter Cash is available for takeaway. A running table keeps its own bill.');
      if (counterDraftConflict || counterDraftLoaded !== counterDraftKey || counterStorageWarning) return cashUnavailable('The saved basket must be verified before receiving Cash.');
      if (isComplimentarySelected || isSplitPayment || cart.length > 30 || !offlineCounterLinesMatch) {
        return cashUnavailable('This bill requires online checkout. Its items and payment selection are kept.');
      }
    }
    try {
      const { grandTotal } = offlineCashTotals(offlineSnapshot, forTable ? [] : counterCashItems, discount, forTable);
      if (!Number.isFinite(grandTotal) || grandTotal <= 0) return cashUnavailable('This bill requires online checkout.');
      if (!forTable && Math.round(grandTotal * 100) !== Math.round(cartTotals.grandTotal * 100)) {
        return cashUnavailable('The basket total differs from the approved offline menu. Reconnect to review this bill.');
      }
      return <>
        <PosOfflineCashPayment key={forTable ? forTable.id + ':' + forTable.version + ':' + discount : basketReference + ':' + discount}
          total={grandTotal} busy={isSaving} onSave={cash => void receiveOfflineCash(cash, discount, forTable)} />
        {offlineNotice && <p role="status" className="text-xs font-semibold text-amber-900">{offlineNotice}</p>}
      </>;
    } catch {
      return cashUnavailable('Review the items or discount. This bill must use the approved offline menu and limit.');
    }
  };
  const complimentaryValidationErrors = useMemo(() => validateComplimentaryCheckout({
    customerName,
    customerPhone,
    reason: complimentaryReason,
    verification: complimentaryVerification,
  }), [complimentaryExpiryClock, complimentaryReason, complimentaryVerification, customerName, customerPhone]);
  const canSubmitComplimentary = !isComplimentarySelected || complimentaryValidationErrors.length === 0;
  const complimentaryUiStatus = complimentaryOtpStatus === 'VERIFIED' && complimentaryVerification
    ? {
        label: 'Verified',
        className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
      }
    : complimentaryOtpStatus === 'EXPIRED'
      ? {
          label: 'Expired',
          className: 'border-red-200 bg-red-50 text-red-700',
        }
      : complimentaryOtpStatus === 'SENDING'
        || complimentaryOtpStatus === 'CODE_SENT'
        || complimentaryOtpStatus === 'VERIFYING'
        || (complimentaryOtpStatus === 'ERROR' && complimentaryConfirmationResult)
        ? {
            label: 'OTP sent',
            className: 'border-amber-200 bg-amber-50 text-amber-700',
          }
        : {
            label: 'Verification required',
            className: 'border-[#eadfd4] bg-[#f8f3ec] text-[#73594b]',
          };
  const complimentaryMaskedPhone = customerPhone.replace(/\D/g, '').slice(-4);

  const cartHasItemTaxRate = useMemo(() => {
    return cart.some(item => normalizeTaxRate(item.taxRate) > 0);
  }, [cart]);

  const cartIsMissingGstConfig = cart.length > 0 && selectedStoreTaxConfig.mode !== 'NO_GST' && !cartHasItemTaxRate && selectedStoreTaxConfig.rate <= 0;
  const maxDiscountPercent = getMaxDiscountPercent(staffProfile?.role);
  const discountExceedsLimit = cartTotals.discountPercent > maxDiscountPercent + 0.0001;
  const splitAllocatedAmount = useMemo(() => paymentRowsAllocated(splitPayments), [splitPayments]);
  const splitBalanceAmount = paymentBalance(displayedCartTotals.grandTotal, splitAllocatedAmount);
  const splitPaymentBalanced = paymentRowsAreBalanced(displayedCartTotals.grandTotal, splitAllocatedAmount);
  const cartItemCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const cartQuantityByItemId = useMemo(() => {
    const quantities = new Map<string, number>();
    if(tableOrderMode)table.draft.forEach(item=>quantities.set(item.parentProductCode,(quantities.get(item.parentProductCode)||0)+item.quantity));
    else cart.forEach(item => quantities.set(item.menuItemId, (quantities.get(item.menuItemId) || 0) + item.quantity));
    return quantities;
  }, [cart,tableOrderMode,table.draft]);
  const selectedStore = stores.find(store => store.id === selectedStoreId);
  const isSetupTestSale = selectedStore?.internalPosTestEnabled === true && selectedStore?.isActive !== true;
  const hasActivePosLaunchException = activePosLaunchException(selectedStore);
  const setupPaymentMethods: PaymentMethod[] = isSetupTestSale ? ['CASH'] : PAYMENT_METHODS;
  const selectedViewTitle = searchQuery.trim()
    ? 'Search Results'
    : selectedCategoryId === 'QUICK_PICKS'
      ? 'Quick Picks'
      : selectedCategoryId === 'ALL'
        ? 'All Items'
        : selectedCategory?.name || 'All Items';
  const selectedViewDescription = selectedCategoryId === 'QUICK_PICKS'
    ? 'Fast favourites for quick billing'
    : searchQuery.trim()
      ? `Matches across the full ${selectedStore?.name || 'store'} menu`
      : null;

  const dismissMobileKeyboard = () => {
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setIsSearchInputFocused(false);
  };

  const blurInputOnEnter = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const shouldDismissKeyboard = typeof window !== 'undefined'
      && window.matchMedia('(max-width: 1279px)').matches;
    if (event.key === 'Enter' && shouldDismissKeyboard) {
      event.stopPropagation();
      event.currentTarget.blur();
      setIsSearchInputFocused(false);
    }
  };

  const selectCategory = (categoryId: string) => {
    dismissMobileKeyboard();
    setSelectedCategoryId(categoryId);
    setSelectedSubcategoryId('ALL');
  };

  useEffect(() => {
    if (!isSetupTestSale) return;
    setIsSplitPayment(false);
    setSplitPayments([]);
    setPaymentMethod('CASH');
    resetComplimentaryOtp();
  }, [isSetupTestSale]);

  const coordinateHeldChange = (change:()=>void,held?:HeldBill) => {
    const original=checkoutContextRef.current;
    void withCheckoutMarkerLock(()=>{
      const current=checkoutContextRef.current;
      if(auth.currentUser?.uid!==original.uid || current.uid!==original.uid || current.storeId!==original.storeId
        || current.fingerprint!==original.fingerprint || !current.ready || current.saving || current.paymentPending || loadCheckoutAttempt()
        || localStorage.getItem(POS_RAZORPAY_SESSION_STORAGE_KEY) || localStorage.getItem('coffee-bond-table-command:'+original.uid))
        throw Error('The bill or a previous checkout changed. Review the original bill before changing a hold.');
      const local=localStorage.getItem(original.draftKey);
      if(!local || stableJson(JSON.parse(local))!==original.reference)
        throw Error('The saved basket changed in another window. Reopen the original basket.');
      if(held && !loadStoredHeldBills().some(b=>stableJson(b)===stableJson(held)))
        throw Error('This held bill changed in another window. Reopen the list.');
      change();
    }).catch(error=>setCheckoutError({message:error instanceof Error?error.message:'The held bill could not be checked.'}));
  };

  const persistHeldBills = (mutate:(saved:HeldBill[])=>HeldBill[]) => {
    try {
      const stored=JSON.parse(localStorage.getItem(HELD_BILLS_STORAGE_KEY)||'[]');
      if(!Array.isArray(stored))throw Error('Unreadable held bills.');
      const nextHeldBills=mutate(stored);
      window.localStorage.setItem(HELD_BILLS_STORAGE_KEY, JSON.stringify(nextHeldBills));
      setHeldBills(nextHeldBills);
      return true;
    } catch {
      setCheckoutError({message:'The held bill could not be saved. Keep the original basket open.'});
      return false;
    }
  };

  const prepareWhatsAppReceipt = async (): Promise<ReceiptSnapshot> => {
    const sourceOrderId = receiptView?.order.sourceOrderId;
    if (!sourceOrderId || sourceOrderId.includes('/')) throw new Error('Saved receipt unavailable.');
    const ref = doc(db, 'orders', sourceOrderId), saved = await getDocFromServer(ref);
    if (!saved.exists()) throw new Error('Saved receipt unavailable.');
    const order = { ...saved.data(), id: saved.id } as Order;
    const store = accessiblePosStores(stores, staffProfile).find(s => s.id === order.storeId);
    if (!store || order.orderNumber !== receiptView?.order.orderNumber || order.status !== 'COMPLETED') throw new Error('Saved receipt unavailable.');
    const [items, payments] = await Promise.all([getDocsFromServer(collection(ref, 'items')), getDocsFromServer(collection(ref, 'payments'))]);
    return buildReceiptSnapshot(order, items.docs.map(d => ({ ...d.data(), id: d.id } as OrderItem)), payments.docs.map(d => ({ ...d.data(), id: d.id } as OrderPayment)), store, true);
  };

  const openLastReceipt = () => {
    if (!lastReceipt) return;
    setReceiptViewTitle('Last Order Receipt');
    setReceiptView(lastReceipt);
  };

  const holdCurrentBill = () => {
    if (hasPendingCheckoutGuard(checkoutAttemptRef.current)) {
      void checkPendingCheckout(checkoutAttemptRef.current!);
      return;
    }
    if ((posOnline ? revalidationRequired : !offlineCash.sessionReady) || counterDraftLoaded!==counterDraftKey) {setCheckoutError({message:'Reconnect checks are incomplete. Nothing has been submitted.'});return;}
    if (posOnline && !requireOnlineAction()) return;
    const selectedStore = stores.find(s => s.id === selectedStoreId);
    const holdError = heldBillValidationError(cart.length, Boolean(selectedStore), razorpayPaymentLocked);
    if (holdError) {
      alert(holdError);
      return;
    }
    if (!selectedStore) return;

    const mobile = customerMobile(customerPhone);
    if (!isComplimentarySelected && mobile.error) { setCheckoutError({ message: mobile.error }); return; }

    const heldBill = createHeldBillSnapshot({
      id: 'held:'+JSON.stringify([uid,selectedStoreId,...cart.map(line=>line.id).sort()]), heldByUid:uid,
      storeId: selectedStore.id,
      storeName: selectedStore.name,
      orderType,
      tableNumber,
      customerName,
      customerPhone: isComplimentarySelected ? customerPhone : mobile.normalized || '',
      cart,
      discountPercentStr,
      isSplitPayment,
      splitPayments,
      heldAtIso: new Date().toISOString(),
    }, cartTotals.grandTotal);

    if (!persistHeldBills(saved=>[heldBill,...saved.filter(other=>other.id!==heldBill.id)])) return;
    if(!writeLocalDraft(counterDraftKey,{cart:[],orderType})){
      setCheckoutError({message:'The held bill was saved. The original draft could not be cleared. Review it before collecting Cash.'});
      setCounterStorageWarning(true);return;
    }
    setIsRecallMenuOpen(false);
    clearCart(true);
    setIsMobileCartOpen(false);
  };

  const recallHeldBill = (bill: HeldBill) => {
    if (hasPendingCheckoutGuard(checkoutAttemptRef.current)) {
      void checkPendingCheckout(checkoutAttemptRef.current!);
      return;
    }
    if(auth.currentUser?.uid!==uid || !heldBills.some(b=>b.id===bill.id)|| !loadStoredHeldBills().some(b=>b.id===bill.id && stableJson(b)===stableJson(bill)))return;
    if ((posOnline ? revalidationRequired : !offlineCash.sessionReady) || counterDraftLoaded!==counterDraftKey) {setCheckoutError({message:'Reconnect checks are incomplete. Nothing has been submitted.'});return;}
    if (posOnline && !requireOnlineAction()) return;
    if (razorpayPaymentLocked) return;
    if (!stores.some(store => store.id === bill.storeId)) {
      alert('This held bill belongs to a store that is not available for your account.');
      return;
    }

    if (cart.length > 0 && !window.confirm('Recall this held bill and replace the current cart?')) {
      return;
    }

    const draft = recallHeldBillDraft(bill);
    const destinationKey = draftKey(uid,bill.storeId,null);
    try {
      if (bill.storeId !== selectedStoreId) {
        const rawDestination = localStorage.getItem(destinationKey);
        const saved = rawDestination === null ? null : sanitizeDraft(JSON.parse(rawDestination));
        if (draftStatus(destinationKey)!=='saved'||(saved && (!Array.isArray(saved.cart)||saved.cart.length))) {
          setCheckoutError({message:'This store already has a saved basket. The held bill is still available.'});
          return;
        }
      }
      if(!writeLocalDraft(destinationKey,{cart:draft.cart,orderType:bill.orderType})){
        setCheckoutError({message:'The recalled basket could not be saved. The held bill is still available.'});
        return;
      }
    } catch {
      setCheckoutError({message:'The saved basket at the held bill’s store could not be checked. The held bill is still available.'});
      return;
    }
    setCounterDraftLoaded(destinationKey);
    clearTableRoute();
    selectStartupStore(bill.storeId);
    setOrderType(bill.orderType);
    setTableNumber(bill.tableNumber);
    setCustomerName(bill.customerName);
    setCustomerPhone(bill.customerPhone);
    setCart(draft.cart);
    setDiscountPercentStr(draft.discountPercentStr);
    setIsSplitPayment(draft.isSplitPayment);
    setSplitPayments(draft.splitPayments);
    setPaymentMethod('');
    setCheckoutError(null);
    setTableNumberError(draft.tableNumberError);
    setIsRecallMenuOpen(false);
    persistHeldBills(saved=>withoutHeldBill(saved, bill.id));
    setIsMobileCartOpen(true);
  };

  const deleteHeldBill = (bill: HeldBill) => {
    if(auth.currentUser?.uid!==uid || !heldBills.some(b=>b.id===bill.id))return;
    if ((posOnline ? revalidationRequired : !offlineCash.sessionReady) || counterDraftLoaded!==counterDraftKey) {setCheckoutError({message:'Reconnect checks are incomplete. Nothing has been submitted.'});return;}
    if (posOnline && !requireOnlineAction()) return;
    const label = heldBillDeleteLabel(bill);
    if (!window.confirm(`Delete held bill for ${label}?`)) return;
    setIsRecallMenuOpen(false);
    persistHeldBills(saved=>withoutHeldBill(saved, bill.id));
  };

  const setSplitPaymentMode = (enabled: boolean) => {
    if (razorpayPaymentLocked) return;
    setIsSplitPayment(enabled);
    setCheckoutError(null);

    if (enabled) {
      setPaymentMethod('');
      if (splitPayments.length === 0) {
        setSplitPayments([{
          id: createSafeClientId('split-payment'),
          method: 'CASH',
          amountStr: cartTotals.grandTotal > 0 ? cartTotals.grandTotal.toFixed(2) : '',
        }]);
      }
    } else {
      setSplitPayments([]);
    }
  };

  const updateSplitPayment = (id: string, changes: Partial<SplitPaymentRow>) => {
    setCheckoutError(null);
    setSplitPayments(prev => prev.map(payment => (
      payment.id === id ? { ...payment, ...changes } : payment
    )));
  };

  const addSplitPaymentRow = () => {
    const remaining = Math.max(0, splitBalanceAmount);
    setCheckoutError(null);
    setSplitPayments(prev => [
      ...prev,
      {
        id: createSafeClientId('split-payment'),
        method: 'UPI',
        amountStr: remaining > 0 ? remaining.toFixed(2) : '',
      },
    ]);
  };

  const removeSplitPaymentRow = (id: string) => {
    setCheckoutError(null);
    setSplitPayments(prev => prev.filter(payment => payment.id !== id));
  };

  const recoverCapturedRazorpayOrder = async (session: PosRazorpaySession) => {
    const idempotencyKey = session.orderId.startsWith('POS_')
      ? session.orderId.slice(4)
      : checkoutAttemptRef.current?.idempotencyKey || '';
    if (!idempotencyKey || !session.checkoutPayloadHash) {
      throw new Error('The captured payment is safe, but this receipt needs Admin recovery because its checkout key is unavailable.');
    }
    const previous = loadCheckoutAttempt();
    if (!previous || !ownsCheckoutContext(previous) || previous.orderId !== session.orderId || previous.idempotencyKey !== idempotencyKey) throw new Error('The captured checkout must remain protected in its original staff and basket context.');
    const attempt: CheckoutAttempt = { ...previous, payloadHash: session.checkoutPayloadHash };
    await writeCheckoutAttempt(attempt, previous);
    checkoutAttemptRef.current = attempt;
    const result = await loadExistingCheckoutResult(
      doc(db, 'orders', session.orderId),
      attempt,
      session.checkoutPayloadHash,
    );
    if (!result) throw new Error('Razorpay captured the payment, but the POS order is still being recovered. Retry status shortly.');
    const receiptStore = stores.find(store => store.id === result.savedOrder.storeId);
    if (!receiptStore) throw new Error('The completed order store is not available in this staff session.');
    const receipt = buildReceiptSnapshot(result.savedOrder, result.savedItems, result.savedPayments, receiptStore);
    setLastReceipt(receipt);
    writeLocalStorageJson(lastReceiptKey, receipt);
    setReceiptViewTitle('Razorpay Payment Captured');
    setReceiptView(receipt);
    setRazorpaySession(null);
    if (bindingMatchesCheckout(attempt)) await finishCommittedCheckout(attempt, { ...checkoutContextRef.current, paymentPending: false });
  };

  const refreshRazorpayStatus = async (manual = false) => {
    if (!razorpaySession || razorpayStatusInFlightRef.current) return;
    razorpayStatusInFlightRef.current = true;
    if (manual) setRazorpayActionLoading(true);
    try {
      const next = await getPosRazorpayStatus(razorpaySession.sessionId);
      setRazorpaySession(next);
      if (next.status === 'PAYMENT_CAPTURED') {
        await recoverCapturedRazorpayOrder(next);
      } else if (next.status === 'PAYMENT_REVIEW_REQUIRED') {
        setCheckoutError({
          message: 'Razorpay captured the payment, but this order needs Admin review.',
          details: next.failureMessage || next.failureCode || 'The POS order was not finalised.',
        });
      }
    } catch (error) {
      if (manual) setCheckoutError(buildCheckoutError(error));
    } finally {
      razorpayStatusInFlightRef.current = false;
      if (manual) setRazorpayActionLoading(false);
    }
  };

  const cancelRazorpayPayment = async () => {
    if (!razorpaySession || razorpayActionLoading) return;
    if (revalidationRequired || counterDraftLoaded!==counterDraftKey) {setCheckoutError({message:'Reconnect checks are incomplete. Nothing has been submitted.'});return;}
    if (!requireOnlineAction()) {
      setCheckoutError({ message: OFFLINE_ACTION_MESSAGE });
      return;
    }
    setRazorpayActionLoading(true);
    setCheckoutError(null);
    try {
      const next = await cancelPosRazorpaySession(razorpaySession.sessionId);
      setRazorpaySession(next);
      if (next.status === 'PAYMENT_CAPTURED') await recoverCapturedRazorpayOrder(next);
    } catch (error) {
      setCheckoutError(buildCheckoutError(error));
    } finally {
      setRazorpayActionLoading(false);
    }
  };

  const closeFinalRazorpaySession = () => {
    if (razorpayPaymentLocked) return;
    setRazorpaySession(null);
    // Closing a provider panel cannot retire a browser-wide checkout guard.
    if (checkoutAttemptRef.current) void checkPendingCheckout(checkoutAttemptRef.current);
  };

  useEffect(() => {
    if (!razorpaySession || !['CREATING', 'WAITING_FOR_PAYMENT', 'RECOVERING'].includes(razorpaySession.status)) return;
    void refreshRazorpayStatus(false);
    const timer = window.setInterval(() => void refreshRazorpayStatus(false), 5000);
    return () => window.clearInterval(timer);
  }, [razorpayPaymentLocked, razorpaySession?.sessionId, razorpaySession?.status]);

  const handleCheckout = async (paymentMethodOverride?: PaymentMethod) => {
    if(tableOrderMode){table.setError('Use Send new items and the table payment controls for this running table.');return;}
    if (isSaving || offlineSaving.current || recoveryBusy || recoveryInFlightRef.current) return;
    if (counterDraftConflict) { setCheckoutError({ message: 'This basket changed in another window. Reload to restore the protected saved basket before billing.' }); return; }
    const selectedPaymentMethod = !isSplitPayment && paymentMethodOverride ? paymentMethodOverride : paymentMethod;
    const isComplimentaryCheckout = !isSplitPayment && selectedPaymentMethod === 'COMPLIMENTARY';
    const mobile = customerMobile(customerPhone);
    if (!isComplimentaryCheckout && mobile.error) { setCheckoutError({ message: mobile.error }); return; }
    const normalizedBillMobile = isComplimentaryCheckout ? customerPhone.trim() : mobile.normalized || '';

    if (!staffProfile || !auth.currentUser) return;
    if (revalidationRequired || counterDraftLoaded!==counterDraftKey) {setCheckoutError({message:'Reconnect checks are incomplete. Nothing has been submitted.'});return;}
    if (!posOnline || !requireOnlineAction()) {
      setCheckoutError({ message: OFFLINE_ACTION_MESSAGE });
      return;
    }
    let retryAttempt: CheckoutAttempt | null = null;
    const storedAttempt = loadCheckoutAttempt();
    if (storedAttempt) {
      checkoutAttemptRef.current = storedAttempt;
      const outcome = await checkPendingCheckout(storedAttempt);
      if (outcome.status !== 'NOT_SAVED' || !verifiedCheckoutContext(storedAttempt, outcome)
        || staffProfile.role !== 'ADMIN' || storedAttempt.payloadHash || !storedAttempt.previousPayloadHashes?.length) {
        setCheckoutError({ message: 'The previous checkout remains protected. Recover its original sale or have the original Admin review the unchanged basket before retrying its original reference.' });
        return;
      }
      retryAttempt = storedAttempt;
    }
    const checkoutPreconditionError = checkoutPreconditionMessage(cart.length, selectedStoreId, isSplitPayment, selectedPaymentMethod, splitPayments.length);
    if (checkoutPreconditionError) return alert(checkoutPreconditionError);
    if (isSetupTestSale && (isSplitPayment || selectedPaymentMethod !== 'CASH')) {
      setCheckoutError({
        message: 'Setup-test orders must use Cash only.',
        details: 'Draft-store POS testing is isolated from Razorpay, UPI, Card, Split, Credit and Complimentary payments.',
      });
      return;
    }
    if (orderType === 'DINE_IN' && !tableNumber.trim()) {
      setTableNumberError('Table number is required for dine in orders.');
      return;
    }

    if (isComplimentaryCheckout) {
      const validationErrors = validateComplimentaryCheckout({
        customerName,
        customerPhone,
        reason: complimentaryReason,
        verification: complimentaryVerification,
      });
      if (validationErrors.length > 0) {
        setCheckoutError({
          message: validationErrors[0],
          details: validationErrors.join('\n'),
        });
        return;
      }
    }

    setTableNumberError(null);

    const checkoutOriginContext = { ...checkoutContextRef.current };
    const endCriticalOperation = beginCriticalOperation();
    setIsSaving(true);
    setCheckoutError(null);
    const checkoutWriteTrace: CheckoutWriteTrace[] = [];
    let checkoutRecoveryContext: {
      orderRef: ReturnType<typeof doc>;
      attempt: CheckoutAttempt;
      payloadHash: string;
      store: Store;
      context: typeof checkoutContextRef.current;
    } | null = null;
    const traceCheckoutWrite = (step: string, operation: CheckoutWriteTrace['operation'], path: string) => {
      const entry = { step, operation, path };
      checkoutWriteTrace.push(entry);
      if (import.meta.env.DEV) console.log('[CHECKOUT WRITE]', entry);
    };

    try {
      const selectedStore = stores.find(s => s.id === selectedStoreId);
      if (!selectedStore) throw new Error("Store not found");

      // Verify menu items exist and are still active/available, and compute true totals
      const browserValidatedCart = cart.map(item => {
        const liveItem = menuItems.find(mi => mi.id === item.menuItemId && mi.isActive && mi.availableStoreIds.includes(selectedStoreId));
        if (!liveItem) {
          throw new Error(`Menu item ${item.name} is no longer available at this store.`);
        }
        const canonicalAddOns = canonicalAddOnSelections(
          liveItem.addOnGroupIds,
          liveItem.addOnOptionIdsByGroup,
          addOnGroups,
          item.addOns,
          getItemTaxRate(liveItem, selectedStoreTaxConfig),
        );
        return { cartItem: item, liveItem, canonicalAddOns };
      });
      const freshAttempt = createCheckoutAttempt();
      let checkoutAttempt: CheckoutAttempt = retryAttempt || { ...freshAttempt, ownership: {
        version: 1, staffUid: checkoutOriginContext.uid, storeId: checkoutOriginContext.storeId,
        orderId: freshAttempt.orderId, draftKey: checkoutOriginContext.draftKey, reference: checkoutOriginContext.reference,
      } };
      if (!ownsCheckoutContext(checkoutAttempt, checkoutOriginContext)
        || checkoutContextRef.current.fingerprint !== checkoutOriginContext.fingerprint) throw new Error('The original checkout context changed. Nothing was submitted.');
      await writeCheckoutAttempt(checkoutAttempt, retryAttempt);
      checkoutAttemptRef.current = checkoutAttempt;

      const newOrderRef = doc(db, 'orders', checkoutAttempt.orderId);
      const lineOccurrenceCounts = new Map<string, number>();
      const lineIdentities = browserValidatedCart.map(({ cartItem, liveItem, canonicalAddOns }) => {
        const identity = cartLineIdentity(cartItem, liveItem, canonicalAddOns);
        const identityHash = shortHash(identity);
        const occurrence = (lineOccurrenceCounts.get(identityHash) || 0) + 1;
        lineOccurrenceCounts.set(identityHash, occurrence);
        return { identity, occurrence };
      });
      const orderLineRefs = lineIdentities.map(({ identity, occurrence }) => (
        doc(collection(newOrderRef, 'items'), deterministicOrderItemId(newOrderRef.id, identity, occurrence))
      ));
      if (!isSplitPayment && selectedPaymentMethod === 'RAZORPAY') {
        if (hasBoundCheckoutAttempt(checkoutAttempt) && !razorpaySession) {
          await checkPendingCheckout(checkoutAttempt);
          return;
        }
        const session = await createPosRazorpaySession({
          expectedGstRevision: storeGstTreatment(gstSourceStore(selectedStore, stores)).revision,
          storeId: selectedStore.id,
          checkoutIdempotencyKey: checkoutAttempt.idempotencyKey,
          paymentMethod: 'RAZORPAY',
          isSplitPayment: false,
          orderType,
          tableNumber: orderType === 'DINE_IN' ? tableNumber.trim() : null,
          customerName: customerName.trim(),
          customerPhone: normalizedBillMobile,
          discountPercent: clampDiscountPercent(discountPercentStr),
          items: browserValidatedCart.map(({ cartItem, liveItem, canonicalAddOns }, index) => ({
            orderItemId: orderLineRefs[index].id,
            parentProductId: liveItem.id,
            parentProductCode: liveItem.code,
            quantity: cartItem.quantity,
            selectedAddOns: selectedAddOnIds(canonicalAddOns),
          })),
        });
        const nextAttempt = { ...checkoutAttempt, payloadHash: session.checkoutPayloadHash };
        await writeCheckoutAttempt(nextAttempt, checkoutAttempt);
        checkoutAttempt = nextAttempt;
        checkoutAttemptRef.current = checkoutAttempt;
        setRazorpaySession(session);
        setIsMobileCartOpen(false);
        if (session.status === 'PAYMENT_CAPTURED') await recoverCapturedRazorpayOrder(session);
        return;
      }
      const posAddOnAuthorization = await authorizePosAddOns({
        storeId: selectedStore.id,
        orderId: newOrderRef.id,
        orderNumber: null,
        checkoutMode: isSetupTestSale ? 'SETUP_TEST' : 'STANDARD_POS',
        checkoutSource: 'POS',
        paymentMethod: isSplitPayment ? 'SPLIT' : selectedPaymentMethod,
        financialVersion: 3,
        checkoutContext: {
          version: 1, staffUid: checkoutOriginContext.uid, storeId: selectedStore.id,
          originalOrderId: checkoutAttempt.orderId, idempotencyKey: checkoutAttempt.idempotencyKey,
          basketIdentity: checkoutBasketIdentity(browserValidatedCart.map(({ cartItem, liveItem, canonicalAddOns }) => ({ menuItemId: liveItem.id, quantity: cartItem.quantity, addOns: canonicalAddOns })))!,
        },
        discountPercent: isComplimentaryCheckout ? 100 : Number(discountPercentStr) || 0,
        ...(isSplitPayment ? { splitPayments: splitPayments.map(row => ({ method: row.method, amount: normalizePaymentAmount(row.amountStr) })) } : {}),
        items: browserValidatedCart.map(({ cartItem, liveItem, canonicalAddOns }, index) => ({
          orderItemId: orderLineRefs[index].id,
          parentProductId: liveItem.id,
          parentProductCode: liveItem.code,
          quantity: cartItem.quantity,
          selectedAddOns: selectedAddOnIds(canonicalAddOns),
        })),
      });
      const serverBinding = (posAddOnAuthorization as typeof posAddOnAuthorization & { recoveryBinding?: CheckoutRecoveryBinding }).recoveryBinding;
      const bindingAttempt = { ...checkoutAttempt, recoveryBinding: serverBinding };
      if (!bindingMatchesCheckout(bindingAttempt) || serverBinding.authorizationId !== posAddOnAuthorization.authorizationId
        || checkoutBasketIdentity(Object.values(posAddOnAuthorization.canonicalItems).map(row => ({ menuItemId: row.parentProductId, quantity: row.quantity, addOns: row.addOns }))) !== serverBinding.basketIdentity
        || !ownsCheckoutContext(checkoutAttempt) || checkoutContextRef.current.fingerprint !== checkoutOriginContext.fingerprint) {
        throw new Error('The server checkout ownership or basket binding could not be verified. Keep the original reference.');
      }
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serverBinding.basketIdentity));
      const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      if (fingerprint !== serverBinding.basketFingerprint || (checkoutAttempt.recoveryBinding
        && (checkoutAttempt.recoveryBinding.basketIdentity !== serverBinding.basketIdentity
          || checkoutAttempt.recoveryBinding.basketFingerprint !== serverBinding.basketFingerprint
          || checkoutAttempt.recoveryBinding.sourceVersionHash !== serverBinding.sourceVersionHash))) {
        throw new Error('The original checkout basket or authorized source changed. Its reference remains protected.');
      }
      const boundAttempt = { ...checkoutAttempt, recoveryBinding: checkoutAttempt.recoveryBinding || serverBinding };
      await writeCheckoutAttempt(boundAttempt, checkoutAttempt);
      checkoutAttempt = boundAttempt;
      checkoutAttemptRef.current = checkoutAttempt;
      const validatedCart = browserValidatedCart.map(({ cartItem, liveItem }, index) => {
        const canonicalItem = posAddOnAuthorization.canonicalItems[orderLineRefs[index].id];
        if (
          !canonicalItem
          || canonicalItem.parentProductId !== liveItem.id
          || canonicalItem.parentProductCode !== liveItem.code
          || canonicalItem.quantity !== cartItem.quantity
        ) {
          throw new Error('The server returned an invalid add-on authorization. Refresh the menu and try again.');
        }
        return {
          cartItem,
          liveItem: {
            ...liveItem,
            price: canonicalItem.baseUnitPrice,
            taxRate: canonicalItem.taxRate,
          },
          canonicalAddOns: canonicalItem.addOns,
          components: canonicalItem.components || [],
        };
      });
      const trueTotals = calculateTotals(
        validatedCart.map(({ cartItem, liveItem, canonicalAddOns }) => ({
          price: liveItem.price,
          quantity: cartItem.quantity,
          taxRate: liveItem.taxRate,
          addOns: canonicalAddOns,
        })),
        discountPercentStr,
        selectedStoreTaxConfig,
      );
      const effectiveTotals = isComplimentaryCheckout
        ? buildComplimentaryTotals(trueTotals.subtotal)
        : trueTotals;
      const financials = posAddOnAuthorization.financials;
      if (!financials || financials.version !== 3) throw new Error('A current server financial authorization is required.');
      for (const field of ['subtotal', 'discountPercent', 'discountAmount', 'taxableAmount', 'taxTotal', 'grandTotal'] as const) {
        if (effectiveTotals[field] !== financials[field]) throw new Error('The menu or tax configuration changed. Review this bill before checkout.');
      }
      const trueSubtotal = financials.subtotal;
      const trueDiscount = financials.discountAmount;
      const trueDiscountPercent = financials.discountPercent;
      const trueTaxableAmount = financials.taxableAmount;
      const trueTaxTotal = financials.taxTotal;
      const trueGrandTotal = financials.grandTotal;
      const paymentRows: ReceiptPaymentSnapshot[] = financials.paymentIds.map(id => ({
        method: financials.payments[id].method as PaymentMethod,
        amount: financials.payments[id].amount,
      }));

      const requestPayloadHash = checkoutPayloadHash({
        storeId: selectedStore.id,
        orderType,
        tableNumber: orderType === 'DINE_IN' ? tableNumber.trim() : null,
        customerName: customerName.trim(),
        customerPhone: normalizedBillMobile,
        discountPercent: trueDiscountPercent,
        subtotal: trueSubtotal,
        taxTotal: trueTaxTotal,
        grandTotal: trueGrandTotal,
        commercialStatus: isComplimentaryCheckout ? 'COMPLIMENTARY' : 'SALE',
        payments: paymentRows,
        items: validatedCart.map(({ cartItem, liveItem, canonicalAddOns }, index) => ({
          orderItemId: orderLineRefs[index].id,
          productId: liveItem.id,
          productCode: liveItem.code,
          quantity: cartItem.quantity,
          unitPrice: liveItem.price,
          taxRate: liveItem.taxRate,
          addOns: canonicalAddOns,
        })),
      });
      if (checkoutAttempt.payloadHash && checkoutAttempt.payloadHash !== requestPayloadHash) {
        await checkPendingCheckout(checkoutAttempt);
        return;
      }
      const payloadAttempt = { ...checkoutAttempt, payloadHash: requestPayloadHash };
      await writeCheckoutAttempt(payloadAttempt, checkoutAttempt);
      checkoutAttempt = payloadAttempt;
      checkoutAttemptRef.current = checkoutAttempt;
      checkoutRecoveryContext = {
        orderRef: newOrderRef,
        attempt: checkoutAttempt,
        payloadHash: requestPayloadHash,
        store: selectedStore,
        context: checkoutOriginContext,
      };

      let existingBeforeTransaction: Awaited<ReturnType<typeof loadExistingCheckoutResult>> = null;
      try {
        existingBeforeTransaction = await loadExistingCheckoutResult(
          newOrderRef,
          checkoutAttempt,
          requestPayloadHash,
        );
      } catch (existingOrderError) {
        if (!canTreatCheckoutOrderReadAsMissing(existingOrderError, staffProfile.role)) {
          throw existingOrderError;
        }
      }
      if (existingBeforeTransaction) {
        const receipt = buildReceiptSnapshot(
          existingBeforeTransaction.savedOrder,
          existingBeforeTransaction.savedItems,
          existingBeforeTransaction.savedPayments,
          selectedStore,
        );
        setLastReceipt(receipt);
        writeLocalStorageJson(lastReceiptKey, receipt);
        setReceiptViewTitle('Order Recovered');
        setReceiptView(receipt);
        await finishCommittedCheckout(checkoutAttempt, checkoutOriginContext);
        return;
      }

      assertCounterContext(tableOrderMode);
      const transactionResult = await persistPosOrder({
        newOrderRef, checkoutAttempt, requestPayloadHash,
        customerNameFinal: customerName.trim() || null,
        phoneToSearch: normalizedBillMobile,
        trueGrandTotal, trueSubtotal, trueTaxTotal,
        trueTaxableAmount, trueDiscountPercent, trueDiscount,
        isComplimentaryCheckout, complimentaryReason, complimentaryVerification,
        posAddOnAuthorization, tableNumber, orderType,
      });

      const recoveredResult = transactionResult.existingOrderId
        ? await loadExistingCheckoutResult(newOrderRef, checkoutAttempt, requestPayloadHash)
        : null;
      if (transactionResult.existingOrderId && !recoveredResult) {
        throw new Error('Checkout recovery failed: the completed order could not be loaded.');
      }
      const { savedOrder, savedItems, savedPayments } = recoveredResult || transactionResult;

        if (import.meta.env.DEV) console.log(`[CHECKOUT] Success`);
      if (savedOrder.inventoryWarnings?.length) {
        console.warn('[CHECKOUT INVENTORY WARNINGS RECORDED]', savedOrder.inventoryWarnings);
      }

      // Show receipt
      const receipt = buildReceiptSnapshot(savedOrder, savedItems, savedPayments, selectedStore);
      setLastReceipt(receipt);
      writeLocalStorageJson(lastReceiptKey, receipt);
      setReceiptViewTitle('Order Saved');
      setReceiptView(receipt);
      await finishCommittedCheckout(checkoutAttempt, checkoutOriginContext);
    } catch (err: any) {
      if (String(err?.message || '').startsWith('Checkout retry conflict:') && hasPendingCheckoutGuard(checkoutAttemptRef.current)) {
        await checkPendingCheckout(checkoutAttemptRef.current!);
        return;
      }
      if (checkoutRecoveryContext && isCheckoutPermissionError(err)) {
        try {
          const recovered = await loadExistingCheckoutResult(
            checkoutRecoveryContext.orderRef,
            checkoutRecoveryContext.attempt,
            checkoutRecoveryContext.payloadHash,
          );
          if (recovered) {
            const receipt = buildReceiptSnapshot(
              recovered.savedOrder,
              recovered.savedItems,
              recovered.savedPayments,
              checkoutRecoveryContext.store,
            );
            setLastReceipt(receipt);
            writeLocalStorageJson(lastReceiptKey, receipt);
            setReceiptViewTitle('Order Recovered');
            setReceiptView(receipt);
            await finishCommittedCheckout(checkoutRecoveryContext.attempt, checkoutRecoveryContext.context);
            return;
          }
        } catch (recoveryError) {
          if (!isCheckoutPermissionError(recoveryError)) console.warn('[CHECKOUT RECOVERY FAILED]', checkoutDiagnostic(recoveryError) || 'RECOVERY_UNCONFIRMED');
        }
      }
      console.warn('[CHECKOUT FAILED]', checkoutDiagnostic(err) || 'CHECKOUT_UNCONFIRMED');
      setCheckoutError(buildCheckoutError(err));
    } finally {
      setIsSaving(false);
      endCriticalOperation();
    }
  };

  useEffect(() => {
    if (!selectedStoreAuthorized) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if(event.defaultPrevented || event.repeat || target?.closest('[role=dialog],[role=alertdialog]'))return;
      const tagName = target?.tagName || '';
      const isTyping = target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName);

      if (event.key === 'Escape') {
        if (receiptView) {
          event.preventDefault();
          setReceiptView(null);
          return;
        }
        if (isMobileCartOpen) {
          event.preventDefault();
          setIsMobileCartOpen(false);
          return;
        }
        if (document.activeElement === searchInputRef.current || searchQuery) {
          event.preventDefault();
          setSearchQuery('');
          searchInputRef.current?.blur();
        }
        return;
      }

      if (event.key === '/' && !isTyping) {
        event.preventDefault();
        if(table.enabled&&!fullMenuOpen)document.querySelector<HTMLInputElement>('.pos-bill-region [role=combobox]:not(:disabled)')?.focus();else searchInputRef.current?.focus();
        return;
      }

      if (event.key === 'Enter' && document.activeElement === searchInputRef.current && filteredMenuItems.length > 0 && searchQuery.trim()) {
        event.preventDefault();
        addToCart(filteredMenuItems[0]);
        setSearchQuery('');
        searchInputRef.current?.focus();
        return;
      }

      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !isTyping && cart.length > 0 && !isSaving && posOnline) {
        event.preventDefault();
        if (isSplitPayment) {
          void handleCheckout();
        } else {
          const method = paymentMethod || 'CASH';
          setPaymentMethod(method);
          void handleCheckout(method);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    cart.length,
    tableOrderMode, table.canEdit, table.sessionId, table.draft.length, table.enabled, fullMenuOpen,
    filteredMenuItems,
    isMobileCartOpen,
    isSaving,
    isSplitPayment,
    paymentMethod,
    posOnline,
    selectedStoreAuthorized,
    receiptView,
    searchQuery,
  ]);

  if ((loading && posOnline) || storeRead.key !== storeAccessKey) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={32} className="animate-spin text-[#5c4033]" />
      </div>
    );
  }

  if (storeRead.failed || stores.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-center text-neutral-500">
        <div>
          <SearchX size={48} className="mx-auto mb-4 opacity-50" />
          <h2 className="text-xl font-bold mb-2">{storeRead.failed ? 'Store access unavailable' : 'No Active Stores'}</h2>
          <p>{storeRead.failed ? 'Your stores could not be verified. Your saved references are kept.' : 'You do not have access to any active stores, or none exist in the system.'}</p>
        </div>
      </div>
    );
  }

  const receiptGst = receiptView ? receiptGstSplit(receiptView.order) : null;
  const connectionStatus = <PosOfflineStatus key={staffProfile?.uid + ':' + selectedStoreId}
    online={posOnline} cashAvailable={offlineCash.sessionReady && canCoordinateOfflineCash} tableReady={offlineCash.tableReady} lastSuccessfulSync={offlineCash.lastSuccessfulSync} excludedChoices={offlineCash.snapshot?.excluded?.length}
    pendingCheckout={pendingOfflineSettlement} entries={offlineCash.entries} syncing={offlineCash.syncing}
    onSync={() => void offlineCash.sync()}
    canReconcile={staffProfile?.role === 'ADMIN' || staffProfile?.role === 'STORE_MANAGER'}
    onReconcile={(entry, reason) => void offlineCash.reconcile(entry, reason)}
    prepare={offlineCash.canPrepare && canCoordinateOfflineCash ? { busy: offlineCash.preparing, onPrepare: () => void offlineCash.prepare() } : undefined}
    notice={offlineNotice || offlineCash.notice}
    reason={offlineCash.unavailableReason}
    storeId={selectedStoreId}
    receipt={offlineReceipt?.payload.uid === staffProfile?.uid && offlineReceipt.payload.storeId === selectedStoreId ? offlineReceipt : null}
    onCloseReceipt={() => setOfflineReceipt(null)} />;

  if (!selectedStoreAuthorized) {
    const hasActiveWorkspace = Boolean(cart.length || counterDraftConflict || table.active || tableRouteRequested
      || pendingOfflineSettlement || isSaving || recoveryBusy || offlineSaving.current || pendingAddOnItem
      || customerName || customerPhone || tableNumber);
    if (selectedStoreId && hasActiveWorkspace) return <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-md rounded-2xl border border-[#eadfd4] bg-white p-5 text-[#2d1c19]">
        <h2 className="text-lg font-black">Store access changed</h2>
        <p role="status" className="mt-2 text-sm">The current store could not be authorized. Your basket and recovery references are kept. Verify your store access before continuing.</p>
      </div>
    </div>;
    return <div className="flex flex-1 items-start justify-center bg-[#f5efe6] p-4 pt-12 sm:p-8 sm:pt-16">
      <section aria-labelledby="pos-store-startup" className="w-full max-w-md rounded-2xl border border-[#eadfd4] bg-white p-5 text-[#2d1c19] shadow-sm">
        <h2 id="pos-store-startup" className="text-xl font-black">Select your store</h2>
        <p role="status" className="mt-2 text-sm">{selectedStoreId ? 'Access to the previous store changed. Choose an authorized store to continue.'
          : startupNotice || (startupWorkChecked ? 'Choose an authorized store to open the POS.' : 'Checking for saved POS activity…')}</p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <select value="" disabled={!startupWorkChecked} aria-label="Select POS store" className="min-h-11 min-w-0 flex-1 rounded-xl border border-[#eadfd4] bg-[#fbf8f3] px-3 text-sm font-bold"
            onChange={event=>{
              const storeId=event.target.value;
              if(!stores.some(store=>store.id===storeId))return;
              if(tableTargetStore&&storeId!==tableTargetStore)clearTableRoute();
              selectStartupStore(storeId);
              if(!pendingOfflineSettlement)rememberPosStore(uid,storeId);
            }}>
            <option value="" disabled>Select your store</option>
            {stores.map(store=><option key={store.id} value={store.id}>{store.name}</option>)}
          </select>
          {connectionStatus}
        </div>
      </section>
    </div>;
  }

  return (
    <div data-menu-open={fullMenuOpen} className={`${table.enabled ? 'pos-table-workspace ' : ''}relative flex h-[100dvh] w-full min-w-0 max-w-full flex-none flex-col overflow-hidden bg-[#f5efe6] pb-[env(safe-area-inset-bottom)] lg:h-[calc(100dvh-92px)] lg:pb-0`}>
      <div className="pos-control-bar shrink-0 max-w-full relative z-40 overflow-visible border-b border-[#eadfd4] bg-white/95 px-3 py-1.5 shadow-sm backdrop-blur sm:px-4 sm:py-2">
          <div className="pos-control-row flex min-w-0 flex-col gap-1.5 md:flex-row md:flex-wrap md:items-center md:gap-2">
            <div className="pos-store-control flex w-full min-w-0 items-center gap-2 rounded-2xl border border-[#eadfd4] bg-[#fbf8f3] px-3 py-1.5 md:w-auto md:max-w-full">
              <StoreIcon size={15} className="shrink-0 text-[#5c4033]" />
              <select
                value={selectedStoreId}
                disabled={isSaving}
                onChange={e=>{
                  const storeId=e.target.value;
                  if(table.active&&!hasPendingCheckoutGuard(checkoutAttemptRef.current)&&!razorpayPaymentLocked){
                    table.requestLeave(()=>{
                      if(storeAccessRef.current!==storeAccessKey||!stores.some(store=>store.id===storeId))return;
                      clearTableRoute();
                      selectStartupStore(storeId);
                      rememberPosStore(uid,storeId);
                      setPendingAddOnItem(null);
                      setEditingAddOnCartItem(null);
                    });
                  }else handleStoreChange(e);
                }}
                className="w-full min-w-0 max-w-full bg-transparent text-sm font-black text-[#2d1c19] outline-none md:w-auto md:min-w-[180px] lg:min-w-[190px]"
                aria-label="Select POS store"
              >
                {stores.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.name}{s.internalPosTestEnabled === true && s.isActive !== true ? ' (Setup test)' : ''}
                  </option>
                ))}
              </select>
            </div>
            {!table.enabled && connectionStatus}
            {!posOnline && !table.enabled && orderType==='DINE_IN' && <span role="status" className="text-xs">Table service is unavailable offline for this store.</span>}

            {table.enabled && <label className="pos-order-control"><span className="sr-only">Order type</span><select aria-label="Order type" value={orderType} disabled={isSaving||razorpayPaymentLocked||!!table.pending} onChange={e=>changeOrderType(e.target.value as OrderType)}>{(['DINE_IN','TAKEAWAY','DELIVERY'] as OrderType[]).map(type=><option key={type} value={type}>{ORDER_TYPE_LABELS[type]}</option>)}</select></label>}
            {table.enabled && <TableSelector table={table} blocked={isSaving || razorpayPaymentLocked || hasPendingCheckoutGuard(checkoutAttemptRef.current)}/> }
            <div className={`pos-order-tabs ${table.enabled?'hidden':'grid'} w-full min-w-0 grid-cols-3 items-center rounded-2xl border border-[#eadfd4] bg-[#fbf8f3] p-1 md:flex md:w-auto`}>
              {(['DINE_IN', 'TAKEAWAY', 'DELIVERY'] as OrderType[]).map(type => (
                <button
                  key={type}
                  type="button"
                  disabled={isSaving}
                  onClick={() => {
                    if(type===orderType)return;
                    const change=()=>{clearTableRoute();setOrderType(type);setPendingAddOnItem(null);if(type!=='DINE_IN')setTableNumberError(null)};
                    if(table.active)table.requestLeave(change);else change();
                  }}
                  className={`min-h-[34px] min-w-0 rounded-xl px-2 text-xs font-black transition-all sm:px-3 sm:text-sm ${
                    orderType === type
                      ? 'bg-[#3e2723] text-white shadow-sm'
                      : 'text-neutral-600 hover:bg-white hover:text-[#2d1c19]'
                  }`}
                >
                  {ORDER_TYPE_LABELS[type]}
                </button>
              ))}
            </div>
            {isSetupTestSale && (
              <span className="rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-black uppercase text-amber-800">
                Setup test sale
              </span>
            )}
            {hasActivePosLaunchException && (
              <span className="rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-black uppercase text-amber-800">
                Provisional stock launch
              </span>
            )}

            <div className="pos-secondary-links flex w-full min-w-0 flex-wrap gap-2 md:w-auto">
              <Link
                to="/pos/running-orders"
                className="inline-flex min-h-[36px] min-w-0 flex-1 items-center justify-center rounded-2xl border border-[#3e2723]/15 bg-white px-3 text-sm font-black text-[#3e2723] transition hover:bg-[#fff8ed] md:flex-none"
              >
                Running Orders
              </Link>
              {isAdmin && (
                <Link
                  to="/admin/pos-readiness"
                  title={debugCounts ? `${debugCounts.mappedCount} menu items ready for POS checks` : 'Open POS readiness'}
                  className="inline-flex min-h-[36px] min-w-0 flex-1 items-center justify-center rounded-2xl border border-[#eadfd4] bg-[#fbf8f3] px-3 text-sm font-bold text-neutral-600 transition hover:bg-white hover:text-[#3e2723] md:flex-none"
                >
                  POS Readiness
                </Link>
              )}
            </div>
            <OnlineOrderSoundControl storeId={selectedStoreId} />
          </div>
          {table.enabled && <div className="mt-1.5">{connectionStatus}</div>}
      </div>

      {hasActivePosLaunchException && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs font-bold text-amber-900">
          Baked by Bond 51 staff POS is temporarily active while opening stock remains pending. Customer ordering stays disabled; complete physical opening stock as soon as possible.
        </div>
      )}

      <div className="pos-main-grid grid min-h-0 flex-1 grid-cols-1 overflow-hidden xl:grid-cols-[minmax(0,1fr)_420px]">
      {/* Menu Area */}
      <div ref={fullMenuRef} role={table.enabled&&fullMenuOpen?'dialog':undefined} aria-modal={table.enabled&&fullMenuOpen?true:undefined} aria-label={table.enabled&&fullMenuOpen?'Full authorised menu':undefined} className="pos-menu-region flex min-h-0 min-w-0 overflow-hidden border-b border-[#eadfd4] xl:border-b-0 xl:border-r" onKeyDown={e=>{if(!table.enabled||!fullMenuOpen)return;if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeFullMenu();}if(e.key==='Tab'){const fields=Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]')).filter(x=>x.getClientRects().length);const first=fields[0],last=fields.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}}}>
        {table.enabled&&<div className="pos-full-menu-heading"><h2>Full menu</h2><p>All items available to your store</p><button type="button" aria-label="Close full menu" onClick={closeFullMenu}><X size={22}/></button></div>}
        <aside className="hidden w-[192px] shrink-0 flex-col border-r border-[#eadfd4] bg-[#f8f3ec] xl:flex">
          <div className="border-b border-[#eadfd4] px-3 py-3">
            <p className="text-[10px] font-black uppercase tracking-[0.14em] text-[#8a6a58]">Menu</p>
          </div>
          <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2 custom-scrollbar" aria-label="POS menu categories">
            <button
              type="button"
              onClick={() => selectCategory('QUICK_PICKS')}
              className={`flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-xs font-black transition ${selectedCategoryId === 'QUICK_PICKS' ? 'bg-[#3e2723] text-white shadow-sm' : 'text-neutral-700 hover:bg-white'}`}
            >
              <Zap size={15} className="shrink-0" />
              <span className="min-w-0 flex-1">Quick Picks</span>
              <span className="text-[10px] opacity-70">{topFeaturedItems.length}</span>
            </button>
            <button
              type="button"
              onClick={() => selectCategory('ALL')}
              className={`flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-xs font-black transition ${selectedCategoryId === 'ALL' ? 'bg-[#3e2723] text-white shadow-sm' : 'text-neutral-700 hover:bg-white'}`}
            >
              <LayoutGrid size={15} className="shrink-0" />
              <span className="min-w-0 flex-1">All Items</span>
              <span className="text-[10px] opacity-70">{availableMenuItems.length}</span>
            </button>
            <div className="my-2 border-t border-[#e4d8cc]" />
            {navigationCategories.map(category => (
              <button
                key={category.code}
                type="button"
                onClick={() => selectCategory(category.code)}
                className={`flex w-full items-start gap-2 rounded-xl px-3 py-2.5 text-left text-xs font-black leading-snug transition ${
                  selectedCategoryId === category.code
                    ? 'bg-[#3e2723] text-white shadow-sm'
                    : category.code === NEEDS_CLASSIFICATION_CATEGORY.code
                      ? 'text-amber-800 hover:bg-amber-50'
                      : 'text-neutral-700 hover:bg-white'
                }`}
              >
                <span className="min-w-0 flex-1">{category.name}</span>
                <span className="mt-0.5 text-[10px] opacity-70">{categoryItemCounts.get(category.code) || 0}</span>
              </button>
            ))}
          </nav>
          {isAdmin && unclassifiedItemCount > 0 && (
            <div className="border-t border-amber-200 bg-amber-50 p-3 text-[10px] font-bold leading-relaxed text-amber-800">
              <span className="flex items-center gap-1.5 font-black"><AlertTriangle size={13} /> {unclassifiedItemCount} need classification</span>
              <span className="mt-1 block">Items remain visible and billable.</span>
            </div>
          )}
        </aside>

        <div className={`min-h-0 min-w-0 flex-1 overflow-y-auto px-3 pt-2 custom-scrollbar sm:px-4 sm:pt-3 lg:px-5 ${!table.enabled ? 'pb-28' : 'pb-3'} xl:pb-6`}>
          <div className="space-y-2.5 pb-3 xl:space-y-3 xl:pb-6">
            <div className="rounded-2xl border border-[#e8ddd2] bg-white p-2.5 shadow-[0_8px_20px_rgba(62,39,35,0.04)] sm:p-3">
              <div className="grid w-full min-w-0 grid-cols-1 gap-2 md:grid-cols-2 xl:hidden">
                <label className="space-y-1">
                  <span className="text-[10px] font-black uppercase tracking-[0.12em] text-neutral-500">Category</span>
                  <select
                    value={selectedCategoryId}
                    onChange={event => selectCategory(event.target.value)}
                    className="min-h-11 w-full rounded-xl border border-[#eadfd4] bg-[#fcfaf7] px-3 text-sm font-black text-[#2d1c19] outline-none focus:border-[#5c4033] focus:ring-2 focus:ring-[#5c4033]/10"
                  >
                    <option value="QUICK_PICKS">Quick Picks ({topFeaturedItems.length})</option>
                    <option value="ALL">All Items ({availableMenuItems.length})</option>
                    {navigationCategories.map(category => (
                      <option key={category.code} value={category.code}>
                        {category.name} ({categoryItemCounts.get(category.code) || 0})
                      </option>
                    ))}
                  </select>
                </label>
                {selectedCategory && selectedCategory.subcategories.length > 0 && (
                  <label className="space-y-1">
                    <span className="text-[10px] font-black uppercase tracking-[0.12em] text-neutral-500">Subcategory</span>
                    <select
                      value={selectedSubcategoryId}
                      onChange={event => setSelectedSubcategoryId(event.target.value)}
                      className="min-h-11 w-full rounded-xl border border-[#eadfd4] bg-[#fcfaf7] px-3 text-sm font-black text-[#2d1c19] outline-none focus:border-[#5c4033] focus:ring-2 focus:ring-[#5c4033]/10"
                    >
                      <option value="ALL">All</option>
                      {selectedCategory.subcategories.map(subcategory => (
                        <option key={subcategory.code} value={subcategory.code}>{subcategory.name}</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>

              <div className="relative mt-2 min-w-0 xl:mt-0">
                <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-neutral-400" />
                <input
                  ref={searchInputRef}
                  type="search"
                  placeholder="Search products or codes..."
                  value={searchQuery}
                  onChange={event => setSearchQuery(event.target.value)}
                  onFocus={() => setIsSearchInputFocused(true)}
                  onBlur={() => setIsSearchInputFocused(false)}
                  onKeyDown={blurInputOnEnter}
                  enterKeyHint="search"
                  className="min-h-[42px] w-full rounded-xl border border-[#eadfd4] bg-[#fcfaf7] pl-11 pr-10 text-sm font-semibold text-neutral-800 outline-none transition focus:border-[#5c4033] focus:ring-4 focus:ring-[#5c4033]/10"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => {
                      setSearchQuery('');
                      dismissMobileKeyboard();
                    }}
                    aria-label="Clear product search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-neutral-400 hover:bg-white hover:text-[#3e2723]"
                  >
                    <X size={15} />
                  </button>
                )}
              </div>
              {isSearchInputFocused && (
                <div className="mt-1.5 flex justify-end xl:hidden">
                  <button
                    type="button"
                    onMouseDown={event => event.preventDefault()}
                    onClick={dismissMobileKeyboard}
                    className="rounded-lg border border-[#eadfd4] bg-white px-2.5 py-1 text-[10px] font-black text-[#5c4033] shadow-sm"
                  >
                    Hide Keyboard
                  </button>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-end justify-between gap-2 px-1">
              <div className="min-w-0">
                <h2 className="text-lg font-black tracking-tight text-[#2d1c19]">{selectedViewTitle}</h2>
                {selectedViewDescription && <p className="text-[11px] font-semibold text-neutral-500">{selectedViewDescription}</p>}
              </div>
              <span className="rounded-full border border-[#eadfd4] bg-white px-2.5 py-1 text-[11px] font-black text-neutral-500">
                {filteredMenuItems.length} {filteredMenuItems.length === 1 ? 'item' : 'items'}
              </span>
            </div>

            {selectedCategory && selectedCategory.subcategories.length > 0 && !searchQuery.trim() && (
              <div className="hidden flex-wrap gap-2 xl:flex" aria-label={`${selectedCategory.name} subcategories`}>
                <button
                  type="button"
                  onClick={() => setSelectedSubcategoryId('ALL')}
                  className={`min-h-9 rounded-xl border px-3 text-xs font-black transition ${selectedSubcategoryId === 'ALL' ? 'border-[#3e2723] bg-[#3e2723] text-white' : 'border-[#eadfd4] bg-white text-neutral-600 hover:border-[#5c4033]/30'}`}
                >
                  All
                </button>
                {selectedCategory.subcategories.map(subcategory => (
                  <button
                    key={subcategory.code}
                    type="button"
                    onClick={() => setSelectedSubcategoryId(subcategory.code)}
                    className={`min-h-9 rounded-xl border px-3 text-xs font-black transition ${selectedSubcategoryId === subcategory.code ? 'border-[#3e2723] bg-[#3e2723] text-white' : 'border-[#eadfd4] bg-white text-neutral-600 hover:border-[#5c4033]/30'}`}
                  >
                    {subcategory.name}
                  </button>
                ))}
              </div>
            )}

            {isAdmin && unclassifiedItemCount > 0 && (
              <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-800 xl:hidden">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                {unclassifiedItemCount} active {unclassifiedItemCount === 1 ? 'item needs' : 'items need'} classification. They remain visible under Needs Classification.
              </div>
            )}

            <PopularItems data={popularity.data} loading={popularity.loading}
              quantityByItemId={cartQuantityByItemId}
              items={filteredMenuItems} onAddItem={item => { dismissMobileKeyboard(); if(table.enabled)closeFullMenu(); addToCart(item); }}/>
            <MenuGrid
              isMenuEmpty={menuItems.length === 0}
              isViewEmpty={filteredMenuItems.length === 0}
              menuSections={menuSections.map(section => ({ ...section, items: section.items.map(item => {
                        const classification = classificationByItemId.get(item.id)
                          || classifyPosMenuItemWithCategories(
                            item as MenuItem & Record<string, unknown>,
                            posMenuCategories,
                          );
                        const tone = menuTileTone(classification.category.code);
                        const quantityInCart = cartQuantityByItemId.get(item.id) || 0;
                        const showContext = Boolean(searchQuery.trim())
                          || selectedCategoryId === 'ALL'
                          || selectedCategoryId === 'QUICK_PICKS';
                        const breadcrumb = [classification.category.name, classification.subcategory?.name]
                          .filter(Boolean)
                          .join(' / ');

                return { item, classification, tone, quantityInCart, showContext, breadcrumb,
                  stationLabel: item.prepStation && item.prepStation !== 'NONE' ? prepStationLabel(item.prepStation) : '' };
              }) }))}
              onAddItem={item => { dismissMobileKeyboard(); if(table.enabled)closeFullMenu(); addToCart(item); }}
            />
          </div>
        </div>
      </div>

      {/* Right Area: Current Sale */}
      <div id="pos-current-sale" className={`pos-bill-region fixed inset-0 z-[100] flex h-[100dvh] w-full max-w-full shrink-0 transform flex-col overflow-hidden border-l border-[#eadfd4] bg-[#fcfaf7] shadow-2xl transition-transform duration-300 xl:static xl:z-20 xl:h-full xl:w-[420px] xl:translate-y-0 xl:shadow-none ${isMobileCartOpen ? 'translate-y-0' : 'translate-y-full xl:translate-y-0'}`}>
        <div
          className="pos-bill-scroll flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-3 custom-scrollbar sm:px-4 lg:px-4"
          style={isMobileCartOpen ? { paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' } : undefined}
        >
          {tableOrderMode ? <>{!table.active&&<p role="alert">This table requires authorized Dine In service and a saved or confirmed table configuration for this store.</p>}<TableOrderPanel key={table.sessionId || table.selected?.tableId || 'unselected'} table={table} offlinePayment={posOnline ? undefined : discount => renderOfflineCashPayment(discount, cashTable)} search={q=>searchPosMenuItems(availableMenuItems,q,posMenuCategories)} onAdd={addToCart} onViewMenu={openFullMenu} describeLine={line=>{
            const item=availableMenuItems.find(item=>(item as any).tableProductId===line.parentProductId&&item.code===line.parentProductCode);if(!item)return null;
            try{const addOns=canonicalAddOnSelections(item.addOnGroupIds,item.addOnOptionIdsByGroup,addOnGroups,line.selectedAddOns as AddOnSelection[],getItemTaxRate(item,selectedStoreTaxConfig));return {name:item.name,options:addOns.map(a=>a.quantity+' × '+a.optionName).join(', '),totals:calculateTotals([{price:item.price,quantity:line.quantity,taxRate:getItemTaxRate(item,selectedStoreTaxConfig),addOns}],'0',selectedStoreTaxConfig)};}catch{return null;}
          }}/></> : <>
          <div className="border-b border-[#eadfd4] pb-3">
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <h3 className="min-w-0 text-[15px] font-black tracking-tight text-[#2d1c19] sm:text-base">Current Sale</h3>
                  <p className="text-[11px] font-semibold text-neutral-500">
                    {[
                      ORDER_TYPE_LABELS[orderType],
                      `${cartItemCount} ${cartItemCount === 1 ? 'item' : 'items'}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-[#3e2723]">
                  <span className="text-[11px] font-semibold text-neutral-500">Payable</span>
                  <span className="break-all font-mono text-xl font-black">₹{displayedCartTotals.grandTotal.toFixed(2)}</span>
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {lastReceipt && (
                  <button
                    onClick={openLastReceipt}
                    className="rounded-full border border-[#eadfd4] bg-white px-3 py-1.5 text-[11px] font-black text-[#5c4033] transition-colors hover:bg-[#fff8ed]"
                  >
                    Last Order
                  </button>
                )}
                <button
                  type="button"
                  aria-label="Close current sale"
                  onClick={() => setIsMobileCartOpen(false)}
                  className="rounded-full bg-neutral-200 p-1.5 font-bold text-neutral-600 transition-colors hover:bg-neutral-300 xl:hidden"
                >
                  <X size={20} />
                </button>
              </div>
            </div>

            {(cart.length > 0 || heldBills.length > 0) && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  {cart.length > 0 && (
                    <button
                      onClick={()=>coordinateHeldChange(holdCurrentBill)}
                      className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] font-black text-amber-700 transition-colors hover:bg-amber-100"
                    >
                      Hold
                    </button>
                  )}

                  {heldBills.length > 0 && (
                    <div ref={recallMenuRef} className="relative">
                      <button
                        type="button"
                        onClick={() => setIsRecallMenuOpen(prev => !prev)}
                        aria-expanded={isRecallMenuOpen}
                        className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-black transition-colors ${
                          isRecallMenuOpen
                            ? 'border-[#5c4033]/30 bg-[#fff8ed] text-[#3e2723]'
                            : 'border-[#eadfd4] bg-white text-[#5c4033] hover:bg-[#fff8ed]'
                        }`}
                      >
                        <span>Recall</span>
                        <span className="inline-flex min-w-[20px] items-center justify-center rounded-full bg-[#f5efe7] px-1.5 py-0.5 text-[10px] font-black text-[#8a6a58]">
                          {heldBills.length}
                        </span>
                      </button>
                      {isRecallMenuOpen && (
                        <HeldBillsPanel heldBills={heldBills} recallHeldBill={bill=>coordinateHeldChange(()=>recallHeldBill(bill),bill)} deleteHeldBill={bill=>coordinateHeldChange(()=>deleteHeldBill(bill),bill)} />
                      )}
                    </div>
                  )}
                </div>

                {cart.length > 0 && (
                  <button
                    type="button"
                    onClick={() => clearCart()}
                    className="rounded-full border border-[#eadfd4] bg-white px-3 py-1.5 text-[11px] font-black text-neutral-500 transition-colors hover:bg-neutral-50 hover:text-neutral-700"
                  >
                    Clear
                  </button>
                )}
              </div>
            )}
          </div>

          {table.enabled?<BillItemEntry search={q=>searchPosMenuItems(availableMenuItems,q,posMenuCategories)} onAdd={addToCart} onViewMenu={openFullMenu} disabled={isSaving || razorpayPaymentLocked || hasPendingCheckoutGuard(checkoutAttemptRef.current)}/>:<InlineItemEntry search={q=>searchPosMenuItems(availableMenuItems,q,posMenuCategories)} onAdd={addToCart} disabled={isSaving || razorpayPaymentLocked || hasPendingCheckoutGuard(checkoutAttemptRef.current)}/>}
          {counterStorageWarning&&<p role="status">The draft could not be saved or restored from browser storage. Keep this page open; customer details are not cached.</p>}
          {revalidationRequired&&posOnline&&<p role="status">Reconnect checks pending · orders and table actions are locked. Local draft editing remains available.
            {checkoutError?.message===POS_REVALIDATION_MESSAGE&&<button type="button" className="ml-2 underline"
              onClick={()=>setRevalidationAttempt(attempt=>attempt+1)}>Retry connection checks</button>}
          </p>}
          <CartPanel
            cart={cart.map(item => ({ item,
              unitPrice: unitPriceWithAddOns(item.baseUnitPrice ?? item.price, item.addOns),
              lineTotal: unitPriceWithAddOns(item.baseUnitPrice ?? item.price, item.addOns) * item.quantity,
            }))}
            orderType={orderType} isComplimentarySelected={isComplimentarySelected}
            tableNumber={tableNumber} tableNumberError={tableNumberError}
            customerName={customerName} customerPhone={customerPhone}
            contactLocked={isSaving || razorpayPaymentLocked || hasPendingCheckoutGuard(checkoutAttemptRef.current)}
            QUICK_TABLE_CHIPS={QUICK_TABLE_CHIPS} editCartItemAddOns={editCartItemAddOns}
            onRemove={item => updateQuantity(item.id, -item.quantity)}
            onDecrease={item => updateQuantity(item.id, -1)}
            onIncrease={item => updateQuantity(item.id, 1)}
            onDuplicate={item => updateQuantity(item.id, item.quantity)}
            blurInputOnEnter={blurInputOnEnter}
            onTableNumberChange={value => { setTableNumber(value); if (value.trim()) setTableNumberError(null); }}
            onTableNumberBlur={() => {
              if (orderType === 'DINE_IN' && !tableNumber.trim()) setTableNumberError('Table number is required for dine in orders.');
            }}
            onTableChip={value => { setOrderType('DINE_IN'); setTableNumber(value); setTableNumberError(null); }}
            onTakeaway={() => { setOrderType('TAKEAWAY'); setTableNumber(''); setTableNumberError(null); }}
            onWalkIn={() => { setCustomerName('Walk-in'); setCustomerPhone(''); resetComplimentaryOtp(); }}
            setCustomerName={setCustomerName}
            onPhoneChange={value => { if (isSaving || razorpayPaymentLocked || hasPendingCheckoutGuard(checkoutAttemptRef.current)) return; isComplimentarySelected ? handleComplimentaryPhoneChange(value) : setCustomerPhone(value); }}
          />

          {pendingRecovery && <PendingCheckoutRecoveryPanel key={pendingRecovery.attempt.orderId}
            orderId={pendingRecovery.attempt.orderId}
            resolution={pendingRecovery.resolution}
            busy={recoveryBusy || isSaving}
            paymentPending={Boolean(razorpaySession)}
            canReviewAbsent={staffProfile?.role === 'ADMIN' && verifiedCheckoutContext(pendingRecovery.attempt, pendingRecovery.resolution)}
            canFinishSaved={verifiedCheckoutContext(pendingRecovery.attempt, pendingRecovery.resolution)}
            reviewContext={checkoutContextRef.current.fingerprint}
            onCheck={() => { if (!recoveryBusy && !isSaving) void checkPendingCheckout(pendingRecovery.attempt); }}
            onReceipt={() => { void viewPendingReceipt(); }}
            onSeparateBill={() => { void startSeparateBill(); }}
            onRetryOriginalReference={() => { void retryOriginalReference(); }}
            onRetire={review => { void retirePendingCheckout(review); }}
          />}

          {checkoutError && (
            <div className="mt-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900 shadow-sm">
              <div className="flex gap-3">
                <AlertCircle size={20} className="mt-0.5 shrink-0 text-red-600" />
                <div className="min-w-0">
                  <p className="font-black">Checkout needs attention</p>
                  <p className="mt-1 font-medium">{checkoutError.message}</p>
                  {checkoutError.supportReference && <p className="mt-2 break-all font-mono text-xs">{checkoutError.supportReference}</p>}
                  {canViewCheckoutDebug && checkoutError.blockers && checkoutError.blockers.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {checkoutError.blockers.map((blocker, index) => (
                        <div key={`${blocker.itemCode}-${blocker.componentCode || 'item'}-${index}`} className="min-w-0 overflow-hidden rounded-lg border border-red-100 bg-white p-3">
                          <div className="space-y-1">
                            <p className="text-[10px] font-black uppercase tracking-widest text-red-500">Item</p>
                            <p className="break-words font-black leading-snug text-red-800">{blocker.itemName}</p>
                            <span className="inline-flex max-w-full break-words rounded bg-red-100 px-2 py-0.5 font-mono text-[11px] whitespace-normal text-red-700">
                              {blocker.blockerType}
                            </span>
                          </div>
                          <div className="mt-3 space-y-2 text-xs text-red-900">
                            <div className="rounded-lg bg-red-50/70 p-2">
                              <p className="text-[10px] font-black uppercase tracking-widest text-red-500">Item code</p>
                              <p className="mt-0.5 break-words font-mono leading-relaxed whitespace-normal">{blocker.itemCode}</p>
                            </div>
                            <div className="rounded-lg bg-red-50/70 p-2">
                              <p className="text-[10px] font-black uppercase tracking-widest text-red-500">FG code</p>
                              <p className="mt-0.5 break-words font-mono leading-relaxed whitespace-normal">{blocker.finishedGoodCode || blocker.itemCode}</p>
                            </div>
                            <div className="rounded-lg bg-red-50/70 p-2">
                              <p className="text-[10px] font-black uppercase tracking-widest text-red-500">Component type/code</p>
                              <p className="mt-0.5 break-words font-mono leading-relaxed whitespace-normal">{blocker.componentType || 'ITEM'} / {blocker.componentCode || '-'}</p>
                            </div>
                            <div className="rounded-lg bg-red-50/70 p-2">
                              <p className="text-[10px] font-black uppercase tracking-widest text-red-500">Component name</p>
                              <p className="mt-0.5 break-words leading-relaxed whitespace-normal">{blocker.componentName || blocker.itemName}</p>
                            </div>
                            <div className="rounded-lg bg-red-50/70 p-2">
                              <p className="text-[10px] font-black uppercase tracking-widest text-red-500">Required quantity</p>
                              <p className="mt-0.5 break-words font-mono leading-relaxed whitespace-normal">{formatQuantity(blocker.requiredQuantity, blocker.unit)}</p>
                            </div>
                            <div className="rounded-lg bg-red-50/70 p-2">
                              <p className="text-[10px] font-black uppercase tracking-widest text-red-500">Available quantity</p>
                              <p className="mt-0.5 break-words font-mono leading-relaxed whitespace-normal">{formatQuantity(blocker.availableQuantity, blocker.unit)}</p>
                            </div>
                            <div className="rounded-lg bg-red-50/70 p-2">
                              <p className="text-[10px] font-black uppercase tracking-widest text-red-500">Store</p>
                              <p className="mt-0.5 break-words leading-relaxed whitespace-normal">{blocker.storeName}</p>
                            </div>
                            <div className="rounded-lg bg-red-50/70 p-2">
                              <p className="text-[10px] font-black uppercase tracking-widest text-red-500">confirmedZero</p>
                              <p className="mt-0.5 break-words font-mono leading-relaxed whitespace-normal">{blocker.confirmedZero === undefined ? 'n/a' : String(blocker.confirmedZero)}</p>
                            </div>
                          </div>
                          <div className="mt-3 rounded-lg border border-red-100 bg-red-50 p-3">
                            <p className="text-[10px] font-black uppercase tracking-widest text-red-500">Suggested admin action</p>
                            <p className="mt-1 break-words text-xs font-bold leading-relaxed whitespace-normal text-red-900">{blocker.suggestedAdminAction}</p>
                          </div>
                        </div>
                      ))}
                      <Link
                        to="/admin/pos-readiness"
                        className="inline-flex w-full items-center justify-center rounded-lg bg-red-700 px-3 py-2 text-xs font-black text-white hover:bg-red-800"
                      >
                        Open POS Readiness
                      </Link>
                    </div>
                  )}
                  {canViewCheckoutDebug && checkoutError.details && (
                    <details className="mt-3">
                      <summary className="cursor-pointer font-bold text-red-700">Technical debug details</summary>
                      <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg border border-red-100 bg-white/80 p-3 text-xs font-mono text-red-800">
                        {checkoutError.details}
                      </pre>
                    </details>
                  )}
                </div>
              </div>
            </div>
          )}

          {!isComplimentarySelected && (
            <div className="mt-2 space-y-0.5 border-t border-[#eadfd4] pt-2">
              <div className="flex items-center justify-between gap-2 text-[12px] font-medium text-neutral-500">
                <span>Subtotal</span>
                <span className="font-mono leading-none">₹{displayedCartTotals.subtotal.toFixed(2)}</span>
              </div>

              <div className="flex items-center justify-between gap-2 text-[12px] font-medium text-neutral-500">
                <span>Discount (%)</span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  value={discountPercentStr}
                  inputMode="decimal"
                  enterKeyHint="done"
                  onKeyDown={blurInputOnEnter}
                  onChange={e => setDiscountPercentStr(String(clampDiscountPercent(e.target.value)))}
                  disabled={razorpayPaymentLocked}
                  className="w-18 rounded-full border border-[#eadfd4] bg-white px-2.5 py-1 text-right font-mono text-[12px] outline-none focus:border-[#5c4033]"
                  placeholder="0"
                />
              </div>
              {discountExceedsLimit && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-2 py-1.5 text-[10px] font-bold leading-snug text-red-700">
                  Max discount for {staffProfile?.role || 'this role'}: {maxDiscountPercent}% · Current discount {cartTotals.discountPercent.toFixed(2)}% will be blocked
                </div>
              )}

              <div className="flex items-center justify-between gap-2 text-[12px] font-medium text-neutral-500">
                <span>Discount Amount</span>
                <span className="font-mono leading-none">-₹{displayedCartTotals.discountAmount.toFixed(2)}</span>
              </div>

              <div className="flex items-center justify-between gap-2 text-[12px] font-medium text-neutral-500">
                <span>Taxable Amount</span>
                <span className="font-mono leading-none">₹{displayedCartTotals.taxableAmount.toFixed(2)}</span>
              </div>

              <div className="flex items-center justify-between gap-2 text-[12px] font-medium text-neutral-500">
                <span>GST</span>
                <span className="font-mono leading-none">₹{displayedCartTotals.taxTotal.toFixed(2)}</span>
              </div>
              {canViewCheckoutDebug && cartIsMissingGstConfig && (
                <p className="rounded-lg border border-amber-100 bg-amber-50 px-2 py-1 text-[10px] font-bold leading-snug text-amber-700">
                  GST rate is not configured for this store/menu.
                </p>
              )}

              <div className="mt-1.5 flex items-end justify-between gap-2 border-t border-[#eadfd4] pt-1.5">
                <span className="shrink-0 text-[15px] font-black text-neutral-800">Total</span>
                <span className="break-all text-right font-mono text-[27px] font-black leading-none text-[#3e2723]">₹{displayedCartTotals.grandTotal.toFixed(2)}</span>
              </div>
            </div>
          )}

          {posOnline ? <PaymentPanel
            isSplitPayment={isSplitPayment} splitToggleDisabled={isSetupTestSale || razorpayPaymentLocked}
            razorpayPaymentLocked={razorpayPaymentLocked} setupPaymentMethods={setupPaymentMethods}
            paymentMethod={paymentMethod} splitPayments={splitPayments} SPLIT_PAYMENT_METHODS={SPLIT_PAYMENT_METHODS}
            singleSplitRow={splitPayments.length === 1} grandTotal={displayedCartTotals.grandTotal}
            splitAllocatedAmount={splitAllocatedAmount} splitBalanceAmount={splitBalanceAmount}
            splitPaymentBalanced={splitPaymentBalanced} setSplitPaymentMode={setSplitPaymentMode}
            onSelectMethod={method => {
              if (razorpayPaymentLocked) return;
              setPaymentMethod(method); setCheckoutError(null);
              if (method !== 'COMPLIMENTARY') resetComplimentaryOtp();
            }}
            updateSplitPayment={updateSplitPayment} removeSplitPaymentRow={removeSplitPaymentRow}
            addSplitPaymentRow={addSplitPaymentRow} blurInputOnEnter={blurInputOnEnter}
            singlePaymentDetails={<>
                {isSetupTestSale && (
                  <p className="text-[10px] font-bold text-amber-700">
                    Internal setup tests are Cash-only and excluded from commercial reports.
                  </p>
                )}
                {isComplimentarySelected && (
                  <section className="mt-3 rounded-2xl border border-[#eadfd4] bg-[#fffdf9] p-3 shadow-sm md:p-4" aria-labelledby="complimentary-order-title">
                    <div className="flex items-center justify-between gap-3">
                      <h3 id="complimentary-order-title" className="text-sm font-black text-[#2d1c19]">
                        Complimentary Order
                      </h3>
                      <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-black ${complimentaryUiStatus.className}`}>
                        {complimentaryUiStatus.label}
                      </span>
                    </div>

                    <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                      <label className="space-y-1.5">
                        <span className="text-[10px] font-black uppercase tracking-[0.12em] text-neutral-500">Customer name</span>
                        <input
                          type="text"
                          value={customerName}
                          enterKeyHint="done"
                          onKeyDown={blurInputOnEnter}
                          onChange={event => setCustomerName(event.target.value)}
                          placeholder="Customer name"
                          className="h-10 w-full rounded-xl border border-[#eadfd4] bg-white px-3 text-sm outline-none transition focus:border-[#8a6a58] focus:ring-2 focus:ring-[#8a6a58]/10"
                        />
                      </label>
                      <label className="space-y-1.5">
                        <span className="text-[10px] font-black uppercase tracking-[0.12em] text-neutral-500">Mobile number</span>
                        <input
                          type="tel"
                          inputMode="numeric"
                          enterKeyHint="done"
                          onKeyDown={blurInputOnEnter}
                          value={customerPhone}
                          onChange={event => handleComplimentaryPhoneChange(event.target.value)}
                          placeholder="10-digit mobile"
                          disabled={complimentaryOtpStatus === 'SENDING' || complimentaryOtpStatus === 'VERIFYING'}
                          className="h-10 w-full rounded-xl border border-[#eadfd4] bg-white px-3 text-sm outline-none transition focus:border-[#8a6a58] focus:ring-2 focus:ring-[#8a6a58]/10 disabled:bg-neutral-50"
                        />
                      </label>
                    </div>

                    <label className="mt-3 block space-y-1.5">
                      <span className="text-[10px] font-black uppercase tracking-[0.12em] text-neutral-500">Complimentary reason</span>
                      <textarea
                        value={complimentaryReason}
                        onChange={event => setComplimentaryReason(event.target.value)}
                        placeholder="Reason for complimentary order"
                        rows={2}
                        className="w-full resize-none rounded-xl border border-[#eadfd4] bg-white px-3 py-2 text-sm outline-none transition focus:border-[#8a6a58] focus:ring-2 focus:ring-[#8a6a58]/10"
                      />
                    </label>

                    <div className="mt-3 border-t border-[#eee4da] pt-3">
                      <div id={COMPLIMENTARY_RECAPTCHA_CONTAINER_ID} className="max-w-full overflow-hidden" />

                      {complimentaryOtpStatus === 'VERIFIED' && complimentaryVerification ? (
                        <div className="flex flex-col gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-emerald-800 md:flex-row md:items-center md:justify-between">
                          <div className="flex min-w-0 items-center gap-2">
                            <CheckCircle size={17} className="shrink-0" />
                            <div className="min-w-0">
                              <p className="text-xs font-black">Mobile verified</p>
                              <p className="text-[10px] font-semibold text-emerald-700">
                                ••••••{complimentaryMaskedPhone}
                              </p>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setCustomerPhone('');
                              resetComplimentaryOtp();
                            }}
                            className="self-start text-[10px] font-black text-emerald-800 underline decoration-emerald-300 underline-offset-2 md:self-auto"
                          >
                            Change number
                          </button>
                        </div>
                      ) : complimentaryOtpStatus === 'CODE_SENT' || complimentaryOtpStatus === 'VERIFYING' ? (
                        <div className="space-y-2.5">
                          <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
                            <input
                              type="text"
                              inputMode="numeric"
                              enterKeyHint="done"
                              onKeyDown={blurInputOnEnter}
                              autoComplete="one-time-code"
                              value={complimentaryOtpCode}
                              onChange={event => setComplimentaryOtpCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
                              placeholder="Enter 6-digit OTP"
                              disabled={complimentaryOtpStatus === 'VERIFYING'}
                              aria-label="Six-digit OTP"
                              className="h-10 min-w-0 rounded-xl border border-amber-200 bg-white px-3 text-sm tracking-[0.2em] outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-500/10"
                            />
                            <button
                              type="button"
                              onClick={() => void handleVerifyComplimentaryOtp()}
                              data-requires-online="true"
                              disabled={complimentaryOtpStatus === 'VERIFYING' || complimentaryOtpCode.length !== 6}
                              className="h-10 w-full rounded-xl bg-[#5c4033] px-4 text-xs font-black text-white transition hover:bg-[#3e2723] disabled:cursor-not-allowed disabled:bg-neutral-300 md:w-auto"
                            >
                              {complimentaryOtpStatus === 'VERIFYING' ? 'Verifying…' : 'Verify OTP'}
                            </button>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-bold">
                            <button
                              type="button"
                              onClick={() => void handleSendComplimentaryOtp()}
                              data-requires-online="true"
                              disabled={complimentaryOtpStatus === 'VERIFYING' || complimentaryResendSeconds > 0}
                              className="text-amber-800 underline decoration-amber-300 underline-offset-2 disabled:cursor-not-allowed disabled:text-neutral-400 disabled:no-underline"
                            >
                              {complimentaryResendSeconds > 0 ? `Resend in ${complimentaryResendSeconds}s` : 'Resend OTP'}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setCustomerPhone('');
                                resetComplimentaryOtp();
                              }}
                              disabled={complimentaryOtpStatus === 'VERIFYING'}
                              className="text-[#5c4033] underline decoration-[#d9c8b8] underline-offset-2 disabled:text-neutral-400"
                            >
                              Change number
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div>
                        <button
                          type="button"
                          onClick={() => void handleSendComplimentaryOtp()}
                          data-requires-online="true"
                          disabled={complimentaryOtpStatus === 'SENDING'}
                          className="h-10 w-full rounded-xl bg-[#5c4033] px-4 text-xs font-black text-white transition hover:bg-[#3e2723] disabled:cursor-not-allowed disabled:bg-neutral-300 md:w-auto"
                        >
                          {complimentaryOtpStatus === 'SENDING' ? 'Sending…' : 'Send OTP'}
                        </button>
                          <p className="mt-2 text-[10px] font-medium leading-relaxed text-neutral-500">
                            An SMS verification code will be sent to this number.
                          </p>
                        </div>
                      )}

                      {complimentaryOtpMessage && (complimentaryOtpStatus === 'ERROR' || complimentaryOtpStatus === 'EXPIRED') && (
                        <p className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[10px] font-bold text-red-700">
                          {complimentaryOtpMessage}
                        </p>
                      )}
                    </div>

                    <div className="mt-3 space-y-1.5 border-t border-[#eee4da] pt-3 text-[11px] font-medium text-neutral-600">
                      <div className="flex items-center justify-between gap-3">
                        <span>Menu Value</span>
                        <span className="font-mono text-neutral-800">₹{displayedCartTotals.subtotal.toFixed(2)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Complimentary Discount</span>
                        <span className="font-mono text-neutral-800">-₹{displayedCartTotals.discountAmount.toFixed(2)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Taxable Amount</span>
                        <span className="font-mono text-neutral-800">₹{displayedCartTotals.taxableAmount.toFixed(2)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>GST</span>
                        <span className="font-mono text-neutral-800">₹{displayedCartTotals.taxTotal.toFixed(2)}</span>
                      </div>
                      <div className="mt-2 flex items-end justify-between gap-3 border-t border-[#e4d6ca] pt-2">
                        <span className="text-sm font-black text-[#2d1c19]">Amount Payable</span>
                        <span className="font-mono text-2xl font-black leading-none text-[#3e2723]">₹{displayedCartTotals.grandTotal.toFixed(2)}</span>
                      </div>
                    </div>
                  </section>
                )}
            </>}
            checkoutAction={<button
              disabled={cart.length === 0 || isSaving || revalidationRequired || !canSubmitComplimentary || razorpayPaymentLocked || chargeRecoveryBlocked}
              className={`mt-0.5 w-full rounded-2xl py-2.5 text-sm font-black transition-all shadow-sm ${
                cart.length > 0 && !isSaving && canSubmitComplimentary && !razorpayPaymentLocked
                  ? 'border border-[#2d1c19] bg-[#3e2723] text-[#f9f5f0] hover:bg-[#2d1c19] hover:shadow-md active:scale-[0.99]'
                  : 'cursor-not-allowed border border-neutral-300 bg-neutral-200 text-neutral-400'
              }`}
              onClick={() => void handleCheckout()}
              data-requires-online="true"
            >
              {isSaving
                ? <Loader2 size={20} className="mx-auto animate-spin text-[#5c4033]" />
                : cart.length === 0
                  ? 'Cart Empty'
                  : isComplimentarySelected && !canSubmitComplimentary
                    ? 'Complimentary checkout unavailable'
                    : isComplimentarySelected
                      ? 'Save Complimentary Order'
                      : paymentMethod === 'RAZORPAY'
                        ? `Generate Razorpay Payment ₹${displayedCartTotals.grandTotal.toFixed(2)}`
                        : `Charge ₹${displayedCartTotals.grandTotal.toFixed(2)}`}
            </button>}
          /> : renderOfflineCashPayment(Number(discountPercentStr) || 0)}
          </>}
        </div>
      </div>
      </div>
      <TableDraftSwitch table={table}/>

      {pendingAddOnItem && (
        <div className="pos-add-on-overlay"><AddOnSelector
          productName={pendingAddOnItem.name}
          basePrice={Number(pendingAddOnItem.price) || 0}
          taxRate={getItemTaxRate(pendingAddOnItem, selectedStoreTaxConfig)}
          groups={activeAddOnGroupsForProduct(
            pendingAddOnItem.addOnGroupIds,
            pendingAddOnItem.addOnOptionIdsByGroup,
            addOnGroups,
          )}
          initialSelections={editingAddOnCartItem?.addOns}
          onCancel={() => {
            setPendingAddOnItem(null);
            setEditingAddOnCartItem(null);
          }}
          onConfirm={selections => {
            commitItemToCart(pendingAddOnItem, selections, editingAddOnCartItem?.id);
            setPendingAddOnItem(null);
            setEditingAddOnCartItem(null);
          }}
        /></div>
      )}

      {razorpaySession && (
        <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/55 p-0 backdrop-blur-[2px] sm:items-center sm:p-5">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="pos-razorpay-title"
            className="max-h-[94dvh] w-full overflow-y-auto rounded-t-2xl border border-neutral-200 bg-white p-5 shadow-2xl sm:max-w-md sm:rounded-2xl sm:p-6"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#8a6a58]">Verified in-store payment</p>
                <h2 id="pos-razorpay-title" className="mt-1 text-xl font-black text-[#2d1c19]">Razorpay Payment</h2>
              </div>
              {!razorpayPaymentLocked && (
                <button
                  type="button"
                  onClick={closeFinalRazorpaySession}
                  className="rounded-full border border-neutral-200 p-2 text-neutral-500 hover:bg-neutral-50"
                  aria-label="Close Razorpay payment"
                >
                  <X size={18} />
                </button>
              )}
            </div>

            <div className={`mt-4 rounded-xl border px-3 py-2 text-sm font-black ${
              razorpaySession.status === 'PAYMENT_CAPTURED'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : razorpaySession.status === 'FAILED' || razorpaySession.status === 'PAYMENT_REVIEW_REQUIRED'
                  ? 'border-red-200 bg-red-50 text-red-700'
                  : razorpaySession.status === 'EXPIRED' || razorpaySession.status === 'CANCELLED'
                    ? 'border-neutral-200 bg-neutral-50 text-neutral-700'
                    : 'border-amber-200 bg-amber-50 text-amber-800'
            }`}>
              {posRazorpayStatusLabel(razorpaySession.status)}
            </div>

            <div className="mt-5 text-center">
              <p className="text-xs font-black uppercase tracking-widest text-neutral-500">Exact amount</p>
              <p className="mt-1 font-mono text-4xl font-black text-[#3e2723]">₹{razorpaySession.amount.toFixed(2)}</p>
              <p className="mt-1 text-xs font-bold text-neutral-500">Full payment only · INR</p>
            </div>

            {['CREATING', 'WAITING_FOR_PAYMENT', 'RECOVERING'].includes(razorpaySession.status) && (
              <div className="mt-5">
                <div className="mx-auto flex min-h-[260px] w-full max-w-[280px] items-center justify-center rounded-xl border border-neutral-200 bg-white p-4">
                  {razorpaySession.qrImageUrl ? (
                    <img
                      src={razorpaySession.qrImageUrl}
                      alt="Razorpay payment QR"
                      className="h-auto max-h-[248px] w-full object-contain"
                    />
                  ) : razorpaySession.paymentUrl ? (
                    <QRCode
                      value={razorpaySession.paymentUrl}
                      size={248}
                      level="M"
                      className="h-auto w-full max-w-[248px]"
                      aria-label="Razorpay payment link QR"
                    />
                  ) : (
                    <Loader2 size={38} className="animate-spin text-[#5c4033]" />
                  )}
                </div>
                <div className="mt-3 flex items-center justify-center gap-2 text-xs font-bold text-neutral-600">
                  <span>Expires in</span>
                  <span className="rounded-full bg-neutral-100 px-2.5 py-1 font-mono text-neutral-900">{razorpayExpiryLabel}</span>
                </div>
              </div>
            )}

            {razorpaySession.paymentUrl && (
              <div className="mt-4 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => void navigator.clipboard.writeText(razorpaySession.paymentUrl!)}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-white px-3 text-xs font-black text-neutral-700 hover:bg-neutral-50"
                >
                  <Copy size={15} /> Copy link
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (navigator.share) {
                      void navigator.share({ title: 'Coffee Bond payment', url: razorpaySession.paymentUrl! });
                    } else {
                      window.open(razorpaySession.paymentUrl!, '_blank', 'noopener,noreferrer');
                    }
                  }}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-white px-3 text-xs font-black text-neutral-700 hover:bg-neutral-50"
                >
                  <ExternalLink size={15} /> Share / open
                </button>
              </div>
            )}

            {razorpaySession.failureMessage && (
              <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold leading-relaxed text-red-700">
                {razorpaySession.failureMessage}
              </p>
            )}

            <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {['CREATING', 'WAITING_FOR_PAYMENT', 'RECOVERING'].includes(razorpaySession.status) && (
                <>
                  <button
                    type="button"
                    onClick={() => void refreshRazorpayStatus(true)}
                    disabled={razorpayActionLoading}
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-[#5c4033] bg-white px-4 text-sm font-black text-[#5c4033] disabled:opacity-50"
                  >
                    <RefreshCw size={16} className={razorpayActionLoading ? 'animate-spin' : ''} />
                    Retry status
                  </button>
                  <button
                    type="button"
                    onClick={() => void cancelRazorpayPayment()}
                    data-requires-online="true"
                    disabled={razorpayActionLoading}
                    className="h-11 rounded-xl bg-neutral-900 px-4 text-sm font-black text-white disabled:opacity-50"
                  >
                    Cancel request
                  </button>
                </>
              )}
              {razorpaySession.status === 'FAILED' && (
                <button
                  type="button"
                  onClick={() => void handleCheckout('RAZORPAY')}
                  data-requires-online="true"
                  disabled={isSaving}
                  className="h-11 rounded-xl bg-[#3e2723] px-4 text-sm font-black text-white disabled:opacity-50 sm:col-span-2"
                >
                  Retry payment request
                </button>
              )}
              {['EXPIRED', 'CANCELLED'].includes(razorpaySession.status) && (
                <button
                  type="button"
                  onClick={closeFinalRazorpaySession}
                  className="h-11 rounded-xl bg-[#3e2723] px-4 text-sm font-black text-white sm:col-span-2"
                >
                  Return to cart
                </button>
              )}
            </div>

            <p className="mt-4 text-center text-[10px] font-semibold leading-relaxed text-neutral-500">
              The sale is created only after Coffee Bond verifies a captured payment directly with Razorpay.
            </p>
          </section>
        </div>
      )}

      {/* Sticky Mobile Cart Bar */}
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {tableOrderMode
          ? `Current table draft: ${table.draft.reduce((sum, item) => sum + item.quantity, 0)} unsent items.`
          : `Current Sale: ${cartItemCount} ${cartItemCount === 1 ? 'item' : 'items'}. Payable ₹${displayedCartTotals.grandTotal.toFixed(2)}.`}
      </p>
      {!isMobileCartOpen && !table.enabled && (
        <div className="fixed bottom-0 left-0 right-0 z-30 max-w-full border-t border-[#eadfd4] bg-white p-3 shadow-[0_-4px_15px_rgba(0,0,0,0.05)] pb-[calc(1rem+env(safe-area-inset-bottom))] sm:p-4 xl:hidden">
           <button type="button" aria-controls="pos-current-sale" onClick={() => setIsMobileCartOpen(true)} className="flex w-full items-center justify-between gap-3 rounded-2xl bg-[#3e2723] px-4 py-3.5 font-black text-white shadow-sm transition-colors hover:bg-[#2d1c19] sm:px-5">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm">{tableOrderMode ? table.context?.tableNo || 'View table' : 'Current Sale'}</span>
                <span className="rounded-xl bg-white/20 px-2.5 py-1 text-xs">{tableOrderMode ? table.draft.reduce((n,l)=>n+l.quantity,0)+' unsent' : cartItemCount+' items'}</span>
              </span>
	              <span className="min-w-0 truncate text-base sm:text-lg">{tableOrderMode && !table.session ? (table.sessionId ? 'Check table' : 'Not opened') : '₹'+(tableOrderMode ? table.session.outstanding : displayedCartTotals.grandTotal).toFixed(2)}</span>
           </button>
        </div>
      )}

      {receiptView && (
        <ReceiptModal key={receiptView.order.sourceOrderId || receiptView.order.orderNumber}
          receiptView={receiptView}
          receiptViewTitle={receiptViewTitle}
          receiptGst={receiptGst}
          showGstin={Boolean(receiptView.order.gstTreatmentSnapshot?.mode !== 'NO_GST' && receiptView.order.receiptLegalDetails?.gstRegistered && receiptView.order.receiptLegalDetails.gstin)}
          showState={Boolean(receiptView.order.gstTreatmentSnapshot?.mode !== 'NO_GST' && receiptView.order.receiptLegalDetails?.gstRegistered && receiptView.order.receiptLegalDetails.stateName)}
          prepareWhatsAppReceipt={receiptView.order.sourceOrderId ? prepareWhatsAppReceipt : undefined}
          printReceiptElement={printReceiptElement}
          onClose={() => setReceiptView(null)}
        />
      )}
    </div>
  );
}
