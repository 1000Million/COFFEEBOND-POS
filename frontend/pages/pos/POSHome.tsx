import React, { useState, useEffect, useMemo, useRef } from 'react';
import { collection, query, getDocs, where, runTransaction, doc, serverTimestamp, getDoc } from 'firebase/firestore';
import { Link } from 'react-router-dom';
import { auth, db } from '../../lib/firebase';
import { useAuth } from '../../contexts/AuthContext';
import { Store, MenuItem, CartItem, OrderType, PaymentMethod, Order, OrderItem, OrderPayment } from '../../types';
import { Loader2, Plus, Minus, Trash2, Search, Store as StoreIcon, User, Phone, MapPin, SearchX, Coffee, CheckCircle, Printer, AlertCircle, X } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

type CheckoutError = {
  message: string;
  details?: string;
  blockers?: CheckoutBlocker[];
};

type CheckoutBlockerType =
  | 'Missing stock record'
  | 'Zero stock'
  | 'confirmedZero false'
  | 'Missing BOM'
  | 'Missing prep/raw ingredient reference'
  | 'Insufficient stock';

type CheckoutBlocker = {
  itemName: string;
  itemCode: string;
  finishedGoodCode?: string;
  blockerType: CheckoutBlockerType;
  componentType?: string;
  componentCode?: string;
  componentName?: string;
  requiredQuantity?: number;
  availableQuantity?: number;
  unit?: string;
  confirmedZero?: boolean;
  storeName: string;
  storeId: string;
  suggestedAdminAction: string;
};

type StockSource = {
  itemName: string;
  itemCode: string;
  finishedGoodCode?: string;
  lineQuantity: number;
  componentType: string;
  componentCode: string;
  componentName: string;
  quantity: number;
  unit: string;
};

type RequiredStock = {
  id: string;
  name: string;
  unit: string;
  qty: number;
  type: string;
  code: string;
  sources: StockSource[];
};

type TaxConfig = {
  rate: number;
  source: string;
};

type AppGstConfig = {
  defaultRate: number;
  defaultSource: string;
  storeOverrides: Record<string, number>;
};

type TotalsInput = {
  price: number;
  quantity: number;
  taxRate?: number | null;
};

type CalculatedTotals = {
  subtotal: number;
  discountPercent: number;
  discountAmount: number;
  taxableAmount: number;
  taxTotal: number;
  grandTotal: number;
};

type ReceiptLineSnapshot = {
  itemName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
};

type ReceiptOrderSnapshot = {
  orderNumber: string;
  storeName: string;
  createdAtIso: string;
  createdByName: string;
  customerName: string | null;
  customerPhone: string | null;
  orderType: OrderType;
  tableNumber: string | null;
  subtotal: number;
  discountPercent: number;
  discountAmount: number;
  taxableAmount: number;
  gstTotal: number;
  grandTotal: number;
  paymentMethod: PaymentMethod;
  isSplitPayment: boolean;
  paymentStatus?: string | null;
};

type ReceiptPaymentSnapshot = {
  method: PaymentMethod;
  amount: number;
};

type ReceiptSnapshot = {
  order: ReceiptOrderSnapshot;
  items: ReceiptLineSnapshot[];
  payments: ReceiptPaymentSnapshot[];
};

type SplitPaymentRow = {
  id: string;
  method: PaymentMethod;
  amountStr: string;
};

type HeldBill = {
  id: string;
  storeId: string;
  storeName: string;
  orderType: OrderType;
  tableNumber: string;
  customerName: string;
  customerPhone: string;
  cart: CartItem[];
  discountPercentStr: string;
  isSplitPayment?: boolean;
  splitPayments?: SplitPaymentRow[];
  heldAtIso: string;
  itemCount: number;
  total: number;
};

class CheckoutBlockerError extends Error {
  blockers: CheckoutBlocker[];

  constructor(blockers: CheckoutBlocker[]) {
    super('Checkout blocked by stock/BOM readiness checks.');
    this.name = 'CheckoutBlockerError';
    this.blockers = blockers;
  }
}

const GST_CONFIG_DOC_ID = 'gstConfig';
const TAX_SETTING_DOC_IDS = [GST_CONFIG_DOC_ID, 'tax', 'taxSettings', 'posSettings', 'settings'];
const APP_TAX_RATE_KEYS = ['defaultGstRate', 'gstRate', 'taxRate', 'defaultTaxRate', 'defaultGSTPercent', 'gstPercent', 'taxPercent'];
const STORE_TAX_RATE_KEYS = ['gstRate', 'taxRate', 'defaultGstRate', 'defaultTaxRate', 'gstPercent', 'taxPercent'];
const ITEM_TAX_RATE_KEYS = ['taxRate', 'gstRate', 'taxPercent', 'gstPercent'];
const LAST_RECEIPT_STORAGE_KEY = 'coffeeBondPos:lastReceipt:v1';
const HELD_BILLS_STORAGE_KEY = 'coffeeBondPos:heldBills:v1';
const PAYMENT_TOLERANCE = 0.01;
const PAYMENT_METHODS: PaymentMethod[] = ['CASH', 'UPI', 'CARD', 'SWIGGY', 'ZOMATO', 'CREDIT', 'COMPLIMENTARY'];

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTaxRate(value: unknown): number {
  const parsed = toFiniteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : 0;
}

function pickTaxConfig(data: Record<string, unknown>, source: string, keys = APP_TAX_RATE_KEYS): TaxConfig | null {
  for (const key of keys) {
    const rate = normalizeTaxRate(data[key]);
    if (rate > 0) return { rate, source: `${source}.${key}` };
  }
  return null;
}

function normalizeStoreOverrides(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, number>>((acc, [key, rate]) => {
    const normalizedRate = normalizeTaxRate(rate);
    if (normalizedRate > 0) acc[key] = normalizedRate;
    return acc;
  }, {});
}

function pickItemTaxRate(item: Record<string, unknown>): number {
  const picked = pickTaxConfig(item, 'item', ITEM_TAX_RATE_KEYS);
  return picked?.rate || 0;
}

function getItemTaxRate(item: { taxRate?: number | null }, fallbackTaxRate: number): number {
  const itemTax = normalizeTaxRate(item.taxRate);
  return itemTax > 0 ? itemTax : fallbackTaxRate;
}

function clampDiscountPercent(value: unknown): number {
  const parsed = toFiniteNumber(value) || 0;
  if (parsed < 0) return 0;
  if (parsed > 100) return 100;
  return parsed;
}

function getMaxDiscountPercent(role?: string): number {
  if (role === 'ADMIN') return 100;
  if (role === 'STORE_MANAGER') return 20;
  return 10;
}

function normalizePaymentAmount(value: unknown): number {
  const parsed = toFiniteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : 0;
}

function createSafeClientId(prefix: string): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return randomUuid;

  const randomPart = globalThis.crypto?.getRandomValues
    ? globalThis.crypto.getRandomValues(new Uint32Array(2)).join('-')
    : Math.random().toString(36).slice(2);

  return `${prefix}-${Date.now()}-${randomPart}`;
}

function paymentRowsAllocated(rows: SplitPaymentRow[]): number {
  return rows.reduce((sum, row) => sum + normalizePaymentAmount(row.amountStr), 0);
}

function paymentRowsAreBalanced(totalDue: number, allocated: number): boolean {
  return Math.abs(totalDue - allocated) <= PAYMENT_TOLERANCE;
}

function buildPaymentLabel(payments: ReceiptPaymentSnapshot[]): string {
  if (payments.length === 0) return 'UNKNOWN';
  if (payments.length === 1) return payments[0].method;
  return payments.map(payment => `${payment.method} ₹${payment.amount.toFixed(2)}`).join(' + ');
}

function splitPaymentStatus(payments: ReceiptPaymentSnapshot[], totalDue: number): Order['paymentStatus'] {
  const creditAmount = payments
    .filter(payment => payment.method === 'CREDIT')
    .reduce((sum, payment) => sum + payment.amount, 0);

  if (creditAmount <= PAYMENT_TOLERANCE) return 'PAID';
  return creditAmount >= totalDue - PAYMENT_TOLERANCE ? 'UNPAID' : 'PARTIAL';
}

function calculateTotals(items: TotalsInput[], discountPercentInput: unknown, fallbackTaxRate: number): CalculatedTotals {
  const subtotal = items.reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 0), 0);
  const discountPercent = clampDiscountPercent(discountPercentInput);
  const discountAmount = subtotal * (discountPercent / 100);
  const taxableAmount = Math.max(0, subtotal - discountAmount);
  const discountRatio = subtotal > 0 ? discountAmount / subtotal : 0;
  const taxTotal = items.reduce((sum, item) => {
    const lineSubtotal = (Number(item.price) || 0) * (Number(item.quantity) || 0);
    const lineTaxable = Math.max(0, lineSubtotal - (lineSubtotal * discountRatio));
    return sum + lineTaxable * (getItemTaxRate(item, fallbackTaxRate) / 100);
  }, 0);

  return {
    subtotal,
    discountPercent,
    discountAmount,
    taxableAmount,
    taxTotal,
    grandTotal: taxableAmount + taxTotal,
  };
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

function buildReceiptSnapshot(
  order: Order,
  items: OrderItem[],
  payments: OrderPayment[],
  storeName: string,
): ReceiptSnapshot {
  const discountAmount =
    toFiniteNumber(order.discountAmount) ??
    toFiniteNumber(order.discountTotal) ??
    toFiniteNumber(order.discount) ??
    0;
  const taxableAmount = toFiniteNumber(order.taxableAmount) ?? Math.max(0, (toFiniteNumber(order.subtotal) || 0) - discountAmount);
  const gstTotal = toFiniteNumber(order.gstTotal) ?? toFiniteNumber(order.taxTotal) ?? 0;
  const receiptPayments = payments
    .map(payment => ({
      method: payment.method,
      amount: normalizePaymentAmount(payment.amount),
    }))
    .filter(payment => payment.amount > 0 || payments.length === 1);

  return {
    order: {
      orderNumber: order.orderNumber,
      storeName: order.storeName || storeName,
      createdAtIso: new Date().toISOString(),
      createdByName: order.createdByName,
      customerName: order.customerName || null,
      customerPhone: order.customerPhone || null,
      orderType: order.orderType,
      tableNumber: order.tableNumber || null,
      subtotal: toFiniteNumber(order.subtotal) || 0,
      discountPercent: toFiniteNumber(order.discountPercent) || 0,
      discountAmount,
      taxableAmount,
      gstTotal,
      grandTotal: toFiniteNumber(order.grandTotal) || 0,
      paymentMethod: order.paymentMethod || receiptPayments[0]?.method || 'CASH',
      isSplitPayment: order.isSplitPayment === true || receiptPayments.length > 1,
      paymentStatus: order.paymentStatus || null,
    },
    items: items.map(item => {
      const quantity = toFiniteNumber(item.quantity) || 0;
      const unitPrice = toFiniteNumber(item.unitPrice) || 0;
      return {
        itemName: item.itemName,
        quantity,
        unitPrice,
        lineTotal: toFiniteNumber(item.lineTotal) ?? quantity * unitPrice,
      };
    }),
    payments: receiptPayments.length > 0
      ? receiptPayments
      : [{ method: order.paymentMethod || 'CASH', amount: toFiniteNumber(order.grandTotal) || 0 }],
  };
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
  if (error instanceof CheckoutBlockerError) {
    return {
      message: 'This item is not ready for billing because stock/BOM setup is incomplete. Please ask an Admin or Store Manager to check POS Readiness.',
      details: formatCheckoutBlockerDetails(error.blockers),
      blockers: error.blockers,
    };
  }

  const details = error instanceof Error ? error.message : String(error || 'Unknown checkout error');
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
    };
  }

  if (lower.includes('discount') && lower.includes('limit')) {
    return {
      message: details,
      details,
    };
  }

  if (lower.includes('split payment') || lower.includes('allocated')) {
    return {
      message: details,
      details,
    };
  }

  if (lower.includes('permission') || lower.includes('permission-denied')) {
    return {
      message: 'This checkout could not be saved because your account does not have permission for this action. Please contact an Admin.',
      details,
    };
  }

  return {
    message: 'Checkout could not be completed. Please check the cart and try again.',
    details,
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

export default function POSHome() {
  const { staffProfile } = useAuth();
  const isAdmin = staffProfile?.role === 'ADMIN';
  const canViewCheckoutDebug = staffProfile?.role === 'ADMIN' || staffProfile?.role === 'STORE_MANAGER';

  const [stores, setStores] = useState<Store[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [appGstConfig, setAppGstConfig] = useState<AppGstConfig>({
    defaultRate: 0,
    defaultSource: 'No app GST fallback configured',
    storeOverrides: {},
  });

  const [selectedStoreId, setSelectedStoreId] = useState<string>('');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const [orderType, setOrderType] = useState<OrderType>('DINE_IN');
  const [tableNumber, setTableNumber] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');

  const [cart, setCart] = useState<CartItem[]>([]);
  const [discountPercentStr, setDiscountPercentStr] = useState<string>('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | ''>('');
  const [isSplitPayment, setIsSplitPayment] = useState(false);
  const [splitPayments, setSplitPayments] = useState<SplitPaymentRow[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [checkoutError, setCheckoutError] = useState<CheckoutError | null>(null);
  const [lastReceipt, setLastReceipt] = useState<ReceiptSnapshot | null>(null);
  const [receiptView, setReceiptView] = useState<ReceiptSnapshot | null>(null);
  const [receiptViewTitle, setReceiptViewTitle] = useState('Order Saved');
  const [heldBills, setHeldBills] = useState<HeldBill[]>([]);

  const posSource = 'FINISHED_GOODS' as const;

  const [debugCounts, setDebugCounts] = useState<any>(null);
  const [isMobileCartOpen, setIsMobileCartOpen] = useState(false);

  useEffect(() => {
    fetchData();
    fetchMenuData();
    fetchTaxConfig();
  }, []);

  useEffect(() => {
    setLastReceipt(readLocalStorageJson<ReceiptSnapshot | null>(LAST_RECEIPT_STORAGE_KEY, null));
    setHeldBills(loadStoredHeldBills());
  }, []);

  useEffect(() => {
    if (!loading) {
      const timer = window.setTimeout(() => searchInputRef.current?.focus(), 100);
      return () => window.clearTimeout(timer);
    }
  }, [loading, selectedStoreId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName || '';
      const isTyping = target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName);

      if (event.key === '/' && !isTyping) {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if (event.key === 'Escape' && (document.activeElement === searchInputRef.current || searchQuery)) {
        event.preventDefault();
        setSearchQuery('');
        searchInputRef.current?.blur();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [searchQuery]);

  const fetchMenuData = async () => {
    setLoading(true);
    try {
      const fgSnap = await getDocs(query(collection(db, 'finishedGoods')));

      let total = 0;
      let activeCount = 0;
      let sellableCount = 0;
      let availableCount = 0;

      const mappedItems: (MenuItem & { itemType: string, bom: any[], finishedGoodCode: string })[] = [];

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
           name: data.displayName || data.name,
           code: data.code,
           categoryId: data.posCategoryCode || 'MISC',
           categoryCode: data.posCategoryCode || 'MISC',
           categoryName: data.posCategoryName || 'Misc',
           categorySortOrder: typeof data.categorySortOrder === 'number' ? data.categorySortOrder : 999,
           subcategoryCode: data.posSubcategoryCode || 'MISC',
           subcategoryName: data.posSubcategoryName || '',
           subcategorySortOrder: typeof data.subcategorySortOrder === 'number' ? data.subcategorySortOrder : 999,
           sortOrder: typeof data.sortOrder === 'number' ? data.sortOrder : 999,
           description: data.description || '',
           price: data.salePrice || 0,
           taxRate: pickItemTaxRate(data),
           prepStation: data.prepStation || 'NONE',
           isActive: data.isActive,
           availableStoreIds: data.availableStoreIds || [],
           itemType: data.itemType,
           bom: data.bom || [],
           finishedGoodCode: data.code,
           createdAt: data.createdAt,
           updatedAt: data.updatedAt
         } as any);
      });

      setMenuItems(mappedItems);
      setDebugCounts({ total, activeCount, sellableCount, availableCount, mappedCount: mappedItems.length });
    } catch (e: any) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  const fetchData = async () => {
    try {
      const storesSnap = await getDocs(query(collection(db, 'stores'), where('isActive', '==', true)));

      const fetchedStores = storesSnap.docs.map(d => ({ id: d.id, ...d.data() } as Store));

      const allowedStores = isAdmin
        ? fetchedStores
        : fetchedStores.filter(s => staffProfile?.storeIds.includes(s.id));

      setStores(allowedStores);
      if (allowedStores.length > 0) {
        setSelectedStoreId(allowedStores[0].id);
      }
    } catch (error: any) {
      if (error?.code !== 'permission-denied') {
        console.error("Error fetching POS data:", error);
      }
    }
  };

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

  const handleStoreChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    if (cart.length > 0) {
      if (window.confirm("Changing store will clear your current cart. Proceed?")) {
        setCart([]);
        setCheckoutError(null);
        setSelectedStoreId(e.target.value);
      }
    } else {
      setCheckoutError(null);
      setSelectedStoreId(e.target.value);
    }
  };

  const selectedStoreTaxConfig = useMemo(() => {
    const selectedStore = stores.find(s => s.id === selectedStoreId);
    const configuredStoreOverride = selectedStore
      ? appGstConfig.storeOverrides[selectedStore.id] || appGstConfig.storeOverrides[selectedStore.code]
      : 0;
    if (configuredStoreOverride > 0 && selectedStore) {
      return {
        rate: configuredStoreOverride,
        source: `appSettings/${GST_CONFIG_DOC_ID}.storeOverrides.${selectedStore.code}`,
      };
    }

    const storeTaxConfig = selectedStore
      ? pickTaxConfig(selectedStore as unknown as Record<string, unknown>, `stores/${selectedStore.id}`, STORE_TAX_RATE_KEYS)
      : null;
    if (storeTaxConfig) return storeTaxConfig;

    return {
      rate: appGstConfig.defaultRate,
      source: appGstConfig.defaultSource,
    };
  }, [stores, selectedStoreId, appGstConfig]);

  const displayCategories = useMemo(() => {
    const catsMap = new Map<string, { id: string, name: string, sortOrder: number, count: number }>();
    menuItems.forEach(item => {
      if (!item.availableStoreIds?.includes(selectedStoreId)) return;

      const code = (item as any).categoryCode || item.categoryId || 'MISC';
      const name = (item as any).categoryName || 'Misc';
      const order = (item as any).categorySortOrder !== undefined ? (item as any).categorySortOrder : 999;

      if (!catsMap.has(code)) {
         catsMap.set(code, { id: code, name: name, sortOrder: order, count: 0 });
      }
      catsMap.get(code)!.count++;
    });

    return Array.from(catsMap.values()).sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) {
        return a.sortOrder - b.sortOrder;
      }
      return a.name.localeCompare(b.name);
    });
  }, [menuItems, selectedStoreId]);

  // Reset selected category if it's no longer valid for the current display categories
  useEffect(() => {
    if (selectedCategoryId !== 'ALL') {
      const isValid = displayCategories.some(c => c.id === selectedCategoryId);
      if (!isValid) {
        setSelectedCategoryId('ALL');
      }
    }
  }, [displayCategories, selectedCategoryId]);

  const filteredMenuItems = useMemo(() => {
    const filtered = menuItems.filter(item => {
      // Must be available in selected store
      if (!item.availableStoreIds?.includes(selectedStoreId)) return false;

      // Must match category if selected
      const catCode = (item as any).categoryCode || item.categoryId;
      if (selectedCategoryId !== 'ALL' && catCode !== selectedCategoryId) return false;

      // Must match search query
      if (searchQuery) {
        const queryLower = searchQuery.toLowerCase();
        const nameMatch = (item.name || '').toLowerCase().includes(queryLower);
        const codeMatch = (item.code || '').toLowerCase().includes(queryLower);
        if (!nameMatch && !codeMatch) {
          return false;
        }
      }
      return true;
    });

    // Sort items
    return filtered.sort((a: any, b: any) => {
      const orderA = typeof a.sortOrder === 'number' ? a.sortOrder : 999;
      const orderB = typeof b.sortOrder === 'number' ? b.sortOrder : 999;
      if (orderA !== orderB) {
        return orderA - orderB;
      }
      return (a.name || '').localeCompare(b.name || '');
    });
  }, [menuItems, selectedStoreId, selectedCategoryId, searchQuery]);

  const availableMenuItems = useMemo(() => {
    return menuItems
      .filter(item => item.isActive && item.availableStoreIds?.includes(selectedStoreId))
      .sort((a: any, b: any) => {
        const orderA = typeof a.sortOrder === 'number' ? a.sortOrder : 999;
        const orderB = typeof b.sortOrder === 'number' ? b.sortOrder : 999;
        if (orderA !== orderB) return orderA - orderB;
        return (a.name || '').localeCompare(b.name || '');
      });
  }, [menuItems, selectedStoreId]);

  const fastItems = useMemo(() => {
    return [...availableMenuItems]
      .sort((a: any, b: any) => {
        const aPopular = Boolean(a.isPopular || a.isFastItem || a.fastItem);
        const bPopular = Boolean(b.isPopular || b.isFastItem || b.fastItem);
        if (aPopular !== bPopular) return aPopular ? -1 : 1;

        const aSales = Number(a.salesCount || a.orderCount || a.popularityScore || 0);
        const bSales = Number(b.salesCount || b.orderCount || b.popularityScore || 0);
        if (aSales !== bSales) return bSales - aSales;

        const orderA = typeof a.sortOrder === 'number' ? a.sortOrder : 999;
        const orderB = typeof b.sortOrder === 'number' ? b.sortOrder : 999;
        if (orderA !== orderB) return orderA - orderB;
        return (a.name || '').localeCompare(b.name || '');
      })
      .slice(0, 8);
  }, [availableMenuItems]);

  // --- Cart Operations ---
  const addToCart = (item: any) => {
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

    setCart(prev => {
      const existing = prev.find(ci => ci.menuItemId === itemId);
      if (existing) {
        return prev.map(ci => ci.menuItemId === itemId ? { ...ci, quantity: ci.quantity + 1 } : ci);
      }
      return [...prev, {
        id: createSafeClientId('cart-item'),
        menuItemId: itemId,
        menuItemCode: itemCode,
        name: itemName,
        price: itemPrice,
        taxRate: item.taxRate,
        prepStation: item.prepStation,
        quantity: 1,
        sourceSystem: posSource,
        itemType: item.itemType,
        finishedGoodCode: item.finishedGoodCode,
        bom: item.bom
      }];
    });
  };

  const updateQuantity = (cartItemId: string, delta: number) => {
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
    setCheckoutError(null);
    setCart(prev => prev.filter(ci => ci.id !== cartItemId));
  };

  const clearCart = (skipConfirm: boolean = false) => {
    if (skipConfirm === true || window.confirm("Clear the entire cart?")) {
      setCart([]);
      setCheckoutError(null);
      setDiscountPercentStr('');
      setPaymentMethod('');
      setIsSplitPayment(false);
      setSplitPayments([]);
      setCustomerName('');
      setCustomerPhone('');
      setTableNumber('');
      setOrderType('DINE_IN');
    }
  };

  const cartTotals = useMemo(() => {
    return calculateTotals(cart, discountPercentStr, selectedStoreTaxConfig.rate);
  }, [cart, discountPercentStr, selectedStoreTaxConfig.rate]);

  const cartHasItemTaxRate = useMemo(() => {
    return cart.some(item => normalizeTaxRate(item.taxRate) > 0);
  }, [cart]);

  const cartIsMissingGstConfig = cart.length > 0 && !cartHasItemTaxRate && selectedStoreTaxConfig.rate <= 0;
  const maxDiscountPercent = getMaxDiscountPercent(staffProfile?.role);
  const discountExceedsLimit = cartTotals.discountPercent > maxDiscountPercent + 0.0001;
  const splitAllocatedAmount = useMemo(() => paymentRowsAllocated(splitPayments), [splitPayments]);
  const splitBalanceAmount = cartTotals.grandTotal - splitAllocatedAmount;
  const splitPaymentBalanced = paymentRowsAreBalanced(cartTotals.grandTotal, splitAllocatedAmount);

  const persistHeldBills = (nextHeldBills: HeldBill[]) => {
    setHeldBills(nextHeldBills);
    writeLocalStorageJson(HELD_BILLS_STORAGE_KEY, nextHeldBills);
  };

  const openLastReceipt = () => {
    if (!lastReceipt) return;
    setReceiptViewTitle('Last Order Receipt');
    setReceiptView(lastReceipt);
  };

  const holdCurrentBill = () => {
    if (cart.length === 0) {
      alert('Cart is empty');
      return;
    }

    const selectedStore = stores.find(s => s.id === selectedStoreId);
    if (!selectedStore) {
      alert('Please select a store before holding this bill.');
      return;
    }

    const heldBill: HeldBill = {
      id: createSafeClientId('held-bill'),
      storeId: selectedStore.id,
      storeName: selectedStore.name,
      orderType,
      tableNumber,
      customerName,
      customerPhone,
      cart: cart.map(item => ({ ...item })),
      discountPercentStr,
      isSplitPayment,
      splitPayments: splitPayments.map(payment => ({ ...payment })),
      heldAtIso: new Date().toISOString(),
      itemCount: cart.reduce((sum, item) => sum + item.quantity, 0),
      total: cartTotals.grandTotal,
    };

    persistHeldBills([heldBill, ...heldBills]);
    clearCart(true);
    setIsMobileCartOpen(false);
  };

  const recallHeldBill = (bill: HeldBill) => {
    if (!stores.some(store => store.id === bill.storeId)) {
      alert('This held bill belongs to a store that is not available for your account.');
      return;
    }

    if (cart.length > 0 && !window.confirm('Recall this held bill and replace the current cart?')) {
      return;
    }

    setSelectedStoreId(bill.storeId);
    setOrderType(bill.orderType);
    setTableNumber(bill.tableNumber);
    setCustomerName(bill.customerName);
    setCustomerPhone(bill.customerPhone);
    setCart(bill.cart.map(item => ({ ...item })));
    setDiscountPercentStr(bill.discountPercentStr);
    setIsSplitPayment(bill.isSplitPayment === true);
    setSplitPayments((bill.splitPayments || []).map(payment => ({ ...payment })));
    setPaymentMethod('');
    setCheckoutError(null);
    persistHeldBills(heldBills.filter(held => held.id !== bill.id));
    setIsMobileCartOpen(true);
  };

  const deleteHeldBill = (bill: HeldBill) => {
    const label = bill.customerName || bill.tableNumber || bill.storeName;
    if (!window.confirm(`Delete held bill for ${label}?`)) return;
    persistHeldBills(heldBills.filter(held => held.id !== bill.id));
  };

  const setSplitPaymentMode = (enabled: boolean) => {
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

  const normalizedSplitPayments = (totalDue: number): ReceiptPaymentSnapshot[] => {
    return splitPayments.map(payment => ({
      method: payment.method,
      amount: normalizePaymentAmount(payment.amountStr),
    })).filter(payment => payment.amount > 0 || totalDue === 0);
  };

  const handleCheckout = async () => {
    if (!staffProfile || !auth.currentUser) return;
    if (cart.length === 0) return alert("Cart is empty");
    if (!selectedStoreId) return alert("Please select a store");
    if (!isSplitPayment && !paymentMethod) return alert("Please select a payment method");
    if (isSplitPayment && splitPayments.length === 0) return alert("Please add at least one payment row");
    if (orderType === 'DINE_IN' && !tableNumber.trim()) return alert("Table number is required for DINE IN");

    setIsSaving(true);
    setCheckoutError(null);

    try {
      const selectedStore = stores.find(s => s.id === selectedStoreId);
      if (!selectedStore) throw new Error("Store not found");

      // Verify menu items exist and are still active/available, and compute true totals
      const validatedCart = cart.map(item => {
        const liveItem = menuItems.find(mi => mi.id === item.menuItemId && mi.isActive && mi.availableStoreIds.includes(selectedStoreId));
        if (!liveItem) {
          throw new Error(`Menu item ${item.name} is no longer available at this store.`);
        }
        return { cartItem: item, liveItem };
      });

      const trueTotals = calculateTotals(
        validatedCart.map(({ cartItem, liveItem }) => ({
          price: liveItem.price,
          quantity: cartItem.quantity,
          taxRate: liveItem.taxRate,
        })),
        discountPercentStr,
        selectedStoreTaxConfig.rate,
      );
      const trueSubtotal = trueTotals.subtotal;
      const trueDiscount = trueTotals.discountAmount;
      const trueDiscountPercent = trueTotals.discountPercent;
      const trueTaxableAmount = trueTotals.taxableAmount;
      const trueTaxTotal = trueTotals.taxTotal;
      const trueGrandTotal = trueTotals.grandTotal;
      const trueDiscountRatio = trueSubtotal > 0 ? trueDiscount / trueSubtotal : 0;
      const userMaxDiscount = getMaxDiscountPercent(staffProfile.role);

      if (trueDiscountPercent > userMaxDiscount + 0.0001) {
        throw new Error(`Discount ${trueDiscountPercent.toFixed(2)}% exceeds the ${userMaxDiscount}% limit for your role.`);
      }

      const paymentRows: ReceiptPaymentSnapshot[] = isSplitPayment
        ? normalizedSplitPayments(trueGrandTotal)
        : [{
          method: paymentMethod as PaymentMethod,
          amount: paymentMethod === 'CREDIT' ? 0 : trueGrandTotal,
        }];
      const allocatedPaymentAmount = isSplitPayment
        ? paymentRows.reduce((sum, payment) => sum + payment.amount, 0)
        : trueGrandTotal;

      if (isSplitPayment) {
        if (paymentRows.length === 0) {
          throw new Error('Split payment needs at least one payment row with an amount greater than zero.');
        }
        if (!paymentRowsAreBalanced(trueGrandTotal, allocatedPaymentAmount)) {
          throw new Error(`Split payment must equal the total due. Allocated ₹${allocatedPaymentAmount.toFixed(2)} against ₹${trueGrandTotal.toFixed(2)}.`);
        }
      }

      if (paymentRows.some(payment => payment.method === 'COMPLIMENTARY' && payment.amount > 0) && trueGrandTotal > 0) {
        if (!window.confirm(`This order is COMPLIMENTARY but has a total of ₹${trueGrandTotal.toFixed(2)}. Proceed?`)) {
          setIsSaving(false);
          return;
        }
      }

      // Detailed Checkout Logging
      if (import.meta.env.DEV) console.log(`[CHECKOUT START] User: ${auth.currentUser.uid}, Role: ${staffProfile.role}, Store: ${selectedStoreId}, Phone: ${customerPhone}`);

      // Check customer
      let customerId: string | null = null;
      let customerNameFinal = customerName.trim() || null;
      let existingCustomerDocs: any[] = [];
      const phoneToSearch = customerPhone.trim();

      if (phoneToSearch) {
        try {
          if (import.meta.env.DEV) console.log(`[CHECKOUT] Fetching customer with phone: ${phoneToSearch}`);
          const q = query(collection(db, 'customers'), where('phone', '==', phoneToSearch));
          const custSnap = await getDocs(q);
          if (!custSnap.empty) {
            existingCustomerDocs = custSnap.docs;
            if (import.meta.env.DEV) console.log(`[CHECKOUT] Found existing customer: ${existingCustomerDocs[0].id}`);
          }
        } catch (e: any) {
          console.error(`[CHECKOUT ERROR] Customers getDocs failed:`, e);
          throw e; // fail early for logging
        }
      }

      const custRef = existingCustomerDocs.length > 0
        ? doc(db, 'customers', existingCustomerDocs[0].id)
        : phoneToSearch ? doc(collection(db, 'customers')) : null;

      // 10. Generate order number & save transaction
      const dateKey = new Date().toISOString().slice(0,10).replace(/-/g,''); // YYYYMMDD
      const counterId = `${selectedStore.code}_${dateKey}`;
      const counterRef = doc(db, 'counters', counterId);
      const newOrderRef = doc(collection(db, 'orders'));

      if (import.meta.env.DEV) console.log(`[CHECKOUT] Preflight complete. target counter: ${counterId}, order: ${newOrderRef.id}`);

      const reqStock: Record<string, RequiredStock> = {};
      const setupBlockers: CheckoutBlocker[] = [];
      const allowMissingRecipeCheckout = import.meta.env.DEV && import.meta.env.VITE_ALLOW_MISSING_RECIPE_CHECKOUT === 'true';

      const addSetupBlocker = (blocker: Omit<CheckoutBlocker, 'storeName' | 'storeId'>) => {
        setupBlockers.push({
          ...blocker,
          storeName: selectedStore.name,
          storeId: selectedStore.id,
        });
      };

      const addStockRequirement = (stockId: string, source: StockSource) => {
        if (!reqStock[stockId]) {
          reqStock[stockId] = {
            id: stockId,
            name: source.componentName,
            unit: source.unit,
            qty: 0,
            type: source.componentType,
            code: source.componentCode,
            sources: [],
          };
        }
        reqStock[stockId].qty += source.quantity;
        reqStock[stockId].sources.push(source);
      };

      for (const { cartItem, liveItem } of validatedCart) {
        const liveItemData = liveItem as any;
        const itemType = liveItemData.itemType || cartItem.itemType;
        const bom = Array.isArray(liveItemData.bom) ? liveItemData.bom : (Array.isArray(cartItem.bom) ? cartItem.bom : []);

        if (itemType === 'NO_STOCK') continue;

        if (itemType === 'MADE_TO_ORDER' || (itemType === 'DIRECT_STOCK' && bom.length > 0)) {
          if (bom.length === 0) {
            addSetupBlocker({
              itemName: liveItem.name,
              itemCode: liveItem.code,
              finishedGoodCode: liveItemData.finishedGoodCode || liveItem.code,
              blockerType: 'Missing BOM',
              requiredQuantity: cartItem.quantity,
              availableQuantity: 0,
              unit: 'BOM',
              suggestedAdminAction: 'Add a BOM/recipe for this finished good in Menu Management, or mark it as No Stock only if it should never deduct inventory.',
            });
            continue;
          }
          bom.forEach((line: any) => {
            const code = String(line.componentCode || '').trim();
            const type = String(line.componentType || '').trim();
            const quantity = Number(line.quantity) || 0;
            const unit = String(line.uom || line.usageUOM || '').trim();

            if (!code || !type || quantity <= 0) {
              addSetupBlocker({
                itemName: liveItem.name,
                itemCode: liveItem.code,
                finishedGoodCode: liveItemData.finishedGoodCode || liveItem.code,
                blockerType: 'Missing prep/raw ingredient reference',
                componentType: type || 'UNKNOWN',
                componentCode: code || 'UNKNOWN',
                componentName: line.componentName || 'Missing component',
                requiredQuantity: quantity,
                availableQuantity: 0,
                unit,
                suggestedAdminAction: 'Fix the BOM row so it has a valid component type, component code, quantity, and UOM.',
              });
              return;
            }

            const stockId = `${selectedStoreId}_${type}_${code}`;
            addStockRequirement(stockId, {
              itemName: liveItem.name,
              itemCode: liveItem.code,
              finishedGoodCode: liveItemData.finishedGoodCode || liveItem.code,
              lineQuantity: cartItem.quantity,
              componentType: type,
              componentCode: code,
              componentName: line.componentName || code,
              quantity: quantity * cartItem.quantity,
              unit,
            });
          });
        } else if (itemType === 'DIRECT_STOCK') {
          const stockId = `${selectedStoreId}_FINISHED_GOOD_${liveItem.code}`;
          addStockRequirement(stockId, {
            itemName: liveItem.name,
            itemCode: liveItem.code,
            finishedGoodCode: liveItemData.finishedGoodCode || liveItem.code,
            lineQuantity: cartItem.quantity,
            componentType: 'FINISHED_GOOD',
            componentCode: liveItem.code,
            componentName: liveItem.name,
            quantity: cartItem.quantity,
            unit: 'pcs',
          });
        }
      }

      if (setupBlockers.length > 0) {
        if (!allowMissingRecipeCheckout || setupBlockers.some(blocker => blocker.blockerType !== 'Missing BOM')) {
          throw new CheckoutBlockerError(setupBlockers);
        }
        console.warn(`[CHECKOUT DEV BYPASS] ${formatCheckoutBlockerDetails(setupBlockers)}`);
      }

      const buildStockBlockers = (
        req: RequiredStock,
        blockerType: CheckoutBlockerType,
        availableQuantity: number,
        confirmedZero: boolean | undefined,
        suggestedAdminAction: string,
      ): CheckoutBlocker[] => req.sources.map(source => ({
        itemName: source.itemName,
        itemCode: source.itemCode,
        finishedGoodCode: source.finishedGoodCode,
        blockerType,
        componentType: source.componentType,
        componentCode: source.componentCode,
        componentName: source.componentName,
        requiredQuantity: req.qty,
        availableQuantity,
        unit: source.unit,
        confirmedZero,
        storeName: selectedStore.name,
        storeId: selectedStore.id,
        suggestedAdminAction,
      }));

      const { savedOrder, savedItems, savedPayments } = await runTransaction(db, async (transaction) => {
        // --- READ PHASE ONLY ---
        if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction: get counter`);
        const counterDoc = await transaction.get(counterRef);

        let custDoc: any = null;
        if (custRef) {
          if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction: get customer doc`);
          custDoc = await transaction.get(custRef);
        }

        // Fetch current stock
        const stockDocsMap: Record<string, any> = {};
        const stockBlockers: CheckoutBlocker[] = [];
        for (const stockKey of Object.keys(reqStock)) {
           const req = reqStock[stockKey];

           let stockRef;
           if (req.type === 'PACKAGING') {
              stockRef = doc(db, 'storeStock', `${selectedStoreId}_PACKAGING_${req.code}`);
           } else {
              stockRef = doc(db, 'storeStock', stockKey);
           }

           let stockDoc = await transaction.get(stockRef);

           if (req.type === 'PACKAGING' && !stockDoc.exists()) {
              stockRef = doc(db, 'storeStock', `${selectedStoreId}_RAW_INGREDIENT_${req.code}`);
              stockDoc = await transaction.get(stockRef);
           }

           if (!stockDoc.exists()) {
              stockBlockers.push(...buildStockBlockers(
                req,
                'Missing stock record',
                0,
                undefined,
                `Create a storeStock row for ${req.type} / ${req.code} at ${selectedStore.name}, then load opening/current stock.`,
              ));
              continue;
           }

           const stockData = stockDoc.data() as any;
           const currentStock = toFiniteNumber(stockData.currentStock) || 0;
           const confirmedZero = stockData.confirmedZero === true;
           if (currentStock < req.qty) {
              const blockerType: CheckoutBlockerType = currentStock <= 0
                ? (confirmedZero ? 'Zero stock' : 'confirmedZero false')
                : 'Insufficient stock';
              const suggestedAdminAction = currentStock <= 0
                ? `Load current stock for ${req.type} / ${req.code}, or mark confirmedZero TRUE only if this item is intentionally unavailable.`
                : `Adjust stock or reduce the cart quantity. Required total is ${req.qty.toFixed(2)} ${req.unit}; available is ${currentStock.toFixed(2)} ${req.unit}.`;
              stockBlockers.push(...buildStockBlockers(
                req,
                blockerType,
                currentStock,
                confirmedZero,
                suggestedAdminAction,
              ));
              continue;
           }

           stockDocsMap[stockKey] = { ref: stockRef, currentStock };
        }

        if (stockBlockers.length > 0) {
          throw new CheckoutBlockerError(stockBlockers);
        }

        if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction read phase complete`);

        // --- VALIDATION PHASE ---
        let seq = 1;
        if (counterDoc.exists()) {
          seq = (counterDoc.data()?.lastSequence || 0) + 1;
        }

        const orderNumber = `CB-${selectedStore.code}-${dateKey}-${seq.toString().padStart(4, '0')}`;
        if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction validation complete - order number generated: ${orderNumber}`);

        // --- WRITE PHASE ONLY ---

        // Inventory Deduction Writes
        for (const stockKey of Object.keys(reqStock)) {
           const { ref, currentStock } = stockDocsMap[stockKey] as { ref: any, currentStock: number };
           const req = reqStock[stockKey];
           const deduction = req.qty;

           transaction.update(ref, {
              currentStock: currentStock - deduction,
              updatedAt: serverTimestamp()
           });

           // movement record
           const moveRef = doc(collection(db, 'stockMovements'));

           const movementData: any = {
              storeId: selectedStore.id,
              storeName: selectedStore.name,
              inventoryItemId: req.code,
              inventoryItemName: req.name,
              movementType: 'SALE_DEDUCTION',
              quantity: -deduction,
              unit: req.unit,
              referenceType: 'ORDER',
              referenceId: newOrderRef.id,
              notes: `Order ${orderNumber}`,
              createdByUserId: auth.currentUser!.uid,
              createdByName: staffProfile.name,
              createdAt: serverTimestamp()
           };

           movementData.stockSystem = 'MENU_MANAGEMENT';
           movementData.stockItemType = req.type === 'PACKAGING' ? (ref.id.includes('RAW_INGREDIENT') ? 'RAW_INGREDIENT' : 'PACKAGING') : req.type;
           movementData.stockItemCode = req.code;

           transaction.set(moveRef, movementData);
        }
        if (counterDoc.exists()) {
          if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction: updating counter to ${seq}`);
          transaction.update(counterRef, { lastSequence: seq, updatedAt: serverTimestamp() });
        } else {
          if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction: creating counter at ${seq}`);
          transaction.set(counterRef, { storeCode: selectedStore.code, dateKey, lastSequence: seq, updatedAt: serverTimestamp() });
        }

        // Prepare customer updates
        if (custRef) {
          if (custDoc && custDoc.exists()) {
             if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction: update customer`);
            const data = custDoc.data();
            transaction.update(custRef, {
              visitCount: (data.visitCount || 0) + 1,
              totalSpend: (data.totalSpend || 0) + trueGrandTotal,
              lastVisitAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
              ...(customerNameFinal && { name: customerNameFinal })
            });
            if (!customerNameFinal && data.name) customerNameFinal = data.name;
          } else {
            if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction: create customer`);
            transaction.set(custRef, {
              name: customerNameFinal || 'Unknown',
              phone: phoneToSearch,
              visitCount: 1,
              totalSpend: trueGrandTotal,
              lastVisitAt: serverTimestamp(),
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp()
            });
          }
          customerId = custRef.id;
        }

        const paymentStatus: Order['paymentStatus'] = isSplitPayment
          ? splitPaymentStatus(paymentRows, trueGrandTotal)
          : (paymentMethod === 'CREDIT' && trueGrandTotal > 0) ? 'UNPAID' : 'PAID';

        const orderData: Order = {
          orderNumber,
          storeId: selectedStore.id,
          storeCode: selectedStore.code,
          storeName: selectedStore.name,
          customerId,
          customerName: customerNameFinal,
          customerPhone: phoneToSearch || null,
          createdByUserId: auth.currentUser!.uid,
          createdByName: staffProfile.name,
          orderType,
          status: 'COMPLETED',
          paymentStatus,
          tableNumber: tableNumber.trim() || null,
          subtotal: trueSubtotal,
          taxTotal: trueTaxTotal,
          gstTotal: trueTaxTotal,
          taxableAmount: trueTaxableAmount,
          discountPercent: trueDiscountPercent,
          discountAmount: trueDiscount,
          discountTotal: trueDiscount,
          discount: trueDiscount,
          grandTotal: trueGrandTotal,
          paymentMethod: (paymentRows[0]?.method || paymentMethod) as PaymentMethod,
          ...(isSplitPayment && {
            isSplitPayment: true,
            paymentMethodLabel: buildPaymentLabel(paymentRows),
            paymentBreakdown: paymentRows,
          }),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        };

        if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction: saving order data...`);
        transaction.set(newOrderRef, orderData);

        // Prep line items
        if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction: saving line items...`);
        const newItems: OrderItem[] = [];
        validatedCart.forEach(({ cartItem: item, liveItem }) => {
          const lineRef = doc(collection(newOrderRef, 'items'));
          const lineSub = liveItem.price * item.quantity;
          const lineDiscount = lineSub * trueDiscountRatio;
          const lineTaxable = Math.max(0, lineSub - lineDiscount);
          const appliedTaxRate = getItemTaxRate(liveItem, selectedStoreTaxConfig.rate);
          const lineTax = lineTaxable * (appliedTaxRate / 100);

          const itemData: OrderItem = {
            menuItemId: liveItem.id,
            itemName: liveItem.name,
            itemCode: liveItem.code,
            categoryId: liveItem.categoryId,
            categoryName: liveItem.categoryName,
            quantity: item.quantity,
            unitPrice: liveItem.price,
            taxRate: appliedTaxRate,
            lineSubtotal: lineSub,
            lineDiscount,
            lineTaxable,
            lineTax: lineTax,
            lineTotal: lineTaxable + lineTax,
            prepStation: liveItem.prepStation,
            status: 'PENDING',
            createdAt: serverTimestamp(),
            sourceSystem: 'FINISHED_GOODS',
            itemType: item.itemType,
            finishedGoodCode: item.finishedGoodCode
          };

          if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction: set lineItem ${lineRef.id}`);
          transaction.set(lineRef, itemData);
          newItems.push({ id: lineRef.id, ...itemData });

          // Create KOT items
          const createKotItem = (station: "BARISTA" | "KITCHEN") => {
            const kotRef = doc(collection(db, 'kotItems'));
            if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction: set kotItem ${kotRef.id} for station: ${station}`);
            transaction.set(kotRef, {
              orderId: newOrderRef.id,
              orderNumber,
              orderItemId: lineRef.id,
              storeId: selectedStore.id,
              storeCode: selectedStore.code,
              storeName: selectedStore.name,
              station,
              itemName: liveItem.name,
              itemCode: liveItem.code || '',
              quantity: item.quantity,
              orderType,
              tableNumber: orderType === 'DINE_IN' ? tableNumber.trim() : null,
              customerName: customerNameFinal,
              status: "PENDING",
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
              createdByUserId: auth.currentUser!.uid,
              createdByName: staffProfile.name
            });
          };

          if (liveItem.prepStation === "BARISTA" || liveItem.prepStation === "BOTH") {
            createKotItem("BARISTA");
          }
          if (liveItem.prepStation === "KITCHEN" || liveItem.prepStation === "BOTH") {
            createKotItem("KITCHEN");
          }
        });

        // Prep payment
        if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction: saving payment data...`);
        const paymentsToWrite: ReceiptPaymentSnapshot[] = isSplitPayment
          ? paymentRows
          : [{
            method: paymentMethod as PaymentMethod,
            amount: paymentStatus === 'PAID' ? trueGrandTotal : 0,
          }];
        const newPayments: OrderPayment[] = [];
        paymentsToWrite.forEach((payment, index) => {
          const paymentRef = doc(collection(newOrderRef, 'payments'));
          const paymentData: OrderPayment = {
            method: payment.method,
            amount: payment.amount,
            reference: null,
            paymentIndex: index,
            createdAt: serverTimestamp()
          };
          transaction.set(paymentRef, paymentData);
          newPayments.push({ id: paymentRef.id, ...paymentData });
        });

        if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction write phase complete`);

        return { savedOrder: { id: newOrderRef.id, ...orderData }, savedItems: newItems, savedPayments: newPayments };
      });

      if (import.meta.env.DEV) console.log(`[CHECKOUT] Success`);

      // Show receipt
      const receipt = buildReceiptSnapshot(savedOrder, savedItems, savedPayments, selectedStore.name);
      setLastReceipt(receipt);
      writeLocalStorageJson(LAST_RECEIPT_STORAGE_KEY, receipt);
      setReceiptViewTitle('Order Saved');
      setReceiptView(receipt);
      clearCart(true); // pass true to skip confirmation on submit
    } catch (err: any) {
      if (isExpectedCheckoutValidationError(err)) console.warn(err instanceof Error ? err.message : err);
      else console.error(err);
      setCheckoutError(buildCheckoutError(err));
    } finally {
      setIsSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={32} className="animate-spin text-[#5c4033]" />
      </div>
    );
  }

  if (stores.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-center text-neutral-500">
        <div>
          <SearchX size={48} className="mx-auto mb-4 opacity-50" />
          <h2 className="text-xl font-bold mb-2">No Active Stores</h2>
          <p>You do not have access to any active stores, or none exist in the system.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col lg:flex-row gap-0 overflow-hidden relative w-full min-w-0 h-[100dvh] lg:h-[calc(100vh-64px)] pb-[env(safe-area-inset-bottom)] lg:pb-0">

      {/* Desktop Category Rail (Hidden on Mobile) */}
      <div className="hidden lg:flex flex-col w-[180px] shrink-0 bg-white border-r border-neutral-200 z-10">
        <div className="p-4 border-b border-neutral-100 bg-[#faf8f5]">
          <h2 className="font-black text-neutral-800 tracking-tight">Categories</h2>
        </div>
        <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1">
          <button
            onClick={() => setSelectedCategoryId('ALL')}
            className={`w-full text-left px-3 py-2.5 rounded-lg text-sm font-bold transition-colors flex items-center justify-between group ${selectedCategoryId === 'ALL' ? 'bg-[#5c4033] text-white shadow-sm' : 'text-neutral-600 hover:bg-neutral-100'}`}
          >
            <span>All Items</span>
            <span className={`text-xs px-1.5 py-0.5 rounded-md transition-colors ${selectedCategoryId === 'ALL' ? 'bg-white/20 text-white' : 'bg-neutral-200 text-neutral-500 group-hover:bg-neutral-300'}`}>
              {menuItems.filter(i => i.availableStoreIds?.includes(selectedStoreId)).length}
            </span>
          </button>
          {displayCategories.map(cat => (
            <button
              key={cat.id}
              onClick={() => setSelectedCategoryId(cat.id)}
              className={`w-full text-left px-3 py-2.5 rounded-lg text-sm font-bold transition-colors leading-snug flex items-center justify-between group ${selectedCategoryId === cat.id ? 'bg-[#5c4033] text-white shadow-sm' : 'text-neutral-600 hover:bg-neutral-100'}`}
            >
              <span className="flex-1 mr-2">{cat.name}</span>
              {(cat as any).count !== undefined && (
                <span className={`text-xs px-1.5 py-0.5 rounded-md transition-colors shrink-0 ${selectedCategoryId === cat.id ? 'bg-white/20 text-white' : 'bg-neutral-200 text-neutral-500 group-hover:bg-neutral-300'}`}>
                  {(cat as any).count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Center Area: Menu & Navigation */}
      <div className="flex flex-col bg-[#f9f5f0] overflow-hidden flex-1 w-full min-w-0">
        {/* Top Header */}
        <div className="bg-white border-b border-neutral-200 px-4 py-3 flex flex-wrap lg:flex-nowrap items-center justify-between gap-3 shadow-sm z-10 basis-auto shrink-0 relative">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 lg:hidden bg-[#5c4033] rounded-lg flex items-center justify-center text-[#f9f5f0] shrink-0">
              <Coffee size={18} strokeWidth={2.5} />
            </div>
            <div className="flex flex-col gap-1">
               <div className="flex items-center gap-2">
                 <StoreIcon size={18} className="text-[#5c4033] hidden lg:block" />
                 <select
                   value={selectedStoreId}
                   onChange={handleStoreChange}
                   className="bg-neutral-50 border border-neutral-200 text-neutral-800 font-bold px-3 py-1.5 rounded-lg focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033] outline-none text-sm max-w-[140px] sm:max-w-xs"
                 >
                   {stores.map(s => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
                 </select>
               </div>
               <div className="flex flex-col">
                 <span className="text-[8px] sm:text-[9px] font-bold uppercase tracking-wider text-emerald-600 bg-emerald-50 border border-emerald-100 px-1.5 py-0.5 rounded self-start">
                   POS V2 · Finished Goods Menu
                 </span>
               </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex bg-neutral-100 p-1 rounded-lg w-full sm:w-auto overflow-x-auto custom-scrollbar">
              {(['DINE_IN', 'TAKEAWAY', 'DELIVERY'] as OrderType[]).map(type => (
                <button
                  key={type}
                  onClick={() => setOrderType(type)}
                  className={`px-3 py-1.5 rounded-md text-xs font-bold whitespace-nowrap transition-all ${orderType === type ? 'bg-[#5c4033] text-white shadow-sm' : 'text-neutral-500 hover:text-neutral-800 hover:bg-neutral-200/50'}`}
                >
                  {type === 'DINE_IN' ? 'DINE IN' : type === 'TAKEAWAY' ? 'TAKEAWAY' : 'DELIVERY'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Categories Mobile Dropdown */}
        <div className="lg:hidden bg-white border-b border-neutral-200 px-4 py-3 flex items-center gap-3 shrink-0">
          <label className="text-xs font-bold text-neutral-500 uppercase tracking-widest shrink-0">Category</label>
          <select
            value={selectedCategoryId}
            onChange={e => setSelectedCategoryId(e.target.value)}
            className="flex-1 bg-neutral-50 border border-neutral-200 text-neutral-800 font-bold px-3 py-2 rounded-lg focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033] outline-none text-sm"
          >
            <option value="ALL">All Items ({menuItems.filter(i => i.availableStoreIds?.includes(selectedStoreId)).length})</option>
            {displayCategories.map(cat => (
              <option key={cat.id} value={cat.id}>
                {cat.name} {(cat as any).count !== undefined ? `(${(cat as any).count})` : ''}
              </option>
            ))}
          </select>
        </div>

        {/* DEV Debug Panel */}
        {import.meta.env.DEV && debugCounts && (
          <div className="mx-4 mt-4 bg-blue-50 border border-blue-200 p-3 rounded-xl shadow-sm text-xs text-blue-900 grid grid-cols-2 md:grid-cols-4 gap-2 xl:grid-cols-6 items-center text-center">
             <div className="flex flex-col"><span className="font-bold">Total Finished Goods</span><span>{debugCounts.total}</span></div>
             <div className="flex flex-col"><span className="font-bold">Unique Categories</span><span>{displayCategories.length}</span></div>
             <div className="flex flex-col"><span className="font-bold">Current Category</span><span className="truncate" title={selectedCategoryId}>{selectedCategoryId}</span></div>
             <div className="flex flex-col"><span className="font-bold">Visible Items</span><span>{filteredMenuItems.length}</span></div>
             <div className="flex flex-col"><span className="font-bold">Active/Sellable</span><span>{debugCounts.activeCount}/{debugCounts.sellableCount}</span></div>
             <div className="flex flex-col"><span className="font-bold">Store Available</span><span>{menuItems.filter(i => i.availableStoreIds?.includes(selectedStoreId)).length}</span></div>
          </div>
        )}

        {/* Search & Items Grid */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-4 flex flex-col">
          <div className="mb-3 shrink-0 overflow-x-auto custom-scrollbar">
            <div className="flex gap-2 min-w-max pb-1">
              <button
                type="button"
                onClick={() => setSelectedCategoryId('ALL')}
                className={`px-3 py-2 rounded-full border text-xs font-black uppercase tracking-wide transition-colors ${
                  selectedCategoryId === 'ALL'
                    ? 'bg-[#5c4033] border-[#5c4033] text-white'
                    : 'bg-white border-neutral-200 text-neutral-600 hover:border-[#5c4033]/30'
                }`}
              >
                All ({availableMenuItems.length})
              </button>
              {displayCategories.map(cat => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setSelectedCategoryId(cat.id)}
                  className={`px-3 py-2 rounded-full border text-xs font-black uppercase tracking-wide whitespace-nowrap transition-colors ${
                    selectedCategoryId === cat.id
                      ? 'bg-[#5c4033] border-[#5c4033] text-white'
                      : 'bg-white border-neutral-200 text-neutral-600 hover:border-[#5c4033]/30'
                  }`}
                >
                  {cat.name} {(cat as any).count !== undefined ? `(${(cat as any).count})` : ''}
                </button>
              ))}
            </div>
          </div>

          <div className="relative mb-4 shrink-0">
            <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search menu...  / to focus, Esc to clear"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-3 bg-white border border-neutral-200 rounded-xl shadow-sm focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033] outline-none font-medium"
            />
          </div>

          {fastItems.length > 0 && (
            <div className="mb-4 shrink-0">
              <div className="flex items-center justify-between gap-3 mb-2">
                <h3 className="text-sm font-black text-neutral-700 uppercase tracking-wider">Popular / Fast Items</h3>
                <span className="text-xs text-neutral-400 font-bold">Tap once to add</span>
              </div>
              <div className="overflow-x-auto custom-scrollbar">
                <div className="flex gap-2 min-w-max pb-1">
                  {fastItems.map((item: any) => (
                    <button
                      key={`fast_${item.id}`}
                      type="button"
                      onClick={() => addToCart(item)}
                      className="w-40 text-left bg-white border border-neutral-200 hover:border-[#5c4033]/40 hover:bg-[#fffaf4] rounded-xl p-3 shadow-sm transition-colors"
                    >
                      <p className="font-black text-sm text-neutral-800 line-clamp-2 leading-tight">{item.name}</p>
                      <p className="font-mono font-bold text-[#5c4033] mt-2">₹{item.price}</p>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="flex-1">
            {menuItems.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-neutral-400 p-6 text-center">
                <AlertCircle size={48} className="mb-4 opacity-30 text-amber-500" />
                <p className="font-bold text-lg text-neutral-600 mb-2">No active menu items found</p>
                <p className="text-sm border border-neutral-200 bg-white p-3 rounded-xl shadow-sm text-neutral-600 max-w-sm">
                  Go to <strong>Admin &rarr; Menu Import</strong> and click <strong>Restore All Menu Items Active</strong>.
                </p>
              </div>
            ) : filteredMenuItems.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-neutral-400 p-6 text-center">
                <Coffee size={48} className="mb-4 opacity-30 text-[#5c4033]" />
                <p className="font-medium text-lg text-neutral-600 mb-2">No items found</p>
                <p className="text-sm text-amber-700 bg-amber-50 p-4 border border-amber-200 rounded-xl max-w-md">
                  No Finished Goods are available for this store. Check <strong>Menu Management &rarr; Sellable Items</strong> and store availability.
                </p>
              </div>
            ) : (
              <div className="pb-32 lg:pb-4">
                {(() => {
                  const renderMenuItem = (item: any) => (
                    <motion.button
                      key={item.id}
                      whileHover={{ scale: 1.025, y: -2 }}
                      whileTap={{ scale: 0.975 }}
                      onClick={() => addToCart(item)}
                      className="bg-white border border-neutral-200 hover:border-[#5c4033]/40 p-4 rounded-xl shadow-sm hover:shadow-md active:scale-95 transition-all text-left flex flex-col h-full cursor-pointer"
                    >
                      <div className="flex justify-between items-start mb-2">
                        <span className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${
                          item.prepStation === 'BARISTA' ? 'bg-amber-100 text-amber-800' :
                          item.prepStation === 'KITCHEN' ? 'bg-blue-100 text-blue-800' :
                          item.prepStation === 'BOTH' ? 'bg-purple-100 text-purple-800' :
                          'bg-neutral-100 text-neutral-500'
                        }`}>
                          {item.prepStation === 'NONE' ? 'NO KOT' : item.prepStation}
                        </span>
                      </div>
                      <h4 className="font-bold text-neutral-800 leading-tight mb-auto">{item.name}</h4>
                      <p className="text-[#5c4033] font-bold mt-3 text-lg font-mono">₹{item.price}</p>
                    </motion.button>
                  );

                  if (selectedCategoryId !== 'ALL') {
                    const grouped = new Map<string, any[]>();
                    const sortedSubcats = new Map<string, {name: string, order: number}>();

                    filteredMenuItems.forEach((item: any) => {
                      const subCode = item.subcategoryCode || 'MISC';
                      const subName = item.subcategoryName || 'Other';
                      const subOrder = typeof item.subcategorySortOrder === 'number' ? item.subcategorySortOrder : 999;
                      if (!grouped.has(subCode)) {
                        grouped.set(subCode, []);
                        sortedSubcats.set(subCode, { name: subName, order: subOrder });
                      }
                      grouped.get(subCode)!.push(item);
                    });

                    const sortedSubCodes = Array.from(sortedSubcats.keys()).sort((a, b) => {
                      return sortedSubcats.get(a)!.order - sortedSubcats.get(b)!.order;
                    });

                    return sortedSubCodes.map(subCode => (
                      <div key={subCode} className="mb-6 last:mb-0">
                        {sortedSubcats.get(subCode)!.name && sortedSubcats.get(subCode)!.name !== 'Misc' && sortedSubcats.get(subCode)!.name !== 'Other' && (
                          <h3 className="text-sm font-bold text-neutral-500 uppercase tracking-wider mb-3 px-1">{sortedSubcats.get(subCode)!.name}</h3>
                        )}
                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3 md:gap-4">
                          {grouped.get(subCode)!.map(renderMenuItem)}
                        </div>
                      </div>
                    ));
                  }

                  return (
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3 md:gap-4">
                      {filteredMenuItems.map(renderMenuItem)}
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right Area: Cart Panel */}
      <div className={`lg:w-[360px] xl:w-[400px] shrink-0 bg-white border-l border-neutral-200 flex flex-col z-[100] lg:z-20 fixed lg:static inset-0 lg:inset-auto w-full h-[100dvh] lg:h-full transition-transform duration-300 transform overflow-hidden ${isMobileCartOpen ? 'translate-y-0' : 'translate-y-full lg:translate-y-0'}`}>

        {/* Cart Header */}
        <div className="p-4 pl-4 pr-3 border-b border-neutral-100 bg-[#faf8f5] shrink-0 sticky lg:static top-0 z-20 w-full">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xl font-black text-neutral-800">Current Order</h3>
            <div className="flex items-center justify-end gap-2 flex-wrap">
              {lastReceipt && (
                <button onClick={openLastReceipt} className="text-xs font-bold text-[#5c4033] hover:bg-[#5c4033]/10 px-2 py-2 md:py-1 rounded transition-colors uppercase tracking-wider">
                  Last Order
                </button>
              )}
              {cart.length > 0 && (
                <button onClick={holdCurrentBill} className="text-xs font-bold text-amber-700 hover:bg-amber-50 px-2 py-2 md:py-1 rounded transition-colors uppercase tracking-wider">
                  Hold Bill
                </button>
              )}
              {cart.length > 0 && (
                <button onClick={() => clearCart()} className="text-xs font-bold text-red-500 hover:bg-red-50 px-2 py-2 md:py-1 rounded transition-colors uppercase tracking-wider">
                  Clear Cart
                </button>
              )}
              <button onClick={() => setIsMobileCartOpen(false)} className="lg:hidden p-1.5 bg-neutral-200 text-neutral-600 hover:bg-neutral-300 rounded-full font-bold transition-colors">
                <X size={20} />
              </button>
            </div>
          </div>

          {heldBills.length > 0 && (
            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-black uppercase tracking-widest text-amber-700">Recall Bill</p>
                  <p className="text-[11px] text-amber-800">{heldBills.length} held {heldBills.length === 1 ? 'bill' : 'bills'} saved on this browser</p>
                </div>
                <span className="rounded-full bg-amber-200 px-2 py-0.5 text-xs font-black text-amber-900">{heldBills.length}</span>
              </div>
              <div className="mt-3 max-h-44 space-y-2 overflow-y-auto pr-1 custom-scrollbar">
                {heldBills.map(bill => (
                  <div key={bill.id} className="rounded-lg border border-amber-100 bg-white p-3 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-black text-neutral-800 break-words">{bill.customerName || 'Walk-in guest'}</p>
                        <p className="mt-0.5 text-xs font-medium text-neutral-500 break-words">
                          {bill.storeName}
                          {bill.tableNumber ? ` • Table ${bill.tableNumber}` : ''}
                          {` • ${bill.orderType.replace('_', ' ')}`}
                        </p>
                        <p className="mt-0.5 text-xs text-neutral-400">
                          {new Date(bill.heldAtIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} • {bill.itemCount} items • ₹{bill.total.toFixed(2)}
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button
                        onClick={() => recallHeldBill(bill)}
                        className="rounded-lg bg-[#5c4033] px-3 py-2 text-xs font-black uppercase tracking-wider text-white hover:bg-[#4a332a]"
                      >
                        Recall
                      </button>
                      <button
                        onClick={() => deleteHeldBill(bill)}
                        className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs font-black uppercase tracking-wider text-red-600 hover:bg-red-100"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Scrollable Body (Mobile) / Flex Container (Desktop) */}
        <div className="flex-1 overflow-y-auto lg:overflow-hidden flex flex-col w-full pb-28 lg:pb-0 custom-scrollbar min-h-0">

          {/* Order Details Inputs */}
          <div className="p-4 border-b border-neutral-100 bg-[#faf8f5] shrink-0">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
              {orderType === 'DINE_IN' && (
                <div className="col-span-1 sm:col-span-2 flex items-center gap-2 bg-white px-3 py-3 lg:py-2 border border-neutral-200 rounded-lg min-h-[44px]">
                  <MapPin size={16} className="text-neutral-400" />
                  <input
                    type="text"
                    placeholder="Table Number"
                    value={tableNumber}
                    onChange={e => setTableNumber(e.target.value)}
                    className="bg-transparent outline-none w-full font-medium placeholder-neutral-400"
                  />
                </div>
              )}
              <div className={`flex items-center gap-2 bg-white px-3 py-3 lg:py-2 border border-neutral-200 rounded-lg min-h-[44px] ${orderType !== 'DINE_IN' ? 'col-span-1 sm:col-span-2' : ''}`}>
                <User size={16} className="text-neutral-400 shrink-0" />
                <input
                  type="text"
                  placeholder="Name"
                  value={customerName}
                  onChange={e => setCustomerName(e.target.value)}
                  className="bg-transparent outline-none w-full font-medium placeholder-neutral-400"
                />
              </div>
              <div className={`flex items-center gap-2 bg-white px-3 py-3 lg:py-2 border border-neutral-200 rounded-lg min-h-[44px] ${orderType !== 'DINE_IN' ? 'col-span-1 sm:col-span-2' : ''}`}>
                <Phone size={16} className="text-neutral-400 shrink-0" />
                <input
                  type="tel"
                  placeholder="Phone"
                  value={customerPhone}
                  onChange={e => setCustomerPhone(e.target.value)}
                  className="bg-transparent outline-none w-full font-medium placeholder-neutral-400"
                />
              </div>
            </div>
          </div>

          {checkoutError && (
            <div className="mx-4 mt-4 bg-red-50 border border-red-200 text-red-900 rounded-xl p-4 text-sm shrink-0">
              <div className="flex gap-3">
                <AlertCircle size={20} className="shrink-0 mt-0.5 text-red-600" />
                <div className="min-w-0">
                  <p className="font-black">Checkout needs attention</p>
                  <p className="mt-1 font-medium">{checkoutError.message}</p>
                  {canViewCheckoutDebug && checkoutError.blockers && checkoutError.blockers.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {checkoutError.blockers.map((blocker, index) => (
                        <div key={`${blocker.itemCode}-${blocker.componentCode || 'item'}-${index}`} className="bg-white border border-red-100 rounded-lg p-3 min-w-0 overflow-hidden">
                          <div className="space-y-1">
                            <p className="text-[10px] font-black uppercase tracking-widest text-red-500">Item</p>
                            <p className="font-black text-red-800 break-words leading-snug">{blocker.itemName}</p>
                            <span className="inline-flex max-w-full text-[11px] font-mono bg-red-100 text-red-700 rounded px-2 py-0.5 break-words whitespace-normal">
                              {blocker.blockerType}
                            </span>
                          </div>
                          <div className="mt-3 space-y-2 text-xs text-red-900">
                            <div className="rounded-lg bg-red-50/70 p-2">
                              <p className="text-[10px] font-black uppercase tracking-widest text-red-500">Item code</p>
                              <p className="mt-0.5 font-mono break-words whitespace-normal leading-relaxed">{blocker.itemCode}</p>
                            </div>
                            <div className="rounded-lg bg-red-50/70 p-2">
                              <p className="text-[10px] font-black uppercase tracking-widest text-red-500">FG code</p>
                              <p className="mt-0.5 font-mono break-words whitespace-normal leading-relaxed">{blocker.finishedGoodCode || blocker.itemCode}</p>
                            </div>
                            <div className="rounded-lg bg-red-50/70 p-2">
                              <p className="text-[10px] font-black uppercase tracking-widest text-red-500">Component type/code</p>
                              <p className="mt-0.5 font-mono break-words whitespace-normal leading-relaxed">{blocker.componentType || 'ITEM'} / {blocker.componentCode || '-'}</p>
                            </div>
                            <div className="rounded-lg bg-red-50/70 p-2">
                              <p className="text-[10px] font-black uppercase tracking-widest text-red-500">Component name</p>
                              <p className="mt-0.5 break-words whitespace-normal leading-relaxed">{blocker.componentName || blocker.itemName}</p>
                            </div>
                            <div className="rounded-lg bg-red-50/70 p-2">
                              <p className="text-[10px] font-black uppercase tracking-widest text-red-500">Required quantity</p>
                              <p className="mt-0.5 font-mono break-words whitespace-normal leading-relaxed">{formatQuantity(blocker.requiredQuantity, blocker.unit)}</p>
                            </div>
                            <div className="rounded-lg bg-red-50/70 p-2">
                              <p className="text-[10px] font-black uppercase tracking-widest text-red-500">Available quantity</p>
                              <p className="mt-0.5 font-mono break-words whitespace-normal leading-relaxed">{formatQuantity(blocker.availableQuantity, blocker.unit)}</p>
                            </div>
                            <div className="rounded-lg bg-red-50/70 p-2">
                              <p className="text-[10px] font-black uppercase tracking-widest text-red-500">Store</p>
                              <p className="mt-0.5 break-words whitespace-normal leading-relaxed">{blocker.storeName}</p>
                            </div>
                            <div className="rounded-lg bg-red-50/70 p-2">
                              <p className="text-[10px] font-black uppercase tracking-widest text-red-500">confirmedZero</p>
                              <p className="mt-0.5 font-mono break-words whitespace-normal leading-relaxed">{blocker.confirmedZero === undefined ? 'n/a' : String(blocker.confirmedZero)}</p>
                            </div>
                          </div>
                          <div className="mt-3 rounded-lg border border-red-100 bg-red-50 p-3">
                            <p className="text-[10px] font-black uppercase tracking-widest text-red-500">Suggested admin action</p>
                            <p className="mt-1 text-xs font-bold text-red-900 break-words whitespace-normal leading-relaxed">{blocker.suggestedAdminAction}</p>
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
                      <pre className="mt-2 whitespace-pre-wrap break-words bg-white/80 border border-red-100 rounded-lg p-3 text-xs font-mono text-red-800">
                        {checkoutError.details}
                      </pre>
                    </details>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Cart Items List */}
          <div className="shrink-0 lg:flex-1 lg:overflow-y-auto custom-scrollbar p-4 space-y-3 min-h-max lg:min-h-0">
            {cart.length === 0 ? (
              <div className="h-full min-h-[200px] flex flex-col items-center justify-center text-center opacity-50 py-10">
                <div className="w-16 h-16 border-2 border-dashed border-neutral-400 rounded-full flex items-center justify-center mb-3">
                  <Coffee size={24} className="text-neutral-400" />
                </div>
                <p className="font-bold text-neutral-500">Cart is empty</p>
                <p className="text-sm text-neutral-400">Select items to start order</p>
              </div>
            ) : (
              <div className="space-y-3">
                <AnimatePresence initial={false} mode="popLayout">
                  {cart.map(item => (
                    <motion.div
                      key={item.id}
                      layout
                      initial={{ opacity: 0, x: 20, height: 0 }}
                      animate={{ opacity: 1, x: 0, height: "auto" }}
                      exit={{ opacity: 0, x: -20, height: 0 }}
                      transition={{ type: "spring" as const, stiffness: 500, damping: 40 }}
                      className="flex justify-between items-center py-2 border-b border-neutral-100 last:border-0 group gap-3 min-w-0"
                    >
                      <div className="flex flex-col flex-1 min-w-0">
                        <span className="font-bold text-neutral-800 text-sm line-clamp-2 leading-snug break-words">{item.name}</span>
                        <p className="text-xs text-neutral-400 font-mono mt-0.5">₹{item.price} each</p>
                      </div>
                      <div className="flex flex-col items-end shrink-0">
                        <span className="font-mono text-sm font-bold text-neutral-800 mb-1.5">
                          ₹{(item.price * item.quantity).toFixed(2)}
                        </span>
                        <div className="flex items-center gap-1.5 flex-nowrap">
                          <button
                            onClick={() => updateQuantity(item.id, -1)}
                            aria-label={item.quantity === 1 ? `Remove ${item.name}` : `Decrease ${item.name}`}
                            title={item.quantity === 1 ? `Remove ${item.name}` : `Decrease ${item.name}`}
                            className="p-1.5 bg-neutral-100 hover:bg-neutral-200 rounded-md text-neutral-600 transition-colors flex items-center justify-center cursor-pointer"
                          >
                            {item.quantity === 1 ? <Trash2 size={14} className="text-red-500" /> : <Minus size={14} />}
                          </button>
                          <span className="font-mono font-bold w-6 text-center text-sm">{item.quantity}</span>
                          <button
                            onClick={() => updateQuantity(item.id, 1)}
                            aria-label={`Increase ${item.name}`}
                            title={`Increase ${item.name}`}
                            className="p-1.5 bg-[#5c4033]/10 hover:bg-[#5c4033]/20 rounded-md text-[#5c4033] transition-colors flex items-center justify-center cursor-pointer"
                          >
                            <Plus size={14} />
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            )}
          </div>

          {/* Cart Footer (Totals & Payments) */}
          <div className="bg-white border-t border-neutral-200 flex flex-col shrink-0 lg:bg-neutral-50 shadow-[0_-4px_15px_rgba(0,0,0,0.05)] lg:shadow-none mt-auto lg:mt-0">
            <div className="px-4 lg:px-5 py-3 lg:py-4 space-y-2">
              <div className="flex justify-between text-sm font-medium text-neutral-500">
                <span>Subtotal</span>
                <span className="font-mono">₹{cartTotals.subtotal.toFixed(2)}</span>
              </div>

              <div className="flex justify-between items-center text-sm font-medium text-neutral-500 gap-3">
                <span>Discount (%)</span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  value={discountPercentStr}
                  onChange={e => setDiscountPercentStr(String(clampDiscountPercent(e.target.value)))}
                  className="w-20 text-right bg-white lg:bg-white border border-neutral-200 rounded px-2 py-1 font-mono outline-none focus:border-[#5c4033]"
                  placeholder="0"
                />
              </div>
              <div className={`rounded-lg border px-2 py-1 text-[11px] font-bold ${
                discountExceedsLimit
                  ? 'border-red-200 bg-red-50 text-red-700'
                  : 'border-neutral-100 bg-white text-neutral-400'
              }`}>
                Max discount for {staffProfile?.role || 'this role'}: {maxDiscountPercent}%
                {discountExceedsLimit && ` · Current discount ${cartTotals.discountPercent.toFixed(2)}% will be blocked`}
              </div>

              <div className="flex justify-between text-sm font-medium text-neutral-500">
                <span>Discount Amount</span>
                <span className="font-mono">-₹{cartTotals.discountAmount.toFixed(2)}</span>
              </div>

              <div className="flex justify-between text-sm font-medium text-neutral-500">
                <span>Taxable Amount</span>
                <span className="font-mono">₹{cartTotals.taxableAmount.toFixed(2)}</span>
              </div>

              <div className="flex justify-between text-sm font-medium text-neutral-500">
                <span>GST</span>
                <span className="font-mono">₹{cartTotals.taxTotal.toFixed(2)}</span>
              </div>
              {canViewCheckoutDebug && cartIsMissingGstConfig && (
                <p className="text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-2 py-1">
                  GST rate is not configured for this store/menu.
                </p>
              )}
              {canViewCheckoutDebug && selectedStoreTaxConfig.rate > 0 && (
                <p className="text-[11px] text-neutral-400">
                  GST fallback source: {selectedStoreTaxConfig.source} ({selectedStoreTaxConfig.rate}% when item tax is missing)
                </p>
              )}

              <div className="h-px bg-neutral-200 my-2" />

              <div className="flex justify-between items-end gap-2">
                <span className="font-black text-lg text-neutral-800 shrink-0">Total</span>
                <span className="font-black font-mono text-2xl text-[#3e2723] break-all text-right">₹{cartTotals.grandTotal.toFixed(2)}</span>
              </div>
            </div>

            <div className="px-4 pb-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <label className="block text-xs font-bold text-neutral-500 uppercase tracking-widest">Payment</label>
                <button
                  onClick={() => setSplitPaymentMode(!isSplitPayment)}
                  className={`rounded-full px-3 py-1 text-[11px] font-black uppercase tracking-wider border transition-colors ${
                    isSplitPayment
                      ? 'bg-[#5c4033] border-[#5c4033] text-white'
                      : 'bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-50'
                  }`}
                >
                  Split Payment
                </button>
              </div>

              {!isSplitPayment ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4 lg:mb-4">
                  {PAYMENT_METHODS.map(method => (
                    <button
                      key={method}
                      onClick={() => setPaymentMethod(method)}
                      className={`py-3 lg:py-2 px-1 text-[11px] lg:text-[10px] font-bold uppercase rounded-xl lg:rounded-md border transition-all h-full min-h-[44px] ${
                        paymentMethod === method
                          ? 'bg-[#5c4033] border-[#5c4033] text-white shadow-sm'
                          : 'bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-50'
                      }`}
                    >
                      <span className="truncate block mx-auto -tracking-wider uppercase">
                        {method === 'COMPLIMENTARY' ? 'COMP' : method}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="mb-4 rounded-xl border border-neutral-200 bg-white p-3 space-y-3">
                  <div className="space-y-2">
                    {splitPayments.map((payment, index) => (
                      <div key={payment.id} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
                        <select
                          value={payment.method}
                          onChange={event => updateSplitPayment(payment.id, { method: event.target.value as PaymentMethod })}
                          className="min-w-0 rounded-lg border border-neutral-200 bg-white px-2 py-2 text-xs font-bold text-neutral-700 outline-none focus:border-[#5c4033]"
                          aria-label={`Payment method ${index + 1}`}
                        >
                          {PAYMENT_METHODS.map(method => (
                            <option key={method} value={method}>{method}</option>
                          ))}
                        </select>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={payment.amountStr}
                          onChange={event => updateSplitPayment(payment.id, { amountStr: event.target.value })}
                          className="min-w-0 rounded-lg border border-neutral-200 bg-white px-2 py-2 text-right text-xs font-mono font-bold text-neutral-700 outline-none focus:border-[#5c4033]"
                          placeholder="0.00"
                          aria-label={`Payment amount ${index + 1}`}
                        />
                        <button
                          onClick={() => removeSplitPaymentRow(payment.id)}
                          disabled={splitPayments.length === 1}
                          className={`rounded-lg border px-2 py-2 text-xs font-black ${
                            splitPayments.length === 1
                              ? 'border-neutral-100 bg-neutral-50 text-neutral-300 cursor-not-allowed'
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
                    onClick={addSplitPaymentRow}
                    className="w-full rounded-lg border border-dashed border-[#5c4033]/40 bg-[#5c4033]/5 px-3 py-2 text-xs font-black uppercase tracking-wider text-[#5c4033] hover:bg-[#5c4033]/10"
                  >
                    Add Payment Row
                  </button>
                  <div className="space-y-1 rounded-lg bg-neutral-50 p-3 text-xs font-bold text-neutral-600">
                    <div className="flex justify-between">
                      <span>Total Due</span>
                      <span className="font-mono">₹{cartTotals.grandTotal.toFixed(2)}</span>
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

              {/* Desktop ONLY Order button (Mobile has sticky footer) */}
              <div className="hidden lg:block">
                <button
                  disabled={cart.length === 0 || isSaving}
                  className={`w-full py-4 rounded-xl font-black uppercase tracking-widest text-sm transition-all shadow-sm ${
                    (cart.length > 0 && !isSaving)
                      ? 'bg-[#3e2723] hover:bg-[#2d1c19] text-[#f9f5f0] hover:shadow-md active:scale-[0.99]'
                      : 'bg-neutral-200 text-neutral-400 cursor-not-allowed'
                  }`}
                  onClick={handleCheckout}
                >
                  {isSaving ? <Loader2 size={20} className="animate-spin mx-auto text-[#5c4033]" /> : 'Order & Pay'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile ONLY Sticky Checkout Footer */}
      {isMobileCartOpen && (
        <div className="lg:hidden fixed bottom-0 left-0 right-0 p-4 bg-white border-t border-neutral-200 z-[120] shadow-[0_-4px_15px_rgba(0,0,0,0.05)]" style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
          <button
            disabled={cart.length === 0 || isSaving}
            className={`w-full py-4 rounded-xl font-black uppercase tracking-widest text-sm transition-all shadow-[0_4px_14px_rgba(0,0,0,0.15)] ${
              (cart.length > 0 && !isSaving)
                ? 'bg-[#3e2723] hover:bg-[#2d1c19] text-[#f9f5f0] hover:shadow-md active:scale-[0.99] border border-[#2d1c19]'
                : 'bg-neutral-200 text-neutral-400 cursor-not-allowed border border-neutral-300'
            }`}
            onClick={handleCheckout}
          >
            {isSaving ? <Loader2 size={20} className="animate-spin mx-auto text-[#5c4033]" /> : (cart.length > 0 ? `Pay ₹${cartTotals.grandTotal.toFixed(2)}` : 'Cart Empty')}
          </button>
        </div>
      )}

      {/* Sticky Mobile Cart Bar */}
      {!isMobileCartOpen && cart.length > 0 && (
        <div className="lg:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-neutral-200 p-4 shadow-[0_-4px_15px_rgba(0,0,0,0.05)] z-30 pb-[calc(1rem+env(safe-area-inset-bottom))]">
           <button onClick={() => setIsMobileCartOpen(true)} className="w-full bg-[#3e2723] hover:bg-[#2d1c19] text-white py-3.5 rounded-xl font-black uppercase tracking-widest flex items-center justify-between px-5 shadow-sm transition-colors">
              <span className="flex items-center gap-2">
                <span className="bg-white/20 px-2.5 py-1 rounded-md text-xs">{cart.reduce((a,c)=>a+c.quantity, 0)} items</span>
              </span>
              <span className="text-lg">Checkout ₹{cartTotals.grandTotal.toFixed(2)}</span>
           </button>
        </div>
      )}

      {receiptView && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden flex flex-col max-h-[90vh]">
            <div className="bg-[#5c4033] p-6 text-center text-white shrink-0 relative">
               <CheckCircle size={48} className="mx-auto mb-3 text-emerald-400" />
               <h2 className="text-2xl font-black mb-1 tracking-tight">{receiptViewTitle}</h2>
               <p className="text-white/80 font-mono text-sm">{receiptView.order.orderNumber}</p>
            </div>

            {/* Printable Receipt Area */}
            <div id="receipt-area" className="p-6 bg-white flex-1 overflow-y-auto custom-scrollbar text-neutral-800 text-sm">
               <div className="text-center mb-6 border-b border-dashed border-neutral-300 pb-6">
                 <h1 className="text-xl font-black uppercase tracking-widest mb-1">Coffee Bond</h1>
                 <p className="font-bold text-neutral-600">{receiptView.order.storeName}</p>
                 <p className="text-neutral-500 mt-2 text-xs">{new Date(receiptView.order.createdAtIso).toLocaleString()}</p>
                 <p className="text-neutral-500 text-xs">Staff: {receiptView.order.createdByName}</p>
                 {receiptView.order.customerName && <p className="text-neutral-500 text-xs mt-1">Guest: {receiptView.order.customerName} {receiptView.order.customerPhone ? `(${receiptView.order.customerPhone})` : ''}</p>}
                 <p className="font-bold mt-3 border border-neutral-200 inline-block px-3 py-1 rounded-md">{receiptView.order.orderType.replace('_', ' ')} {receiptView.order.tableNumber ? `- Table ${receiptView.order.tableNumber}` : ''}</p>
               </div>

               <div className="space-y-3 mb-6 border-b border-dashed border-neutral-300 pb-6">
                 <div className="flex justify-between font-bold text-xs text-neutral-500 uppercase pb-1 border-b border-neutral-100">
                    <span>Item</span>
                    <span>Total</span>
                 </div>
                 {receiptView.items.map((item, i) => (
                   <div key={i} className="flex justify-between items-start text-sm">
                     <div>
                       <p className="font-bold leading-tight">{item.itemName}</p>
                       <p className="text-xs text-neutral-500 font-mono">{item.quantity} x ₹{item.unitPrice.toFixed(2)}</p>
                     </div>
                     <span className="font-bold font-mono">₹{item.lineTotal.toFixed(2)}</span>
                   </div>
                 ))}
               </div>

               <div className="space-y-2 mb-6 text-sm">
                 <div className="flex justify-between text-neutral-500">
                    <span>Subtotal</span>
                    <span className="font-mono text-neutral-800">₹{receiptView.order.subtotal.toFixed(2)}</span>
                 </div>
                 {receiptView.order.discountAmount > 0 && (
                   <div className="flex justify-between text-red-500">
                      <span>Discount ({receiptView.order.discountPercent.toFixed(2)}%)</span>
                      <span className="font-mono">-₹{receiptView.order.discountAmount.toFixed(2)}</span>
                   </div>
                 )}
                 <div className="flex justify-between text-neutral-500">
                    <span>Taxable Amount</span>
                    <span className="font-mono text-neutral-800">₹{receiptView.order.taxableAmount.toFixed(2)}</span>
                 </div>
                 <div className="flex justify-between text-neutral-500 pb-2 border-b border-neutral-100">
                    <span>GST</span>
                    <span className="font-mono text-neutral-800">₹{receiptView.order.gstTotal.toFixed(2)}</span>
                 </div>
                 <div className="flex justify-between font-black text-lg pt-1">
                    <span>Total Paid</span>
                    <span className="font-mono">₹{receiptView.order.grandTotal.toFixed(2)}</span>
                 </div>
               </div>

               <div className="text-xs font-bold text-neutral-500 mb-6">
                 {receiptView.order.isSplitPayment ? (
                   <div className="rounded-lg border border-neutral-100 p-3 space-y-1">
                     <p className="text-center uppercase tracking-widest text-neutral-400 mb-2">Split Payment</p>
                     {receiptView.payments.map((payment, index) => (
                       <div key={`${payment.method}-${index}`} className="flex justify-between">
                         <span>{payment.method}</span>
                         <span className="font-mono">₹{payment.amount.toFixed(2)}</span>
                       </div>
                     ))}
                   </div>
                 ) : (
                   <p className="text-center">Payment Method: {receiptView.order.paymentMethod}</p>
                 )}
                 <p className="text-center mt-2">{receiptView.order.paymentStatus || 'PAID'}</p>
               </div>

               <div className="text-center font-bold text-neutral-400 pt-4 border-t border-dashed border-neutral-300">
                 Thank you! Keep Brewing.
               </div>
            </div>

            <div className="p-4 bg-neutral-50 border-t border-neutral-200 grid grid-cols-2 gap-2 shrink-0">
               <button
                 onClick={printReceiptElement}
                 className="flex items-center justify-center gap-2 bg-white border border-neutral-200 hover:bg-neutral-100 text-neutral-700 font-bold py-3 rounded-xl transition-colors"
               >
                 <Printer size={18} /> Print
               </button>
               <button
                 onClick={() => setReceiptView(null)}
                 className="bg-[#5c4033] hover:bg-[#4a332a] text-white font-bold py-3 rounded-xl transition-colors"
               >
                 New Order
               </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
