import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, getDoc, getDocs, query, runTransaction, serverTimestamp } from 'firebase/firestore';
import { AlertTriangle, ImageOff, Info, Layers, Search } from 'lucide-react';
import { db } from '../../lib/firebase';
import { useAuth } from '../../contexts/AuthContext';
import type { Store } from '../../types';
import type { AddOnGroup, FinishedGood, PrepItem, RawIngredient } from '../../types/menu-management';
import {
  STORE_ITEM_CONFIG_COLLECTION,
  resolveStoreItem,
  storeItemConfigDocId,
  type StoreItemConfig,
} from '../../lib/storeItemConfig';
import {
  buildOverridePublishPlan,
  buildOverrideWritePlan,
  buildResolvedComparison,
  assignedStoreCount,
  canonicalDataToken,
  draftFromConfig,
  emptyDraft,
  overrideIntentToken,
  snapshotRevisionToken,
  validateOverrideDraft,
  type OverrideDraft,
  type OverrideMode,
} from '../../lib/storeItemConfigAdmin';


function isAdminOnlyRole(role?: string | null): boolean {
  return role === 'ADMIN';
}

function money(value: number): string {
  return `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function storeIdsOf(item: FinishedGood): string[] {
  return Array.isArray(item.availableStoreIds) ? item.availableStoreIds.filter(Boolean) : [];
}

function isAssignedToStore(item: FinishedGood, storeId: string): boolean {
  const assignedStoreIds = storeIdsOf(item);
  return assignedStoreIds.length === 0 || assignedStoreIds.includes(storeId);
}

type ConfigsByKey = Map<string, StoreItemConfig>;
const keyOf = storeItemConfigDocId;

export default function GlobalItems() {
  const { staffProfile } = useAuth();
  const isAdmin = isAdminOnlyRole(staffProfile?.role) && staffProfile?.isActive === true;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [items, setItems] = useState<FinishedGood[]>([]);
  const [stores, setStores] = useState<(Store & { id: string })[]>([]);
  const [configs, setConfigs] = useState<ConfigsByKey>(new Map());
  const [rawIngredients, setRawIngredients] = useState<RawIngredient[]>([]);
  const [prepItems, setPrepItems] = useState<PrepItem[]>([]);
  const [addOnGroups, setAddOnGroups] = useState<AddOnGroup[]>([]);

  const [search, setSearch] = useState('');
  const [selectedCode, setSelectedCode] = useState('');
  const [editingStoreId, setEditingStoreId] = useState('');
  const [draft, setDraft] = useState<OverrideDraft>(emptyDraft());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isAdmin) { setLoading(false); return; }
    let active = true;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const [itemSnap, storeSnap, configSnap, rawSnap, prepSnap, addOnSnap] = await Promise.all([
          getDocs(collection(db, 'finishedGoods')),
          getDocs(query(collection(db, 'stores'))),
          getDocs(query(collection(db, STORE_ITEM_CONFIG_COLLECTION))),
          getDocs(query(collection(db, 'rawIngredients'))),
          getDocs(query(collection(db, 'prepItems'))),
          getDocs(query(collection(db, 'addOnGroups'))),
        ]);
        if (!active) return;
        setItems(itemSnap.docs
          .map((d) => {
            const data = d.data() as Omit<FinishedGood, 'id'>;
            return {
              id: d.id,
              ...data,
              name: String(data.name || data.displayName || data.code || d.id),
            };
          })
          .sort((a, b) => String(a.name || a.displayName || a.code).localeCompare(String(b.name || b.displayName || b.code))));
        setStores(storeSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Store, 'id'>) })));
        const map: ConfigsByKey = new Map();
        configSnap.docs.forEach((d) => {
          const data = { id: d.id, ...(d.data() as Omit<StoreItemConfig, 'id'>) };
          if (data.storeId && data.itemCode) map.set(keyOf(data.storeId, data.itemCode), data);
        });
        setConfigs(map);
        setRawIngredients(rawSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<RawIngredient, 'id'>) })));
        setPrepItems(prepSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<PrepItem, 'id'>) })));
        setAddOnGroups(addOnSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<AddOnGroup, 'id'>) })));
      } catch (e: unknown) {
        if (active) setError(e instanceof Error ? e.message : 'Unable to load the global catalogue.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [isAdmin]);

  const overrideCountByCode = useMemo(() => {
    const counts = new Map<string, number>();
    configs.forEach((config) => {
      counts.set(config.itemCode, (counts.get(config.itemCode) || 0) + 1);
    });
    return counts;
  }, [configs]);

  const filteredItems = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) => [item.name, item.displayName, item.code, item.posCategoryName]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(needle)));
  }, [items, search]);

  const selectedItem = useMemo(
    () => items.find((item) => item.code === selectedCode) || null,
    [items, selectedCode],
  );

  const storesById = useMemo(
    () => new Map(stores.map((store) => [store.id, store])),
    [stores],
  );

  const assignedStores = useMemo(() => {
    if (!selectedItem) return [];
    const assignedStoreIds = storeIdsOf(selectedItem);
    const rows = assignedStoreIds.length === 0
      ? stores
      : assignedStoreIds.map((storeId) => storesById.get(storeId)
        || ({ id: storeId, code: storeId, name: storeId } as Store & { id: string }));
    return rows
      .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
  }, [selectedItem, stores, storesById]);

  const unassignedStores = useMemo(() => {
    if (!selectedItem) return [];
    return stores.filter((store) => !isAssignedToStore(selectedItem, store.id));
  }, [selectedItem, stores]);

  const existingConfig = selectedItem && editingStoreId
    ? configs.get(keyOf(editingStoreId, selectedItem.code)) || null
    : null;

  const isAssigned = !!selectedItem && !!editingStoreId && isAssignedToStore(selectedItem, editingStoreId);
  const issues = useMemo(
    () => (editingStoreId ? validateOverrideDraft(draft, { isAssigned }) : []),
    [draft, editingStoreId, isAssigned],
  );

  const comparison = useMemo(() => {
    if (!selectedItem || !editingStoreId) return [];
    return buildResolvedComparison(selectedItem, existingConfig, draft, editingStoreId);
  }, [selectedItem, editingStoreId, existingConfig, draft]);

  const plannedResolved = useMemo(() => {
    if (!selectedItem || !editingStoreId) return null;
    const plan = buildOverrideWritePlan({ storeId: editingStoreId, itemCode: selectedItem.code, draft, existing: existingConfig, updatedBy: '' });
    return resolveStoreItem(selectedItem, plan.action === 'SET' ? plan.data : null);
  }, [selectedItem, editingStoreId, draft, existingConfig]);

  const previewPublication = useMemo(() => {
    if (!selectedItem || !editingStoreId || issues.length > 0) return null;
    const store = storesById.get(editingStoreId);
    if (!store || !String(store.code || '').trim()) return null;
    try {
      return buildOverridePublishPlan({
        store,
        itemCode: selectedItem.code,
        draft,
        existing: existingConfig,
        storeConfigs: Array.from(configs.values()).filter((config) => config.storeId === editingStoreId),
        finishedGoods: items,
        rawIngredients,
        prepItems,
        addOnGroups,
        updatedBy: staffProfile?.uid || '',
      });
    } catch {
      return null;
    }
  }, [addOnGroups, configs, draft, editingStoreId, existingConfig, items, issues.length, prepItems, rawIngredients, selectedItem, staffProfile?.uid, storesById]);

  const customerSnapshotPreview = useMemo(() => {
    if (!selectedItem || !plannedResolved || !previewPublication) return null;
    if (plannedResolved.menuVisible === false) {
      return { state: 'HIDDEN', detail: 'This item will be omitted from the customer menu.' };
    }
    const availability = previewPublication.snapshot.items[selectedItem.code];
    const menuItem = previewPublication.snapshot.menuItems[selectedItem.code];
    if (!availability || !menuItem) {
      return {
        state: 'NOT PUBLISHED',
        detail: 'The canonical customer snapshot will omit this item because a global eligibility or store-assignment rule is not satisfied.',
      };
    }
    if (!availability.available) {
      return {
        state: 'UNAVAILABLE',
        detail: availability.publicMessage || 'The canonical customer snapshot will show this item as currently unavailable.',
      };
    }
    return { state: 'AVAILABLE', detail: 'The canonical customer snapshot will publish this item as available.' };
  }, [plannedResolved, previewPublication, selectedItem]);

  const selectStore = (storeId: string) => {
    if (!selectedItem) return;
    setEditingStoreId(storeId);
    setDraft(draftFromConfig(configs.get(keyOf(storeId, selectedItem.code))));
    setMessage('');
    setError('');
  };

  const selectItem = (code: string) => {
    setSelectedCode(code);
    setEditingStoreId('');
    setDraft(emptyDraft());
    setMessage('');
    setError('');
  };

  const save = async () => {
    if (!isAdmin || !selectedItem || !editingStoreId) return;
    if (issues.length > 0) { setError(issues.map((i) => i.message).join(' ')); return; }

    setSaving(true);
    setError('');
    setMessage('');
    try {
      // Re-read all canonical sources at save time. Cached page state must never
      // replace a newer complete customer-menu snapshot.
      const freshStoreSnapshot = await getDoc(doc(db, 'stores', editingStoreId));
      if (!freshStoreSnapshot.exists()) throw new Error('That store no longer exists. Reload and try again.');
      const store = { id: freshStoreSnapshot.id, ...(freshStoreSnapshot.data() as Omit<Store, 'id'>) };
      const storeCode = String(store.code || '').trim();
      if (!storeCode) throw new Error('That store has no store code, so its customer menu cannot be published.');
      const snapshotRef = doc(db, 'publicMenuAvailability', storeCode);
      const [itemSnap, configSnap, rawSnap, prepSnap, addOnSnap, publicSnapshot] = await Promise.all([
        getDocs(collection(db, 'finishedGoods')),
        getDocs(query(collection(db, STORE_ITEM_CONFIG_COLLECTION))),
        getDocs(collection(db, 'rawIngredients')),
        getDocs(collection(db, 'prepItems')),
        getDocs(collection(db, 'addOnGroups')),
        getDoc(snapshotRef),
      ]);
      const freshItems = itemSnap.docs
        .map((entry) => {
          const data = entry.data() as Omit<FinishedGood, 'id'>;
          return {
            id: entry.id,
            ...data,
            name: String(data.name || data.displayName || data.code || entry.id),
          };
        })
        .sort((a, b) => String(a.name || a.displayName || a.code).localeCompare(String(b.name || b.displayName || b.code)));
      const freshSelectedItem = freshItems.find((item) => item.code === selectedItem.code);
      if (!freshSelectedItem) throw new Error('That item changed or was removed. Reload and try again.');
      if (canonicalDataToken(freshSelectedItem) !== canonicalDataToken(selectedItem)) {
        throw new Error('The global item changed while you were editing. Reload and review the current values.');
      }
      const freshIssues = validateOverrideDraft(draft, {
        isAssigned: isAssignedToStore(freshSelectedItem, editingStoreId),
      });
      if (freshIssues.length > 0) {
        throw new Error(freshIssues.map((issue) => issue.message).join(' '));
      }
      const freshSelectedSnapshot = itemSnap.docs.find((entry) => entry.id === freshSelectedItem.id);
      if (!freshSelectedSnapshot) throw new Error('The global item identity changed. Reload and try again.');
      const sourceItemRef = doc(db, 'finishedGoods', freshSelectedSnapshot.id);
      const expectedSourceItemToken = canonicalDataToken(freshSelectedSnapshot.data());
      const expectedStoreToken = canonicalDataToken(freshStoreSnapshot.data());

      const freshConfigMap: ConfigsByKey = new Map();
      configSnap.docs.forEach((entry) => {
        const data = { id: entry.id, ...(entry.data() as Omit<StoreItemConfig, 'id'>) };
        if (data.storeId && data.itemCode) freshConfigMap.set(keyOf(data.storeId, data.itemCode), data);
      });
      const freshExisting = freshConfigMap.get(keyOf(editingStoreId, freshSelectedItem.code)) || null;
      if (overrideIntentToken(freshExisting) !== overrideIntentToken(existingConfig)) {
        throw new Error('This override changed while you were editing. Reload and review the latest values.');
      }

      const freshRawIngredients = rawSnap.docs.map((entry) => ({ id: entry.id, ...(entry.data() as Omit<RawIngredient, 'id'>) }));
      const freshPrepItems = prepSnap.docs.map((entry) => ({ id: entry.id, ...(entry.data() as Omit<PrepItem, 'id'>) }));
      const freshAddOnGroups = addOnSnap.docs.map((entry) => ({ id: entry.id, ...(entry.data() as Omit<AddOnGroup, 'id'>) }));
      const storeConfigs = Array.from(freshConfigMap.values()).filter((config) => config.storeId === editingStoreId);
      const writeTimestamp = serverTimestamp();
      const publish = buildOverridePublishPlan({
        store,
        itemCode: freshSelectedItem.code,
        draft,
        existing: freshExisting,
        storeConfigs,
        finishedGoods: freshItems,
        rawIngredients: freshRawIngredients,
        prepItems: freshPrepItems,
        addOnGroups: freshAddOnGroups,
        updatedBy: staffProfile?.uid || '',
        updatedAt: writeTimestamp,
        createdAt: freshExisting?.createdAt ?? writeTimestamp,
      });

      if (publish.overridePlan.action === 'NONE') {
        setMessage('Nothing to publish — every field already inherits the global value.');
        setSaving(false);
        return;
      }

      const overrideRef = doc(db, STORE_ITEM_CONFIG_COLLECTION, publish.overridePlan.docId);
      const expectedSnapshotRevision = snapshotRevisionToken(
        publicSnapshot.exists() ? publicSnapshot.data() : null,
      );
      const publicationRevision = globalThis.crypto?.randomUUID?.()
        || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      // The revision precondition makes a concurrent complete-snapshot writer
      // fail closed. Firestore retries transactions after a conflicting write;
      // the retry then sees the new revision and asks the Admin to refresh.
      await runTransaction(db, async (transaction) => {
        const [livePublicSnapshot, liveOverrideSnapshot, liveSourceItem, liveStore] = await Promise.all([
          transaction.get(snapshotRef),
          transaction.get(overrideRef),
          transaction.get(sourceItemRef),
          transaction.get(freshStoreSnapshot.ref),
        ]);
        if (!liveSourceItem.exists() || canonicalDataToken(liveSourceItem.data()) !== expectedSourceItemToken) {
          throw new Error('The global item changed while publishing. Nothing was published; reload and review it.');
        }
        if (!liveStore.exists() || canonicalDataToken(liveStore.data()) !== expectedStoreToken) {
          throw new Error('The store changed while publishing. Nothing was published; reload and review it.');
        }
        const liveRevision = snapshotRevisionToken(
          livePublicSnapshot.exists() ? livePublicSnapshot.data() : null,
        );
        if (liveRevision !== expectedSnapshotRevision) {
          throw new Error('This store menu changed while publishing. Reload and try again.');
        }
        const liveOverride = liveOverrideSnapshot.exists()
          ? { id: liveOverrideSnapshot.id, ...(liveOverrideSnapshot.data() as Omit<StoreItemConfig, 'id'>) }
          : null;
        if (overrideIntentToken(liveOverride) !== overrideIntentToken(freshExisting)) {
          throw new Error('This override changed while publishing. Reload and review it.');
        }
        if (publish.overridePlan.action === 'SET') transaction.set(overrideRef, publish.overridePlan.data);
        else transaction.delete(overrideRef);
        transaction.set(snapshotRef, {
          ...publish.snapshot,
          publicationRevision,
          updatedAt: writeTimestamp,
          updatedBy: staffProfile?.uid || '',
          updatedByName: staffProfile?.displayName || staffProfile?.email || 'Admin',
        });
      });

      const next = new Map(freshConfigMap);
      if (publish.overridePlan.action === 'DELETE') {
        next.delete(keyOf(editingStoreId, freshSelectedItem.code));
        setMessage(`Override removed and published. ${store.name || store.id} is back on the global values, and its customer menu was rebuilt in the same save.`);
      } else {
        next.set(keyOf(editingStoreId, freshSelectedItem.code), { id: publish.overridePlan.docId, ...publish.overridePlan.data });
        setMessage(`Override published. The complete customer menu for ${store.name || store.id} was rebuilt in the same save (${publish.snapshot.itemCount} items live).`);
      }
      setItems(freshItems);
      setConfigs(next);
      setRawIngredients(freshRawIngredients);
      setPrepItems(freshPrepItems);
      setAddOnGroups(freshAddOnGroups);
    } catch (e: unknown) {
      setError(e instanceof Error ? `Nothing was published. ${e.message}` : 'Nothing was published. The override could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  if (!isAdmin) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="bg-white border border-neutral-200 rounded-2xl p-6">
          <h1 className="text-xl font-black text-[#3e2723] mb-2">Admin access required</h1>
          <p className="text-sm text-neutral-600">Only an active Admin can manage global items and store overrides.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-[1400px] mx-auto">
      <header className="mb-5">
        <p className="text-xs font-black uppercase tracking-widest text-amber-700">Global catalogue</p>
        <h1 className="text-2xl md:text-3xl font-black text-[#3e2723]">Global Items</h1>
        <p className="text-sm text-neutral-600 mt-1">
          One shared product definition per item. Stores inherit every value unless you set an explicit override.
        </p>
      </header>

      {error && <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">{error}</div>}
      {message && <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">{message}</div>}

      {loading ? (
        <div className="rounded-2xl border border-neutral-200 bg-white p-10 text-center text-sm font-semibold text-neutral-500">Loading global catalogue…</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(280px,340px)_1fr] gap-4 items-start">
          <section className="rounded-2xl border border-neutral-200 bg-white p-4">
            <label className="block mb-3">
              <span className="sr-only">Search items</span>
              <div className="flex items-center gap-2 rounded-xl border border-neutral-200 px-3 py-2 focus-within:ring-2 focus-within:ring-[#5c4033]/20">
                <Search size={16} className="text-neutral-400 shrink-0" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search name, code or category"
                  className="w-full outline-none text-sm font-semibold"
                />
              </div>
            </label>
            <p className="text-xs font-bold uppercase tracking-widest text-neutral-400 mb-2">
              {filteredItems.length} item{filteredItems.length === 1 ? '' : 's'}
            </p>
            <ul className="space-y-2 max-h-[70vh] overflow-y-auto pr-1">
              {filteredItems.map((item) => {
                const overrides = overrideCountByCode.get(item.code) || 0;
                const active = item.code === selectedCode;
                return (
                  <li key={item.code}>
                    <button
                      type="button"
                      onClick={() => selectItem(item.code)}
                      className={`w-full text-left flex items-center gap-3 rounded-xl border p-2.5 transition-colors ${active ? 'border-[#5c4033] bg-[#fff8f0]' : 'border-neutral-200 hover:border-[#5c4033]/40'}`}
                    >
                      <span className="w-11 h-11 rounded-lg bg-[#f7eee3] shrink-0 flex items-center justify-center overflow-hidden">
                        {item.imageUrl
                          ? <img src={item.imageUrl} alt="" loading="lazy" className="w-full h-full object-cover" />
                          : <ImageOff size={16} className="text-neutral-400" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-bold text-sm text-neutral-800 truncate">{item.displayName || item.name}</span>
                        <span className="block text-[11px] text-neutral-500 truncate">{item.code} · {money(item.salePrice)}</span>
                      </span>
                      {overrides > 0 && (
                        <span className="shrink-0 text-[10px] font-black uppercase rounded-full bg-[#5c4033] text-white px-2 py-0.5">{overrides}</span>
                      )}
                    </button>
                  </li>
                );
              })}
              {filteredItems.length === 0 && (
                <li className="text-sm text-neutral-500 py-6 text-center">No items match that search.</li>
              )}
            </ul>
          </section>

          <section className="min-w-0 space-y-4">
            {!selectedItem ? (
              <div className="rounded-2xl border border-neutral-200 bg-white p-10 text-center">
                <Layers size={22} className="mx-auto text-neutral-300 mb-2" />
                <p className="text-sm font-semibold text-neutral-500">Select an item to review its global values and store overrides.</p>
              </div>
            ) : (
              <>
                <div className="rounded-2xl border border-neutral-200 bg-white p-4 md:p-5">
                  <div className="flex flex-wrap items-start gap-4">
                    <div className="w-20 h-20 rounded-xl bg-[#f7eee3] shrink-0 flex items-center justify-center overflow-hidden">
                      {selectedItem.imageUrl
                        ? <img src={selectedItem.imageUrl} alt="" className="w-full h-full object-cover" />
                        : <ImageOff size={20} className="text-neutral-400" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <h2 className="text-lg font-black text-[#3e2723]">{selectedItem.displayName || selectedItem.name}</h2>
                      <p className="text-xs text-neutral-500 mb-2">{selectedItem.code} · {selectedItem.posCategoryName || 'Uncategorised'}</p>
                      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                        <div><dt className="text-[11px] font-bold uppercase tracking-widest text-neutral-400">Global price</dt><dd className="font-black text-neutral-800">{money(selectedItem.salePrice)}</dd></div>
                        <div><dt className="text-[11px] font-bold uppercase tracking-widest text-neutral-400">Global availability</dt><dd className="font-bold text-neutral-800">{selectedItem.isAvailable === false ? 'Unavailable' : 'Available'}</dd></div>
                        <div><dt className="text-[11px] font-bold uppercase tracking-widest text-neutral-400">Display order</dt><dd className="font-bold text-neutral-800">{selectedItem.sortOrder ?? 0}</dd></div>
                        <div><dt className="text-[11px] font-bold uppercase tracking-widest text-neutral-400">Assigned stores</dt><dd className="font-bold text-neutral-800">{assignedStoreCount(selectedItem, stores)}</dd></div>
                      </dl>
                      <p className="mt-3 inline-flex items-center gap-1.5 text-[11px] font-semibold text-neutral-500">
                        <Info size={13} /> Image, description, add-ons, KOT station, GST and recipe are global and shared by every store. Edit them in Menu Management.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-neutral-200 bg-white overflow-hidden">
                  <div className="px-4 py-3 border-b border-neutral-100">
                    <h3 className="font-black text-[#3e2723]">Stores</h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[640px]">
                      <thead className="bg-[#fcf9f5] text-[11px] uppercase tracking-widest text-neutral-500">
                        <tr>
                          <th className="text-left font-bold px-4 py-2">Store</th>
                          <th className="text-left font-bold px-4 py-2">Price</th>
                          <th className="text-left font-bold px-4 py-2">Availability</th>
                          <th className="text-left font-bold px-4 py-2">Customer menu</th>
                          <th className="text-left font-bold px-4 py-2">Order</th>
                          <th className="px-4 py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {assignedStores.map((store) => {
                          const config = configs.get(keyOf(store.id, selectedItem.code)) || null;
                          const resolved = resolveStoreItem(selectedItem, config);
                          const applied = new Set(resolved.appliedOverrides);
                          const tag = (on: boolean) => on
                            ? <span className="ml-1.5 text-[10px] font-black uppercase text-[#5c4033]">Override</span>
                            : <span className="ml-1.5 text-[10px] font-bold uppercase text-neutral-400">Global</span>;
                          return (
                            <tr key={store.id} className={`border-t border-neutral-100 ${editingStoreId === store.id ? 'bg-[#fff8f0]' : ''}`}>
                              <td className="px-4 py-2.5">
                                <span className="font-bold text-neutral-800">{store.name || store.id}</span>
                                <span className="block text-[11px] text-neutral-500">{store.code || store.id}</span>
                              </td>
                              <td className="px-4 py-2.5 whitespace-nowrap">{money(resolved.salePrice)}{tag(applied.has('priceOverride'))}</td>
                              <td className="px-4 py-2.5 whitespace-nowrap">{resolved.isAvailable === false ? 'Unavailable' : 'Available'}{tag(applied.has('isAvailableOverride'))}</td>
                              <td className="px-4 py-2.5 whitespace-nowrap">{resolved.menuVisible === false ? 'Hidden' : 'Visible'}{tag(applied.has('menuVisibilityOverride'))}</td>
                              <td className="px-4 py-2.5 whitespace-nowrap">{resolved.sortOrder ?? 0}{tag(applied.has('sortOrderOverride'))}</td>
                              <td className="px-4 py-2.5 text-right">
                                <button type="button" onClick={() => selectStore(store.id)} className="text-xs font-black uppercase tracking-wide text-[#5c4033] hover:underline">Edit</button>
                              </td>
                            </tr>
                          );
                        })}
                        {unassignedStores.map((store) => (
                          <tr key={store.id} className="border-t border-neutral-100 text-neutral-400">
                            <td className="px-4 py-2.5">
                              <span className="font-bold">{store.name || store.id}</span>
                              <span className="block text-[11px]">{store.code || store.id}</span>
                            </td>
                            <td className="px-4 py-2.5" colSpan={5}>Not assigned — assign this item in Menu Management before setting an override.</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {editingStoreId && (
                  <div className="rounded-2xl border border-[#5c4033]/30 bg-white p-4 md:p-5">
                    <h3 className="font-black text-[#3e2723] mb-1">
                      Store override — {storesById.get(editingStoreId)?.name || editingStoreId}
                    </h3>
                    <p className="text-xs text-neutral-500 mb-4">Inherit global keeps this store on the shared value. Override stores an explicit value for this store only.</p>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <OverrideField
                        label="Price"
                        mode={draft.price.mode}
                        inheritLabel={money(selectedItem.salePrice)}
                        onMode={(mode) => setDraft({ ...draft, price: { ...draft.price, mode, value: mode === 'OVERRIDE' && !draft.price.value ? String(selectedItem.salePrice) : draft.price.value } })}
                      >
                        <input
                          type="number" min="0" step="0.01" inputMode="decimal"
                          value={draft.price.value}
                          onChange={(e) => setDraft({ ...draft, price: { ...draft.price, value: e.target.value } })}
                          className="w-full rounded-lg border border-neutral-200 px-3 py-2 font-bold outline-none focus:ring-2 focus:ring-[#5c4033]/20"
                        />
                      </OverrideField>

                      <OverrideField
                        label="Store availability"
                        mode={draft.availability.mode}
                        inheritLabel={selectedItem.isAvailable === false ? 'Unavailable' : 'Available'}
                        onMode={(mode) => setDraft({ ...draft, availability: { ...draft.availability, mode } })}
                      >
                        <select
                          value={draft.availability.value ? 'AVAILABLE' : 'UNAVAILABLE'}
                          onChange={(e) => setDraft({ ...draft, availability: { ...draft.availability, value: e.target.value === 'AVAILABLE' } })}
                          className="w-full rounded-lg border border-neutral-200 px-3 py-2 font-bold outline-none focus:ring-2 focus:ring-[#5c4033]/20"
                        >
                          <option value="AVAILABLE">Available</option>
                          <option value="UNAVAILABLE">Unavailable</option>
                        </select>
                      </OverrideField>

                      <OverrideField
                        label="Customer menu visibility"
                        hint="Customer ordering only. POS keeps showing this item to staff."
                        mode={draft.menuVisibility.mode}
                        inheritLabel="Visible"
                        onMode={(mode) => setDraft({ ...draft, menuVisibility: { ...draft.menuVisibility, mode } })}
                      >
                        <select
                          value={draft.menuVisibility.value ? 'VISIBLE' : 'HIDDEN'}
                          onChange={(e) => setDraft({ ...draft, menuVisibility: { ...draft.menuVisibility, value: e.target.value === 'VISIBLE' } })}
                          className="w-full rounded-lg border border-neutral-200 px-3 py-2 font-bold outline-none focus:ring-2 focus:ring-[#5c4033]/20"
                        >
                          <option value="VISIBLE">Visible</option>
                          <option value="HIDDEN">Hidden</option>
                        </select>
                      </OverrideField>

                      <OverrideField
                        label="Display order"
                        mode={draft.sortOrder.mode}
                        inheritLabel={String(selectedItem.sortOrder ?? 0)}
                        onMode={(mode) => setDraft({ ...draft, sortOrder: { ...draft.sortOrder, mode, value: mode === 'OVERRIDE' && !draft.sortOrder.value ? String(selectedItem.sortOrder ?? 0) : draft.sortOrder.value } })}
                      >
                        <input
                          type="number" step="1" inputMode="numeric"
                          value={draft.sortOrder.value}
                          onChange={(e) => setDraft({ ...draft, sortOrder: { ...draft.sortOrder, value: e.target.value } })}
                          className="w-full rounded-lg border border-neutral-200 px-3 py-2 font-bold outline-none focus:ring-2 focus:ring-[#5c4033]/20"
                        />
                      </OverrideField>
                    </div>

                    <div className="mt-5 rounded-xl border border-neutral-200 bg-[#fcf9f5] p-4">
                      <h4 className="text-[11px] font-black uppercase tracking-widest text-neutral-500 mb-2">Resolved preview</h4>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm min-w-[520px]">
                          <thead className="text-[11px] uppercase tracking-widest text-neutral-400">
                            <tr><th className="text-left font-bold py-1">Field</th><th className="text-left font-bold py-1">Global</th><th className="text-left font-bold py-1">Now</th><th className="text-left font-bold py-1">After save</th></tr>
                          </thead>
                          <tbody>
                            {comparison.map((row) => (
                              <tr key={row.field} className="border-t border-neutral-200/70">
                                <td className="py-1.5 font-bold text-neutral-700">{row.label}</td>
                                <td className="py-1.5 text-neutral-500">{row.globalValue}</td>
                                <td className="py-1.5 text-neutral-500">{row.currentValue}</td>
                                <td className={`py-1.5 font-black ${row.changed ? 'text-[#5c4033]' : 'text-neutral-700'}`}>
                                  {row.nextValue}{row.overridden && <span className="ml-1.5 text-[10px] font-black uppercase text-[#5c4033]">Override</span>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {customerSnapshotPreview && (
                      <div className={`mt-3 flex gap-2 rounded-xl border px-4 py-3 text-sm ${customerSnapshotPreview.state === 'AVAILABLE' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
                        <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                        <span><strong className="font-black">Customer snapshot after save: {customerSnapshotPreview.state}.</strong> {customerSnapshotPreview.detail}</span>
                      </div>
                    )}

                    {issues.length > 0 && (
                      <ul className="mt-3 space-y-1">
                        {issues.map((issue) => (
                          <li key={issue.field} className="text-sm font-semibold text-red-700">{issue.message}</li>
                        ))}
                      </ul>
                    )}

                    {existingConfig?.updatedBy && (
                      <p className="mt-3 text-[11px] text-neutral-400">Last updated by {existingConfig.updatedBy}</p>
                    )}

                    <div className="mt-4 flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={save}
                        disabled={saving || issues.length > 0}
                        className="px-4 py-2.5 rounded-xl bg-[#3e2723] text-white font-black disabled:bg-neutral-200 disabled:text-neutral-400"
                      >
                        {saving ? 'Publishing…' : 'Publish override'}
                      </button>
                      <button type="button" onClick={() => setEditingStoreId('')} className="text-sm font-bold text-neutral-500 hover:text-neutral-700">Cancel</button>
                      <span className="text-xs text-neutral-500">
                        Publishing updates the private override and complete customer menu snapshot together in one save. For an
                        operational rebuild of a whole store menu, use{' '}
                        <Link to="/admin/pos-readiness" className="font-black text-[#5c4033] hover:underline">POS Readiness</Link>.
                      </span>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function OverrideField(props: {
  label: string;
  hint?: string;
  mode: OverrideMode;
  inheritLabel: string;
  onMode: (mode: OverrideMode) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-neutral-200 p-3">
      <p className="text-[11px] font-black uppercase tracking-widest text-neutral-500">{props.label}</p>
      {props.hint && <p className="text-[11px] text-neutral-400 mb-1.5">{props.hint}</p>}
      <div className="mt-2 space-y-2">
        <label className="flex items-center gap-2 text-sm font-semibold text-neutral-700 cursor-pointer">
          <input type="radio" checked={props.mode === 'INHERIT'} onChange={() => props.onMode('INHERIT')} className="accent-[#5c4033]" />
          <span>Inherit global — <span className="font-black">{props.inheritLabel}</span></span>
        </label>
        <label className="flex items-center gap-2 text-sm font-semibold text-neutral-700 cursor-pointer">
          <input type="radio" checked={props.mode === 'OVERRIDE'} onChange={() => props.onMode('OVERRIDE')} className="accent-[#5c4033]" />
          <span>Override</span>
        </label>
        <div className={props.mode === 'OVERRIDE' ? '' : 'opacity-40 pointer-events-none'}>{props.children}</div>
      </div>
    </div>
  );
}
