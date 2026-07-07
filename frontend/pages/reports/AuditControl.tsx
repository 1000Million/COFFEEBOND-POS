import React, { ReactNode, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Calendar,
  CheckCircle2,
  Clock,
  FileWarning,
  Loader2,
  ShieldCheck,
  Store as StoreIcon,
  XCircle,
} from 'lucide-react';
import { collection, doc, getDoc, getDocs, query, Timestamp, where } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../contexts/AuthContext';
import { DayClosing, KotItem, OnlineOrder, Order, PaymentMethod, Store } from '../../types';

type AuditStatus = 'PASS' | 'WARNING' | 'FAIL';

type PaymentLine = {
  method: PaymentMethod | string;
  amount: number;
};

type StockMovementDoc = {
  id: string;
  storeId?: string;
  storeName?: string;
  inventoryItemId?: string;
  inventoryItemName?: string;
  movementType?: string;
  reason?: string;
  quantity?: number;
  unit?: string;
  referenceType?: string;
  referenceId?: string | null;
  stockItemType?: string;
  stockItemCode?: string;
  createdAt?: any;
  createdByName?: string;
};

type GstConfig = {
  defaultRate: number;
  storeOverrides: Record<string, number>;
};

const PAYMENT_METHODS: PaymentMethod[] = ['CASH', 'UPI', 'CARD', 'SWIGGY', 'ZOMATO', 'CREDIT', 'COMPLIMENTARY', 'PAY_AT_COUNTER'];
const APP_TAX_RATE_KEYS = ['defaultGstRate', 'gstRate', 'taxRate', 'defaultTaxRate', 'defaultGSTPercent', 'gstPercent', 'taxPercent'];
const STORE_TAX_RATE_KEYS = ['gstRate', 'taxRate', 'defaultGstRate', 'defaultTaxRate', 'gstPercent', 'taxPercent'];

function todayIso(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dayClosingId(storeId: string, businessDate: string): string {
  return `${storeId}_${businessDate}`;
}

function money(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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

function formatDateTime(value: any): string {
  const date = toDate(value);
  return date ? date.toLocaleString() : '-';
}

function ageMinutes(value: any): number {
  const date = toDate(value);
  if (!date) return 0;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
}

function effectiveOrderStatus(order: Order): 'COMPLETED' | 'VOIDED' | 'CANCELLED' {
  if (order.status === 'VOIDED') return 'VOIDED';
  if (order.status === 'CANCELLED') return 'CANCELLED';
  return 'COMPLETED';
}

function orderTaxTotal(order: Order): number {
  const gstTotal = money(order.gstTotal);
  return gstTotal > 0 ? gstTotal : money(order.taxTotal);
}

function orderDiscountTotal(order: Order): number {
  const discountAmount = money(order.discountAmount);
  if (discountAmount > 0) return discountAmount;
  const discountTotal = money(order.discountTotal);
  if (discountTotal > 0) return discountTotal;
  return money(order.discount);
}

function orderTaxableAmount(order: Order): number {
  return money(order.taxableAmount ?? (money(order.subtotal) - orderDiscountTotal(order)));
}

function orderPaymentBreakdown(order: Order): PaymentLine[] {
  const rawBreakdown = (order as Order & { paymentBreakdown?: PaymentLine[] }).paymentBreakdown;
  if (Array.isArray(rawBreakdown) && rawBreakdown.length > 0) {
    const normalized = rawBreakdown
      .map(payment => ({
        method: payment.method || 'UNKNOWN',
        amount: money(payment.amount),
      }))
      .filter(payment => payment.amount > 0);
    if (normalized.length > 0) return normalized;
  }

  return [{
    method: order.paymentMethod || 'UNKNOWN',
    amount: money(order.grandTotal),
  }];
}

function emptyPaymentBreakdown(): Record<PaymentMethod, number> {
  return PAYMENT_METHODS.reduce((acc, method) => {
    acc[method] = 0;
    return acc;
  }, {} as Record<PaymentMethod, number>);
}

function allowedStoreIds(staffProfile: NonNullable<ReturnType<typeof useAuth>['staffProfile']>): string[] {
  return staffProfile.assignedStoreIds?.length ? staffProfile.assignedStoreIds : staffProfile.storeIds || [];
}

function parseRate(value: unknown): number {
  const rate = money(value);
  return rate > 0 ? rate : 0;
}

function pickRate(source: Record<string, unknown> | null | undefined, keys: string[]): number {
  if (!source) return 0;
  for (const key of keys) {
    const rate = parseRate(source[key]);
    if (rate > 0) return rate;
  }
  return 0;
}

function normalizeStoreOverrides(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {};
  return Object.entries(value as Record<string, unknown>).reduce((acc, [key, rate]) => {
    const parsed = parseRate(rate);
    if (parsed > 0) acc[key] = parsed;
    return acc;
  }, {} as Record<string, number>);
}

function storeGstRate(store: Store | null, gstConfig: GstConfig): number {
  if (!store) return gstConfig.defaultRate;
  const override = gstConfig.storeOverrides[store.id] || gstConfig.storeOverrides[store.code];
  if (override > 0) return override;
  const storeRate = pickRate(store as unknown as Record<string, unknown>, STORE_TAX_RATE_KEYS);
  return storeRate > 0 ? storeRate : gstConfig.defaultRate;
}

function checkTone(status: AuditStatus): string {
  if (status === 'PASS') return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  if (status === 'WARNING') return 'border-amber-200 bg-amber-50 text-amber-800';
  return 'border-red-200 bg-red-50 text-red-800';
}

function statusIcon(status: AuditStatus) {
  if (status === 'PASS') return <CheckCircle2 size={18} />;
  if (status === 'WARNING') return <AlertTriangle size={18} />;
  return <XCircle size={18} />;
}

function SummaryCard({ label, value, tone = 'neutral' }: { label: string; value: ReactNode; tone?: 'neutral' | 'green' | 'amber' | 'red' }) {
  const toneClass = {
    neutral: 'border-neutral-200 bg-white text-neutral-900',
    green: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    amber: 'border-amber-200 bg-amber-50 text-amber-900',
    red: 'border-red-200 bg-red-50 text-red-900',
  }[tone];

  return (
    <div className={`rounded-2xl border p-4 shadow-sm ${toneClass}`}>
      <p className="text-[10px] font-black uppercase tracking-widest opacity-60">{label}</p>
      <div className="mt-2 font-mono text-2xl font-black">{value}</div>
    </div>
  );
}

function AuditCheckCard({ title, status, detail }: { title: string; status: AuditStatus; detail: string }) {
  return (
    <div className={`rounded-2xl border p-4 ${checkTone(status)}`}>
      <div className="flex items-center gap-2 text-sm font-black uppercase tracking-wider">
        {statusIcon(status)}
        {status}
      </div>
      <h3 className="mt-3 text-base font-black text-neutral-900">{title}</h3>
      <p className="mt-1 text-sm font-semibold opacity-80">{detail}</p>
    </div>
  );
}

function TableSection({ title, description, headers, rows }: { title: string; description: string; headers: string[]; rows: ReactNode[][] }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
      <div className="border-b border-neutral-100 p-5">
        <h2 className="font-black text-neutral-900">{title}</h2>
        <p className="mt-1 text-sm font-medium text-neutral-500">{description}</p>
      </div>
      {rows.length === 0 ? (
        <div className="p-5 text-sm font-bold text-neutral-400">No records found.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full whitespace-nowrap text-left text-sm">
            <thead className="bg-neutral-50 text-[10px] uppercase tracking-widest text-neutral-500">
              <tr>
                {headers.map(header => <th key={header} className="px-4 py-3 font-black">{header}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="align-top">
                  {row.map((cell, cellIndex) => <td key={cellIndex} className="px-4 py-3 font-bold text-neutral-700">{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function AuditControl() {
  const { staffProfile } = useAuth();
  const [stores, setStores] = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState('');
  const [dateStr, setDateStr] = useState(todayIso());
  const [orders, setOrders] = useState<Order[]>([]);
  const [onlineOrders, setOnlineOrders] = useState<OnlineOrder[]>([]);
  const [kotItems, setKotItems] = useState<KotItem[]>([]);
  const [dayClosing, setDayClosing] = useState<DayClosing | null>(null);
  const [stockMovements, setStockMovements] = useState<StockMovementDoc[]>([]);
  const [gstConfig, setGstConfig] = useState<GstConfig>({ defaultRate: 0, storeOverrides: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const accessibleStores = useMemo(() => {
    if (!staffProfile) return [];
    if (staffProfile.role === 'ADMIN') return stores;
    const allowedIds = allowedStoreIds(staffProfile);
    return stores.filter(store => allowedIds.includes(store.id));
  }, [staffProfile, stores]);

  const selectedStore = useMemo(() => {
    return accessibleStores.find(store => store.id === selectedStoreId) || null;
  }, [accessibleStores, selectedStoreId]);

  useEffect(() => {
    let active = true;

    const loadStores = async () => {
      if (!staffProfile) return;
      setLoading(true);
      setError('');
      try {
        const storeSnap = await getDocs(query(collection(db, 'stores'), where('isActive', '==', true)));
        const loadedStores = storeSnap.docs
          .map(storeDoc => ({ id: storeDoc.id, ...storeDoc.data() } as Store))
          .sort((a, b) => a.name.localeCompare(b.name));
        if (active) setStores(loadedStores);
      } catch (err: any) {
        console.error('Failed to load stores for audit control', err);
        if (active) setError(`Failed to load stores: ${err.message || err.toString()}`);
      } finally {
        if (active) setLoading(false);
      }
    };

    loadStores();
    return () => { active = false; };
  }, [staffProfile]);

  useEffect(() => {
    if (selectedStoreId || accessibleStores.length === 0) return;
    const udayPark = accessibleStores.find(store => store.code === 'UDAY_PARK');
    setSelectedStoreId(udayPark?.id || accessibleStores[0].id);
  }, [accessibleStores, selectedStoreId]);

  useEffect(() => {
    let active = true;

    const loadAuditData = async () => {
      if (!staffProfile || !selectedStore) return;
      setLoading(true);
      setError('');

      const [year, month, day] = dateStr.split('-').map(Number);
      const startOfDay = new Date(year, month - 1, day, 0, 0, 0, 0);
      const endOfDay = new Date(year, month - 1, day, 23, 59, 59, 999);
      const startTs = Timestamp.fromDate(startOfDay);
      const endTs = Timestamp.fromDate(endOfDay);

      try {
        const [ordersSnap, onlineSnap, kotSnap, closingSnap, gstSnap] = await Promise.all([
          getDocs(query(
            collection(db, 'orders'),
            where('storeId', '==', selectedStore.id),
            where('createdAt', '>=', startTs),
            where('createdAt', '<=', endTs),
          )),
          getDocs(query(
            collection(db, 'onlineOrders'),
            where('storeId', '==', selectedStore.id),
          )),
          getDocs(query(
            collection(db, 'kotItems'),
            where('storeId', '==', selectedStore.id),
            where('createdAt', '>=', startTs),
            where('createdAt', '<=', endTs),
          )),
          getDoc(doc(db, 'dayClosings', dayClosingId(selectedStore.id, dateStr))),
          getDoc(doc(db, 'appSettings', 'gstConfig')),
        ]);

        const loadedOrders = ordersSnap.docs.map(orderDoc => ({ id: orderDoc.id, ...orderDoc.data() } as Order));
        const voidedOrders = loadedOrders.filter(order => effectiveOrderStatus(order) === 'VOIDED' && order.id);
        const movementSnaps = await Promise.all(voidedOrders.map(order => getDocs(query(
          collection(db, 'stockMovements'),
          where('referenceId', '==', order.id),
        ))));
        const loadedMovements = movementSnaps.flatMap(snap => snap.docs.map(movementDoc => ({
          id: movementDoc.id,
          ...movementDoc.data(),
        } as StockMovementDoc)));

        const gstData = gstSnap.exists() ? gstSnap.data() as Record<string, unknown> : null;
        const nextGstConfig = {
          defaultRate: pickRate(gstData, APP_TAX_RATE_KEYS),
          storeOverrides: normalizeStoreOverrides(gstData?.storeOverrides),
        };

        if (active) {
          setOrders(loadedOrders);
          setOnlineOrders(onlineSnap.docs
            .map(orderDoc => ({ id: orderDoc.id, ...orderDoc.data() } as OnlineOrder))
            .filter(order => {
              const createdAt = toDate(order.createdAt);
              return createdAt ? createdAt >= startOfDay && createdAt <= endOfDay : false;
            }));
          setKotItems(kotSnap.docs.map(kotDoc => ({ id: kotDoc.id, ...kotDoc.data() } as KotItem)));
          setDayClosing(closingSnap.exists() ? ({ id: closingSnap.id, ...closingSnap.data() } as DayClosing) : null);
          setStockMovements(loadedMovements);
          setGstConfig(nextGstConfig);
        }
      } catch (err: any) {
        console.error('Failed to load audit control data', err);
        if (active) {
          if (err.message && (err.message.includes('requires an index') || err.message.includes('failed-precondition'))) {
            setError('Firestore index required for one audit lookup. Deploy Firestore indexes before using this dashboard for this filter.');
          } else {
            setError(`Failed to load audit data: ${err.message || err.toString()}`);
          }
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    loadAuditData();
    return () => { active = false; };
  }, [dateStr, selectedStore, staffProfile]);

  const completedOrders = useMemo(() => orders.filter(order => effectiveOrderStatus(order) === 'COMPLETED'), [orders]);
  const voidedOrders = useMemo(() => orders.filter(order => effectiveOrderStatus(order) === 'VOIDED'), [orders]);
  const paymentBreakdown = useMemo(() => {
    const breakdown = emptyPaymentBreakdown();
    completedOrders.forEach(order => {
      orderPaymentBreakdown(order).forEach(payment => {
        if (PAYMENT_METHODS.includes(payment.method as PaymentMethod)) {
          breakdown[payment.method as PaymentMethod] += payment.amount;
        }
      });
    });
    return breakdown;
  }, [completedOrders]);

  const grossSales = completedOrders.reduce((sum, order) => sum + money(order.grandTotal), 0);
  const voidedSales = voidedOrders.reduce((sum, order) => sum + money(order.grandTotal), 0);
  const netSales = grossSales;
  const gstTotal = completedOrders.reduce((sum, order) => sum + orderTaxTotal(order), 0);
  const taxableSales = completedOrders.reduce((sum, order) => sum + orderTaxableAmount(order), 0);
  const discountTotal = completedOrders.reduce((sum, order) => sum + orderDiscountTotal(order), 0);
  const expectedCash = paymentBreakdown.CASH;
  const actualCash = money(dayClosing?.actualCash);
  const cashVariance = dayClosing ? money(dayClosing.cashVariance) : 0;
  const paymentTotal = PAYMENT_METHODS.reduce((sum, method) => sum + paymentBreakdown[method], 0);
  const paymentMismatch = paymentTotal - netSales;
  const unsettledPayAtCounterOrders = completedOrders.filter(order => {
    const hasPayAtCounter = order.paymentMethod === 'PAY_AT_COUNTER'
      || orderPaymentBreakdown(order).some(payment => payment.method === 'PAY_AT_COUNTER' && payment.amount > 0);
    return hasPayAtCounter && order.paymentStatus !== 'PAID';
  });
  const gstRate = storeGstRate(selectedStore, gstConfig);
  const zeroGstOrders = gstRate > 0
    ? completedOrders.filter(order => money(order.grandTotal) > 0 && orderTaxTotal(order) <= 0.005)
    : [];
  const reversalMovements = stockMovements.filter(movement => movement.movementType === 'ORDER_VOID_REVERSAL');
  const voidedOrdersWithoutReversal = voidedOrders.filter(order => !reversalMovements.some(movement => movement.referenceId === order.id));
  const pendingOnlineOrders = onlineOrders.filter(order => order.status === 'PENDING' || order.status === 'NEEDS_ATTENTION');
  const stalePendingOnlineOrders = pendingOnlineOrders.filter(order => ageMinutes(order.createdAt) > 15);
  const rejectedOnlineOrders = onlineOrders.filter(order => order.status === 'REJECTED');
  const acceptedOnlineOrders = onlineOrders.filter(order => order.status === 'ACCEPTED' || order.status === 'CONVERTED');
  const pendingKotItems = kotItems.filter(item => item.status === 'PENDING');
  const preparingKotItems = kotItems.filter(item => item.status === 'PREPARING');
  const readyKotItems = kotItems.filter(item => item.status === 'READY');
  const oldPendingKotItems = pendingKotItems.filter(item => ageMinutes(item.createdAt) > 15);
  const voidsMissingReason = voidedOrders.filter(order => !String(order.voidReason || '').trim());

  const cashCheck: AuditStatus = !dayClosing ? 'FAIL' : Math.abs(cashVariance) < 0.01 ? 'PASS' : 'WARNING';
  const paymentCheck: AuditStatus = Math.abs(paymentMismatch) > 0.01 || unsettledPayAtCounterOrders.length > 0 ? 'FAIL' : 'PASS';
  const voidCheck: AuditStatus = voidsMissingReason.length > 0 ? 'FAIL' : voidedOrders.length > 0 ? 'WARNING' : 'PASS';
  const stockCheck: AuditStatus = voidedOrdersWithoutReversal.length > 0 ? 'FAIL' : reversalMovements.length > 0 ? 'WARNING' : 'PASS';
  const gstCheck: AuditStatus = gstRate > 0 ? zeroGstOrders.length > 0 ? 'FAIL' : 'PASS' : 'WARNING';
  const onlineCheck: AuditStatus = stalePendingOnlineOrders.length > 0 ? 'FAIL' : pendingOnlineOrders.length > 0 ? 'WARNING' : 'PASS';
  const kotCheck: AuditStatus = oldPendingKotItems.length > 0 ? 'FAIL' : (pendingKotItems.length + preparingKotItems.length + readyKotItems.length) > 0 ? 'WARNING' : 'PASS';
  const dayCloseCheck: AuditStatus = !dayClosing ? 'FAIL' : Math.abs(cashVariance) >= 0.01 && !String(dayClosing.notes || '').trim() ? 'WARNING' : 'PASS';

  if (!staffProfile) return null;

  return (
    <div className="min-h-screen bg-[#fcf9f5] pb-24 font-sans text-neutral-800">
      <div className="sticky top-0 z-30 border-b border-neutral-200 bg-white shadow-sm">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 md:flex-row md:items-center md:justify-between md:px-8">
          <div className="flex items-center gap-4">
            <Link to="/reports" className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-100 text-neutral-600 transition-colors hover:bg-neutral-200">
              <ArrowLeft size={20} />
            </Link>
            <div>
              <p className="text-xs font-black uppercase tracking-[0.2em] text-amber-700">Owner Review</p>
              <h1 className="text-2xl font-black tracking-tight text-neutral-900">Audit & Control Dashboard</h1>
              <p className="text-sm font-medium text-neutral-500">Read-only day-close, cash, payment, GST, void, stock, online order, and KOT checks.</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={16} />
              <input
                type="date"
                value={dateStr}
                onChange={event => setDateStr(event.target.value)}
                onInput={event => setDateStr(event.currentTarget.value)}
                className="rounded-lg border border-neutral-200 bg-neutral-50 py-2 pl-9 pr-4 text-sm font-bold outline-none focus:border-[#5c4033] focus:ring-2 focus:ring-[#5c4033]/20"
              />
            </div>

            <div className="relative">
              <StoreIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={16} />
              <select
                value={selectedStoreId}
                onChange={event => setSelectedStoreId(event.target.value)}
                className="appearance-none rounded-lg border border-neutral-200 bg-neutral-50 py-2 pl-9 pr-8 text-sm font-bold outline-none focus:border-[#5c4033] focus:ring-2 focus:ring-[#5c4033]/20"
              >
                {accessibleStores.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}
              </select>
            </div>
          </div>
        </div>
      </div>

      <main className="mx-auto mt-8 max-w-7xl space-y-6 px-4 md:px-8">
        {error && (
          <div className="flex gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700">
            <FileWarning size={18} className="shrink-0" />
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex h-64 flex-col items-center justify-center gap-4 text-neutral-400">
            <Loader2 size={32} className="animate-spin text-[#5c4033]" />
            <p className="font-medium animate-pulse">Running audit checks...</p>
          </div>
        ) : !selectedStore ? (
          <div className="rounded-2xl border border-neutral-200 bg-white p-10 text-center shadow-sm">
            <h2 className="mb-2 text-xl font-bold text-neutral-800">No store available</h2>
            <p className="text-neutral-500">Your profile does not have an assigned store for audit review.</p>
          </div>
        ) : (
          <>
            <section className="grid grid-cols-2 gap-4 lg:grid-cols-5">
              <SummaryCard label="Day Close" value={dayClosing ? 'Closed' : 'Not Closed'} tone={dayClosing ? 'green' : 'red'} />
              <SummaryCard label="Completed Bills" value={completedOrders.length} />
              <SummaryCard label="Voided Bills" value={voidedOrders.length} tone={voidedOrders.length > 0 ? 'red' : 'neutral'} />
              <SummaryCard label="Net Sales" value={formatMoney(netSales)} tone="green" />
              <SummaryCard label="GST Total" value={formatMoney(gstTotal)} />
              <SummaryCard label="Discount Total" value={formatMoney(discountTotal)} />
              <SummaryCard label="Expected Cash" value={formatMoney(expectedCash)} tone="amber" />
              <SummaryCard label="Actual Cash" value={dayClosing ? formatMoney(actualCash) : '-'} />
              <SummaryCard label="Cash Variance" value={dayClosing ? formatMoney(cashVariance) : '-'} tone={!dayClosing ? 'red' : Math.abs(cashVariance) < 0.01 ? 'green' : 'amber'} />
              <SummaryCard label="Pending Online" value={pendingOnlineOrders.length} tone={pendingOnlineOrders.length > 0 ? 'amber' : 'neutral'} />
              <SummaryCard label="Rejected Online" value={rejectedOnlineOrders.length} tone={rejectedOnlineOrders.length > 0 ? 'amber' : 'neutral'} />
              <SummaryCard label="Unsettled Pay Counter" value={unsettledPayAtCounterOrders.length} tone={unsettledPayAtCounterOrders.length > 0 ? 'red' : 'neutral'} />
              <SummaryCard label="Stock Reversals" value={reversalMovements.length} tone={reversalMovements.length > 0 ? 'amber' : 'neutral'} />
              <SummaryCard label="KOT Pending" value={pendingKotItems.length} tone={oldPendingKotItems.length > 0 ? 'red' : pendingKotItems.length > 0 ? 'amber' : 'neutral'} />
              <SummaryCard label="Payment Total" value={formatMoney(paymentTotal)} tone={Math.abs(paymentMismatch) > 0.01 ? 'red' : 'green'} />
            </section>

            <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
              <AuditCheckCard
                title="Cash Check"
                status={cashCheck}
                detail={!dayClosing ? 'Day close is missing.' : Math.abs(cashVariance) < 0.01 ? 'Cash matched expected cash.' : `Cash variance is ${formatMoney(cashVariance)}.`}
              />
              <AuditCheckCard
                title="Payment Check"
                status={paymentCheck}
                detail={Math.abs(paymentMismatch) > 0.01 ? `Payment total differs from net sales by ${formatMoney(paymentMismatch)}.` : unsettledPayAtCounterOrders.length > 0 ? `${unsettledPayAtCounterOrders.length} pay-at-counter orders are unsettled.` : 'Payment totals match net sales.'}
              />
              <AuditCheckCard
                title="Void Check"
                status={voidCheck}
                detail={voidsMissingReason.length > 0 ? `${voidsMissingReason.length} voided orders are missing a reason.` : voidedOrders.length > 0 ? `${voidedOrders.length} voided orders need owner review.` : 'No voided orders found.'}
              />
              <AuditCheckCard
                title="Stock Check"
                status={stockCheck}
                detail={voidedOrdersWithoutReversal.length > 0 ? `${voidedOrdersWithoutReversal.length} voided orders have no stock reversal movement.` : reversalMovements.length > 0 ? `${reversalMovements.length} stock reversal rows found.` : 'No reversal issues found.'}
              />
              <AuditCheckCard
                title="GST Check"
                status={gstCheck}
                detail={gstRate <= 0 ? 'GST config is not active for this store.' : zeroGstOrders.length > 0 ? `${zeroGstOrders.length} completed orders have zero GST.` : `GST active at ${gstRate}%.`}
              />
              <AuditCheckCard
                title="Online Order Check"
                status={onlineCheck}
                detail={stalePendingOnlineOrders.length > 0 ? `${stalePendingOnlineOrders.length} pending online orders are older than 15 minutes.` : pendingOnlineOrders.length > 0 ? `${pendingOnlineOrders.length} online orders are still pending.` : `${acceptedOnlineOrders.length} accepted/converted, ${rejectedOnlineOrders.length} rejected.`}
              />
              <AuditCheckCard
                title="KOT Check"
                status={kotCheck}
                detail={oldPendingKotItems.length > 0 ? `${oldPendingKotItems.length} pending KOT items are older than 15 minutes.` : `${pendingKotItems.length} pending, ${preparingKotItems.length} preparing, ${readyKotItems.length} ready.`}
              />
              <AuditCheckCard
                title="Day Close Check"
                status={dayCloseCheck}
                detail={!dayClosing ? 'Closing is missing.' : Math.abs(cashVariance) >= 0.01 && !String(dayClosing.notes || '').trim() ? 'Cash variance exists but notes are missing.' : `Closed by ${dayClosing.closedByName || 'Unknown'} at ${formatDateTime(dayClosing.closedAt)}.`}
              />
            </section>

            <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
                <h2 className="font-black text-neutral-900">Payment Breakdown</h2>
                <p className="mt-1 text-sm font-medium text-neutral-500">Completed orders only. Voided orders are excluded.</p>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  {PAYMENT_METHODS.map(method => (
                    <div key={method} className="rounded-xl border border-neutral-100 bg-neutral-50 p-3">
                      <p className="text-[10px] font-black uppercase tracking-widest text-neutral-400">{method}</p>
                      <p className="mt-1 font-mono text-lg font-black text-neutral-900">{formatMoney(paymentBreakdown[method])}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
                <h2 className="font-black text-neutral-900">Day Close Details</h2>
                <p className="mt-1 text-sm font-medium text-neutral-500">This dashboard is read-only and does not update closing records.</p>
                <div className="mt-4 space-y-3 text-sm">
                  <div className="flex justify-between gap-4"><span className="font-bold text-neutral-500">Store</span><span className="font-black text-neutral-900">{selectedStore.name}</span></div>
                  <div className="flex justify-between gap-4"><span className="font-bold text-neutral-500">Business Date</span><span className="font-mono font-black text-neutral-900">{dateStr}</span></div>
                  <div className="flex justify-between gap-4"><span className="font-bold text-neutral-500">Status</span><span className="font-black text-neutral-900">{dayClosing?.status || 'Not Closed'}</span></div>
                  <div className="flex justify-between gap-4"><span className="font-bold text-neutral-500">Closed By</span><span className="font-black text-neutral-900">{dayClosing?.closedByName || '-'}</span></div>
                  <div className="flex justify-between gap-4"><span className="font-bold text-neutral-500">Closed At</span><span className="font-black text-neutral-900">{formatDateTime(dayClosing?.closedAt)}</span></div>
                  <div className="rounded-xl border border-neutral-100 bg-neutral-50 p-3">
                    <p className="text-[10px] font-black uppercase tracking-widest text-neutral-400">Notes</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm font-bold text-neutral-700">{dayClosing?.notes || 'No notes recorded.'}</p>
                  </div>
                </div>
              </div>
            </section>

            <TableSection
              title="Voided Orders"
              description="Voids should have a reason, manager identity, timestamp, and matching stock reversal rows."
              headers={['Order', 'Total', 'Reason', 'Voided By', 'Voided At', 'Reversal']}
              rows={voidedOrders.map(order => [
                order.orderNumber,
                formatMoney(order.grandTotal),
                order.voidReason || <span className="text-red-700">Missing reason</span>,
                order.voidedByName || '-',
                formatDateTime(order.voidedAt),
                reversalMovements.some(movement => movement.referenceId === order.id) ? 'Found' : <span className="text-red-700">Missing</span>,
              ])}
            />

            <TableSection
              title="Pending Online Orders"
              description="Online orders older than 15 minutes should be accepted or rejected by staff."
              headers={['Reference', 'Customer', 'Status', 'Age', 'Total']}
              rows={pendingOnlineOrders.map(order => [
                order.id || '-',
                `${order.customerName} ${order.customerPhone ? `(${order.customerPhone})` : ''}`,
                order.status,
                `${ageMinutes(order.createdAt)}m`,
                formatMoney(order.grandTotal),
              ])}
            />

            <TableSection
              title="Unsettled PAY_AT_COUNTER Orders"
              description="These orders need settlement before cash/payment totals are considered final."
              headers={['Order', 'Customer', 'Payment Status', 'Total', 'Created']}
              rows={unsettledPayAtCounterOrders.map(order => [
                order.orderNumber,
                order.customerName || '-',
                order.paymentStatus || 'UNPAID',
                formatMoney(order.grandTotal),
                formatDateTime(order.createdAt),
              ])}
            />

            <TableSection
              title="Orders With Zero GST"
              description="Only flagged when GST configuration is active for this store."
              headers={['Order', 'Subtotal', 'Taxable', 'GST', 'Total']}
              rows={zeroGstOrders.map(order => [
                order.orderNumber,
                formatMoney(order.subtotal),
                formatMoney(orderTaxableAmount(order)),
                formatMoney(orderTaxTotal(order)),
                formatMoney(order.grandTotal),
              ])}
            />

            <TableSection
              title="Stock Reversals"
              description="Stock reversals created for voided orders."
              headers={['Order Ref', 'Item', 'Type', 'Qty', 'Created By', 'Created At']}
              rows={reversalMovements.map(movement => [
                movement.referenceId || '-',
                movement.inventoryItemName || movement.stockItemCode || '-',
                movement.stockItemType || movement.movementType || '-',
                `${money(movement.quantity)} ${movement.unit || ''}`,
                movement.createdByName || '-',
                formatDateTime(movement.createdAt),
              ])}
            />

            <TableSection
              title="KOT Pending / Old Items"
              description="Pending, preparing, and ready KOT rows that still need operational follow-up."
              headers={['Order', 'Item', 'Station', 'Status', 'Age']}
              rows={[...pendingKotItems, ...preparingKotItems, ...readyKotItems].map(item => [
                item.orderNumber,
                `${money(item.quantity)}x ${item.itemName}`,
                item.station,
                item.status,
                `${ageMinutes(item.createdAt)}m`,
              ])}
            />

            <TableSection
              title="Cash Variance Snapshot"
              description="Saved day close values compared against live completed-order cash totals."
              headers={['Field', 'Value']}
              rows={[
                ['Expected cash from completed orders', formatMoney(expectedCash)],
                ['Saved expected cash', dayClosing ? formatMoney(dayClosing.expectedCash) : '-'],
                ['Actual cash counted', dayClosing ? formatMoney(dayClosing.actualCash) : '-'],
                ['Cash variance', dayClosing ? formatMoney(dayClosing.cashVariance) : '-'],
                ['Dashboard payment total', formatMoney(paymentTotal)],
                ['Dashboard net sales', formatMoney(netSales)],
              ]}
            />

            <div className="flex items-start gap-3 rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm font-bold text-blue-800">
              <ShieldCheck size={18} className="mt-0.5 shrink-0" />
              Audit & Control is read-only. Opening this page does not modify orders, stock, KOT, online orders, day close, checkout, or reports data.
            </div>
          </>
        )}
      </main>
    </div>
  );
}
