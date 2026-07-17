import assert from 'node:assert/strict';
import { buildBerryBaseSplitPlan } from './dry-run-berry-base-split.mjs';

const stores = [
  { id: 'UDAY_PARK', code: 'UDAY_PARK', name: 'Uday Park' },
  { id: 'NOIDA_29', code: 'NOIDA_29', name: 'Noida Sector 29' },
  { id: 'NOIDA_51', code: 'NOIDA_51', name: 'Noida Sector 51' },
  { id: 'GOLDEN_I', code: 'GOLDEN_I', name: 'Golden I' },
];

const basePrep = {
  id: 'BERRY_ME_BASE',
  code: 'BERRY_ME_BASE',
  name: 'Berry Me Smoothie Base',
  outputUOM: 'G',
  yieldUOM: 'G',
  defaultBatchSize: 4500,
  yieldQuantity: 4500,
  costPerUnit: 0.25,
  isStockTracked: true,
  isActive: true,
  bom: [
    { componentType: 'RAW_INGREDIENT', componentCode: 'FROZEN_BLUEBERRY', componentName: 'Frozen Blueberry', quantity: 1000, uom: 'G' },
    { componentType: 'RAW_INGREDIENT', componentCode: 'STRAWBERRY_FROZEN', componentName: 'Strawberry Frozen', quantity: 1000, uom: 'G' },
  ],
};

const rawIngredients = [
  { code: 'FROZEN_BLUEBERRY', name: 'Frozen Blueberry', usageUOM: 'G', isActive: true },
  { code: 'STRAWBERRY_FROZEN', name: 'Strawberry Frozen', usageUOM: 'G', isActive: true },
];

const oldFinishedGoods = [
  {
    id: 'BERRY_ME',
    code: 'BERRY_ME',
    name: 'Berry Me',
    salePrice: 350,
    prepStation: 'BARISTA',
    itemType: 'MADE_TO_ORDER',
    productionMode: 'MADE_TO_ORDER',
    availableStoreIds: ['UDAY_PARK', 'NOIDA_29', 'NOIDA_51'],
    isActive: true,
    isSellable: true,
    isAvailable: true,
    bom: [
      { componentType: 'PREP_ITEM', componentCode: 'BERRY_ME_BASE', componentName: 'Berry Me Smoothie Base', quantity: 350, uom: 'ML' },
    ],
  },
  {
    id: 'BERRY_SMOOTHIE_BOWL',
    code: 'BERRY_SMOOTHIE_BOWL',
    name: 'Berry Smoothie Bowl',
    salePrice: 420,
    prepStation: 'KITCHEN',
    itemType: 'MADE_TO_ORDER',
    productionMode: 'MADE_TO_ORDER',
    availableStoreIds: ['UDAY_PARK', 'NOIDA_29', 'NOIDA_51', 'GOLDEN_I'],
    isActive: true,
    isSellable: true,
    isAvailable: true,
    bom: [
      { componentType: 'PREP_ITEM', componentCode: 'BERRY_ME_BASE', componentName: 'Berry Me Smoothie Base', quantity: 250, uom: 'G' },
    ],
  },
];

const oldStoreStock = [
  { id: 'UDAY_PARK_PREP_ITEM_BERRY_ME_BASE', storeId: 'UDAY_PARK', storeName: 'Uday Park', stockItemType: 'PREP_ITEM', stockItemCode: 'BERRY_ME_BASE', stockItemName: 'Berry Me Smoothie Base', uom: 'G', openingStock: 4500, currentStock: 2550, costPerUnit: 0.25 },
  { id: 'NOIDA_29_PREP_ITEM_BERRY_ME_BASE', storeId: 'NOIDA_29', storeName: 'Noida Sector 29', stockItemType: 'PREP_ITEM', stockItemCode: 'BERRY_ME_BASE', stockItemName: 'Berry Me Smoothie Base', uom: 'G', openingStock: 3000, currentStock: 3000, costPerUnit: 0.25 },
  { id: 'NOIDA_51_PREP_ITEM_BERRY_ME_BASE', storeId: 'NOIDA_51', storeName: 'Noida Sector 51', stockItemType: 'PREP_ITEM', stockItemCode: 'BERRY_ME_BASE', stockItemName: 'Berry Me Smoothie Base', uom: 'G', openingStock: 3000, currentStock: 3000, costPerUnit: 0.25 },
  { id: 'GOLDEN_I_PREP_ITEM_BERRY_ME_BASE', storeId: 'GOLDEN_I', storeName: 'Golden I', stockItemType: 'PREP_ITEM', stockItemCode: 'BERRY_ME_BASE', stockItemName: 'Berry Me Smoothie Base', uom: 'G', openingStock: 0, currentStock: -250, costPerUnit: 0.25 },
];

function plan(overrides = {}) {
  return buildBerryBaseSplitPlan({
    stores,
    rawIngredients,
    prepItems: [basePrep],
    finishedGoods: oldFinishedGoods,
    storeStock: oldStoreStock,
    storeInventory: [],
    stockMovements: [
      { id: 'movement-1', stockItemCode: 'BERRY_ME_BASE', movementType: 'SALE_DEDUCTION' },
    ],
    purchaseEntries: [
      { id: 'purchase-1', lines: [{ itemCode: 'BERRY_ME_BASE' }] },
    ],
    pendingInventoryConsumption: [
      { id: 'pending-1', reason: 'BERRY_ME_BASE setup blocker' },
    ],
    localImportMappingReferences: [
      { collection: 'local-import-mappings', path: 'data/imports/sample.json', referenceType: 'LOCAL_FILE_TEXT_REFERENCE', field: '*', detail: 'File contains BERRY_ME_BASE.' },
    ],
    generatedAt: '2026-07-16T00:00:00.000Z',
    ...overrides,
  });
}

const dryRun = plan();

assert.equal(dryRun.applyReadiness, 'BLOCKED', 'Missing owner opening allocations must block apply readiness.');
assert.equal(dryRun.summary.unitBlockersBefore, 3, 'Three Berry Me ML-to-G unit blockers should be detected before the split.');
assert.equal(dryRun.summary.projectedUnitBlockersAfter, 0, 'Projected split must clear Berry Me unit blockers.');
assert.equal(dryRun.validation.noFinishedGoodReferencesOldBaseAfterProjection, true, 'Projected BOMs must not reference BERRY_ME_BASE.');

const drinkPrep = dryRun.documentsToCreate.find((row) => row.path === 'prepItems/BERRY_ME_DRINK_BASE');
assert.equal(drinkPrep.stockUnit, 'ML', 'Drink replacement base must use ML.');
assert.equal(drinkPrep.proposedPayload.outputUOM, 'ML');
assert.equal(drinkPrep.proposedPayload.yieldUOM, 'ML');

const bowlPrep = dryRun.documentsToCreate.find((row) => row.path === 'prepItems/BERRY_SMOOTHIE_BOWL_BASE');
assert.equal(bowlPrep.stockUnit, 'G', 'Bowl replacement base must use G.');
assert.equal(bowlPrep.proposedPayload.outputUOM, 'G');
assert.equal(bowlPrep.proposedPayload.yieldUOM, 'G');

const berryMeRef = dryRun.proposedNewReferences.find((row) => row.finishedGoodCode === 'BERRY_ME');
assert.equal(berryMeRef.newComponentCode, 'BERRY_ME_DRINK_BASE');
assert.equal(berryMeRef.quantity, 350);
assert.equal(berryMeRef.uom, 'ML');

const bowlRef = dryRun.proposedNewReferences.find((row) => row.finishedGoodCode === 'BERRY_SMOOTHIE_BOWL');
assert.equal(bowlRef.newComponentCode, 'BERRY_SMOOTHIE_BOWL_BASE');
assert.equal(bowlRef.quantity, 250);
assert.equal(bowlRef.uom, 'G');

assert.equal(dryRun.currentStockByStore.find((row) => row.storeCode === 'UDAY_PARK').currentStock, 2550, 'Existing quantities must remain untouched.');
assert.equal(dryRun.currentStockByStore.find((row) => row.storeCode === 'GOLDEN_I').currentStock, -250, 'Negative existing quantity must remain reported exactly.');
assert.equal(dryRun.requiredOwnerProvidedOpeningBalances.length, 8, 'Both replacement bases need owner balances for every affected store.');
assert.equal(dryRun.referencesFound.some((row) => row.collection === 'stockMovements'), true, 'Stock movement references should be inspected.');
assert.equal(dryRun.referencesFound.some((row) => row.collection === 'purchaseEntries'), true, 'Purchase references should be inspected.');
assert.equal(dryRun.referencesFound.some((row) => row.collection === 'pendingInventoryConsumption'), true, 'Pending BOM references should be inspected.');
assert.equal(dryRun.referencesFound.some((row) => row.collection === 'local-import-mappings'), true, 'Import mapping references should be inspected.');

const allocatedStoreStock = [
  ...oldStoreStock,
  ...stores.flatMap((store) => [
    { id: `${store.id}_PREP_ITEM_BERRY_ME_DRINK_BASE`, storeId: store.id, storeName: store.name, stockItemType: 'PREP_ITEM', stockItemCode: 'BERRY_ME_DRINK_BASE', stockItemName: 'Berry Me Drink Base', uom: 'ML', openingStock: 0, currentStock: 0, costPerUnit: 0 },
    { id: `${store.id}_PREP_ITEM_BERRY_SMOOTHIE_BOWL_BASE`, storeId: store.id, storeName: store.name, stockItemType: 'PREP_ITEM', stockItemCode: 'BERRY_SMOOTHIE_BOWL_BASE', stockItemName: 'Berry Smoothie Bowl Base', uom: 'G', openingStock: 0, currentStock: 0, costPerUnit: 0 },
  ]),
];

const readyPlan = plan({ storeStock: allocatedStoreStock });
assert.equal(readyPlan.requiredOwnerProvidedOpeningBalances.length, 0, 'Complete owner allocations should unblock projected apply readiness.');
assert.equal(readyPlan.applyReadiness, 'READY');

const alreadyProjectedFinishedGoods = oldFinishedGoods.map((item) => ({
  ...item,
  bom: item.bom.map((line) => {
    if (item.code === 'BERRY_ME') return { ...line, componentCode: 'BERRY_ME_DRINK_BASE', componentName: 'Berry Me Drink Base', quantity: 350, uom: 'ML' };
    return { ...line, componentCode: 'BERRY_SMOOTHIE_BOWL_BASE', componentName: 'Berry Smoothie Bowl Base', quantity: 250, uom: 'G' };
  }),
}));
const alreadyProjectedPreps = [
  { ...basePrep, isActive: false, splitMigrationStatus: 'LEGACY_REPLACED_BY_BERRY_BASE_SPLIT_PENDING_ALLOCATION' },
  { ...basePrep, code: 'BERRY_ME_DRINK_BASE', name: 'Berry Me Drink Base', outputUOM: 'ML', yieldUOM: 'ML' },
  { ...basePrep, code: 'BERRY_SMOOTHIE_BOWL_BASE', name: 'Berry Smoothie Bowl Base', outputUOM: 'G', yieldUOM: 'G' },
];
const idempotentPlan = plan({
  prepItems: alreadyProjectedPreps,
  finishedGoods: alreadyProjectedFinishedGoods,
  storeStock: allocatedStoreStock,
});
assert.equal(idempotentPlan.documentsToCreate.length, 0, 'Repeated execution must not propose duplicate creates.');
assert.equal(idempotentPlan.documentsToUpdate.length, 0, 'Repeated execution must not propose redundant updates.');
assert.equal(idempotentPlan.applyReadiness, 'READY');

console.log('Berry base split tests passed.');
console.log('- Drink base is ML');
console.log('- Bowl base is G');
console.log('- Berry Me points only to drink base');
console.log('- Berry Smoothie Bowl points only to bowl base');
console.log('- No G-to-ML conversion is performed');
console.log('- Existing quantities remain untouched');
console.log('- Missing opening allocations block apply');
console.log('- Complete allocations permit projected apply');
console.log('- Repeated execution is idempotent');
console.log('- Projected unit blockers become zero');
