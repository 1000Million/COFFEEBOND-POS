import React, { useEffect, useMemo, useState } from 'react';
import {
  collection,
  doc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  AlertCircle,
  Banknote,
  CheckCircle2,
  ChefHat,
  Clock,
  CreditCard,
  Eye,
  Loader2,
  Printer,
  ReceiptText,
  RefreshCw,
  Search,
  Store as StoreIcon,
  Utensils,
  X,
} from 'lucide-react';
import { db } from '../../lib/firebase';
import { auth } from '../../lib/firebase';
import { useAuth } from '../../contexts/AuthContext';
import { buildPaymentReversalAudit, orderItemDisplayStatus, paymentOutcomeLabel } from '../../lib/paymentReversal';
import { isComplimentaryOrder } from '../../lib/complimentaryOrders';
import {
  KotItem,
  KotStatus,
  Order,
  OrderItem,
  OrderPayment,
  PaymentMethod,
  Store,
} from '../../types';

type RunningTab = 'ALL' | 'DINE_IN' | 'TAKEAWAY' | 'ONLINE' | 'PAY_AT_COUNTER' | 'PREPARING' | 'READY' | 'UNPAID' | 'VOIDED';

type OrderBundle = {
  order: Order;
  items: OrderItem[];
  payments: OrderPayment[];
  kotItems: KotItem[];
};

type StockMovementDoc = {
  id?: string;
  storeId: string;
  storeName?: string;
  inventoryItemId?: string;
  inventoryItemName?: string;
  movementType: string;
  quantity: number;
  unit?: string;
  referenceType?: string;
  referenceId?: string | null;
  stockSystem?: string;
  stockItemType?: string;
  stockItemCode?: string;
};

type SettlementRow = {
  method: PaymentMethod | '';
  amount: string;
};

const PAYMENT_METHODS: PaymentMethod[] = ['CASH', 'UPI', 'CARD', 'SWIGGY', 'ZOMATO', 'CREDIT'];
const FILTER_TABS: { id: RunningTab; label: string }[] = [
  { id: 'ALL', label: 'All' },
  { id: 'DINE_IN', label: 'Dine-in' },
  { id: 'TAKEAWAY', label: 'Takeaway' },
  { id: 'ONLINE', label: 'Online' },
  { id: 'PAY_AT_COUNTER', label: 'Pay at Counter' },
  { id: 'PREPARING', label: 'Preparing' },
  { id: 'READY', label: 'Ready' },
  { id: 'UNPAID', label: 'Unpaid' },
  { id: 'VOIDED', label: 'Voided' },
];

function money(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundStock(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function formatMoney(value: unknown): string {
  return `₹${money(value).toFixed(2)}`;
}

function toDate(value: any): Date | null {
  if (!value) return null;
  if (value.toDate) return value.toDate();
  if (value instanceof Date) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function startOfBusinessDay(key: string): Date {
  return new Date(`${key}T00:00:00`);
}

function endOfBusinessDay(key: string): Date {
  return new Date(`${key}T23:59:59.999`);
}

function elapsedLabel(value: any, now: Date): string {
  const date = toDate(value);
  if (!date) return 'just now';
  const minutes = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  if (hours < 24) return `${hours}h ${remaining}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function allowedStoreIds(staffProfile: NonNullable<ReturnType<typeof useAuth>['staffProfile']>): string[] {
  return staffProfile.assignedStoreIds?.length ? staffProfile.assignedStoreIds : staffProfile.storeIds || [];
}

function effectiveOrderStatus(order: Order): 'COMPLETED' | 'VOIDED' | 'CANCELLED' {
  if (order.status === 'VOIDED') return 'VOIDED';
  if (order.status === 'CANCELLED') return 'CANCELLED';
  return 'COMPLETED';
}

function inferPaymentStatus(order: Order, payments: OrderPayment[]): Order['paymentStatus'] {
  if (isComplimentaryOrder(order)) return 'NOT_REQUIRED';
  if (effectiveOrderStatus(order) === 'VOIDED') return order.paymentStatus || 'UNPAID';
  if (order.paymentStatus) return order.paymentStatus;
  if (order.paymentMethod === 'PAY_AT_COUNTER') return 'UNPAID';
  const paid = payments.reduce((sum, payment) => sum + money(payment.amount), 0);
  const total = money(order.grandTotal);
  if (total <= 0) return 'PAID';
  if (paid >= total - 0.01) return 'PAID';
  if (paid > 0) return 'PARTIAL';
  return 'UNPAID';
}

function isPayAtCounter(order: Order, payments: OrderPayment[]): boolean {
  return order.paymentMethod === 'PAY_AT_COUNTER'
    || (order.paymentBreakdown || []).some(payment => payment.method === 'PAY_AT_COUNTER')
    || payments.some(payment => payment.method === 'PAY_AT_COUNTER');
}

function settledTenderRows(payments: OrderPayment[]): OrderPayment[] {
  return payments.filter(payment => payment.method !== 'PAY_AT_COUNTER' && money(payment.amount) > 0);
}

function sourceLabel(order: Order): 'CUSTOMER_WEB' | 'POS' {
  const record = order as Order & Record<string, unknown>;
  if (record.source === 'CUSTOMER_WEB' || record.onlineOrderId || record.onlineOrderReference || record.linkedOnlineOrderId) {
    return 'CUSTOMER_WEB';
  }
  return 'POS';
}

function orderItemCount(items: OrderItem[]): number {
  return items.reduce((sum, item) => sum + money(item.quantity), 0);
}

function kotSummary(kotItems: KotItem[]): { label: string; tone: string; rank: number } {
  if (kotItems.length === 0) return { label: 'No KOT found', tone: 'bg-neutral-100 text-neutral-600', rank: 0 };
  if (kotItems.some(item => item.status === 'CANCELLED')) return { label: 'Cancelled / Voided', tone: 'bg-red-100 text-red-700', rank: 1 };
  if (kotItems.every(item => item.status === 'SERVED' || item.status === 'WASTAGE_RECORDED')) return { label: 'Served / Completed', tone: 'bg-neutral-900 text-white', rank: 5 };
  if (kotItems.some(item => item.status === 'READY')) return { label: 'Ready', tone: 'bg-emerald-100 text-emerald-700', rank: 4 };
  if (kotItems.some(item => item.status === 'PREPARING')) return { label: 'Preparing', tone: 'bg-amber-100 text-amber-700', rank: 3 };
  if (kotItems.some(item => item.status === 'PENDING')) return { label: 'Pending', tone: 'bg-blue-100 text-blue-700', rank: 2 };
  return { label: 'No active KOT', tone: 'bg-neutral-100 text-neutral-600', rank: 0 };
}

function fulfillmentStatus(bundle: OrderBundle): string {
  if (effectiveOrderStatus(bundle.order) === 'VOIDED') return 'Voided';
  const kot = kotSummary(bundle.kotItems);
  if (kot.label === 'No KOT found') return 'Active';
  return kot.label;
}

function statusBadge(bundle: OrderBundle): { label: string; className: string } {
  const orderStatus = effectiveOrderStatus(bundle.order);
  const paymentStatus = inferPaymentStatus(bundle.order, bundle.payments);
  const kot = kotSummary(bundle.kotItems);
  if (orderStatus === 'VOIDED') return { label: 'Voided', className: 'bg-red-100 text-red-700 border-red-200' };
  if (isComplimentaryOrder(bundle.order)) return { label: 'Complimentary', className: 'bg-purple-100 text-purple-700 border-purple-200' };
  if (paymentStatus === 'PAID' && kot.label === 'Served / Completed') return { label: 'Paid', className: 'bg-emerald-100 text-emerald-700 border-emerald-200' };
  if (isPayAtCounter(bundle.order, bundle.payments) && paymentStatus !== 'PAID') return { label: 'Pay at Counter', className: 'bg-violet-100 text-violet-700 border-violet-200' };
  if (kot.label === 'Ready') return { label: 'Ready', className: 'bg-emerald-100 text-emerald-700 border-emerald-200' };
  if (kot.label === 'Preparing') return { label: 'Preparing', className: 'bg-amber-100 text-amber-700 border-amber-200' };
  return { label: 'Active', className: 'bg-blue-100 text-blue-700 border-blue-200' };
}

function printReceipt(bundle: OrderBundle) {
  const { order, items, payments } = bundle;
  const complimentary = isComplimentaryOrder(order);
  const paymentRows = complimentary
    ? []
    : payments.length > 0 ? payments : [{ method: order.paymentMethod, amount: order.grandTotal, reference: null, createdAt: null }];
  const paymentOutcome = paymentOutcomeLabel(order, payments);
  const legalDetails = order.receiptLegalDetails;
  const printWin = window.open('', '', 'width=420,height=650');
  printWin?.document.write(`
    <html>
      <head>
        <title>${order.orderNumber}</title>
        <style>
          body { font-family: monospace; padding: 20px; color: #111; }
          h1,h2,p { margin: 0; }
          .center { text-align: center; }
          .line { border-top: 1px dashed #aaa; margin: 14px 0; }
          .row { display: flex; justify-content: space-between; gap: 12px; margin: 6px 0; }
          .bold { font-weight: 800; }
          .muted { color: #555; font-size: 12px; }
          .total { font-size: 18px; font-weight: 900; }
          .voided { border: 2px solid #b91c1c; color: #b91c1c; padding: 8px; margin-top: 10px; font-weight: 900; }
        </style>
      </head>
      <body>
        <div class="center">
          <h1>${legalDetails?.tradeName || legalDetails?.legalName || 'COFFEE BOND'}</h1>
          <p class="bold">${order.storeName || ''}</p>
          ${legalDetails?.legalAddress ? `<p class="muted">${legalDetails.legalAddress}</p>` : ''}
          ${legalDetails?.gstRegistered && legalDetails.gstin ? `<p class="muted">GSTIN: ${legalDetails.gstin}</p>` : ''}
          <p class="muted">${order.orderNumber}</p>
          <p class="muted">${toDate(order.createdAt)?.toLocaleString() || new Date().toLocaleString()}</p>
          ${effectiveOrderStatus(order) === 'VOIDED' ? '<div class="voided">VOIDED</div>' : ''}
        </div>
        <div class="line"></div>
        <p class="muted">${order.orderType?.replace('_', ' ') || ''}${order.tableNumber ? ` • Table ${order.tableNumber}` : ''}</p>
        ${order.customerName ? `<p class="muted">Guest: ${order.customerName}${order.customerPhone ? ` (${order.customerPhone})` : ''}</p>` : ''}
        <div class="line"></div>
        ${items.map(item => `
          <div class="row">
            <div>
              <p class="bold">${item.itemName}</p>
              <p class="muted">${money(item.quantity)} x ${formatMoney(item.unitPrice)}${effectiveOrderStatus(order) === 'VOIDED' ? ` • ${orderItemDisplayStatus(order, item)}` : ''}</p>
            </div>
            <p class="bold">${formatMoney(complimentary ? money(item.quantity) * money(item.unitPrice) : item.lineTotal)}</p>
          </div>
        `).join('')}
        <div class="line"></div>
        <div class="row"><span>${complimentary ? 'Menu Value' : 'Subtotal'}</span><span>${formatMoney(order.menuValue ?? order.subtotal)}</span></div>
        <div class="row"><span>${complimentary ? 'Complimentary Discount' : `Discount (${money(order.discountPercent).toFixed(2)}%)`}</span><span>-${formatMoney(order.complimentaryDiscount ?? order.discountAmount ?? order.discountTotal ?? order.discount)}</span></div>
        <div class="row"><span>Taxable</span><span>${formatMoney(order.taxableAmount ?? Math.max(0, money(order.subtotal) - money(order.discountTotal)))}</span></div>
        <div class="row"><span>GST</span><span>${formatMoney(order.gstTotal ?? order.taxTotal)}</span></div>
        <div class="row total"><span>${complimentary ? 'Amount Payable' : 'Total'}</span><span>${formatMoney(order.grandTotal)}</span></div>
        <div class="line"></div>
        ${complimentary
          ? '<p class="center bold">COMPLIMENTARY — NO PAYMENT REQUIRED</p><p class="center muted" style="margin-top:8px;">Payment Status: NOT REQUIRED</p>'
          : `${paymentRows.map(payment => `<div class="row"><span>${payment.method}</span><span>${formatMoney(payment.amount)}</span></div>`).join('')}<p class="center muted" style="margin-top:16px;">${paymentOutcome}</p>`}
      </body>
    </html>
  `);
  printWin?.document.close();
  printWin?.focus();
  printWin?.print();
}

export default function RunningOrders() {
  const { staffProfile } = useAuth();
  const [stores, setStores] = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState('ALL');
  const [businessDate, setBusinessDate] = useState(dateKey(new Date()));
  const [bundles, setBundles] = useState<OrderBundle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [activeTab, setActiveTab] = useState<RunningTab>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedBundle, setSelectedBundle] = useState<OrderBundle | null>(null);
  const [settleBundle, setSettleBundle] = useState<OrderBundle | null>(null);
  const [settleMethod, setSettleMethod] = useState<PaymentMethod | ''>('');
  const [settleRows, setSettleRows] = useState<SettlementRow[]>([{ method: '', amount: '' }]);
  const [isSplitSettlement, setIsSplitSettlement] = useState(false);
  const [cashReceived, setCashReceived] = useState('');
  const [settling, setSettling] = useState(false);
  const [voidBundle, setVoidBundle] = useState<OrderBundle | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [voidConfirmation, setVoidConfirmation] = useState('');
  const [voiding, setVoiding] = useState(false);
  const [now, setNow] = useState(new Date());

  const accessibleStores = useMemo(() => {
    if (!staffProfile) return [];
    if (staffProfile.role === 'ADMIN') return stores;
    const allowedIds = allowedStoreIds(staffProfile);
    return stores.filter(store => allowedIds.includes(store.id));
  }, [staffProfile, stores]);

  const canSeeAllStores = staffProfile?.role === 'ADMIN';
  const canSettle = staffProfile?.role === 'ADMIN' || staffProfile?.role === 'STORE_MANAGER' || staffProfile?.role === 'CASHIER';
  const canUpdateKot = staffProfile?.role === 'ADMIN' || staffProfile?.role === 'STORE_MANAGER' || staffProfile?.role === 'CASHIER';
  const canVoidOrders = staffProfile?.role === 'ADMIN' || staffProfile?.role === 'STORE_MANAGER';

  const selectedStoreName = selectedStoreId === 'ALL'
    ? 'All authorized stores'
    : accessibleStores.find(store => store.id === selectedStoreId)?.name || 'Selected store';

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!staffProfile) return;
    getDocs(query(collection(db, 'stores'), where('isActive', '==', true)))
      .then(snap => {
        const loaded = snap.docs.map(storeDoc => ({ id: storeDoc.id, ...storeDoc.data() } as Store))
          .sort((a, b) => a.name.localeCompare(b.name));
        setStores(loaded);
        const accessible = staffProfile.role === 'ADMIN' ? loaded : loaded.filter(store => allowedStoreIds(staffProfile).includes(store.id));
        setSelectedStoreId(prev => prev || (staffProfile.role === 'ADMIN' ? 'ALL' : accessible[0]?.id || ''));
      })
      .catch(err => {
        console.error('Failed to load stores', err);
        setError('Could not load stores for running orders.');
      });
  }, [staffProfile]);

  const loadOrders = async () => {
    if (!staffProfile || accessibleStores.length === 0) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError('');
    setSuccess('');
    try {
      const start = startOfBusinessDay(businessDate);
      const end = endOfBusinessDay(businessDate);
      const storesToLoad = selectedStoreId === 'ALL'
        ? accessibleStores
        : accessibleStores.filter(store => store.id === selectedStoreId);

      const orderSnaps = await Promise.all(storesToLoad.map(store => getDocs(query(
        collection(db, 'orders'),
        where('storeId', '==', store.id),
        where('createdAt', '>=', start),
        where('createdAt', '<=', end),
      ))));

      const orders = orderSnaps.flatMap(snap => snap.docs.map(orderDoc => ({
        id: orderDoc.id,
        ...orderDoc.data(),
      } as Order)));

      orders.sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0));

      const orderBundles = await Promise.all(orders.map(async order => {
        if (!order.id) return { order, items: [], payments: [], kotItems: [] };
        const [itemsSnap, paymentsSnap, kotSnap] = await Promise.all([
          getDocs(collection(db, 'orders', order.id, 'items')),
          getDocs(collection(db, 'orders', order.id, 'payments')),
          getDocs(query(
            collection(db, 'kotItems'),
            where('storeId', '==', order.storeId),
            where('orderId', '==', order.id),
          )),
        ]);
        return {
          order,
          items: itemsSnap.docs.map(itemDoc => ({ id: itemDoc.id, ...itemDoc.data() } as OrderItem)),
          payments: paymentsSnap.docs.map(paymentDoc => ({ id: paymentDoc.id, ...paymentDoc.data() } as OrderPayment))
            .sort((a, b) => (a.paymentIndex ?? 0) - (b.paymentIndex ?? 0)),
          kotItems: kotSnap.docs.map(kotDoc => ({ id: kotDoc.id, ...kotDoc.data() } as KotItem)),
        };
      }));

      setBundles(orderBundles);
      if (selectedBundle?.order.id) {
        setSelectedBundle(orderBundles.find(bundle => bundle.order.id === selectedBundle.order.id) || null);
      }
    } catch (err) {
      console.error('Failed to load running orders', err);
      setError(err instanceof Error ? err.message : 'Could not load running orders.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (accessibleStores.length === 0) return;
    loadOrders();
  }, [businessDate, selectedStoreId, accessibleStores.length]);

  const filteredBundles = useMemo(() => {
    const term = searchQuery.trim().toLowerCase();
    return bundles.filter(bundle => {
      const order = bundle.order;
      const paymentStatus = inferPaymentStatus(order, bundle.payments);
      const source = sourceLabel(order);
      const kot = kotSummary(bundle.kotItems);
      const orderStatus = effectiveOrderStatus(order);

      if (activeTab === 'DINE_IN' && order.orderType !== 'DINE_IN') return false;
      if (activeTab === 'TAKEAWAY' && order.orderType !== 'TAKEAWAY') return false;
      if (activeTab === 'ONLINE' && source !== 'CUSTOMER_WEB') return false;
      if (activeTab === 'PAY_AT_COUNTER' && !isPayAtCounter(order, bundle.payments)) return false;
      if (activeTab === 'PREPARING' && kot.label !== 'Preparing') return false;
      if (activeTab === 'READY' && kot.label !== 'Ready') return false;
      if (activeTab === 'UNPAID' && (paymentStatus === 'PAID' || paymentStatus === 'NOT_REQUIRED')) return false;
      if (activeTab === 'VOIDED' && orderStatus !== 'VOIDED') return false;
      if (activeTab !== 'VOIDED' && orderStatus === 'VOIDED' && !['ALL', 'UNPAID'].includes(activeTab)) return false;

      if (!term) return true;
      const haystack = [
        order.orderNumber,
        order.customerName,
        order.customerPhone,
        order.tableNumber,
        order.storeName,
        ...bundle.items.map(item => item.itemName),
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(term);
    });
  }, [bundles, activeTab, searchQuery]);

  const tabCounts = useMemo(() => {
    const counts = FILTER_TABS.reduce<Record<RunningTab, number>>((acc, tab) => {
      acc[tab.id] = 0;
      return acc;
    }, {} as Record<RunningTab, number>);
    bundles.forEach(bundle => {
      const paymentStatus = inferPaymentStatus(bundle.order, bundle.payments);
      const source = sourceLabel(bundle.order);
      const kot = kotSummary(bundle.kotItems);
      const orderStatus = effectiveOrderStatus(bundle.order);
      counts.ALL += 1;
      if (bundle.order.orderType === 'DINE_IN') counts.DINE_IN += 1;
      if (bundle.order.orderType === 'TAKEAWAY') counts.TAKEAWAY += 1;
      if (source === 'CUSTOMER_WEB') counts.ONLINE += 1;
      if (isPayAtCounter(bundle.order, bundle.payments)) counts.PAY_AT_COUNTER += 1;
      if (kot.label === 'Preparing') counts.PREPARING += 1;
      if (kot.label === 'Ready') counts.READY += 1;
      if (paymentStatus !== 'PAID' && paymentStatus !== 'NOT_REQUIRED') counts.UNPAID += 1;
      if (orderStatus === 'VOIDED') counts.VOIDED += 1;
    });
    return counts;
  }, [bundles]);

  const openSettleModal = (bundle: OrderBundle) => {
    setSettleBundle(bundle);
    setSettleMethod('');
    setIsSplitSettlement(false);
    setSettleRows([{ method: '', amount: '' }]);
    setCashReceived('');
    setError('');
    setSuccess('');
  };

  const settlementAlreadyPaid = settleBundle
    ? settledTenderRows(settleBundle.payments).reduce((sum, payment) => sum + money(payment.amount), 0)
    : 0;
  const settlementDue = money(settleBundle?.order.grandTotal);
  const settlementOutstanding = Math.max(0, Number((settlementDue - settlementAlreadyPaid).toFixed(2)));
  const proposedSettlementRows: SettlementRow[] = isSplitSettlement
    ? settleRows
    : settleMethod
      ? [{ method: settleMethod, amount: settlementOutstanding.toFixed(2) }]
      : [];
  const settlementTotal = proposedSettlementRows.reduce((sum, row) => sum + money(row.amount), 0);
  const settlementBalance = settlementOutstanding - settlementTotal;
  const cashReceivedAmount = settleMethod === 'CASH' && cashReceived.trim()
    ? money(cashReceived)
    : settlementOutstanding;
  const cashChangeDue = settleMethod === 'CASH'
    ? Math.max(0, cashReceivedAmount - settlementOutstanding)
    : 0;
  const cashReceivedValid = settleMethod !== 'CASH'
    || !cashReceived.trim()
    || cashReceivedAmount + 0.01 >= settlementOutstanding;
  const settlementReady = !!settleBundle
    && settlementOutstanding > 0
    && Math.abs(settlementBalance) <= 0.01
    && proposedSettlementRows.length > 0
    && proposedSettlementRows.every(row => row.method && row.method !== 'PAY_AT_COUNTER' && money(row.amount) > 0)
    && cashReceivedValid;

  const settlePayment = async () => {
    if (!settleBundle?.order.id || !staffProfile || !settlementReady) return;
    if (effectiveOrderStatus(settleBundle.order) === 'VOIDED') {
      setError('Voided orders cannot be settled.');
      return;
    }

    const cleanRows = proposedSettlementRows.map((row, index) => {
      if (!row.method) throw new Error('Select a payment method before settling.');
      return {
        method: row.method,
        amount: Number(money(row.amount).toFixed(2)),
        reference: null,
        paymentIndex: settledTenderRows(settleBundle.payments).length + index,
        createdAt: serverTimestamp(),
        settledBy: staffProfile.uid,
        settledByName: staffProfile.displayName || staffProfile.name,
        ...(row.method === 'CASH' && !isSplitSettlement ? {
          amountReceived: Number(cashReceivedAmount.toFixed(2)),
          changeDue: Number(cashChangeDue.toFixed(2)),
        } : {}),
      };
    });
    const existingPaidRows = settledTenderRows(settleBundle.payments).map(payment => ({
      method: payment.method,
      amount: Number(money(payment.amount).toFixed(2)),
    }));
    const nextBreakdown = [
      ...existingPaidRows,
      ...cleanRows.map(row => ({ method: row.method, amount: row.amount })),
    ];

    setSettling(true);
    setError('');
    setSuccess('');
    try {
      const orderRef = doc(db, 'orders', settleBundle.order.id);
      await runTransaction(db, async transaction => {
        const freshOrderSnap = await transaction.get(orderRef);
        if (!freshOrderSnap.exists()) throw new Error('Order no longer exists.');
        const freshOrder = { id: freshOrderSnap.id, ...freshOrderSnap.data() } as Order;
        if (effectiveOrderStatus(freshOrder) === 'VOIDED') throw new Error('Voided orders cannot be settled.');
        if (freshOrder.paymentStatus === 'PAID') throw new Error('This order is already settled.');

        settleBundle.payments.forEach(payment => {
          if (payment.id && payment.method === 'PAY_AT_COUNTER') {
            transaction.update(doc(db, 'orders', settleBundle.order.id!, 'payments', payment.id), {
              amount: 0,
              reference: payment.reference || 'PAY_AT_COUNTER_PLACEHOLDER',
            });
          }
        });

        cleanRows.forEach(row => {
          const paymentRef = doc(collection(db, 'orders', settleBundle.order.id!, 'payments'));
          transaction.set(paymentRef, row);
        });

        transaction.update(orderRef, {
          paymentStatus: 'PAID',
          paymentMethod: nextBreakdown[0]?.method || cleanRows[0].method,
          isSplitPayment: nextBreakdown.length > 1,
          paymentMethodLabel: nextBreakdown.length > 1
            ? nextBreakdown.map(row => `${row.method} ₹${row.amount.toFixed(2)}`).join(' + ')
            : nextBreakdown[0]?.method || cleanRows[0].method,
          paymentBreakdown: nextBreakdown,
          settledAt: serverTimestamp(),
          settledBy: staffProfile.uid,
          settledByName: staffProfile.displayName || staffProfile.name,
          updatedAt: serverTimestamp(),
        });
      });
      setSuccess(`Settled ${settleBundle.order.orderNumber} without changing KOT or stock.`);
      setSettleBundle(null);
      await loadOrders();
    } catch (err) {
      console.error('Failed to settle payment', err);
      setError(err instanceof Error ? err.message : 'Could not settle payment.');
    } finally {
      setSettling(false);
    }
  };

  const updateKotStatus = async (bundle: OrderBundle, nextStatus: KotStatus) => {
    if (!canUpdateKot || bundle.kotItems.length === 0) return;
    setError('');
    setSuccess('');
    try {
      const batch = writeBatch(db);
      bundle.kotItems
        .filter(kot => kot.id && !['CANCELLED', 'SERVED', 'WASTAGE_RECORDED'].includes(kot.status))
        .forEach(kot => {
          const updateData: Record<string, unknown> = {
            status: nextStatus,
            updatedAt: serverTimestamp(),
            handledByUserId: staffProfile?.uid || null,
            handledByName: staffProfile?.displayName || staffProfile?.name || null,
          };
          if (nextStatus === 'READY') updateData.readyAt = serverTimestamp();
          if (nextStatus === 'SERVED') updateData.servedAt = serverTimestamp();
          batch.update(doc(db, 'kotItems', kot.id!), updateData);
          if (kot.orderItemId) {
            batch.update(doc(db, 'orders', kot.orderId, 'items', kot.orderItemId), {
              status: nextStatus,
            });
          }
        });
      await batch.commit();
      setSuccess(`${bundle.order.orderNumber} KOT marked ${nextStatus}.`);
      await loadOrders();
    } catch (err) {
      console.error('Failed to update KOT status', err);
      setError(err instanceof Error ? err.message : 'Could not update KOT status.');
    }
  };

  const voidOrder = async () => {
    if (!voidBundle?.order.id || !staffProfile || !auth.currentUser) return;
    if (!canVoidOrders) {
      setError('Only Admin or Store Manager can void orders.');
      return;
    }
    if (effectiveOrderStatus(voidBundle.order) === 'VOIDED') {
      setError('This order is already voided.');
      return;
    }
    if (!voidReason.trim()) {
      setError('Void reason is required.');
      return;
    }
    if (voidConfirmation.trim() !== 'VOID ORDER') {
      setError('Type VOID ORDER to confirm the void.');
      return;
    }

    setVoiding(true);
    setError('');
    setSuccess('');
    try {
      const orderRef = doc(db, 'orders', voidBundle.order.id);
      const [movementSnap, kotSnap, paymentSnap] = await Promise.all([
        getDocs(query(collection(db, 'stockMovements'), where('referenceId', '==', voidBundle.order.id))),
        getDocs(query(
          collection(db, 'kotItems'),
          where('storeId', '==', voidBundle.order.storeId),
          where('orderId', '==', voidBundle.order.id),
        )),
        getDocs(collection(db, 'orders', voidBundle.order.id, 'payments')),
      ]);
      const pendingSnap = await getDocs(query(
        collection(db, 'pendingInventoryConsumption'),
        where('storeId', '==', voidBundle.order.storeId),
        where('orderId', '==', voidBundle.order.id),
      ));
      const movementDocs = movementSnap.docs.map(movementDoc => ({ id: movementDoc.id, ...movementDoc.data() } as StockMovementDoc));
      if (movementDocs.some(movement => movement.movementType === 'ORDER_VOID_REVERSAL')) {
        throw new Error('This order already has reversal stock movements. It cannot be voided again.');
      }
      const saleMovements = movementDocs.filter(movement => (
        (movement.movementType === 'SALE_DEDUCTION' || movement.movementType === 'ORDER_BOM_BACKFILL')
        && (movement.referenceType === 'ORDER' || !movement.referenceType)
        && Number(movement.quantity) < 0
      ));
      const paymentRows = paymentSnap.docs.map(paymentDoc => ({ id: paymentDoc.id, ...paymentDoc.data() } as OrderPayment));

      await runTransaction(db, async transaction => {
        const freshOrderSnap = await transaction.get(orderRef);
        if (!freshOrderSnap.exists()) throw new Error('Order no longer exists.');
        const freshOrder = { id: freshOrderSnap.id, ...freshOrderSnap.data() } as Order;
        if (effectiveOrderStatus(freshOrder) === 'VOIDED') throw new Error('This order is already voided.');
        const paymentReversal = buildPaymentReversalAudit(freshOrder, paymentRows);

        const stockTargets = saleMovements.map(movement => {
          const stockItemType = String(movement.stockItemType || 'RAW_INGREDIENT');
          const stockItemCode = String(movement.stockItemCode || movement.inventoryItemId || '');
          if (!movement.storeId || !stockItemCode) {
            throw new Error(`Cannot reverse stock movement ${movement.id}; stock item details are missing.`);
          }
          return {
            movement,
            stockItemType,
            stockItemCode,
            stockRef: doc(db, 'storeStock', `${movement.storeId}_${stockItemType}_${stockItemCode}`),
          };
        });

        const stockSnaps = await Promise.all(stockTargets.map(target => transaction.get(target.stockRef)));
        const missingStockIndex = stockSnaps.findIndex(stockSnap => !stockSnap.exists());
        if (missingStockIndex >= 0) {
          const target = stockTargets[missingStockIndex];
          throw new Error(`Cannot reverse stock; storeStock row is missing for ${target.stockItemType} / ${target.stockItemCode}.`);
        }

        stockTargets.forEach((target, index) => {
          const reversalQuantity = Math.abs(Number(target.movement.quantity) || 0);
          const stockBefore = Number(stockSnaps[index].data()?.currentStock);
          if (!Number.isFinite(stockBefore)) {
            throw new Error(`Cannot reverse stock; current stock is missing for ${target.stockItemType} / ${target.stockItemCode}.`);
          }
          const stockAfter = roundStock(stockBefore + reversalQuantity);
          transaction.update(target.stockRef, {
            currentStock: stockAfter,
            updatedAt: serverTimestamp(),
          });
          transaction.set(doc(collection(db, 'stockMovements')), {
            storeId: target.movement.storeId,
            storeCode: freshOrder.storeCode,
            storeName: target.movement.storeName || freshOrder.storeName,
            inventoryItemId: target.stockItemCode,
            inventoryItemName: target.movement.inventoryItemName || target.stockItemCode,
            movementType: 'ORDER_VOID_REVERSAL',
            reason: 'ORDER_VOID_REVERSAL',
            quantity: reversalQuantity,
            quantityDelta: reversalQuantity,
            unit: target.movement.unit || '',
            referenceType: 'ORDER',
            referenceId: freshOrder.id,
            orderId: freshOrder.id,
            orderNumber: freshOrder.orderNumber,
            sourceOrderId: freshOrder.id,
            voidedOrderId: freshOrder.id,
            originalMovementId: target.movement.id,
            originalMovementType: target.movement.movementType,
            notes: `Void order ${freshOrder.orderNumber}: ${voidReason.trim()}`,
            createdByUserId: auth.currentUser!.uid,
            createdByName: staffProfile.displayName || staffProfile.name,
            createdAt: serverTimestamp(),
            stockSystem: target.movement.stockSystem || 'MENU_MANAGEMENT',
            stockItemType: target.stockItemType,
            stockItemCode: target.stockItemCode,
            previousQty: stockBefore,
            newQty: stockAfter,
            stockBefore,
            stockAfter,
            balanceBefore: stockBefore,
            balanceAfter: stockAfter,
          });
        });

        pendingSnap.docs.forEach(pendingDoc => {
          const pendingData = pendingDoc.data() as Record<string, unknown>;
          if (pendingData.status !== 'PENDING_BOM') {
            return;
          }
          transaction.update(pendingDoc.ref, {
            status: 'CANCELLED',
            reason: `Order voided before BOM backfill: ${voidReason.trim()}`,
            resolvedAt: serverTimestamp(),
            resolvedBy: auth.currentUser!.uid,
            updatedAt: serverTimestamp(),
          });
        });

        kotSnap.docs.forEach(kotDoc => {
          transaction.update(kotDoc.ref, {
            status: 'CANCELLED',
            voidReason: voidReason.trim(),
            handledByUserId: auth.currentUser!.uid,
            handledByName: staffProfile.displayName || staffProfile.name,
            updatedAt: serverTimestamp(),
          });
        });

        const paymentReversalFields = isComplimentaryOrder(freshOrder) ? {} : {
          paymentReversalStatus: paymentReversal.paymentReversalStatus,
          paymentReversalBreakdown: paymentReversal.paymentReversalBreakdown,
          paymentReversalTotal: paymentReversal.paymentReversalTotal,
          refundedAmount: paymentReversal.refundedAmount,
          reversedAmount: paymentReversal.reversedAmount,
          refundPendingAmount: paymentReversal.refundPendingAmount,
          manualRefundRequiredAmount: paymentReversal.manualRefundRequiredAmount,
          netCollectionAmount: paymentReversal.netCollectionAmount,
        };
        transaction.update(orderRef, {
          status: 'VOIDED',
          ...paymentReversalFields,
          voidReason: voidReason.trim(),
          voidedBy: auth.currentUser!.uid,
          voidedByName: staffProfile.displayName || staffProfile.name,
          voidedByEmail: staffProfile.email || null,
          voidedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      });

      setSuccess(`Voided ${voidBundle.order.orderNumber}. Reversed ${saleMovements.length} stock movement rows and cancelled ${kotSnap.docs.length} KOT rows.`);
      setVoidBundle(null);
      setVoidReason('');
      setVoidConfirmation('');
      await loadOrders();
    } catch (err) {
      console.error('Failed to void order', err);
      setError(err instanceof Error ? err.message : 'Could not void order.');
    } finally {
      setVoiding(false);
    }
  };

  if (!staffProfile) return null;

  return (
    <div className="mx-auto w-full max-w-7xl min-w-0 pb-24">
      <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.2em] text-amber-700">Phase 8D.1</p>
          <h1 className="text-3xl font-black text-[#3e2723]">Running Orders</h1>
          <p className="text-sm text-neutral-500">Live service board for POS, dine-in, takeaway, online, KOT, and pay-at-counter orders.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={loadOrders}
            className="inline-flex items-center gap-2 rounded-xl border border-neutral-200 bg-white px-4 py-2 text-sm font-black text-neutral-700"
          >
            <RefreshCw size={16} />
            Refresh
          </button>
        </div>
      </div>

      <div className="mb-5 grid grid-cols-1 gap-3 rounded-2xl border border-neutral-200 bg-white p-3 shadow-sm sm:p-4 lg:grid-cols-[1fr_180px_1fr]">
        <label className="block">
          <span className="text-xs font-black uppercase tracking-widest text-neutral-500">Store</span>
          <span className="mt-1 flex items-center gap-2 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2">
            <StoreIcon size={16} className="text-neutral-400" />
            <select
              value={selectedStoreId}
              onChange={event => setSelectedStoreId(event.target.value)}
              className="w-full bg-transparent text-sm font-black outline-none"
            >
              {canSeeAllStores && <option value="ALL">All Authorized Stores</option>}
              {accessibleStores.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}
            </select>
          </span>
        </label>

        <label className="block">
          <span className="text-xs font-black uppercase tracking-widest text-neutral-500">Date</span>
          <input
            type="date"
            value={businessDate}
            onChange={event => setBusinessDate(event.target.value)}
            onInput={event => setBusinessDate(event.currentTarget.value)}
            className="mt-1 w-full rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm font-black outline-none"
          />
        </label>

        <label className="block">
          <span className="text-xs font-black uppercase tracking-widest text-neutral-500">Search</span>
          <span className="mt-1 flex items-center gap-2 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2">
            <Search size={16} className="text-neutral-400" />
            <input
              value={searchQuery}
              onChange={event => setSearchQuery(event.target.value)}
              placeholder="Order, guest, phone, table, item..."
              className="w-full bg-transparent text-sm font-bold outline-none"
            />
          </span>
        </label>
      </div>

      {error && (
        <div className="mb-4 flex gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700">
          <AlertCircle size={18} className="shrink-0" />
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 flex gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-bold text-emerald-800">
          <CheckCircle2 size={18} className="shrink-0" />
          {success}
        </div>
      )}

      <div className="mb-5 flex gap-2 overflow-x-auto pb-1">
        {FILTER_TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`shrink-0 rounded-full px-4 py-2 text-sm font-black transition ${
              activeTab === tab.id
                ? 'bg-[#5c4033] text-white shadow-sm'
                : 'border border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50'
            }`}
          >
            {tab.label}
            <span className={`ml-2 rounded-full px-2 py-0.5 text-xs ${activeTab === tab.id ? 'bg-white/20' : 'bg-neutral-100 text-neutral-500'}`}>
              {tabCounts[tab.id]}
            </span>
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex min-h-[320px] flex-col items-center justify-center rounded-3xl border border-neutral-200 bg-white text-neutral-500">
          <Loader2 size={28} className="mb-3 animate-spin" />
          <p className="font-bold">Loading running orders...</p>
        </div>
      ) : filteredBundles.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-neutral-300 bg-white p-10 text-center">
          <ReceiptText size={36} className="mx-auto mb-3 text-neutral-300" />
          <h2 className="text-xl font-black text-neutral-800">No running orders found</h2>
          <p className="text-sm text-neutral-500">{selectedStoreName} has no orders matching this filter for {businessDate}.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {filteredBundles.map(bundle => {
            const { order } = bundle;
            const badge = statusBadge(bundle);
            const kot = kotSummary(bundle.kotItems);
            const paymentStatus = inferPaymentStatus(order, bundle.payments);
            const paymentOutcome = paymentOutcomeLabel(order, bundle.payments);
            const payAtCounter = isPayAtCounter(order, bundle.payments);
            const voided = effectiveOrderStatus(order) === 'VOIDED';
            const source = sourceLabel(order);
            return (
              <article key={order.id} className={`rounded-3xl border bg-white p-5 shadow-sm ${voided ? 'border-red-200 bg-red-50/40' : 'border-neutral-200'}`}>
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div>
                    <p className="font-mono text-lg font-black text-neutral-900">{order.orderNumber}</p>
                    <p className="mt-1 text-xs font-bold uppercase tracking-widest text-neutral-400">{order.storeName}</p>
                  </div>
                  <span className={`rounded-full border px-3 py-1 text-xs font-black ${badge.className}`}>{badge.label}</span>
                </div>

                <div className="mb-4 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                  <Info label="Type" value={order.orderType?.replace('_', ' ') || 'Order'} />
                  <Info label="Source" value={source} />
                  <Info label="Guest" value={order.customerName || 'Walk-in'} />
                  <Info label="Phone" value={order.customerPhone || '-'} />
                  <Info label="Table" value={order.tableNumber || '-'} />
                  <Info label="Age" value={elapsedLabel(order.createdAt, now)} />
                  <Info label="Items" value={`${orderItemCount(bundle.items)} item${orderItemCount(bundle.items) === 1 ? '' : 's'}`} />
                  <Info label={isComplimentaryOrder(order) ? 'Menu Value' : 'Total'} value={formatMoney(isComplimentaryOrder(order) ? order.menuValue ?? order.subtotal : order.grandTotal)} />
                </div>

                <div className="mb-4 flex flex-wrap gap-2">
                  <span className={`rounded-full px-3 py-1 text-xs font-black ${kot.tone}`}>KOT: {kot.label}</span>
                  <span className={`rounded-full px-3 py-1 text-xs font-black ${voided ? 'bg-red-100 text-red-700' : paymentStatus === 'PAID' ? 'bg-emerald-100 text-emerald-700' : paymentStatus === 'NOT_REQUIRED' ? 'bg-purple-100 text-purple-700' : 'bg-violet-100 text-violet-700'}`}>
                    Payment: {paymentOutcome}{payAtCounter && paymentStatus !== 'PAID' && !voided ? ' / PAY AT COUNTER' : ''}
                  </span>
                  <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-black text-neutral-600">Fulfillment: {fulfillmentStatus(bundle)}</span>
                </div>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <button onClick={() => setSelectedBundle(bundle)} className="inline-flex items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm font-black text-neutral-700">
                    <Eye size={15} />
                    Details
                  </button>
                  <button onClick={() => printReceipt(bundle)} className="inline-flex items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm font-black text-neutral-700">
                    <Printer size={15} />
                    Reprint
                  </button>
                  {kot.label === 'Pending' && (
                    <button onClick={() => updateKotStatus(bundle, 'READY')} className="rounded-xl bg-emerald-600 px-3 py-2 text-sm font-black text-white">
                      Mark Ready
                    </button>
                  )}
                  {kot.label === 'Ready' && (
                    <button onClick={() => updateKotStatus(bundle, 'SERVED')} className="rounded-xl bg-neutral-900 px-3 py-2 text-sm font-black text-white">
                      Mark Served
                    </button>
                  )}
                  {payAtCounter && paymentStatus !== 'PAID' && !voided && canSettle && (
                    <button onClick={() => openSettleModal(bundle)} className="rounded-xl bg-[#5c4033] px-3 py-2 text-sm font-black text-white">
                      Settle Payment
                    </button>
                  )}
                  {voided && (
                    <span className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-center text-sm font-black text-red-700">
                      Cannot settle voided
                    </span>
                  )}
                  {canVoidOrders && !voided && (
                    <button onClick={() => setVoidBundle(bundle)} className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-black text-red-700">
                      Void Order
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {selectedBundle && (
        <OrderDetailDrawer
          bundle={selectedBundle}
          onClose={() => setSelectedBundle(null)}
          onPrint={() => printReceipt(selectedBundle)}
          onSettle={() => openSettleModal(selectedBundle)}
          canSettle={canSettle && isPayAtCounter(selectedBundle.order, selectedBundle.payments) && inferPaymentStatus(selectedBundle.order, selectedBundle.payments) !== 'PAID' && effectiveOrderStatus(selectedBundle.order) !== 'VOIDED'}
        />
      )}

      {settleBundle && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-4">
          <div className="flex max-h-[94dvh] w-full max-w-lg flex-col overflow-hidden rounded-3xl bg-white shadow-xl">
            <div className="flex items-start justify-between gap-4 border-b border-neutral-200 p-5">
              <div>
                <h2 className="text-xl font-black text-neutral-900">Settle Payment</h2>
                <p className="mt-1 font-mono text-sm text-neutral-500">{settleBundle.order.orderNumber}</p>
              </div>
              <button onClick={() => setSettleBundle(null)} className="rounded-full p-2 text-neutral-400 hover:bg-neutral-100">
                <X size={20} />
              </button>
            </div>
            <div className="space-y-4 p-5">
              <div className="rounded-2xl bg-violet-50 p-4 text-sm font-bold text-violet-800">
                This updates payment rows only. It does not create another order, KOT, or stock deduction.
              </div>

              <label className="flex items-center gap-2 text-sm font-black text-neutral-700">
                <input
                  type="checkbox"
                  checked={isSplitSettlement}
                  disabled={settling}
                  onChange={event => {
                    setIsSplitSettlement(event.target.checked);
                    setSettleMethod('');
                    setCashReceived('');
                    setSettleRows([{ method: '', amount: settlementOutstanding.toFixed(2) }]);
                  }}
                />
                Split payment
              </label>

              {isSplitSettlement ? (
                <div className="space-y-2">
                  {settleRows.map((row, index) => (
                    <div key={index} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
                      <select
                        value={row.method}
                        onChange={event => setSettleRows(prev => prev.map((item, itemIndex) => itemIndex === index ? { ...item, method: event.target.value as PaymentMethod } : item))}
                        disabled={settling}
                        className="rounded-xl border border-neutral-200 px-3 py-2 text-sm font-bold"
                      >
                        <option value="">Select method...</option>
                        {PAYMENT_METHODS.map(method => <option key={method} value={method}>{method}</option>)}
                      </select>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={row.amount}
                        onChange={event => setSettleRows(prev => prev.map((item, itemIndex) => itemIndex === index ? { ...item, amount: event.target.value } : item))}
                        disabled={settling}
                        className="rounded-xl border border-neutral-200 px-3 py-2 text-sm font-bold"
                      />
                      <button
                        onClick={() => setSettleRows(prev => prev.filter((_, itemIndex) => itemIndex !== index))}
                        disabled={settleRows.length === 1 || settling}
                        className="rounded-xl border border-neutral-200 px-3 py-2 text-sm font-black text-neutral-600 disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => setSettleRows(prev => [...prev, { method: '', amount: Math.max(0, settlementBalance).toFixed(2) }])}
                    disabled={settling}
                    className="rounded-xl border border-neutral-200 px-3 py-2 text-sm font-black text-neutral-700"
                  >
                    Add Payment Row
                  </button>
                </div>
              ) : (
                <label className="block">
                  <span className="text-xs font-black uppercase tracking-widest text-neutral-500">Payment method</span>
                  <select
                    value={settleMethod}
                    onChange={event => setSettleMethod(event.target.value as PaymentMethod)}
                    disabled={settling}
                    className="mt-1 w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm font-black"
                  >
                    <option value="">Select payment method...</option>
                    {PAYMENT_METHODS.map(method => <option key={method} value={method}>{method}</option>)}
                  </select>
                </label>
              )}

              {!isSplitSettlement && settleMethod === 'CASH' && (
                <label className="block">
                  <span className="text-xs font-black uppercase tracking-widest text-neutral-500">Cash received optional</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={cashReceived}
                    onChange={event => setCashReceived(event.target.value)}
                    disabled={settling}
                    placeholder={settlementOutstanding.toFixed(2)}
                    className="mt-1 w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm font-black"
                  />
                  {!cashReceivedValid && (
                    <span className="mt-1 block text-xs font-bold text-red-700">Cash received must cover the outstanding amount.</span>
                  )}
                </label>
              )}

              <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4 text-sm">
                <Row label="Total due" value={formatMoney(settlementDue)} />
                <Row label="Already paid" value={formatMoney(settlementAlreadyPaid)} />
                <Row label="Outstanding" value={formatMoney(settlementOutstanding)} bold />
                <Row label="Allocated" value={formatMoney(settlementTotal)} />
                <Row label="Balance" value={formatMoney(settlementBalance)} bold tone={Math.abs(settlementBalance) <= 0.01 ? 'text-emerald-700' : 'text-red-700'} />
                {!isSplitSettlement && settleMethod === 'CASH' && (
                  <>
                    <Row label="Cash received" value={formatMoney(cashReceivedAmount)} />
                    <Row label="Change due" value={formatMoney(cashChangeDue)} bold />
                  </>
                )}
              </div>

              <button
                onClick={settlePayment}
                disabled={!settlementReady || settling}
                className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#5c4033] px-4 py-3 font-black text-white disabled:bg-neutral-200 disabled:text-neutral-500"
              >
                {settling ? <Loader2 size={18} className="animate-spin" /> : <Banknote size={18} />}
                Confirm Payment
              </button>
            </div>
          </div>
        </div>
      )}

      {voidBundle && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-4">
          <div className="flex max-h-[94dvh] w-full max-w-lg flex-col overflow-hidden rounded-3xl bg-white shadow-xl">
            <div className="flex items-start justify-between gap-4 border-b border-neutral-200 p-5">
              <div>
                <h2 className="text-xl font-black text-red-700">Void Order</h2>
                <p className="mt-1 font-mono text-sm text-neutral-500">{voidBundle.order.orderNumber}</p>
              </div>
              <button onClick={() => setVoidBundle(null)} className="rounded-full p-2 text-neutral-400 hover:bg-neutral-100">
                <X size={20} />
              </button>
            </div>
            <div className="space-y-4 p-5">
              <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700">
                This marks the order VOIDED, cancels related KOT rows, and reverses original sale stock movements. It does not delete the order.
              </div>
              <label className="block">
                <span className="text-xs font-black uppercase tracking-widest text-neutral-500">Void reason</span>
                <textarea
                  value={voidReason}
                  onChange={event => setVoidReason(event.target.value)}
                  className="mt-1 min-h-24 w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm font-bold outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100"
                  placeholder="Why is this order being voided?"
                />
              </label>
              <label className="block">
                <span className="text-xs font-black uppercase tracking-widest text-neutral-500">Confirmation</span>
                <input
                  value={voidConfirmation}
                  onChange={event => setVoidConfirmation(event.target.value)}
                  className="mt-1 w-full rounded-xl border border-neutral-200 px-3 py-2 font-mono text-sm font-bold outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100"
                  placeholder="VOID ORDER"
                />
              </label>
              <button
                onClick={voidOrder}
                disabled={voiding || !voidReason.trim() || voidConfirmation.trim() !== 'VOID ORDER'}
                className="flex w-full items-center justify-center gap-2 rounded-2xl bg-red-600 px-4 py-3 font-black text-white disabled:bg-neutral-200 disabled:text-neutral-500"
              >
                {voiding ? <Loader2 size={18} className="animate-spin" /> : <AlertCircle size={18} />}
                Void Order
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-neutral-50 p-3">
      <p className="text-[10px] font-black uppercase tracking-widest text-neutral-400">{label}</p>
      <p className="mt-1 truncate text-sm font-black text-neutral-800" title={value}>{value}</p>
    </div>
  );
}

function Row({ label, value, bold, tone }: { label: string; value: string; bold?: boolean; tone?: string }) {
  return (
    <div className={`flex justify-between gap-4 py-1 ${bold ? 'font-black' : 'font-bold text-neutral-600'} ${tone || ''}`}>
      <span>{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

function OrderDetailDrawer({
  bundle,
  onClose,
  onPrint,
  onSettle,
  canSettle,
}: {
  bundle: OrderBundle;
  onClose: () => void;
  onPrint: () => void;
  onSettle: () => void;
  canSettle: boolean;
}) {
  const { order, items, payments, kotItems } = bundle;
  const kot = kotSummary(kotItems);
  const paymentStatus = paymentOutcomeLabel(order, payments);
  const reversalAudit = buildPaymentReversalAudit(order, payments);
  const record = order as Order & Record<string, unknown>;
  const onlineRef = record.onlineOrderId || record.onlineOrderReference || record.linkedOnlineOrderId || record.sourceOrderId || null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50">
      <div className="flex h-full w-full max-w-2xl min-w-0 flex-col bg-white shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b border-neutral-200 p-5">
          <div>
            <p className="text-xs font-black uppercase tracking-widest text-neutral-400">Order Details</p>
            <h2 className="mt-1 font-mono text-2xl font-black text-neutral-900">{order.orderNumber}</h2>
            <p className="mt-1 text-sm font-bold text-neutral-500">{order.storeName} • {order.orderType?.replace('_', ' ')}</p>
          </div>
          <button onClick={onClose} className="rounded-full p-2 text-neutral-400 hover:bg-neutral-100">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          {effectiveOrderStatus(order) === 'VOIDED' && (
            <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700">
              VOIDED: {order.voidReason || 'No reason saved'}
              {reversalAudit.paymentReversalStatus !== 'NOT_REQUIRED' && (
                <p className="mt-2 text-xs">
                  Payment outcome: {paymentStatus} · Reversal total {formatMoney(reversalAudit.paymentReversalTotal)}
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Info label="Guest" value={order.customerName || 'Walk-in'} />
            <Info label="Phone" value={order.customerPhone || '-'} />
            <Info label="Table" value={order.tableNumber || '-'} />
            <Info label="Source" value={sourceLabel(order)} />
            <Info label="KOT" value={kot.label} />
            <Info label="Payment" value={paymentStatus} />
          </div>

          {onlineRef && (
            <div className="rounded-2xl border border-blue-100 bg-blue-50 p-4 text-sm font-bold text-blue-800">
              Linked online order reference: {String(onlineRef)}
            </div>
          )}

          <section>
            <h3 className="mb-2 text-sm font-black uppercase tracking-widest text-neutral-500">Items</h3>
            <div className="overflow-hidden rounded-2xl border border-neutral-200">
              {items.map(item => (
                <div key={item.id || item.itemCode} className="flex items-start justify-between gap-3 border-b border-neutral-100 p-3 last:border-b-0">
                  <div>
                    <p className="font-black text-neutral-900">{item.itemName}</p>
                    <p className="text-xs font-bold text-neutral-500">{money(item.quantity)} x {formatMoney(item.unitPrice)} • {orderItemDisplayStatus(order, item)}</p>
                  </div>
                  <p className="font-mono font-black">{formatMoney(isComplimentaryOrder(order) ? money(item.quantity) * money(item.unitPrice) : item.lineTotal)}</p>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-black uppercase tracking-widest text-neutral-500">KOT Items</h3>
            {kotItems.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-neutral-300 p-4 text-sm font-bold text-neutral-500">No KOT found</div>
            ) : (
              <div className="space-y-2">
                {kotItems.map(kotItem => (
                  <div key={kotItem.id} className="flex items-center justify-between rounded-2xl border border-neutral-200 p-3">
                    <div>
                      <p className="font-black">{kotItem.quantity}x {kotItem.itemName}</p>
                      <p className="text-xs font-bold text-neutral-500">{kotItem.station}</p>
                    </div>
                    <span className={`rounded-full px-3 py-1 text-xs font-black ${kotSummary([kotItem]).tone}`}>{kotItem.status}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-sm font-black uppercase tracking-widest text-neutral-500">Totals</h3>
            <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4 text-sm">
              <Row label={isComplimentaryOrder(order) ? 'Menu Value' : 'Subtotal'} value={formatMoney(order.menuValue ?? order.subtotal)} />
              <Row label={isComplimentaryOrder(order) ? 'Complimentary Discount' : `Discount (${money(order.discountPercent).toFixed(2)}%)`} value={`-${formatMoney(order.complimentaryDiscount ?? order.discountAmount ?? order.discountTotal ?? order.discount)}`} />
              <Row label="Taxable" value={formatMoney(order.taxableAmount ?? Math.max(0, money(order.subtotal) - money(order.discountTotal)))} />
              <Row label="GST" value={formatMoney(order.gstTotal ?? order.taxTotal)} />
              <Row label={isComplimentaryOrder(order) ? 'Amount Payable' : 'Total'} value={formatMoney(order.grandTotal)} bold />
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-black uppercase tracking-widest text-neutral-500">Payment</h3>
            <div className={`rounded-2xl border p-4 text-sm ${isComplimentaryOrder(order) ? 'border-purple-200 bg-purple-50 text-purple-900' : 'border-neutral-200'}`}>
              {isComplimentaryOrder(order) ? (
                <div className="space-y-1 text-center font-black">
                  <p>COMPLIMENTARY — NO PAYMENT REQUIRED</p>
                  <p className="text-xs">Payment Status: NOT REQUIRED</p>
                </div>
              ) : (payments.length ? payments : [{ method: order.paymentMethod, amount: order.grandTotal, reference: null, createdAt: null }]).map((payment, index) => (
                <Row key={`${payment.method}-${index}`} label={payment.method} value={formatMoney(payment.amount)} />
              ))}
            </div>
          </section>

          {effectiveOrderStatus(order) === 'VOIDED' && reversalAudit.paymentReversalBreakdown.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-black uppercase tracking-widest text-neutral-500">Void Payment Audit</h3>
              <div className="space-y-2 rounded-2xl border border-red-100 bg-red-50 p-4 text-sm">
                {reversalAudit.paymentReversalBreakdown.map((line, index) => (
                  <div key={`${line.method}-${index}`} className="rounded-xl bg-white p-3">
                    <div className="flex justify-between gap-3 font-black text-red-800">
                      <span>{line.method}</span>
                      <span>{formatMoney(line.amount)}</span>
                    </div>
                    <p className="mt-1 text-xs font-bold text-red-700">{line.reversalStatus}</p>
                    <p className="mt-1 text-xs text-red-700">{line.reason}</p>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        <div className="grid grid-cols-1 gap-2 border-t border-neutral-200 bg-neutral-50 p-3 sm:grid-cols-2 sm:p-4">
          <button onClick={onPrint} className="inline-flex items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-white px-4 py-3 font-black text-neutral-700">
            <Printer size={18} />
            Reprint
          </button>
          <button
            onClick={onSettle}
            disabled={!canSettle}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#5c4033] px-4 py-3 font-black text-white disabled:bg-neutral-200 disabled:text-neutral-500"
          >
            <CreditCard size={18} />
            Settle
          </button>
        </div>
      </div>
    </div>
  );
}
