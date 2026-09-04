import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  effectiveInventoryStoreId as clientEffectiveInventoryStoreId,
  resolveInventoryStore as clientResolveInventoryStore,
} from '../frontend/lib/inventoryStoreResolver';
import {
  buildFinishedGoodsRemakeLine,
  deterministicRemakeKotId,
  deterministicRemakeMovementId,
} from '../frontend/lib/remakeInventory';

const require = createRequire(import.meta.url);
const root = process.cwd();
const authorizationPolicy = require(resolve(root, 'functions/complimentaryAuthorizationPolicy.js'));
const serverResolver = require(resolve(root, 'functions/inventoryStoreResolver.js'));
const onlineOrderInventory = require(resolve(root, 'functions/onlineOrderInventory.js'));

type Test = { name: string; run: () => void | Promise<void> };
const tests: Test[] = [];

function test(name: string, run: Test['run']) {
  tests.push({ name, run });
}

function plannerHarness(records: Record<string, Record<string, unknown>> = {}) {
  const reads: string[] = [];
  const db = {
    collection(collectionName: string) {
      return {
        doc(id: string) {
          return { id, path: `${collectionName}/${id}` };
        },
      };
    },
  };
  const transaction = {
    async get(ref: { id: string; path: string }) {
      reads.push(ref.path);
      const value = records[ref.path];
      return {
        id: ref.id,
        exists: value !== undefined,
        data: () => value,
      };
    },
  };
  const admin = {
    firestore: {
      FieldValue: {
        serverTimestamp: () => 'SERVER_TIMESTAMP',
      },
    },
  };
  return { admin, db, reads, transaction };
}

function store(overrides: Record<string, unknown> = {}) {
  return {
    id: 'TASTING_ROOM_29',
    code: 'TASTING_ROOM_29',
    name: 'The Tasting Room',
    inventoryStoreId: 'NOIDA_29',
    inventoryPolicy: 'STRICT',
    ...overrides,
  };
}

function finishedGood(overrides: Record<string, unknown> = {}) {
  return {
    id: 'TR_FILTER_COFFEE',
    code: 'TR_FILTER_COFFEE',
    name: 'Filter Coffee',
    displayName: 'Filter Coffee',
    itemType: 'MADE_TO_ORDER',
    productionMode: 'MADE_TO_ORDER',
    availableStoreIds: ['TASTING_ROOM_29'],
    isActive: true,
    isSellable: true,
    isAvailable: true,
    bom: [{
      componentType: 'RAW_INGREDIENT',
      componentCode: 'COFFEE_BEANS',
      componentName: 'Coffee Beans',
      quantity: 18,
      uom: 'G',
    }],
    ...overrides,
  };
}

async function plan({
  salesStore = store(),
  item = finishedGood(),
  records = {},
  line,
  source,
}: {
  salesStore?: Record<string, unknown>;
  item?: Record<string, unknown>;
  records?: Record<string, Record<string, unknown>>;
  line?: Record<string, unknown>;
  source?: string;
}) {
  const harness = plannerHarness(records);
  const result = await onlineOrderInventory.planOnlineOrderInventory({
    ...harness,
    store: salesStore,
    orderId: 'TR_ORDER_1',
    orderNumber: 'CB-TR-0001',
    orderType: 'DINE_IN',
    businessDate: '20260902',
    staff: { uid: 'manager-1', name: 'Manager' },
    lines: [line || { lineKey: 'LINE_1', quantity: 1, finishedGood: item, addOns: [] }],
    requireAvailableStock: true,
    ...(source ? { source } : {}),
  });
  return { harness, result };
}

test('self-store fallback is identical and performs no alias lookup', async () => {
  const selfStore = store({
    id: 'NOIDA_29',
    code: 'NOIDA_29',
    name: 'Noida 29',
    inventoryStoreId: undefined,
  });
  let clientLoads = 0;
  let serverLoads = 0;
  assert.equal(clientEffectiveInventoryStoreId(selfStore as never), 'NOIDA_29');
  assert.deepEqual(
    await clientResolveInventoryStore(selfStore as never, async () => { clientLoads += 1; return null; }),
    { id: 'NOIDA_29', code: 'NOIDA_29', name: 'Noida 29' },
  );
  assert.deepEqual(
    await serverResolver.resolveInventoryStore(selfStore, async () => { serverLoads += 1; return null; }),
    { id: 'NOIDA_29', code: 'NOIDA_29', name: 'Noida 29' },
  );
  assert.equal(clientLoads, 0);
  assert.equal(serverLoads, 0);
});

test('frontend and server resolve one direct inventory alias consistently', async () => {
  const target = { id: 'NOIDA_29', code: 'NOIDA_29', name: 'Noida 29' };
  assert.equal(clientEffectiveInventoryStoreId(store() as never), 'NOIDA_29');
  assert.deepEqual(await clientResolveInventoryStore(store() as never, async id => id === target.id ? target : null), target);
  assert.deepEqual(await serverResolver.resolveInventoryStore(store(), async (id: string) => id === target.id ? target : null), target);
});

test('missing and chained aliases fail closed', async () => {
  await assert.rejects(
    clientResolveInventoryStore(store() as never, async () => null),
    /does not exist/,
  );
  await assert.rejects(
    serverResolver.resolveInventoryStore(store(), async () => ({
      id: 'NOIDA_29',
      code: 'NOIDA_29',
      name: 'Noida 29',
      inventoryStoreId: 'WAREHOUSE',
    })),
    /cannot alias another inventory store/,
  );
});

test('server fulfillment authorization requires both logical and physical assignments', () => {
  const activeManager = {
    isActive: true,
    role: 'STORE_MANAGER',
    storeIds: ['TASTING_ROOM_29'],
    assignedStoreIds: ['NOIDA_29'],
  };
  assert.equal(
    authorizationPolicy.isAuthorizedStaffForStorePair(activeManager, 'TASTING_ROOM_29', 'NOIDA_29'),
    true,
  );
  assert.equal(
    authorizationPolicy.isAuthorizedStaffForStorePair(
      { ...activeManager, assignedStoreIds: [] },
      'TASTING_ROOM_29',
      'NOIDA_29',
    ),
    false,
  );
  assert.equal(
    authorizationPolicy.isAuthorizedStaffForStorePair(
      { ...activeManager, isActive: false },
      'TASTING_ROOM_29',
      'NOIDA_29',
    ),
    false,
  );
  assert.equal(
    authorizationPolicy.isAuthorizedStaffForStorePair(
      { isActive: true, role: 'ADMIN', storeIds: [], assignedStoreIds: [] },
      'TASTING_ROOM_29',
      'NOIDA_29',
    ),
    true,
  );
  assert.equal(
    authorizationPolicy.isAuthorizedStaffForStorePair(
      { isActive: true, role: 'CASHIER', storeIds: ['NOIDA_29'] },
      'NOIDA_29',
      'NOIDA_29',
    ),
    true,
  );
});

test('aliased sale reads and updates physical stock while retaining logical attribution', async () => {
  const { harness, result } = await plan({
    records: {
      'stores/NOIDA_29': { code: 'NOIDA_29', name: 'Noida 29' },
      'rawIngredients/COFFEE_BEANS': { code: 'COFFEE_BEANS', name: 'Coffee Beans', usageUOM: 'G', costPerUsageUnit: 2 },
      'storeStock/NOIDA_29_RAW_INGREDIENT_COFFEE_BEANS': {
        stockItemName: 'Coffee Beans', currentStock: 100, uom: 'G', costPerUnit: 2,
      },
    },
  });
  assert.equal(result.blockers.length, 0);
  assert.ok(harness.reads.includes('storeStock/NOIDA_29_RAW_INGREDIENT_COFFEE_BEANS'));
  assert.ok(!harness.reads.includes('storeStock/TASTING_ROOM_29_RAW_INGREDIENT_COFFEE_BEANS'));
  assert.equal(result.stockUpdates[0].stockDocId, 'NOIDA_29_RAW_INGREDIENT_COFFEE_BEANS');
  assert.deepEqual(
    {
      storeId: result.movementPayloads[0].storeId,
      inventoryStoreId: result.movementPayloads[0].inventoryStoreId,
      logicalSalesStoreId: result.movementPayloads[0].logicalSalesStoreId,
      logicalSalesStoreName: result.movementPayloads[0].logicalSalesStoreName,
    },
    {
      storeId: 'NOIDA_29',
      inventoryStoreId: 'NOIDA_29',
      logicalSalesStoreId: 'TASTING_ROOM_29',
      logicalSalesStoreName: 'The Tasting Room',
    },
  );
  assert.equal(result.stockUpdates[0].seedData.storeId, 'NOIDA_29');
});

test('self-store planner retains the legacy stock document identity', async () => {
  const selfStore = store({
    id: 'NOIDA_29', code: 'NOIDA_29', name: 'Noida 29', inventoryStoreId: undefined,
  });
  const selfItem = finishedGood({ availableStoreIds: ['NOIDA_29'] });
  const { harness, result } = await plan({
    salesStore: selfStore,
    item: selfItem,
    records: {
      'rawIngredients/COFFEE_BEANS': { code: 'COFFEE_BEANS', name: 'Coffee Beans', usageUOM: 'G', costPerUsageUnit: 2 },
      'storeStock/NOIDA_29_RAW_INGREDIENT_COFFEE_BEANS': {
        stockItemName: 'Coffee Beans', currentStock: 100, uom: 'G', costPerUnit: 2,
      },
    },
  });
  assert.equal(result.stockUpdates[0].stockDocId, 'NOIDA_29_RAW_INGREDIENT_COFFEE_BEANS');
  assert.equal(result.movementPayloads[0].storeId, 'NOIDA_29');
  assert.equal(result.movementPayloads[0].logicalSalesStoreId, 'NOIDA_29');
  assert.ok(!harness.reads.includes('stores/NOIDA_29'));
});

test('aliased V2 remake consumes the persisted component snapshot from physical stock', async () => {
  const component = {
    sequence: 1,
    source: 'STATIC',
    componentFinishedGoodId: 'TR_FILTER_COFFEE',
    componentFinishedGoodCode: 'TR_FILTER_COFFEE',
    componentName: 'Filter Coffee',
    quantity: 1,
    prepStation: 'BARISTA',
    itemType: 'MADE_TO_ORDER',
    productionMode: 'MADE_TO_ORDER',
    bom: [{
      componentType: 'RAW_INGREDIENT',
      componentCode: 'COFFEE_BEANS',
      componentName: 'Coffee Beans',
      quantity: 18,
      uom: 'G',
    }],
    bomVersion: 3,
  };
  const kot = {
    id: 'TR_ORDER_1_KOT_COMP_001',
    orderId: 'TR_ORDER_1',
    orderNumber: 'CB-TR-0001',
    orderItemId: 'LINE_1',
    storeId: 'TASTING_ROOM_29',
    storeCode: 'TASTING_ROOM_29',
    storeName: 'The Tasting Room',
    station: 'BARISTA',
    itemName: 'Filter Coffee',
    itemCode: 'TR_FILTER_COFFEE',
    quantity: 1,
    orderType: 'DINE_IN',
    tableNumber: '1',
    customerName: 'Guest',
    status: 'SERVED',
    component,
    createdAt: null,
    updatedAt: null,
    createdByUserId: 'manager-1',
    createdByName: 'Manager',
  };
  const orderItem = {
    id: 'LINE_1',
    sourceSystem: 'FINISHED_GOODS',
    menuItemId: 'TR_FLIGHT',
    itemName: 'Coffee Flight',
    itemCode: 'TR_FLIGHT',
    finishedGoodCode: 'TR_FLIGHT',
    quantity: 1,
    addOns: [],
    components: [component],
  };
  const remakeKotId = deterministicRemakeKotId(kot as never);
  const line = buildFinishedGoodsRemakeLine({
    orderItem: orderItem as never,
    kot: kot as never,
    remakeKotId,
    logicalStoreId: 'TASTING_ROOM_29',
  });
  assert.equal(remakeKotId, 'TR_ORDER_1_KOT_COMP_001_REMAKE_01');
  assert.equal(line.lineKey, 'TR_ORDER_1_KOT_COMP_001_REMAKE_01__COMP_001');
  assert.equal(line.quantity, 1);
  assert.deepEqual(line.finishedGood.bom, component.bom);

  const { harness, result } = await plan({
    line: line as unknown as Record<string, unknown>,
    source: 'REMAKE',
    records: {
      'stores/NOIDA_29': { code: 'NOIDA_29', name: 'Noida 29' },
      'rawIngredients/COFFEE_BEANS': { code: 'COFFEE_BEANS', name: 'Coffee Beans', usageUOM: 'G', costPerUsageUnit: 2 },
      'storeStock/NOIDA_29_RAW_INGREDIENT_COFFEE_BEANS': {
        stockItemName: 'Coffee Beans', currentStock: 100, uom: 'G', costPerUnit: 2,
      },
    },
  });
  assert.equal(result.blockers.length, 0);
  assert.equal(result.stockUpdates[0].stockDocId, 'NOIDA_29_RAW_INGREDIENT_COFFEE_BEANS');
  assert.equal(result.movementPayloads[0].storeId, 'NOIDA_29');
  assert.equal(result.movementPayloads[0].inventoryStoreId, 'NOIDA_29');
  assert.equal(result.movementPayloads[0].logicalSalesStoreId, 'TASTING_ROOM_29');
  assert.equal(result.movementPayloads[0].source, 'REMAKE');
  assert.equal(result.movementPayloads[0].quantity, -18);
  assert.ok(harness.reads.includes('storeStock/NOIDA_29_RAW_INGREDIENT_COFFEE_BEANS'));
  assert.equal(
    deterministicRemakeMovementId(remakeKotId, result.movementPayloads[0]),
    deterministicRemakeMovementId(remakeKotId, result.movementPayloads[0]),
  );
});

test('normal-store V2 remake keeps self-store stock and canonical add-ons', async () => {
  const selfStore = store({
    id: 'NOIDA_29', code: 'NOIDA_29', name: 'Noida 29', inventoryStoreId: undefined,
  });
  const item = finishedGood({ availableStoreIds: ['NOIDA_29'] });
  const kot = {
    id: 'NOIDA_ORDER_1_KOT_BARISTA',
    quantity: 1,
  };
  const line = buildFinishedGoodsRemakeLine({
    orderItem: {
      sourceSystem: 'FINISHED_GOODS',
      finishedGoodCode: 'TR_FILTER_COFFEE',
      itemCode: 'TR_FILTER_COFFEE',
      itemName: 'Filter Coffee',
      quantity: 1,
      addOns: [{ optionId: 'EXTRA_SHOT', name: 'Extra shot', price: 50 }],
    } as never,
    kot: kot as never,
    remakeKotId: deterministicRemakeKotId(kot as never),
    liveFinishedGood: item as never,
    logicalStoreId: 'NOIDA_29',
  });
  assert.equal(line.lineKey, 'NOIDA_ORDER_1_KOT_BARISTA_REMAKE_01');
  assert.equal(line.addOns?.length, 1);

  const { harness, result } = await plan({
    salesStore: selfStore,
    line: line as unknown as Record<string, unknown>,
    source: 'REMAKE',
    records: {
      'rawIngredients/COFFEE_BEANS': { code: 'COFFEE_BEANS', name: 'Coffee Beans', usageUOM: 'G', costPerUsageUnit: 2 },
      'storeStock/NOIDA_29_RAW_INGREDIENT_COFFEE_BEANS': {
        stockItemName: 'Coffee Beans', currentStock: 100, uom: 'G', costPerUnit: 2,
      },
    },
  });
  assert.equal(result.blockers.length, 0);
  assert.equal(result.movementPayloads[0].storeId, 'NOIDA_29');
  assert.equal(result.movementPayloads[0].logicalSalesStoreId, 'NOIDA_29');
  assert.equal(result.movementPayloads[0].source, 'REMAKE');
  assert.ok(!harness.reads.includes('stores/NOIDA_29'));
});

test('deferred BOM record uses physical storeId and logical sales audit fields', async () => {
  const { result } = await plan({
    salesStore: store({ inventoryPolicy: 'ALLOW_NEGATIVE_DEFER_BOM' }),
    item: finishedGood({ bom: [] }),
    records: {
      'stores/NOIDA_29': { code: 'NOIDA_29', name: 'Noida 29' },
    },
  });
  assert.equal(result.pendingConsumptionPayloads.length, 1);
  assert.equal(result.pendingConsumptionPayloads[0].storeId, 'NOIDA_29');
  assert.equal(result.pendingConsumptionPayloads[0].inventoryStoreId, 'NOIDA_29');
  assert.equal(result.pendingConsumptionPayloads[0].logicalSalesStoreId, 'TASTING_ROOM_29');
  assert.equal(result.pendingConsumptionPayloads[0].idempotencyKey, 'TASTING_ROOM_29_TR_ORDER_1_LINE_1');
});

test('void and backfill paths use physical identity and preserve logical attribution', () => {
  const clientInventory = readFileSync(resolve(root, 'frontend/lib/inventoryDeduction.ts'), 'utf8');
  const runningOrders = readFileSync(resolve(root, 'frontend/pages/pos/RunningOrders.tsx'), 'utf8');
  const backfill = readFileSync(resolve(root, 'scripts/backfill-pending-bom-consumption.mjs'), 'utf8');
  const readyToServe = readFileSync(resolve(root, 'frontend/pages/kot/ReadyToServe.tsx'), 'utf8');
  assert.match(clientInventory, /getStockDocId\(inventoryStore\.id, stockItemType, stockItemCode\)/);
  assert.match(clientInventory, /\.\.\.inventoryAttribution,[\s\S]*\.\.\.logicalSalesAttribution,[\s\S]*movementType: 'SALE_DEDUCTION'/);
  assert.match(runningOrders, /where\('storeId', '==', inventoryStore\.id\)/);
  assert.match(runningOrders, /inventoryStoreId: target\.movement\.inventoryStoreId \|\| target\.movement\.storeId/);
  assert.match(runningOrders, /logicalSalesStoreId: target\.movement\.logicalSalesStoreId \|\| freshOrder\.storeId/);
  assert.match(backfill, /getStockDocId\(inventoryStore\.id, movement\.stockItemType, movement\.stockItemCode\)/);
  assert.match(backfill, /\.\.\.inventoryAttribution,[\s\S]*\.\.\.logicalSalesAttribution,[\s\S]*movementType: 'ORDER_BOM_BACKFILL'/);
  assert.match(readyToServe, /planInventoryDeductionForSale\(\{[\s\S]*source: 'REMAKE'/);
  assert.match(readyToServe, /deterministicRemakeMovementId\(remakeKotId, movement\)/);
  assert.match(readyToServe, /movementType: 'WASTAGE',[\s\S]*source: 'REMAKE'/);
});

test('readiness uses physical stock while inventory entry screens exclude logical aliases', () => {
  const posReadiness = readFileSync(resolve(root, 'frontend/pages/admin/POSReadiness.tsx'), 'utf8');
  const goLiveReadiness = readFileSync(resolve(root, 'frontend/pages/admin/GoLiveReadiness.tsx'), 'utf8');
  const purchaseEntry = readFileSync(resolve(root, 'frontend/pages/inventory/PurchaseEntry.tsx'), 'utf8');
  const stockCorrection = readFileSync(resolve(root, 'frontend/pages/inventory/StockCorrection.tsx'), 'utf8');
  assert.match(posReadiness, /const inventoryStoreId = effectiveInventoryStoreId\(store\)/);
  assert.match(posReadiness, /getStockDocId\(inventoryStoreId, line\.componentType, line\.componentCode\)/);
  assert.match(goLiveReadiness, /const storeStock = data\.storeStock\.filter\(\(stock\) => stock\.storeId === inventoryStoreId\)/);
  assert.match(goLiveReadiness, /movement\.logicalSalesStoreId[\s\S]*movement\.logicalSalesStoreId === store\.id/);
  assert.match(goLiveReadiness, /inventoryStoreScoped\('stockMovements'/);
  assert.match(purchaseEntry, /loadedStores = loadedStores\.filter\(\(store\) => effectiveInventoryStoreId\(store\) === store\.id\)/);
  assert.match(stockCorrection, /loaded = loaded\.filter\(\(store\) => effectiveInventoryStoreId\(store\) === store\.id\)/);
  assert.match(purchaseEntry, /assignedStoreIdentifiers\(profile\)/);
  assert.match(stockCorrection, /assignedStoreIdentifiers\(profile\)/);
  assert.match(purchaseEntry, /assignedIds\.map\(storeId => getDoc\(doc\(db, 'stores', storeId\)\)\)/);
  assert.match(stockCorrection, /assignedIds\.map\(storeId => getDoc\(doc\(db, 'stores', storeId\)\)\)/);
  assert.doesNotMatch(purchaseEntry, /query\(collection\(db, 'stores'\), where\('isActive'/);
  assert.doesNotMatch(stockCorrection, /query\(collection\(db, 'stores'\), where\('isActive'/);
});

test('POS readiness expands composite children and fails closed without requiring a parent BOM', () => {
  const posReadiness = readFileSync(resolve(root, 'frontend/pages/admin/POSReadiness.tsx'), 'utf8');
  assert.match(posReadiness, /parent\.unresolvedCompositeRequirements[\s\S]*component requirements still need owner confirmation/);
  assert.match(posReadiness, /enabledOptionIdsByGroup[\s\S]*option\?\.finishedGoodComponent/);
  assert.match(posReadiness, /selectionMode[\s\S]*SINGLE[\s\S]*EXACT_DISTINCT/);
  assert.match(posReadiness, /finishedById\.get\(reference\.finishedGoodId\)[\s\S]*component Finished Good reference is missing or changed/);
  assert.match(posReadiness, /child\.isActive !== true[\s\S]*child\.isAvailable === false[\s\S]*childStoreIds\.includes\(store\.id\)/);
  assert.match(posReadiness, /addCompositeChildStockRequirements\(parent, child\)/);
  assert.match(posReadiness, /getStockDocId\(inventoryStoreId, line\.componentType, line\.componentCode\)/);
  assert.match(posReadiness, /if \(fg\.composite\) \{[\s\S]*scanComposite\(fg\);[\s\S]*return;[\s\S]*isStockTrackedFinishedGood/);
});

let passed = 0;
for (const entry of tests) {
  await entry.run();
  passed += 1;
  console.log(`PASS ${entry.name}`);
}
console.log(`Inventory store alias tests passed: ${passed}/${tests.length}`);
