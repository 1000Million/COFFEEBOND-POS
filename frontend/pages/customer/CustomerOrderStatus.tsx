import React, { useEffect, useMemo, useState } from 'react';
import { onSnapshot } from 'firebase/firestore';
import { Link, useParams } from 'react-router-dom';
import { AlertCircle, CheckCircle2, Clock, Copy, Loader2, RefreshCw, ShoppingBag, Store as StoreIcon, XCircle } from 'lucide-react';
import { PublicOrderStatus, PublicOrderTracking } from '../../types';
import CustomerHeader from '../../components/customer/CustomerHeader';
import { CustomerProfile, restoreCustomerProfile } from '../../lib/customerAuth';
import { rememberCustomerOrder } from '../../lib/customerOrderPersistence';
import { publicStatusMessage, publicTrackingDocRef } from '../../lib/publicOrderTracking';

function formatMoney(value: number): string {
  return `₹${Number(value || 0).toFixed(2)}`;
}

function formatDate(value: any): string {
  const date = value?.toDate ? value.toDate() : null;
  return date ? date.toLocaleString() : 'Just now';
}

function statusLabel(status: PublicOrderStatus): string {
  if (status === 'PAYMENT_PROCESSING') return 'Confirming payment';
  if (status === 'PAID_PENDING_ACCEPTANCE') return 'Paid, awaiting store';
  if (status === 'PAYMENT_REVIEW_REQUIRED') return 'Payment under review';
  if (status === 'REFUND_PENDING') return 'Refund in progress';
  if (status === 'REFUNDED') return 'Refunded';
  if (status === 'REFUND_FAILED') return 'Refund needs attention';
  if (status === 'CANCELLED_REFUNDED') return 'Cancelled and refunded';
  if (status === 'CONVERTED' || status === 'ACCEPTED') return 'Order confirmed';
  if (status === 'PREPARING') return 'Preparing';
  if (status === 'READY') return 'Ready for pickup';
  if (status === 'SERVED') return 'Completed';
  if (status === 'CANCELLED') return 'Cancelled';
  if (status === 'NEEDS_ATTENTION') return 'Store reviewing';
  if (status === 'REJECTED') return 'Not accepted';
  return 'Request sent';
}

function statusMessage(order: PublicOrderTracking): string {
  if (order.customerStatusMessage) return order.customerStatusMessage;
  return publicStatusMessage(order.publicStatus);
}

function statusTone(status: PublicOrderStatus): string {
  if (status === 'CONVERTED' || status === 'ACCEPTED' || status === 'PREPARING') return 'bg-emerald-50 text-emerald-900';
  if (status === 'READY' || status === 'SERVED') return 'bg-[#f0fdf4] text-emerald-950';
  if (status === 'REJECTED' || status === 'CANCELLED' || status === 'CANCELLED_REFUNDED' || status === 'REFUNDED') return 'bg-red-50 text-red-900';
  if (status === 'NEEDS_ATTENTION' || status === 'PAYMENT_REVIEW_REQUIRED' || status === 'REFUND_PENDING' || status === 'REFUND_FAILED') return 'bg-amber-50 text-amber-900';
  return 'bg-blue-50 text-blue-900';
}

function stepState(orderStatus: PublicOrderStatus, step: 'SENT' | 'CONFIRMED' | 'PREPARING' | 'READY_SOON' | 'READY_FOR_PICKUP' | 'REJECTED'): 'done' | 'active' | 'pending' | 'rejected' {
  if (['REJECTED', 'CANCELLED', 'CANCELLED_REFUNDED', 'REFUNDED', 'REFUND_FAILED'].includes(orderStatus)) {
    if (step === 'REJECTED') return 'rejected';
    if (step === 'SENT' || step === 'CONFIRMED') return 'done';
    return 'pending';
  }

  if (orderStatus === 'SERVED') return step === 'REJECTED' ? 'pending' : 'done';
  if (orderStatus === 'READY') {
    if (step === 'SENT' || step === 'CONFIRMED' || step === 'PREPARING' || step === 'READY_SOON') return 'done';
    if (step === 'READY_FOR_PICKUP') return 'active';
    return 'pending';
  }

  if (orderStatus === 'PREPARING' || orderStatus === 'CONVERTED' || orderStatus === 'ACCEPTED') {
    if (step === 'SENT' || step === 'CONFIRMED') return 'done';
    if (step === 'PREPARING') return 'active';
    return 'pending';
  }

  if (
    orderStatus === 'PAYMENT_PROCESSING'
    || orderStatus === 'PAID_PENDING_ACCEPTANCE'
    || orderStatus === 'PAYMENT_REVIEW_REQUIRED'
    || orderStatus === 'REFUND_PENDING'
  ) {
    if (step === 'SENT') return 'done';
    if (step === 'CONFIRMED') return 'active';
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
  const { onlineOrderId: trackingToken } = useParams();
  const [order, setOrder] = useState<PublicOrderTracking | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState('');
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [authRestored, setAuthRestored] = useState(false);

  useEffect(() => {
    let active = true;
    restoreCustomerProfile().then(restoredProfile => {
      if (active) setProfile(restoredProfile);
    }).catch(() => {
      // Tracking remains available even if the optional account session cannot be restored.
    }).finally(() => {
      if (active) setAuthRestored(true);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!trackingToken) {
      setError('Missing order reference.');
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    setError(null);
    rememberCustomerOrder(trackingToken);
    const unsubscribe = onSnapshot(
      publicTrackingDocRef(trackingToken),
      (snapshot) => {
        if (!snapshot.exists()) {
          setOrder(null);
          setError('We could not find this order reference.');
        } else {
          setOrder({ id: snapshot.id, ...snapshot.data() } as PublicOrderTracking);
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
  }, [trackingToken]);

  const tone = useMemo(() => order ? statusTone(order.publicStatus) : 'bg-white text-neutral-900', [order]);

  const visibleSteps = useMemo(() => {
    if (!order) return [];
    if (['REJECTED', 'CANCELLED', 'CANCELLED_REFUNDED', 'REFUNDED', 'REFUND_FAILED'].includes(order.publicStatus)) {
      return [
        { key: 'SENT' as const, title: 'Request sent', body: 'We received your basket.' },
        { key: 'CONFIRMED' as const, title: 'Store reviewed', body: 'The team checked your request.' },
        { key: 'REJECTED' as const, title: 'Not accepted', body: 'The store could not complete it.' },
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
    if (!trackingToken) return;
    const trackingUrl = `${window.location.origin}/order/status/${trackingToken}`;
    try {
      await navigator.clipboard.writeText(trackingUrl);
      setCopyMessage('Tracking link copied.');
    } catch {
      setCopyMessage(trackingUrl);
    }
  };

  return (
    <div className="min-h-[100dvh] min-w-0 overflow-x-hidden bg-[#f8efe6] font-sans text-neutral-900">
      <CustomerHeader
        title="Track order"
        profile={profile}
        authRestored={authRestored}
        onProfileUpdated={setProfile}
        onSignedOut={() => setProfile(null)}
        rightSlot={(
          <button onClick={copyTrackingLink} className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-2 text-xs font-black text-[#5c4033] shadow-sm ring-1 ring-[#eadfd2]">
            <Copy size={14} />
            Copy
          </button>
        )}
      />

      <div className="mx-auto max-w-md min-w-0 px-4 py-4 lg:max-w-4xl">
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
                  {['REJECTED', 'CANCELLED', 'CANCELLED_REFUNDED', 'REFUNDED', 'REFUND_FAILED'].includes(order.publicStatus) ? (
                    <XCircle size={24} className="text-red-700" />
                  ) : order.publicStatus === 'CONVERTED' || order.publicStatus === 'ACCEPTED' || order.publicStatus === 'PREPARING' || order.publicStatus === 'READY' || order.publicStatus === 'SERVED' ? (
                    <CheckCircle2 size={24} className="text-emerald-700" />
                  ) : order.publicStatus === 'NEEDS_ATTENTION' || order.publicStatus === 'PAYMENT_REVIEW_REQUIRED' ? (
                    <AlertCircle size={24} className="text-amber-700" />
                  ) : (
                    <Clock size={24} className="text-blue-700" />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-bold opacity-70">Current status</p>
                  <h2 className="mt-1 text-2xl font-black">{statusLabel(order.publicStatus)}</h2>
                  <p className="mt-2 text-sm leading-relaxed">{statusMessage(order)}</p>
                  {(order.publicStatus === 'CONVERTED' || order.publicStatus === 'ACCEPTED' || order.publicStatus === 'PREPARING' || order.publicStatus === 'READY' || order.publicStatus === 'SERVED') && order.publicOrderNumber && (
                    <p className="mt-3 inline-flex rounded-full bg-white/75 px-3 py-2 text-xs font-black">
                      Store order number: {order.publicOrderNumber}
                    </p>
                  )}
                </div>
              </div>
            </section>

            {order.paymentProvider === 'RAZORPAY' && (
              <section className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-[#eadfd2]">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-black uppercase tracking-wider text-[#9a6a45]">Online payment</p>
                    <h3 className="mt-1 text-lg font-black text-[#2d2019]">
                      {order.paymentStatus === 'PAID'
                        ? 'Payment confirmed'
                        : order.paymentStatus === 'PAYMENT_PROCESSING'
                          ? 'Confirming payment'
                          : order.paymentStatus === 'PAYMENT_REVIEW_REQUIRED'
                            ? 'Payment under review'
                            : order.paymentStatus === 'REFUND_PENDING'
                              ? 'Refund in progress'
                              : order.paymentStatus === 'REFUNDED'
                                ? 'Payment refunded'
                                : order.paymentStatus === 'REFUND_FAILED'
                                  ? 'Refund needs attention'
                                  : 'Payment status'}
                    </h3>
                    <p className="mt-1 text-sm text-neutral-500">
                      {order.paymentStatus === 'PAID'
                        ? 'Payment is captured. The store is reviewing the order.'
                        : order.paymentStatus === 'PAYMENT_PROCESSING'
                          ? 'Waiting for secure provider confirmation.'
                          : order.paymentStatus === 'PAYMENT_REVIEW_REQUIRED'
                            ? 'The store is reviewing fulfilment.'
                            : order.paymentStatus === 'REFUND_PENDING'
                              ? 'A full refund has been initiated.'
                              : order.paymentStatus === 'REFUNDED'
                                ? 'The provider confirmed the full refund.'
                                : 'No further payment is required.'}
                    </p>
                  </div>
                  <span className={`rounded-full px-3 py-1 text-xs font-black ${
                    order.paymentStatus === 'PAID'
                      ? 'bg-emerald-100 text-emerald-800'
                      : order.paymentStatus === 'PAYMENT_REVIEW_REQUIRED'
                        || order.paymentStatus === 'REFUND_PENDING'
                        || order.paymentStatus === 'REFUND_FAILED'
                        ? 'bg-amber-100 text-amber-800'
                        : order.paymentStatus === 'REFUNDED'
                          ? 'bg-red-100 text-red-800'
                        : 'bg-blue-100 text-blue-800'
                  }`}>
                    {(order.paymentStatus || 'NOT_STARTED').replaceAll('_', ' ')}
                  </span>
                </div>
                {order.paymentStatus === 'PAYMENT_PROCESSING' && (
                  <p className="mt-3 rounded-xl bg-blue-50 p-3 text-sm font-bold text-blue-900">
                    Payment confirmation is in progress. Please do not pay again.
                  </p>
                )}
                {order.paymentStatus === 'PAYMENT_REVIEW_REQUIRED' && (
                  <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm font-bold text-amber-900">
                    Payment was received. The store is reviewing fulfilment; no further payment is required.
                  </p>
                )}
              </section>
            )}

            <section className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-[#eadfd2]">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-bold text-neutral-500">Order reference</p>
                  <p className="mt-1 break-all text-sm font-black text-[#2d2019]">{order.publicOrderReference}</p>
                </div>
                <div className="rounded-2xl bg-[#fbf5ee] px-3 py-2 text-right">
                  <p className="text-xs font-bold text-neutral-500">Total</p>
                  <p className="font-black text-[#2d2019]">{formatMoney(order.total)}</p>
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
                  <p className="mt-1 font-black text-[#2d2019]">{formatDate(order.submittedAt)}</p>
                </div>
              </div>
            </section>

            <section className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-[#eadfd2]">
              <h3 className="text-lg font-black text-[#2d2019]">Progress</h3>
              <div className="mt-4 space-y-3">
                {visibleSteps.map(step => {
                  const state = stepState(order.publicStatus, step.key);
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
                  <div key={`${order.id}-${item.itemName}`} className="flex justify-between gap-3 rounded-2xl bg-[#fbf5ee] px-3 py-2 text-sm">
                    <div>
                      <span className="font-bold text-[#2d2019]">{item.quantity} x {item.itemName}</span>
                      {(item.addOns || []).map(addOn => (
                        <p key={`${addOn.groupName}-${addOn.optionName}`} className="pl-2 text-xs font-semibold text-neutral-500">
                          + {addOn.optionName}{addOn.quantity > 1 ? ` × ${addOn.quantity}` : ''}
                        </p>
                      ))}
                    </div>
                    <span className="font-black text-[#5c4033]">{formatMoney(item.lineTotal)}</span>
                  </div>
                ))}
              </div>

              <div className="mt-4 space-y-2 border-t border-[#eadfd2] pt-3 text-sm">
                <div className="flex justify-between"><span>Subtotal</span><span className="font-black">{formatMoney(order.subtotal)}</span></div>
                <div className="flex justify-between"><span>GST</span><span className="font-black">{formatMoney(order.gstTotal)}</span></div>
                <div className="flex justify-between text-lg font-black text-[#2d2019]"><span>Total</span><span>{formatMoney(order.total)}</span></div>
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
              <Link to="/order/my-orders" className="rounded-2xl border border-[#eadfd2] bg-white px-4 py-3 text-center text-sm font-black text-[#5c4033]">
                My Orders
              </Link>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
