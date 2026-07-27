import React, { useEffect, useMemo, useRef, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { collection, doc, getDocs, onSnapshot, query, serverTimestamp, updateDoc, where } from 'firebase/firestore';
import { AlertCircle, CheckCircle2, Clock, Loader2, Phone, RefreshCw, ShoppingBag, StickyNote, Store as StoreIcon, XCircle } from 'lucide-react';
import { db, functions } from '../../lib/firebase';
import { useAuth } from '../../contexts/AuthContext';
import { OnlineOrder, Store } from '../../types';
import { acceptOnlineOrder, isOnlineOrderAcceptError, OnlineOrderAcceptBlocker } from '../../lib/onlineOrderConversion';
import { publicStatusMessage, updatePublicOrderTracking } from '../../lib/publicOrderTracking';
import {
  compareIncomingOrders,
  isPaidIncomingOrder,
  paidOrderEscalation,
  paidOrderWaitingMillis,
} from '../../lib/razorpayLatency';

const acceptPaidRazorpayOrder = httpsCallable<
  { onlineOrderId: string },
  {
    orderId?: string;
    orderNumber?: string;
    kotCount?: number;
    stockMovementCount?: number;
    reviewRequired?: boolean;
    code?: string;
  }
>(functions, 'acceptPaidRazorpayOrder');
const cancelAndRefundRazorpayOrder = httpsCallable<
  { onlineOrderId: string; reason: string; confirmation: string },
  { status: 'REFUND_PENDING'; refundId: string; alreadyRequested: boolean }
>(functions, 'cancelAndRefundRazorpayOrder');
const ACTIVE_ORDER_STATUSES: OnlineOrder['status'][] = [
  'PENDING',
  'NEEDS_ATTENTION',
  'PAID_PENDING_ACCEPTANCE',
  'PAYMENT_REVIEW_REQUIRED',
  'REFUND_FAILED',
];

function formatMoney(value: number): string {
  return `₹${Number(value || 0).toFixed(2)}`;
}

function formatTime(value: any): string {
  const date = value?.toDate ? value.toDate() : null;
  return date ? date.toLocaleString() : 'Just now';
}

function maskPhone(value: string): string {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? `••••••${digits.slice(-4)}` : 'Verified customer';
}

function minutesSince(value: any, now: Date): number {
  const date = value?.toDate ? value.toDate() : null;
  if (!date) return 0;
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 60000));
}

function elapsedLabel(value: any, now: Date): string {
  const minutes = minutesSince(value, now);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return `${hours}h ${remaining}m ago`;
}

function allowedStoreIds(staffProfile: NonNullable<ReturnType<typeof useAuth>['staffProfile']>): string[] {
  return staffProfile.assignedStoreIds?.length ? staffProfile.assignedStoreIds : staffProfile.storeIds || [];
}

function blockerSummary(blocker: OnlineOrderAcceptBlocker): string {
  const component = blocker.componentCode ? `${blocker.componentType || 'Component'} / ${blocker.componentCode}` : blocker.itemCode;
  const quantities = blocker.requiredQuantity !== undefined
    ? ` Required ${Number(blocker.requiredQuantity).toFixed(2)} ${blocker.unit || ''}; available ${Number(blocker.availableQuantity || 0).toFixed(2)} ${blocker.unit || ''}.`
    : '';
  return `${blocker.itemName}: ${blocker.blockerType} (${component}).${quantities} ${blocker.suggestedAdminAction}`;
}

async function playPaidOrderNotification(): Promise<void> {
  try {
    const AudioContextClass = window.AudioContext
      || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    await context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, context.currentTime);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.35);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.36);
    oscillator.addEventListener('ended', () => {
      void context.close();
    }, { once: true });
  } catch {
    // Browsers may suppress audio until the next staff interaction.
  }
}

export default function IncomingOnlineOrders() {
  const { staffProfile } = useAuth();
  const [stores, setStores] = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState('');
  const [orders, setOrders] = useState<OnlineOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<Record<string, OnlineOrderAcceptBlocker[]>>({});
  const [rejectReasons, setRejectReasons] = useState<Record<string, string>>({});
  const [refundConfirmations, setRefundConfirmations] = useState<Record<string, string>>({});
  const [now, setNow] = useState(new Date());
  const [listenerRevision, setListenerRevision] = useState(0);
  const notifiedPaidOrderIdsRef = useRef(new Set<string>());

  const accessibleStores = useMemo(() => {
    if (!staffProfile) return [];
    if (staffProfile.role === 'ADMIN') return stores;
    const allowedIds = allowedStoreIds(staffProfile);
    return stores.filter(store => allowedIds.includes(store.id));
  }, [staffProfile, stores]);

  const selectedStore = accessibleStores.find(store => store.id === selectedStoreId) || null;

  const loadStores = async () => {
    if (!staffProfile) return;
    const snap = await getDocs(query(collection(db, 'stores'), where('isActive', '==', true)));
    const loadedStores = snap.docs.map(storeDoc => ({ id: storeDoc.id, ...storeDoc.data() } as Store))
      .sort((a, b) => a.name.localeCompare(b.name));
    setStores(loadedStores);
    const allowed = staffProfile.role === 'ADMIN' ? loadedStores : loadedStores.filter(store => allowedStoreIds(staffProfile).includes(store.id));
    setSelectedStoreId(prev => prev || allowed[0]?.id || '');
  };

  useEffect(() => {
    loadStores().catch(err => {
      console.error('Failed to load stores for online orders', err);
      setError('Could not load stores.');
      setLoading(false);
    });
  }, [staffProfile]);

  useEffect(() => {
    if (!selectedStoreId) {
      setOrders([]);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    setError(null);
    setOrders([]);
    notifiedPaidOrderIdsRef.current = new Set();
    const ordersByStatus = new Map<OnlineOrder['status'], OnlineOrder[]>();
    const loadedStatuses = new Set<OnlineOrder['status']>();
    let initialSnapshotComplete = false;
    const unsubscriptions = ACTIVE_ORDER_STATUSES.map(status => onSnapshot(query(
      collection(db, 'onlineOrders'),
      where('storeId', '==', selectedStoreId),
      where('status', '==', status),
    ), snapshot => {
      ordersByStatus.set(status, snapshot.docs.map(orderDoc => ({
        id: orderDoc.id,
        ...orderDoc.data(),
      } as OnlineOrder)));
      loadedStatuses.add(status);
      const loadedOrders = ACTIVE_ORDER_STATUSES
        .flatMap(activeStatus => ordersByStatus.get(activeStatus) || [])
        .sort(compareIncomingOrders);
      const paidOrders = loadedOrders.filter(isPaidIncomingOrder);
      if (!initialSnapshotComplete && loadedStatuses.size === ACTIVE_ORDER_STATUSES.length) {
        paidOrders.forEach(order => order.id && notifiedPaidOrderIdsRef.current.add(order.id));
        initialSnapshotComplete = true;
        setLoading(false);
      } else if (initialSnapshotComplete) {
        const newPaidOrders = paidOrders.filter(order => (
          order.id && !notifiedPaidOrderIdsRef.current.has(order.id)
        ));
        newPaidOrders.forEach(order => {
          if (!order.id) return;
          notifiedPaidOrderIdsRef.current.add(order.id);
          console.info('incoming-online-order-timing', {
            stage: 'paid_order_listener_received',
            serverToListenerMs: paidOrderWaitingMillis(order),
          });
        });
        if (newPaidOrders.length > 0) void playPaidOrderNotification();
      }
      setOrders(loadedOrders);
    }, err => {
      console.error('Failed to listen for online orders', {
        code: err.code,
        storeId: selectedStoreId,
        status,
      });
      setError('Could not keep incoming online orders live for this store.');
      setLoading(false);
    }));
    return () => {
      unsubscriptions.forEach(unsubscribe => unsubscribe());
    };
  }, [selectedStoreId, listenerRevision]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const handleAccept = async (order: OnlineOrder) => {
    if (!staffProfile || !order.id) return;
    setActioningId(order.id);
    setMessage(null);
    setError(null);
    setBlockers(prev => ({ ...prev, [order.id!]: [] }));
    try {
      if (order.paymentProvider === 'RAZORPAY') {
        const paidResult = await acceptPaidRazorpayOrder({ onlineOrderId: order.id });
        if (paidResult.data.reviewRequired) {
          setError('Payment is captured, but acceptance is blocked by current inventory. No POS order, KOT, or stock deduction was created. Fix stock and retry, or ask a Manager/Admin to issue a full refund.');
          return;
        }
        setMessage(`Accepted paid order and created POS order ${paidResult.data.orderNumber}. KOT rows: ${paidResult.data.kotCount}; stock movements: ${paidResult.data.stockMovementCount}.`);
        return;
      }
      const result = await acceptOnlineOrder(order.id, staffProfile);
      setMessage(`Accepted online order and created POS order ${result.orderNumber}. KOT rows: ${result.kotCount}; stock movements: ${result.stockMovementCount}.`);
    } catch (err) {
      if (isOnlineOrderAcceptError(err)) {
        setBlockers(prev => ({ ...prev, [order.id!]: err.blockers }));
        setError('This order cannot be accepted until stock/BOM readiness blockers are fixed.');
      } else {
        console.error('Failed to accept online order', err);
        setError(err instanceof Error ? err.message : 'Could not accept the online order.');
      }
    } finally {
      setActioningId(null);
    }
  };

  const handleRefund = async (order: OnlineOrder) => {
    if (!staffProfile || !order.id) return;
    const reason = (rejectReasons[order.id] || '').trim();
    const confirmation = (refundConfirmations[order.id] || '').trim();
    if (!reason) {
      setError('Enter the reason the store cannot fulfil this paid order.');
      return;
    }
    if (!['REFUND', order.publicOrderReference].includes(confirmation)) {
      setError('Type REFUND or the order reference to confirm the full refund.');
      return;
    }
    setActioningId(order.id);
    setMessage(null);
    setError(null);
    try {
      await cancelAndRefundRazorpayOrder({
        onlineOrderId: order.id,
        reason,
        confirmation,
      });
      setMessage('Full Razorpay refund initiated. The order remains REFUND PENDING until provider confirmation.');
    } catch (err) {
      console.error('Failed to initiate Razorpay refund', err);
      setError(err instanceof Error ? err.message : 'Could not initiate the full refund.');
    } finally {
      setActioningId(null);
    }
  };

  const handleReject = async (order: OnlineOrder) => {
    if (!staffProfile || !order.id) return;
    const reason = (rejectReasons[order.id] || '').trim();
    if (!reason) {
      setError('Please enter a rejection reason before rejecting the order.');
      return;
    }

    setActioningId(order.id);
    setMessage(null);
    setError(null);
    try {
      await updateDoc(doc(db, 'onlineOrders', order.id), {
        status: 'REJECTED',
        rejectReason: reason,
        customerStatusMessage: 'Sorry, the store could not accept this order.',
        rejectedBy: staffProfile.uid,
        rejectedByName: staffProfile.name,
        rejectedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await updatePublicOrderTracking(order.trackingToken, {
        publicStatus: 'REJECTED',
        customerStatusMessage: publicStatusMessage('REJECTED'),
      });
      setMessage('Online order rejected. No POS order, KOT, or stock movement was created.');
    } catch (err) {
      console.error('Failed to reject online order', err);
      setError(err instanceof Error ? err.message : 'Could not reject the online order.');
    } finally {
      setActioningId(null);
    }
  };

  if (!staffProfile) return null;

  return (
    <div className="mx-auto w-full max-w-6xl min-w-0 pb-20">
      <div className="mb-6 flex min-w-0 flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-black text-[#3e2723]">Incoming Online Orders</h1>
          <p className="text-sm text-neutral-500">Customer requests stay pending until staff accepts them into POS V2.</p>
        </div>
        <button
          onClick={() => setListenerRevision(current => current + 1)}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-white px-4 py-2 text-sm font-black text-neutral-700"
        >
          <RefreshCw size={16} />
          Refresh
        </button>
      </div>

      <div className="mb-5 rounded-2xl border border-amber-100 bg-white p-4 shadow-sm">
        <label className="text-sm font-bold text-neutral-700">
          Store
          <span className="mt-2 flex w-full max-w-sm items-center gap-2 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2">
            <StoreIcon size={16} className="text-neutral-400" />
            <select
              value={selectedStoreId}
              onChange={(event) => setSelectedStoreId(event.target.value)}
              className="w-full bg-transparent text-sm font-black outline-none"
            >
              {accessibleStores.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}
            </select>
          </span>
        </label>
      </div>

      {message && (
        <div className="mb-4 flex gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-bold text-emerald-800">
          <CheckCircle2 size={18} className="shrink-0" />
          {message}
        </div>
      )}
      {error && (
        <div className="mb-4 flex gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-800">
          <AlertCircle size={18} className="shrink-0" />
          {error}
        </div>
      )}

      {loading ? (
        <div className="rounded-3xl bg-white p-12 text-center text-neutral-500">
          <Loader2 className="mx-auto mb-3 animate-spin text-[#5c4033]" />
          <p className="font-bold">Loading online orders...</p>
        </div>
      ) : orders.length === 0 ? (
        <div className="rounded-3xl border border-neutral-100 bg-white p-12 text-center">
          <ShoppingBag className="mx-auto mb-3 text-neutral-300" size={36} />
          <h2 className="text-xl font-black text-neutral-800">No pending online orders</h2>
          <p className="text-sm text-neutral-500">{selectedStore ? `${selectedStore.name} is clear.` : 'Select a store to begin.'}</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {orders.map(order => {
            const orderBlockers = order.id ? blockers[order.id] || [] : [];
            const isBusy = actioningId === order.id;
            const requiresPaymentReview = order.status === 'PAYMENT_REVIEW_REQUIRED';
            const ageMinutes = minutesSince(order.createdAt, now);
            const isNew = ageMinutes < 5;
            const isPaid = isPaidIncomingOrder(order);
            const waitingMillis = isPaid ? paidOrderWaitingMillis(order, now.getTime()) : 0;
            const escalation = paidOrderEscalation(waitingMillis);
            const escalationClass = escalation === 'URGENT'
              ? 'border-red-400 ring-2 ring-red-200'
              : escalation === 'ATTENTION'
                ? 'border-amber-400 ring-2 ring-amber-100'
                : '';
            return (
              <article key={order.id} className={`rounded-3xl border bg-white p-4 shadow-sm sm:p-5 ${requiresPaymentReview ? 'border-red-300 ring-2 ring-red-100' : isPaid ? escalationClass || 'border-emerald-300' : isNew ? 'border-amber-300 ring-2 ring-amber-100' : 'border-neutral-100'}`}>
                <div className="flex min-w-0 flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-xl font-black text-neutral-900">{order.customerName}</h2>
                      {isNew && <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-black text-amber-800">NEW</span>}
                      {isPaid && <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-black text-emerald-800">PAID</span>}
                      {isPaid && escalation !== 'NORMAL' && (
                        <span className={`rounded-full px-3 py-1 text-xs font-black ${
                          escalation === 'URGENT' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'
                        }`}>
                          {escalation === 'URGENT' ? 'URGENT · OVER 2 MIN' : 'ATTENTION · OVER 1 MIN'}
                        </span>
                      )}
                      <span className={`rounded-full px-3 py-1 text-xs font-black ${requiresPaymentReview ? 'bg-red-100 text-red-800' : order.status === 'NEEDS_ATTENTION' ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-800'}`}>
                        {order.status.replaceAll('_', ' ')}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-sm font-bold text-neutral-600">
                      <span className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-3 py-1">
                        <Phone size={14} /> {order.paymentProvider === 'RAZORPAY' ? maskPhone(order.customerPhone) : order.customerPhone}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-3 py-1">
                        <Clock size={14} /> {elapsedLabel(isPaid ? order.paymentCapturedAt || order.createdAt : order.createdAt, now)}
                      </span>
                      <span className="rounded-full bg-neutral-100 px-3 py-1">{order.orderType.replace('_', ' ')}</span>
                    </div>
                    <p className="mt-2 text-xs font-bold uppercase tracking-widest text-neutral-400">Submitted {formatTime(order.createdAt)}</p>
                    {order.notes && (
                      <p className="mt-3 flex gap-2 rounded-xl bg-amber-50 p-3 text-sm font-bold text-amber-900">
                        <StickyNote size={16} className="mt-0.5 shrink-0" />
                        <span>{order.notes}</span>
                      </p>
                    )}
                    {order.attentionReason && <p className="mt-2 rounded-xl bg-amber-50 p-3 text-sm font-bold text-amber-800">Needs attention: {order.attentionReason}</p>}
                  </div>
                  <div className="text-left md:text-right">
                    <p className="text-xs font-bold uppercase tracking-widest text-neutral-400">Total</p>
                    <p className="text-2xl font-black text-[#3e2723]">{formatMoney(order.grandTotal)}</p>
                    <p className="mt-1 text-xs font-black text-neutral-500">
                      {order.paymentProvider === 'RAZORPAY'
                        ? `RAZORPAY · PAID${order.providerMethod ? ` · ${order.providerMethod}` : ''}`
                        : 'PAY AT COUNTER'}
                    </p>
                    {order.paymentCapturedAt && (
                      <p className="mt-1 text-xs font-bold text-neutral-400">Paid {formatTime(order.paymentCapturedAt)}</p>
                    )}
                  </div>
                </div>

                <div className="mt-4 grid gap-2">
                  {order.items.map(item => (
                    <div key={`${order.id}-${item.finishedGoodCode}`} className="flex min-w-0 items-center justify-between gap-3 rounded-xl bg-neutral-50 px-3 py-2 text-sm">
                      <span className="min-w-0 break-words font-bold text-neutral-800">{item.quantity} x {item.itemName}</span>
                      <span className="font-black">{formatMoney(item.lineTotal)}</span>
                      {(item.addOns || []).map(addOn => (
                        <span key={`${addOn.groupId}-${addOn.optionId}`} className="basis-full pl-4 text-xs font-bold text-neutral-500">
                          + {addOn.optionName}{addOn.quantity > 1 ? ` × ${addOn.quantity}` : ''}
                        </span>
                      ))}
                    </div>
                  ))}
                </div>

                {orderBlockers.length > 0 && (
                  <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-4">
                    <div className="mb-2 flex items-center gap-2 font-black text-red-800">
                      <XCircle size={18} />
                      Accept blocked
                    </div>
                    <ul className="space-y-2 text-sm text-red-800">
                      {orderBlockers.map((blocker, index) => (
                        <li key={`${blocker.itemCode}-${index}`} className="break-words rounded-xl bg-white/70 p-3">{blockerSummary(blocker)}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {requiresPaymentReview && order.paymentProvider !== 'RAZORPAY' ? (
                  <div className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-900">
                    Payment was received, but POS/KOT/stock finalisation needs Admin or Store Manager review. Do not take another payment or reject this request.
                    {order.paymentReviewCode && <p className="mt-2 font-mono text-xs">Review code: {order.paymentReviewCode}</p>}
                  </div>
                ) : (
                  <div className="mt-5 grid gap-3 lg:grid-cols-[1fr_auto_auto] lg:items-end">
                    <label className="text-sm font-bold text-neutral-700">
                      {order.paymentProvider === 'RAZORPAY' ? 'Cancellation and full-refund reason' : 'Reject reason'}
                      <input
                        value={order.id ? rejectReasons[order.id] || '' : ''}
                        onChange={(event) => order.id && setRejectReasons(prev => ({ ...prev, [order.id]: event.target.value }))}
                        placeholder="Required only when rejecting"
                        className="mt-1 w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-[#5c4033]"
                      />
                    </label>
                    {order.paymentProvider !== 'RAZORPAY' && (
                      <button
                        onClick={() => handleReject(order)}
                        disabled={isBusy}
                        className="min-h-12 rounded-xl border border-red-200 bg-red-50 px-5 py-3 text-sm font-black text-red-700 disabled:opacity-60"
                      >
                        Reject
                      </button>
                    )}
                    {(order.paymentProvider !== 'RAZORPAY'
                      || ['PAID_PENDING_ACCEPTANCE', 'PAYMENT_REVIEW_REQUIRED'].includes(order.status)) && (
                      <button
                        onClick={() => handleAccept(order)}
                        disabled={isBusy}
                        className={`min-h-12 rounded-xl px-6 py-3 text-sm font-black text-white shadow-sm disabled:opacity-60 ${
                          isPaid ? 'bg-emerald-700 ring-2 ring-emerald-200' : 'bg-[#5c4033]'
                        }`}
                      >
                        {isBusy ? (
                          <span className="inline-flex items-center gap-2"><Clock size={15} /> Working...</span>
                        ) : order.paymentProvider === 'RAZORPAY'
                          ? order.status === 'PAYMENT_REVIEW_REQUIRED' ? 'Retry acceptance' : 'Accept paid order'
                          : 'Accept into POS'}
                      </button>
                    )}
                    {order.paymentProvider === 'RAZORPAY'
                      && (staffProfile.role === 'ADMIN' || staffProfile.role === 'STORE_MANAGER') && (
                        <>
                          <label className="text-sm font-bold text-neutral-700 lg:col-span-2">
                            Refund confirmation
                            <input
                              value={order.id ? refundConfirmations[order.id] || '' : ''}
                              onChange={(event) => order.id && setRefundConfirmations(prev => ({ ...prev, [order.id!]: event.target.value }))}
                              placeholder={`Type REFUND or ${order.publicOrderReference}`}
                              className="mt-1 w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-[#5c4033]"
                            />
                          </label>
                          <button
                            type="button"
                            onClick={() => handleRefund(order)}
                            disabled={isBusy}
                            className="min-h-12 rounded-xl border border-red-200 bg-red-50 px-5 py-3 text-sm font-black text-red-700 disabled:opacity-60"
                          >
                            Cancel &amp; full refund
                          </button>
                        </>
                      )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
