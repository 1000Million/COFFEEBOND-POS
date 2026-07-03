import React, { useEffect, useMemo, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { Link, useParams } from 'react-router-dom';
import { AlertCircle, CheckCircle2, Clock, Coffee, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { db } from '../../lib/firebase';
import { OnlineOrder, OnlineOrderStatus } from '../../types';

function formatMoney(value: number): string {
  return `₹${Number(value || 0).toFixed(2)}`;
}

function formatDate(value: any): string {
  const date = value?.toDate ? value.toDate() : null;
  return date ? date.toLocaleString() : 'Just now';
}

function statusLabel(status: OnlineOrderStatus): string {
  if (status === 'CONVERTED' || status === 'ACCEPTED') return 'ACCEPTED';
  if (status === 'NEEDS_ATTENTION') return 'REVIEWING';
  return status;
}

function statusMessage(order: OnlineOrder): string {
  if (order.customerStatusMessage) return order.customerStatusMessage;
  if (order.status === 'PENDING') return 'Your order request has been received. The store will confirm shortly.';
  if (order.status === 'CONVERTED' || order.status === 'ACCEPTED') return 'Your order has been accepted and is being prepared.';
  if (order.status === 'REJECTED') return 'Sorry, the store could not accept this order.';
  if (order.status === 'NEEDS_ATTENTION') return 'The store is reviewing this order.';
  return 'We are checking your order status.';
}

function statusTone(status: OnlineOrderStatus): string {
  if (status === 'CONVERTED' || status === 'ACCEPTED') return 'border-emerald-200 bg-emerald-50 text-emerald-900';
  if (status === 'REJECTED') return 'border-red-200 bg-red-50 text-red-900';
  if (status === 'NEEDS_ATTENTION') return 'border-amber-200 bg-amber-50 text-amber-900';
  return 'border-blue-200 bg-blue-50 text-blue-900';
}

function statusIcon(status: OnlineOrderStatus) {
  if (status === 'CONVERTED' || status === 'ACCEPTED') return <CheckCircle2 size={24} className="text-emerald-700" />;
  if (status === 'REJECTED') return <XCircle size={24} className="text-red-700" />;
  if (status === 'NEEDS_ATTENTION') return <AlertCircle size={24} className="text-amber-700" />;
  return <Clock size={24} className="text-blue-700" />;
}

export default function CustomerOrderStatus() {
  const { onlineOrderId } = useParams();
  const [order, setOrder] = useState<OnlineOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const tone = useMemo(() => order ? statusTone(order.status) : 'border-neutral-200 bg-white text-neutral-900', [order]);

  return (
    <div className="min-h-[100dvh] bg-[#f9f5f0] px-4 py-6 font-sans text-neutral-900">
      <div className="mx-auto max-w-2xl">
        <header className="mb-5 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#5c4033] text-white">
            <Coffee size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-black text-[#3e2723]">Track Order</h1>
            <p className="text-xs font-bold uppercase tracking-widest text-amber-700">Coffee Bond customer ordering</p>
          </div>
        </header>

        {loading ? (
          <div className="rounded-3xl border border-neutral-100 bg-white p-10 text-center shadow-sm">
            <Loader2 className="mx-auto mb-3 animate-spin text-[#5c4033]" />
            <p className="font-bold text-neutral-500">Loading order status...</p>
          </div>
        ) : error ? (
          <div className="rounded-3xl border border-red-200 bg-red-50 p-8 text-red-900 shadow-sm">
            <div className="mb-3 flex items-center gap-2 font-black">
              <AlertCircle size={22} />
              Order status unavailable
            </div>
            <p className="text-sm font-medium">{error}</p>
            <Link to="/order" className="mt-6 inline-block rounded-xl bg-[#5c4033] px-4 py-3 text-sm font-black text-white">
              Back to ordering
            </Link>
          </div>
        ) : order ? (
          <div className="rounded-3xl border border-neutral-100 bg-white p-5 shadow-sm md:p-7">
            <div className={`rounded-2xl border p-5 ${tone}`}>
              <div className="flex items-start gap-3">
                <div className="shrink-0">{statusIcon(order.status)}</div>
                <div>
                  <p className="text-xs font-black uppercase tracking-widest opacity-70">Current Status</p>
                  <h2 className="mt-1 text-2xl font-black">{statusLabel(order.status)}</h2>
                  <p className="mt-2 text-sm font-medium">{statusMessage(order)}</p>
                  {(order.status === 'CONVERTED' || order.status === 'ACCEPTED') && order.linkedOrderNumber && (
                    <p className="mt-3 rounded-xl bg-white/70 px-3 py-2 text-sm font-black">
                      POS order number: {order.linkedOrderNumber}
                    </p>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-5 grid gap-3 text-sm md:grid-cols-2">
              <div className="rounded-2xl bg-neutral-50 p-4">
                <p className="text-xs font-black uppercase tracking-widest text-neutral-400">Reference</p>
                <p className="mt-1 break-all font-black text-neutral-900">{order.id}</p>
              </div>
              <div className="rounded-2xl bg-neutral-50 p-4">
                <p className="text-xs font-black uppercase tracking-widest text-neutral-400">Store</p>
                <p className="mt-1 font-black text-neutral-900">{order.storeName}</p>
              </div>
              <div className="rounded-2xl bg-neutral-50 p-4">
                <p className="text-xs font-black uppercase tracking-widest text-neutral-400">Customer</p>
                <p className="mt-1 font-black text-neutral-900">{order.customerName}</p>
              </div>
              <div className="rounded-2xl bg-neutral-50 p-4">
                <p className="text-xs font-black uppercase tracking-widest text-neutral-400">Submitted</p>
                <p className="mt-1 font-black text-neutral-900">{formatDate(order.createdAt)}</p>
              </div>
            </div>

            <div className="mt-5 rounded-2xl border border-neutral-100 p-4">
              <h3 className="mb-3 font-black text-neutral-900">Items</h3>
              <div className="space-y-2">
                {order.items.map(item => (
                  <div key={`${order.id}-${item.finishedGoodCode}`} className="flex justify-between gap-3 rounded-xl bg-neutral-50 px-3 py-2 text-sm">
                    <span className="font-bold">{item.quantity} x {item.itemName}</span>
                    <span className="font-black">{formatMoney(item.lineTotal)}</span>
                  </div>
                ))}
              </div>
              <div className="mt-4 space-y-1 border-t border-neutral-100 pt-3 text-sm">
                <div className="flex justify-between"><span>Subtotal</span><span className="font-black">{formatMoney(order.subtotal)}</span></div>
                <div className="flex justify-between"><span>GST</span><span className="font-black">{formatMoney(order.gstTotal)}</span></div>
                <div className="flex justify-between text-lg font-black text-[#3e2723]"><span>Total</span><span>{formatMoney(order.grandTotal)}</span></div>
              </div>
            </div>

            <div className="mt-5 flex flex-col gap-3 sm:flex-row">
              <button
                onClick={() => window.location.reload()}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm font-black text-neutral-700"
              >
                <RefreshCw size={16} />
                Refresh
              </button>
              <Link to="/order" className="flex-1 rounded-xl bg-[#5c4033] px-4 py-3 text-center text-sm font-black text-white">
                Place another order
              </Link>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
