import React, { useEffect, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { Clock, Loader2, ShoppingBag } from 'lucide-react';
import { Link } from 'react-router-dom';
import coffeeBondLogo from '../../assets/coffee-bond-logo.png';
import { customerAuth, customerFunctions } from '../../lib/customerAuth';
import { rememberCustomerOrder } from '../../lib/customerOrderPersistence';
import { OnlineOrderStatus, PaymentStatus } from '../../types';

type CustomerOrderSummary = {
  trackingToken: string;
  publicOrderReference: string;
  storeName: string;
  orderType: 'PICKUP' | 'DINE_IN';
  total: number;
  status: OnlineOrderStatus;
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

export default function CustomerMyOrders() {
  const [signedIn, setSignedIn] = useState(Boolean(customerAuth.currentUser));
  const [orders, setOrders] = useState<CustomerOrderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => onAuthStateChanged(customerAuth, (user) => {
    setSignedIn(Boolean(user));
    if (!user) {
      setOrders([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    listMyCustomerOrders().then(result => {
      setOrders(result.data.orders);
      result.data.orders.forEach(order => rememberCustomerOrder(order.trackingToken));
      setError(null);
    }).catch(() => {
      setError('We could not load your orders. Please retry.');
    }).finally(() => setLoading(false));
  }), []);

  return (
    <main className="min-h-[100dvh] bg-[#f8efe6] px-4 py-5 text-neutral-900">
      <div className="mx-auto max-w-lg">
        <header className="mb-5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <img src={coffeeBondLogo} alt="Coffee Bond" className="h-10 w-10 rounded-xl bg-white object-contain p-1 shadow-sm" />
            <div>
              <p className="text-xs font-black tracking-[0.18em] text-[#9a6a45]">COFFEE BOND</p>
              <h1 className="text-xl font-black text-[#2d2019]">My Orders</h1>
            </div>
          </div>
          <Link to="/order" className="rounded-full bg-white px-4 py-2 text-xs font-black text-[#5c4033] shadow-sm">
            Order
          </Link>
        </header>

        {!signedIn ? (
          <section className="rounded-3xl bg-white p-6 text-center shadow-sm ring-1 ring-[#eadfd2]">
            <ShoppingBag className="mx-auto text-[#9a6a45]" size={32} />
            <h2 className="mt-3 text-lg font-black">Verify your mobile first</h2>
            <p className="mt-2 text-sm text-neutral-500">Start Pay Online checkout and verify your mobile to recover your orders securely.</p>
            <Link to="/order" className="mt-5 inline-block rounded-2xl bg-[#3b261d] px-5 py-3 text-sm font-black text-white">
              Verify on order page
            </Link>
          </section>
        ) : loading ? (
          <div className="rounded-3xl bg-white p-8 text-center shadow-sm">
            <Loader2 className="mx-auto animate-spin text-[#5c4033]" />
          </div>
        ) : error ? (
          <p className="rounded-2xl bg-red-50 p-4 text-sm font-bold text-red-800">{error}</p>
        ) : orders.length === 0 ? (
          <section className="rounded-3xl bg-white p-6 text-center shadow-sm">
            <h2 className="font-black">No paid orders yet</h2>
            <p className="mt-1 text-sm text-neutral-500">Your verified online orders will appear here.</p>
          </section>
        ) : (
          <div className="space-y-3">
            {orders.map(order => (
              <Link
                key={order.trackingToken}
                to={`/order/status/${order.trackingToken}`}
                className="block rounded-3xl bg-white p-4 shadow-sm ring-1 ring-[#eadfd2]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-black uppercase tracking-wider text-[#9a6a45]">{order.storeName}</p>
                    <h2 className="mt-1 font-black text-[#2d2019]">{order.publicOrderReference}</h2>
                    <p className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-neutral-500">
                      <Clock size={13} />
                      {order.createdAt ? new Date(order.createdAt).toLocaleString() : 'Recently'}
                    </p>
                  </div>
                  <p className="text-lg font-black text-[#2d2019]">{money(order.total)}</p>
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-xs font-black">
                  <span className="rounded-full bg-[#fbf5ee] px-3 py-1.5">{order.orderType.replace('_', ' ')}</span>
                  <span className="rounded-full bg-emerald-50 px-3 py-1.5 text-emerald-800">{order.status.replaceAll('_', ' ')}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
