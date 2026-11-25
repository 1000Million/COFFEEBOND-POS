import { collection, doc, getDoc, getDocs, query, where, type Firestore } from 'firebase/firestore';
import type { Store } from '../../types';

// Role selection and accessiblePosStores filtering remain with the POS caller.
// Cached or partial records still support explicit selection and saved work,
// but cannot establish that a store is the sole or unambiguous nearby choice.
export async function loadPosStoreRecords(db: Firestore, assignedStoreIds?: string[]) {
  if (assignedStoreIds === undefined) {
    const snapshot = await getDocs(collection(db, 'stores'));
    return { stores: snapshot.docs.map(d => ({ ...d.data(), id: d.id } as Store)), verified: !snapshot.metadata.fromCache };
  }
  const records = await Promise.all(assignedStoreIds.map(id => getDoc(doc(db, 'stores', id)).catch(() => null)));
  return {
    stores: records.flatMap(d => d?.exists() ? [{ ...d.data(), id: d.id } as Store] : []),
    verified: records.every(snapshot => snapshot !== null && !snapshot.metadata.fromCache),
  };
}

// Only Admin callers omit assignments. Report reads must surface permission errors.
export async function loadActiveReportStoreRecords(db: Firestore, assignedStoreIds?: string[]): Promise<Store[]> {
  if (assignedStoreIds === undefined) {
    const snapshot = await getDocs(query(collection(db, 'stores'), where('isActive', '==', true)));
    return snapshot.docs.map(snap => ({ ...snap.data(), id: snap.id } as Store));
  }
  const storeIds = [...new Set(assignedStoreIds.filter(id => typeof id === 'string' && id.length > 0 && !id.includes('/')))];
  const snapshots = await Promise.all(storeIds.map(id => getDoc(doc(db, 'stores', id))));
  return snapshots
    .filter(snap => snap.exists() && snap.data().isActive === true)
    .map(snap => ({ ...snap.data(), id: snap.id } as Store));
}
