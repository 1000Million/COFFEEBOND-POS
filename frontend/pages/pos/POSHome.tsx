import React, { useState, useEffect, useMemo, useRef } from 'react';
import { collection, query, getDocs, where, runTransaction, doc, serverTimestamp, getDoc, Timestamp } from 'firebase/firestore';
import { Link } from 'react-router-dom';
import { auth, db } from '../../lib/firebase';
import { useAuth } from '../../contexts/AuthContext';
import { Store, MenuItem, CartItem, OrderType, PaymentMethod, Order, OrderItem, OrderPayment } from '../../types';
import { InventoryDeductionBlocker, planInventoryDeductionForSale } from '../../lib/inventoryDeduction';
import { Loader2, Plus, Minus, Trash2, Search, Store as StoreIcon, User, Phone, MapPin, SearchX, Coffee, CheckCircle, Printer, AlertCircle, X } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

type CheckoutError = {
  message: string;
  details?: string;
  blockers?: CheckoutBlocker[];
};

type CheckoutBlocker = InventoryDeductionBlocker;

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
const RECENT_ITEMS_STORAGE_KEY = 'coffeeBondPos:recentItems:v1';
const RECENT_ITEMS_LIMIT = 8;
const PAYMENT_TOLERANCE = 0.01;
const PAYMENT_METHODS: PaymentMethod[] = ['CASH', 'UPI', 'CARD', 'SWIGGY', 'ZOMATO', 'CREDIT', 'COMPLIMENTARY'];
const POS_PRODUCT_FILTERS = [
  { id: 'ALL', label: 'All' },
  { id: 'FOOD', label: 'Food' },
  { id: 'DRINKS', label: 'Drinks' },
  { id: 'COFFEE', label: 'Coffee' },
  { id: 'RETAIL', label: 'Retail' },
] as const;
const ORDER_TYPE_LABELS: Record<OrderType, string> = {
  DINE_IN: 'Dine In',
  TAKEAWAY: 'Takeaway',
  DELIVERY: 'Delivery',
};
const QUICK_TABLE_CHIPS = ['1', '2', '3', '4'];

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

function normalizePosCategoryGroupName(item: Partial<MenuItem> & Record<string, unknown>): string {
  const raw = [
    item.categoryName,
    item.categoryId,
    item.code,
    item.name,
    item.description,
    item.subcategoryName,
    item.subcategoryCode,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (raw.includes('add on') || raw.includes('add-ons') || raw.includes('extra') || raw.includes('retail') || raw.includes('merch')) return 'Add Ons';
  if (raw.includes('dessert') || raw.includes('baked') || raw.includes('ice cream') || raw.includes('brownie') || raw.includes('cookie')) return 'Desserts';
  if (raw.includes('matcha') || raw.includes('tea') || raw.includes('manual brew') || raw.includes('herbal')) return 'Matcha & Tea';
  if (raw.includes('cold brew') || raw.includes('iced') || raw.includes('frappe') || raw.includes('shake') || raw.includes('cold coffee')) return 'Cold Coffee';
  if (raw.includes('coffee') || raw.includes('latte') || raw.includes('espresso') || raw.includes('cappuccino') || raw.includes('americano') || raw.includes('mocha') || raw.includes('brew') || raw.includes('black')) return 'Coffee';
  return 'Food';
}

function normalizePosSubcategoryFilter(item: Partial<MenuItem> & Record<string, unknown>): string {
  const raw = [
    item.categoryName,
    item.categoryId,
    item.code,
    item.name,
    item.description,
    item.subcategoryName,
    item.subcategoryCode,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (
    raw.includes('retail')
    || raw.includes('merch')
    || raw.includes('merchandise')
    || raw.includes('beans')
    || raw.includes('packaged')
    || raw.includes('ground coffee')
  ) {
    return 'RETAIL';
  }

  if (
    raw.includes('dessert')
    || raw.includes('baked')
    || raw.includes('brownie')
    || raw.includes('cookie')
    || raw.includes('cake')
    || raw.includes('sandwich')
    || raw.includes('salad')
    || raw.includes('pizza')
    || raw.includes('bowl')
    || raw.includes('bread')
    || raw.includes('bakery')
    || raw.includes('waffle')
    || raw.includes('croissant')
    || raw.includes('food')
  ) {
    return 'FOOD';
  }

  if (
    raw.includes('smoothie')
    || raw.includes('shake')
    || raw.includes('juice')
    || raw.includes('cooler')
    || raw.includes('lemonade')
    || raw.includes('fizz')
    || raw.includes('soda')
    || raw.includes('protein')
    || raw.includes('chocolate')
    || raw.includes('tea')
    || raw.includes('non-coffee')
  ) {
    return 'DRINKS';
  }

  if (
    raw.includes('coffee')
    || raw.includes('latte')
    || raw.includes('espresso')
    || raw.includes('cappuccino')
    || raw.includes('americano')
    || raw.includes('mocha')
    || raw.includes('macchiato')
    || raw.includes('affogato')
    || raw.includes('brew')
    || raw.includes('matcha')
    || raw.includes('flat white')
    || raw.includes('ristretto')
  ) {
    return 'COFFEE';
  }

  return 'FOOD';
}

function posTabLabel(category: string): string {
  if (category === 'ALL') return 'All';
  if (category === 'FAVOURITES') return 'Favourites';
  if (category === 'Cold Coffee') return 'Cold';
  if (category === 'Matcha & Tea') return 'Matcha';
  return category;
}

function menuTileTone(category: string): { badge: string; panel: string; icon: string } {
  switch (category) {
    case 'Coffee':
      return {
        badge: 'bg-[#3e2723] text-white',
        panel: 'bg-[#f4e6d8]',
        icon: 'text-[#5c4033]',
      };
    case 'Cold Coffee':
      return {
        badge: 'bg-[#e6f1f6] text-[#24526a]',
        panel: 'bg-[#eef7fb]',
        icon: 'text-[#24526a]',
      };
    case 'Matcha & Tea':
      return {
        badge: 'bg-[#edf6ec] text-[#3f6a4a]',
        panel: 'bg-[#f5fbf3]',
        icon: 'text-[#3f6a4a]',
      };
    case 'Desserts':
      return {
        badge: 'bg-[#f8ece8] text-[#8a4f3b]',
        panel: 'bg-[#fff7f3]',
        icon: 'text-[#8a4f3b]',
      };
    case 'Add Ons':
      return {
        badge: 'bg-[#f3efe9] text-[#6d584a]',
        panel: 'bg-[#faf7f2]',
        icon: 'text-[#6d584a]',
      };
    default:
      return {
        badge: 'bg-[#f3efe9] text-[#6d584a]',
        panel: 'bg-[#fbf7f1]',
        icon: 'text-[#6d584a]',
      };
  }
}

function prepStationLabel(prepStation?: string | null): string {
  if (prepStation === 'BARISTA') return 'Barista';
  if (prepStation === 'KITCHEN') return 'Kitchen';
  if (prepStation === 'BOTH') return 'Bar + Kitchen';
  return 'Ready to bill';
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

function loadStoredRecentItems(): Record<string, string[]> {
  const recentItems = readLocalStorageJson<Record<string, string[]>>(RECENT_ITEMS_STORAGE_KEY, {});
  return recentItems && typeof recentItems === 'object' && !Array.isArray(recentItems) ? recentItems : {};
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
  const recallMenuRef = useRef<HTMLDivElement | null>(null);

  const [orderType, setOrderType] = useState<OrderType>('DINE_IN');
  const [tableNumber, setTableNumber] = useState('');
  const [tableNumberError, setTableNumberError] = useState<string | null>(null);
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
  const [recentItemIdsByStore, setRecentItemIdsByStore] = useState<Record<string, string[]>>({});
  const [topSellerItemIds, setTopSellerItemIds] = useState<string[]>([]);
  const [isUsingTopSellerData, setIsUsingTopSellerData] = useState(false);

  const posSource = 'FINISHED_GOODS' as const;

  const [debugCounts, setDebugCounts] = useState<any>(null);
  const [isMobileCartOpen, setIsMobileCartOpen] = useState(false);
  const [isRecallMenuOpen, setIsRecallMenuOpen] = useState(false);

  useEffect(() => {
    fetchData();
    fetchMenuData();
    fetchTaxConfig();
  }, []);

  useEffect(() => {
    setLastReceipt(readLocalStorageJson<ReceiptSnapshot | null>(LAST_RECEIPT_STORAGE_KEY, null));
    setHeldBills(loadStoredHeldBills());
    setRecentItemIdsByStore(loadStoredRecentItems());
  }, []);

  useEffect(() => {
    if (!loading) {
      const timer = window.setTimeout(() => searchInputRef.current?.focus(), 100);
      return () => window.clearTimeout(timer);
    }
  }, [loading, selectedStoreId]);

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
        setTableNumberError(null);
        setIsRecallMenuOpen(false);
        setSelectedStoreId(e.target.value);
      }
    } else {
      setCheckoutError(null);
      setTableNumberError(null);
      setIsRecallMenuOpen(false);
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

  const topFeaturedItems = useMemo(() => {
    const rankedItems = topSellerItemIds
      .map(itemId => availableMenuItems.find(item => item.id === itemId))
      .filter(Boolean) as MenuItem[];

    if (isUsingTopSellerData && rankedItems.length > 0) {
      return rankedItems.slice(0, 4);
    }

    return fastItems.slice(0, 4);
  }, [availableMenuItems, fastItems, isUsingTopSellerData, topSellerItemIds]);

  useEffect(() => {
    let active = true;

    const loadTopSellers = async () => {
      if (!selectedStoreId || availableMenuItems.length === 0) {
        if (active) {
          setTopSellerItemIds([]);
          setIsUsingTopSellerData(false);
        }
        return;
      }

      try {
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const ordersSnap = await getDocs(query(
          collection(db, 'orders'),
          where('storeId', '==', selectedStoreId),
          where('createdAt', '>=', Timestamp.fromDate(sevenDaysAgo)),
        ));

        const completedOrders = ordersSnap.docs
          .map(orderDoc => ({ id: orderDoc.id, ...orderDoc.data() } as Order))
          .filter(order => order.status !== 'VOIDED' && order.status !== 'CANCELLED');

        if (completedOrders.length === 0) {
          if (active) {
            setTopSellerItemIds([]);
            setIsUsingTopSellerData(false);
          }
          return;
        }

        const salesByItemId = new Map<string, number>();

        await Promise.all(completedOrders.map(async order => {
          if (!order.id) return;
          const itemSnap = await getDocs(collection(db, 'orders', order.id, 'items'));
          itemSnap.docs.forEach(itemDoc => {
            const item = itemDoc.data() as OrderItem;
            const itemId = String(item.menuItemId || item.finishedGoodCode || item.itemCode || '').trim();
            if (!itemId) return;
            const quantity = Number(item.quantity) || 0;
            salesByItemId.set(itemId, (salesByItemId.get(itemId) || 0) + quantity);
          });
        }));

        const rankedItemIds = [...availableMenuItems]
          .filter(item => (salesByItemId.get(item.id) || 0) > 0)
          .sort((a, b) => {
            const salesDelta = (salesByItemId.get(b.id) || 0) - (salesByItemId.get(a.id) || 0);
            if (salesDelta !== 0) return salesDelta;

            const orderA = typeof (a as any).sortOrder === 'number' ? (a as any).sortOrder : 999;
            const orderB = typeof (b as any).sortOrder === 'number' ? (b as any).sortOrder : 999;
            if (orderA !== orderB) return orderA - orderB;

            return (a.name || '').localeCompare(b.name || '');
          })
          .slice(0, 4)
          .map(item => item.id);

        if (!active) return;

        setTopSellerItemIds(rankedItemIds);
        setIsUsingTopSellerData(rankedItemIds.length > 0);
      } catch (error) {
        console.warn('Unable to load top sellers for POS, using fallback picks instead.', error);
        if (active) {
          setTopSellerItemIds([]);
          setIsUsingTopSellerData(false);
        }
      }
    };

    void loadTopSellers();

    return () => {
      active = false;
    };
  }, [availableMenuItems, selectedStoreId]);

  useEffect(() => {
    const isValid = POS_PRODUCT_FILTERS.some(filter => filter.id === selectedCategoryId);
    if (!isValid) {
      setSelectedCategoryId('ALL');
    }
  }, [selectedCategoryId]);

  const filteredMenuItems = useMemo(() => {
    const scopedItems = availableMenuItems.filter(item => {
      if (selectedCategoryId === 'ALL') return true;
      return normalizePosSubcategoryFilter(item as any) === selectedCategoryId;
    });

    return scopedItems.filter(item => {
      if (!searchQuery.trim()) return true;
      const queryLower = searchQuery.toLowerCase();
      const haystack = [
        item.name,
        item.code,
        (item as any).finishedGoodCode,
        item.categoryName,
        item.description,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(queryLower);
    });
  }, [availableMenuItems, searchQuery, selectedCategoryId]);

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

    rememberRecentItem(itemId);

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
      setIsRecallMenuOpen(false);
      setDiscountPercentStr('');
      setPaymentMethod('');
      setIsSplitPayment(false);
      setSplitPayments([]);
      setCustomerName('');
      setCustomerPhone('');
      setTableNumber('');
      setTableNumberError(null);
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
  const cartItemCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const selectedStore = stores.find(store => store.id === selectedStoreId);
  const selectedProductFilter = POS_PRODUCT_FILTERS.find(filter => filter.id === selectedCategoryId);
  const productGridHeading = searchQuery.trim() ? 'Search results' : (selectedProductFilter?.label || 'All items');
  const productGridSubheading = searchQuery.trim()
    ? `${filteredMenuItems.length} ${filteredMenuItems.length === 1 ? 'item' : 'items'} match "${searchQuery.trim()}"`
    : `${filteredMenuItems.length} ${filteredMenuItems.length === 1 ? 'item' : 'items'} ready to bill`;
  const featuredHeading = isUsingTopSellerData ? 'Top sellers last 7 days' : 'Top picks';
  const featuredSubheading = isUsingTopSellerData
    ? 'Based on completed sales for this store'
    : 'Fast favourites for quick billing';

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
    setIsRecallMenuOpen(false);
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
    setTableNumberError(bill.orderType === 'DINE_IN' && !bill.tableNumber.trim() ? 'Table number is required for dine in orders.' : null);
    setIsRecallMenuOpen(false);
    persistHeldBills(heldBills.filter(held => held.id !== bill.id));
    setIsMobileCartOpen(true);
  };

  const deleteHeldBill = (bill: HeldBill) => {
    const label = bill.customerName || bill.tableNumber || bill.storeName;
    if (!window.confirm(`Delete held bill for ${label}?`)) return;
    setIsRecallMenuOpen(false);
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

  const handleCheckout = async (paymentMethodOverride?: PaymentMethod) => {
    const selectedPaymentMethod = !isSplitPayment && paymentMethodOverride ? paymentMethodOverride : paymentMethod;

    if (!staffProfile || !auth.currentUser) return;
    if (cart.length === 0) return alert("Cart is empty");
    if (!selectedStoreId) return alert("Please select a store");
    if (!isSplitPayment && !selectedPaymentMethod) return alert("Please select a payment method");
    if (isSplitPayment && splitPayments.length === 0) return alert("Please add at least one payment row");
    if (orderType === 'DINE_IN' && !tableNumber.trim()) {
      setTableNumberError('Table number is required for dine in orders.');
      return;
    }

    setTableNumberError(null);

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
          method: selectedPaymentMethod as PaymentMethod,
          amount: selectedPaymentMethod === 'CREDIT' ? 0 : trueGrandTotal,
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
      const orderLineRefs = validatedCart.map(() => doc(collection(newOrderRef, 'items')));

      if (import.meta.env.DEV) console.log(`[CHECKOUT] Preflight complete. target counter: ${counterId}, order: ${newOrderRef.id}`);

      const { savedOrder, savedItems, savedPayments } = await runTransaction(db, async (transaction) => {
        // --- READ PHASE ONLY ---
        if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction: get counter`);
        const counterDoc = await transaction.get(counterRef);

        let custDoc: any = null;
        if (custRef) {
          if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction: get customer doc`);
          custDoc = await transaction.get(custRef);
        }

        let seq = 1;
        if (counterDoc.exists()) {
          seq = (counterDoc.data()?.lastSequence || 0) + 1;
        }

        const orderNumber = `CB-${selectedStore.code}-${dateKey}-${seq.toString().padStart(4, '0')}`;
        if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction validation complete - order number generated: ${orderNumber}`);
        const deductionPlan = await planInventoryDeductionForSale({
          transaction,
          store: selectedStore,
          orderId: newOrderRef.id,
          orderNumber,
          businessDate: dateKey,
          source: 'POS',
          staffProfile: {
            uid: auth.currentUser!.uid,
            name: staffProfile.name,
          },
          lines: validatedCart.map(({ cartItem, liveItem }, index) => {
            const liveItemData = liveItem as unknown as Record<string, unknown>;
            return {
              lineKey: orderLineRefs[index].id,
              quantity: cartItem.quantity,
              finishedGood: {
                ...liveItemData,
                code: liveItem.code,
                name: liveItem.name,
                itemType: liveItemData.itemType || cartItem.itemType || 'DIRECT_STOCK',
                bom: Array.isArray(liveItemData.bom)
                  ? liveItemData.bom
                  : (Array.isArray(cartItem.bom) ? cartItem.bom : []),
                finishedGoodCode: liveItemData.finishedGoodCode || cartItem.finishedGoodCode || liveItem.code,
              } as any,
            };
          }),
        });

        if (deductionPlan.blockers.length > 0) {
          throw new CheckoutBlockerError(deductionPlan.blockers);
        }

        if (import.meta.env.DEV && deductionPlan.warnings.length > 0) {
          console.warn('[CHECKOUT INVENTORY WARNINGS]', deductionPlan.warnings);
        }

        if (import.meta.env.DEV) console.log(`[CHECKOUT] Transaction read phase complete`);

        // --- WRITE PHASE ONLY ---
        deductionPlan.stockUpdates.forEach((update) => {
          if (update.existed) {
            transaction.update(update.stockRef, {
              currentStock: update.newQty,
              updatedAt: serverTimestamp(),
            });
            return;
          }

          transaction.set(update.stockRef, {
            ...update.seedData,
            currentStock: update.newQty,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        });
        deductionPlan.movementPayloads.forEach((movement) => {
          transaction.set(doc(collection(db, 'stockMovements')), movement);
        });

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
          : (selectedPaymentMethod === 'CREDIT' && trueGrandTotal > 0) ? 'UNPAID' : 'PAID';

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
          cogsTotal: deductionPlan.totalCogs,
          inventoryWarningCount: deductionPlan.warnings.length,
          inventoryWarnings: deductionPlan.warnings.map((warning) => warning.message),
          stockMovementCount: deductionPlan.movementPayloads.length,
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
        validatedCart.forEach(({ cartItem: item, liveItem }, index) => {
          const lineRef = orderLineRefs[index];
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
            cogsAmount: deductionPlan.perLineCogs[lineRef.id] || 0,
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
            method: selectedPaymentMethod as PaymentMethod,
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
      if (savedOrder.inventoryWarnings?.length) {
        console.warn('[CHECKOUT INVENTORY WARNINGS RECORDED]', savedOrder.inventoryWarnings);
      }

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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
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
        searchInputRef.current?.focus();
        return;
      }

      if (event.key === 'Enter' && document.activeElement === searchInputRef.current && filteredMenuItems.length > 0 && searchQuery.trim()) {
        event.preventDefault();
        addToCart(filteredMenuItems[0]);
        setSearchQuery('');
        searchInputRef.current?.focus();
        return;
      }

      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !isTyping && cart.length > 0 && !isSaving) {
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
    filteredMenuItems,
    isMobileCartOpen,
    isSaving,
    isSplitPayment,
    paymentMethod,
    receiptView,
    searchQuery,
  ]);

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
    <div className="relative flex h-[calc(100dvh-72px)] w-full min-w-0 max-w-full flex-none flex-col overflow-hidden bg-[#f5efe6] pb-[env(safe-area-inset-bottom)] lg:h-[calc(100dvh-92px)] lg:pb-0">
      <div className="shrink-0 border-b border-[#eadfd4] bg-white/95 px-3 py-2 shadow-sm backdrop-blur sm:px-4">
        <div className="overflow-x-auto custom-scrollbar">
          <div className="flex min-w-max items-center gap-2 whitespace-nowrap pb-1">
            <div className="flex min-w-0 items-center gap-2 rounded-2xl border border-[#eadfd4] bg-[#fbf8f3] px-3 py-1.5">
              <StoreIcon size={15} className="shrink-0 text-[#5c4033]" />
              <select
                value={selectedStoreId}
                onChange={handleStoreChange}
                className="min-w-[180px] bg-transparent text-sm font-black text-[#2d1c19] outline-none lg:min-w-[190px]"
                aria-label="Select POS store"
              >
                {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>

            <div className="flex items-center rounded-2xl border border-[#eadfd4] bg-[#fbf8f3] p-1">
              {(['DINE_IN', 'TAKEAWAY', 'DELIVERY'] as OrderType[]).map(type => (
                <button
                  key={type}
                  type="button"
                  onClick={() => {
                    setOrderType(type);
                    if (type !== 'DINE_IN') setTableNumberError(null);
                  }}
                  className={`min-h-[34px] whitespace-nowrap rounded-xl px-3 text-sm font-black transition-all ${
                    orderType === type
                      ? 'bg-[#3e2723] text-white shadow-sm'
                      : 'text-neutral-600 hover:bg-white hover:text-[#2d1c19]'
                  }`}
                >
                  {ORDER_TYPE_LABELS[type]}
                </button>
              ))}
            </div>

            <Link
              to="/pos/running-orders"
              className="inline-flex min-h-[36px] items-center justify-center rounded-2xl border border-[#3e2723]/15 bg-white px-3 text-sm font-black text-[#3e2723] transition hover:bg-[#fff8ed]"
            >
              Running Orders
            </Link>
            {isAdmin && (
              <Link
                to="/admin/pos-readiness"
                title={debugCounts ? `${debugCounts.mappedCount} menu items ready for POS checks` : 'Open POS readiness'}
                className="inline-flex min-h-[36px] items-center justify-center rounded-2xl border border-[#eadfd4] bg-[#fbf8f3] px-3 text-sm font-bold text-neutral-600 transition hover:bg-white hover:text-[#3e2723]"
              >
                POS Readiness
              </Link>
            )}
          </div>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,1fr)_380px] xl:grid-cols-[minmax(0,1fr)_420px]">
      {/* Menu Area */}
      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden border-b border-[#eadfd4] lg:border-b-0 lg:border-r">
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-24 pt-3 custom-scrollbar sm:px-4 lg:px-5">
          <div className="space-y-3 pb-32 lg:pb-6">
            <div className="rounded-3xl border border-[#e8ddd2] bg-white p-3 shadow-[0_10px_24px_rgba(62,39,35,0.05)]">
              <div className="relative min-w-0">
                <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-neutral-400" />
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder="Search coffee, food, desserts..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="min-h-[46px] w-full rounded-2xl border border-[#eadfd4] bg-[#fcfaf7] pl-11 pr-4 text-sm font-semibold text-neutral-800 outline-none transition focus:border-[#5c4033] focus:ring-4 focus:ring-[#5c4033]/10"
                />
              </div>
            </div>

            {topFeaturedItems.length > 0 && (
              <div className="rounded-3xl border border-[#e8ddd2] bg-white p-3 shadow-[0_10px_24px_rgba(62,39,35,0.05)]">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-black tracking-tight text-[#2d1c19]">{featuredHeading}</h2>
                    <p className="truncate text-[11px] font-semibold text-neutral-500">{featuredSubheading}</p>
                  </div>
                  <span className="text-[11px] font-bold text-neutral-400">{topFeaturedItems.length}</span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
                  {topFeaturedItems.map((item: any) => {
                    const categoryGroup = normalizePosCategoryGroupName(item);
                    return (
                      <button
                        key={`top_${item.id}`}
                        type="button"
                        onClick={() => addToCart(item)}
                        className="group rounded-3xl border border-[#eadfd4] bg-[#fcfaf7] p-3 text-left transition hover:border-[#5c4033]/25 hover:bg-[#fff8ed]"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className={`rounded-full px-2 py-1 text-[9px] font-black ${menuTileTone(categoryGroup).badge}`}>
                            {posTabLabel(categoryGroup)}
                          </span>
                          <Plus size={14} className="text-[#5c4033]" strokeWidth={2.8} />
                        </div>
                        <h3 className="mt-3 line-clamp-2 text-[13px] font-black leading-snug text-[#2d1c19]">{item.name}</h3>
                        <p className="mt-2 font-mono text-sm font-black text-[#3e2723]">₹{item.price}</p>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="overflow-x-auto custom-scrollbar">
              <div className="flex min-w-max gap-2 pb-1">
                {POS_PRODUCT_FILTERS.map(filter => (
                  <button
                    key={filter.id}
                    type="button"
                    onClick={() => setSelectedCategoryId(filter.id)}
                    className={`inline-flex min-h-[36px] items-center rounded-2xl border px-3 text-sm font-black transition-colors ${
                      selectedCategoryId === filter.id
                        ? 'border-[#3e2723] bg-[#3e2723] text-white'
                        : 'border-[#eadfd4] bg-white text-neutral-600 hover:border-[#5c4033]/30 hover:text-[#3e2723]'
                    }`}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
            </div>

            {menuItems.length === 0 ? (
              <div className="flex min-h-[280px] flex-col items-center justify-center rounded-[28px] border border-dashed border-[#dccfc2] bg-white px-6 py-8 text-center text-neutral-500">
                <AlertCircle size={44} className="mb-4 text-amber-500/70" />
                <p className="text-lg font-black text-neutral-700">No active menu items found</p>
                <p className="mt-2 max-w-sm text-sm font-medium text-neutral-500">
                  An Admin can restore active finished goods from Menu Management before billing starts here.
                </p>
              </div>
            ) : filteredMenuItems.length === 0 ? (
              <div className="flex min-h-[260px] flex-col items-center justify-center rounded-[28px] border border-dashed border-[#dccfc2] bg-white px-6 py-8 text-center text-neutral-500">
                <Coffee size={42} className="mb-4 text-[#8a6a58]/70" />
                <p className="text-lg font-black text-neutral-700">No items match this view</p>
                <p className="mt-2 max-w-sm text-sm font-medium text-neutral-500">
                  Try a different filter, clear the search, or review POS Readiness if this store should have more items.
                </p>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3 px-1">
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-black tracking-tight text-[#2d1c19]">{productGridHeading}</h2>
                    <p className="truncate text-[11px] font-semibold text-neutral-500">{productGridSubheading}</p>
                  </div>
                  <span className="text-[11px] font-bold text-neutral-400">{filteredMenuItems.length}</span>
                </div>

                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                  {filteredMenuItems.map((item: any) => {
                    const categoryGroup = normalizePosCategoryGroupName(item);
                    const tone = menuTileTone(categoryGroup);
                    return (
                      <motion.button
                        key={item.id}
                        whileHover={{ scale: 1.015, y: -2 }}
                        whileTap={{ scale: 0.985 }}
                        onClick={() => addToCart(item)}
                        className="group flex min-h-[102px] min-w-0 flex-col justify-between rounded-3xl border border-[#eadfd4] bg-white p-3 text-left shadow-[0_6px_16px_rgba(62,39,35,0.05)] transition-all hover:border-[#5c4033]/25 hover:bg-[#fffaf4]"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className={`rounded-full px-2 py-1 text-[9px] font-black ${tone.badge}`}>
                            {posTabLabel(categoryGroup)}
                          </span>
                          <Plus size={14} className={tone.icon} strokeWidth={2.8} />
                        </div>
                        <div className="min-w-0 flex-1 pt-2">
                          <h4 className="line-clamp-2 text-[13px] font-black leading-snug text-[#2d1c19]">{item.name}</h4>
                        </div>
                        <div className="flex items-end justify-between gap-2 pt-2">
                          <p className="font-mono text-[15px] font-black text-[#3e2723]">₹{item.price}</p>
                          {item.prepStation && item.prepStation !== 'NONE' && (
                            <span className="rounded-full bg-neutral-100 px-2 py-1 text-[9px] font-black text-neutral-500">
                              {prepStationLabel(item.prepStation)}
                            </span>
                          )}
                        </div>
                      </motion.button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Right Area: Current Sale */}
      <div className={`fixed inset-0 z-[100] flex h-[100dvh] w-full max-w-full shrink-0 transform flex-col overflow-hidden border-l border-[#eadfd4] bg-[#fcfaf7] shadow-2xl transition-transform duration-300 lg:static lg:z-20 lg:h-full lg:w-[380px] lg:translate-y-0 lg:shadow-none xl:w-[420px] ${isMobileCartOpen ? 'translate-y-0' : 'translate-y-full lg:translate-y-0'}`}>
        <div
          className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-3 custom-scrollbar sm:px-4 lg:px-4"
          style={isMobileCartOpen ? { paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' } : undefined}
        >
          <div className="border-b border-[#eadfd4] pb-3">
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <h3 className="min-w-0 text-[15px] font-black tracking-tight text-[#2d1c19] sm:text-base">Current Sale</h3>
                  <p className="text-[11px] font-semibold text-neutral-500">
                    {[
                      ORDER_TYPE_LABELS[orderType],
                      cartItemCount > 0 ? `${cartItemCount} ${cartItemCount === 1 ? 'item' : 'items'}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
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
                  onClick={() => setIsMobileCartOpen(false)}
                  className="rounded-full bg-neutral-200 p-1.5 font-bold text-neutral-600 transition-colors hover:bg-neutral-300 lg:hidden"
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
                      onClick={holdCurrentBill}
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

          <div className="mt-3">
            {cart.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[#eadfd4] bg-[#fbf8f3] px-4 py-3 text-center">
                <p className="text-xs font-semibold text-neutral-500">Tap a tile to start.</p>
              </div>
            ) : (
              <div className="divide-y divide-[#efe4d9] border-y border-[#efe4d9]">
                <AnimatePresence initial={false} mode="popLayout">
                  {cart.map(item => (
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
                            <span>₹{item.price} each</span>
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="font-mono text-sm font-black text-[#3e2723]">₹{(item.price * item.quantity).toFixed(2)}</p>
                          <button
                            onClick={() => updateQuantity(item.id, -item.quantity)}
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
                            onClick={() => updateQuantity(item.id, -1)}
                            aria-label={item.quantity === 1 ? `Remove ${item.name}` : `Decrease ${item.name}`}
                            title={item.quantity === 1 ? `Remove ${item.name}` : `Decrease ${item.name}`}
                            className="flex h-7 w-7 items-center justify-center rounded-full text-neutral-600 transition-colors hover:bg-neutral-100"
                          >
                            {item.quantity === 1 ? <Trash2 size={14} className="text-red-500" /> : <Minus size={14} />}
                          </button>
                          <span className="w-8 text-center font-mono text-sm font-black text-[#2d1c19]">{item.quantity}</span>
                          <button
                            onClick={() => updateQuantity(item.id, 1)}
                            aria-label={`Increase ${item.name}`}
                            title={`Increase ${item.name}`}
                            className="flex h-7 w-7 items-center justify-center rounded-full text-[#5c4033] transition-colors hover:bg-[#5c4033]/10"
                          >
                            <Plus size={14} />
                          </button>
                        </div>
                        <button
                          onClick={() => updateQuantity(item.id, item.quantity)}
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
                      onChange={e => {
                        setTableNumber(e.target.value);
                        if (e.target.value.trim()) setTableNumberError(null);
                      }}
                      onBlur={() => {
                        if (orderType === 'DINE_IN' && !tableNumber.trim()) {
                          setTableNumberError('Table number is required for dine in orders.');
                        }
                      }}
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
                        onClick={() => {
                          setOrderType('DINE_IN');
                          setTableNumber(tableChip);
                          setTableNumberError(null);
                        }}
                        className="rounded-full border border-[#eadfd4] bg-white px-3 py-1.5 text-[10px] font-black text-[#5c4033] transition hover:bg-[#fff8ed]"
                      >
                        Table {tableChip}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        setOrderType('TAKEAWAY');
                        setTableNumber('');
                        setTableNumberError(null);
                      }}
                      className="rounded-full border border-[#eadfd4] bg-white px-3 py-1.5 text-[10px] font-black text-[#5c4033] transition hover:bg-[#fff8ed]"
                    >
                      Takeaway
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[11px] font-black uppercase tracking-[0.14em] text-[#8a6a58]">Customer</p>
                  <button
                    type="button"
                    onClick={() => {
                      setCustomerName('Walk-in');
                      setCustomerPhone('');
                    }}
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
                  <div className="flex min-h-[40px] items-center gap-2 rounded-full border border-[#eadfd4] bg-white px-3 py-2">
                    <Phone size={15} className="shrink-0 text-neutral-400" />
                    <input
                      type="tel"
                      placeholder="Phone"
                      value={customerPhone}
                      onChange={e => setCustomerPhone(e.target.value)}
                      className="w-full bg-transparent text-sm font-medium outline-none placeholder-neutral-400"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {checkoutError && (
            <div className="mt-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900 shadow-sm">
              <div className="flex gap-3">
                <AlertCircle size={20} className="mt-0.5 shrink-0 text-red-600" />
                <div className="min-w-0">
                  <p className="font-black">Checkout needs attention</p>
                  <p className="mt-1 font-medium">{checkoutError.message}</p>
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

          <div className="mt-3 space-y-1.5 border-t border-[#eadfd4] pt-3">
            <div className="flex justify-between text-[13px] font-medium text-neutral-500">
              <span>Subtotal</span>
              <span className="font-mono">₹{cartTotals.subtotal.toFixed(2)}</span>
            </div>

            <div className="flex items-center justify-between gap-3 text-[13px] font-medium text-neutral-500">
              <span>Discount (%)</span>
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={discountPercentStr}
                onChange={e => setDiscountPercentStr(String(clampDiscountPercent(e.target.value)))}
                className="w-18 rounded-full border border-[#eadfd4] bg-white px-3 py-1.5 text-right font-mono text-[13px] outline-none focus:border-[#5c4033]"
                placeholder="0"
              />
            </div>
            {discountExceedsLimit && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] font-bold text-red-700">
                Max discount for {staffProfile?.role || 'this role'}: {maxDiscountPercent}% · Current discount {cartTotals.discountPercent.toFixed(2)}% will be blocked
              </div>
            )}

            <div className="flex justify-between text-[13px] font-medium text-neutral-500">
              <span>Discount Amount</span>
              <span className="font-mono">-₹{cartTotals.discountAmount.toFixed(2)}</span>
            </div>

            <div className="flex justify-between text-[13px] font-medium text-neutral-500">
              <span>Taxable Amount</span>
              <span className="font-mono">₹{cartTotals.taxableAmount.toFixed(2)}</span>
            </div>

            <div className="flex justify-between text-[13px] font-medium text-neutral-500">
              <span>GST</span>
              <span className="font-mono">₹{cartTotals.taxTotal.toFixed(2)}</span>
            </div>
            {canViewCheckoutDebug && cartIsMissingGstConfig && (
              <p className="rounded-lg border border-amber-100 bg-amber-50 px-2.5 py-1.5 text-[11px] font-bold text-amber-700">
                GST rate is not configured for this store/menu.
              </p>
            )}

            <div className="mt-2 flex items-end justify-between gap-2 border-t border-[#eadfd4] pt-2.5">
              <span className="shrink-0 text-base font-black text-neutral-800">Total</span>
              <span className="break-all text-right font-mono text-2xl font-black text-[#3e2723]">₹{cartTotals.grandTotal.toFixed(2)}</span>
            </div>
          </div>

          <div className="mt-3 space-y-3 border-t border-[#eadfd4] pt-3">
            <div className="flex items-center justify-between gap-3">
              <label className="block text-[11px] font-black uppercase tracking-[0.16em] text-neutral-500">Payment</label>
              <button
                onClick={() => setSplitPaymentMode(!isSplitPayment)}
                className={`rounded-full border px-3 py-1.5 text-[11px] font-black transition-colors ${
                  isSplitPayment
                    ? 'border-[#5c4033] bg-[#5c4033] text-white'
                    : 'border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50'
                }`}
              >
                {isSplitPayment ? 'Single' : 'Split'}
              </button>
            </div>

            {!isSplitPayment ? (
              <div className="overflow-x-auto custom-scrollbar">
                <div className="flex min-w-max gap-2 pb-1">
                  {PAYMENT_METHODS.map(method => (
                    <button
                      key={method}
                      onClick={() => setPaymentMethod(method)}
                      className={`min-h-[34px] min-w-[64px] rounded-full border px-3 py-1.5 text-[10px] font-black transition-all ${
                        paymentMethod === method
                          ? 'border-[#5c4033] bg-[#5c4033] text-white shadow-sm'
                          : 'border-[#eadfd4] bg-white text-neutral-600 hover:bg-neutral-50'
                      }`}
                    >
                      <span className="mx-auto block truncate -tracking-wider uppercase">
                        {method === 'COMPLIMENTARY' ? 'COMP' : method}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-2">
                  {splitPayments.map((payment, index) => (
                    <div key={payment.id} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-center">
                      <select
                        value={payment.method}
                        onChange={event => updateSplitPayment(payment.id, { method: event.target.value as PaymentMethod })}
                        className="min-w-0 rounded-2xl border border-[#eadfd4] bg-white px-3 py-2 text-xs font-bold text-neutral-700 outline-none focus:border-[#5c4033]"
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
                        className="min-w-0 rounded-2xl border border-[#eadfd4] bg-white px-3 py-2 text-right text-xs font-mono font-bold text-neutral-700 outline-none focus:border-[#5c4033]"
                        placeholder="0.00"
                        aria-label={`Payment amount ${index + 1}`}
                      />
                      <button
                        onClick={() => removeSplitPaymentRow(payment.id)}
                        disabled={splitPayments.length === 1}
                        className={`rounded-2xl border px-2 py-2 text-xs font-black ${
                          splitPayments.length === 1
                            ? 'cursor-not-allowed border-neutral-100 bg-neutral-50 text-neutral-300'
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
                  className="w-full rounded-2xl border border-dashed border-[#5c4033]/40 bg-[#5c4033]/5 px-3 py-2.5 text-xs font-black text-[#5c4033] hover:bg-[#5c4033]/10"
                >
                  Add Payment Row
                </button>
                <div className="space-y-1 rounded-2xl bg-white px-3 py-3 text-xs font-bold text-neutral-600">
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

            <button
              disabled={cart.length === 0 || isSaving}
              className={`mt-1 w-full rounded-2xl py-3 text-sm font-black transition-all shadow-sm ${
                cart.length > 0 && !isSaving
                  ? 'border border-[#2d1c19] bg-[#3e2723] text-[#f9f5f0] hover:bg-[#2d1c19] hover:shadow-md active:scale-[0.99]'
                  : 'cursor-not-allowed border border-neutral-300 bg-neutral-200 text-neutral-400'
              }`}
              onClick={() => void handleCheckout()}
            >
              {isSaving ? <Loader2 size={20} className="mx-auto animate-spin text-[#5c4033]" /> : (cart.length > 0 ? `Charge ₹${cartTotals.grandTotal.toFixed(2)}` : 'Cart Empty')}
            </button>
          </div>
        </div>
      </div>
      </div>

      {/* Sticky Mobile Cart Bar */}
      {!isMobileCartOpen && cart.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-30 max-w-full border-t border-[#eadfd4] bg-white p-3 shadow-[0_-4px_15px_rgba(0,0,0,0.05)] pb-[calc(1rem+env(safe-area-inset-bottom))] sm:p-4 lg:hidden">
           <button onClick={() => setIsMobileCartOpen(true)} className="flex w-full items-center justify-between gap-3 rounded-2xl bg-[#3e2723] px-4 py-3.5 font-black text-white shadow-sm transition-colors hover:bg-[#2d1c19] sm:px-5">
              <span className="flex min-w-0 items-center gap-2">
                <span className="rounded-xl bg-white/20 px-2.5 py-1 text-xs">{cartItemCount} {cartItemCount === 1 ? 'item' : 'items'}</span>
                <span className="truncate text-sm">View Order</span>
              </span>
              <span className="min-w-0 truncate text-base sm:text-lg">₹{cartTotals.grandTotal.toFixed(2)}</span>
           </button>
        </div>
      )}

      {receiptView && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-3 sm:p-4">
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
