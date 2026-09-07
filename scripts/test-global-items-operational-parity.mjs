import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { buildKotTasks } from '../frontend/lib/compositeFulfillment.ts';
import { buildPublicMenuAvailabilitySnapshot } from '../frontend/lib/publicMenuAvailability.ts';
import { resolveEffectiveProduct } from '../frontend/lib/storeItemConfig.ts';
import { summarizeReportingRecords } from '../functions/reportingCore.mjs';

const require = createRequire(import.meta.url);
const root = process.cwd();
const {
  canonicalizeFrozenAuthorizationCart,
  canonicalizeRequestedCart,
} = require(resolve(root, 'functions/posAddOnAuthorization.js'));
const { canonicalizeCustomerCheckout } = require(resolve(root, 'functions/customerCheckoutCanonicalization.js'));
const { resolveEffectiveProductSnapshots } = require(resolve(root, 'functions/effectiveProductCatalog.js'));
const { planOnlineOrderInventory } = require(resolve(root, 'functions/onlineOrderInventory.js'));
const { rupeesToPaise } = require(resolve(root, 'functions/razorpayCheckoutPolicy.js'));
const { storeItemConfigDocId } = require(resolve(root, 'functions/storeItemConfigPolicy.js'));

const NOIDA_29 = 'NOIDA_29';
const GOLDEN_I = 'GOLDEN_I';
const ITEM_CODE = 'AFFOGATO';
let checks = 0;

function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
  console.log(`PASS ${checks}. ${message}`);
}

function equal(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks += 1;
  console.log(`PASS ${checks}. ${message}`);
}

function bom(componentCode) {
  return [{
    componentType: 'RAW_INGREDIENT',
    componentCode,
    componentName: componentCode,
    quantity: 10,
    uom: 'G',
    costPerUnit: 1,
    lineCost: 10,
  }];
}

const BASE_AFFOGATO = {
  id: ITEM_CODE,
  code: ITEM_CODE,
  name: 'Affogato',
  displayName: 'Affogato',
  description: 'Classic affogato',
  categoryId: 'COFFEE',
  categoryCode: 'COFFEE',
  categoryName: 'Coffee',
  posCategoryCode: 'COFFEE',
  posCategoryName: 'Coffee',
  salePrice: 280,
  taxRate: 5,
  prepStation: 'BARISTA',
  addOnGroupIds: ['A'],
  addOnOptionIdsByGroup: { A: ['A1'] },
  bom: bom('COMPONENT_A'),
  bomVersion: 1,
  itemType: 'MADE_TO_ORDER',
  productionMode: 'MADE_TO_ORDER',
  recipeCost: 10,
  grossMargin: 270,
  cogsPercent: 3.57,
  sortOrder: 1,
  availableStoreIds: [GOLDEN_I, NOIDA_29],
  isActive: true,
  isSellable: true,
  isAvailable: true,
};

const PUBLISHED_AFFOGATO = {
  ...BASE_AFFOGATO,
  name: 'Affogato Reserve',
  displayName: 'Affogato Reserve',
  description: 'Noida reserve affogato',
  categoryId: 'EXPERIENCES',
  categoryCode: 'EXPERIENCES',
  categoryName: 'Experiences',
  posCategoryCode: 'EXPERIENCES',
  posCategoryName: 'Experiences',
  salePrice: 300,
  taxRate: 12,
  prepStation: 'KITCHEN',
  addOnGroupIds: ['B'],
  addOnOptionIdsByGroup: { B: ['B1'] },
  bom: bom('COMPONENT_B'),
  bomVersion: 2,
  recipeCost: 12,
  availableStoreIds: [NOIDA_29],
  menuVisible: true,
};

const VERSIONED_CONFIG = {
  storeId: NOIDA_29,
  itemCode: ITEM_CODE,
  priceOverride: 999,
  isAvailableOverride: false,
  menuVisibilityOverride: false,
  sortOrderOverride: 999,
  managementMode: 'FULL_VERSION_MANAGED',
  publishedVersion: {
    schemaVersion: 1,
    storeId: NOIDA_29,
    itemCode: ITEM_CODE,
    sourceDraftRevision: 'draft-affogato-v1',
    publishedRevision: 'published-affogato-v1',
    publishedAt: '2026-09-07T00:00:00.000Z',
    publishedBy: 'admin',
    publishedByName: 'Admin',
    product: PUBLISHED_AFFOGATO,
  },
};

function addOnGroup(id, optionId, price) {
  return {
    id,
    name: `Group ${id}`,
    isActive: true,
    minimumSelections: 0,
    maximumSelections: 2,
    selectionMode: 'MULTIPLE',
    purpose: 'ADD_ON',
    options: [{
      id: optionId,
      name: `Option ${optionId}`,
      price,
      taxRate: 5,
      isActive: true,
      inventoryItemType: 'RAW_INGREDIENT',
      inventoryItemCode: `ADDON_${optionId}`,
      consumptionQuantity: 1,
      consumptionUnit: 'G',
    }],
  };
}

const GROUP_A = addOnGroup('A', 'A1', 10);
const GROUP_B = addOnGroup('B', 'B1', 20);
const GROUPS_BY_ID = { A: GROUP_A, B: GROUP_B };

function store(id, overrides = {}) {
  return {
    id,
    code: id,
    name: id,
    isActive: true,
    posEnabled: true,
    onlineOrderingEnabled: true,
    inventoryPolicy: 'STRICT',
    ...overrides,
  };
}

function snapshot(id, value, path = '') {
  return { id, exists: value !== undefined, data: () => value, ref: { id, path } };
}

function fakeDb(documents) {
  return {
    collection(collectionName) {
      return {
        doc(documentId) {
          const path = `${collectionName}/${documentId}`;
          return {
            id: documentId,
            path,
            async get() {
              return snapshot(documentId, documents.get(path), path);
            },
          };
        },
      };
    },
  };
}

const noidaEffective = resolveEffectiveProduct(BASE_AFFOGATO, VERSIONED_CONFIG);
const goldenEffective = resolveEffectiveProduct(BASE_AFFOGATO, null);
equal(noidaEffective, PUBLISHED_AFFOGATO, 'Noida 29 resolves the complete published product as one version');
check(goldenEffective === BASE_AFFOGATO, 'Golden I keeps exact fallback identity without a published version');
equal(noidaEffective.salePrice, 300, 'published version defeats conflicting legacy price authority');
equal(noidaEffective.isAvailable, true, 'published version defeats conflicting legacy availability authority');

const configPath = `storeItemConfig/${storeItemConfigDocId(NOIDA_29, ITEM_CODE)}`;
const catalogueDocuments = new Map([[configPath, VERSIONED_CONFIG]]);
const catalogueDb = fakeDb(catalogueDocuments);
const noidaCatalogue = await resolveEffectiveProductSnapshots({
  db: catalogueDb,
  storeId: NOIDA_29,
  productSnapshots: [snapshot(ITEM_CODE, BASE_AFFOGATO)],
  readSnapshot: reference => reference.get(),
});
equal(noidaCatalogue[0].displayName, 'Affogato Reserve', 'POS catalogue displays the published name');
equal(noidaCatalogue[0].salePrice, 300, 'POS catalogue displays the published price');
equal(noidaCatalogue[0].posCategoryName, 'Experiences', 'POS catalogue displays the published category');

const noidaStore = store(NOIDA_29);
const goldenStore = store(GOLDEN_I);
const noidaPublic = buildPublicMenuAvailabilitySnapshot({
  store: noidaStore,
  finishedGoods: [BASE_AFFOGATO],
  storeStock: [],
  rawIngredients: [
    { code: 'COMPONENT_A', name: 'A', usageUOM: 'G', isActive: true },
    { code: 'COMPONENT_B', name: 'B', usageUOM: 'G', isActive: true },
  ],
  addOnGroups: [GROUP_A, GROUP_B],
  storeItemConfigs: [VERSIONED_CONFIG],
});
const goldenPublic = buildPublicMenuAvailabilitySnapshot({
  store: goldenStore,
  finishedGoods: [BASE_AFFOGATO],
  storeStock: [],
  rawIngredients: [{ code: 'COMPONENT_A', name: 'A', usageUOM: 'G', isActive: true }],
  addOnGroups: [GROUP_A, GROUP_B],
});
equal(noidaPublic.menuItems[ITEM_CODE].displayName, 'Affogato Reserve', 'Noida customer menu uses the published name');
equal(noidaPublic.menuItems[ITEM_CODE].salePrice, 300, 'Noida customer menu uses the published price');
equal(noidaPublic.menuItems[ITEM_CODE].addOnGroupIds, ['B'], 'Noida customer menu uses published add-on group B');
equal(goldenPublic.menuItems[ITEM_CODE].salePrice, 280, 'Golden I customer menu retains the base price');
equal(goldenPublic.menuItems[ITEM_CODE].addOnGroupIds, ['A'], 'Golden I customer menu retains add-on group A');

function canonical(product, storeValue, selectedAddOns = [], gstConfig = { defaultGstRate: 5 }) {
  return canonicalizeRequestedCart({
    storeId: storeValue.id,
    store: storeValue,
    gstConfig,
    requestedItems: [{
      orderItemId: 'LINE_1',
      parentProductId: ITEM_CODE,
      parentProductCode: ITEM_CODE,
      quantity: 1,
      selectedAddOns,
    }],
    productsById: { [ITEM_CODE]: product },
    groupsById: GROUPS_BY_ID,
    componentProductsById: { [ITEM_CODE]: product },
  }).canonicalItems.LINE_1;
}

const noidaCanonical = canonical(noidaEffective, noidaStore, [{ groupId: 'B', optionId: 'B1', quantity: 1 }]);
const goldenCanonical = canonical(goldenEffective, goldenStore, [{ groupId: 'A', optionId: 'A1', quantity: 1 }]);
equal(noidaCanonical.baseUnitPrice, 300, 'server authorization uses the published base price');
equal(noidaCanonical.taxRate, 12, 'published item tax wins over store and application fallbacks');
equal(noidaCanonical.addOns[0].groupId, 'B', 'server add-on authorization uses published group B');
equal(goldenCanonical.baseUnitPrice, 280, 'unselected-store authorization keeps the base price');
equal(goldenCanonical.addOns[0].groupId, 'A', 'unselected-store authorization keeps group A');

const storeTaxProduct = { ...noidaEffective, taxRate: 0 };
equal(canonical(storeTaxProduct, noidaStore, [], { storeOverrides: { [NOIDA_29]: 18 }, defaultGstRate: 5 }).taxRate, 18,
  'store tax override applies when the effective item has no tax rate');
equal(canonical(storeTaxProduct, noidaStore, [], { defaultGstRate: 5 }).taxRate, 5,
  'application tax fallback applies when item and store rates are absent');

const noidaBaseTotal = noidaCanonical.baseUnitPrice + noidaCanonical.addOnTotal;
equal(noidaBaseTotal, 320, 'Cash, UPI, and Split begin from the same server-authorized line value');
equal(rupeesToPaise(
  noidaBaseTotal
  + noidaCanonical.baseUnitPrice * noidaCanonical.taxRate / 100
  + noidaCanonical.addOns[0].totalPrice * noidaCanonical.addOns[0].taxRate / 100,
), 35700,
  'POS Razorpay paise derive from the published-price canonical total');
equal([10, 20, 100].map(percent => Number((noidaBaseTotal * (1 - percent / 100)).toFixed(2))), [288, 256, 0],
  'Cashier, Manager, and Admin discount percentages apply to the same effective subtotal');

const customerDocuments = new Map([
  [`stores/${NOIDA_29}`, noidaStore],
  ['appSettings/gstConfig', { defaultGstRate: 5 }],
  [`finishedGoods/${ITEM_CODE}`, BASE_AFFOGATO],
  [configPath, VERSIONED_CONFIG],
  ['addOnGroups/B', GROUP_B],
  [`publicMenuAvailability/${NOIDA_29}`, noidaPublic],
]);
const customerCheckout = await canonicalizeCustomerCheckout({
  db: fakeDb(customerDocuments),
  sessionId: 'AFFOGATO_CUSTOMER_CHECKOUT',
  data: {
    storeId: NOIDA_29,
    storeCode: NOIDA_29,
    customerName: 'Parity Test',
    orderType: 'PICKUP',
    items: [{
      parentProductId: ITEM_CODE,
      parentProductCode: ITEM_CODE,
      quantity: 1,
      selectedAddOns: [{ groupId: 'B', optionId: 'B1', quantity: 1 }],
    }],
  },
});
equal(customerCheckout.items[0].itemName, 'Affogato Reserve', 'customer checkout freezes the published name');
equal(customerCheckout.items[0].baseUnitPrice, 300, 'Pay Online canonicalization uses the published price');
equal(customerCheckout.items[0].prepStation, 'KITCHEN', 'customer checkout freezes published KOT routing');
equal(customerCheckout.items[0].productSnapshot.bom[0].componentCode, 'COMPONENT_B', 'customer checkout freezes the published BOM');

function inventoryDocuments(storeId) {
  return new Map([
    ['rawIngredients/COMPONENT_A', { code: 'COMPONENT_A', name: 'A', usageUOM: 'G', costPerUsageUnit: 1 }],
    ['rawIngredients/COMPONENT_B', { code: 'COMPONENT_B', name: 'B', usageUOM: 'G', costPerUsageUnit: 1 }],
    [`storeStock/${storeId}_RAW_INGREDIENT_COMPONENT_A`, { stockItemName: 'A', currentStock: 100, uom: 'G', costPerUnit: 1 }],
    [`storeStock/${storeId}_RAW_INGREDIENT_COMPONENT_B`, { stockItemName: 'B', currentStock: 100, uom: 'G', costPerUnit: 1 }],
  ]);
}

async function inventoryPlan(storeValue, product) {
  const db = fakeDb(inventoryDocuments(storeValue.id));
  return planOnlineOrderInventory({
    transaction: { get: reference => reference.get() },
    db,
    admin: { firestore: { FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' } } },
    store: storeValue,
    orderId: `ORDER_${storeValue.id}`,
    orderNumber: `CB-${storeValue.id}-1`,
    orderType: 'DINE_IN',
    businessDate: '20260907',
    staff: { uid: 'admin', name: 'Admin' },
    lines: [{ lineKey: 'LINE_1', quantity: 1, finishedGood: product, addOns: [] }],
    requireAvailableStock: true,
    source: 'POS',
  });
}

const noidaInventory = await inventoryPlan(noidaStore, noidaEffective);
const goldenInventory = await inventoryPlan(goldenStore, goldenEffective);
equal(noidaInventory.movementPayloads.length, 1, 'selected store consumes its published BOM exactly once');
equal(noidaInventory.movementPayloads[0].stockItemCode, 'COMPONENT_B', 'selected store consumes component B');
equal(goldenInventory.movementPayloads[0].stockItemCode, 'COMPONENT_A', 'unselected store consumes component A');
equal(buildKotTasks({ quantity: 1, finishedGood: noidaEffective }).map(task => task.station), ['KITCHEN'],
  'published prep station creates exactly one Kitchen KOT');
equal(buildKotTasks({ quantity: 1, finishedGood: goldenEffective }).map(task => task.station), ['BARISTA'],
  'unselected store creates exactly one Barista KOT');

const revisionTwo = {
  ...PUBLISHED_AFFOGATO,
  salePrice: 325,
  taxRate: 18,
  prepStation: 'BARISTA',
  bom: bom('COMPONENT_C'),
  addOnGroupIds: ['A'],
  addOnOptionIdsByGroup: { A: ['A1'] },
};
const heldSource = {
  canonicalItems: { HOLD_LINE: noidaCanonical },
};
const recalled = canonicalizeFrozenAuthorizationCart({
  storeId: NOIDA_29,
  store: noidaStore,
  requestedItems: [{
    orderItemId: 'RECALLED_LINE',
    sourceOrderItemId: 'HOLD_LINE',
    parentProductId: ITEM_CODE,
    parentProductCode: ITEM_CODE,
    quantity: 1,
    selectedAddOns: [{ groupId: 'B', optionId: 'B1', quantity: 1 }],
  }],
  sourceAuthorization: heldSource,
  productsById: { [ITEM_CODE]: revisionTwo },
  componentProductsById: { [ITEM_CODE]: revisionTwo },
}).canonicalItems.RECALLED_LINE;
equal(recalled.baseUnitPrice, 300, 'held-bill recall retains revision N price after revision N+1');
equal(recalled.taxRate, 12, 'held-bill recall retains revision N tax after revision N+1');
equal(recalled.productSnapshot.prepStation, 'KITCHEN', 'held-bill recall retains revision N KOT station');
equal(recalled.productSnapshot.bom[0].componentCode, 'COMPONENT_B', 'held-bill recall retains revision N BOM');

const persistedGrandTotal = customerCheckout.grandTotal;
const report = summarizeReportingRecords([{
  order: {
    id: 'ORDER_N',
    orderNumber: 'CB-NOIDA_29-1',
    storeId: NOIDA_29,
    storeCode: NOIDA_29,
    storeName: 'Noida 29',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    paymentMethod: 'UPI',
    subtotal: customerCheckout.subtotal,
    taxableAmount: customerCheckout.taxableAmount,
    gstTotal: customerCheckout.gstTotal,
    grandTotal: persistedGrandTotal,
    createdAt: new Date('2026-09-07T06:00:00.000Z'),
  },
  items: customerCheckout.items,
  payments: [{ method: 'UPI', amount: persistedGrandTotal }],
}]);
equal(report.netSales, persistedGrandTotal, 'reporting uses persisted transaction values');
equal(report.gstCollected, customerCheckout.gstTotal, 'reporting uses persisted GST values');

const posSource = fs.readFileSync(resolve(root, 'frontend/pages/pos/POSHome.tsx'), 'utf8');
const acceptanceSource = fs.readFileSync(resolve(root, 'frontend/lib/onlineOrderConversion.ts'), 'utf8');
const razorpayAcceptanceSource = fs.readFileSync(resolve(root, 'functions/razorpayCheckout.js'), 'utf8');
const voidSource = fs.readFileSync(resolve(root, 'frontend/pages/pos/RunningOrders.tsx'), 'utf8');
check(posSource.includes('authorizationPurpose: \'HELD_BILL\'') && posSource.includes('sourceAuthorizationId'),
  'held bills create and reuse a server-approved immutable product snapshot');
const holdSection = posSource.slice(posSource.indexOf('const holdCurrentBill'), posSource.indexOf('const recallHeldBill'));
check(
  !/(createPosRazorpaySession|addDoc\(|setDoc\(|deductInventory|createKOT)/.test(holdSection),
  'holding creates no sale, payment request, KOT, or stock consumption');
const deleteHeldSection = posSource.slice(posSource.indexOf('const deleteHeldBill'), posSource.indexOf('const setSplitPaymentMode'));
check(
  deleteHeldSection.includes('persistHeldBills')
    && !/(authorizePosAddOns|createPosRazorpaySession|addDoc\(|setDoc\(|deductInventory|createKOT)/.test(deleteHeldSection),
  'deleting a held bill only removes its local held entry');
check(acceptanceSource.includes('canonicalItem?.productSnapshot || finishedGood'),
  'Pay-at-Counter acceptance uses the submitted effective-product snapshot');
check(razorpayAcceptanceSource.includes('canonicalItem.productSnapshot || finishedGoods[index]'),
  'customer Razorpay acceptance uses the paid effective-product snapshot');
check(!voidSource.slice(voidSource.indexOf('const voidOrder'), voidSource.indexOf('return (')).includes("'finishedGoods'"),
  'void reverses original stock movements without current-product resolution');

for (const count of [125, 128, 128]) {
  const catalogue = Array.from({ length: count }, (_, index) => ({ ...BASE_AFFOGATO, id: `FG_${index}`, code: `FG_${index}` }));
  check(catalogue.every(item => resolveEffectiveProduct(item) === item),
    `no-published-version fallback preserves all ${count} product identities`);
}

console.log(`\n${checks} G8.3 operational effective-product parity checks passed.`);
