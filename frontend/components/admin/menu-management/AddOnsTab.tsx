import React, { useEffect, useMemo, useState } from 'react';
import { collection, doc, getDocs, serverTimestamp, writeBatch } from 'firebase/firestore';
import { AlertCircle, CheckCircle2, Loader2, Save } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { db } from '../../../lib/firebase';
import type { AddOnGroup, AddOnOption, FinishedGood } from '../../../types/menu-management';

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function persistedOption(option: AddOnOption): AddOnOption {
  const inventoryConfigured = option.inventoryItemType
    && option.inventoryItemCode?.trim()
    && number(option.consumptionQuantity) > 0
    && option.consumptionUnit?.trim();
  return {
    id: option.id,
    code: option.code || option.id,
    name: option.name.trim(),
    price: Math.max(0, number(option.price)),
    ...(option.attribute ? { attribute: option.attribute } : {}),
    ...(number(option.taxRate) > 0 ? { taxRate: number(option.taxRate) } : {}),
    isActive: option.isActive !== false,
    sortOrder: number(option.sortOrder),
    ...(inventoryConfigured ? {
      inventoryItemType: option.inventoryItemType,
      inventoryItemCode: option.inventoryItemCode!.trim(),
      consumptionQuantity: number(option.consumptionQuantity),
      consumptionUnit: option.consumptionUnit!.trim().toUpperCase(),
    } : {}),
  };
}

export default function AddOnsTab() {
  const { staffProfile } = useAuth();
  const isAdmin = staffProfile?.role === 'ADMIN' && staffProfile?.isActive !== false;
  const [groups, setGroups] = useState<AddOnGroup[]>([]);
  const [finishedGoods, setFinishedGoods] = useState<FinishedGood[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    let active = true;
    Promise.all([
      getDocs(collection(db, 'addOnGroups')),
      getDocs(collection(db, 'finishedGoods')),
    ]).then(([groupSnap, finishedSnap]) => {
      if (!active) return;
      const loadedGroups = groupSnap.docs
        .map(snap => ({ id: snap.id, ...snap.data() } as AddOnGroup))
        .sort((a, b) => a.name.localeCompare(b.name));
      setGroups(loadedGroups);
      setFinishedGoods(finishedSnap.docs.map(snap => ({ id: snap.id, ...snap.data() } as FinishedGood)));
      setSelectedGroupId(current => current || loadedGroups[0]?.id || '');
    }).catch(loadError => {
      console.error('add-on-groups-load-failed', loadError);
      if (active) setError('Add-on configuration could not be loaded.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [isAdmin]);

  const selectedGroup = groups.find(group => group.id === selectedGroupId) || null;
  const mappedProducts = useMemo(
    () => finishedGoods
      .filter(item => item.isActive !== false && item.isSellable !== false && item.addOnGroupIds?.includes(selectedGroupId))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [finishedGoods, selectedGroupId],
  );

  const updateGroup = (patch: Partial<AddOnGroup>) => {
    setGroups(current => current.map(group => group.id === selectedGroupId ? { ...group, ...patch } : group));
  };

  const updateOption = (optionId: string, patch: Partial<AddOnOption>) => {
    if (!selectedGroup) return;
    updateGroup({
      options: selectedGroup.options.map(option => option.id === optionId ? { ...option, ...patch } : option),
    });
  };

  const save = async () => {
    if (!isAdmin || !selectedGroup?.id || saving) return;
    const minimumSelections = Math.max(0, number(selectedGroup.minimumSelections));
    const maximumSelections = selectedGroup.maximumSelections === null || selectedGroup.maximumSelections === undefined
      ? null
      : Math.max(0, number(selectedGroup.maximumSelections));
    if (maximumSelections !== null && maximumSelections < minimumSelections) {
      setError('Maximum selections cannot be lower than minimum selections.');
      return;
    }
    if (selectedGroup.options.some(option => !option.id || !option.name.trim() || number(option.price) < 0)) {
      setError('Every option needs a stable ID, name, and non-negative price.');
      return;
    }

    setSaving(true);
    setError('');
    setMessage('');
    try {
      const nextData = {
        id: selectedGroup.id,
        name: selectedGroup.name,
        isActive: selectedGroup.isActive !== false,
        isRequired: minimumSelections > 0,
        minimumSelections,
        maximumSelections,
        selectionMode: selectedGroup.selectionMode === 'SINGLE' ? 'SINGLE' : 'MULTIPLE',
        options: selectedGroup.options.map(persistedOption),
        updatedAt: serverTimestamp(),
        updatedBy: staffProfile?.uid || '',
      };
      const batch = writeBatch(db);
      batch.set(doc(db, 'addOnGroups', selectedGroup.id), nextData, { merge: true });
      batch.set(doc(collection(db, 'addOnGroupAudit')), {
        groupId: selectedGroup.id,
        groupName: selectedGroup.name,
        action: 'UPDATE',
        optionCount: selectedGroup.options.length,
        changedBy: staffProfile?.uid || '',
        changedByName: staffProfile?.displayName || staffProfile?.name || staffProfile?.email || 'Admin',
        changedAt: serverTimestamp(),
      });
      await batch.commit();
      setMessage(`${selectedGroup.name} saved. Refresh customer availability snapshots before public use.`);
    } catch (saveError) {
      console.error('add-on-group-save-failed', saveError);
      setError('Add-on configuration could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  if (!isAdmin) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm font-bold text-amber-900">
        Add-on configuration is available only to an active Admin.
      </div>
    );
  }

  if (loading) {
    return <div className="flex min-h-48 items-center justify-center"><Loader2 className="animate-spin text-[#5c4033]" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <label className="text-sm font-black text-neutral-700">
            Add-on group
            <select value={selectedGroupId} onChange={event => setSelectedGroupId(event.target.value)} className="mt-2 block min-h-11 w-full rounded-xl border border-neutral-200 bg-white px-3 sm:min-w-64">
              {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
            </select>
          </label>
          <div className="text-sm font-bold text-neutral-500">{mappedProducts.length} active sellable products use this group</div>
        </div>
      </div>

      {error && <div className="flex gap-2 rounded-xl bg-red-50 p-3 text-sm font-bold text-red-700"><AlertCircle size={18} />{error}</div>}
      {message && <div className="flex gap-2 rounded-xl bg-emerald-50 p-3 text-sm font-bold text-emerald-700"><CheckCircle2 size={18} />{message}</div>}

      {selectedGroup ? (
        <>
          <div className="grid gap-3 rounded-2xl border border-neutral-200 bg-white p-4 sm:grid-cols-3">
            <label className="text-xs font-black uppercase text-neutral-500">Minimum selections<input type="number" min="0" value={selectedGroup.minimumSelections ?? 0} onChange={event => updateGroup({ minimumSelections: number(event.target.value) })} className="mt-1 min-h-11 w-full rounded-xl border border-neutral-200 px-3 text-sm" /></label>
            <label className="text-xs font-black uppercase text-neutral-500">Maximum selections<input type="number" min="0" value={selectedGroup.maximumSelections ?? ''} placeholder="No limit" onChange={event => updateGroup({ maximumSelections: event.target.value === '' ? null : number(event.target.value) })} className="mt-1 min-h-11 w-full rounded-xl border border-neutral-200 px-3 text-sm" /></label>
            <label className="flex min-h-11 items-center gap-2 self-end rounded-xl border border-neutral-200 px-3 text-sm font-bold"><input type="checkbox" checked={selectedGroup.isActive !== false} onChange={event => updateGroup({ isActive: event.target.checked })} /> Group active</label>
          </div>

          <div className="space-y-3">
            {selectedGroup.options.map(option => (
              <div key={option.id} className="grid gap-3 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm lg:grid-cols-[minmax(180px,1fr)_120px_100px_150px_minmax(150px,1fr)_100px_90px]">
                <div><p className="font-black text-neutral-900">{option.name}</p><p className="text-xs font-bold text-neutral-400">{option.code}</p></div>
                <label className="text-xs font-bold text-neutral-500">Price<input type="number" min="0" step="0.01" value={option.price} onChange={event => updateOption(option.id, { price: number(event.target.value) })} className="mt-1 min-h-10 w-full rounded-xl border border-neutral-200 px-3" /></label>
                <label className="text-xs font-bold text-neutral-500">Order<input type="number" value={option.sortOrder} onChange={event => updateOption(option.id, { sortOrder: number(event.target.value) })} className="mt-1 min-h-10 w-full rounded-xl border border-neutral-200 px-3" /></label>
                <label className="text-xs font-bold text-neutral-500">Inventory type<select value={option.inventoryItemType || ''} onChange={event => updateOption(option.id, { inventoryItemType: event.target.value as AddOnOption['inventoryItemType'] || undefined })} className="mt-1 min-h-10 w-full rounded-xl border border-neutral-200 px-2"><option value="">Not configured</option><option value="RAW_INGREDIENT">Raw</option><option value="PREP_ITEM">Prep</option><option value="PACKAGING">Packaging</option></select></label>
                <label className="text-xs font-bold text-neutral-500">Inventory code<input value={option.inventoryItemCode || ''} onChange={event => updateOption(option.id, { inventoryItemCode: event.target.value.toUpperCase() })} className="mt-1 min-h-10 w-full rounded-xl border border-neutral-200 px-3" /></label>
                <label className="text-xs font-bold text-neutral-500">Qty<input type="number" min="0" step="0.001" value={option.consumptionQuantity || ''} onChange={event => updateOption(option.id, { consumptionQuantity: number(event.target.value) })} className="mt-1 min-h-10 w-full rounded-xl border border-neutral-200 px-3" /></label>
                <label className="text-xs font-bold text-neutral-500">Unit<input value={option.consumptionUnit || ''} onChange={event => updateOption(option.id, { consumptionUnit: event.target.value.toUpperCase() })} className="mt-1 min-h-10 w-full rounded-xl border border-neutral-200 px-3" /></label>
                <label className="flex items-center gap-2 text-sm font-bold"><input type="checkbox" checked={option.isActive !== false} onChange={event => updateOption(option.id, { isActive: event.target.checked })} /> Active</label>
              </div>
            ))}
          </div>

          <div className="rounded-2xl border border-neutral-200 bg-white p-4">
            <p className="mb-2 text-sm font-black text-neutral-800">Products receiving {selectedGroup.name}</p>
            <div className="flex flex-wrap gap-2">
              {mappedProducts.map(product => <span key={product.code} className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-bold text-neutral-600">{product.name}</span>)}
              {mappedProducts.length === 0 && <span className="text-sm font-bold text-neutral-400">No mapped products yet.</span>}
            </div>
          </div>

          <button type="button" onClick={save} disabled={saving} className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-[#5c4033] px-5 font-black text-white disabled:opacity-50">
            {saving ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
            Save add-ons
          </button>
        </>
      ) : (
        <div className="rounded-2xl border border-dashed border-neutral-300 p-6 text-center font-bold text-neutral-500">
          No add-on group documents exist yet. Run the approved deployment dry run first.
        </div>
      )}
    </div>
  );
}
