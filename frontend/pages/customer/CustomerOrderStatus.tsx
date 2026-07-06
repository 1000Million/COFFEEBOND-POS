import React, { useEffect, useMemo, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { Link, useParams } from 'react-router-dom';
import { AlertCircle, CheckCircle2, Clock, Copy, Loader2, RefreshCw, ShoppingBag, Store as StoreIcon, XCircle } from 'lucide-react';
import { db } from '../../lib/firebase';
import { OnlineOrder, OnlineOrderStatus } from '../../types';
import coffeeBondLogo from '../../assets/coffee-bond-logo.png';

function formatMoney(value: number): string {
  return `₹${Number(value || 0).toFixed(2)}`;
}

function formatDate(value: any): string {
  const date = value?.toDate ? value.toDate() : null;
  return date ? date.toLocaleString() : 'Just now';
}

function statusLabel(status: OnlineOrderStatus): string {
  if (status === 'CONVERTED' || status === 'ACCEPTED') return 'Order confirmed';
  if (status === 'NEEDS_ATTENTION') return 'Store reviewing';
  if (status === 'REJECTED') return 'Not accepted';
  return 'Request sent';
}

function statusMessage(order: OnlineOrder): string {
  if (order.customerStatusMessage) return order.customerStatusMessage;
  if (order.status === 'PENDING') return 'Your order request has been received. The store will confirm shortly.';
  if (order.status === 'CONVERTED' || order.status === 'ACCEPTED') return 'Your order has been accepted and is being prepared.';
  if (order.status === 'REJECTED') return 'Sorry, the store could not accept this order.';
  if (order.status === 'NEEDS_ATTENTION') return 'The store is reviewing your order.';
  return 'We are checking your order status.';
}

function statusTone(status: OnlineOrderStatus): string {
  if (status === 'CONVERTED' || status === 'ACCEPTED') return 'bg-emerald-50 text-emerald-900';
  if (status === 'REJECTED') return 'bg-red-50 text-red-900';
  if (status === 'NEEDS_ATTENTION') return 'bg-amber-50 text-amber-900';
  return 'bg-blue-50 text-blue-900';
}

function stepState(orderStatus: OnlineOrderStatus, step: 'SENT' | 'CONFIRMED' | 'PREPARING' | 'READY_SOON' | 'READY_FOR_PICKUP' | 'REJECTED'): 'done' | 'active' | 'pending' | 'rejected' {
  if (orderStatus === 'REJECTED') {
    if (step === 'REJECTED') return 'rejected';
    if (step === 'SENT' || step === 'CONFIRMED') return 'done';
    return 'pending';
  }

  if (orderStatus === 'CONVERTED' || orderStatus === 'ACCEPTED') {
    if (step === 'SENT' || step === 'CONFIRMED') return 'done';
    if (step === 'PREPARING') return 'active';
    return 'pending';
  }

  if (orderStatus === 'NEEDS_ATTENTION') {
    if (step === 'SENT') return 'done';
    if (step === 'CONFIRMED') return 'active';
    return 'pending';
  }

  return step === 'SENT' ? 'active' : 'pending';
}

function stepDotClass(state: ReturnType<typeof stepState>): string {
  if (state === 'done') return 'bg-emerald-600 text-white';
  if (state === 'active') return 'bg-[#3b261d] text-white';
  if (state === 'rejected') return 'bg-red-600 text-white';
  return 'bg-[#eadfd2] text-[#7c685a]';
}

export default function CustomerOrderStatus() {
  const { onlineOrderId } = useParams();
  const [order, setOrder] = useState<OnlineOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState('');

  useEffect(() => {
    if (!onlineOrderId) {
      setError('Missing order reference.');
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    setError(null);
    const unsubscribe = onSnapshot(
      doc(db, 'onlineOrders', onlineOrderId),
      (snapshot) => {
        if (!snapshot.exists()) {
          setOrder(null);
          setError('We could not find this order reference.');
        } else {
          setOrder({ id: snapshot.id, ...snapshot.data() } as OnlineOrder);
          setError(null);
        }
        setLoading(false);
      },
      (err) => {
        console.error('Failed to listen to order status', err);
        setError('We could not load this order status. Please check the reference and try again.');
        setLoading(false);
      },
    );

    return unsubscribe;
  }, [onlineOrderId]);

  const tone = useMemo(() => order ? statusTone(order.status) : 'bg-white text-neutral-900', [order]);

  const visibleSteps = useMemo(() => {
    if (!order) return [];
    if (order.status === 'REJECTED') {
      return [
        { key: 'SENT' as const, title: 'Request sent', body: 'We received your basket.' },
        { key: 'CONFIRMED' as const, title: 'Store reviewed', body: 'The team checked your request.' },
        { key: 'REJECTED' as const, title: 'Not accepted', body: 'The store could not accept it.' },
      ];
    }

    return [
      { key: 'SENT' as const, title: 'Request sent', body: 'Your basket reached the store.' },
      { key: 'CONFIRMED' as const, title: 'Store confirmed', body: 'The team accepts it.' },
      { key: 'PREPARING' as const, title: 'Preparing', body: 'Your order is being made.' },
      { key: 'READY_SOON' as const, title: 'Ready soon', body: 'Pickup time is close.' },
      { key: 'READY_FOR_PICKUP' as const, title: 'Ready for pickup', body: 'Collect once the store confirms.' },
    ];
  }, [order]);

  const copyTrackingLink = async () => {
    if (!onlineOrderId) return;
    const trackingUrl = `${window.location.origin}/order/status/${onlineOrderId}`;
    try {
      await navigator.clipboard.writeText(trackingUrl);
      setCopyMessage('Tracking link copied.');
    } catch {
      setCopyMessage(trackingUrl);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-[#f8efe6] px-4 py-4 font-sans text-neutral-900">
      <div className="mx-auto max-w-md lg:max-w-4xl">
        <header className="mb-4 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <img src={coffeeBondLogo} alt="Coffee Bond" className="h-10 w-10 rounded-xl bg-white object-contain p-1 shadow-sm" />
            <div className="min-w-0">
              <p className="text-xs font-black tracking-[0.18em] text-[#9a6a45]">COFFEE BOND</p>
              <h1 className="truncate text-lg font-black text-[#2d2019]">Track order</h1>
            </div>
          </div>
          <button onClick={copyTrackingLink} className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-2 text-xs font-black text-[#5c4033] shadow-sm ring-1 ring-[#eadfd2]">
            <Copy size={14} />
            Copy
          </button>
        </header>

        {copyMessage && (
          <p className="mb-4 break-all rounded-xl bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">
            {copyMessage}
          </p>
        )}

        {loading ? (
          <div className="rounded-3xl bg-white p-8 text-center shadow-sm ring-1 ring-[#eadfd2]">
            <Loader2 className="mx-auto mb-3 animate-spin text-[#5c4033]" />
            <p className="font-bold text-neutral-500">Loading order status...</p>
          </div>
        ) : error ? (
          <div className="rounded-3xl bg-red-50 p-5 text-red-900 shadow-sm ring-1 ring-red-200">
            <div className="mb-3 flex items-center gap-2 font-black">
              <AlertCircle size={22} />
              Order status unavailable
            </div>
            <p className="text-sm font-medium">{error}</p>
            <Link to="/order" className="mt-5 inline-block rounded-2xl bg-[#3b261d] px-4 py-3 text-sm font-black text-white">
              Back to ordering
            </Link>
          </div>
        ) : order ? (
          <div className="space-y-4">
            <section className={`rounded-3xl p-5 shadow-sm ring-1 ring-[#eadfd2] ${tone}`}>
              <div className="flex items-start gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/75">
                  {order.status === 'REJECTED' ? (
                    <XCircle size={24} className="text-red-700" />
                  ) : order.status === 'CONVERTED' || order.status === 'ACCEPTED' ? (
                    <CheckCircle2 size={24} className="text-emerald-700" />
                  ) : order.status === 'NEEDS_ATTENTION' ? (
                    <AlertCircle size={24} className="text-amber-700" />
                  ) : (
                    <Clock size={24} className="text-blue-700" />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-bold opacity-70">Current status</p>
                  <h2 className="mt-1 text-2xl font-black">{statusLabel(order.status)}</h2>
                  <p className="mt-2 text-sm leading-relaxed">{statusMessage(order)}</p>
                  {(order.status === 'CONVERTED' || order.status === 'ACCEPTED') && order.linkedOrderNumber && (
                    <p className="mt-3 inline-flex rounded-full bg-white/75 px-3 py-2 text-xs font-black">
                      Store order number: {order.linkedOrderNumber}
                    </p>
                  )}
                </div>
              </div>
            </section>

            <section className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-[#eadfd2]">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-bold text-neutral-500">Order reference</p>
                  <p className="mt-1 break-all text-sm font-black text-[#2d2019]">{order.id}</p>
                </div>
                <div className="rounded-2xl bg-[#fbf5ee] px-3 py-2 text-right">
                  <p className="text-xs font-bold text-neutral-500">Total</p>
                  <p className="font-black text-[#2d2019]">{formatMoney(order.grandTotal)}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-2xl bg-[#fbf5ee] p-3">
                  <StoreIcon size={15} className="mb-2 text-[#9a6a45]" />
                  <p className="text-xs font-bold text-neutral-500">Pickup from</p>
                  <p className="mt-1 font-black text-[#2d2019]">{order.storeName}</p>
                </div>
                <div className="rounded-2xl bg-[#fbf5ee] p-3">
                  <Clock size={15} className="mb-2 text-[#9a6a45]" />
                  <p className="text-xs font-bold text-neutral-500">Submitted</p>
                  <p className="mt-1 font-black text-[#2d2019]">{formatDate(order.createdAt)}</p>
                </div>
              </div>
            </section>

            <section className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-[#eadfd2]">
              <h3 className="text-lg font-black text-[#2d2019]">Progress</h3>
              <div className="mt-4 space-y-3">
                {visibleSteps.map(step => {
                  const state = stepState(order.status, step.key);
                  return (
                    <div key={step.title} className="flex gap-3">
                      <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${stepDotClass(state)}`}>
                        {state === 'done' ? <CheckCircle2 size={16} /> : state === 'rejected' ? <XCircle size={16} /> : <Clock size={16} />}
                      </div>
                      <div className="min-w-0 border-b border-[#f0e6db] pb-3 last:border-b-0">
                        <p className="font-black text-[#2d2019]">{step.title}</p>
                        <p className="mt-1 text-sm leading-relaxed text-neutral-500">{step.body}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-[#eadfd2]">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-lg font-black text-[#2d2019]">Order summary</h3>
                <span className="inline-flex items-center gap-1 rounded-full bg-[#fbf5ee] px-3 py-1.5 text-xs font-black text-[#5c4033]">
                  <ShoppingBag size={13} />
                  {order.items.length}
                </span>
              </div>

              <div className="space-y-2">
                {order.items.map(item => (
                  <div key={`${order.id}-${item.finishedGoodCode}`} className="flex justify-between gap-3 rounded-2xl bg-[#fbf5ee] px-3 py-2 text-sm">
                    <span className="font-bold text-[#2d2019]">{item.quantity} x {item.itemName}</span>
                    <span className="font-black text-[#5c4033]">{formatMoney(item.lineTotal)}</span>
                  </div>
                ))}
              </div>

              <div className="mt-4 space-y-2 border-t border-[#eadfd2] pt-3 text-sm">
                <div className="flex justify-between"><span>Subtotal</span><span className="font-black">{formatMoney(order.subtotal)}</span></div>
                <div className="flex justify-between"><span>GST</span><span className="font-black">{formatMoney(order.gstTotal)}</span></div>
                <div className="flex justify-between text-lg font-black text-[#2d2019]"><span>Total</span><span>{formatMoney(order.grandTotal)}</span></div>
              </div>
            </section>

            <div className="grid gap-3 pb-3">
              <button
                onClick={() => window.location.reload()}
                className="inline-flex items-center justify-center gap-2 rounded-2xl border border-[#eadfd2] bg-white px-4 py-3 text-sm font-black text-[#5c4033]"
              >
                <RefreshCw size={16} />
                Refresh
              </button>
              <Link to="/order" className="rounded-2xl bg-[#3b261d] px-4 py-3 text-center text-sm font-black text-white">
                Place another order
              </Link>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
