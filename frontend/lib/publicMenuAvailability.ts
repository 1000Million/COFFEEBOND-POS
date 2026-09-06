import { Store } from '../types';
import {
  AddOnGroup,
  BOMComponent,
  FinishedGood,
  FinishedGoodComponentReference,
  PrepItem,
  RawIngredient,
  StockItemType,
  StoreStock,
} from '../types/menu-management';
import { normalizeAddOnOptionIdsByGroup, sanitizeAddOnGroupsForPublic } from './addOns';
import { trustedDietaryClassification } from './customerMenuPresentation';
import { resolveStoreItem, storeItemConfigByItemCode, type StoreItemConfig } from './storeItemConfig';

export type PublicMenuAvailabilityStatus = 'AVAILABLE' | 'CURRENTLY_UNAVAILABLE' | 'STORE_DISABLED' | 'SETUP_INCOMPLETE';

export type PublicMenuAvailabilityItem = {
  itemCode: string;
  fgCode: string;
  available: boolean;
  publicStatus: PublicMenuAvailabilityStatus;
  publicMessage: string;
};

export type PublicMenuDisplayItem = {
  id: string;
  code: string;
  name: string;
  displayName?: string;
  description?: string;
  posCategoryCode: string;
  posCategoryName: string;
  salePrice: number;
  prepStation: FinishedGood['prepStation'];
  itemType: FinishedGood['itemType'];
  productionMode?: FinishedGood['productionMode'];
  sortOrder: number;
  availableStoreIds: string[];
  addOnGroupIds?: string[];
  addOnOptionIdsByGroup?: Record<string, string[]>;
  isSellable: boolean;
  isAvailable: boolean;
  isActive: boolean;
  taxRate?: number;
  imageUrl?: string;
  dietaryClassification?: 'VEGETARIAN' | 'NON_VEGETARIAN' | 'EGG';
};

export type PublicMenuAvailabilitySnapshot = {
  storeId: string;
  storeCode: string;
  storeName: string;
  items: Record<string, PublicMenuAvailabilityItem>;
  menuItems: Record<string, PublicMenuDisplayItem>;
  addOnGroups: Record<string, AddOnGroup>;
  itemCount: number;
  availableCount: number;
  unavailableCount: number;
};

type BuildSnapshotInput = {
  store: Store;
  finishedGoods: FinishedGood[];
  storeStock: (StoreStock & { id?: string } & Record<string, unknown>)[];
  rawIngredients?: RawIngredient[];
  prepItems?: PrepItem[];
  addOnGroups?: AddOnGroup[];
  /** Per-store overrides. Omitted or empty preserves the protected baseline behavior. */
  storeItemConfigs?: StoreItemConfig[];
};

function toNumber(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

const UOM_ALIASES: Record<string, string> = {
  G: 'G',
  GRAM: 'G',
  GRAMS: 'G',
  KG: 'KG',
  KGS: 'KG',
  KILOGRAM: 'KG',
  KILOGRAMS: 'KG',
  ML: 'ML',
  MILLILITRE: 'ML',
  MILLILITER: 'ML',
  MILLILITRES: 'ML',
  MILLILITERS: 'ML',
  L: 'L',
  LTR: 'L',
  LTRS: 'L',
  LITRE: 'L',
  LITER: 'L',
  LITRES: 'L',
  LITERS: 'L',
  PCS: 'PCS',
  PC: 'PCS',
  PIECE: 'PCS',
  PIECES: 'PCS',
};

const UOM_FAMILY: Record<string, 'WEIGHT' | 'VOLUME' | 'COUNT'> = {
  G: 'WEIGHT',
  KG: 'WEIGHT',
  ML: 'VOLUME',
  L: 'VOLUME',
  PCS: 'COUNT',
};

const FINISHED_GOOD_ITEM_TYPES = new Set(['MADE_TO_ORDER', 'DIRECT_STOCK', 'NO_STOCK']);
const PRODUCTION_MODES = new Set(['MADE_TO_ORDER', 'ASSEMBLED_TO_ORDER', 'BOUGHT_AND_SOLD', 'NO_STOCK']);

function normalizeUom(value: unknown): string {
  const raw = String(value || '').trim().toUpperCase();
  return UOM_ALIASES[raw] || raw;
}

function canConvertUom(fromUom: unknown, toUom: unknown): boolean {
  const from = normalizeUom(fromUom);
  const to = normalizeUom(toUom);
  if (!from || !to) return false;
  if (from === to) return true;
  return !!UOM_FAMILY[from] && UOM_FAMILY[from] === UOM_FAMILY[to];
}

function isStockItemType(value: string): value is StockItemType {
  return ['RAW_INGREDIENT', 'PREP_ITEM', 'BOUGHT_COMPONENT', 'FINISHED_GOOD', 'PACKAGING'].includes(value);
}

function isStoreAssigned(item: FinishedGood, storeId: string): boolean {
  const storeIds = Array.isArray(item.availableStoreIds) ? item.availableStoreIds : [];
  return storeIds.length === 0 || storeIds.includes(storeId);
}

export function isGoldenISalesFirstOrderingStore(store: Pick<Store, 'id' | 'code' | 'storeCode'>): boolean {
  return store.id === 'GOLDEN_I'
    && (store.code || store.storeCode) === 'GOLDEN_I';
}

/**
 * Sales-first stores treat inventory setup as a back-office concern: a missing or
 * incomplete BOM must not withdraw the item from sale, because consumption is deferred
 * as PENDING_BOM and reconciled later. A store opts in per-store with
 * inventoryPolicy = ALLOW_NEGATIVE_DEFER_BOM. ALLOW_NEGATIVE only relaxes stock
 * shortage, not BOM completeness, so it is deliberately not sales-first here.
 * Golden I keeps its historical behaviour through the identity fallback.
 */
/**
 * True only when a store has explicitly opted in via the inventoryPolicy field.
 * Deliberately excludes the Golden I identity fallback, so Golden I keeps its
 * existing invariant that it cannot bypass composite child readiness.
 */
function hasExplicitDeferBomPolicy(
  store: Pick<Store, 'inventoryPolicy'>,
): boolean {
  return String(store.inventoryPolicy || '').trim().toUpperCase() === 'ALLOW_NEGATIVE_DEFER_BOM';
}

export function isSalesFirstOrderingStore(
  store: Pick<Store, 'id' | 'code' | 'storeCode' | 'inventoryPolicy'>,
): boolean {
  const configured = String(store.inventoryPolicy || '').trim().toUpperCase();
  if (configured === 'ALLOW_NEGATIVE_DEFER_BOM') return true;
  if (configured === 'STRICT' || configured === 'ALLOW_NEGATIVE') return false;
  return isGoldenISalesFirstOrderingStore(store);
}

export function isGoldenISetupWarningOnly(
  store: Pick<Store, 'id' | 'code' | 'storeCode' | 'inventoryPolicy'>,
  publicStatus: PublicMenuAvailabilityStatus | undefined,
): boolean {
  return isSalesFirstOrderingStore(store) && publicStatus === 'SETUP_INCOMPLETE';
}

function isActiveSellable(item: FinishedGood, storeId: string): boolean {
  return item.isActive !== false
    && item.isSellable !== false
    && item.isAvailable !== false
    && isStoreAssigned(item, storeId);
}

function usesBom(item: FinishedGood): boolean {
  return item.itemType === 'MADE_TO_ORDER'
    || (item.itemType === 'DIRECT_STOCK' && Array.isArray(item.bom) && item.bom.length > 0)
    || item.productionMode === 'MADE_TO_ORDER'
    || item.productionMode === 'ASSEMBLED_TO_ORDER';
}

function noStockRequired(item: FinishedGood): boolean {
  return item.itemType === 'NO_STOCK' || item.productionMode === 'NO_STOCK';
}

function componentMasterExists(
  line: BOMComponent,
  rawByCode: Map<string, RawIngredient>,
  prepByCode: Map<string, PrepItem>,
  finishedByCode: Map<string, FinishedGood>,
): boolean {
  if (line.componentType === 'RAW_INGREDIENT' || line.componentType === 'PACKAGING') return rawByCode.has(line.componentCode);
  if (line.componentType === 'PREP_ITEM') return prepByCode.has(line.componentCode);
  if (line.componentType === 'FINISHED_GOOD') return finishedByCode.has(line.componentCode);
  return true;
}

type StructureValidationResult = {
  ok: boolean;
  status: PublicMenuAvailabilityStatus;
  message: string;
};

const AVAILABLE_STRUCTURE: StructureValidationResult = {
  ok: true,
  status: 'AVAILABLE',
  message: 'Available',
};

const INCOMPLETE_STRUCTURE: StructureValidationResult = {
  ok: false,
  status: 'SETUP_INCOMPLETE',
  message: 'Currently unavailable',
};

const UNAVAILABLE_STRUCTURE: StructureValidationResult = {
  ok: false,
  status: 'CURRENTLY_UNAVAILABLE',
  message: 'Currently unavailable',
};

function validBomLine(line: BOMComponent): boolean {
  return !!String(line.componentCode || '').trim()
    && !!String(line.componentType || '').trim()
    && !!String(line.uom || '').trim()
    && toNumber(line.quantity) > 0;
}

function componentUomIsCompatible(
  line: BOMComponent,
  rawByCode: Map<string, RawIngredient>,
  prepByCode: Map<string, PrepItem>,
): boolean {
  if (line.componentType === 'RAW_INGREDIENT' || line.componentType === 'PACKAGING') {
    const rawIngredient = rawByCode.get(line.componentCode);
    return canConvertUom(line.uom, rawIngredient?.usageUOM || line.uom);
  }

  if (line.componentType === 'PREP_ITEM') {
    const prepItem = prepByCode.get(line.componentCode);
    return canConvertUom(line.uom, prepItem?.yieldUOM || prepItem?.outputUOM || line.uom);
  }

  return true;
}

function validateBomStructure(
  bom: BOMComponent[],
  rawByCode: Map<string, RawIngredient>,
  prepByCode: Map<string, PrepItem>,
  finishedByCode: Map<string, FinishedGood>,
): StructureValidationResult {
  for (const line of bom) {
    const componentCode = String(line.componentCode || '').trim();
    const componentType = String(line.componentType || '').trim();
    const componentQuantity = toNumber(line.quantity);

    if (!componentCode || !componentType || !isStockItemType(componentType) || componentQuantity <= 0) {
      return INCOMPLETE_STRUCTURE;
    }

    if (!componentMasterExists(line, rawByCode, prepByCode, finishedByCode)) {
      return INCOMPLETE_STRUCTURE;
    }

    if (!componentUomIsCompatible(line, rawByCode, prepByCode)) {
      return INCOMPLETE_STRUCTURE;
    }

    if (componentType === 'PREP_ITEM') {
      const prepItem = prepByCode.get(componentCode);
      if (!prepItem) return INCOMPLETE_STRUCTURE;
      const prepValidation = validatePrepStructure(prepItem, rawByCode, prepByCode, finishedByCode, new Set());
      if (!prepValidation.ok) return prepValidation;
    }
  }

  return AVAILABLE_STRUCTURE;
}

function normalizedStrings(value: unknown): string[] {
  return Array.from(new Set(
    (Array.isArray(value) ? value : [])
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map(entry => entry.trim()),
  ));
}

function parsedComponentReference(value: unknown): FinishedGoodComponentReference | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<FinishedGoodComponentReference>;
  const finishedGoodId = typeof candidate.finishedGoodId === 'string'
    ? candidate.finishedGoodId.trim()
    : '';
  const finishedGoodCode = typeof candidate.finishedGoodCode === 'string'
    ? candidate.finishedGoodCode.trim()
    : '';
  const quantity = toNumber(candidate.quantity);
  if (
    !finishedGoodId
    || !finishedGoodCode
    || !Number.isInteger(quantity)
    || quantity <= 0
    || quantity > 100
  ) return null;
  return { finishedGoodId, finishedGoodCode, quantity };
}

function validateCompositeChild(
  store: Store,
  parent: FinishedGood,
  reference: FinishedGoodComponentReference,
  rawByCode: Map<string, RawIngredient>,
  prepByCode: Map<string, PrepItem>,
  finishedByCode: Map<string, FinishedGood>,
  finishedById: Map<string, FinishedGood>,
): StructureValidationResult {
  if (reference.finishedGoodId === parent.id || reference.finishedGoodCode === parent.code) {
    return INCOMPLETE_STRUCTURE;
  }

  const child = finishedById.get(reference.finishedGoodId);
  if (
    !child
    || String(child.id || '').trim() !== reference.finishedGoodId
    || String(child.code || '').trim() !== reference.finishedGoodCode
    || finishedByCode.get(reference.finishedGoodCode) !== child
  ) {
    return INCOMPLETE_STRUCTURE;
  }

  const childStoreIds = Array.isArray(child.availableStoreIds) ? child.availableStoreIds : [];
  if (child.isActive !== true || child.isAvailable === false || !childStoreIds.includes(store.id)) {
    return UNAVAILABLE_STRUCTURE;
  }

  // Component Finished Goods are intentionally permitted to be hidden from the
  // public menu. Their active/available/store/BOM state, not isSellable, decides
  // whether the composite parent is ready.
  if (child.composite) return INCOMPLETE_STRUCTURE;
  if (!['BARISTA', 'KITCHEN', 'BOTH', 'NONE'].includes(child.prepStation)) {
    return INCOMPLETE_STRUCTURE;
  }
  if (!FINISHED_GOOD_ITEM_TYPES.has(String(child.itemType || '').trim().toUpperCase())) {
    return INCOMPLETE_STRUCTURE;
  }
  const productionMode = String(child.productionMode || '').trim().toUpperCase();
  if (productionMode && !PRODUCTION_MODES.has(productionMode)) {
    return INCOMPLETE_STRUCTURE;
  }

  if (child.bom !== undefined && child.bom !== null && !Array.isArray(child.bom)) {
    return INCOMPLETE_STRUCTURE;
  }
  const childBom = Array.isArray(child.bom) ? child.bom : [];
  // A missing/empty child BOM is a back-office gap, not a structural fault. At a
  // sales-first store consumption defers to PENDING_BOM and is backfilled exactly
  // once, so it must not withdraw the parent from sale. Everything above -
  // unresolvable child, nested composite, invalid station/itemType/productionMode -
  // remains a hard block, as does a malformed BOM below, because those cannot be
  // reconciled later and would fail at KOT routing or canonicalization.
  // Gated on the EXPLICIT inventoryPolicy field rather than isSalesFirstOrderingStore,
  // so Golden I - which is sales-first only through the identity fallback - keeps its
  // established invariant that it cannot bypass composite child readiness.
  if (usesBom(child) && childBom.length === 0) {
    return hasExplicitDeferBomPolicy(store) ? AVAILABLE_STRUCTURE : INCOMPLETE_STRUCTURE;
  }
  return childBom.length > 0
    ? validateBomStructure(childBom, rawByCode, prepByCode, finishedByCode)
    : AVAILABLE_STRUCTURE;
}

function validateCompositeStructure(
  store: Store,
  item: FinishedGood,
  rawByCode: Map<string, RawIngredient>,
  prepByCode: Map<string, PrepItem>,
  finishedByCode: Map<string, FinishedGood>,
  finishedById: Map<string, FinishedGood>,
  addOnGroupsById: Map<string, AddOnGroup>,
): StructureValidationResult {
  const composite = item.composite;
  if (!composite || Number(composite.schemaVersion) !== 1) return INCOMPLETE_STRUCTURE;
  if (!Array.isArray(composite.staticComponents) || !Array.isArray(composite.choiceGroupIds)) {
    return INCOMPLETE_STRUCTURE;
  }
  if (
    item.unresolvedCompositeRequirements !== undefined
    && (
      !Array.isArray(item.unresolvedCompositeRequirements)
      || item.unresolvedCompositeRequirements.length > 0
    )
  ) {
    return INCOMPLETE_STRUCTURE;
  }

  const staticReferences = composite.staticComponents.map(parsedComponentReference);
  if (staticReferences.some(reference => !reference)) return INCOMPLETE_STRUCTURE;
  const validStaticReferences = staticReferences as FinishedGoodComponentReference[];
  const staticIds = validStaticReferences.map(reference => reference.finishedGoodId);
  if (new Set(staticIds).size !== staticIds.length) return INCOMPLETE_STRUCTURE;

  const rawChoiceGroupIds = composite.choiceGroupIds
    .map(groupId => typeof groupId === 'string' ? groupId.trim() : '')
    .filter(Boolean);
  const choiceGroupIds = normalizedStrings(rawChoiceGroupIds);
  if (choiceGroupIds.length !== composite.choiceGroupIds.length) return INCOMPLETE_STRUCTURE;

  const configuredGroupIds = normalizedStrings(item.addOnGroupIds);
  const assignedCompositeGroupIds = configuredGroupIds.filter(groupId => (
    addOnGroupsById.get(groupId)?.purpose === 'COMPOSITE_CHOICE'
  ));
  if (
    assignedCompositeGroupIds.length !== choiceGroupIds.length
    || assignedCompositeGroupIds.some(groupId => !choiceGroupIds.includes(groupId))
    || configuredGroupIds.length !== assignedCompositeGroupIds.length
  ) {
    return INCOMPLETE_STRUCTURE;
  }

  const optionIdsByGroup = normalizeAddOnOptionIdsByGroup(item.addOnOptionIdsByGroup);
  const choiceReferences: FinishedGoodComponentReference[] = [];
  for (const groupId of choiceGroupIds) {
    if (!configuredGroupIds.includes(groupId)) return INCOMPLETE_STRUCTURE;
    const group = addOnGroupsById.get(groupId);
    if (!group || group.isActive !== true || group.purpose !== 'COMPOSITE_CHOICE') {
      return INCOMPLETE_STRUCTURE;
    }
    if (group.selectionMode !== 'SINGLE' && group.selectionMode !== 'EXACT_DISTINCT') {
      return INCOMPLETE_STRUCTURE;
    }
    if (group.selectionMode === 'SINGLE') {
      const minimum = toNumber(group.minimumSelections);
      const maximum = group.maximumSelections === null || group.maximumSelections === undefined
        ? 1
        : toNumber(group.maximumSelections);
      if (
        !Number.isInteger(minimum)
        || minimum < 0
        || minimum > 1
        || !Number.isInteger(maximum)
        || maximum !== 1
      ) {
        return INCOMPLETE_STRUCTURE;
      }
    }
    if (group.selectionMode === 'EXACT_DISTINCT') {
      const minimum = toNumber(group.minimumSelections);
      const maximum = toNumber(group.maximumSelections);
      if (!Number.isInteger(minimum) || minimum <= 0 || maximum !== minimum) {
        return INCOMPLETE_STRUCTURE;
      }
    }

    const allowedOptionIds = optionIdsByGroup[groupId] || [];
    if (allowedOptionIds.length === 0) return INCOMPLETE_STRUCTURE;
    const optionsById = new Map((Array.isArray(group.options) ? group.options : []).map(option => [option.id, option]));
    const groupReferences: FinishedGoodComponentReference[] = [];
    for (const optionId of allowedOptionIds) {
      const option = optionsById.get(optionId);
      const reference = parsedComponentReference(option?.finishedGoodComponent);
      if (!option || option.isActive !== true || !reference) return INCOMPLETE_STRUCTURE;
      groupReferences.push(reference);
    }
    if (
      group.selectionMode === 'EXACT_DISTINCT'
      && new Set(groupReferences.map(reference => reference.finishedGoodId)).size !== groupReferences.length
    ) {
      return INCOMPLETE_STRUCTURE;
    }
    choiceReferences.push(...groupReferences);
  }

  const references = [...validStaticReferences, ...choiceReferences];
  if (validStaticReferences.length + choiceGroupIds.length === 0 || references.length > 40) {
    return INCOMPLETE_STRUCTURE;
  }
  for (const reference of references) {
    const childResult = validateCompositeChild(
      store,
      item,
      reference,
      rawByCode,
      prepByCode,
      finishedByCode,
      finishedById,
    );
    if (!childResult.ok) return childResult;
  }

  // A composite parent is a commercial wrapper around its child recipes. It may
  // therefore omit a duplicate parent BOM; if it does declare one, that BOM must
  // still pass the same structural checks as an ordinary product.
  const parentBom = Array.isArray(item.bom) ? item.bom : [];
  return parentBom.length > 0
    ? validateBomStructure(parentBom, rawByCode, prepByCode, finishedByCode)
    : AVAILABLE_STRUCTURE;
}

function validatePrepStructure(
  prepItem: PrepItem,
  rawByCode: Map<string, RawIngredient>,
  prepByCode: Map<string, PrepItem>,
  finishedByCode: Map<string, FinishedGood>,
  visited: Set<string>,
): StructureValidationResult {
  if (visited.has(prepItem.code)) {
    return {
      ok: false,
      status: 'SETUP_INCOMPLETE',
      message: 'Currently unavailable',
    };
  }

  if (prepItem.isStockTracked) {
    return { ok: true, status: 'AVAILABLE', message: 'Available' };
  }

  const yieldQuantity = toNumber(prepItem.yieldQuantity);
  const yieldUom = String(prepItem.yieldUOM || prepItem.outputUOM || '').trim();
  if (yieldQuantity <= 0 || !yieldUom || !Array.isArray(prepItem.bom) || prepItem.bom.length === 0) {
    return {
      ok: false,
      status: 'SETUP_INCOMPLETE',
      message: 'Currently unavailable',
    };
  }

  const nextVisited = new Set(visited);
  nextVisited.add(prepItem.code);

  for (const line of prepItem.bom) {
    if (!validBomLine(line) || !isStockItemType(line.componentType) || !componentMasterExists(line, rawByCode, prepByCode, finishedByCode)) {
      return {
        ok: false,
        status: 'SETUP_INCOMPLETE',
        message: 'Currently unavailable',
      };
    }

    if (!componentUomIsCompatible(line, rawByCode, prepByCode)) {
      return {
        ok: false,
        status: 'SETUP_INCOMPLETE',
        message: 'Currently unavailable',
      };
    }

    if (line.componentType === 'RAW_INGREDIENT' || line.componentType === 'PACKAGING') {
      continue;
    }

    if (line.componentType === 'PREP_ITEM') {
      const nestedPrep = prepByCode.get(line.componentCode);
      if (!nestedPrep) {
        return {
          ok: false,
          status: 'SETUP_INCOMPLETE',
          message: 'Currently unavailable',
        };
      }
      const nestedResult = validatePrepStructure(nestedPrep, rawByCode, prepByCode, finishedByCode, nextVisited);
      if (!nestedResult.ok) return nestedResult;
      continue;
    }
  }

  return {
    ok: true,
    status: 'AVAILABLE',
    message: 'Available',
  };
}

function publicItem(
  item: FinishedGood,
  status: PublicMenuAvailabilityStatus,
  message: string,
): PublicMenuAvailabilityItem {
  const available = status === 'AVAILABLE';
  return {
    itemCode: item.code,
    fgCode: item.code,
    available,
    publicStatus: status,
    publicMessage: message,
  };
}

function publicDisplayItem(store: Store, item: FinishedGood): PublicMenuDisplayItem {
  const record = item as FinishedGood & Record<string, unknown>;
  const addonGroupIds = (item as unknown as { addOnGroupIds?: unknown }).addOnGroupIds;
  const publicGroupIds = Array.isArray(addonGroupIds)
    ? Array.from(new Set((addonGroupIds as unknown[])
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim())))
    : [];
  const optionIdsByGroup = normalizeAddOnOptionIdsByGroup(item.addOnOptionIdsByGroup);
  const publicOptionIdsByGroup = Object.fromEntries(
    publicGroupIds
      .filter(groupId => Object.prototype.hasOwnProperty.call(optionIdsByGroup, groupId))
      .map(groupId => [groupId, optionIdsByGroup[groupId]]),
  );
  const imageUrl = ['imageUrl', 'image', 'photoUrl', 'photo', 'thumbnailUrl', 'thumbnail']
    .map((key) => record[key])
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const dietaryClassification = trustedDietaryClassification(record);

  return {
    id: item.code,
    code: item.code,
    // Legacy catalogue rows may predate the required `name` field. Never emit
    // `undefined` into Firestore; preserve their display name (or code) instead.
    name: item.name || item.displayName || item.code,
    ...(item.displayName ? { displayName: item.displayName } : {}),
    ...(item.description ? { description: item.description } : {}),
    posCategoryCode: item.posCategoryCode || 'MISC',
    posCategoryName: item.posCategoryName || 'Other',
    salePrice: toNumber(item.salePrice),
    prepStation: item.prepStation,
    itemType: item.itemType,
    ...(item.productionMode ? { productionMode: item.productionMode } : {}),
    sortOrder: toNumber(item.sortOrder),
    availableStoreIds: [store.id],
    ...(publicGroupIds.length > 0
      ? { addOnGroupIds: publicGroupIds, addOnOptionIdsByGroup: publicOptionIdsByGroup }
      : {}),
    isSellable: item.isSellable !== false,
    isAvailable: item.isAvailable !== false,
    isActive: item.isActive !== false,
    ...(toNumber(item.taxRate) > 0 ? { taxRate: toNumber(item.taxRate) } : {}),
    ...(imageUrl ? { imageUrl: imageUrl.trim() } : {}),
    ...(dietaryClassification ? { dietaryClassification } : {}),
  };
}

function evaluateItemAvailability(
  store: Store,
  item: FinishedGood,
  rawByCode: Map<string, RawIngredient>,
  prepByCode: Map<string, PrepItem>,
  finishedByCode: Map<string, FinishedGood>,
  finishedById: Map<string, FinishedGood>,
  addOnGroupsById: Map<string, AddOnGroup>,
): PublicMenuAvailabilityItem {
  if (store.onlineOrderingEnabled === false) {
    return publicItem(item, 'STORE_DISABLED', 'Online ordering unavailable for this store');
  }

  if (!isActiveSellable(item, store.id)) {
    return publicItem(item, 'CURRENTLY_UNAVAILABLE', 'Currently unavailable');
  }

  if (toNumber(item.salePrice) <= 0 || !['BARISTA', 'KITCHEN', 'BOTH', 'NONE'].includes(item.prepStation)) {
    return publicItem(item, 'SETUP_INCOMPLETE', 'Currently unavailable');
  }

  if (item.composite) {
    const compositeValidation = validateCompositeStructure(
      store,
      item,
      rawByCode,
      prepByCode,
      finishedByCode,
      finishedById,
      addOnGroupsById,
    );
    return publicItem(item, compositeValidation.status, compositeValidation.message);
  }

  if (isSalesFirstOrderingStore(store)) {
    return publicItem(item, 'AVAILABLE', 'Available');
  }

  if (noStockRequired(item)) {
    return publicItem(item, 'AVAILABLE', 'Available');
  }

  const bom = Array.isArray(item.bom) ? item.bom : [];
  if (usesBom(item)) {
    if (bom.length === 0) {
      return publicItem(item, 'SETUP_INCOMPLETE', 'Currently unavailable');
    }
    const bomValidation = validateBomStructure(bom, rawByCode, prepByCode, finishedByCode);
    return publicItem(item, bomValidation.status, bomValidation.message);
  }

  return publicItem(item, 'AVAILABLE', 'Available');
}

export function buildPublicMenuAvailabilitySnapshot(input: BuildSnapshotInput): PublicMenuAvailabilitySnapshot {
  const { store, rawIngredients = [], prepItems = [], addOnGroups = [] } = input;
  const overridesByCode = storeItemConfigByItemCode(store.id, input.storeItemConfigs);
  const finishedGoods = overridesByCode.size === 0
    ? input.finishedGoods
    : input.finishedGoods.map((item) => resolveStoreItem(item, overridesByCode.get(item.code)));
  const rawByCode = new Map(rawIngredients.map((item) => [item.code, item]));
  const prepByCode = new Map(prepItems.map((item) => [item.code, item]));
  const finishedByCode = new Map(finishedGoods.map((item) => [item.code, item]));
  const finishedById = new Map(
    finishedGoods
      .filter((item): item is FinishedGood & { id: string } => typeof item.id === 'string' && item.id.trim().length > 0)
      .map(item => [item.id.trim(), item]),
  );
  const addOnGroupsById = new Map(
    addOnGroups
      .filter((group): group is AddOnGroup & { id: string } => typeof group.id === 'string' && group.id.trim().length > 0)
      .map(group => [group.id.trim(), group]),
  );

  const visibleItems = finishedGoods
    .filter((item) => item.isActive !== false && item.isSellable !== false && isStoreAssigned(item, store.id))
    .filter((item) => (item as { menuVisible?: boolean }).menuVisible !== false)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)
      || String(a.displayName || a.name || a.code).localeCompare(String(b.displayName || b.name || b.code)));

  const evaluatedItems = visibleItems.reduce<Record<string, PublicMenuAvailabilityItem>>((acc, item) => {
    acc[item.code] = evaluateItemAvailability(
      store,
      item,
      rawByCode,
      prepByCode,
      finishedByCode,
      finishedById,
      addOnGroupsById,
    );
    return acc;
  }, {});
  const publishedItems = visibleItems;
  const items = publishedItems.reduce<Record<string, PublicMenuAvailabilityItem>>((acc, item) => {
    acc[item.code] = evaluatedItems[item.code];
    return acc;
  }, {});
  const menuItems = publishedItems.reduce<Record<string, PublicMenuDisplayItem>>((acc, item) => {
    acc[item.code] = publicDisplayItem(store, item);
    return acc;
  }, {});
  const visibleGroupIds = new Set(
    Object.values(menuItems).flatMap(item => item.addOnGroupIds || []),
  );
  const sanitizedGroups = sanitizeAddOnGroupsForPublic(addOnGroups)
    .filter(group => group.id && visibleGroupIds.has(group.id));
  const publicAddOnGroups = sanitizedGroups.reduce<Record<string, AddOnGroup>>((acc, group) => {
    if (group.id) acc[group.id] = group;
    return acc;
  }, {});
  const values = Object.values(items);

  return {
    storeId: store.id,
    storeCode: store.code,
    storeName: store.name,
    items,
    menuItems,
    addOnGroups: publicAddOnGroups,
    itemCount: values.length,
    availableCount: values.filter((item) => item.available).length,
    unavailableCount: values.filter((item) => !item.available).length,
  };
}
