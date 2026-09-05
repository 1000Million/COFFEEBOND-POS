/**
 * Admin-side logic for editing per-store item overrides.
 *
 * Pure module: no Firestore imports, so the write plan, validation and rounding preview
 * can be tested directly. The page performs the Firestore call using the plan returned here.
 *
 * Precedence is NOT re-implemented here — resolveStoreItem from ./storeItemConfig remains
 * the single source of truth for effective values.
 */
import { calculateTotals } from './posPricing';
import { buildPublicMenuAvailabilitySnapshot, type PublicMenuAvailabilitySnapshot } from './publicMenuAvailability';
import { resolveStoreItem, storeItemConfigDocId, type StoreItemConfig } from './storeItemConfig';
import type { Store } from '../types';
import type { AddOnGroup, FinishedGood, PrepItem, RawIngredient } from '../types/menu-management';

/** Every override field is explicitly one or the other — never an ambiguous empty input. */
export type OverrideMode = 'INHERIT' | 'OVERRIDE';

export type OverrideDraft = {
  price: { mode: OverrideMode; value: string };
  availability: { mode: OverrideMode; value: boolean };
  menuVisibility: { mode: OverrideMode; value: boolean };
  sortOrder: { mode: OverrideMode; value: string };
};

export type OverrideWritePlan =
  | { action: 'NONE'; docId: string }
  | { action: 'DELETE'; docId: string; reason: string }
  | { action: 'SET'; docId: string; data: StoreItemConfig; overriddenFields: string[] };

export type ValidationIssue = { field: string; message: string };

/** Discount ceilings that actually exist in this POS. Kept in sync with posPricing. */
export const ROUNDING_PREVIEW_DISCOUNTS = [
  { label: 'Cashier 10%', percent: 10 },
  { label: 'Store Manager 20%', percent: 20 },
];

export function emptyDraft(): OverrideDraft {
  return {
    price: { mode: 'INHERIT', value: '' },
    availability: { mode: 'INHERIT', value: true },
    menuVisibility: { mode: 'INHERIT', value: true },
    sortOrder: { mode: 'INHERIT', value: '' },
  };
}

/** Rebuilds the editor state from a stored document. Absent field => INHERIT. */
export function draftFromConfig(config: StoreItemConfig | null | undefined): OverrideDraft {
  const draft = emptyDraft();
  const has = (key: keyof StoreItemConfig) =>
    !!config && Object.prototype.hasOwnProperty.call(config, key)
    && config[key] !== undefined && config[key] !== null;

  if (has('priceOverride')) {
    draft.price = { mode: 'OVERRIDE', value: String(config!.priceOverride) };
  }
  if (has('isAvailableOverride')) {
    draft.availability = { mode: 'OVERRIDE', value: config!.isAvailableOverride === true };
  }
  if (has('menuVisibilityOverride')) {
    draft.menuVisibility = { mode: 'OVERRIDE', value: config!.menuVisibilityOverride === true };
  }
  if (has('sortOrderOverride')) {
    draft.sortOrder = { mode: 'OVERRIDE', value: String(config!.sortOrderOverride) };
  }
  return draft;
}

function parsedNumber(raw: string): number | null {
  const trimmed = String(raw ?? '').trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function validateOverrideDraft(
  draft: OverrideDraft,
  context: { isAssigned: boolean },
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!context.isAssigned) {
    issues.push({ field: 'store', message: 'This item is not assigned to this store. Assign it in Menu Management before setting an override.' });
  }
  if (draft.price.mode === 'OVERRIDE') {
    const price = parsedNumber(draft.price.value);
    if (price === null) issues.push({ field: 'price', message: 'Enter a price, or switch back to Inherit global.' });
    else if (price < 0) issues.push({ field: 'price', message: 'Price cannot be negative.' });
  }
  if (draft.sortOrder.mode === 'OVERRIDE') {
    const sortOrder = parsedNumber(draft.sortOrder.value);
    if (sortOrder === null) issues.push({ field: 'sortOrder', message: 'Enter a display order, or switch back to Inherit global.' });
    else if (!Number.isInteger(sortOrder)) issues.push({ field: 'sortOrder', message: 'Display order must be a whole number.' });
    else if (sortOrder < 0) issues.push({ field: 'sortOrder', message: 'Display order cannot be negative.' });
  }
  return issues;
}

/**
 * Turns editor state into the exact Firestore action.
 *
 * A field left on INHERIT is simply absent from the written document, so the resolver
 * falls through to the global value. When every field inherits there is nothing left to
 * store and the document is deleted rather than left behind as an empty shell.
 */
export function buildOverrideWritePlan(input: {
  storeId: string;
  itemCode: string;
  draft: OverrideDraft;
  existing?: StoreItemConfig | null;
  updatedBy: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}): OverrideWritePlan {
  const docId = storeItemConfigDocId(input.storeId, input.itemCode);
  const draft = input.draft;
  const data: StoreItemConfig = { storeId: input.storeId, itemCode: input.itemCode };
  const overriddenFields: string[] = [];

  if (draft.price.mode === 'OVERRIDE') {
    const price = parsedNumber(draft.price.value);
    if (price !== null) { data.priceOverride = price; overriddenFields.push('priceOverride'); }
  }
  if (draft.availability.mode === 'OVERRIDE') {
    data.isAvailableOverride = draft.availability.value === true;
    overriddenFields.push('isAvailableOverride');
  }
  if (draft.menuVisibility.mode === 'OVERRIDE') {
    data.menuVisibilityOverride = draft.menuVisibility.value === true;
    overriddenFields.push('menuVisibilityOverride');
  }
  if (draft.sortOrder.mode === 'OVERRIDE') {
    const sortOrder = parsedNumber(draft.sortOrder.value);
    if (sortOrder !== null) { data.sortOrderOverride = sortOrder; overriddenFields.push('sortOrderOverride'); }
  }

  if (overriddenFields.length === 0) {
    return input.existing
      ? { action: 'DELETE', docId, reason: 'Every field inherits the global value, so no override document is needed.' }
      : { action: 'NONE', docId };
  }

  data.updatedBy = input.updatedBy;
  if (input.updatedAt !== undefined) data.updatedAt = input.updatedAt;
  if (input.createdAt !== undefined) data.createdAt = input.createdAt;
  return { action: 'SET', docId, data, overriddenFields };
}

export type ResolvedComparison = {
  field: 'price' | 'availability' | 'menuVisibility' | 'sortOrder';
  label: string;
  globalValue: string;
  currentValue: string;
  nextValue: string;
  changed: boolean;
  overridden: boolean;
};

const money = (value: number) => `₹${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Builds the before/after preview using the shared resolver, so what the admin is shown
 * is produced by exactly the code the POS and customer menu run.
 */
export function buildResolvedComparison(
  item: FinishedGood,
  existing: StoreItemConfig | null | undefined,
  draft: OverrideDraft,
  storeId: string,
): ResolvedComparison[] {
  const plan = buildOverrideWritePlan({ storeId, itemCode: item.code, draft, existing, updatedBy: '' });
  const nextConfig = plan.action === 'SET' ? plan.data : null;

  const globalResolved = resolveStoreItem(item, null);
  const currentResolved = resolveStoreItem(item, existing || null);
  const nextResolved = resolveStoreItem(item, nextConfig);
  const overridden = new Set(nextResolved.appliedOverrides);

  return [
    {
      field: 'price', label: 'Price',
      globalValue: money(globalResolved.salePrice),
      currentValue: money(currentResolved.salePrice),
      nextValue: money(nextResolved.salePrice),
      changed: currentResolved.salePrice !== nextResolved.salePrice,
      overridden: overridden.has('priceOverride'),
    },
    {
      field: 'availability', label: 'Store availability',
      globalValue: globalResolved.isAvailable === false ? 'Unavailable' : 'Available',
      currentValue: currentResolved.isAvailable === false ? 'Unavailable' : 'Available',
      nextValue: nextResolved.isAvailable === false ? 'Unavailable' : 'Available',
      changed: (currentResolved.isAvailable !== false) !== (nextResolved.isAvailable !== false),
      overridden: overridden.has('isAvailableOverride'),
    },
    {
      field: 'menuVisibility', label: 'Customer menu visibility',
      globalValue: 'Visible',
      currentValue: currentResolved.menuVisible === false ? 'Hidden' : 'Visible',
      nextValue: nextResolved.menuVisible === false ? 'Hidden' : 'Visible',
      changed: currentResolved.menuVisible !== nextResolved.menuVisible,
      overridden: overridden.has('menuVisibilityOverride'),
    },
    {
      field: 'sortOrder', label: 'Display order',
      globalValue: String(globalResolved.sortOrder ?? 0),
      currentValue: String(currentResolved.sortOrder ?? 0),
      nextValue: String(nextResolved.sortOrder ?? 0),
      changed: (currentResolved.sortOrder ?? 0) !== (nextResolved.sortOrder ?? 0),
      overridden: overridden.has('sortOrderOverride'),
    },
  ];
}

export type RoundingPreviewRow = { label: string; percent: number; payable: number; fractional: boolean };
export type RoundingPreview = { rows: RoundingPreviewRow[]; hasFractionalPaise: boolean };

function hasSubPaiseFraction(value: number): boolean {
  return Math.abs(value * 100 - Math.round(value * 100)) > 1e-9;
}

/**
 * Non-blocking preview only. Runs the real POS totals maths at the discount ceilings that
 * exist, and reports whether any lands below paise precision.
 *
 * Since G7.2 quantized transaction totals to a canonical 2dp (ROUND_HALF_UP), this should
 * always report no fractional paise. It is retained as a REGRESSION GUARD: if unquantized
 * totals are ever reintroduced upstream, this preview surfaces it to the operator again.
 */
export function buildRoundingPreview(effectivePrice: number, taxRate: number | null | undefined, fallbackTaxRate: number): RoundingPreview {
  const rows = ROUNDING_PREVIEW_DISCOUNTS.map(({ label, percent }) => {
    const payable = calculateTotals(
      [{ price: effectivePrice, quantity: 1, addOns: [], taxRate: taxRate ?? null }],
      percent,
      fallbackTaxRate,
    ).grandTotal;
    return { label, percent, payable, fractional: hasSubPaiseFraction(payable) };
  });
  return { rows, hasFractionalPaise: rows.some((row) => row.fractional) };
}


/**
 * Projects the store's override rows to the state they will have AFTER a plan is applied,
 * without writing anything. This is what lets the customer-menu snapshot be built for the
 * post-save world inside the same transaction, instead of writing the override first and
 * rebuilding afterwards (which is what left POS and customers out of step).
 */
export function projectStoreConfigsAfterPlan(
  storeConfigs: StoreItemConfig[],
  itemCode: string,
  plan: OverrideWritePlan,
): StoreItemConfig[] {
  const others = (storeConfigs || []).filter((row) => row && row.itemCode !== itemCode);
  return plan.action === 'SET' ? [...others, plan.data] : others;
}

export type OverridePublishPlan = {
  overridePlan: OverrideWritePlan;
  projectedConfigs: StoreItemConfig[];
  snapshot: PublicMenuAvailabilitySnapshot;
  snapshotDocId: string;
};

/**
 * Builds everything a single atomic publish needs: the override action, and the customer
 * menu snapshot as it will look once that action has been applied.
 *
 * The snapshot comes from the canonical buildPublicMenuAvailabilitySnapshot, so images,
 * add-ons, BOM/composite blocking, GST, identity, assignments, visibility and sort order
 * all keep their existing behaviour. Nothing here patches a snapshot field by hand.
 *
 * Throws if the destination store has no code — the snapshot document is keyed by store
 * CODE, and guessing one would publish to the wrong document.
 */
export function buildOverridePublishPlan(input: {
  store: Store & { id: string };
  itemCode: string;
  draft: OverrideDraft;
  existing?: StoreItemConfig | null;
  storeConfigs: StoreItemConfig[];
  finishedGoods: FinishedGood[];
  rawIngredients?: RawIngredient[];
  prepItems?: PrepItem[];
  addOnGroups?: AddOnGroup[];
  updatedBy: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}): OverridePublishPlan {
  const snapshotDocId = String(input.store.code || '').trim();
  if (!snapshotDocId) {
    throw new Error('This store has no store code, so its customer menu snapshot cannot be published.');
  }

  const overridePlan = buildOverrideWritePlan({
    storeId: input.store.id,
    itemCode: input.itemCode,
    draft: input.draft,
    existing: input.existing,
    updatedBy: input.updatedBy,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  });

  const projectedConfigs = projectStoreConfigsAfterPlan(input.storeConfigs, input.itemCode, overridePlan);

  const snapshot = buildPublicMenuAvailabilitySnapshot({
    store: input.store,
    finishedGoods: input.finishedGoods,
    // The canonical builder does not read storeStock; availability comes from BOM and
    // composite structure. Passing [] keeps this save from loading the whole stock table.
    storeStock: [],
    rawIngredients: input.rawIngredients || [],
    prepItems: input.prepItems || [],
    addOnGroups: input.addOnGroups || [],
    storeItemConfigs: projectedConfigs,
  });

  return { overridePlan, projectedConfigs, snapshot, snapshotDocId };
}
