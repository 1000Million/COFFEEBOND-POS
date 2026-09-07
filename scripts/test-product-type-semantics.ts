import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildKotTasks, expandCompositeInventoryLines } from '../frontend/lib/compositeFulfillment';
import { completePublishedProduct } from '../frontend/lib/globalItemPublish';
import {
  isCompositeParentProduct,
  isDirectlySellableProductRole,
  resolveFinishedGoodProductType,
} from '../frontend/lib/productType';
import { buildPublicMenuAvailabilitySnapshot } from '../frontend/lib/publicMenuAvailability';
import { resolveEffectiveProduct, type StoreItemConfig } from '../frontend/lib/storeItemConfig';
import type { FinishedGood } from '../frontend/types/menu-management';
import type { GlobalItemProductVersion, PublishedStoreProductVersion } from '../frontend/types/global-items';

const require = createRequire(import.meta.url);
const serverProductType = require(resolve(process.cwd(), 'functions/productTypePolicy.js'));
const { canonicalizeRequestedCart } = require(resolve(process.cwd(), 'functions/posAddOnAuthorization.js'));
const { resolvePublicCheckoutProduct } = require(resolve(process.cwd(), 'functions/customerCheckoutCanonicalization.js'));
const {
  resolveCanonicalCompositeComponents,
  validateFrozenCanonicalCompositeComponents,
} = require(resolve(process.cwd(), 'functions/compositeProductPolicy.js'));

const STORE_ID = 'TYPE_TEST_STORE';
const store = {
  id: STORE_ID,
  code: STORE_ID,
  name: 'Type test store',
  address: 'Test address',
  isActive: true,
  posEnabled: true,
  onlineOrderingEnabled: true,
  inventoryPolicy: 'STRICT' as const,
  createdAt: null,
  updatedAt: null,
};

function product(code: string, fields: Partial<FinishedGood> = {}): FinishedGood {
  return {
    id: code,
    code,
    name: code,
    displayName: code,
    posCategoryCode: 'COFFEE',
    posCategoryName: 'Coffee',
    salePrice: 200,
    productType: 'NORMAL_SELLABLE',
    productionMode: 'MADE_TO_ORDER',
    itemType: 'MADE_TO_ORDER',
    prepStation: 'BARISTA',
    taxRate: 5,
    bom: [{
      componentType: 'RAW_INGREDIENT',
      componentCode: 'COFFEE_BEANS',
      componentName: 'Coffee beans',
      quantity: 10,
      uom: 'G',
      costPerUnit: 1,
      lineCost: 10,
    }],
    bomVersion: 1,
    recipeCost: 10,
    grossMargin: 190,
    cogsPercent: 5,
    sortOrder: 10,
    availableStoreIds: [STORE_ID],
    isSellable: true,
    isAvailable: true,
    isActive: true,
    ...fields,
  };
}

const normal = product('NORMAL');
const internal = product('INTERNAL', {
  productType: 'INTERNAL_COMPONENT',
  salePrice: 0,
  isSellable: false,
  sortOrder: 20,
});
const composite = product('COMPOSITE', {
  productType: 'COMPOSITE_PARENT',
  prepStation: 'NONE',
  bom: [],
  sortOrder: 30,
  composite: {
    schemaVersion: 1,
    staticComponents: [{ finishedGoodId: internal.id!, finishedGoodCode: internal.code, quantity: 2 }],
    choiceGroupIds: [],
  },
});

assert.equal(resolveFinishedGoodProductType(normal), 'NORMAL_SELLABLE');
assert.equal(resolveFinishedGoodProductType(internal), 'INTERNAL_COMPONENT');
assert.equal(resolveFinishedGoodProductType(composite), 'COMPOSITE_PARENT');
assert.equal(resolveFinishedGoodProductType({ ...normal, productType: undefined }), 'NORMAL_SELLABLE');
assert.equal(resolveFinishedGoodProductType({ ...composite, productType: undefined }), 'COMPOSITE_PARENT');
assert.equal(serverProductType.resolveFinishedGoodProductType(internal), 'INTERNAL_COMPONENT');
assert.equal(isDirectlySellableProductRole(normal), true);
assert.equal(isDirectlySellableProductRole(internal), false);
assert.equal(isCompositeParentProduct(composite), true);
assert.equal(isCompositeParentProduct({ ...normal, productType: 'COMPOSITE_PARENT' }), false);

const snapshot = buildPublicMenuAvailabilitySnapshot({
  store,
  finishedGoods: [normal, internal, composite],
  storeStock: [],
  rawIngredients: [{
    id: 'COFFEE_BEANS',
    code: 'COFFEE_BEANS',
    name: 'Coffee beans',
    category: 'Coffee',
    purchaseUOM: 'G',
    usageUOM: 'G',
    conversionFactor: 1,
    purchaseCost: 1,
    costPerUsageUnit: 1,
    isActive: true,
  }],
});
assert.deepEqual(Object.keys(snapshot.menuItems), ['NORMAL', 'COMPOSITE']);
assert.equal(snapshot.menuItems.INTERNAL, undefined);
assert.equal(snapshot.items.COMPOSITE.publicStatus, 'AVAILABLE');
assert.equal(snapshot.menuItems.COMPOSITE.productType, 'COMPOSITE_PARENT');

const components = resolveCanonicalCompositeComponents({
  parentProduct: composite,
  requestedSelections: [],
  groupsById: {},
  componentProductsById: { INTERNAL: internal },
  storeId: STORE_ID,
});
assert.equal(components.length, 1);
assert.equal(components[0].productType, 'INTERNAL_COMPONENT');
assert.equal(components[0].prepStation, 'BARISTA');
assert.equal(components[0].bomVersion, 1);

const canonical = canonicalizeRequestedCart({
  storeId: STORE_ID,
  store,
  gstConfig: { defaultGstRate: 5 },
  requestedItems: [{
    orderItemId: 'PARENT_LINE',
    parentProductId: composite.id,
    parentProductCode: composite.code,
    quantity: 1,
    selectedAddOns: [],
  }],
  productsById: { COMPOSITE: composite },
  groupsById: {},
  componentProductsById: { INTERNAL: internal },
});
assert.equal(Object.keys(canonical.canonicalItems).length, 1, 'the parent is sold exactly once');
assert.equal(canonical.canonicalItems.PARENT_LINE.baseUnitPrice, composite.salePrice);
assert.equal(canonical.canonicalItems.PARENT_LINE.components.length, 1);

const fulfilmentLine = {
  lineKey: 'PARENT_LINE',
  quantity: 1,
  finishedGood: composite,
  components: canonical.canonicalItems.PARENT_LINE.components,
};
const kotTasks = buildKotTasks(fulfilmentLine);
assert.deepEqual(kotTasks.map((task) => [task.itemCode, task.quantity]), [['INTERNAL', 2]]);
const inventoryLines = expandCompositeInventoryLines([fulfilmentLine], STORE_ID);
assert.equal(inventoryLines.length, 1);
assert.equal(inventoryLines[0].finishedGood.code, 'INTERNAL');
assert.equal(inventoryLines[0].quantity, 2);
assert.ok(inventoryLines.every((line) => line.finishedGood.code !== composite.code), 'parent stock is never consumed in addition to child stock');

assert.throws(() => canonicalizeRequestedCart({
  storeId: STORE_ID,
  store,
  gstConfig: { defaultGstRate: 5 },
  requestedItems: [{
    orderItemId: 'INTERNAL_LINE',
    parentProductId: internal.id,
    parentProductCode: internal.code,
    quantity: 1,
    selectedAddOns: [],
  }],
  productsById: { INTERNAL: internal },
  groupsById: {},
}), /no longer available/i);

assert.throws(() => resolvePublicCheckoutProduct({
  product: { ...internal, menuVisible: true, isSellable: true },
  publicAvailability: { itemCode: internal.code, available: true, publicStatus: 'AVAILABLE' },
  publicMenuItem: { ...internal, availableStoreIds: [STORE_ID] },
  store,
}), /currently unavailable/i);

const frozen = structuredClone(components);
const changedChild = { ...internal, bomVersion: 2, bom: [{ ...internal.bom[0], quantity: 99 }] };
assert.deepEqual(validateFrozenCanonicalCompositeComponents({
  components: frozen,
  componentProductsById: { INTERNAL: changedChild },
  store,
  storeId: STORE_ID,
}), frozen, 'held/recall keeps the original child recipe and BOM version');
assert.equal(frozen[0].bomVersion, 1);
assert.equal(frozen[0].bom[0].quantity, 10);

const posSource = readFileSync(resolve(process.cwd(), 'frontend/pages/pos/POSHome.tsx'), 'utf8');
const holdSection = posSource.slice(posSource.indexOf('const holdCurrentBill'), posSource.indexOf('const recallHeldBill'));
assert.doesNotMatch(holdSection, /(createPosRazorpaySession|addDoc\(|setDoc\(|deductInventory|createKOT)/,
  'holding a composite remains local and creates zero KOT/stock/sale writes');
const runningOrdersSource = readFileSync(resolve(process.cwd(), 'frontend/pages/pos/RunningOrders.tsx'), 'utf8');
assert.match(runningOrdersSource, /deterministicVoidReversalMovementId/);
assert.match(runningOrdersSource, /already has reversal stock movements/,
  'void reverses the original child-only movement set at most once');

const publishedCompositeProduct = completePublishedProduct({
  draftProduct: { ...composite, menuVisible: true } as GlobalItemProductVersion,
  baseProduct: composite,
  storeId: STORE_ID,
});
assert.equal(publishedCompositeProduct.productType, 'COMPOSITE_PARENT');
assert.deepEqual(publishedCompositeProduct.composite, composite.composite);

const publishedInternalProduct = completePublishedProduct({
  draftProduct: { ...internal, menuVisible: true, isSellable: true } as GlobalItemProductVersion,
  baseProduct: internal,
  storeId: STORE_ID,
});
assert.equal(publishedInternalProduct.productType, 'INTERNAL_COMPONENT');
assert.equal(publishedInternalProduct.isSellable, false);
assert.equal(publishedInternalProduct.menuVisible, false);

const publishedVersion: PublishedStoreProductVersion = {
  schemaVersion: 1,
  storeId: STORE_ID,
  itemCode: composite.code,
  publishedRevision: 'published-composite-v1',
  sourceDraftRevision: 'draft-composite-v1',
  publishedAt: { seconds: 1, nanoseconds: 0 },
  publishedBy: 'admin',
  product: publishedCompositeProduct,
};
const config: StoreItemConfig = {
  storeId: STORE_ID,
  itemCode: composite.code,
  publishedVersion,
};
assert.strictEqual(resolveEffectiveProduct(composite, config), publishedCompositeProduct);

assert.throws(() => resolveEffectiveProduct(internal, {
  storeId: STORE_ID,
  itemCode: internal.code,
  publishedVersion: {
    ...publishedVersion,
    itemCode: internal.code,
    product: { ...publishedInternalProduct, isSellable: true, menuVisible: true },
  },
}), /invalid/i, 'a malformed visible/sellable published internal component fails closed');

console.log('G8.3A product type semantics tests passed (normal/internal/composite, visibility, sale, KOT, BOM, hold and publication).');
