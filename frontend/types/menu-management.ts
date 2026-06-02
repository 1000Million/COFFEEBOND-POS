export interface RawIngredient {
  id?: string;
  code: string;
  name: string;
  category: string;
  purchaseUOM: string;
  usageUOM: string;
  conversionFactor: number;
  purchaseCost: number;
  costPerUsageUnit: number;
  supplierName?: string;
  isActive: boolean;
  createdAt?: any;
  updatedAt?: any;
}

export type BOMComponentType = 'RAW_INGREDIENT' | 'PREP_ITEM' | 'BOUGHT_COMPONENT' | 'FINISHED_GOOD' | 'PACKAGING';

export interface BOMComponent {
  componentType: BOMComponentType;
  componentStockType?: 'RAW_INGREDIENT' | 'PREP_ITEM' | 'BOUGHT_COMPONENT' | 'FINISHED_GOOD' | 'PACKAGING';
  componentCode: string;
  componentName: string;
  quantity: number;
  uom: string;
  costPerUnit: number;
  lineCost: number;
}

export interface PrepItem {
  id?: string;
  code: string;
  name: string;
  outputUOM: string;
  defaultBatchSize: number;
  yieldQuantity: number;
  yieldUOM: string;
  costPerUnit: number;
  isStockTracked: boolean;
  bom: BOMComponent[];
  bomVersion: number;
  lastCostedAt?: any;
  isActive: boolean;
  createdAt?: any;
  updatedAt?: any;
}

export type FinishedGoodItemType = 'MADE_TO_ORDER' | 'DIRECT_STOCK' | 'NO_STOCK';
export type PrepStation = 'BARISTA' | 'KITCHEN' | 'BOTH' | 'NONE';

export type ProductionMode = 'MADE_TO_ORDER' | 'ASSEMBLED_TO_ORDER' | 'BOUGHT_AND_SOLD' | 'NO_STOCK';

export interface FinishedGood {
  id?: string;
  code: string;
  name: string;
  displayName?: string;
  description?: string;
  posCategoryCode: string;
  posCategoryName: string;
  salePrice: number;
  productionMode?: ProductionMode;
  itemType: FinishedGoodItemType;
  prepStation: PrepStation;
  taxRate: number;
  bom: BOMComponent[];
  bomVersion: number;
  recipeCost: number;
  grossMargin: number;
  cogsPercent: number;
  sortOrder: number;
  availableStoreIds: string[];
  isSellable: boolean;
  isAvailable: boolean;
  isActive: boolean;
  createdAt?: any;
  updatedAt?: any;
}

export type StockItemType = 'RAW_INGREDIENT' | 'PREP_ITEM' | 'BOUGHT_COMPONENT' | 'FINISHED_GOOD' | 'PACKAGING';

export interface StoreStock {
  id?: string;
  storeId: string;
  storeName: string;
  stockItemType: StockItemType;
  stockItemCode: string;
  stockItemName: string;
  uom: string;
  openingStock: number;
  currentStock: number;
  minimumStock: number;
  costPerUnit: number;
  createdAt?: any;
  updatedAt?: any;
}

export interface PrepProduction {
  id?: string;
  storeId: string;
  storeName: string;
  prepItemCode: string;
  prepItemName: string;
  outputQuantity: number;
  outputUOM: string;
  totalCost: number;
  costPerUnit: number;
  notes: string;
  createdByUserId: string;
  createdByName: string;
  createdAt?: any;
}