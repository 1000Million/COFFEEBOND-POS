import React, { useEffect, useMemo, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { Clock, Loader2, ShoppingBag } from 'lucide-react';
import { Link } from 'react-router-dom';
import CustomerHeader from '../../components/customer/CustomerHeader';
import {
  CustomerProfile,
  customerAuth,
  customerFunctions,
  restoreCustomerProfile,
  waitForCustomerAuthRestoration,
} from '../../lib/customerAuth';
import { rememberCustomerOrder } from '../../lib/customerOrderPersistence';
import { PaymentStatus, PublicOrderStatus } from '../../types';
import { CUSTOMER_HOME_PATH, customerStatusPath } from '../../lib/customerRoutes';

type CustomerOrderSummary = {
  trackingToken: string;
  publicOrderReference: string;
  storeName: string;
  orderType: 'PICKUP' | 'DINE_IN';
  total: number;
  status: PublicOrderStatus | 'COMPLETED';
  paymentStatus: PaymentStatus;
  createdAt: string | null;
};

const listMyCustomerOrders = httpsCallable<void, { orders: CustomerOrderSummary[] }>(
  customerFunctions,
  'listMyCustomerOrders',
);

function money(value: number): string {
  return `₹${Number(value || 0).toFixed(2)}`;
}

function operationalStatus(status: CustomerOrderSummary['status']): string {
  if (status === 'PAID_PENDING_ACCEPTANCE') return 'Paid — awaiting store confirmation';
  if (status === 'ACCEPTED' || status === 'CONVERTED') return 'Accepted';
  if (status === 'PREPARING') return 'Preparing';
  if (status === 'READY') return 'Ready';
  if (status === 'SERVED' || status === 'COMPLETED') return 'Completed';
  if (status === 'PAYMENT_PROCESSING') return 'Payment processing';
  if (status === 'PAYMENT_REVIEW_REQUIRED') return 'Payment review required';
  if (status === 'REFUND_PENDING') return 'Refund pending';
  if (status === 'REFUNDED' || status === 'CANCELLED_REFUNDED') return 'Refunded';
  if (status === 'REFUND_FAILED') return 'Refund failed';
  if (status === 'CANCELLED') return 'Cancelled';
  return status.replaceAll('_', ' ').toLowerCase().replace(/^\w/, value => value.toUpperCase());
}

function paymentLabel(status: PaymentStatus): string {
  if (status === 'PAYMENT_PROCESSING') return 'Payment processing';
  if (status === 'PAYMENT_REVIEW_REQUIRED') return 'Payment review required';
  if (status === 'REFUND_PENDING') return 'Refund pending';
  if (status === 'REFUNDED') return 'Refunded';
  if (status === 'REFUND_FAILED') return 'Refund failed';
  if (status === 'PAID') return 'Paid';
  return status.replaceAll('_', ' ').toLowerCase().replace(/^\w/, value => value.toUpperCase());
}

function isCurrentOrder(order: CustomerOrderSummary): boolean {
  return ![
    'SERVED',
    'COMPLETED',
    'CANCELLED',
    'CANCELLED_REFUNDED',
    'REFUNDED',
    'REFUND_FAILED',
    'REJECTED',
  ].includes(order.status);
}

export default function CustomerMyOrders() {
  const [authRestored, setAuthRestored] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [orders, setOrders] = useState<CustomerOrderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};

    waitForCustomerAuthRestoration().then(() => {
      if (!active) return;
      setAuthRestored(true);
      unsubscribe = onAuthStateChanged(customerAuth, async (user) => {
        if (!active) return;
        setSignedIn(Boolean(user));
        if (!user) {
          setProfile(null);
          setOrders([]);
          setError(null);
          setLoading(false);
          return;
        }
        setLoading(true);
        try {
          const [resolvedProfile, result] = await Promise.all([
            restoreCustomerProfile(),
            listMyCustomerOrders(),
          ]);
          if (!active) return;
          setProfile(resolvedProfile);
          setOrders(result.data.orders);
          result.data.orders.forEach(order => rememberCustomerOrder(order.trackingToken));
          setError(null);
        } catch {
          if (active) setError('We could not load your orders. Please retry.');
        } finally {
          if (active) setLoading(false);
        }
      });
    }).catch(() => {
      if (!active) return;
      setAuthRestored(true);
      setLoading(false);
      setError('We could not restore your verified session. Please retry.');
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const sortedOrders = useMemo(() => (
    [...orders].sort((left, right) => {
      const activeDifference = Number(isCurrentOrder(right)) - Number(isCurrentOrder(left));
      if (activeDifference !== 0) return activeDifference;
      return String(right.createdAt || '').localeCompare(String(left.createdAt || ''));
    })
  ), [orders]);

  return (
    <main className="min-h-[100dvh] min-w-0 overflow-x-hidden bg-[#f8efe6] text-neutral-900 pb-[max(1.5rem,env(safe-area-inset-bottom))] [padding-left:env(safe-area-inset-left)] [padding-right:env(safe-area-inset-right)]">
      <CustomerHeader
        title="My Orders"
        profile={profile}
        authRestored={authRestored}
        onProfileUpdated={setProfile}
        onSignedOut={() => {
          setProfile(null);
          setSignedIn(false);
          setOrders([]);
        }}
      />

      <div className="mx-auto max-w-2xl px-4 py-5">
        {!authRestored || loading ? (
          <div className="rounded-3xl bg-white p-8 text-center shadow-sm">
            <Loader2 className="mx-auto animate-spin text-[#5c4033]" />
            <p className="mt-3 text-sm font-bold text-neutral-500">Loading your orders...</p>
          </div>
        ) : error ? (
          <p className="rounded-2xl bg-red-50 p-4 text-sm font-bold text-red-800">{error}</p>
        ) : !signedIn ? (
          <section className="rounded-3xl bg-white p-6 text-center shadow-sm ring-1 ring-[#eadfd2]">
            <ShoppingBag className="mx-auto text-[#9a6a45]" size={32} />
            <h2 className="mt-3 text-lg font-black">Verify your mobile number to view your orders</h2>
            <p className="mt-2 text-sm text-neutral-500">Return to ordering and choose Pay Online to verify securely.</p>
            <Link to={CUSTOMER_HOME_PATH} className="mt-5 inline-block rounded-2xl bg-[#3b261d] px-5 py-3 text-sm font-black text-white">
              Verify on order page
            </Link>
          </section>
        ) : sortedOrders.length === 0 ? (
          <section className="rounded-3xl bg-white p-6 text-center shadow-sm ring-1 ring-[#eadfd2]">
            <ShoppingBag className="mx-auto text-[#9a6a45]" size={32} />
            <h2 className="mt-3 text-lg font-black">No orders yet</h2>
            <p className="mt-2 text-sm text-neutral-500">Your paid Coffee Bond orders will appear here.</p>
            <Link to={CUSTOMER_HOME_PATH} className="mt-5 inline-block rounded-2xl bg-[#3b261d] px-5 py-3 text-sm font-black text-white">
              Order Now
            </Link>
          </section>
        ) : (
          <div className="space-y-3">
            {sortedOrders.map(order => (
              <article key={order.trackingToken} className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-[#eadfd2]">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-black uppercase tracking-wider text-[#9a6a45]">{order.storeName}</p>
                    <h2 className="mt-1 break-words font-black text-[#2d2019]">{order.publicOrderReference}</h2>
                    <p className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-neutral-500">
                      <Clock size={13} />
                      {order.createdAt ? new Date(order.createdAt).toLocaleString() : 'Recently'}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-xs font-bold text-neutral-500">Total paid</p>
                    <p className="text-lg font-black text-[#2d2019]">{money(order.total)}</p>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-xs font-black">
                  <span className="rounded-full bg-[#fbf5ee] px-3 py-1.5">
                    {order.orderType === 'DINE_IN' ? 'Dine-in' : 'Pickup'}
                  </span>
                  <span className={`rounded-full px-3 py-1.5 ${
                    isCurrentOrder(order) ? 'bg-emerald-50 text-emerald-800' : 'bg-neutral-100 text-neutral-700'
                  }`}>
                    {operationalStatus(order.status)}
                  </span>
                  <span className={`rounded-full px-3 py-1.5 ${
                    order.paymentStatus === 'PAID'
                      ? 'bg-blue-50 text-blue-800'
                      : order.paymentStatus === 'REFUNDED'
                        ? 'bg-neutral-100 text-neutral-700'
                        : 'bg-amber-50 text-amber-800'
                  }`}>
                    {paymentLabel(order.paymentStatus)}
                  </span>
                </div>
                <Link
                  to={customerStatusPath(order.trackingToken)}
                  className="mt-4 block rounded-2xl bg-[#3b261d] px-4 py-3 text-center text-sm font-black text-white"
                >
                  View Order
                </Link>
              </article>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
