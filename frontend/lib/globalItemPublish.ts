import {
  collection,
  doc,
  getDoc,
  getDocs,
  runTransaction,
  serverTimestamp,
  type DocumentData,
  type DocumentReference,
  type Firestore,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import type { Store } from '../types';
import type {
  AddOnGroup,
  BOMComponent,
  FinishedGood,
  PrepItem,
  RawIngredient,
} from '../types/menu-management';
import {
  FULL_VERSION_MANAGEMENT_MODE,
  GLOBAL_ITEM_MASTER_DRAFT_COLLECTION,
  GLOBAL_ITEM_VERSION_SCHEMA_VERSION,
  globalItemMasterDraftDocId,
  type GlobalItemMasterDraft,
  type GlobalItemProductVersion,
  type PublishedStoreProductVersion,
} from '../types/global-items';
import { normalizeAddOnOptionIdsByGroup, uniqueAddOnGroupIds } from './addOns';
import { buildPublicMenuAvailabilitySnapshot, type PublicMenuAvailabilitySnapshot } from './publicMenuAvailability';
import { classifyPosMenuItemWithCategories } from './posMenuNavigation';
import {
  activePosMenuCategories,
  POS_MENU_TAXONOMY_DOCUMENT_PATH,
  resolvePosMenuTaxonomy,
} from './posMenuTaxonomy';
import {
  STORE_ITEM_CONFIG_COLLECTION,
  resolveStoreItem,
  storeItemConfigDocId,
  type StoreItemConfig,
} from './storeItemConfig';
import { canonicalDataToken, snapshotRevisionToken } from './storeItemConfigAdmin';
import {
  isDirectlySellableProductRole,
  productTypeSemanticIssues,
  resolveFinishedGoodProductType,
} from './productType';

export const GLOBAL_ITEM_ASSIGNMENT_SOURCE_FIELD = 'finishedGoods.availableStoreIds' as const;
export const MAX_GLOBAL_ITEM_PUBLISH_STORES = 200;

export type GlobalItemPublishErrorCode =
  | 'REJECTED_STALE_MASTER'
  | 'REJECTED_INVALID_REQUEST'
  | 'REJECTED_INVALID_MASTER'
  | 'REJECTED_TARGET_STORE'
  | 'REJECTED_VALIDATION'
  | 'REJECTED_SOURCE_CHANGED';

export class GlobalItemPublishError extends Error {
  readonly code: GlobalItemPublishErrorCode;
  readonly issues: string[];

  constructor(code: GlobalItemPublishErrorCode, message: string, issues: string[] = []) {
    super(message);
    this.name = 'GlobalItemPublishError';
    this.code = code;
    this.issues = issues;
  }
}

export type PublishGlobalItemInput = {
  itemCode: string;
  expectedMasterRevision: string;
  targetStoreIds: string[];
  publishedBy: { uid: string; name?: string | null };
};

export type PublishGlobalItemResult = {
  itemCode: string;
  sourceDraftRevision: string;
  publishedRevision: string;
  publishedStoreIds: string[];
  assignmentAddedStoreIds: string[];
  snapshotDocumentIds: string[];
  managementMode: typeof FULL_VERSION_MANAGEMENT_MODE;
};

export type ProductPublishSources = {
  finishedGoods: FinishedGood[];
  rawIngredients: RawIngredient[];
  prepItems: PrepItem[];
  addOnGroups: AddOnGroup[];
  taxonomyDocument?: unknown;
};

type SourceDocument = {
  ref: DocumentReference<DocumentData>;
  token: string;
};

type LoadedSource<T extends { id?: string }> = {
  row: T;
  snapshot: QueryDocumentSnapshot<DocumentData>;
};

type StorePublishPlan = {
  store: Store & { id: string };
  storeToken: string;
  configRef: DocumentReference<DocumentData>;
  expectedConfigToken: string;
  configData: StoreItemConfig;
  snapshotRef: DocumentReference<DocumentData>;
  expectedSnapshotRevision: string;
  snapshotData: PublicMenuAvailabilitySnapshot;
};

function requiredText(value: unknown, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new GlobalItemPublishError('REJECTED_INVALID_REQUEST', `${label} is required.`);
  }
  return normalized;
}

function uniqueRequiredIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new GlobalItemPublishError('REJECTED_INVALID_REQUEST', `${label} must be an array.`);
  }
  const ids = value.map((entry) => requiredText(entry, label));
  if (new Set(ids).size !== ids.length) {
    throw new GlobalItemPublishError('REJECTED_INVALID_REQUEST', `${label} cannot contain duplicates.`);
  }
  return ids;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasOwn(config: StoreItemConfig | null | undefined, key: keyof StoreItemConfig): boolean {
  return !!config
    && Object.prototype.hasOwnProperty.call(config, key)
    && config[key] !== undefined
    && config[key] !== null;
}

function newRevision(): string {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Assignment changes are publication bookkeeping, not a master-product edit. Excluding
 * only that array lets one saved draft be rolled out to stores in more than one operation
 * without weakening conflict detection for any actual product field.
 */
export function globalItemBaseProductToken(product: FinishedGood): string {
  const { availableStoreIds: _assignmentOnly, ...masterProduct } = product;
  return canonicalDataToken(masterProduct);
}

/**
 * First-publication migration policy: an existing legacy override is copied into the
 * complete version so customer-visible behavior remains stable during the authority
 * handoff. Once a publishedVersion exists, later publications use the draft as-is.
 */
export function completePublishedProduct(input: {
  draftProduct: GlobalItemProductVersion;
  baseProduct: FinishedGood;
  storeId: string;
  existingConfig?: StoreItemConfig | null;
}): GlobalItemProductVersion {
  const productType = resolveFinishedGoodProductType(input.draftProduct);
  const product: GlobalItemProductVersion = {
    ...input.draftProduct,
    ...(productType ? { productType } : {}),
    availableStoreIds: [input.storeId],
  };
  const enforceInternalRole = () => {
    if (product.productType === 'INTERNAL_COMPONENT') {
      product.isSellable = false;
      product.menuVisible = false;
    }
  };
  enforceInternalRole();
  if (input.existingConfig?.publishedVersion) return product;

  const legacy = resolveStoreItem(input.baseProduct, input.existingConfig);
  if (hasOwn(input.existingConfig, 'priceOverride') && finiteNumber(legacy.salePrice)) {
    product.salePrice = legacy.salePrice;
  }
  if (hasOwn(input.existingConfig, 'isAvailableOverride')) {
    product.isAvailable = legacy.isAvailable;
  }
  if (hasOwn(input.existingConfig, 'menuVisibilityOverride')) {
    product.menuVisible = legacy.menuVisible;
  }
  if (hasOwn(input.existingConfig, 'sortOrderOverride') && finiteNumber(legacy.sortOrder)) {
    product.sortOrder = legacy.sortOrder;
  }
  enforceInternalRole();
  return product;
}

function componentType(line: BOMComponent): string {
  return String(line.componentType || '').trim();
}

/** Validates every reference carried by the complete version before any write occurs. */
export function validateGlobalItemProductForPublish(
  product: GlobalItemProductVersion,
  sources: ProductPublishSources,
): string[] {
  const issues: string[] = [];
  const push = (message: string) => {
    if (!issues.includes(message)) issues.push(message);
  };
  if (!String(product.code || '').trim()) push('Product code is required.');
  if (!String(product.name || product.displayName || '').trim()) push('Product name is required.');
  if (!finiteNumber(product.salePrice) || product.salePrice < 0) push('Price must be a finite number greater than or equal to zero.');
  if (!finiteNumber(product.taxRate) || product.taxRate < 0 || product.taxRate > 100) push('Tax must be between 0 and 100.');
  if (!finiteNumber(product.sortOrder) || !Number.isInteger(product.sortOrder) || product.sortOrder < 0) {
    push('Sort order must be a whole number greater than or equal to zero.');
  }
  if (!['BARISTA', 'KITCHEN', 'BOTH', 'NONE'].includes(String(product.prepStation || ''))) push('KOT/prep station is invalid.');
  if (!['MADE_TO_ORDER', 'DIRECT_STOCK', 'NO_STOCK'].includes(String(product.itemType || ''))) push('Finished-good item type is invalid.');
  if (product.productionMode && !['MADE_TO_ORDER', 'ASSEMBLED_TO_ORDER', 'BOUGHT_AND_SOLD', 'NO_STOCK'].includes(product.productionMode)) {
    push('Production mode is invalid.');
  }
  if (typeof product.isActive !== 'boolean' || typeof product.isSellable !== 'boolean'
    || typeof product.isAvailable !== 'boolean' || typeof product.menuVisible !== 'boolean') {
    push('Active, sellable, availability, and visibility values must be explicit booleans.');
  }
  productTypeSemanticIssues(product).forEach(push);

  const imageUrl = typeof product.imageUrl === 'string' ? product.imageUrl.trim() : '';
  const imagePath = typeof product.imageStoragePath === 'string' ? product.imageStoragePath.trim() : '';
  if (product.imageUrl !== undefined && product.imageUrl !== null && !imageUrl) push('Image URL cannot be blank.');
  if (imageUrl && !/^https?:\/\//i.test(imageUrl)) push('Image URL must be an HTTP(S) URL.');
  if (product.imageStoragePath !== undefined && product.imageStoragePath !== null && !imagePath) push('Image storage path cannot be blank.');
  if (imagePath && !imageUrl) push('An image storage path requires an image URL.');
  if (product.imageSource === 'ADMIN_UPLOAD' && (!imageUrl || !imagePath)) push('Admin-uploaded images require both URL and storage path metadata.');

  const categories = activePosMenuCategories(resolvePosMenuTaxonomy(sources.taxonomyDocument).taxonomy);
  const classification = classifyPosMenuItemWithCategories(product, categories);
  if (!classification.isClassified) push(`Category reference is invalid: ${classification.reason || 'unknown category'}.`);

  const rawByCode = new Map(sources.rawIngredients.map((row) => [row.code, row]));
  const prepByCode = new Map(sources.prepItems.map((row) => [row.code, row]));
  const finishedByCode = new Map(sources.finishedGoods.map((row) => [row.code, row]));
  finishedByCode.set(product.code, product);
  const validComponentTypes = new Set(['RAW_INGREDIENT', 'PREP_ITEM', 'BOUGHT_COMPONENT', 'FINISHED_GOOD', 'PACKAGING']);

  const validateBom = (
    bom: BOMComponent[],
    parentCode: string,
    visitedFinished: Set<string>,
    visitedPrep: Set<string>,
  ) => {
    const seen = new Set<string>();
    for (const line of bom) {
      const code = String(line.componentCode || '').trim();
      const type = componentType(line);
      if (!code || !type || !validComponentTypes.has(type)) {
        push(`BOM for ${parentCode} contains an invalid component reference.`);
        continue;
      }
      if (seen.has(code)) push(`BOM for ${parentCode} contains duplicate component ${code}.`);
      seen.add(code);
      if (code === parentCode) push(`BOM for ${parentCode} contains a self reference.`);
      if (!finiteNumber(line.quantity) || line.quantity <= 0 || !String(line.uom || '').trim()) {
        push(`BOM component ${code} requires a positive quantity and UOM.`);
      }
      if (type === 'RAW_INGREDIENT' || type === 'PACKAGING' || type === 'BOUGHT_COMPONENT') {
        if (!rawByCode.has(code) || rawByCode.get(code)?.isActive === false) push(`BOM component ${code} does not reference an active stock master.`);
        continue;
      }
      if (type === 'PREP_ITEM') {
        const prep = prepByCode.get(code);
        if (!prep || prep.isActive === false) {
          push(`BOM component ${code} does not reference an active prep item.`);
          continue;
        }
        if (visitedPrep.has(code)) {
          push(`BOM contains a circular prep-item reference at ${code}.`);
          continue;
        }
        if (!prep.isStockTracked) {
          if (!Array.isArray(prep.bom) || prep.bom.length === 0) push(`Prep item ${code} has no valid BOM.`);
          else validateBom(prep.bom, code, visitedFinished, new Set(visitedPrep).add(code));
        }
        continue;
      }
      const child = finishedByCode.get(code);
      if (!child || child.isActive === false) {
        push(`BOM component ${code} does not reference an active finished good.`);
        continue;
      }
      if (visitedFinished.has(code)) {
        push(`BOM contains a circular finished-good reference at ${code}.`);
        continue;
      }
      if (Array.isArray(child.bom) && child.bom.length > 0) {
        validateBom(child.bom, code, new Set(visitedFinished).add(code), visitedPrep);
      }
    }
  };

  if (!Array.isArray(product.bom)) push('BOM must be an array.');
  else {
    const requiresBom = resolveFinishedGoodProductType(product) !== 'COMPOSITE_PARENT' && (
      product.itemType === 'MADE_TO_ORDER'
      || product.productionMode === 'MADE_TO_ORDER'
      || product.productionMode === 'ASSEMBLED_TO_ORDER'
    );
    if (requiresBom && product.bom.length === 0) push('Made-to-order products require a BOM.');
    validateBom(product.bom, product.code, new Set([product.code]), new Set());
  }

  const groupIds = uniqueAddOnGroupIds(product.addOnGroupIds);
  const rawGroupIds = Array.isArray(product.addOnGroupIds) ? product.addOnGroupIds : [];
  if (groupIds.length !== rawGroupIds.length) push('Add-on group IDs must be unique, non-empty strings.');
  const groupsById = new Map(sources.addOnGroups.filter((group) => group.id).map((group) => [group.id as string, group]));
  const optionIdsByGroup = normalizeAddOnOptionIdsByGroup(product.addOnOptionIdsByGroup);
  for (const key of Object.keys(optionIdsByGroup)) {
    if (!groupIds.includes(key)) push(`Add-on option mapping ${key} has no assigned group.`);
  }
  for (const groupId of groupIds) {
    const group = groupsById.get(groupId);
    if (!group || group.isActive === false) {
      push(`Add-on group ${groupId} does not exist or is inactive.`);
      continue;
    }
    const selectedIds = optionIdsByGroup[groupId] || [];
    const rawSelectedIds = product.addOnOptionIdsByGroup?.[groupId];
    if (!Array.isArray(rawSelectedIds) || rawSelectedIds.length !== selectedIds.length) {
      push(`Add-on options for ${groupId} must be unique, non-empty IDs.`);
    }
    if (selectedIds.length === 0) push(`Add-on group ${groupId} has no published options.`);
    const activeOptions = new Set((group.options || []).filter((option) => option.isActive !== false).map((option) => option.id));
    for (const optionId of selectedIds) {
      if (!activeOptions.has(optionId)) push(`Add-on option ${groupId}/${optionId} does not exist or is inactive.`);
    }
  }

  if (product.composite) {
    if (product.composite.schemaVersion !== 1
      || !Array.isArray(product.composite.staticComponents)
      || !Array.isArray(product.composite.choiceGroupIds)) {
      push('Composite product definition is invalid.');
    } else {
      for (const child of product.composite.staticComponents) {
        const referenced = sources.finishedGoods.find((row) => row.id === child.finishedGoodId && row.code === child.finishedGoodCode);
        if (!referenced || referenced.isActive === false || !finiteNumber(child.quantity) || child.quantity <= 0) {
          push(`Composite child ${child.finishedGoodCode || 'unknown'} is invalid.`);
        }
      }
      for (const groupId of product.composite.choiceGroupIds) {
        const group = groupsById.get(groupId);
        if (!group || group.isActive === false || group.purpose !== 'COMPOSITE_CHOICE') {
          push(`Composite choice group ${groupId} is invalid.`);
        }
      }
    }
    if (Array.isArray(product.unresolvedCompositeRequirements) && product.unresolvedCompositeRequirements.length > 0) {
      push('Composite product has unresolved component requirements.');
    }
  }
  return issues;
}

function asLoaded<T extends { id?: string }>(
  snapshots: QueryDocumentSnapshot<DocumentData>[],
): LoadedSource<T>[] {
  return snapshots.map((snapshot) => ({
    snapshot,
    row: { ...(snapshot.data() as T), id: snapshot.id },
  }));
}

function sourceChanged(message: string): never {
  throw new GlobalItemPublishError('REJECTED_SOURCE_CHANGED', `${message} Nothing was published.`);
}

function assertMasterDraft(value: unknown, itemCode: string): GlobalItemMasterDraft {
  if (!value || typeof value !== 'object') {
    throw new GlobalItemPublishError('REJECTED_INVALID_MASTER', `No master draft exists for ${itemCode}.`);
  }
  const draft = value as GlobalItemMasterDraft;
  if (draft.schemaVersion !== GLOBAL_ITEM_VERSION_SCHEMA_VERSION
    || String(draft.itemCode || '').trim() !== itemCode
    || !String(draft.draftRevision || '').trim()
    || !String(draft.baseProductToken || '').trim()
    || !draft.product
    || String(draft.product.code || '').trim() !== itemCode) {
    throw new GlobalItemPublishError('REJECTED_INVALID_MASTER', `The master draft for ${itemCode} is incomplete or has invalid identity.`);
  }
  return draft;
}

function draftMatchesBase(draft: GlobalItemMasterDraft, baseProduct: FinishedGood): boolean {
  if (draft.baseProductToken === globalItemBaseProductToken(baseProduct)) return true;
  // Compatibility with a G8.1 draft token that included the assignment array. This
  // remains valid after earlier selected-store publications add assignments only.
  return draft.baseProductToken === canonicalDataToken({
    ...baseProduct,
    availableStoreIds: Array.isArray(draft.product.availableStoreIds)
      ? draft.product.availableStoreIds
      : baseProduct.availableStoreIds,
  });
}

function storeConfigData(configSnapshot: QueryDocumentSnapshot<DocumentData> | undefined): StoreItemConfig | null {
  return configSnapshot ? configSnapshot.data() as StoreItemConfig : null;
}

function buildPublishedVersion(input: {
  draft: GlobalItemMasterDraft;
  baseProduct: FinishedGood;
  storeId: string;
  existingConfig: StoreItemConfig | null;
  publishedRevision: string;
  publishedAt: unknown;
  publishedBy: PublishGlobalItemInput['publishedBy'];
}): PublishedStoreProductVersion {
  return {
    schemaVersion: GLOBAL_ITEM_VERSION_SCHEMA_VERSION,
    storeId: input.storeId,
    itemCode: input.draft.itemCode,
    publishedRevision: input.publishedRevision,
    sourceDraftRevision: input.draft.draftRevision,
    previousPublishedRevision: input.existingConfig?.publishedVersion?.publishedRevision || null,
    product: completePublishedProduct({
      draftProduct: input.draft.product,
      baseProduct: input.baseProduct,
      storeId: input.storeId,
      existingConfig: input.existingConfig,
    }),
    publishedAt: input.publishedAt,
    publishedBy: input.publishedBy.uid,
    ...(input.publishedBy.name ? { publishedByName: input.publishedBy.name } : {}),
  };
}

function assignmentAfterPublish(current: unknown, targetStoreIds: string[]): {
  value: string[];
  added: string[];
  changed: boolean;
} {
  const original = Array.isArray(current) ? [...current] as string[] : [];
  // Protected baseline semantics: an empty array means globally assigned already.
  if (original.length === 0) return { value: original, added: [], changed: false };
  const next = [...original];
  const added: string[] = [];
  for (const storeId of targetStoreIds) {
    if (!next.includes(storeId)) {
      next.push(storeId);
      added.push(storeId);
    }
  }
  return { value: next, added, changed: added.length > 0 };
}

/**
 * Canonical G8.2 operation. The request carries identity/revision/targets only; product
 * data is loaded from the protected master-draft collection. Every selected config and
 * public snapshot plus any assignment addition is committed by one Firestore transaction.
 */
export async function publishGlobalItemToStores(
  firestore: Firestore,
  request: PublishGlobalItemInput,
): Promise<PublishGlobalItemResult> {
  const itemCode = requiredText(request.itemCode, 'Item code');
  const expectedMasterRevision = requiredText(request.expectedMasterRevision, 'Expected master revision');
  const targetStoreIds = uniqueRequiredIds(request.targetStoreIds, 'Target store IDs');
  const publishedByUid = requiredText(request.publishedBy?.uid, 'Publisher UID');
  if (targetStoreIds.length === 0) {
    throw new GlobalItemPublishError('REJECTED_INVALID_REQUEST', 'Select at least one target store.');
  }
  if (targetStoreIds.length > MAX_GLOBAL_ITEM_PUBLISH_STORES) {
    throw new GlobalItemPublishError('REJECTED_INVALID_REQUEST', `A publish operation can target at most ${MAX_GLOBAL_ITEM_PUBLISH_STORES} stores.`);
  }

  const actor = { uid: publishedByUid, name: request.publishedBy.name?.trim() || null };
  const draftRef = doc(firestore, GLOBAL_ITEM_MASTER_DRAFT_COLLECTION, globalItemMasterDraftDocId(itemCode));
  const draftSnapshot = await getDoc(draftRef);
  const draft = assertMasterDraft(draftSnapshot.exists() ? draftSnapshot.data() : null, itemCode);
  if (draft.draftRevision !== expectedMasterRevision) {
    throw new GlobalItemPublishError('REJECTED_STALE_MASTER', 'REJECTED_STALE_MASTER: the master draft changed. Nothing was published.');
  }

  const taxonomyRef = doc(firestore, POS_MENU_TAXONOMY_DOCUMENT_PATH);
  const [finishedSnapshot, storeSnapshot, configSnapshot, rawSnapshot, prepSnapshot, addOnSnapshot, taxonomySnapshot] = await Promise.all([
    getDocs(collection(firestore, 'finishedGoods')),
    getDocs(collection(firestore, 'stores')),
    getDocs(collection(firestore, STORE_ITEM_CONFIG_COLLECTION)),
    getDocs(collection(firestore, 'rawIngredients')),
    getDocs(collection(firestore, 'prepItems')),
    getDocs(collection(firestore, 'addOnGroups')),
    getDoc(taxonomyRef),
  ]);

  const loadedFinished = asLoaded<FinishedGood>(finishedSnapshot.docs);
  const loadedStores = asLoaded<Store>(storeSnapshot.docs);
  const loadedRaw = asLoaded<RawIngredient>(rawSnapshot.docs);
  const loadedPrep = asLoaded<PrepItem>(prepSnapshot.docs);
  const loadedAddOns = asLoaded<AddOnGroup>(addOnSnapshot.docs);
  const finishedGoods = loadedFinished.map((entry) => entry.row);
  const baseCandidates = loadedFinished.filter((entry) => (
    (draft.baseProductId && entry.snapshot.id === draft.baseProductId)
    || entry.row.code === itemCode
  ));
  const baseSource = draft.baseProductId
    ? baseCandidates.find((entry) => entry.snapshot.id === draft.baseProductId)
    : baseCandidates.length === 1 ? baseCandidates[0] : undefined;
  if (!baseSource || baseSource.row.code !== itemCode) {
    throw new GlobalItemPublishError('REJECTED_INVALID_MASTER', `The finishedGoods source for ${itemCode} is missing or ambiguous.`);
  }
  const baseProduct = baseSource.row;
  if (!draftMatchesBase(draft, baseProduct)) {
    throw new GlobalItemPublishError('REJECTED_SOURCE_CHANGED', 'The finishedGoods source changed after the master draft was saved. Nothing was published.');
  }

  const storesById = new Map(loadedStores.map((entry) => [entry.snapshot.id, entry]));
  const targets = targetStoreIds.map((storeId) => {
    const loaded = storesById.get(storeId);
    if (!loaded || loaded.row.isActive !== true || !String(loaded.row.code || '').trim()) {
      throw new GlobalItemPublishError('REJECTED_TARGET_STORE', `Target store ${storeId} is missing, inactive, or has no store code.`);
    }
    return loaded;
  });
  if (new Set(targets.map((entry) => entry.row.code)).size !== targets.length) {
    throw new GlobalItemPublishError('REJECTED_TARGET_STORE', 'Selected stores must have unique store codes.');
  }

  const validationSources: ProductPublishSources = {
    finishedGoods,
    rawIngredients: loadedRaw.map((entry) => entry.row),
    prepItems: loadedPrep.map((entry) => entry.row),
    addOnGroups: loadedAddOns.map((entry) => entry.row),
    taxonomyDocument: taxonomySnapshot.exists() ? taxonomySnapshot.data() : null,
  };
  const genericIssues = validateGlobalItemProductForPublish(draft.product, validationSources);
  if (genericIssues.length > 0) {
    throw new GlobalItemPublishError('REJECTED_VALIDATION', `Master draft validation failed. Nothing was published. ${genericIssues.join(' ')}`, genericIssues);
  }

  // Guard the exact referenced masters in the same transaction that publishes the
  // versions. Validation cannot race a component/add-on deletion or mutation.
  const referenceDocuments = new Map<string, SourceDocument>();
  const rawSourceByCode = new Map(loadedRaw.map((entry) => [entry.row.code, entry]));
  const prepSourceByCode = new Map(loadedPrep.map((entry) => [entry.row.code, entry]));
  const finishedSourceByCode = new Map(loadedFinished.map((entry) => [entry.row.code, entry]));
  const addOnSourceById = new Map(loadedAddOns.map((entry) => [entry.row.id as string, entry]));
  const protect = (snapshot: QueryDocumentSnapshot<DocumentData> | undefined) => {
    if (!snapshot || snapshot.ref.path === baseSource.snapshot.ref.path) return;
    referenceDocuments.set(snapshot.ref.path, {
      ref: snapshot.ref,
      token: canonicalDataToken(snapshot.data()),
    });
  };
  const protectedFinished = new Set<string>();
  const protectedPrep = new Set<string>();
  const protectBom = (bom: BOMComponent[]) => {
    for (const line of bom || []) {
      const code = String(line.componentCode || '').trim();
      const type = componentType(line);
      if (type === 'RAW_INGREDIENT' || type === 'PACKAGING' || type === 'BOUGHT_COMPONENT') {
        protect(rawSourceByCode.get(code)?.snapshot);
      } else if (type === 'PREP_ITEM') {
        const prep = prepSourceByCode.get(code);
        protect(prep?.snapshot);
        if (prep && !protectedPrep.has(code)) {
          protectedPrep.add(code);
          protectBom(prep.row.bom || []);
        }
      } else if (type === 'FINISHED_GOOD') {
        protectFinishedCode(code);
      }
    }
  };
  const protectFinishedCode = (code: string) => {
    if (protectedFinished.has(code)) return;
    protectedFinished.add(code);
    const child = finishedSourceByCode.get(code);
    protect(child?.snapshot);
    if (!child) return;
    protectBom(child.row.bom || []);
    for (const reference of child.row.composite?.staticComponents || []) {
      protectFinishedCode(reference.finishedGoodCode);
    }
  };
  protectBom(draft.product.bom || []);
  for (const reference of draft.product.composite?.staticComponents || []) {
    protectFinishedCode(reference.finishedGoodCode);
  }
  const allowedOptionsByGroup = normalizeAddOnOptionIdsByGroup(draft.product.addOnOptionIdsByGroup);
  for (const groupId of uniqueAddOnGroupIds(draft.product.addOnGroupIds)) {
    const group = addOnSourceById.get(groupId);
    protect(group?.snapshot);
    const allowed = new Set(allowedOptionsByGroup[groupId] || []);
    for (const option of group?.row.options || []) {
      if (!allowed.has(option.id)) continue;
      const finishedReference = option.finishedGoodComponent;
      if (finishedReference) protectFinishedCode(finishedReference.finishedGoodCode);
      if (option.inventoryItemType === 'PREP_ITEM' && option.inventoryItemCode) {
        const prep = prepSourceByCode.get(option.inventoryItemCode);
        protect(prep?.snapshot);
        if (prep && !protectedPrep.has(prep.row.code)) {
          protectedPrep.add(prep.row.code);
          protectBom(prep.row.bom || []);
        }
      } else if (option.inventoryItemCode) {
        protect(rawSourceByCode.get(option.inventoryItemCode)?.snapshot);
      }
    }
  }

  const assignment = assignmentAfterPublish(baseProduct.availableStoreIds, targetStoreIds);
  const catalogueAfterAssignment = finishedGoods.map((item) => (
    item.id === baseProduct.id && item.code === baseProduct.code
      ? { ...item, availableStoreIds: assignment.value }
      : item
  ));
  const publishedRevision = newRevision();
  const writeTimestamp = serverTimestamp();
  const allConfigSnapshots = configSnapshot.docs;
  const publishPlans: StorePublishPlan[] = [];

  for (const target of targets) {
    const store = target.row as Store & { id: string };
    const configId = storeItemConfigDocId(store.id, itemCode);
    const matchingConfigs = allConfigSnapshots.filter((entry) => {
      const data = entry.data() as StoreItemConfig;
      return data.storeId === store.id && data.itemCode === itemCode;
    });
    if (matchingConfigs.some((entry) => entry.id !== configId)) {
      throw new GlobalItemPublishError('REJECTED_VALIDATION', `Store ${store.code} has an ambiguous non-canonical item configuration. Nothing was published.`);
    }
    const currentConfigSnapshot = matchingConfigs.find((entry) => entry.id === configId);
    const currentConfig = storeConfigData(currentConfigSnapshot);
    const version = buildPublishedVersion({
      draft,
      baseProduct,
      storeId: store.id,
      existingConfig: currentConfig,
      publishedRevision,
      publishedAt: writeTimestamp,
      publishedBy: actor,
    });
    const nextConfig: StoreItemConfig = {
      ...(currentConfig || {}),
      storeId: store.id,
      itemCode,
      managementMode: FULL_VERSION_MANAGEMENT_MODE,
      publishedVersion: version,
      createdAt: currentConfig?.createdAt ?? writeTimestamp,
      updatedAt: writeTimestamp,
      updatedBy: actor.uid,
    };
    const perStoreConfigs = allConfigSnapshots
      .map((entry) => ({ id: entry.id, ...(entry.data() as StoreItemConfig) }))
      .filter((entry) => entry.storeId === store.id && entry.itemCode !== itemCode);
    perStoreConfigs.push({ id: configId, ...nextConfig });

    const snapshotData = buildPublicMenuAvailabilitySnapshot({
      store,
      finishedGoods: catalogueAfterAssignment,
      storeStock: [],
      rawIngredients: validationSources.rawIngredients,
      prepItems: validationSources.prepItems,
      addOnGroups: validationSources.addOnGroups,
      storeItemConfigs: perStoreConfigs,
    });
    // Run the canonical structural gates independently of commercial intent. A hidden,
    // unavailable, inactive, or ₹0 version is still not allowed to carry broken BOM or
    // composite references that would surface on a later publication.
    const validationConfig: StoreItemConfig = {
      ...nextConfig,
      publishedVersion: {
        ...version,
        product: {
          ...version.product,
          salePrice: Math.max(1, version.product.salePrice),
          isActive: true,
          isSellable: isDirectlySellableProductRole(version.product),
          isAvailable: true,
          menuVisible: isDirectlySellableProductRole(version.product),
        },
      },
    };
    const validationConfigs = perStoreConfigs
      .filter((entry) => entry.itemCode !== itemCode)
      .concat({ id: configId, ...validationConfig });
    const validationSnapshot = buildPublicMenuAvailabilitySnapshot({
      store: { ...store, onlineOrderingEnabled: true, inventoryPolicy: 'STRICT' },
      finishedGoods: catalogueAfterAssignment,
      storeStock: [],
      rawIngredients: validationSources.rawIngredients,
      prepItems: validationSources.prepItems,
      addOnGroups: validationSources.addOnGroups,
      storeItemConfigs: validationConfigs,
    });
    const structuralStatus = validationSnapshot.items[itemCode]?.publicStatus;
    if (isDirectlySellableProductRole(version.product) && structuralStatus !== 'AVAILABLE') {
      const issues = [`${store.code} failed canonical BOM/composite/reference validation.`];
      throw new GlobalItemPublishError('REJECTED_VALIDATION', `${issues[0]} Nothing was published.`, issues);
    }

    const snapshotRef = doc(firestore, 'publicMenuAvailability', store.code);
    const publicSnapshot = await getDoc(snapshotRef);
    publishPlans.push({
      store,
      storeToken: canonicalDataToken(target.snapshot.data()),
      configRef: doc(firestore, STORE_ITEM_CONFIG_COLLECTION, configId),
      expectedConfigToken: currentConfigSnapshot ? canonicalDataToken(currentConfigSnapshot.data()) : 'MISSING',
      configData: nextConfig,
      snapshotRef,
      expectedSnapshotRevision: snapshotRevisionToken(publicSnapshot.exists() ? publicSnapshot.data() : null),
      snapshotData,
    });
  }

  const expectedDraftToken = canonicalDataToken(draftSnapshot.data());
  const expectedBaseToken = canonicalDataToken(baseSource.snapshot.data());
  const expectedTaxonomyToken = taxonomySnapshot.exists() ? canonicalDataToken(taxonomySnapshot.data()) : 'MISSING';
  await runTransaction(firestore, async (transaction) => {
    const primaryRefs = [
      draftRef,
      baseSource.snapshot.ref,
      taxonomyRef,
      ...publishPlans.flatMap((plan) => [plan.store.id ? doc(firestore, 'stores', plan.store.id) : plan.snapshotRef, plan.configRef, plan.snapshotRef]),
      ...Array.from(referenceDocuments.values()).map((source) => source.ref),
    ];
    const live = await Promise.all(primaryRefs.map((reference) => transaction.get(reference)));
    const [liveDraft, liveBase, liveTaxonomy] = live;
    if (!liveDraft.exists()
      || (liveDraft.data() as GlobalItemMasterDraft).draftRevision !== expectedMasterRevision
      || canonicalDataToken(liveDraft.data()) !== expectedDraftToken) {
      throw new GlobalItemPublishError('REJECTED_STALE_MASTER', 'REJECTED_STALE_MASTER: the master draft changed while publishing. Nothing was published.');
    }
    if (!liveBase.exists() || canonicalDataToken(liveBase.data()) !== expectedBaseToken) sourceChanged('The finishedGoods source changed while publishing.');
    const liveTaxonomyToken = liveTaxonomy.exists() ? canonicalDataToken(liveTaxonomy.data()) : 'MISSING';
    if (liveTaxonomyToken !== expectedTaxonomyToken) sourceChanged('The category taxonomy changed while publishing.');

    let cursor = 3;
    for (const plan of publishPlans) {
      const liveStore = live[cursor];
      const liveConfig = live[cursor + 1];
      const liveSnapshot = live[cursor + 2];
      cursor += 3;
      if (!liveStore.exists() || canonicalDataToken(liveStore.data()) !== plan.storeToken) sourceChanged(`Store ${plan.store.code} changed while publishing.`);
      const liveConfigToken = liveConfig.exists() ? canonicalDataToken(liveConfig.data()) : 'MISSING';
      if (liveConfigToken !== plan.expectedConfigToken) sourceChanged(`Store configuration for ${plan.store.code} changed while publishing.`);
      const liveSnapshotToken = snapshotRevisionToken(liveSnapshot.exists() ? liveSnapshot.data() : null);
      if (liveSnapshotToken !== plan.expectedSnapshotRevision) sourceChanged(`Public menu for ${plan.store.code} changed while publishing.`);
    }
    for (const source of referenceDocuments.values()) {
      const liveReference = live[cursor];
      cursor += 1;
      if (!liveReference.exists() || canonicalDataToken(liveReference.data()) !== source.token) {
        sourceChanged(`Referenced master ${source.ref.path} changed while publishing.`);
      }
    }

    if (assignment.changed) transaction.update(baseSource.snapshot.ref, { availableStoreIds: assignment.value });
    for (const plan of publishPlans) {
      transaction.set(plan.configRef, plan.configData);
      transaction.set(plan.snapshotRef, {
        ...plan.snapshotData,
        publicationRevision: publishedRevision,
        updatedAt: writeTimestamp,
        updatedBy: actor.uid,
        ...(actor.name ? { updatedByName: actor.name } : {}),
      });
    }
  });

  return {
    itemCode,
    sourceDraftRevision: draft.draftRevision,
    publishedRevision,
    publishedStoreIds: [...targetStoreIds],
    assignmentAddedStoreIds: assignment.added,
    snapshotDocumentIds: publishPlans.map((plan) => plan.store.code),
    managementMode: FULL_VERSION_MANAGEMENT_MODE,
  };
}
