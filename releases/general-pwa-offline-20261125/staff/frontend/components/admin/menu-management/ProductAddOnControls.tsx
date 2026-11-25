import React, { useEffect, useMemo, useState } from 'react';
import { collection, doc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { CheckCircle2, Loader2, Save, Search } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { normalizeAddOnOptionIdsByGroup } from '../../../lib/addOns';
import { db } from '../../../lib/firebase';
import type { AddOnGroup, FinishedGood } from '../../../types/menu-management';

type ProductFilter = 'ALL' | 'FULLY_ENABLED' | 'PARTIALLY_ENABLED' | 'NO_OPTIONS';

type Props = {
  group: AddOnGroup;
  products: FinishedGood[];
  onDirtyChange: (dirty: boolean) => void;
  onProductSaved: (productId: string, addOnOptionIdsByGroup: Record<string, string[]>) => void;
};

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].sort();
}

function sameIds(left: string[], right: string[]): boolean {
  return JSON.stringify(sortedUnique(left)) === JSON.stringify(sortedUnique(right));
}

function productStatus(selectedCount: number, activeOptionCount: number): ProductFilter {
  if (selectedCount === 0) return 'NO_OPTIONS';
  if (selectedCount === activeOptionCount) return 'FULLY_ENABLED';
  return 'PARTIALLY_ENABLED';
}

export default function ProductAddOnControls({
  group,
  products,
  onDirtyChange,
  onProductSaved,
}: Props) {
  const { staffProfile } = useAuth();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ProductFilter>('ALL');
  const [selectedProductId, setSelectedProductId] = useState('');
  const [savedOptionIds, setSavedOptionIds] = useState<string[]>([]);
  const [draftOptionIds, setDraftOptionIds] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const activeOptions = useMemo(
    () => (group.options || [])
      .filter(option => option.isActive !== false)
      .sort((left, right) => Number(left.sortOrder || 0) - Number(right.sortOrder || 0)),
    [group.options],
  );
  const activeOptionIds = useMemo(() => activeOptions.map(option => option.id), [activeOptions]);
  const activeOptionIdSet = useMemo(() => new Set(activeOptionIds), [activeOptionIds]);
  const dirty = !sameIds(savedOptionIds, draftOptionIds);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const selectedProduct = products.find(product => (product.id || product.code) === selectedProductId) || null;
  const optionIdsForProduct = (product: FinishedGood): string[] => {
    const map = normalizeAddOnOptionIdsByGroup(product.addOnOptionIdsByGroup);
    return sortedUnique((map[group.id || ''] || []).filter(optionId => activeOptionIdSet.has(optionId)));
  };

  const filteredProducts = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return products.filter(product => {
      const selectedCount = optionIdsForProduct(product).length;
      const status = productStatus(selectedCount, activeOptionIds.length);
      const matchesFilter = filter === 'ALL' || filter === status;
      const matchesSearch = !needle
        || product.name.toLowerCase().includes(needle)
        || product.code.toLowerCase().includes(needle);
      return matchesFilter && matchesSearch;
    });
  }, [activeOptionIds.length, activeOptionIdSet, filter, group.id, products, search]);

  const usageCounts = useMemo(() => Object.fromEntries(
    activeOptions.map(option => [
      option.id,
      products.filter(product => optionIdsForProduct(product).includes(option.id)).length,
    ]),
  ), [activeOptionIdSet, activeOptions, group.id, products]);

  const chooseProduct = (productId: string) => {
    if (dirty && !window.confirm('Discard unsaved product add-on changes?')) return;
    const product = products.find(item => (item.id || item.code) === productId);
    const currentIds = product ? optionIdsForProduct(product) : [];
    setSelectedProductId(productId);
    setSavedOptionIds(currentIds);
    setDraftOptionIds(currentIds);
    setReason('');
    setError('');
    setMessage('');
  };

  const toggleOption = (optionId: string) => {
    setDraftOptionIds(current => current.includes(optionId)
      ? current.filter(id => id !== optionId)
      : sortedUnique([...current, optionId]));
    setMessage('');
  };

  const save = async () => {
    if (!selectedProduct || !group.id || saving || !dirty) return;
    if (!reason.trim()) {
      setError('Enter a reason for this product add-on change.');
      return;
    }
    const productId = selectedProduct.id || selectedProduct.code;
    const previousOptionIds = optionIdsForProduct(selectedProduct);
    const nextOptionIds = sortedUnique(draftOptionIds.filter(optionId => activeOptionIdSet.has(optionId)));
    const currentMap = normalizeAddOnOptionIdsByGroup(selectedProduct.addOnOptionIdsByGroup);
    const nextMap = { ...currentMap, [group.id]: nextOptionIds };

    setSaving(true);
    setError('');
    setMessage('');
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'finishedGoods', productId), {
        addOnOptionIdsByGroup: nextMap,
        updatedAt: serverTimestamp(),
        updatedBy: staffProfile?.uid || '',
      });
      batch.set(doc(collection(db, 'productAddOnAudit')), {
        productId,
        productCode: selectedProduct.code,
        groupId: group.id,
        previousOptionIds,
        newOptionIds: nextOptionIds,
        changedByUid: staffProfile?.uid || '',
        changedByName: staffProfile?.displayName || staffProfile?.name || staffProfile?.email || 'Admin',
        changedAt: serverTimestamp(),
        reason: reason.trim(),
      });
      await batch.commit();
      setSavedOptionIds(nextOptionIds);
      setDraftOptionIds(nextOptionIds);
      setReason('');
      onProductSaved(productId, nextMap);
      setMessage(`${selectedProduct.name} now allows ${nextOptionIds.length} ${group.name} option${nextOptionIds.length === 1 ? '' : 's'}.`);
    } catch (saveError) {
      console.error('product-add-on-controls-save-failed', saveError);
      setError('Product add-on controls could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-4 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
      <div>
        <h3 className="text-lg font-black text-neutral-900">Product Add-on Controls</h3>
        <p className="mt-1 text-sm font-medium text-neutral-500">
          Choose exactly which active {group.name} options each mapped product may offer.
        </p>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(220px,1fr)_repeat(4,auto)]">
        <label className="relative">
          <Search className="pointer-events-none absolute left-3 top-3.5 text-neutral-400" size={17} />
          <input
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Search product name or code"
            className="min-h-11 w-full rounded-xl border border-neutral-200 pl-10 pr-3 text-sm"
          />
        </label>
        {([
          ['ALL', 'All'],
          ['FULLY_ENABLED', 'Fully enabled'],
          ['PARTIALLY_ENABLED', 'Partially enabled'],
          ['NO_OPTIONS', 'No options'],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className={`min-h-11 rounded-xl border px-3 text-sm font-black ${
              filter === value ? 'border-[#5c4033] bg-[#5c4033] text-white' : 'border-neutral-200 text-neutral-600'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <label className="block text-sm font-black text-neutral-700">
        Product
        <select
          value={selectedProductId}
          onChange={event => chooseProduct(event.target.value)}
          className="mt-2 min-h-11 w-full rounded-xl border border-neutral-200 bg-white px-3"
        >
          <option value="">Select a mapped product</option>
          {filteredProducts.map(product => {
            const enabled = optionIdsForProduct(product).length;
            return (
              <option key={product.id || product.code} value={product.id || product.code}>
                {product.name} ({product.code}) - {enabled}/{activeOptionIds.length}
              </option>
            );
          })}
        </select>
      </label>

      {selectedProduct ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[#fbf8f3] p-3">
            <div>
              <p className="font-black text-neutral-900">{selectedProduct.name}</p>
              <p className="text-xs font-bold text-neutral-500">
                Preview: {draftOptionIds.length} of {activeOptionIds.length} active options will be shown
              </p>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setDraftOptionIds(activeOptionIds)} className="min-h-10 rounded-lg border border-neutral-300 px-3 text-sm font-black">Select all</button>
              <button type="button" onClick={() => setDraftOptionIds([])} className="min-h-10 rounded-lg border border-neutral-300 px-3 text-sm font-black">Clear all</button>
            </div>
          </div>

          <div className="grid gap-2 md:grid-cols-2">
            {group.options
              .slice()
              .sort((left, right) => Number(left.sortOrder || 0) - Number(right.sortOrder || 0))
              .map(option => (
                <label key={option.id} className={`flex min-h-14 items-center justify-between gap-3 rounded-xl border p-3 ${
                  option.isActive === false ? 'border-neutral-200 bg-neutral-50 opacity-60' : 'border-neutral-200'
                }`}>
                  <span className="flex min-w-0 items-center gap-3">
                    <input
                      type="checkbox"
                      checked={draftOptionIds.includes(option.id)}
                      disabled={option.isActive === false}
                      onChange={() => toggleOption(option.id)}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-black text-neutral-800">{option.name}</span>
                      <span className="text-xs font-bold text-neutral-500">
                        Rs {Number(option.price || 0).toFixed(2)} · used by {usageCounts[option.id] || 0} products
                      </span>
                    </span>
                  </span>
                  {option.isActive === false && <span className="text-xs font-black text-neutral-400">Inactive</span>}
                </label>
              ))}
          </div>

          <label className="block text-sm font-black text-neutral-700">
            Reason for change
            <textarea
              value={reason}
              onChange={event => setReason(event.target.value)}
              rows={2}
              maxLength={300}
              placeholder="Required for the audit trail"
              className="mt-2 w-full rounded-xl border border-neutral-200 p-3 text-sm"
            />
          </label>

          {dirty && <div className="rounded-xl bg-amber-50 p-3 text-sm font-bold text-amber-800">Unsaved product add-on changes.</div>}
          {error && <div className="rounded-xl bg-red-50 p-3 text-sm font-bold text-red-700">{error}</div>}
          {message && <div className="flex items-center gap-2 rounded-xl bg-emerald-50 p-3 text-sm font-bold text-emerald-700"><CheckCircle2 size={17} />{message}</div>}

          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-[#5c4033] px-5 font-black text-white disabled:opacity-50"
          >
            {saving ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
            Save product controls
          </button>
        </>
      ) : (
        <div className="rounded-xl border border-dashed border-neutral-300 p-5 text-center text-sm font-bold text-neutral-500">
          {filteredProducts.length} mapped product{filteredProducts.length === 1 ? '' : 's'} match this view.
        </div>
      )}
    </section>
  );
}
