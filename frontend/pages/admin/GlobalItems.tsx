import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, getDoc, getDocs, runTransaction, serverTimestamp } from 'firebase/firestore';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  ImageOff,
  Layers,
  PackageCheck,
  Plus,
  Search,
  Store as StoreIcon,
  Trash2,
  X,
} from 'lucide-react';
import { db } from '../../lib/firebase';
import { useAuth } from '../../contexts/AuthContext';
import type { Store } from '../../types';
import type {
  AddOnGroup,
  BOMComponent,
  FinishedGood,
  FinishedGoodProductType,
  PrepItem,
  RawIngredient,
} from '../../types/menu-management';
import {
  GLOBAL_ITEM_MASTER_DRAFT_COLLECTION,
  GLOBAL_ITEM_VERSION_SCHEMA_VERSION,
  globalItemMasterDraftDocId,
  type GlobalItemMasterDraft,
  type GlobalItemProductVersion,
} from '../../types/global-items';
import {
  GlobalItemPublishError,
  globalItemBaseProductToken,
  publishGlobalItemToStores,
  validateGlobalItemProductForPublish,
} from '../../lib/globalItemPublish';
import {
  STORE_ITEM_CONFIG_COLLECTION,
  storeItemConfigDocId,
  type StoreItemConfig,
} from '../../lib/storeItemConfig';
import {
  effectiveStoreProduct,
  eligibleGlobalItemStores,
  initialMasterProduct,
  masterProductToken,
  productWithType,
  publishedProductDiffersFromMaster,
  publishedStoreState,
  publishReviewChanges,
  selectedStoreIdsAfterSelectAll,
  selectedStoreIdsAfterToggle,
} from '../../lib/globalItemUx';
import {
  activePosMenuCategories,
  POS_MENU_TAXONOMY_DOCUMENT_PATH,
  resolvePosMenuTaxonomy,
} from '../../lib/posMenuTaxonomy';

type StoreRecord = Store & { id: string };
type ConfigsByKey = Map<string, StoreItemConfig>;
type DraftsByCode = Map<string, GlobalItemMasterDraft>;

const inputClass = 'min-h-11 w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none transition focus:border-amber-700 focus:ring-2 focus:ring-amber-100';
const cardClass = 'rounded-2xl border border-stone-200 bg-white shadow-sm';

function money(value: unknown): string {
  return `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function newRevision(): string {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function dateTime(value: unknown): string {
  if (!value) return '—';
  const candidate = value as { toDate?: () => Date; seconds?: number };
  const date = typeof candidate.toDate === 'function'
    ? candidate.toDate()
    : typeof candidate.seconds === 'number'
      ? new Date(candidate.seconds * 1_000)
      : new Date(String(value));
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-IN');
}

function isAssigned(item: FinishedGood, storeId: string): boolean {
  const ids = Array.isArray(item.availableStoreIds) ? item.availableStoreIds : [];
  return ids.length === 0 || ids.includes(storeId);
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5 text-sm font-medium text-stone-700">
      <span>{label}</span>
      {children}
      {hint && <span className="block text-xs font-normal text-stone-500">{hint}</span>}
    </label>
  );
}

function Switch({ checked, disabled, onChange, label }: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <label className={`flex min-h-11 items-center justify-between gap-3 rounded-xl border px-3 py-2 text-sm ${disabled ? 'cursor-not-allowed border-stone-200 bg-stone-100 text-stone-400' : 'cursor-pointer border-stone-300 bg-white text-stone-700'}`}>
      <span>{label}</span>
      <input
        className="h-5 w-5 accent-amber-700"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function Section({ title, description, children }: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`${cardClass} p-4 sm:p-5`}>
      <div className="mb-4">
        <h3 className="text-base font-semibold text-stone-900">{title}</h3>
        {description && <p className="mt-1 text-sm text-stone-500">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function StatusPill({ state }: { state: ReturnType<typeof publishedStoreState> }) {
  const style = state === 'CURRENT'
    ? 'bg-emerald-100 text-emerald-800'
    : state === 'OLDER_VERSION'
      ? 'bg-amber-100 text-amber-800'
      : 'bg-stone-100 text-stone-600';
  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${style}`}>{state.replace('_', ' ')}</span>;
}

function MasterHeader({ item, product, saved, dirty }: {
  item: FinishedGood;
  product: GlobalItemProductVersion;
  saved: GlobalItemMasterDraft | null;
  dirty: boolean;
}) {
  const type = product.productType || 'NORMAL_SELLABLE';
  const role = type === 'INTERNAL_COMPONENT'
    ? 'Internal — not sold directly'
    : type === 'COMPOSITE_PARENT'
      ? 'Set / flight / composite'
      : 'Normal sellable';
  return (
    <div className={`${cardClass} overflow-hidden`}>
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:p-5">
        <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-stone-100">
          {product.imageUrl
            ? <img src={product.imageUrl} alt="" className="h-full w-full object-cover" />
            : <ImageOff className="h-7 w-7 text-stone-400" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-800">Master product</p>
          <h2 className="mt-1 truncate text-2xl font-semibold text-stone-950">{product.displayName || product.name}</h2>
          <p className="mt-1 text-sm text-stone-500">{item.code} · {product.posCategoryName || 'Uncategorised'}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-700">{role}</span>
            <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${dirty ? 'bg-orange-100 text-orange-800' : saved ? 'bg-blue-100 text-blue-800' : 'bg-stone-100 text-stone-600'}`}>
              {dirty ? 'Unsaved changes' : saved ? 'Master saved' : 'Master not saved'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function BomEditor({ product, rawIngredients, prepItems, finishedGoods, onChange }: {
  product: GlobalItemProductVersion;
  rawIngredients: RawIngredient[];
  prepItems: PrepItem[];
  finishedGoods: FinishedGood[];
  onChange: (product: GlobalItemProductVersion) => void;
}) {
  const updateLine = (index: number, patch: Partial<BOMComponent>) => {
    const bom = product.bom.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line);
    onChange({ ...product, bom, bomVersion: Number(product.bomVersion || 0) + 1 });
  };
  const addLine = () => onChange({
    ...product,
    bom: [...product.bom, {
      componentType: 'RAW_INGREDIENT', componentCode: '', componentName: '', quantity: 1,
      uom: 'unit', costPerUnit: 0, lineCost: 0,
    }],
    bomVersion: Number(product.bomVersion || 0) + 1,
  });
  const sourceOptions = (type: BOMComponent['componentType']) => {
    if (type === 'PREP_ITEM') return prepItems.map((row) => ({ code: row.code, name: row.name, uom: row.outputUOM, cost: row.costPerUnit }));
    if (type === 'FINISHED_GOOD') return finishedGoods.filter((row) => row.code !== product.code).map((row) => ({ code: row.code, name: row.name, uom: 'unit', cost: row.recipeCost }));
    return rawIngredients.map((row) => ({ code: row.code, name: row.name, uom: row.usageUOM, cost: row.costPerUsageUnit }));
  };
  return (
    <div className="space-y-3">
      {product.bom.map((line, index) => (
        <div key={`${index}-${line.componentCode}`} className="grid gap-2 rounded-xl border border-stone-200 bg-stone-50 p-3 md:grid-cols-[150px_minmax(160px,1fr)_100px_100px_44px]">
          <select className={inputClass} value={line.componentType} onChange={(event) => updateLine(index, { componentType: event.target.value as BOMComponent['componentType'], componentCode: '', componentName: '' })} aria-label={`Recipe component type ${index + 1}`}>
            <option value="RAW_INGREDIENT">Ingredient</option>
            <option value="PREP_ITEM">Prep item</option>
            <option value="FINISHED_GOOD">Finished good</option>
            <option value="PACKAGING">Packaging</option>
            <option value="BOUGHT_COMPONENT">Bought component</option>
          </select>
          <select className={inputClass} value={line.componentCode} onChange={(event) => {
            const option = sourceOptions(line.componentType).find((row) => row.code === event.target.value);
            updateLine(index, {
              componentCode: event.target.value,
              componentName: option?.name || '',
              uom: option?.uom || line.uom,
              costPerUnit: Number(option?.cost || 0),
              lineCost: Number(option?.cost || 0) * Number(line.quantity || 0),
            });
          }} aria-label={`Recipe component ${index + 1}`}>
            <option value="">Select component</option>
            {sourceOptions(line.componentType).map((row) => <option key={row.code} value={row.code}>{row.name} ({row.code})</option>)}
          </select>
          <input className={inputClass} type="number" min="0.001" step="0.001" value={line.quantity} onChange={(event) => {
            const quantity = Number(event.target.value);
            updateLine(index, { quantity, lineCost: quantity * Number(line.costPerUnit || 0) });
          }} aria-label={`Recipe quantity ${index + 1}`} />
          <input className={inputClass} value={line.uom} onChange={(event) => updateLine(index, { uom: event.target.value })} aria-label={`Recipe unit ${index + 1}`} />
          <button type="button" className="flex h-11 w-11 items-center justify-center rounded-xl border border-red-200 text-red-700 hover:bg-red-50" onClick={() => onChange({ ...product, bom: product.bom.filter((_, lineIndex) => lineIndex !== index), bomVersion: Number(product.bomVersion || 0) + 1 })} aria-label={`Remove recipe row ${index + 1}`}><Trash2 className="h-4 w-4" /></button>
        </div>
      ))}
      <button type="button" onClick={addLine} className="flex min-h-11 items-center gap-2 rounded-xl border border-stone-300 px-4 text-sm font-semibold text-stone-700 hover:bg-stone-50"><Plus className="h-4 w-4" /> Add recipe component</button>
    </div>
  );
}

function GroupPicker({ title, groups, product, compositeChoice, onChange }: {
  title: string;
  groups: AddOnGroup[];
  product: GlobalItemProductVersion;
  compositeChoice?: boolean;
  onChange: (product: GlobalItemProductVersion) => void;
}) {
  const groupIds = product.addOnGroupIds || [];
  const toggleGroup = (group: AddOnGroup & { id: string }) => {
    const active = groupIds.includes(group.id);
    const nextIds = active ? groupIds.filter((id) => id !== group.id) : [...groupIds, group.id];
    const nextOptions = { ...(product.addOnOptionIdsByGroup || {}) };
    if (active) delete nextOptions[group.id];
    else nextOptions[group.id] = group.options.filter((option) => option.isActive !== false).map((option) => option.id);
    const composite = compositeChoice
      ? { ...(product.composite || { schemaVersion: 1, staticComponents: [], choiceGroupIds: [] }), choiceGroupIds: active
        ? (product.composite?.choiceGroupIds || []).filter((id) => id !== group.id)
        : [...(product.composite?.choiceGroupIds || []), group.id] }
      : product.composite;
    onChange({ ...product, addOnGroupIds: nextIds, addOnOptionIdsByGroup: nextOptions, ...(composite ? { composite } : {}) });
  };
  const toggleOption = (groupId: string, optionId: string) => {
    const selected = product.addOnOptionIdsByGroup?.[groupId] || [];
    const next = selected.includes(optionId) ? selected.filter((id) => id !== optionId) : [...selected, optionId];
    onChange({ ...product, addOnOptionIdsByGroup: { ...(product.addOnOptionIdsByGroup || {}), [groupId]: next } });
  };
  return (
    <div>
      <h4 className="mb-2 text-sm font-semibold text-stone-800">{title}</h4>
      {groups.length === 0 && <p className="rounded-xl bg-stone-50 p-3 text-sm text-stone-500">No active groups are available.</p>}
      <div className="space-y-2">
        {groups.map((group) => {
          const id = group.id as string;
          const active = groupIds.includes(id);
          return (
            <div key={id} className="rounded-xl border border-stone-200 p-3">
              <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-semibold text-stone-800">
                <input type="checkbox" className="h-5 w-5 accent-amber-700" checked={active} onChange={() => toggleGroup(group as AddOnGroup & { id: string })} />
                {group.name}
              </label>
              {active && <div className="ml-8 mt-1 flex flex-wrap gap-2">
                {group.options.filter((option) => option.isActive !== false).map((option) => {
                  const selected = (product.addOnOptionIdsByGroup?.[id] || []).includes(option.id);
                  return <label key={option.id} className={`cursor-pointer rounded-lg border px-3 py-2 text-xs ${selected ? 'border-amber-700 bg-amber-50 text-amber-900' : 'border-stone-200 text-stone-600'}`}><input type="checkbox" className="sr-only" checked={selected} onChange={() => toggleOption(id, option.id)} />{option.name}</label>;
                })}
              </div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CompositeEditor({ product, finishedGoods, choiceGroups, onChange }: {
  product: GlobalItemProductVersion;
  finishedGoods: FinishedGood[];
  choiceGroups: AddOnGroup[];
  onChange: (product: GlobalItemProductVersion) => void;
}) {
  const composite = product.composite || { schemaVersion: 1 as const, staticComponents: [], choiceGroupIds: [] };
  return (
    <div className="space-y-5">
      <div>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h4 className="text-sm font-semibold text-stone-800">Fixed child products</h4>
          <button type="button" className="flex min-h-11 items-center gap-2 rounded-xl border border-stone-300 px-3 text-sm font-semibold" onClick={() => onChange({ ...product, composite: { ...composite, staticComponents: [...composite.staticComponents, { finishedGoodId: '', finishedGoodCode: '', quantity: 1 }] } })}><Plus className="h-4 w-4" /> Add child</button>
        </div>
        <div className="space-y-2">
          {composite.staticComponents.map((child, index) => (
            <div key={`${index}-${child.finishedGoodCode}`} className="grid gap-2 rounded-xl border border-stone-200 bg-stone-50 p-3 sm:grid-cols-[1fr_110px_44px]">
              <select className={inputClass} value={child.finishedGoodId} onChange={(event) => {
                const item = finishedGoods.find((row) => (row.id || row.code) === event.target.value);
                const staticComponents = composite.staticComponents.map((entry, childIndex) => childIndex === index ? { ...entry, finishedGoodId: event.target.value, finishedGoodCode: item?.code || '' } : entry);
                onChange({ ...product, composite: { ...composite, staticComponents } });
              }} aria-label={`Composite child ${index + 1}`}>
                <option value="">Select child product</option>
                {finishedGoods.filter((row) => row.code !== product.code && row.isActive !== false).map((row) => <option key={row.id || row.code} value={row.id || row.code}>{row.name} ({row.code})</option>)}
              </select>
              <input className={inputClass} type="number" min="0.001" step="0.001" value={child.quantity} onChange={(event) => {
                const staticComponents = composite.staticComponents.map((entry, childIndex) => childIndex === index ? { ...entry, quantity: Number(event.target.value) } : entry);
                onChange({ ...product, composite: { ...composite, staticComponents } });
              }} aria-label={`Composite child quantity ${index + 1}`} />
              <button type="button" className="flex h-11 w-11 items-center justify-center rounded-xl border border-red-200 text-red-700" onClick={() => onChange({ ...product, composite: { ...composite, staticComponents: composite.staticComponents.filter((_, childIndex) => childIndex !== index) } })} aria-label={`Remove composite child ${index + 1}`}><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
      </div>
      <GroupPicker title="Selectable child groups" groups={choiceGroups} product={product} compositeChoice onChange={onChange} />
      <p className="rounded-xl bg-blue-50 p-3 text-sm text-blue-800">Composite parents may use prep station NONE. At publish, every child product and choice is resolved into the operational order snapshot.</p>
    </div>
  );
}

function MasterEditor({ product, taxonomyDocument, rawIngredients, prepItems, finishedGoods, addOnGroups, issues, onChange, onSave, saving }: {
  product: GlobalItemProductVersion;
  taxonomyDocument: unknown;
  rawIngredients: RawIngredient[];
  prepItems: PrepItem[];
  finishedGoods: FinishedGood[];
  addOnGroups: AddOnGroup[];
  issues: string[];
  onChange: (product: GlobalItemProductVersion) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const categories = activePosMenuCategories(resolvePosMenuTaxonomy(taxonomyDocument).taxonomy);
  const category = categories.find((row) => row.code === product.posCategoryCode);
  const productType = product.productType || 'NORMAL_SELLABLE';
  const ordinaryGroups = addOnGroups.filter((group) => group.id && group.isActive !== false && group.purpose !== 'COMPOSITE_CHOICE');
  const choiceGroups = addOnGroups.filter((group) => group.id && group.isActive !== false && group.purpose === 'COMPOSITE_CHOICE');
  const set = <K extends keyof GlobalItemProductVersion>(key: K, value: GlobalItemProductVersion[K]) => onChange({ ...product, [key]: value });
  const changeProductType = (type: FinishedGoodProductType) => {
    const next = productWithType(product, type);
    if (type === 'INTERNAL_COMPONENT') {
      onChange({ ...next, addOnGroupIds: [], addOnOptionIdsByGroup: {} });
      return;
    }
    if (type === 'NORMAL_SELLABLE') {
      const ordinaryIds = new Set(ordinaryGroups.map((group) => group.id as string));
      const addOnGroupIds = (next.addOnGroupIds || []).filter((id) => ordinaryIds.has(id));
      onChange({
        ...next,
        addOnGroupIds,
        addOnOptionIdsByGroup: Object.fromEntries(
          Object.entries(next.addOnOptionIdsByGroup || {}).filter(([id]) => ordinaryIds.has(id)),
        ),
      });
      return;
    }
    onChange({ ...next, prepStation: product.productType === 'COMPOSITE_PARENT' ? next.prepStation : 'NONE' });
  };
  return (
    <div className="space-y-4">
      <Section title="General" description="The product identity and customer-facing presentation.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Product name"><input className={inputClass} value={product.displayName || product.name} onChange={(event) => onChange({ ...product, name: event.target.value, displayName: event.target.value })} /></Field>
          <Field label="Product code" hint="Identity is protected and cannot be changed here."><input className={`${inputClass} bg-stone-100 text-stone-500`} value={product.code} disabled /></Field>
          <Field label="POS category"><select className={inputClass} value={product.posCategoryCode} onChange={(event) => {
            const next = categories.find((row) => row.code === event.target.value);
            if (!next) return;
            onChange({ ...product, posCategoryCode: next.code, posCategoryName: next.name, categoryCode: next.code, categoryName: next.name, categorySortOrder: next.sortOrder, posSubcategoryCode: null, posSubcategoryName: null, subcategoryCode: null, subcategoryName: null, subcategorySortOrder: null });
          }}>{categories.map((row) => <option key={row.code} value={row.code}>{row.name}</option>)}</select></Field>
          <Field label="Subcategory"><select className={inputClass} value={product.posSubcategoryCode || ''} onChange={(event) => {
            const next = category?.subcategories.find((row) => row.code === event.target.value);
            onChange({ ...product, posSubcategoryCode: next?.code || null, posSubcategoryName: next?.name || null, subcategoryCode: next?.code || null, subcategoryName: next?.name || null, subcategorySortOrder: next?.sortOrder ?? null });
          }}><option value="">None</option>{category?.subcategories.map((row) => <option key={row.code} value={row.code}>{row.name}</option>)}</select></Field>
          <div className="sm:col-span-2"><Field label="Description"><textarea className={`${inputClass} min-h-24`} value={product.description || ''} onChange={(event) => set('description', event.target.value)} /></Field></div>
          <div className="sm:col-span-2"><Field label="Image URL" hint="Use an approved HTTPS product image URL."><input className={inputClass} type="url" value={product.imageUrl || ''} onChange={(event) => onChange({ ...product, imageUrl: event.target.value, imageStoragePath: null, imageSource: null, imageUpdatedBy: null })} /></Field></div>
        </div>
      </Section>

      <Section title="Commercial" description={productType === 'INTERNAL_COMPONENT' ? 'Internal components cannot be sold directly or shown on the customer menu.' : 'Pricing, ordering, availability, and menu presentation.'}>
        {productType === 'INTERNAL_COMPONENT' ? (
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">Direct sale and customer-menu visibility are locked off for this product type.</div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Sale price"><input className={inputClass} type="number" min="0" step="0.01" value={product.salePrice} onChange={(event) => set('salePrice', Number(event.target.value))} /></Field>
            <Field label="GST / tax %"><input className={inputClass} type="number" min="0" max="100" step="0.01" value={product.taxRate} onChange={(event) => set('taxRate', Number(event.target.value))} /></Field>
            <Field label="Display order"><input className={inputClass} type="number" min="0" step="1" value={product.sortOrder ?? 0} onChange={(event) => set('sortOrder', Number(event.target.value))} /></Field>
            <Switch label="Directly sellable" checked={product.isSellable} onChange={(checked) => set('isSellable', checked)} />
            <Switch label="Customer menu visible" checked={product.menuVisible} onChange={(checked) => set('menuVisible', checked)} />
          </div>
        )}
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Switch label="Production available" checked={product.isAvailable} onChange={(checked) => set('isAvailable', checked)} />
          <Switch label="Active product" checked={product.isActive} onChange={(checked) => set('isActive', checked)} />
        </div>
      </Section>

      <Section title="Operations" description="Product role, preparation routing, stock behaviour, and recipe cost.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Product type"><select className={inputClass} value={productType} onChange={(event) => changeProductType(event.target.value as FinishedGoodProductType)}>
            <option value="NORMAL_SELLABLE">Normal sellable</option>
            <option value="INTERNAL_COMPONENT">Internal component</option>
            <option value="COMPOSITE_PARENT">Set / flight / composite</option>
          </select></Field>
          <Field label="Prep / KOT station"><select className={inputClass} value={product.prepStation} onChange={(event) => set('prepStation', event.target.value as GlobalItemProductVersion['prepStation'])}><option value="BARISTA">Barista</option><option value="KITCHEN">Kitchen</option><option value="BOTH">Both</option><option value="NONE">None</option></select></Field>
          <Field label="Item behaviour"><select className={inputClass} value={product.itemType} onChange={(event) => set('itemType', event.target.value as GlobalItemProductVersion['itemType'])}><option value="MADE_TO_ORDER">Made to order</option><option value="DIRECT_STOCK">Direct stock</option><option value="NO_STOCK">No stock</option></select></Field>
          <Field label="Production mode"><select className={inputClass} value={product.productionMode || ''} onChange={(event) => set('productionMode', event.target.value as GlobalItemProductVersion['productionMode'])}><option value="">Not set</option><option value="MADE_TO_ORDER">Made to order</option><option value="ASSEMBLED_TO_ORDER">Assembled to order</option><option value="BOUGHT_AND_SOLD">Bought and sold</option><option value="NO_STOCK">No stock</option></select></Field>
          <Field label="Recipe cost"><input className={inputClass} type="number" min="0" step="0.01" value={product.recipeCost} onChange={(event) => set('recipeCost', Number(event.target.value))} /></Field>
        </div>
      </Section>

      {productType === 'COMPOSITE_PARENT' && <Section title="Child-product configuration" description="Fixed child products and selectable component groups for sets, flights, and bundles."><CompositeEditor product={product} finishedGoods={finishedGoods} choiceGroups={choiceGroups} onChange={onChange} /></Section>}
      {productType !== 'INTERNAL_COMPONENT' && <Section title="Add-ons and modifiers" description="Choose the active groups and option allowlist published with this version."><GroupPicker title="Modifier groups" groups={ordinaryGroups} product={product} onChange={onChange} /></Section>}
      {productType !== 'COMPOSITE_PARENT' && <Section title="Recipe / BOM" description="Structured operational components. Made-to-order products require at least one valid row."><BomEditor product={product} rawIngredients={rawIngredients} prepItems={prepItems} finishedGoods={finishedGoods} onChange={onChange} /></Section>}

      {issues.length > 0 && <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"><div className="mb-2 flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4" /> Resolve before publishing</div><ul className="list-disc space-y-1 pl-5">{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></div>}
      <div className="flex flex-col gap-3 rounded-2xl border border-blue-200 bg-blue-50 p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-blue-900"><strong>Save master</strong> stores a non-live draft. No store, POS, KOT, customer menu, or inventory output changes until publish.</p>
        <button type="button" disabled={saving} onClick={onSave} className="min-h-11 shrink-0 rounded-xl bg-stone-950 px-5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{saving ? 'Saving…' : 'Save master'}</button>
      </div>
    </div>
  );
}

export default function GlobalItems() {
  const { staffProfile } = useAuth();
  const isAdmin = staffProfile?.role === 'ADMIN' && staffProfile?.isActive === true;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [items, setItems] = useState<FinishedGood[]>([]);
  const [stores, setStores] = useState<StoreRecord[]>([]);
  const [configs, setConfigs] = useState<ConfigsByKey>(new Map());
  const [drafts, setDrafts] = useState<DraftsByCode>(new Map());
  const [rawIngredients, setRawIngredients] = useState<RawIngredient[]>([]);
  const [prepItems, setPrepItems] = useState<PrepItem[]>([]);
  const [addOnGroups, setAddOnGroups] = useState<AddOnGroup[]>([]);
  const [taxonomyDocument, setTaxonomyDocument] = useState<unknown>(null);
  const [search, setSearch] = useState('');
  const [selectedCode, setSelectedCode] = useState('');
  const [masterProduct, setMasterProduct] = useState<GlobalItemProductVersion | null>(null);
  const [savedProductToken, setSavedProductToken] = useState('');
  const [selectedStoreIds, setSelectedStoreIds] = useState<string[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);

  const loadCatalogue = useCallback(async () => {
    const [itemSnap, storeSnap, configSnap, draftSnap, rawSnap, prepSnap, addOnSnap, taxonomySnap] = await Promise.all([
      getDocs(collection(db, 'finishedGoods')),
      getDocs(collection(db, 'stores')),
      getDocs(collection(db, STORE_ITEM_CONFIG_COLLECTION)),
      getDocs(collection(db, GLOBAL_ITEM_MASTER_DRAFT_COLLECTION)),
      getDocs(collection(db, 'rawIngredients')),
      getDocs(collection(db, 'prepItems')),
      getDocs(collection(db, 'addOnGroups')),
      getDoc(doc(db, POS_MENU_TAXONOMY_DOCUMENT_PATH)),
    ]);
    setItems(itemSnap.docs.map((row) => {
      const data = row.data() as Omit<FinishedGood, 'id'>;
      return { id: row.id, ...data, name: String(data.name || data.displayName || data.code || row.id) };
    }).sort((a, b) => String(a.name || a.code).localeCompare(String(b.name || b.code))));
    setStores(storeSnap.docs.map((row) => ({ id: row.id, ...(row.data() as Omit<Store, 'id'>) })));
    setConfigs(new Map(configSnap.docs.map((row) => {
      const value = { id: row.id, ...(row.data() as Omit<StoreItemConfig, 'id'>) };
      return [storeItemConfigDocId(value.storeId, value.itemCode), value];
    })));
    setDrafts(new Map(draftSnap.docs.map((row) => {
      const value = row.data() as GlobalItemMasterDraft;
      return [value.itemCode, value];
    })));
    setRawIngredients(rawSnap.docs.map((row) => ({ id: row.id, ...(row.data() as Omit<RawIngredient, 'id'>) })));
    setPrepItems(prepSnap.docs.map((row) => ({ id: row.id, ...(row.data() as Omit<PrepItem, 'id'>) })));
    setAddOnGroups(addOnSnap.docs.map((row) => ({ id: row.id, ...(row.data() as Omit<AddOnGroup, 'id'>) })));
    setTaxonomyDocument(taxonomySnap.exists() ? taxonomySnap.data() : null);
  }, []);

  useEffect(() => {
    if (!isAdmin) { setLoading(false); return; }
    let active = true;
    setLoading(true);
    loadCatalogue().catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : 'Unable to load the global catalogue.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [isAdmin, loadCatalogue]);

  const selectedItem = useMemo(() => items.find((item) => item.code === selectedCode) || null, [items, selectedCode]);
  const savedDraft = selectedCode ? drafts.get(selectedCode) || null : null;
  const eligibleStores = useMemo(() => eligibleGlobalItemStores(stores), [stores]);
  const filteredItems = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('en');
    return needle ? items.filter((item) => [item.name, item.displayName, item.code, item.posCategoryName].some((value) => String(value || '').toLocaleLowerCase('en').includes(needle))) : items;
  }, [items, search]);
  const dirty = !!masterProduct && masterProductToken(masterProduct) !== savedProductToken;
  const validationIssues = useMemo(() => masterProduct ? validateGlobalItemProductForPublish(masterProduct, { finishedGoods: items, rawIngredients, prepItems, addOnGroups, taxonomyDocument }) : [], [addOnGroups, items, masterProduct, prepItems, rawIngredients, taxonomyDocument]);
  const configsBySelectedStore = useMemo(() => new Map(selectedStoreIds.map((storeId) => [storeId, selectedItem ? configs.get(storeItemConfigDocId(storeId, selectedItem.code)) || null : null])), [configs, selectedItem, selectedStoreIds]);
  const reviewChanges = useMemo(() => selectedItem && masterProduct ? publishReviewChanges(selectedItem, masterProduct, selectedStoreIds, configsBySelectedStore) : [], [configsBySelectedStore, masterProduct, selectedItem, selectedStoreIds]);
  const allSelected = eligibleStores.length > 0 && eligibleStores.every((store) => selectedStoreIds.includes(store.id));
  const publishDisabled = !savedDraft || dirty || selectedStoreIds.length === 0 || validationIssues.length > 0 || saving || publishing;

  const chooseItem = (item: FinishedGood) => {
    const saved = drafts.get(item.code) || null;
    const next = initialMasterProduct(item, saved);
    setSelectedCode(item.code);
    setMasterProduct(next);
    setSavedProductToken(saved ? masterProductToken(saved.product) : '');
    setSelectedStoreIds([]);
    setReviewOpen(false);
    setError('');
    setMessage('');
  };

  const saveMaster = async () => {
    if (!selectedItem || !masterProduct || !staffProfile || !isAdmin) return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const itemRef = doc(db, 'finishedGoods', selectedItem.id || selectedItem.code);
      const draftRef = doc(db, GLOBAL_ITEM_MASTER_DRAFT_COLLECTION, globalItemMasterDraftDocId(selectedItem.code));
      const expectedDraftRevision = savedDraft?.draftRevision || '';
      const revision = newRevision();
      const savedProduct = await runTransaction(db, async (transaction) => {
        const [freshItemSnap, freshDraftSnap] = await Promise.all([transaction.get(itemRef), transaction.get(draftRef)]);
        if (!freshItemSnap.exists()) throw new Error('The source product no longer exists. Nothing was saved.');
        const freshItem = { id: freshItemSnap.id, ...(freshItemSnap.data() as Omit<FinishedGood, 'id'>) };
        if (globalItemBaseProductToken(freshItem) !== globalItemBaseProductToken(selectedItem)) {
          throw new Error('The live source product changed while you were editing. Reload it before saving. Nothing was saved.');
        }
        const currentRevision = freshDraftSnap.exists() ? String((freshDraftSnap.data() as GlobalItemMasterDraft).draftRevision || '') : '';
        if (currentRevision !== expectedDraftRevision) throw new Error('A newer master draft was saved by someone else. Reload before saving. Nothing was saved.');
        const product: GlobalItemProductVersion = { ...masterProduct, availableStoreIds: Array.isArray(freshItem.availableStoreIds) ? freshItem.availableStoreIds : [] };
        transaction.set(draftRef, {
          schemaVersion: GLOBAL_ITEM_VERSION_SCHEMA_VERSION,
          itemCode: selectedItem.code,
          draftRevision: revision,
          ...(selectedItem.id ? { baseProductId: selectedItem.id } : {}),
          baseProductToken: globalItemBaseProductToken(freshItem),
          product,
          savedAt: serverTimestamp(),
          savedBy: staffProfile.uid,
          savedByName: staffProfile.displayName || staffProfile.name || staffProfile.email || null,
        });
        return product;
      });
      const nextDraft: GlobalItemMasterDraft = {
        schemaVersion: GLOBAL_ITEM_VERSION_SCHEMA_VERSION,
        itemCode: selectedItem.code,
        draftRevision: revision,
        ...(selectedItem.id ? { baseProductId: selectedItem.id } : {}),
        baseProductToken: globalItemBaseProductToken(selectedItem),
        product: savedProduct,
        savedAt: new Date(),
        savedBy: staffProfile.uid,
        savedByName: staffProfile.displayName || staffProfile.name || staffProfile.email || null,
      };
      setDrafts((current) => new Map(current).set(selectedItem.code, nextDraft));
      setMasterProduct(savedProduct);
      setSavedProductToken(masterProductToken(savedProduct));
      setMessage('MASTER SAVED — NOT YET PUBLISHED. Live stores have not changed.');
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Unable to save the master draft. Nothing was saved.');
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    if (!selectedItem || !savedDraft || !staffProfile || publishDisabled) return;
    setPublishing(true);
    setError('');
    setMessage('');
    try {
      const result = await publishGlobalItemToStores(db, {
        itemCode: selectedItem.code,
        expectedMasterRevision: savedDraft.draftRevision,
        targetStoreIds: selectedStoreIds,
        publishedBy: { uid: staffProfile.uid, name: staffProfile.displayName || staffProfile.name || staffProfile.email || null },
      });
      await loadCatalogue();
      setReviewOpen(false);
      setSelectedStoreIds([]);
      setMessage(`PUBLISHED TO ${result.publishedStoreIds.length} STORE${result.publishedStoreIds.length === 1 ? '' : 'S'}. All selected stores now use this approved version.`);
    } catch (reason: unknown) {
      if (reason instanceof GlobalItemPublishError) {
        setError(`${reason.message}${reason.issues.length ? ` ${reason.issues.join(' ')}` : ''}`);
      } else {
        setError(reason instanceof Error ? reason.message : 'Publish failed. Nothing was published.');
      }
      setReviewOpen(false);
    } finally {
      setPublishing(false);
    }
  };

  if (!isAdmin) return <div className="rounded-2xl border border-red-200 bg-red-50 p-6"><h1 className="text-xl font-semibold text-red-900">Admin access required</h1><p className="mt-2 text-sm text-red-800">Global master products and multi-store publishing are available only to active Admin users.</p></div>;
  if (loading) return <div className="flex min-h-[40vh] items-center justify-center text-sm text-stone-500">Loading Global Items…</div>;

  return (
    <div className="min-h-screen bg-[#f8f6f2] pb-28 text-stone-900">
      <header className="border-b border-stone-200 bg-white px-4 py-5 sm:px-6">
        <div className="mx-auto max-w-[1500px]">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-800">Catalogue control</p><h1 className="mt-1 text-3xl font-semibold tracking-tight text-stone-950">Global Items</h1><p className="mt-1 max-w-2xl text-sm text-stone-500">Edit one protected master, choose stores, review changes, and publish one complete product version.</p></div>
            <Link to="/admin/menu-management" className="flex min-h-11 items-center gap-2 self-start rounded-xl border border-stone-300 bg-white px-4 text-sm font-semibold text-stone-700">Open source catalogue <ChevronRight className="h-4 w-4" /></Link>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1500px] gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside className={`${cardClass} self-start overflow-hidden lg:sticky lg:top-4`}>
          <div className="border-b border-stone-200 p-4"><div className="relative"><Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-stone-400" /><input className={`${inputClass} pl-9`} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search products" aria-label="Search products" /></div><p className="mt-2 text-xs text-stone-500">{filteredItems.length} products</p></div>
          <div className="max-h-[55vh] overflow-y-auto lg:max-h-[calc(100vh-220px)]">
            {filteredItems.map((item) => {
              const saved = drafts.get(item.code);
              const active = selectedCode === item.code;
              return <button key={item.id || item.code} type="button" onClick={() => chooseItem(item)} className={`flex min-h-[68px] w-full items-center gap-3 border-b border-stone-100 px-4 py-3 text-left transition ${active ? 'bg-amber-50' : 'hover:bg-stone-50'}`}><div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-stone-100">{item.imageUrl ? <img src={item.imageUrl} alt="" className="h-full w-full object-cover" /> : <Layers className="h-4 w-4 text-stone-400" />}</div><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-stone-900">{item.displayName || item.name}</p><p className="truncate text-xs text-stone-500">{item.code} · {saved ? 'Master saved' : 'No master'}</p></div><ChevronRight className="h-4 w-4 shrink-0 text-stone-400" /></button>;
            })}
          </div>
        </aside>

        <div className="min-w-0 space-y-5">
          {error && <div role="alert" className="flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div>}
          {message && <div role="status" className="flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800"><Check className="mt-0.5 h-4 w-4 shrink-0" /><span>{message}</span></div>}
          {!selectedItem || !masterProduct ? (
            <div className={`${cardClass} flex min-h-[420px] flex-col items-center justify-center p-8 text-center`}><Layers className="h-10 w-10 text-stone-300" /><h2 className="mt-4 text-xl font-semibold">Select a product</h2><p className="mt-2 max-w-md text-sm text-stone-500">Choose a product from the catalogue to open its master editor and store publishing status.</p></div>
          ) : (
            <>
              <MasterHeader item={selectedItem} product={masterProduct} saved={savedDraft} dirty={dirty} />
              <MasterEditor product={masterProduct} taxonomyDocument={taxonomyDocument} rawIngredients={rawIngredients} prepItems={prepItems} finishedGoods={items} addOnGroups={addOnGroups} issues={validationIssues} onChange={(next) => { setMasterProduct(next); setMessage(''); setError(''); }} onSave={saveMaster} saving={saving} />

              <Section title="Select stores" description="Only active stores with a valid store code can be published. Existing assignments are preserved; a newly selected store is assigned atomically at publish.">
                <button type="button" onClick={() => setSelectedStoreIds(selectedStoreIdsAfterSelectAll(selectedStoreIds, eligibleStores.map((store) => store.id)))} className="mb-3 flex min-h-11 w-full items-center justify-between rounded-xl border border-stone-300 px-4 text-sm font-semibold"><span>{allSelected ? 'Deselect all stores' : 'Select all stores'}</span><span className="text-stone-500">{selectedStoreIds.length} selected</span></button>
                <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                  {eligibleStores.map((store) => {
                    const selected = selectedStoreIds.includes(store.id);
                    const newAssignment = !isAssigned(selectedItem, store.id);
                    return <label key={store.id} className={`flex min-h-[68px] cursor-pointer items-center gap-3 rounded-xl border p-3 ${selected ? 'border-amber-700 bg-amber-50' : 'border-stone-200 bg-white'}`}><input type="checkbox" className="h-5 w-5 shrink-0 accent-amber-700" checked={selected} onChange={() => setSelectedStoreIds(selectedStoreIdsAfterToggle(selectedStoreIds, store.id))} /><StoreIcon className="h-4 w-4 shrink-0 text-stone-500" /><span className="min-w-0"><span className="block truncate text-sm font-semibold">{store.name || store.code}</span><span className="block truncate text-xs text-stone-500">{store.code}{newAssignment ? ' · Will be added to this store' : ' · Already assigned'}</span></span></label>;
                  })}
                </div>
                {eligibleStores.length === 0 && <p className="rounded-xl bg-stone-50 p-4 text-sm text-stone-500">No active stores with a valid store code are available.</p>}
              </Section>

              <Section title="Published stores" description="Compare each store’s live version with the latest saved master.">
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {eligibleStores.map((store) => {
                    const config = configs.get(storeItemConfigDocId(store.id, selectedItem.code)) || null;
                    const state = publishedStoreState(config, savedDraft?.draftRevision);
                    const effective = effectiveStoreProduct(selectedItem, config);
                    const differs = masterProduct ? publishedProductDiffersFromMaster(config, masterProduct) : null;
                    return <article key={store.id} className="rounded-xl border border-stone-200 bg-stone-50 p-4"><div className="flex items-start justify-between gap-3"><div><h4 className="font-semibold text-stone-900">{store.name || store.code}</h4><p className="text-xs text-stone-500">{store.code}</p></div><StatusPill state={state} /></div><dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 text-xs"><dt className="text-stone-500">Revision</dt><dd className="truncate text-right font-medium">{config?.publishedVersion?.publishedRevision?.slice(0, 8) || '—'}</dd><dt className="text-stone-500">Effective price</dt><dd className="text-right font-medium">{money(effective.salePrice)}</dd><dt className="text-stone-500">Availability</dt><dd className="text-right font-medium">{effective.isAvailable ? 'Available' : 'Unavailable'}</dd><dt className="text-stone-500">Customer menu</dt><dd className="text-right font-medium">{effective.menuVisible === false ? 'Hidden' : 'Visible'}</dd><dt className="text-stone-500">Last published</dt><dd className="text-right font-medium">{dateTime(config?.publishedVersion?.publishedAt)}</dd><dt className="text-stone-500">Different from master</dt><dd className="text-right font-medium">{differs === null ? 'Not published' : differs ? 'Yes' : 'No'}</dd></dl></article>;
                  })}
                </div>
              </Section>
            </>
          )}
        </div>
      </main>

      {selectedItem && masterProduct && <div className="fixed inset-x-0 bottom-0 z-30 border-t border-stone-200 bg-white/95 p-3 shadow-[0_-8px_30px_rgba(0,0,0,0.08)] backdrop-blur"><div className="mx-auto flex max-w-[1500px] flex-col gap-2 sm:flex-row sm:items-center sm:justify-end"><p className="text-center text-sm text-stone-600 sm:mr-auto sm:text-left">{!savedDraft ? 'Save the master before publishing.' : dirty ? 'Save master changes before publishing.' : validationIssues.length ? 'Resolve validation issues before publishing.' : `${selectedStoreIds.length} store${selectedStoreIds.length === 1 ? '' : 's'} selected`}</p><button type="button" disabled={publishDisabled} onClick={() => setReviewOpen(true)} className="min-h-12 rounded-xl bg-amber-800 px-6 text-sm font-semibold text-white shadow-sm disabled:cursor-not-allowed disabled:bg-stone-300">Review & publish to {selectedStoreIds.length} store{selectedStoreIds.length === 1 ? '' : 's'}</button></div></div>}

      {reviewOpen && selectedItem && masterProduct && <div className="fixed inset-0 z-50 flex items-end justify-center bg-stone-950/50 p-0 sm:items-center sm:p-5" role="dialog" aria-modal="true" aria-labelledby="publish-review-title"><div className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl"><div className="sticky top-0 flex items-start justify-between gap-4 border-b border-stone-200 bg-white p-5"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-800">Final confirmation</p><h2 id="publish-review-title" className="mt-1 text-2xl font-semibold">Review publish</h2><p className="mt-1 text-sm text-stone-500">{selectedStoreIds.length} selected store{selectedStoreIds.length === 1 ? '' : 's'} · saved master revision {savedDraft?.draftRevision.slice(0, 8)}</p></div><button type="button" onClick={() => setReviewOpen(false)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-stone-200" aria-label="Close publish review"><X className="h-5 w-5" /></button></div><div className="space-y-5 p-5"><div><h3 className="mb-2 text-sm font-semibold">Selected stores</h3><div className="flex flex-wrap gap-2">{selectedStoreIds.map((storeId) => { const store = eligibleStores.find((row) => row.id === storeId); return <span key={storeId} className="rounded-full bg-stone-100 px-3 py-1.5 text-xs font-medium">{store?.name || storeId}{!isAssigned(selectedItem, storeId) ? ' · new assignment' : ''}</span>; })}</div></div><div><h3 className="mb-2 text-sm font-semibold">Changes to live effective products</h3>{reviewChanges.length === 0 ? <p className="rounded-xl bg-stone-50 p-4 text-sm text-stone-500">No field differences detected. Publishing will still create a current approved version for the selected stores.</p> : <div className="divide-y divide-stone-100 rounded-xl border border-stone-200">{reviewChanges.map((change) => <div key={change.key} className="grid gap-1 p-3 text-sm sm:grid-cols-[150px_1fr_24px_1fr]"><span className="font-semibold text-stone-800">{change.label}</span><span className="break-words text-stone-500">{change.before}</span><ChevronRight className="hidden h-4 w-4 text-stone-400 sm:block" /><span className="break-words font-medium text-stone-900">{change.after}</span></div>)}</div>}</div><div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><strong>Atomic publish:</strong> all selected store versions, customer-menu snapshots, and any required assignments succeed together or nothing changes.</div></div><div className="sticky bottom-0 flex flex-col-reverse gap-2 border-t border-stone-200 bg-white p-5 sm:flex-row sm:justify-end"><button type="button" onClick={() => setReviewOpen(false)} className="min-h-11 rounded-xl border border-stone-300 px-5 text-sm font-semibold">Back</button><button type="button" disabled={publishing} onClick={publish} className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-amber-800 px-5 text-sm font-semibold text-white disabled:opacity-50"><PackageCheck className="h-4 w-4" />{publishing ? 'Publishing…' : `Publish to ${selectedStoreIds.length} store${selectedStoreIds.length === 1 ? '' : 's'}`}</button></div></div></div>}
    </div>
  );
}
