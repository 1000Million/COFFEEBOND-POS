import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import {
  CRITICAL_OPERATION_EVENT,
  OFFLINE_ACTION_BLOCKED_EVENT,
  OFFLINE_ACTION_MESSAGE,
  browserIsOnline,
  requireOnlineAction,
} from '../lib/connectivity';

type ConnectivityContextValue = {
  isOnline: boolean;
  isOffline: boolean;
  isReconnected: boolean;
  lastOnlineAt: Date | null;
  blockedActionMessage: string;
  criticalOperationActive: boolean;
  requireOnline: () => boolean;
  clearBlockedActionMessage: () => void;
};

const ConnectivityContext = createContext<ConnectivityContextValue | null>(null);

export function ConnectivityProvider({ children }: { children: ReactNode }) {
  const [isOnline, setIsOnline] = useState(browserIsOnline);
  const [isReconnected, setIsReconnected] = useState(false);
  const [lastOnlineAt, setLastOnlineAt] = useState<Date | null>(() => (browserIsOnline() ? new Date() : null));
  const [blockedActionMessage, setBlockedActionMessage] = useState('');
  const [criticalOperationCount, setCriticalOperationCount] = useState(0);

  useEffect(() => {
    let reconnectTimer: number | undefined;
    let blockedTimer: number | undefined;

    const handleOnline = () => {
      setIsOnline(true);
      setLastOnlineAt(new Date());
      setIsReconnected(true);
      window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(() => setIsReconnected(false), 3500);
    };
    const handleOffline = () => {
      setIsOnline(false);
      setIsReconnected(false);
    };
    const handleBlockedAction = (event: Event) => {
      const message = (event as CustomEvent<{ message?: string }>).detail?.message || OFFLINE_ACTION_MESSAGE;
      setBlockedActionMessage(message);
      window.clearTimeout(blockedTimer);
      blockedTimer = window.setTimeout(() => setBlockedActionMessage(''), 5000);
    };
    const handleCriticalOperation = (event: Event) => {
      const count = Number((event as CustomEvent<{ count?: number }>).detail?.count || 0);
      setCriticalOperationCount(Math.max(0, count));
    };
    const blockOfflineAction = (event: MouseEvent) => {
      if (browserIsOnline()) return;
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>('[data-requires-online="true"]')
        : null;
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      handleBlockedAction(new CustomEvent(OFFLINE_ACTION_BLOCKED_EVENT, {
        detail: { message: OFFLINE_ACTION_MESSAGE },
      }));
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener(OFFLINE_ACTION_BLOCKED_EVENT, handleBlockedAction);
    window.addEventListener(CRITICAL_OPERATION_EVENT, handleCriticalOperation);
    document.addEventListener('click', blockOfflineAction, true);

    return () => {
      window.clearTimeout(reconnectTimer);
      window.clearTimeout(blockedTimer);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener(OFFLINE_ACTION_BLOCKED_EVENT, handleBlockedAction);
      window.removeEventListener(CRITICAL_OPERATION_EVENT, handleCriticalOperation);
      document.removeEventListener('click', blockOfflineAction, true);
    };
  }, []);

  const value = useMemo<ConnectivityContextValue>(() => ({
    isOnline,
    isOffline: !isOnline,
    isReconnected,
    lastOnlineAt,
    blockedActionMessage,
    criticalOperationActive: criticalOperationCount > 0,
    requireOnline: requireOnlineAction,
    clearBlockedActionMessage: () => setBlockedActionMessage(''),
  }), [blockedActionMessage, criticalOperationCount, isOnline, isReconnected, lastOnlineAt]);

  return <ConnectivityContext.Provider value={value}>{children}</ConnectivityContext.Provider>;
}
export function useConnectivity(): ConnectivityContextValue {
  const value = useContext(ConnectivityContext);
  if (!value) throw new Error('useConnectivity must be used inside ConnectivityProvider.');
  return value;
}
