import { collection, getDocsFromServer, query, type Firestore } from 'firebase/firestore';

// Preserve the existing global reads; POS applies eligibility and selected-store filtering.
export function loadPosMenuSources(db: Firestore) {
  return Promise.all([
    getDocsFromServer(query(collection(db, 'finishedGoods'))),
    getDocsFromServer(query(collection(db, 'addOnGroups'))),
  ]);
}
