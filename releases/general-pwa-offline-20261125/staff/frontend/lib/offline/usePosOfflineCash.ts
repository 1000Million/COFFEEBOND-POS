import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { StaffProfile, Store } from '../../types';
import { beginCriticalOperation } from '../connectivity';
import { auth } from '../firebase';
import { assignedStoreIdentifiers } from '../posStoreAccess';
import { hasTableAuthority, projectTables, supportedOfflineSnapshot } from './tableRepository';
import { useUpdateBlocker } from '../useUpdateBlocker';
import { prepareLocalPrint } from './localPrint';

import { validPosStoreId } from '../tables/api';
import {
  entries as readEntries,
  getMeta,
  prepare as prepareSession,
  reconcile as reconcileEntry,
  synchronize,
  usable,verifySnapshotForRead,tillRecoveryOnly,
  type Entry,
  type Snapshot,
} from './journal';

type Options = {
  store?: Pick<Store, 'id' | 'isActive' | 'posEnabled'> | null;
  staffProfile?: StaffProfile | null;
  online: boolean;
};

type JournalView = {
  scope: string;
  snapshot: Snapshot | null;
  entries: Entry[];
  hasDevice: boolean;
  valid: boolean;
  pendingDeviceWork: boolean;
  reason: string;
};

const EMPTY_VIEW: JournalView = { scope: '', snapshot: null, entries: [], hasDevice: false, valid: false, pendingDeviceWork:true, reason: 'Checking local authorization.' };
const CASH_ROLES = new Set(['ADMIN', 'STORE_MANAGER', 'CASHIER']);
const SUPERVISORS = new Set(['ADMIN', 'STORE_MANAGER']);

export function usePosOfflineCash({ store, staffProfile, online }: Options) {
  const uid = staffProfile?.uid ?? '';
  const role = staffProfile?.role ?? '';
  const storeId = store?.id ?? '';
  const scope = uid && auth.currentUser?.uid === uid && staffProfile?.isActive === true
    && CASH_ROLES.has(role) && validPosStoreId(storeId) && store?.isActive === true
    && store.posEnabled !== false && assignedStoreIdentifiers(staffProfile).includes(storeId)
    ? JSON.stringify([uid, storeId, role]) : '';
  const context = useRef({ scope: '', online: false });
  const readVersion = useRef(0);
  const syncInFlight = useRef(false);
  const commandInFlight = useRef(false);
  const [view, setView] = useState(EMPTY_VIEW);
  const [syncScope, setSyncScope] = useState('');
  const [prepareScope, setPrepareScope] = useState('');
  const [message, setMessage] = useState({ scope: '', text: '' });

  useLayoutEffect(() => {
    context.current = { scope, online };
    return () => { context.current = { scope: '', online: false }; };
  }, [scope, online]);

  const isCurrent = useCallback(() => Boolean(scope) && context.current.scope === scope && auth.currentUser?.uid === uid, [scope, uid]);
  const canCallServer = useCallback(() => isCurrent() && context.current.online && navigator.onLine, [isCurrent]);
  const showError = useCallback((error: unknown, fallback: string) => {
    if (isCurrent()) setMessage({ scope, text: error instanceof Error ? error.message : fallback });
  }, [isCurrent, scope]);

  const refresh = useCallback(async () => {
    if (!isCurrent()) return;
    const version = ++readVersion.current;
    const currentRead = () => isCurrent() && version === readVersion.current;
    try {
      const [cached, device, journal] = await Promise.all([
        getMeta('snapshot') as Promise<Snapshot | undefined>,
        getMeta('device'),
        readEntries(),
      ]);
      if (!currentRead()) return;
      const hasDevice = Boolean(device?.id && device.privateKey);
      let snapshot = cached && hasDevice && cached.uid === uid && cached.storeId === storeId
        && cached.deviceId === device.id && cached.role === role && Array.isArray(cached.menu)
        && Array.isArray(cached.tables) && supportedOfflineSnapshot(cached) ? cached : null;
      if(snapshot) {
        try {await verifySnapshotForRead(snapshot);}
        catch {snapshot=null;}
      }
      const supervisor = Boolean(snapshot) && SUPERVISORS.has(role);
      const entries = journal.filter(entry => entry.payload?.storeId === storeId
        && (entry.payload.uid === uid || (supervisor && entry.payload.deviceId === device.id)));

      let valid = false;
      let reason = !hasDevice ? 'This device is not enrolled for offline billing.' : !snapshot
        ? 'No signed session for this staff member and store is saved.' : 'Reauthorize this till online.';
      if (snapshot && document.visibilityState !== 'hidden') {
        try {
          await usable(snapshot);
          valid = true;
          reason = '';
        } catch(error) {reason = error instanceof Error ? error.message : 'Offline authorization could not be verified.';}
      }
      if (currentRead()) {
        setView({ scope, snapshot, entries, hasDevice, pendingDeviceWork:journal.some(e=>e.status!=='SYNCED'), reason, valid: valid && document.visibilityState !== 'hidden' });
      }
    } catch {
      if (currentRead()) {
        setView(previous => ({ ...(previous.scope === scope ? previous : EMPTY_VIEW), scope, valid: false, hasDevice: false, reason: 'The local journal could not be read.' }));
        setMessage({ scope, text: 'Cash journal access is temporarily unavailable on this device.' });
      }
    }
  }, [isCurrent, role, scope, storeId, uid]);

  const sync = useCallback(async () => {
    if (!canCallServer() || syncInFlight.current) return;
    syncInFlight.current = true;
    let endOperation: (() => void) | undefined;
    try {
      const device = await getMeta('device');
      if (!canCallServer() || !device?.id || !device.privateKey) return;
      const journal = await readEntries();
      if (!canCallServer() || !journal.some(entry => entry.payload?.uid === uid
        && entry.payload.storeId === storeId && entry.payload.deviceId === device.id
        && (entry.status === 'PENDING' || entry.status === 'UNCERTAIN'))) return;
      setSyncScope(scope);
      endOperation = beginCriticalOperation();
      await synchronize(() => { void refresh(); },storeId);
    } catch (error) {
      showError(error, 'Cash bills are still in the journal. Synchronization will retry when connected.');
    } finally {
      endOperation?.();
      syncInFlight.current = false;
      setSyncScope('');
      await refresh();
    }
  }, [canCallServer, refresh, scope, showError, storeId, uid]);

  useEffect(() => {
    if (!scope) return;
    const checkVisibility = () => {
      if (document.visibilityState === 'hidden') {
        ++readVersion.current;
        setView(previous => previous.scope === scope ? { ...previous, valid: false } : previous);
      } else {
        void refresh();
      }
    };
    void refresh();
    const validityTimer = window.setInterval(() => { void refresh(); }, 5000);
    document.addEventListener('visibilitychange', checkVisibility);
    return () => {
      window.clearInterval(validityTimer);
      document.removeEventListener('visibilitychange', checkVisibility);
      ++readVersion.current;
    };
  }, [online, refresh, scope]);

  useEffect(() => {
    if (!scope || !online) return;
    void sync();
    const syncTimer = window.setInterval(() => { void sync(); }, 15000);
    return () => window.clearInterval(syncTimer);
  }, [online, scope, sync]);

  const prepare = useCallback(async () => {
    if (!canCallServer() || commandInFlight.current) return;
    commandInFlight.current = true;
    const endOperation = beginCriticalOperation();
    setPrepareScope(scope);
    setMessage({ scope, text: '' });
    setView(previous => previous.scope === scope ? { ...previous, valid: false } : previous);
    try {
      const device = await getMeta('device');
      if (!canCallServer()) return;
      if (!device?.id || !device.privateKey) throw Error('This device has no existing offline Cash setup.');
      if((await readEntries()).some(e=>e.status!=='SYNCED'))throw Error('Synchronize or reconcile this till’s saved work before refreshing its authorization.');
      const snapshot = await prepareSession(storeId);
      if (canCallServer()) void prepareLocalPrint(snapshot).catch(() => false);
    } catch (error) {
      showError(error, 'Offline Cash preparation failed.');
    } finally {
      endOperation();
      commandInFlight.current = false;
      setPrepareScope('');
      await refresh();
    }
  }, [canCallServer, refresh, scope, showError, storeId]);

  const lastPreparation = useRef({scope:'',time:0});
  useEffect(() => {
    if (tillRecoveryOnly || !scope || !online || view.scope !== scope || !view.hasDevice || commandInFlight.current
        || view.pendingDeviceWork) return;
    const now=Date.now();
    const interval=view.valid ? 5*60_000 : 60_000;
    if (lastPreparation.current.scope===scope && now-lastPreparation.current.time<interval) return;
    lastPreparation.current={scope,time:now};
    void prepare();
  }, [scope, online, view, prepare]);

  const currentView = scope && view.scope === scope ? view : EMPTY_VIEW;
  useUpdateBlocker(Boolean(scope && (view.scope!==scope || view.pendingDeviceWork || syncScope || prepareScope)));
  const tableRepository = useMemo(() => projectTables(currentView.snapshot, currentView.entries),
    [currentView.snapshot,currentView.entries]);
  const reconcile = async (entry: Entry, reason: string) => {
    const selected = currentView.entries.find(row => row.id === entry.id && row.status === 'CONFLICT');
    if (!canCallServer() || !SUPERVISORS.has(role) || !selected || !reason.trim() || commandInFlight.current) return;
    commandInFlight.current = true;
    const endOperation = beginCriticalOperation();
    setMessage({ scope, text: '' });
    try {
      const device = await getMeta('device');
      if (!canCallServer()) return;
      if (!device?.privateKey || device.id !== selected.payload.deviceId) throw Error('Use the original offline Cash device to reconcile this bill.');
      await reconcileEntry(selected, reason.trim());
    } catch (error) {
      showError(error, 'Reconciliation is still required. The original Cash bill remains in the journal.');
    } finally {
      endOperation();
      commandInFlight.current = false;
      await refresh();
    }
  };

  return {
    snapshot: currentView.snapshot,
    tableRepository,
    lastSuccessfulSync: currentView.entries.reduce((latest,e)=>e.status==='SYNCED'?Math.max(latest,e.syncedAt||0):latest,currentView.snapshot?.issuedAt || 0) || null,
    tableReady: currentView.valid && hasTableAuthority(currentView.snapshot) && currentView.snapshot?.tableBoard?.enabled!==false,
    unavailableReason: !scope ? 'Offline billing is unavailable for this staff member or store.'
      : currentView.reason || (hasTableAuthority(currentView.snapshot) ? '' : 'A complete authorized table snapshot is unavailable.'),
    sessionReady: currentView.valid,
    cashAvailable: !online && currentView.valid,
    entries: currentView.entries,
    syncing: Boolean(scope && syncScope === scope),
    sync,
    canPrepare: !tillRecoveryOnly && online && currentView.hasDevice,
    prepare,
    preparing: Boolean(scope && prepareScope === scope),
    reconcile,
    notice: scope && message.scope === scope ? message.text : '',
    refresh,
  };
}
