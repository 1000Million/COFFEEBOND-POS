import React, { useEffect, useMemo, useState } from 'react';
import { collection, doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { ChevronDown, ChevronRight, Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { db } from '../../../lib/firebase';
import {
  categoryReferenceCount,
  committedPosMenuTaxonomy,
  normalizeTaxonomyCode,
  normalizeTaxonomyDisplayName,
  resolvePosMenuTaxonomy,
  taxonomyReferenceProtection,
  taxonomyUsage,
  validatePosMenuTaxonomy,
  type ManagedPosMenuCategory,
  type PosMenuTaxonomy,
} from '../../../lib/posMenuTaxonomy';

const DOC_ID = 'posMenuTaxonomy';

export default function PosCategoryManagerTab() {
  const { staffProfile } = useAuth();
  const isAdmin = staffProfile?.role === 'ADMIN' && staffProfile?.isActive !== false;
  const [taxonomy, setTaxonomy] = useState<PosMenuTaxonomy>(committedPosMenuTaxonomy());
  const [source, setSource] = useState<'firestore' | 'fallback'>('fallback');
  const [finishedGoods, setFinishedGoods] = useState<Array<Record<string, unknown>>>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const unsubscribeTaxonomy = onSnapshot(doc(db, 'appSettings', DOC_ID), (snapshot) => {
      const resolved = resolvePosMenuTaxonomy(snapshot.exists() ? snapshot.data() : null);
      setTaxonomy(resolved.taxonomy);
      setSource(resolved.source);
      setLoading(false);
    }, () => {
      setTaxonomy(committedPosMenuTaxonomy());
      setSource('fallback');
      setLoading(false);
      setError('The saved taxonomy could not be read. The committed fallback is shown.');
    });
    const unsubscribeGoods = onSnapshot(collection(db, 'finishedGoods'), (snapshot) => {
      setFinishedGoods(snapshot.docs.map((entry) => entry.data()));
    });
    return () => { unsubscribeTaxonomy(); unsubscribeGoods(); };
  }, []);

  const usage = useMemo(() => taxonomyUsage(finishedGoods), [finishedGoods]);
  const updateCategory = (index: number, patch: Partial<ManagedPosMenuCategory>) => {
    setTaxonomy((current) => ({
      ...current,
      categories: current.categories.map((entry, entryIndex) => entryIndex === index ? { ...entry, ...patch } : entry),
    }));
  };

  const addCategory = () => {
    const code = `NEW_CATEGORY_${taxonomy.categories.length + 1}`;
    setTaxonomy((current) => ({
      ...current,
      categories: [...current.categories, { code, name: 'New Category', sortOrder: (current.categories.length + 1) * 10, isActive: true, subcategories: [] }],
    }));
    setExpanded((current) => ({ ...current, [code]: true }));
  };

  const addSubcategory = (categoryIndex: number) => {
    const category = taxonomy.categories[categoryIndex];
    const code = `NEW_SUBCATEGORY_${category.subcategories.length + 1}`;
    updateCategory(categoryIndex, {
      subcategories: [...category.subcategories, {
        code,
        name: 'New Subcategory',
        sortOrder: (category.subcategories.length + 1) * 10,
        isActive: true,
      }],
    });
  };

  const updateSubcategory = (categoryIndex: number, subcategoryIndex: number, patch: Partial<ManagedPosMenuCategory['subcategories'][number]>) => {
    const category = taxonomy.categories[categoryIndex];
    updateCategory(categoryIndex, {
      subcategories: category.subcategories.map((entry, entryIndex) => entryIndex === subcategoryIndex ? { ...entry, ...patch } : entry),
    });
  };

  const removeSubcategory = (categoryIndex: number, subcategoryIndex: number) => {
    const category = taxonomy.categories[categoryIndex];
    const subcategory = category.subcategories[subcategoryIndex];
    const references = usage.subcategoryCounts[subcategory.code] || 0;
    const protection = taxonomyReferenceProtection(references);
    if (!protection.canHardDelete) {
      setError(`${subcategory.name} cannot be deleted because ${references} active Finished Good${references === 1 ? '' : 's'} reference it. Reclassify those items first.`);
      return;
    }
    if (!window.confirm(`Delete ${subcategory.name} from ${category.name}?`)) return;
    updateCategory(categoryIndex, { subcategories: category.subcategories.filter((_, entryIndex) => entryIndex !== subcategoryIndex) });
  };

  const toggleSubcategoryActive = (categoryIndex: number, subcategoryIndex: number) => {
    const category = taxonomy.categories[categoryIndex];
    const subcategory = category.subcategories[subcategoryIndex];
    const references = usage.subcategoryCounts[subcategory.code] || 0;
    const protection = taxonomyReferenceProtection(references);
    if (subcategory.isActive && protection.requiresDeactivationConfirmation && !window.confirm(`${references} active Finished Good${references === 1 ? '' : 's'} use ${subcategory.name}. Deactivating it hides it from new classification choices but preserves existing references. Continue?`)) return;
    updateSubcategory(categoryIndex, subcategoryIndex, { isActive: !subcategory.isActive });
  };

  const removeCategory = (index: number) => {
    const category = taxonomy.categories[index];
    const references = categoryReferenceCount(category, usage);
    const protection = taxonomyReferenceProtection(references);
    if (!protection.canHardDelete) {
      setError(`${category.name} cannot be deleted because ${references} active Finished Good${references === 1 ? '' : 's'} reference it or its subcategories. Reclassify those items first.`);
      return;
    }
    if (!window.confirm(`Delete ${category.name} from the POS taxonomy?`)) return;
    setTaxonomy((current) => ({ ...current, categories: current.categories.filter((_, entryIndex) => entryIndex !== index) }));
  };

  const toggleActive = (index: number) => {
    const category = taxonomy.categories[index];
    const references = categoryReferenceCount(category, usage);
    const protection = taxonomyReferenceProtection(references);
    if (category.isActive && protection.requiresDeactivationConfirmation && !window.confirm(`${references} active Finished Good${references === 1 ? '' : 's'} use ${category.name}. Deactivating it hides it from new classification choices but preserves existing references. Continue?`)) return;
    updateCategory(index, { isActive: !category.isActive });
  };

  const save = async () => {
    setError(''); setMessage('');
    if (!isAdmin) { setError('Only an active Admin can update POS categories.'); return; }
    const validation = validatePosMenuTaxonomy(taxonomy);
    if (validation.ok === false) { setError(validation.error); return; }
    const codes = taxonomy.categories.map((entry) => normalizeTaxonomyCode(entry.code));
    const normalized = taxonomy.categories.map((entry, index) => ({
      ...entry,
      code: codes[index],
      name: normalizeTaxonomyDisplayName(entry.name),
      sortOrder: Number(entry.sortOrder),
      subcategories: entry.subcategories.map((subcategory) => ({
        ...subcategory,
        code: normalizeTaxonomyCode(subcategory.code),
        name: normalizeTaxonomyDisplayName(subcategory.name),
        sortOrder: Number(subcategory.sortOrder),
      })),
    }));
    setSaving(true);
    try {
      await setDoc(doc(db, 'appSettings', DOC_ID), {
        schemaVersion: 1,
        categories: normalized,
        updatedAt: serverTimestamp(),
        updatedByUserId: staffProfile?.uid || '',
        updatedByName: staffProfile?.displayName || staffProfile?.name || staffProfile?.email || 'Admin',
        ...(source === 'fallback' ? { createdAt: serverTimestamp() } : {}),
      });
      setMessage('POS category taxonomy saved.');
    } catch (saveError) {
      console.error('POS taxonomy save failed', saveError);
      setError('The taxonomy could not be saved. Please try again.');
    } finally { setSaving(false); }
  };

  if (loading) return <div className="flex items-center gap-2 p-8 text-neutral-500"><Loader2 className="animate-spin" size={18} /> Loading POS categories…</div>;

  return <div className="space-y-5">
    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
      <div><h2 className="text-2xl font-black text-neutral-800">POS Category Manager</h2><p className="text-sm text-neutral-500 mt-1">Manage the category tree stored at appSettings/posMenuTaxonomy.</p></div>
      <span className={`self-start rounded-full px-3 py-1 text-xs font-black ${source === 'firestore' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>{source === 'firestore' ? 'Saved taxonomy' : 'Committed fallback'}</span>
    </div>
    {!isAdmin && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">Read only. Only an active Admin can make changes.</div>}
    {error && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-800">{error}</div>}
    {message && <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-800">{message}</div>}
    <div className="space-y-3">
      {taxonomy.categories.map((category, index) => {
        const count = categoryReferenceCount(category, usage);
        return <div key={`${category.code}-${index}`} className="rounded-2xl border border-neutral-200 bg-white overflow-hidden">
          <div className="grid grid-cols-[auto_minmax(0,1fr)] sm:grid-cols-[auto_1fr_1fr_100px_auto] gap-3 items-center p-4">
            <button type="button" onClick={() => setExpanded((current) => ({ ...current, [category.code]: !current[category.code] }))} className="text-neutral-500">{expanded[category.code] ? <ChevronDown size={19} /> : <ChevronRight size={19} />}</button>
            <input disabled={!isAdmin} value={category.name} onChange={(event) => updateCategory(index, { name: event.target.value })} className="min-w-0 rounded-lg border border-neutral-200 px-3 py-2 font-bold disabled:bg-neutral-50" aria-label={`Category name ${index + 1}`} />
            <input disabled={!isAdmin || count > 0} title={count > 0 ? 'Reclassify active Finished Goods before changing this code.' : undefined} value={category.code} onChange={(event) => updateCategory(index, { code: event.target.value })} className="col-start-2 sm:col-auto min-w-0 rounded-lg border border-neutral-200 px-3 py-2 font-mono text-sm disabled:bg-neutral-50" aria-label={`Category code ${index + 1}`} />
            <input disabled={!isAdmin} type="number" value={category.sortOrder} onChange={(event) => updateCategory(index, { sortOrder: Number(event.target.value) })} className="col-start-2 sm:col-auto w-24 rounded-lg border border-neutral-200 px-3 py-2 disabled:bg-neutral-50" aria-label={`Category sort order ${index + 1}`} />
            <div className="col-start-2 sm:col-auto flex items-center justify-end gap-2">
              <button disabled={!isAdmin} type="button" onClick={() => toggleActive(index)} title={category.isActive && count > 0 ? `Confirmation required: ${count} active Finished Goods are assigned` : undefined} className={`rounded-lg px-3 py-2 text-xs font-black disabled:opacity-50 ${category.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-neutral-200 text-neutral-600'}`}>{category.isActive ? 'Active' : 'Inactive'}</button>
              <button disabled={!isAdmin} type="button" onClick={() => removeCategory(index)} title={count ? `${count} active Finished Goods reference this category` : 'Delete category'} className="rounded-lg p-2 text-red-600 hover:bg-red-50 disabled:opacity-40"><Trash2 size={17} /></button>
            </div>
          </div>
          {expanded[category.code] && <div className="border-t border-neutral-100 bg-neutral-50 p-4 space-y-3">
            <div className="text-sm text-neutral-600"><strong>{category.subcategories.length}</strong> subcategories · <strong>{count}</strong> active Finished Goods references.</div>
            {category.subcategories.map((subcategory, subcategoryIndex) => {
              const subcategoryReferences = usage.subcategoryCounts[subcategory.code] || 0;
              return <div key={`${subcategory.code}-${subcategoryIndex}`} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_100px_auto] gap-2 items-center rounded-xl border border-neutral-200 bg-white p-3 ml-0 sm:ml-8">
                <input disabled={!isAdmin} value={subcategory.name} onChange={(event) => updateSubcategory(index, subcategoryIndex, { name: event.target.value })} className="min-w-0 rounded-lg border border-neutral-200 px-3 py-2 font-semibold disabled:bg-neutral-50" aria-label={`Subcategory name ${subcategoryIndex + 1}`} />
                <input disabled={!isAdmin || subcategoryReferences > 0} title={subcategoryReferences > 0 ? 'Reclassify active Finished Goods before changing this code.' : undefined} value={subcategory.code} onChange={(event) => updateSubcategory(index, subcategoryIndex, { code: event.target.value })} className="min-w-0 rounded-lg border border-neutral-200 px-3 py-2 font-mono text-xs disabled:bg-neutral-50" aria-label={`Subcategory code ${subcategoryIndex + 1}`} />
                <input disabled={!isAdmin} type="number" value={subcategory.sortOrder} onChange={(event) => updateSubcategory(index, subcategoryIndex, { sortOrder: Number(event.target.value) })} className="w-24 rounded-lg border border-neutral-200 px-3 py-2 disabled:bg-neutral-50" aria-label={`Subcategory sort order ${subcategoryIndex + 1}`} />
                <div className="flex items-center justify-end gap-2"><span className="text-xs text-neutral-400">{subcategoryReferences} used</span><button disabled={!isAdmin} type="button" onClick={() => toggleSubcategoryActive(index, subcategoryIndex)} title={subcategory.isActive && subcategoryReferences > 0 ? `Confirmation required: ${subcategoryReferences} active Finished Goods are assigned` : undefined} className={`rounded-lg px-2.5 py-2 text-xs font-black disabled:opacity-50 ${subcategory.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-neutral-200 text-neutral-600'}`}>{subcategory.isActive ? 'Active' : 'Inactive'}</button><button disabled={!isAdmin} type="button" onClick={() => removeSubcategory(index, subcategoryIndex)} title={subcategoryReferences ? `${subcategoryReferences} active Finished Goods reference this subcategory` : 'Delete subcategory'} className="rounded-lg p-2 text-red-600 hover:bg-red-50 disabled:opacity-40"><Trash2 size={16} /></button></div>
              </div>;
            })}
            {isAdmin && <button type="button" onClick={() => addSubcategory(index)} className="ml-0 sm:ml-8 flex items-center gap-2 rounded-lg border border-dashed border-neutral-300 bg-white px-3 py-2 text-xs font-black text-neutral-700"><Plus size={15} /> Add subcategory</button>}
          </div>}
        </div>;
      })}
    </div>
    {isAdmin && <div className="flex flex-wrap justify-between gap-3"><button type="button" onClick={addCategory} className="flex items-center gap-2 rounded-xl border border-neutral-300 bg-white px-4 py-2.5 text-sm font-black"><Plus size={17} /> Add category</button><button type="button" disabled={saving} onClick={save} className="flex items-center gap-2 rounded-xl bg-[#5c4033] px-5 py-2.5 text-sm font-black text-white disabled:opacity-50">{saving ? <Loader2 size={17} className="animate-spin" /> : <Save size={17} />} Save taxonomy</button></div>}
  </div>;
}
