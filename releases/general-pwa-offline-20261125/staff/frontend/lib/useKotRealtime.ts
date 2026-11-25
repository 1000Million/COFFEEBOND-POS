import { useEffect, useRef, useState } from 'react';
import { collection, doc, getDoc, getDocs, getDocsFromServer, onSnapshot, query, where } from 'firebase/firestore';
import type { Query } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { db } from './firebase';
import { accessiblePosStores, assignedStoreIdentifiers } from './posStoreAccess';
import { createKotRealtimeFeed, KOT_RESYNC_INTERVAL_MS, type KotReadGate } from './kotRealtimeFeed';
import type { KotItem, Store } from '../types';

export function buildKotReadQuery(storeId: string, view: 'ACTIVE' | 'READY', station: string | null) {
  return query(collection(db, 'kotItems'),
    where('storeId', '==', storeId),
    ...(station ? [where('station', '==', station)] : []),
    where('status', 'in', view === 'ACTIVE' ? ['PENDING', 'PREPARING'] : ['READY', 'SERVED']));
}

export function useKotRealtime(view: 'ACTIVE' | 'READY', activeStation?: 'BARISTA' | 'KITCHEN') {
  const { staffProfile, firebaseUser, authStatus } = useAuth();
  // Stable authorization primitives; cosmetic profile changes don't churn listeners.
  const authScope = authStatus === 'ready' && firebaseUser && staffProfile && firebaseUser.uid === staffProfile.uid
    ? JSON.stringify({ uid: firebaseUser.uid, role: staffProfile.role,
      assignments: assignedStoreIdentifiers(staffProfile).sort() }) : '';
  const [storeState, setStoreState] = useState<{ scope: string; stores: Store[]; error: string; loading: boolean }>(
    { scope: '', stores: [], error: '', loading: false });
  const [feedState, setFeedState] = useState<{ scope: string; items: KotItem[]; loading: boolean; error: string }>(
    { scope: '', items: [], loading: false, error: '' });
  const readGate = useRef<KotReadGate>({ busy: false });
  const storeReadGate = useRef(false);
  const resyncRef = useRef<() => Promise<void>>(() => Promise.resolve());

  useEffect(() => {
    let active = true;
    if (!authScope) return;
    const { role, assignments } = JSON.parse(authScope) as { role: string; assignments: string[] };
    setStoreState({ scope: authScope, stores: [], error: '', loading: true });
    let retryNeeded = true;
    const load = async () => {
      if (!active || storeReadGate.current) return;
      storeReadGate.current = true;
      try {
        let fetched: Store[];
        if (role === 'ADMIN') {
          fetched = (await getDocs(collection(db, 'stores'))).docs.map(d => ({ ...d.data(), id: d.id } as Store));
        } else {
          const results = await Promise.allSettled(assignments.map(id => getDoc(doc(db, 'stores', id))));
          const failed = results.find(result => result.status === 'rejected');
          if (failed?.status === 'rejected') throw failed.reason;
          fetched = results.flatMap(result => result.status === 'fulfilled' && result.value.exists()
            ? [{ ...result.value.data(), id: result.value.id } as Store] : []);
        }
        const stores = accessiblePosStores(fetched, { role, storeIds: assignments });
        if (active) {
          retryNeeded = false;
          setStoreState({ scope: authScope, stores, error: '', loading: false });
        }
      } catch {
        if (active) setStoreState({ scope: authScope, stores: [], error: 'Could not load authorized ticket stores. Retrying automatically.', loading: false });
      } finally { storeReadGate.current = false; }
    };
    void load();
    const retryTimer = setInterval(() => { if (retryNeeded) void load(); }, KOT_RESYNC_INTERVAL_MS);
    return () => { active = false; clearInterval(retryTimer); };
  }, [authScope]);

  const stores = storeState.scope === authScope && authScope ? storeState.stores : [];
  const storeIds = [...new Set(stores.map(store => store.id))].sort();
  const station = view === 'ACTIVE' ? activeStation || null
    : staffProfile?.role === 'BARISTA' ? 'BARISTA' : staffProfile?.role === 'KITCHEN' ? 'KITCHEN' : null;
  const feedScope = authScope ? JSON.stringify([authScope, view, station, storeIds]) : '';

  useEffect(() => {
    resyncRef.current = () => Promise.resolve();
    if (!feedScope) return;
    const [, scopeView, scopeStation, scopeStoreIds] = JSON.parse(feedScope) as [string, 'ACTIVE' | 'READY', string | null, string[]];
    const feed = createKotRealtimeFeed<Query, KotItem>({
      queries: scopeStoreIds.map(storeId => ({ storeId, query: buildKotReadQuery(storeId, scopeView, scopeStation) })),
      subscribe: (readQuery, next, error) => onSnapshot(readQuery, { includeMetadataChanges: true }, snapshot => {
        // Preserve production's acknowledgement rule: an optimistic write
        // must not silence a pending alert before the server confirms it.
        if (scopeView === 'ACTIVE' && snapshot.metadata.hasPendingWrites) return;
        next(snapshot.docs.map(d => ({ ...d.data(), id: d.id } as KotItem)));
      }, error),
      readServer: async readQuery => {
        const snapshot = await getDocsFromServer(readQuery);
        if (scopeView === 'ACTIVE' && snapshot.metadata.hasPendingWrites) {
          throw { code: 'unavailable' };
        }
        return snapshot.docs.map(d => ({ ...d.data(), id: d.id } as KotItem));
      },
      readGate: readGate.current,
      publish: (items, state) => setFeedState({ scope: feedScope, items, ...state }),
    });
    resyncRef.current = feed.resync;
    return () => { feed.dispose(); resyncRef.current = () => Promise.resolve(); };
  }, [feedScope]);

  const current = feedState.scope === feedScope && authScope ? feedState : null;
  const storeError = storeState.scope === authScope ? storeState.error : '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const items = (current?.items || []).filter(item => view === 'ACTIVE' || item.status === 'READY'
    || (item.status === 'SERVED' && (item.servedAt?.toDate?.().getTime() || 0) >= today.getTime()));
  return { stores, items,
    loading: Boolean(authScope) && (storeState.scope !== authScope || storeState.loading || !current || current.loading),
    error: storeError || current?.error || '', resync: () => resyncRef.current() };
}
