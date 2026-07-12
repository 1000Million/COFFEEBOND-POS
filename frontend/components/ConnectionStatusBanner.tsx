import { useEffect, useMemo, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { AlertTriangle, WifiOff } from 'lucide-react';
import { db } from '../lib/firebase';
import { useAuth } from '../contexts/AuthContext';

const formatTime = (date: Date | null) => {
  if (!date) return 'not synced yet';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export default function ConnectionStatusBanner() {
  const { authStatus } = useAuth();
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [lastFirestoreSyncAt, setLastFirestoreSyncAt] = useState<Date | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if (authStatus !== 'ready') {
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
  }, [authStatus]);

  const shouldShow = !isOnline || Boolean(syncError);

  const banner = useMemo(() => {
    if (!isOnline) {
      return {
        icon: <WifiOff size={16} />,
        className: 'border-red-200 bg-red-50 text-red-800',
        title: 'Connection lost',
        detail: `Last Firestore sync: ${formatTime(lastFirestoreSyncAt)}`,
      };
    }

    if (syncError) {
      return {
        icon: <AlertTriangle size={16} />,
        className: 'border-amber-200 bg-amber-50 text-amber-900',
        title: syncError,
        detail: `Last Firestore sync: ${formatTime(lastFirestoreSyncAt)}`,
      };
    }

    return null;
  }, [isOnline, lastFirestoreSyncAt, syncError]);

  if (!shouldShow || !banner) return null;

  return (
    <div className={`fixed top-3 left-1/2 z-[100] flex max-w-[calc(100vw-24px)] -translate-x-1/2 items-center gap-2 rounded-full border px-4 py-2 text-xs font-semibold shadow-lg ${banner.className}`}>
      {banner.icon}
      <span>{banner.title}</span>
      <span className="hidden font-medium opacity-80 sm:inline">· {banner.detail}</span>
    </div>
  );
}
