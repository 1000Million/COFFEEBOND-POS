import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, getDoc, getDocs, onSnapshot, query, where } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { OnlineOrder, StaffProfile, Store } from '../types';
import { db } from './firebase';
import { accessiblePosStores, assignedStoreIdentifiers } from './posStoreAccess';
import { TestAlertSoundButton, useRepeatingOrderAlert } from './orderAlerts';

type OnlineOrderAlertsState = {
  accessibleStores: Store[];
  selectedStoreId: string;
  setSelectedStoreId: (storeId: string) => void;
  orders: OnlineOrder[];
  loading: boolean;
  error: string | null;
  loadOrders: (storeId?: string) => Promise<void>;
} & ReturnType<typeof useRepeatingOrderAlert>;

const OnlineOrderAlertsContext = createContext<OnlineOrderAlertsState | null>(null);
export const useOnlineOrderAlerts = () => useContext(OnlineOrderAlertsContext);

// One owner above the route Suspense boundary. A changed identity/permission
// scope remounts the owner, cancelling reads and clearing the previous user's state.
export function OnlineOrderAlertsProvider({ children }: { children: React.ReactNode }) {
  const { authStatus, firebaseUser, staffProfile } = useAuth();
  if (authStatus !== 'ready' || !firebaseUser || !staffProfile
    || !['ADMIN', 'STORE_MANAGER', 'CASHIER'].includes(staffProfile.role)) {
    return <OnlineOrderAlertsContext.Provider value={null}>{children}</OnlineOrderAlertsContext.Provider>;
  }
  const scope = JSON.stringify([firebaseUser.uid, staffProfile.role, assignedStoreIdentifiers(staffProfile).sort()]);
  return <ScopedOnlineOrderAlerts key={scope} profile={staffProfile}>{children}</ScopedOnlineOrderAlerts>;
}

function ScopedOnlineOrderAlerts({ profile, children }: { profile: StaffProfile; children: React.ReactNode }) {
  // The provider key includes every permission input used by accessiblePosStores.
  const [accessProfile] = useState(profile);
  const [accessibleStores, setAccessibleStores] = useState<Store[]>([]);
  const [selectedStoreId, selectStore] = useState('');
  const [pendingOrders, setPendingOrders] = useState<OnlineOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [subscriptionVersion, setSubscriptionVersion] = useState(0);
  const orders = pendingOrders.filter(order => order.storeId === selectedStoreId);
  const audio = useRepeatingOrderAlert(orders.length);

  useEffect(() => {
    let active = true;
    const loadStores = async () => {
      // Identical store reads/permission resolver to Incoming Online Orders.
      const loadedStores = (accessProfile.role === 'ADMIN'
        ? (await getDocs(query(collection(db, 'stores'), where('isActive', '==', true)))).docs
          .map(snap => ({ id: snap.id, ...snap.data() } as Store))
        : (await Promise.all(assignedStoreIdentifiers(accessProfile)
          .map(storeId => getDoc(doc(db, 'stores', storeId)).catch(() => null))))
          .filter((snap): snap is NonNullable<typeof snap> => Boolean(snap?.exists()))
          .map(snap => ({ id: snap.id, ...snap.data() } as Store)))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (!active) return;
      const allowed = accessiblePosStores(loadedStores, accessProfile);
      setAccessibleStores(allowed);
      selectStore(allowed[0]?.id || '');
      setLoading(false);
    };
    void loadStores().catch(() => {
      if (!active) return;
      setError('Could not load stores for online order alerts.');
      setLoading(false);
    });
    return () => { active = false; };
  }, [accessProfile]);

  useEffect(() => {
    if (!selectedStoreId || !accessibleStores.some(store => store.id === selectedStoreId)) return;
    let active = true;
    const statuses: OnlineOrder['status'][] = [
      'PENDING', 'NEEDS_ATTENTION', 'PAID_PENDING_ACCEPTANCE', 'PAYMENT_REVIEW_REQUIRED', 'REFUND_FAILED',
    ];
    const byStatus = new Map<string, OnlineOrder[]>();
    setPendingOrders(previous => previous.filter(order => order.storeId === selectedStoreId));
    setLoading(true);
    setError(null);
    // Keep all five existing store/status equality queries; no route dependency.
    const unsubs = statuses.map(status => onSnapshot(query(
      collection(db, 'onlineOrders'),
      where('storeId', '==', selectedStoreId),
      where('status', '==', status),
    ), { includeMetadataChanges: true }, snap => {
      if (!active || snap.metadata.hasPendingWrites) return;
      byStatus.set(status, snap.docs.map(orderDoc => ({ id: orderDoc.id, ...orderDoc.data() } as OnlineOrder)));
      if (byStatus.size !== statuses.length) return;
      const unique = new Map(Array.from(byStatus.values()).flat().map(order => [order.id, order]));
      setPendingOrders(Array.from(unique.values()).sort((a, b) =>
        (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0)));
      setLoading(false);
    }, () => {
      if (!active) return;
      setError('Could not refresh incoming online orders. Existing alerts remain active; use Refresh to retry.');
      setLoading(false);
    }));
    return () => { active = false; unsubs.forEach(unsubscribe => unsubscribe()); };
  }, [selectedStoreId, accessibleStores, subscriptionVersion]);

  const setSelectedStoreId = (storeId: string) => {
    if (accessibleStores.some(store => store.id === storeId)) selectStore(storeId);
  };
  const loadOrders = async (storeId = selectedStoreId) => {
    if (storeId === selectedStoreId) setSubscriptionVersion(version => version + 1);
  };
  return <OnlineOrderAlertsContext.Provider value={{ accessibleStores, selectedStoreId, setSelectedStoreId,
    orders, loading, error, loadOrders, ...audio }}>{children}</OnlineOrderAlertsContext.Provider>;
}

// In the staff layout's normal flow. Sound ownership lives in the provider so
// hiding/remounting the layout during lazy navigation cannot silence an order.
export function GlobalOnlineOrderAlertBanner() {
  const alerts = useOnlineOrderAlerts();
  if (!alerts) return null;
  const store = alerts.accessibleStores.find(row => row.id === alerts.selectedStoreId);
  return (
    <div role="status" className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
      <div className="min-w-0">
        <p className="font-black">{alerts.audioBlocked ? 'Order alert sound is off' : alerts.orders.length ? 'Order alert sounding' : 'Order alerts enabled'}</p>
        <Link to="/pos/incoming-orders" className="font-bold underline">Online orders{store ? ` · ${store.name}` : ''}{alerts.orders.length ? ` · ${alerts.orders.length} awaiting action` : ''}</Link>
        {alerts.error && <p>{alerts.error}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
      <TestAlertSoundButton />
      {alerts.audioBlocked && <button type="button" onPointerDown={() => void alerts.enableAudio()} onClick={() => void alerts.enableAudio()} className="min-h-[48px] rounded-xl bg-amber-900 px-4 py-3 font-black text-white">Tap to enable order alerts</button>}
      </div>
    </div>
  );
}

// Presentation only: sound ownership and all five store/status listeners stay above routes.
export function OnlineOrderSoundControl({ storeId }: { storeId: string }) {
  const alerts = useOnlineOrderAlerts();
  const menu = useRef<HTMLDetailsElement>(null);
  if (!alerts) return null;
  const store = alerts.accessibleStores.find(row => row.id === storeId)
    || alerts.accessibleStores.find(row => row.id === alerts.selectedStoreId);
  const closeMenu = () => { if (menu.current) menu.current.open = false; };
  return <div className="pos-order-sound" data-order-sound-control="true">
    <button type="button" role="switch" aria-label="Order sound"
      aria-checked={alerts.audioEnabled}
      aria-describedby={alerts.audioBlocked && !alerts.audioMuted ? 'pos-order-sound-hint' : undefined}
      className="pos-order-sound-toggle"
      onClick={() => { if (alerts.audioEnabled) alerts.muteAudio(); else void alerts.enableAudio({ confirmation: false }); }}>
      <span>Order sound</span><span className="pos-order-sound-track" aria-hidden="true"><span /></span>
      <span className="pos-order-sound-state">{alerts.audioEnabled ? 'On' : 'Off'}</span>
    </button>
    <details ref={menu} className="pos-order-sound-more"
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeMenu(); }}
      onKeyDown={event => { if (event.key === 'Escape' && menu.current?.open) {
        event.preventDefault(); event.stopPropagation(); closeMenu(); menu.current.querySelector('summary')?.focus();
      } }}>
      <summary aria-label="Order sound options" title="Order sound options"><span aria-hidden="true">⋯</span></summary>
      <div className="pos-order-sound-menu" onClick={closeMenu}>
        <TestAlertSoundButton />
        <Link to="/pos/incoming-orders" onClick={() => { if (store) alerts.setSelectedStoreId(store.id); }}>
          Online orders{store ? ` · ${store.name}` : ''}
        </Link>
      </div>
    </details>
    {alerts.audioBlocked && !alerts.audioMuted && <span id="pos-order-sound-hint" className="pos-order-sound-hint" role="status">Tap to enable</span>}
    {alerts.error && <span className="pos-order-sound-error" role="status">{alerts.error}</span>}
  </div>;
}
