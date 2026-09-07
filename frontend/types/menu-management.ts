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
export type PackagingApplicability = 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY' | 'ALL';

export type AddOnInventoryItemType = 'RAW_INGREDIENT' | 'PREP_ITEM' | 'PACKAGING';
export type FinishedGoodProductType = 'NORMAL_SELLABLE' | 'INTERNAL_COMPONENT' | 'COMPOSITE_PARENT';

/**
 * A reference to a Finished Good that is prepared/consumed as one component of
 * a composite parent. The reference carries no recipe or cost data: checkout
 * resolves those fields from the current authoritative child Finished Good.
 */
export interface FinishedGoodComponentReference {
  finishedGoodId: string;
  finishedGoodCode: string;
  /** Quantity required for one unit of the composite parent. */
  quantity: number;
}

export interface CompositeFinishedGoodDefinition {
  schemaVersion: 1;
  /** Stable array order becomes the canonical preparation order. */
  staticComponents: FinishedGoodComponentReference[];
  /** Existing add-on groups used only as server-authoritative component choices. */
  choiceGroupIds: string[];
}

export interface UnresolvedCompositeRequirement {
  name: string;
  quantity: number;
  reason: string;
}

/** Server-resolved snapshot stored on an order line for preparation/inventory. */
export interface CanonicalCompositeComponent {
  sequence: number;
  source: 'STATIC' | 'CHOICE';
  groupId?: string;
  groupName?: string;
  optionId?: string;
  optionName?: string;
  componentFinishedGoodId: string;
  componentFinishedGoodCode: string;
  componentName: string;
  /** Frozen role from the child version; absent only on legacy order snapshots. */
  productType?: FinishedGoodProductType;
  /** Quantity per one unit of the parent order line. */
  quantity: number;
  prepStation: PrepStation;
  itemType: FinishedGoodItemType | null;
  productionMode: ProductionMode | null;
  /** Operational fields only; recipe cost fields are deliberately excluded. */
  bom: Array<Omit<BOMComponent, 'costPerUnit' | 'lineCost'>>;
  bomVersion: number | null;
  /** Present only when an explicit store policy deferred a genuinely missing/empty BOM. */
  bomStatus?: 'PENDING_BOM';
}

export interface AddOnOption {
  id: string;
  code: string;
  name: string;
  price: number;
  attribute?: 'VEG' | 'EGG' | string;
  taxRate?: number;
  isActive: boolean;
  sortOrder: number;
  inventoryItemType?: AddOnInventoryItemType;
  inventoryItemCode?: string;
  consumptionQuantity?: number;
  consumptionUnit?: string;
  /** Required for options in a COMPOSITE_CHOICE group. */
  finishedGoodComponent?: FinishedGoodComponentReference;
}

export interface BOMComponent {
  componentType: BOMComponentType;
  componentStockType?: 'RAW_INGREDIENT' | 'PREP_ITEM' | 'BOUGHT_COMPONENT' | 'FINISHED_GOOD' | 'PACKAGING';
  componentCode: string;
  componentName: string;
  quantity: number;
  uom: string;
  costPerUnit: number;
  lineCost: number;
  applicableOrderTypes?: PackagingApplicability[];
  packagingApplicability?: PackagingApplicability | PackagingApplicability[];
  orderTypes?: PackagingApplicability[];
  serviceTypes?: PackagingApplicability[];
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
  /**
   * Commercial role, independent of itemType/productionMode. Optional only for
   * legacy documents: a legacy composite derives COMPOSITE_PARENT and every other
   * legacy Finished Good derives NORMAL_SELLABLE.
   */
  productType?: FinishedGoodProductType;
  dietaryClassification?: 'VEGETARIAN' | 'NON_VEGETARIAN' | 'EGG';
  imageUrl?: string;
  imageStoragePath?: string | null;
  imageSource?: 'ADMIN_UPLOAD' | null;
  imageUpdatedAt?: any;
  imageUpdatedBy?: string | null;
  previousImageUrl?: string | null;
  previousImageStoragePath?: string | null;
  addOnGroupIds?: string[];
  addOnOptionIdsByGroup?: Record<string, string[]>;
  /** Present only on an explicitly modelled composite/bundle parent. */
  composite?: CompositeFinishedGoodDefinition;
  /** Explicit owner-data gaps keep an otherwise valid composite fail-closed. */
  unresolvedCompositeRequirements?: UnresolvedCompositeRequirement[];
  categoryId?: string;
  categoryCode?: string;
  category?: string | { code?: string; id?: string; name?: string } | null;
  categoryName?: string;
  posCategoryCode: string;
  posCategoryName: string;
  categorySortOrder?: number | null;
  subcategoryId?: string | null;
  subcategoryCode?: string | null;
  subcategory?: string | { code?: string; id?: string; name?: string } | null;
  subcategoryName?: string | null;
  posSubcategoryCode?: string | null;
  posSubcategoryName?: string | null;
  subcategorySortOrder?: number | null;
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
  sortOrder: number | null;
  availableStoreIds: string[];
  isSellable: boolean;
  isAvailable: boolean;
  isActive: boolean;
  createdAt?: any;
  updatedAt?: any;
}

export interface AddOnGroup {
  id?: string;
  name: string;
  code?: string;
  description?: string;
  isActive: boolean;
  isRequired?: boolean;
  minimumSelections?: number;
  maximumSelections?: number | null;
  /**
   * EXACT_DISTINCT means exactly minimumSelections === maximumSelections
   * different options, with quantity one for every selected option.
   */
  selectionMode?: 'SINGLE' | 'MULTIPLE' | 'EXACT_DISTINCT';
  /** Omitted/ADD_ON preserves the existing ordinary add-on behaviour. */
  purpose?: 'ADD_ON' | 'COMPOSITE_CHOICE';
  options: AddOnOption[];
  createdAt?: any;
  updatedAt?: any;
  productIds?: string[];
  productCodes?: string[];
}

export type ProductImageAction = 'UPLOAD' | 'REPLACE' | 'REMOVE';

export interface ProductImageAudit {
  id?: string;
  action: ProductImageAction;
  productCode: string;
  productName: string;
  productDocumentPath: string;
  previousImageUrl: string | null;
  newImageUrl: string | null;
  previousStoragePath: string | null;
  newStoragePath: string | null;
  performedByUid: string;
  performedByEmail: string | null;
  timestamp: any;
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
