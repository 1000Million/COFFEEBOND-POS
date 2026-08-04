import { useEffect, useMemo, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { AlertTriangle, CheckCircle2, WifiOff, X } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { db } from '../lib/firebase';
import { useAuth } from '../contexts/AuthContext';
import { useConnectivity } from '../contexts/ConnectivityContext';
import { CUSTOMER_OFFLINE_MESSAGE, STAFF_OFFLINE_MESSAGE } from '../lib/connectivity';

const formatTime = (date: Date | null) => {
  if (!date) return 'not synced yet';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export default function ConnectionStatusBanner() {
  const { authStatus } = useAuth();
  const location = useLocation();
  const {
    isOnline,
    isReconnected,
    blockedActionMessage,
    clearBlockedActionMessage,
  } = useConnectivity();
  const [lastFirestoreSyncAt, setLastFirestoreSyncAt] = useState<Date | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const isCustomerRoute = location.pathname === '/order' || location.pathname.startsWith('/order/');

  useEffect(() => {
    if (authStatus !== 'ready' || isCustomerRoute || !isOnline) {
      setLastFirestoreSyncAt(null);
      setSyncError(null);
      return undefined;
    }

    const unsubscribe = onSnapshot(
      doc(db, 'appSettings', 'gstConfig'),
      () => {
        setLastFirestoreSyncAt(new Date());
        setSyncError(null);
      },
      (error) => {
        setSyncError(error.code === 'permission-denied'
          ? 'Permission denied while checking Firestore sync.'
          : 'Firestore sync check failed.');
      },
    );

    return unsubscribe;
  }, [authStatus, isCustomerRoute, isOnline]);

  const shouldShow = !isOnline || isReconnected || Boolean(syncError) || Boolean(blockedActionMessage);

  const banner = useMemo(() => {
    if (blockedActionMessage) {
      return {
        icon: <AlertTriangle size={18} />,
        className: 'border-amber-300 bg-amber-50 text-amber-950',
        title: blockedActionMessage,
        detail: '',
        dismissible: true,
      };
    }

    if (!isOnline) {
      return {
        icon: <WifiOff size={18} />,
        className: 'border-amber-300 bg-amber-50 text-amber-950',
        title: isCustomerRoute ? CUSTOMER_OFFLINE_MESSAGE : STAFF_OFFLINE_MESSAGE,
        detail: isCustomerRoute ? '' : `Last online: ${formatTime(lastFirestoreSyncAt)}`,
        dismissible: false,
      };
    }

    if (isReconnected) {
      return {
        icon: <CheckCircle2 size={18} />,
        className: 'border-emerald-200 bg-emerald-50 text-emerald-900',
        title: 'Back online',
        detail: 'Actions are available again. Nothing was resubmitted automatically.',
        dismissible: false,
      };
    }

    if (syncError) {
      return {
        icon: <AlertTriangle size={16} />,
        className: 'border-amber-200 bg-amber-50 text-amber-900',
        title: syncError,
        detail: `Last Firestore sync: ${formatTime(lastFirestoreSyncAt)}`,
        dismissible: false,
      };
    }

    return null;
  }, [blockedActionMessage, isCustomerRoute, isOnline, isReconnected, lastFirestoreSyncAt, syncError]);

  if (!shouldShow || !banner) return null;

  return (
    <div
      role="status"
      aria-live="assertive"
      className={`fixed inset-x-3 top-[max(0.75rem,env(safe-area-inset-top))] z-[100] mx-auto flex max-w-2xl items-start gap-2 rounded-2xl border px-4 py-3 text-sm font-semibold shadow-lg ${banner.className}`}
    >
      <span className="mt-0.5 shrink-0">{banner.icon}</span>
      <span className="min-w-0 flex-1">
        <span>{banner.title}</span>
        {banner.detail && <span className="ml-1 font-medium opacity-80">{banner.detail}</span>}
      </span>
      {banner.dismissible && (
        <button type="button" onClick={clearBlockedActionMessage} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl" aria-label="Dismiss connection message">
          <X size={17} />
        </button>
      )}
    </div>
  );
}
