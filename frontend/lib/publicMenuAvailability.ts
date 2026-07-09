import { Store } from '../types';
import { BOMComponent, FinishedGood, PrepItem, RawIngredient, StockItemType, StoreStock } from '../types/menu-management';

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
  isSellable: boolean;
  isAvailable: boolean;
  isActive: boolean;
  taxRate?: number;
  imageUrl?: string;
};

export type PublicMenuAvailabilitySnapshot = {
  storeId: string;
  storeCode: string;
  storeName: string;
  items: Record<string, PublicMenuAvailabilityItem>;
  menuItems: Record<string, PublicMenuDisplayItem>;
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
  const imageUrl = ['imageUrl', 'image', 'photoUrl', 'photo', 'thumbnailUrl', 'thumbnail']
    .map((key) => record[key])
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);

  return {
    id: item.code,
    code: item.code,
    name: item.name,
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
    isSellable: item.isSellable !== false,
    isAvailable: item.isAvailable !== false,
    isActive: item.isActive !== false,
    ...(toNumber(item.taxRate) > 0 ? { taxRate: toNumber(item.taxRate) } : {}),
    ...(imageUrl ? { imageUrl: imageUrl.trim() } : {}),
  };
}

function evaluateItemAvailability(
  store: Store,
  item: FinishedGood,
  rawByCode: Map<string, RawIngredient>,
  prepByCode: Map<string, PrepItem>,
  finishedByCode: Map<string, FinishedGood>,
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

  if (noStockRequired(item)) {
    return publicItem(item, 'AVAILABLE', 'Available');
  }

  const bom = Array.isArray(item.bom) ? item.bom : [];
  if (usesBom(item)) {
    if (bom.length === 0) {
      return publicItem(item, 'SETUP_INCOMPLETE', 'Currently unavailable');
    }

    for (const line of bom) {
      const componentCode = String(line.componentCode || '').trim();
      const componentType = String(line.componentType || '').trim();
      const componentQuantity = toNumber(line.quantity);

      if (!componentCode || !componentType || !isStockItemType(componentType) || componentQuantity <= 0) {
        return publicItem(item, 'SETUP_INCOMPLETE', 'Currently unavailable');
      }

      if (!componentMasterExists(line, rawByCode, prepByCode, finishedByCode)) {
        return publicItem(item, 'SETUP_INCOMPLETE', 'Currently unavailable');
      }

      if (!componentUomIsCompatible(line, rawByCode, prepByCode)) {
        return publicItem(item, 'SETUP_INCOMPLETE', 'Currently unavailable');
      }

      if (componentType === 'PREP_ITEM') {
        const prepItem = prepByCode.get(componentCode);
        if (!prepItem) return publicItem(item, 'SETUP_INCOMPLETE', 'Currently unavailable');
        const prepValidation = validatePrepStructure(prepItem, rawByCode, prepByCode, finishedByCode, new Set());
        if (!prepValidation.ok) {
          return publicItem(item, prepValidation.status, prepValidation.message);
        }
        continue;
      }
    }

    return publicItem(item, 'AVAILABLE', 'Available');
  }

  return publicItem(item, 'AVAILABLE', 'Available');
}

export function buildPublicMenuAvailabilitySnapshot(input: BuildSnapshotInput): PublicMenuAvailabilitySnapshot {
  const { store, finishedGoods, rawIngredients = [], prepItems = [] } = input;
  const rawByCode = new Map(rawIngredients.map((item) => [item.code, item]));
  const prepByCode = new Map(prepItems.map((item) => [item.code, item]));
  const finishedByCode = new Map(finishedGoods.map((item) => [item.code, item]));

  const visibleItems = finishedGoods
    .filter((item) => item.isActive !== false && item.isSellable !== false && isStoreAssigned(item, store.id))
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.displayName || a.name).localeCompare(b.displayName || b.name));

  const items = visibleItems.reduce<Record<string, PublicMenuAvailabilityItem>>((acc, item) => {
    acc[item.code] = evaluateItemAvailability(store, item, rawByCode, prepByCode, finishedByCode);
    return acc;
  }, {});
  const menuItems = visibleItems.reduce<Record<string, PublicMenuDisplayItem>>((acc, item) => {
    acc[item.code] = publicDisplayItem(store, item);
    return acc;
  }, {});
  const values = Object.values(items);

  return {
    storeId: store.id,
    storeCode: store.code,
    storeName: store.name,
    items,
    menuItems,
    itemCount: values.length,
    availableCount: values.filter((item) => item.available).length,
    unavailableCount: values.filter((item) => !item.available).length,
  };
}
