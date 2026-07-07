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

function getStockDocId(storeId: string, stockItemType: string, stockItemCode: string): string {
  return `${storeId}_${stockItemType}_${stockItemCode}`;
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

function usesFinishedGoodStock(item: FinishedGood): boolean {
  return item.itemType === 'DIRECT_STOCK' || item.productionMode === 'BOUGHT_AND_SOLD';
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

function stockRowFor(
  stockById: Map<string, StoreStock & { id?: string } & Record<string, unknown>>,
  storeId: string,
  stockItemType: string,
  stockItemCode: string,
) {
  const directId = getStockDocId(storeId, stockItemType, stockItemCode);
  const direct = stockById.get(directId);
  if (direct) return direct;
  if (stockItemType === 'PACKAGING') {
    return stockById.get(getStockDocId(storeId, 'RAW_INGREDIENT', stockItemCode));
  }
  return undefined;
}

function evaluateItemAvailability(
  store: Store,
  item: FinishedGood,
  stockById: Map<string, StoreStock & { id?: string } & Record<string, unknown>>,
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

      const stock = stockRowFor(stockById, store.id, componentType, componentCode);
      if (!stock) {
        return publicItem(item, 'SETUP_INCOMPLETE', 'Currently unavailable');
      }

      if (toNumber(stock.currentStock) < componentQuantity) {
        return publicItem(item, 'CURRENTLY_UNAVAILABLE', 'Currently unavailable');
      }
    }

    return publicItem(item, 'AVAILABLE', 'Available');
  }

  if (usesFinishedGoodStock(item)) {
    const stock = stockRowFor(stockById, store.id, 'FINISHED_GOOD', item.code);
    if (!stock) return publicItem(item, 'SETUP_INCOMPLETE', 'Currently unavailable');
    if (toNumber(stock.currentStock) < 1) return publicItem(item, 'CURRENTLY_UNAVAILABLE', 'Currently unavailable');
  }

  return publicItem(item, 'AVAILABLE', 'Available');
}

export function buildPublicMenuAvailabilitySnapshot(input: BuildSnapshotInput): PublicMenuAvailabilitySnapshot {
  const { store, finishedGoods, storeStock, rawIngredients = [], prepItems = [] } = input;
  const stockById = new Map(storeStock.map((stock) => [stock.id || getStockDocId(stock.storeId, stock.stockItemType, stock.stockItemCode), stock]));
  const rawByCode = new Map(rawIngredients.map((item) => [item.code, item]));
  const prepByCode = new Map(prepItems.map((item) => [item.code, item]));
  const finishedByCode = new Map(finishedGoods.map((item) => [item.code, item]));

  const visibleItems = finishedGoods
    .filter((item) => item.isActive !== false && item.isSellable !== false && isStoreAssigned(item, store.id))
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.displayName || a.name).localeCompare(b.displayName || b.name));

  const items = visibleItems.reduce<Record<string, PublicMenuAvailabilityItem>>((acc, item) => {
    acc[item.code] = evaluateItemAvailability(store, item, stockById, rawByCode, prepByCode, finishedByCode);
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
