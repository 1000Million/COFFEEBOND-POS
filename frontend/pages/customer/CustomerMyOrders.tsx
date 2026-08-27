import { useEffect, useMemo, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { onSnapshot } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { useLocation, useNavigate } from 'react-router-dom';
import CustomerOrdersScreen, {
  OrdersScreenState,
  PastOrderView,
} from '../../components/customer/CustomerOrdersScreen';
import {
  CustomerProfile,
  customerAuth,
  customerFunctions,
  restoreCustomerProfile,
  waitForCustomerAuthRestoration,
} from '../../lib/customerAuth';
import { rememberCustomerOrder } from '../../lib/customerOrderPersistence';
import { readCustomerCheckoutDraft } from '../../lib/customerCheckoutPersistence';
import { publicTrackingDocRef } from '../../lib/publicOrderTracking';
import { explicitBondDemoKey } from '../../lib/bondLoyalty';
import { PaymentStatus, PublicOrderStatus, PublicOrderTracking } from '../../types';
import { CUSTOMER_HOME_PATH, customerStatusPath } from '../../lib/customerRoutes';

type CustomerOrderSummary = {
  trackingToken: string;
  publicOrderReference: string;
  storeName: string;
  orderType: 'PICKUP' | 'DINE_IN';
  total: number;
  status: PublicOrderStatus | 'COMPLETED';
  paymentStatus: PaymentStatus;
  /** Points posted by the server's immutable POINT_EARN ledger entry. Never estimated. */
  pointsEarned?: number | null;
  bondRedemptionPoints?: number | null;
  bondRedemptionDiscount?: number | null;
  discountLabel?: string | null;
  createdAt: string | null;
};

/* The one authenticated history source. Stage 5 adds no second orders query. */
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

/**
 * The canonical "is this order still live" test. Unchanged from the previous screen and
 * still driven by the order status, never by matching display strings.
 */
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

/** Orders that ended badly read as ended, not as a neutral archive entry. */
function statusTone(status: CustomerOrderSummary['status']): 'settled' | 'ended' {
  return ['CANCELLED', 'CANCELLED_REFUNDED', 'REFUNDED', 'REFUND_FAILED', 'REJECTED'].includes(status)
    ? 'ended'
    : 'settled';
}

/**
 * Orders — data only.
 *
 * This module owns the queries, the auth gate and the live subscription; the layout
 * lives in CustomerOrdersScreen. The split is deliberate: it lets the screen be
 * rendered and measured at every viewport in every state without a backend, which is
 * how the visual work on this page is actually verified.
 *
 * Data sources are unchanged. History is the existing authenticated
 * listMyCustomerOrders callable. The live order's status and items come from the same
 * public tracking document the tracking screen already subscribes to — the same
 * onSnapshot, not a second implementation of order status.
 */
export default function CustomerMyOrders() {
  const location = useLocation();
  const navigate = useNavigate();
  const demoRequested = Boolean(explicitBondDemoKey(location.search));
  const [authRestored, setAuthRestored] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [orders, setOrders] = useState<CustomerOrderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [liveOrder, setLiveOrder] = useState<PublicOrderTracking | null>(null);
  const [previewOrder, setPreviewOrder] = useState<CustomerOrderSummary | null>(null);

  useEffect(() => {
    if (!demoRequested) {
      setPreviewOrder(null);
      return undefined;
    }
    let active = true;
    void import('@bond-preview').then(module => {
      if (active) setPreviewOrder(module.BOND_PREVIEW_ORDER as CustomerOrderSummary | null);
    });
    return () => { active = false; };
  }, [demoRequested]);

  useEffect(() => {
    if (demoRequested) {
      setAuthRestored(true);
      setSignedIn(true);
      setLoading(false);
      setError(null);
      return undefined;
    }
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
  }, [demoRequested]);

  const displayedOrders = useMemo(
    () => (demoRequested && previewOrder ? [previewOrder] : orders),
    [demoRequested, orders, previewOrder],
  );
  const activeOrder = useMemo(() => (
    [...displayedOrders]
      .filter(isCurrentOrder)
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))[0] || null
  ), [displayedOrders]);

  const pastOrders = useMemo(() => (
    displayedOrders
      .filter(order => order.trackingToken !== activeOrder?.trackingToken)
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
  ), [activeOrder, displayedOrders]);

  /* Live status for the one active order, from the tracking document the tracking
     screen already reads. Keyed on the token so switching orders never shows stale
     items from the previous one. */
  useEffect(() => {
    if (demoRequested || !activeOrder) {
      setLiveOrder(null);
      return undefined;
    }
    setLiveOrder(null);
    const unsubscribe = onSnapshot(
      publicTrackingDocRef(activeOrder.trackingToken),
      (snapshot) => {
        setLiveOrder(snapshot.exists() ? ({ id: snapshot.id, ...snapshot.data() } as PublicOrderTracking) : null);
      },
      () => {
        // The summary below already carries an authoritative status; live detail is a bonus.
        setLiveOrder(null);
      },
    );
    return unsubscribe;
  }, [activeOrder?.trackingToken, demoRequested]);

  /* Basket count for the persistent bar, read from the existing saved draft. This page
     owns no cart state and mutates nothing. */
  const basketCount = useMemo(() => {
    const draft = readCustomerCheckoutDraft(window.localStorage).draft;
    return (draft?.lines || []).reduce((sum, line) => sum + (line.quantity || 0), 0);
  }, []);

  const activeStatus = liveOrder?.publicStatus ?? (activeOrder?.status as PublicOrderStatus | undefined);
  const activeItemSummary = (liveOrder?.items || [])
    .map(item => (item.quantity > 1 ? `${item.quantity}× ${item.itemName}` : item.itemName))
    .slice(0, 3)
    .join(' · ');
  const activeExtraItems = Math.max(0, (liveOrder?.items || []).length - 3);

  const past: PastOrderView[] = pastOrders.map(order => ({
    key: order.trackingToken,
    storeName: order.storeName,
    reference: order.publicOrderReference,
    dateLabel: order.createdAt
      ? new Date(order.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
      : null,
    fulfilmentLabel: order.orderType === 'DINE_IN' ? 'Dine-in' : 'Pickup',
    statusLabel: operationalStatus(order.status),
    /* Server-posted only: listMyOrders reads this from the loyalty ledger, so a value
       here means a POINT_EARN event exists. The client never estimates it. */
    pointsEarned: typeof order.pointsEarned === 'number' ? order.pointsEarned : null,
    bondRedemptionPoints: typeof order.bondRedemptionPoints === 'number' ? order.bondRedemptionPoints : null,
    bondRedemptionLabel: order.discountLabel || null,
    bondRedemptionDiscountLabel: typeof order.bondRedemptionDiscount === 'number'
      ? money(order.bondRedemptionDiscount)
      : null,
    statusTone: statusTone(order.status),
    totalLabel: money(order.total),
    viewPath: customerStatusPath(order.trackingToken),
  }));

  const state: OrdersScreenState = (!authRestored || loading || (demoRequested && !previewOrder))
    ? { kind: 'loading' }
    : !demoRequested && error
      ? { kind: 'error', message: error }
      : !demoRequested && !signedIn
        ? { kind: 'signed-out' }
        : displayedOrders.length === 0
          ? { kind: 'empty' }
          : {
            kind: 'ready',
            active: activeOrder && activeStatus
              ? {
                storeName: activeOrder.storeName,
                statusLabel: operationalStatus(liveOrder?.publicStatus ?? activeOrder.status),
                itemSummary: activeExtraItems > 0 ? `${activeItemSummary} +${activeExtraItems} more` : activeItemSummary,
                totalLabel: money(liveOrder?.total ?? activeOrder.total),
                trackPath: customerStatusPath(activeOrder.trackingToken),
              }
              : null,
            past,
          };

  const goToMenu = () => navigate(CUSTOMER_HOME_PATH);

  return (
    <CustomerOrdersScreen
      state={state}
      profile={profile}
      authRestored={authRestored}
      basketCount={basketCount}
      onProfileUpdated={setProfile}
      onSignedOut={() => {
        setProfile(null);
        setSignedIn(false);
        setOrders([]);
      }}
      onGoToMenu={goToMenu}
      onOpenBasket={() => navigate(CUSTOMER_HOME_PATH, { state: { openBasket: true } })}
      onFocusSearch={() => navigate(CUSTOMER_HOME_PATH, { state: { focusSearch: true } })}
      onOpenAccount={() => {
        const control = document.querySelector<HTMLElement>(
          'header [aria-label="Open customer account"], header [aria-label="Customer account"]',
        );
        if (control) control.click();
        else goToMenu();
      }}
    />
  );
}
