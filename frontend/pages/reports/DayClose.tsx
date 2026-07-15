import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Calendar, CheckCircle2, Loader2, Save, Store as StoreIcon } from 'lucide-react';
import { collection, doc, getDoc, getDocs, query, serverTimestamp, setDoc, Timestamp, where } from 'firebase/firestore';
import { auth, db } from '../../lib/firebase';
import { useAuth } from '../../contexts/AuthContext';
import { DayClosing, Order, PaymentMethod, Store } from '../../types';
import { summarizeCollections } from '../../lib/paymentReversal';

const PAYMENT_METHODS: PaymentMethod[] = ['CASH', 'UPI', 'CARD', 'SWIGGY', 'ZOMATO', 'CREDIT', 'COMPLIMENTARY', 'PAY_AT_COUNTER'];

type ReportPaymentBreakdown = {
  method: PaymentMethod | string;
  amount: number;
};

type DayCloseSummary = {
  completedBillCount: number;
  voidedBillCount: number;
  grossSales: number;
  voidedSales: number;
  netSales: number;
  gstTotal: number;
  discountTotal: number;
  paymentBreakdown: Record<PaymentMethod, number>;
  expectedCash: number;
  grossPaymentsReceived: number;
  voidedPaymentTotal: number;
  refundedOrReversedPayments: number;
  refundPendingPayments: number;
  manualRefundRequiredPayments: number;
  netCollections: number;
};

function todayIso(): string {
  return new Date().toISOString().split('T')[0];
}

function moneyNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatMoney(value: number): string {
  return `₹${value.toFixed(2)}`;
}

function dayClosingId(storeId: string, businessDate: string): string {
  return `${storeId}_${businessDate}`;
}

function effectiveOrderStatus(order: Order): 'COMPLETED' | 'VOIDED' | 'CANCELLED' {
  if (order.status === 'VOIDED') return 'VOIDED';
  if (order.status === 'CANCELLED') return 'CANCELLED';
  return 'COMPLETED';
}

function orderTaxTotal(order: Order): number {
  const gstTotal = moneyNumber(order.gstTotal);
  return gstTotal > 0 ? gstTotal : moneyNumber(order.taxTotal);
}

function orderDiscountTotal(order: Order): number {
  const discountAmount = moneyNumber(order.discountAmount);
  if (discountAmount > 0) return discountAmount;
  const discountTotal = moneyNumber(order.discountTotal);
  if (discountTotal > 0) return discountTotal;
  return moneyNumber(order.discount);
}

function orderPaymentBreakdown(order: Order): ReportPaymentBreakdown[] {
  const rawBreakdown = (order as Order & { paymentBreakdown?: ReportPaymentBreakdown[] }).paymentBreakdown;
  if (Array.isArray(rawBreakdown) && rawBreakdown.length > 0) {
    const normalized = rawBreakdown
      .map(payment => ({
        method: payment.method || 'UNKNOWN',
        amount: moneyNumber(payment.amount),
      }))
      .filter(payment => payment.amount > 0);
    if (normalized.length > 0) return normalized;
  }

  return [{
    method: order.paymentMethod || 'UNKNOWN',
    amount: moneyNumber(order.grandTotal),
  }];
}

function emptyPaymentBreakdown(): Record<PaymentMethod, number> {
  return PAYMENT_METHODS.reduce((acc, method) => {
    acc[method] = 0;
    return acc;
  }, {} as Record<PaymentMethod, number>);
}

function buildSummary(orders: Order[]): DayCloseSummary {
  const completedOrders = orders.filter(order => effectiveOrderStatus(order) === 'COMPLETED');
  const voidedOrders = orders.filter(order => effectiveOrderStatus(order) === 'VOIDED');
  const paymentBreakdown = emptyPaymentBreakdown();
  const collectionAudit = summarizeCollections(orders);

  completedOrders.forEach(order => {
    orderPaymentBreakdown(order).forEach(payment => {
      if (PAYMENT_METHODS.includes(payment.method as PaymentMethod)) {
        paymentBreakdown[payment.method as PaymentMethod] += payment.amount;
      }
    });
  });

  const grossSales = completedOrders.reduce((sum, order) => sum + moneyNumber(order.grandTotal), 0);
  const voidedSales = voidedOrders.reduce((sum, order) => sum + moneyNumber(order.grandTotal), 0);

  return {
    completedBillCount: completedOrders.length,
    voidedBillCount: voidedOrders.length,
    grossSales,
    voidedSales,
    netSales: grossSales,
    gstTotal: completedOrders.reduce((sum, order) => sum + orderTaxTotal(order), 0),
    discountTotal: completedOrders.reduce((sum, order) => sum + orderDiscountTotal(order), 0),
    paymentBreakdown,
    expectedCash: paymentBreakdown.CASH,
    grossPaymentsReceived: collectionAudit.grossPaymentsReceived,
    voidedPaymentTotal: collectionAudit.voidedPaymentTotal,
    refundedOrReversedPayments: collectionAudit.refundedOrReversedPayments,
    refundPendingPayments: collectionAudit.refundPendingPayments,
    manualRefundRequiredPayments: collectionAudit.manualRefundRequiredPayments,
    netCollections: collectionAudit.netCollections,
  };
}

export default function DayClose() {
  const { staffProfile } = useAuth();
  const [dateStr, setDateStr] = useState(todayIso());
  const [stores, setStores] = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState('');
  const [orders, setOrders] = useState<Order[]>([]);
  const [existingClosing, setExistingClosing] = useState<DayClosing | null>(null);
  const [actualCash, setActualCash] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accessibleStores = useMemo(() => {
    if (!staffProfile) return [];
    if (staffProfile.role === 'ADMIN') return stores;
    const allowedStoreIds = staffProfile.assignedStoreIds?.length ? staffProfile.assignedStoreIds : (staffProfile.storeIds || []);
    return stores.filter(store => allowedStoreIds.includes(store.id));
  }, [staffProfile, stores]);

  const selectedStore = useMemo(() => {
    return accessibleStores.find(store => store.id === selectedStoreId) || null;
  }, [accessibleStores, selectedStoreId]);

  const summary = useMemo(() => buildSummary(orders), [orders]);
  const actualCashNumber = moneyNumber(actualCash);
  const cashVariance = actualCashNumber - summary.expectedCash;
  const canUpdateExistingClosing = staffProfile?.role === 'ADMIN' || staffProfile?.role === 'STORE_MANAGER';
  const canSave = Boolean(selectedStore && staffProfile && auth.currentUser && !error && (!existingClosing || canUpdateExistingClosing));

  useEffect(() => {
    let active = true;

    const loadStores = async () => {
      if (!staffProfile) return;
      setLoading(true);
      setError(null);
      try {
        const storeSnap = await getDocs(query(collection(db, 'stores'), where('isActive', '==', true)));
        const loadedStores = storeSnap.docs.map(storeDoc => ({ id: storeDoc.id, ...storeDoc.data() } as Store));
        if (active) setStores(loadedStores);
      } catch (err: any) {
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
    setSelectedStoreId(accessibleStores[0].id);
  }, [accessibleStores, selectedStoreId]);

  useEffect(() => {
    let active = true;

    const loadDayCloseData = async () => {
      if (!staffProfile || !selectedStoreId) return;
      setLoading(true);
      setError(null);
      setMessage(null);

      const [year, month, day] = dateStr.split('-').map(Number);
      const startOfDay = new Date(year, month - 1, day, 0, 0, 0, 0);
      const endOfDay = new Date(year, month - 1, day, 23, 59, 59, 999);
      const startTs = Timestamp.fromDate(startOfDay);
      const endTs = Timestamp.fromDate(endOfDay);

      try {
        const ordersSnap = await getDocs(query(
          collection(db, 'orders'),
          where('storeId', '==', selectedStoreId),
          where('createdAt', '>=', startTs),
          where('createdAt', '<=', endTs),
        ));
        const loadedOrders = ordersSnap.docs.map(orderDoc => ({ id: orderDoc.id, ...orderDoc.data() } as Order));

        const closingRef = doc(db, 'dayClosings', dayClosingId(selectedStoreId, dateStr));
        const closingSnap = await getDoc(closingRef);
        const closing = closingSnap.exists()
          ? ({ id: closingSnap.id, ...closingSnap.data() } as DayClosing)
          : null;

        if (active) {
          setOrders(loadedOrders);
          setExistingClosing(closing);
          setActualCash(closing ? String(closing.actualCash ?? '') : '');
          setNotes(closing?.notes || '');
          setLoading(false);
        }
      } catch (err: any) {
        console.error('Failed to load day close data', err);
        if (active) {
          setLoading(false);
          if (err.message && (err.message.includes('requires an index') || err.message.includes('failed-precondition'))) {
            setError('Firestore index required for store/date order lookup. Deploy Firestore indexes before closing. Save is disabled until this data loads cleanly.');
          } else {
            setError(`Failed to load day close data: ${err.message || err.toString()}`);
          }
        }
      }
    };

    loadDayCloseData();
    return () => { active = false; };
  }, [dateStr, selectedStoreId, staffProfile]);

  const handleSave = async () => {
    if (!staffProfile || !auth.currentUser || !selectedStore) return;
    if (!canSave) {
      setError('This day is already closed. Ask an Admin or Store Manager to update it.');
      return;
    }

    setSaving(true);
    setError(null);
    setMessage(null);

    try {
      const closingRef = doc(db, 'dayClosings', dayClosingId(selectedStore.id, dateStr));
      const payload: DayClosing = {
        storeId: selectedStore.id,
        storeName: selectedStore.name,
        businessDate: dateStr,
        completedBillCount: summary.completedBillCount,
        voidedBillCount: summary.voidedBillCount,
        grossSales: summary.grossSales,
        voidedSales: summary.voidedSales,
        netSales: summary.netSales,
        gstTotal: summary.gstTotal,
        discountTotal: summary.discountTotal,
        paymentBreakdown: summary.paymentBreakdown,
        expectedCash: summary.expectedCash,
        grossPaymentsReceived: summary.grossPaymentsReceived,
        voidedPaymentTotal: summary.voidedPaymentTotal,
        refundedOrReversedPayments: summary.refundedOrReversedPayments,
        refundPendingPayments: summary.refundPendingPayments,
        manualRefundRequiredPayments: summary.manualRefundRequiredPayments,
        netCollections: summary.netCollections,
        actualCash: actualCashNumber,
        cashVariance,
        notes: notes.trim(),
        closedBy: auth.currentUser.uid,
        closedByName: staffProfile.name,
        closedByEmail: staffProfile.email || null,
        closedAt: serverTimestamp(),
        status: 'CLOSED',
      };

      await setDoc(closingRef, payload, { merge: false });
      setExistingClosing({ id: closingRef.id, ...payload, closedAt: new Date() });
      setMessage(existingClosing ? 'Day close updated.' : 'Day close saved.');
    } catch (err: any) {
      console.error('Failed to save day close', err);
      setError(`Failed to save day close: ${err.message || err.toString()}`);
    } finally {
      setSaving(false);
    }
  };

  if (!staffProfile) return null;

  return (
    <div className="min-h-screen min-w-0 bg-[#fcf9f5] pb-24 font-sans text-neutral-800">
      <div className="bg-white border-b border-neutral-200 sticky top-0 z-30 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 md:px-8 py-4 flex min-w-0 flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <Link to="/reports" className="w-10 h-10 bg-neutral-100 hover:bg-neutral-200 text-neutral-600 rounded-full flex items-center justify-center transition-colors">
              <ArrowLeft size={20} />
            </Link>
            <div>
              <h1 className="text-2xl font-black tracking-tight text-neutral-900">Day Close</h1>
              <p className="text-sm font-medium text-neutral-500">Cashier closing, payment reconciliation, and void summary</p>
            </div>
          </div>

          <div className="flex w-full flex-wrap items-center gap-3 md:w-auto">
            <div className="relative">
              <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={16} />
              <input
                type="date"
                value={dateStr}
                onChange={event => setDateStr(event.target.value)}
                className="pl-9 pr-4 py-2 bg-neutral-50 border border-neutral-200 rounded-lg text-sm font-medium outline-none focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033]"
              />
            </div>

            <div className="relative">
              <StoreIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={16} />
              <select
                value={selectedStoreId}
                onChange={event => setSelectedStoreId(event.target.value)}
                disabled={staffProfile.role === 'CASHIER'}
                className="appearance-none pl-9 pr-8 py-2 bg-neutral-50 border border-neutral-200 rounded-lg text-sm font-medium outline-none focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033] disabled:opacity-70 disabled:cursor-not-allowed"
              >
                {accessibleStores.map(store => (
                  <option key={store.id} value={store.id}>{store.name}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      <main className="max-w-6xl mx-auto px-4 md:px-8 mt-8 space-y-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-xl font-bold text-sm">
            {error}
          </div>
        )}

        {message && (
          <div className="bg-emerald-50 border border-emerald-200 text-emerald-700 p-4 rounded-xl font-bold text-sm flex items-center gap-2">
            <CheckCircle2 size={18} />
            {message}
          </div>
        )}

        {loading ? (
          <div className="h-64 flex items-center justify-center flex-col gap-4 text-neutral-400">
            <Loader2 size={32} className="animate-spin text-[#5c4033]" />
            <p className="font-medium animate-pulse">Preparing day close...</p>
          </div>
        ) : !selectedStore ? (
          <div className="bg-white rounded-2xl p-10 shadow-sm border border-neutral-200 text-center">
            <h2 className="text-xl font-bold text-neutral-800 mb-2">No store available</h2>
            <p className="text-neutral-500">Your profile does not have a store assigned for day closing.</p>
          </div>
        ) : (
          <>
            <section className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
              <SummaryCard label="Completed Bills" value={summary.completedBillCount.toString()} />
              <SummaryCard label="Voided Bills" value={summary.voidedBillCount.toString()} tone={summary.voidedBillCount > 0 ? 'red' : 'neutral'} />
              <SummaryCard label="Gross Completed Sales" value={formatMoney(summary.grossSales)} />
              <SummaryCard label="Net Sales" value={formatMoney(summary.netSales)} tone="green" />
              <SummaryCard label="Voided Sales" value={formatMoney(summary.voidedSales)} tone={summary.voidedSales > 0 ? 'red' : 'neutral'} />
              <SummaryCard label="GST Total" value={formatMoney(summary.gstTotal)} />
              <SummaryCard label="Discount Total" value={formatMoney(summary.discountTotal)} />
              <SummaryCard label="Expected Cash" value={formatMoney(summary.expectedCash)} tone="amber" />
              <SummaryCard label="Gross Payments Received" value={formatMoney(summary.grossPaymentsReceived)} />
              <SummaryCard label="Voided / Refunded Payments" value={formatMoney(summary.voidedPaymentTotal)} tone={summary.voidedPaymentTotal > 0 ? 'red' : 'neutral'} />
              <SummaryCard label="Refunds Pending" value={formatMoney(summary.refundPendingPayments + summary.manualRefundRequiredPayments)} tone={summary.refundPendingPayments + summary.manualRefundRequiredPayments > 0 ? 'amber' : 'neutral'} />
              <SummaryCard label="Net Collections" value={formatMoney(summary.netCollections)} tone="green" />
            </section>

            <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="bg-white rounded-2xl border border-neutral-200 shadow-sm overflow-hidden">
                <div className="p-5 border-b border-neutral-100">
                  <h2 className="font-black text-neutral-900">Payment Breakdown</h2>
                  <p className="text-sm text-neutral-500 mt-1">Completed orders only. Voided orders are excluded from net payment totals.</p>
                </div>
                <div className="divide-y divide-neutral-100">
                  {PAYMENT_METHODS.map(method => (
                    <div key={method} className="flex justify-between items-center px-5 py-3 text-sm">
                      <span className="font-bold text-neutral-700">{method}</span>
                      <span className="font-mono font-black text-neutral-900">{formatMoney(summary.paymentBreakdown[method])}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-white rounded-2xl border border-neutral-200 shadow-sm p-5 space-y-4">
                <div>
                  <h2 className="font-black text-neutral-900">Cash Reconciliation</h2>
                  <p className="text-sm text-neutral-500 mt-1">
                    {existingClosing ? `Already closed for ${selectedStore.name} on ${dateStr}.` : `Close ${selectedStore.name} for ${dateStr}.`}
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="rounded-xl border border-neutral-100 bg-neutral-50 p-4">
                    <p className="text-[10px] font-black uppercase tracking-widest text-neutral-400">Expected Cash</p>
                    <p className="font-mono text-2xl font-black text-neutral-900 mt-1">{formatMoney(summary.expectedCash)}</p>
                  </div>
                  <div className={`rounded-xl border p-4 ${Math.abs(cashVariance) < 0.01 ? 'border-emerald-100 bg-emerald-50' : 'border-amber-100 bg-amber-50'}`}>
                    <p className="text-[10px] font-black uppercase tracking-widest text-neutral-500">Cash Variance</p>
                    <p className={`font-mono text-2xl font-black mt-1 ${Math.abs(cashVariance) < 0.01 ? 'text-emerald-700' : 'text-amber-700'}`}>
                      {formatMoney(cashVariance)}
                    </p>
                  </div>
                </div>

                <label className="block">
                  <span className="text-xs font-black uppercase tracking-widest text-neutral-500">Actual Cash Counted</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={actualCash}
                    onChange={event => setActualCash(event.target.value)}
                    className="mt-2 w-full rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 font-mono font-bold outline-none focus:border-[#5c4033] focus:ring-2 focus:ring-[#5c4033]/10"
                    placeholder="0.00"
                  />
                </label>

                <label className="block">
                  <span className="text-xs font-black uppercase tracking-widest text-neutral-500">Notes</span>
                  <textarea
                    value={notes}
                    onChange={event => setNotes(event.target.value)}
                    rows={4}
                    className="mt-2 w-full rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm font-medium outline-none focus:border-[#5c4033] focus:ring-2 focus:ring-[#5c4033]/10"
                    placeholder="Cash over/short notes, settlement comments, or manager handover..."
                  />
                </label>

                {existingClosing && !canUpdateExistingClosing && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm font-bold text-amber-700">
                    This day is already closed. Cashiers cannot overwrite a closed day.
                  </div>
                )}

                {error && (
                  <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700">
                    Save is disabled because the day close totals did not load cleanly.
                  </div>
                )}

                <button
                  onClick={handleSave}
                  disabled={!canSave || saving}
                  className="w-full rounded-xl bg-[#3e2723] px-4 py-3 text-sm font-black uppercase tracking-widest text-white hover:bg-[#2d1c19] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {saving ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
                  {existingClosing ? 'Update Day Close' : 'Save Day Close'}
                </button>
              </div>
            </section>

            <section className="bg-white rounded-2xl border border-neutral-200 shadow-sm overflow-hidden">
              <div className="p-5 border-b border-neutral-100">
                <h2 className="font-black text-neutral-900">Closing Snapshot</h2>
                <p className="text-sm text-neutral-500 mt-1">Saved closings do not lock orders yet and do not modify order, KOT, or stock records.</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm whitespace-nowrap">
                  <tbody className="divide-y divide-neutral-100">
                    <SnapshotRow label="Date" value={dateStr} />
                    <SnapshotRow label="Store" value={selectedStore.name} />
                    <SnapshotRow label="Closing Status" value={existingClosing?.status || 'Not closed'} />
                    <SnapshotRow label="Closed By" value={existingClosing?.closedByName || '-'} />
                    <SnapshotRow label="Closed At" value={existingClosing?.closedAt?.toDate ? existingClosing.closedAt.toDate().toLocaleString() : existingClosing ? 'Saved' : '-'} />
                    <SnapshotRow label="Orders Loaded" value={orders.length.toString()} />
                    <SnapshotRow label="Gross Payments Received" value={formatMoney(summary.grossPaymentsReceived)} />
                    <SnapshotRow label="Voided / Refunded Payments" value={formatMoney(summary.voidedPaymentTotal)} />
                    <SnapshotRow label="Refunds Pending" value={formatMoney(summary.refundPendingPayments + summary.manualRefundRequiredPayments)} />
                    <SnapshotRow label="Net Collections" value={formatMoney(summary.netCollections)} />
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function SummaryCard({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | 'green' | 'amber' | 'red' }) {
  const toneClasses = {
    neutral: 'bg-white border-neutral-200 text-neutral-900',
    green: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    amber: 'bg-amber-50 border-amber-200 text-amber-800',
    red: 'bg-red-50 border-red-200 text-red-800',
  };

  return (
    <div className={`rounded-2xl border p-4 shadow-sm ${toneClasses[tone]}`}>
      <p className="text-[10px] font-black uppercase tracking-widest opacity-60">{label}</p>
      <p className="mt-2 text-2xl font-black font-mono">{value}</p>
    </div>
  );
}

function SnapshotRow({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td className="px-5 py-3 font-black text-neutral-500 uppercase tracking-widest text-[10px]">{label}</td>
      <td className="px-5 py-3 font-bold text-neutral-900">{value}</td>
    </tr>
  );
}
