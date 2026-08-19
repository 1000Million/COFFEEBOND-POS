import React from 'react';
import { Link } from 'react-router-dom';
import CustomerHeader from './CustomerHeader';
import CustomerBottomNav from './CustomerBottomNav';
import CustomerActiveOrderCard from './CustomerActiveOrderCard';
import CustomerOrderCard from './CustomerOrderCard';
import { CustomerProfile } from '../../lib/customerAuth';
import { CUSTOMER_HOME_PATH } from '../../lib/customerRoutes';

export type ActiveOrderView = {
  storeName: string;
  statusLabel: string;
  itemSummary: string;
  totalLabel: string | null;
  trackPath: string;
};

export type PastOrderView = {
  key: string;
  storeName: string;
  reference: string;
  dateLabel: string | null;
  fulfilmentLabel: string;
  statusLabel: string;
  statusTone: 'settled' | 'ended';
  totalLabel: string;
  viewPath: string;
};

/**
 * Everything Orders can be showing, as one closed set.
 *
 * The container decides which one applies from the live data; this file decides how
 * each looks. Keeping them separate is what makes the screen renderable — and
 * therefore measurable — without Firebase, an authenticated session or a live order.
 */
export type OrdersScreenState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'signed-out' }
  | { kind: 'empty' }
  | { kind: 'ready'; active: ActiveOrderView | null; past: PastOrderView[] };

export type Props = {
  state: OrdersScreenState;
  profile: CustomerProfile | null;
  authRestored: boolean;
  basketCount: number;
  onProfileUpdated: (profile: CustomerProfile) => void;
  onSignedOut: () => void;
  onGoToMenu: () => void;
  onOpenBasket: () => void;
  onFocusSearch: () => void;
  onOpenAccount: () => void;
};

/**
 * Compact placeholders shaped like the content they stand in for — one live-order
 * block and a few history rows — so nothing jumps when the real orders arrive and the
 * page never shows a large empty "loading" panel.
 */
function OrdersSkeleton() {
  return (
    <div aria-hidden="true">
      {/* The gap is carried by the block above, not by `mt-7` on the row list: this
          file's `.cb-customer-rows` reset lives in customer.css, which is UNLAYERED,
          and unlayered declarations beat Tailwind's `@layer utilities` at any
          specificity — so a margin utility on the list is silently dropped. */}
      <div className="cb-customer-skeleton mb-7 h-[132px] animate-pulse rounded-[28px] motion-reduce:animate-none" />
      <div className="cb-customer-rows">
        {[0, 1, 2, 3].map(key => (
          <div key={key} className="cb-customer-row">
            <div className="min-w-0 flex-1">
              <div className="cb-customer-skeleton h-3.5 w-2/5 animate-pulse rounded-full motion-reduce:animate-none" />
              <div className="cb-customer-skeleton mt-2 h-3 w-1/4 animate-pulse rounded-full motion-reduce:animate-none" />
            </div>
            <div className="cb-customer-skeleton h-3.5 w-16 animate-pulse rounded-full motion-reduce:animate-none" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A calm block on the page, rather than a large centred card in an empty screen. */
function OrdersMessage({ headline, body }: { headline: string; body: string }) {
  return (
    <div className="cb-customer-orders-void">
      <p className="cb-customer-standfirst">{headline}</p>
      <p className="cb-customer-lede mt-2">{body}</p>
      <Link
        to={CUSTOMER_HOME_PATH}
        className="cb-customer-accent-button mt-6 inline-flex min-h-12 items-center rounded-2xl px-5 text-sm font-black"
      >
        Browse menu
      </Link>
    </div>
  );
}

/**
 * The customer's single Orders destination.
 *
 * One page heading, then the live order as the only filled surface, then history as
 * flat rows on the page. The previous pass gave the heading, the live order and every
 * past order their own bordered card, so five things asked for attention at once and a
 * short history looked like a table of records.
 *
 * Account no longer links here, because the Orders tab is permanent, and the header on
 * this screen deliberately does not offer a second route to Orders either.
 */
export default function CustomerOrdersScreen({
  state,
  profile,
  authRestored,
  basketCount,
  onProfileUpdated,
  onSignedOut,
  onGoToMenu,
  onOpenBasket,
  onFocusSearch,
  onOpenAccount,
}: Props) {
  return (
    <div className="cb-app cb-customer-page-bottom min-h-[100dvh] min-w-0 overflow-x-hidden bg-[#fbf7f1] font-sans text-[#271a16] [padding-left:env(safe-area-inset-left)] [padding-right:env(safe-area-inset-right)]">
      <CustomerHeader
        title="Orders"
        profile={profile}
        authRestored={authRestored}
        onProfileUpdated={onProfileUpdated}
        onSignedOut={onSignedOut}
        onOpenMyUsual={onGoToMenu}
        /* This page IS Orders and its bar already carries an Account tab, so the
           header must not offer a second route to either. */
        onSignedOutAccountPress={onGoToMenu}
      />

      <main className="mx-auto min-w-0 max-w-2xl px-4 pt-6">
        <h1 className="cb-customer-screen-title">Your orders</h1>

        {state.kind === 'loading' ? (
          <>
            <p className="sr-only" role="status" aria-live="polite">Loading your orders</p>
            <div className="mt-6">
              <OrdersSkeleton />
            </div>
          </>
        ) : state.kind === 'error' ? (
          <p role="alert" className="cb-customer-checkout-notice tone-error mt-6 px-3 py-2.5 text-[12.5px] font-bold">
            {state.message}
          </p>
        ) : state.kind === 'signed-out' ? (
          <OrdersMessage
            headline="Verify your mobile number to see your orders."
            body="You’ll be asked to verify securely at checkout."
          />
        ) : state.kind === 'empty' ? (
          <OrdersMessage headline="No orders yet." body="Your next Coffee Bond is waiting." />
        ) : (
          <>
            {state.active && (
              <div className="mt-5">
                <CustomerActiveOrderCard {...state.active} />
              </div>
            )}

            {state.past.length > 0 && (
              <section className={state.active ? 'mt-8' : 'mt-6'} aria-labelledby="cb-past-orders-heading">
                <h2 id="cb-past-orders-heading" className="cb-customer-eyebrow mb-2">Earlier</h2>
                <ul className="cb-customer-rows">
                  {state.past.map(order => (
                    <CustomerOrderCard
                      key={order.key}
                      storeName={order.storeName}
                      reference={order.reference}
                      dateLabel={order.dateLabel}
                      fulfilmentLabel={order.fulfilmentLabel}
                      statusLabel={order.statusLabel}
                      statusTone={order.statusTone}
                      totalLabel={order.totalLabel}
                      viewPath={order.viewPath}
                    />
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </main>

      {/* The same persistent bar as the menu, so Orders is a tab rather than a
          separate little app the customer has to find their way back out of. */}
      <CustomerBottomNav
        itemCount={basketCount}
        onOpenBasket={onOpenBasket}
        onFocusSearch={onFocusSearch}
        onGoToMenu={onGoToMenu}
        onOpenAccount={onOpenAccount}
      />
    </div>
  );
}
