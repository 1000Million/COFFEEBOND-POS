import assert from 'node:assert/strict';
import {
  APPROVED_WORKBOOK_SHA256,
  IMPORT_SOURCE,
  OTHER_SETUP_INCOMPLETE_PRODUCTS,
  buildRepairPlan,
} from './repair-verified-kitchen-boms.mjs';

const rawDefinitions = [
  ['RAW-001', 'Almonds', 'G', 'ALMONDS'],
  ['RAW-004', 'Baby Corn', 'G', 'BABY_CORN'],
  ['RAW-008', 'Basil', 'G', 'BASIL'],
  ['RAW-011', 'Beans', 'G', 'BEANS'],
  ['RAW-014', 'Black Pepper', 'G', 'BLACK_PEPPER'],
  ['RAW-016', 'Broccoli', 'G', 'BROCCOLI'],
  ['RAW-034', 'Garlic', 'G', 'GARLIC'],
  ['RAW-035', 'Green Capsicum', 'G', 'GREEN_CAPSICUM'],
  ['RAW-038', 'Green Zucchini', 'G', 'GREEN_ZUCCHINI'],
  ['RAW-039', 'Heavy Cream', 'ML', 'HEAVY_CREAM'],
  ['RAW-041', 'Hung Curd', 'G', 'HUNG_CURD'],
  ['RAW-048', 'Milk', 'ML', 'MILK'],
  ['RAW-050', 'Mushroom', 'G', 'MUSHROOM'],
  ['RAW-052', 'Olive Oil', 'ML', 'OLIVE_OIL'],
  ['RAW-055', 'Parmesan Cheese', 'G', 'PARMESAN_CHEESE'],
  ['RAW-057', 'Peanut', 'G', 'PEANUT'],
  ['RAW-058', 'Peri Peri', 'G', 'PERI_PERI'],
  ['RAW-060', 'Red Bell Pepper', 'G', 'RED_BELL_PEPPER'],
  ['RAW-061', 'Salt', 'G', 'SALT'],
  ['RAW-068', 'Vinegar', 'ML', 'VINEGAR'],
  ['RAW-069', 'Walnuts', 'G', 'WALNUTS'],
  ['RAW-072', 'Whole Coriander', 'G', 'WHOLE_CORIANDER'],
  ['RAW-073', 'Yellow Bell Pepper', 'G', 'YELLOW_BELL_PEPPER'],
  ['RAW-074', 'Yellow Zucchini', 'G', 'YELLOW_ZUCCHINI'],
];

function rawBom(prepId, line, linkedId, name, quantity, unit = 'G') {
  return {
    'Prep ID': prepId,
    'Line #': String(line),
    'Component Type': 'Raw Material',
    'Linked ID': linkedId,
    'Standard Component': name,
    Qty: String(quantity),
    UOM: unit,
    'Qty in Linked Base UOM': String(quantity),
    Status: 'OK',
    Notes: '',
    __rowNumber: line + 1,
  };
}

const prepBomRows = [
  rawBom('PREP-001', 1, 'RAW-016', 'Broccoli', 10),
  rawBom('PREP-001', 2, 'RAW-011', 'Beans', 10),
  rawBom('PREP-001', 3, 'RAW-050', 'Mushroom', 10),
  rawBom('PREP-001', 4, 'RAW-038', 'Green Zucchini', 10),
  rawBom('PREP-001', 5, 'RAW-074', 'Yellow Zucchini', 10),
  rawBom('PREP-001', 6, 'RAW-073', 'Yellow Bell Pepper', 10),
  rawBom('PREP-001', 7, 'RAW-035', 'Green Capsicum', 10),
  rawBom('PREP-001', 8, 'RAW-060', 'Red Bell Pepper', 10),
  rawBom('PREP-001', 9, 'RAW-004', 'Baby Corn', 10),
  rawBom('PREP-001', 10, 'RAW-014', 'Black Pepper', 1),
  { ...rawBom('PREP-001', 11, 'RAW-052', 'Olive Oil', 5, 'G'), 'Qty in Linked Base UOM': '5' },
  rawBom('PREP-001', 12, 'RAW-034', 'Garlic', 5),
  rawBom('PREP-001', 13, 'RAW-061', 'Salt', 1),
  rawBom('PREP-003', 1, 'RAW-008', 'Basil', 500),
  rawBom('PREP-003', 2, 'RAW-055', 'Parmesan Cheese', 30),
  rawBom('PREP-003', 3, 'RAW-061', 'Salt', 2),
  rawBom('PREP-003', 4, 'RAW-014', 'Black Pepper', 5),
  rawBom('PREP-003', 5, 'RAW-034', 'Garlic', 10),
  rawBom('PREP-003', 6, 'RAW-052', 'Olive Oil', 50, 'ML'),
  rawBom('PREP-003', 7, 'RAW-069', 'Walnuts', 60),
  rawBom('PREP-015', 1, 'RAW-048', 'Milk', 1000, 'ML'),
  rawBom('PREP-015', 2, 'RAW-039', 'Heavy Cream', 200, 'ML'),
  rawBom('PREP-015', 3, 'RAW-068', 'Vinegar', 15, 'ML'),
  rawBom('PREP-025', 1, 'RAW-058', 'Peri Peri', 50),
  rawBom('PREP-025', 2, 'RAW-001', 'Almonds', 5),
  rawBom('PREP-025', 3, 'RAW-069', 'Walnuts', 5),
  rawBom('PREP-025', 4, 'RAW-057', 'Peanut', 5),
  rawBom('PREP-025', 5, 'RAW-072', 'Whole Coriander', 5),
];

const workbookModel = {
  workbookPath: '/approved/Coffee_Bond_Recipe_BOM_Costing_Master.xlsx',
  workbookSha256: APPROVED_WORKBOOK_SHA256,
  rawRows: rawDefinitions.map(([id, name, unit]) => ({
    'Raw Material ID': id,
    'Standard Ingredient': name,
    'Preferred Base UOM': unit,
  })),
  prepRows: [
    { 'Prep ID': 'PREP-001', 'Prep Recipe': 'Sauteed Veggies', 'Batch Output Qty': '100', 'Output UOM': 'G', Status: 'OK', Notes: '' },
    { 'Prep ID': 'PREP-003', 'Prep Recipe': 'Pesto', 'Batch Output Qty': '500', 'Output UOM': 'G', Status: 'CHECK', Notes: '' },
    { 'Prep ID': 'PREP-015', 'Prep Recipe': 'Ricotta Cheese', 'Batch Output Qty': '200', 'Output UOM': 'G', Status: 'OK', Notes: '' },
    { 'Prep ID': 'PREP-025', 'Prep Recipe': 'Dukkah Spice', 'Batch Output Qty': '70', 'Output UOM': 'G', Status: 'OK', Notes: '' },
  ],
  prepBomRows,
  finalRows: [
    { 'Product ID': 'MENU-028', 'Menu Item': 'The Melbourne Fold', Status: 'CHECK', Notes: '' },
    { 'Product ID': 'MENU-029', 'Menu Item': 'Hung curd & Charred Veg Tartine', Status: 'OK', Notes: '' },
  ],
  finalBomRows: [
    { 'Product ID': 'MENU-028', 'Line #': '1', 'Component Type': 'Direct / Manual', 'Linked ID': '', 'Standard Component': 'Sourdough Bread', Qty: '2', UOM: 'SLICE', 'Qty in Linked Base UOM': '', Status: 'OK', Notes: '' },
    { 'Product ID': 'MENU-028', 'Line #': '2', 'Component Type': 'Prep', 'Linked ID': 'PREP-015', 'Standard Component': 'Ricotta Cheese', Qty: '100', UOM: 'G', 'Qty in Linked Base UOM': '100', Status: 'OK', Notes: '' },
    { 'Product ID': 'MENU-028', 'Line #': '3', 'Component Type': 'Prep', 'Linked ID': 'PREP-003', 'Standard Component': 'Pesto', Qty: '50', UOM: 'G', 'Qty in Linked Base UOM': '50', Status: 'CHECK', Notes: '' },
    { 'Product ID': 'MENU-028', 'Line #': '4', 'Component Type': 'Direct / Manual', 'Linked ID': '', 'Standard Component': 'Peanut Crush Garnish', Qty: '5', UOM: 'G', 'Qty in Linked Base UOM': '', Status: 'OK', Notes: '' },
    { 'Product ID': 'MENU-028', 'Line #': '5', 'Component Type': 'Direct / Manual', 'Linked ID': '', 'Standard Component': 'Eggs', Qty: '2', UOM: 'PCS', 'Qty in Linked Base UOM': '', Status: 'OK', Notes: '' },
    { 'Product ID': 'MENU-029', 'Line #': '1', 'Component Type': 'Direct / Manual', 'Linked ID': '', 'Standard Component': 'Sourdough Bread', Qty: '2', UOM: 'SLICE', 'Qty in Linked Base UOM': '', Status: 'OK', Notes: '' },
    { 'Product ID': 'MENU-029', 'Line #': '2', 'Component Type': 'Raw Material', 'Linked ID': 'RAW-041', 'Standard Component': 'Hung Curd', Qty: '50', UOM: 'G', 'Qty in Linked Base UOM': '50', Status: 'OK', Notes: '' },
    { 'Product ID': 'MENU-029', 'Line #': '3', 'Component Type': 'Prep', 'Linked ID': 'PREP-001', 'Standard Component': 'Sauteed Veggies', Qty: '120', UOM: 'G', 'Qty in Linked Base UOM': '120', Status: 'OK', Notes: '' },
    { 'Product ID': 'MENU-029', 'Line #': '4', 'Component Type': 'Prep', 'Linked ID': 'PREP-025', 'Standard Component': 'Dukkah Spice', Qty: '5', UOM: 'G', 'Qty in Linked Base UOM': '5', Status: 'OK', Notes: '' },
  ],
};

const productMappings = {
  mappings: [
    { workbookProductId: 'MENU-028', workbookName: 'The Melbourne Fold', targetFinishedGoodCode: 'THE_MELBOURNE_FOLD', approvalStatus: 'OWNER_APPROVED' },
    { workbookProductId: 'MENU-029', workbookName: 'Hung curd & Charred Veg Tartine', targetFinishedGoodCode: 'HUNG_CURD__CHARED_VEG_TARTINE', approvalStatus: 'OWNER_APPROVED' },
  ],
};

const componentMappings = {
  mappings: [
    { componentName: 'Sourdough Bread', targetType: 'RAW_INGREDIENT', targetCode: 'SOURDOUGH_BREAD', uomOverride: 'PCS', approvalStatus: 'OWNER_APPROVED' },
    { componentName: 'Eggs', targetType: 'RAW_INGREDIENT', targetCode: 'EGG', approvalStatus: 'OWNER_APPROVED' },
    { componentName: 'Peanut Crush Garnish', approvalStatus: 'OWNER_APPROVED', outputs: [{ targetType: 'RAW_MATERIAL', targetId: 'RAW-057', targetName: 'Peanut', quantity: 5, unit: 'G' }] },
  ],
};

function document(collection, id, data) {
  return { id, path: `${collection}/${id}`, data };
}

function publicSnapshot() {
  const unavailableCodes = new Set([
    'THE_MELBOURNE_FOLD',
    'HUNG_CURD__CHARED_VEG_TARTINE',
    ...OTHER_SETUP_INCOMPLETE_PRODUCTS,
  ]);
  const codes = [...unavailableCodes, ...Array.from({ length: 67 }, (_, index) => `AVAILABLE_${index + 1}`)];
  const items = Object.fromEntries(codes.map((code) => [code, unavailableCodes.has(code)
    ? { itemCode: code, fgCode: code, available: false, publicStatus: 'SETUP_INCOMPLETE', publicMessage: 'Currently unavailable' }
    : { itemCode: code, fgCode: code, available: true, publicStatus: 'AVAILABLE', publicMessage: 'Available' }]));
  const menuItems = Object.fromEntries(codes.map((code) => [code, { code, name: code }]));
  return document('publicMenuAvailability', 'GOLDEN_I', {
    storeId: 'GOLDEN_I',
    storeCode: 'GOLDEN_I',
    itemCount: 80,
    availableCount: 67,
    unavailableCount: 13,
    items,
    menuItems,
  });
}

function baseCatalog() {
  const rawIngredients = rawDefinitions.map(([workbookId, name, usageUOM, code]) => document('rawIngredients', code, {
    code,
    name,
    usageUOM,
    workbookId,
    isActive: true,
  }));
  rawIngredients.push(
    document('rawIngredients', 'SOURDOUGH_BREAD', { code: 'SOURDOUGH_BREAD', name: 'Sourdough Bread', usageUOM: 'PCS', isActive: true }),
    document('rawIngredients', 'EGG', { code: 'EGG', name: 'Egg', usageUOM: 'PCS', isActive: true }),
  );
  return {
    rawIngredients,
    prepItems: [],
    finishedGoods: [
      document('finishedGoods', 'THE_MELBOURNE_FOLD', {
        code: 'THE_MELBOURNE_FOLD',
        name: 'The Melbourne Fold',
        salePrice: 420,
        taxRate: 5,
        availableStoreIds: ['GOLDEN_I'],
        bom: [],
        bomVersion: 2,
      }),
      document('finishedGoods', 'HUNG_CURD__CHARED_VEG_TARTINE', {
        code: 'HUNG_CURD__CHARED_VEG_TARTINE',
        name: 'Hung Curd & Chared Veg Tartine',
        salePrice: 330,
        taxRate: 5,
        availableStoreIds: ['GOLDEN_I'],
        bom: [],
        bomVersion: 3,
      }),
    ],
    publicMenuAvailability: publicSnapshot(),
  };
}

function plan(catalog = baseCatalog()) {
  return buildRepairPlan({
    workbookModel,
    mappingFile: productMappings,
    componentMappingFile: componentMappings,
    catalog,
    generatedAt: '2026-08-01T00:00:00.000Z',
  });
}

const initial = plan();
assert.equal(initial.report.writeCount, 7, 'The repair must propose exactly four prep creates, two BOM updates, and one public snapshot update.');
assert.deepEqual(initial.report.writesByCollection, { prepItems: 4, finishedGoods: 2, publicMenuAvailability: 1 });
assert.equal(initial.report.invariants.publicMenuItemCountBefore, 80);
assert.equal(initial.report.invariants.publicMenuItemCountAfter, 80);
assert.equal(initial.report.invariants.remainingElevenUnchanged, true);
assert.deepEqual(initial.report.invariants.costFieldsWritten, []);
assert.equal(initial.report.invariants.otherStoreWrites, 0);
assert.equal(initial.report.applyReadiness, 'READY_AWAITING_OWNER_APPROVAL');

const prepCreates = initial.operations.filter((operation) => operation.kind === 'PREP_ITEM_CREATE');
assert.deepEqual(prepCreates.map((operation) => operation.path).sort(), [
  'prepItems/PREP-001',
  'prepItems/PREP-003',
  'prepItems/PREP-015',
  'prepItems/PREP-025',
]);
assert.equal(prepCreates.find((operation) => operation.path === 'prepItems/PREP-001').applyPayload.bom.length, 13);
assert.equal(prepCreates.find((operation) => operation.path === 'prepItems/PREP-003').applyPayload.bom.length, 7);
assert.equal(prepCreates.find((operation) => operation.path === 'prepItems/PREP-015').applyPayload.bom.length, 3);
assert.equal(prepCreates.find((operation) => operation.path === 'prepItems/PREP-025').applyPayload.bom.length, 5);

const melbourne = initial.operations.find((operation) => operation.path === 'finishedGoods/THE_MELBOURNE_FOLD');
assert.deepEqual(melbourne.applyPayload.bom.map(({ componentCode, quantity, uom }) => ({ componentCode, quantity, uom })), [
  { componentCode: 'SOURDOUGH_BREAD', quantity: 2, uom: 'PCS' },
  { componentCode: 'PREP-015', quantity: 100, uom: 'G' },
  { componentCode: 'PREP-003', quantity: 50, uom: 'G' },
  { componentCode: 'PEANUT', quantity: 5, uom: 'G' },
  { componentCode: 'EGG', quantity: 2, uom: 'PCS' },
]);
assert.equal(melbourne.applyPayload.bomVersion, 3);
assert.equal(melbourne.applyPayload.importSource, IMPORT_SOURCE);

const tartine = initial.operations.find((operation) => operation.path === 'finishedGoods/HUNG_CURD__CHARED_VEG_TARTINE');
assert.deepEqual(tartine.applyPayload.bom.map(({ componentCode, quantity, uom }) => ({ componentCode, quantity, uom })), [
  { componentCode: 'SOURDOUGH_BREAD', quantity: 2, uom: 'PCS' },
  { componentCode: 'HUNG_CURD', quantity: 50, uom: 'G' },
  { componentCode: 'PREP-001', quantity: 120, uom: 'G' },
  { componentCode: 'PREP-025', quantity: 5, uom: 'G' },
]);
assert.equal(tartine.applyPayload.bomVersion, 4);

for (const operation of [...prepCreates, melbourne, tartine]) {
  const serialized = JSON.stringify(operation.applyPayload);
  assert.doesNotMatch(serialized, /recipeCost|costPerUnit|lineCost|grossMargin|cogsPercent/);
}

const publicUpdate = initial.operations.find((operation) => operation.kind === 'PUBLIC_AVAILABILITY_UPDATE');
assert.equal(publicUpdate.after.itemCount, 80);
assert.equal(publicUpdate.after.availableCount, 69);
assert.equal(publicUpdate.after.unavailableCount, 11);
assert.equal(publicUpdate.after.targetItems.THE_MELBOURNE_FOLD.available, true);
assert.equal(publicUpdate.after.targetItems.HUNG_CURD__CHARED_VEG_TARTINE.available, true);
assert.deepEqual(publicUpdate.before.remainingSetupIncompleteItems, publicUpdate.after.remainingSetupIncompleteItems);

const missingRawCatalog = baseCatalog();
missingRawCatalog.rawIngredients = missingRawCatalog.rawIngredients.filter((item) => item.data.workbookId !== 'RAW-016');
const missingRawPlan = plan(missingRawCatalog);
const broccoliCreate = missingRawPlan.operations.find((operation) => operation.path === 'rawIngredients/RAW-016');
assert.ok(broccoliCreate, 'A required workbook raw ingredient may be created when no exact live target exists.');
assert.equal(broccoliCreate.action, 'CREATE');
assert.equal(broccoliCreate.before, null);
assert.equal(broccoliCreate.after.code, 'RAW-016');
assert.equal(broccoliCreate.after.name, 'Broccoli');
assert.equal(broccoliCreate.after.usageUOM, 'G');
assert.doesNotMatch(JSON.stringify(broccoliCreate.applyPayload), /purchaseCost|costPerUsageUnit/);
assert.equal(missingRawPlan.report.invariants.otherStoreWrites, 0);

const projected = baseCatalog();
for (const operation of initial.operations) {
  if (operation.kind === 'PREP_ITEM_CREATE') {
    const id = operation.path.split('/')[1];
    projected.prepItems.push(document('prepItems', id, { ...operation.applyPayload }));
  } else if (operation.kind === 'FINISHED_GOOD_UPDATE') {
    const target = projected.finishedGoods.find((item) => item.path === operation.path);
    Object.assign(target.data, operation.applyPayload);
  } else if (operation.kind === 'PUBLIC_AVAILABILITY_UPDATE') {
    Object.assign(projected.publicMenuAvailability.data, {
      itemCount: operation.applyPayload.itemCount,
      availableCount: operation.applyPayload.availableCount,
      unavailableCount: operation.applyPayload.unavailableCount,
    });
    Object.assign(projected.publicMenuAvailability.data.items, operation.applyPayload.targetItems);
  }
}
const repeated = plan(projected);
assert.equal(repeated.report.writeCount, 0, 'Repeated execution must be idempotent.');
assert.equal(repeated.report.applyReadiness, 'ALREADY_APPLIED');

const conflicting = baseCatalog();
conflicting.finishedGoods[0].data.bom = [{ componentType: 'RAW_INGREDIENT', componentCode: 'OTHER', componentName: 'Other', quantity: 1, uom: 'G' }];
assert.throws(() => plan(conflicting), /different non-empty BOM/);

assert.throws(() => buildRepairPlan({
  workbookModel,
  mappingFile: { mappings: productMappings.mappings.filter((mapping) => mapping.workbookProductId !== 'MENU-029') },
  componentMappingFile: componentMappings,
  catalog: baseCatalog(),
}), /Missing deterministic finished-product mapping for MENU-029/);

console.log('Verified two-product kitchen BOM repair tests passed.');
console.log('- Exactly two Finished Goods are targeted');
console.log('- Exactly four complete prep recipes are created');
console.log('- Missing required raw masters are create-only and cost-free');
console.log('- Approved BOM quantities and units are preserved');
console.log('- Costs, prices, GST, stock, and store assignments are untouched');
console.log('- Golden I remains an 80-item public snapshot');
console.log('- Only the two repaired products become available');
console.log('- The remaining 11 products remain unchanged');
console.log('- Repeated execution is idempotent');
