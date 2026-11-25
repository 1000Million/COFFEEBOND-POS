import React, { useEffect, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { Link } from 'react-router-dom';
import { db, functions } from '../../lib/firebase';
import type { Store } from '../../types';
import { gstSourceStore, storeGstTreatment, type GstMode, type GstTreatment } from '../../lib/storeGstTreatment';

const saveGst = httpsCallable<{
  storeId: string; mode: GstMode; rate: number | null; expectedRevision: number; operationId: string;
}, { storeId: string; gstTreatment: GstTreatment }>(functions, 'setStoreGstTreatment');

export default function StoreGstSettings() {
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState('');
  const [mode, setMode] = useState<GstMode>('ITEM_WISE');
  const [rate, setRate] = useState('');
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<{ fingerprint: string; operationId: string } | null>(null);
  const load = async () => {
    const snapshot = await getDocs(collection(db, 'stores'));
    setStores(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Store)));
  };
  useEffect(() => { load().catch(() => setError('Unable to load stores.')); }, []);
  useEffect(() => {
    const value = storeGstTreatment(gstSourceStore(stores.find(store => store.id === storeId), stores));
    setMode(value.mode); setRate(value.rate == null ? '' : String(value.rate)); setRevision(value.revision);
    setPending(null); setError(''); setNotice('');
  }, [storeId, stores]);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!storeId || busy) return;
    const percent = mode === 'STORE_WIDE' ? Number(rate) : null;
    if (mode === 'STORE_WIDE' && (!rate.trim() || !Number.isFinite(percent) || percent! <= 0 || percent! > 100)) {
      setError('Enter a percentage greater than 0 and no more than 100. For zero tax, select NO GST.'); return;
    }
    const fingerprint = JSON.stringify([storeId, mode, percent, revision]);
    const operationId = pending?.fingerprint === fingerprint ? pending.operationId : crypto.randomUUID();
    setPending({ fingerprint, operationId }); setBusy(true); setError(''); setNotice('');
    try {
      const result = await saveGst({ storeId, mode, rate: percent, expectedRevision: revision, operationId });
      setRevision(result.data.gstTreatment.revision); setPending(null);
      setNotice('GST settings saved. New checkouts use this treatment. Completed bills and paid orders are unchanged.');
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : 'GST settings could not be saved. Retry the same save safely, or reload current settings.');
    } finally { setBusy(false); }
  };
  return <main className="mx-auto w-full max-w-2xl space-y-6 p-4">
    <Link to="/admin/stores" className="text-sm underline">Stores</Link>
    <div><h1 className="text-2xl font-bold text-[#3e2723]">GST Settings</h1><p className="mt-2 text-sm text-neutral-600">Choose one treatment for this store. Legal entity and registration details are maintained separately.</p></div>
    <form onSubmit={save} className="space-y-5 rounded-2xl border bg-white p-5">
      <label className="block">Store<select required disabled={busy} aria-label="GST store" value={storeId} onChange={e => setStoreId(e.target.value)} className="mt-1 block w-full rounded border p-3"><option value="">Select store</option>{stores.map(store => <option key={store.id} value={store.id}>{store.displayName || store.name}</option>)}</select></label>
      {stores.find(store => store.id === storeId)?.legalAndGstSourceStoreId && <p role="note" className="rounded border border-amber-200 bg-amber-50 p-3 text-sm">This store uses the legal/GST settings of {gstSourceStore(stores.find(store => store.id === storeId), stores)?.name}. Saving changes their shared GST treatment; the legal entity mapping remains unchanged.</p>}
      <label className="block">GST treatment<select disabled={!storeId || busy} aria-label="GST treatment" value={mode} onChange={e => setMode(e.target.value as GstMode)} className="mt-1 block w-full rounded border p-3"><option value="NO_GST">NO GST</option><option value="ITEM_WISE">ITEM-WISE GST</option><option value="STORE_WIDE">STORE-WIDE GST</option></select></label>
      <p className="text-sm text-neutral-600">{mode === 'NO_GST' ? 'Exactly 0% on every item and add-on, including items with a configured rate.' : mode === 'STORE_WIDE' ? 'One percentage overrides item and add-on rates in this store.' : 'Existing item rates take priority, followed by store settings and the application default.'}</p>
      {mode === 'STORE_WIDE' && <label className="block">Store-wide GST (%)<input required disabled={busy} aria-label="Store-wide GST percentage" type="number" min="0" max="100" step="any" value={rate} onChange={e => setRate(e.target.value)} className="mt-1 block w-full rounded border p-3" /></label>}
      <p className="text-sm text-neutral-600">Changes apply to new financial authorizations. Open checkouts may need review; held bills stay saved and paid online orders keep their original totals.</p>
      {error && <div role="alert" className="text-red-700">{error} <button type="button" disabled={busy} className="underline" onClick={() => load().catch(() => setError('Unable to reload settings.'))}>Reload current settings</button></div>}
      {notice && <p role="status" className="text-green-800">{notice}</p>}
      <button type="submit" disabled={!storeId || busy} className="rounded-lg bg-[#3e2723] px-6 py-3 text-white disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
    </form>
  </main>;
}
