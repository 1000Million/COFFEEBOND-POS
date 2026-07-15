import fs from 'node:fs';
import path from 'node:path';
import {
  buildInventoryMovementAuditRows,
  buildInventoryRawConsumptionRows,
  filterInventoryMovementAuditRows,
} from '../frontend/lib/inventoryControlAudit';
import { buildPaymentReversalAudit, orderItemDisplayStatus, paymentOutcomeLabel, summarizeCollections, VOIDED_ITEM_STATUS_LABEL } from '../frontend/lib/paymentReversal';
import type { Order, OrderItem, StockMovement } from '../frontend/types';

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order-test',
    orderNumber: 'CB-TEST-0001',
    storeId: 'UDAY_PARK',
    storeCode: 'UDAY_PARK',
    storeName: 'Uday Park',
    customerId: null,
    customerName: 'Test',
    customerPhone: null,
    createdByUserId: 'staff-test',
    createdByName: 'Test Staff',
    orderType: 'TAKEAWAY',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    tableNumber: null,
    subtotal: 100,
    taxTotal: 5,
    gstTotal: 5,
    taxableAmount: 100,
    discountTotal: 0,
    grandTotal: 105,
    paymentMethod: 'CASH',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function orderItem(status: OrderItem['status']): Pick<OrderItem, 'status'> {
  return { status };
}

const unpaidVoid = buildPaymentReversalAudit(order({
  status: 'VOIDED',
  paymentStatus: 'UNPAID',
  paymentMethod: 'PAY_AT_COUNTER',
  grandTotal: 105,
}));
assert(unpaidVoid.paymentReversalStatus === 'NOT_REQUIRED', 'Unpaid void should not require a refund.');
assert(unpaidVoid.paymentReversalTotal === 0, 'Unpaid void should have zero reversal total.');
assert(paymentOutcomeLabel(order({ status: 'VOIDED', paymentStatus: 'UNPAID', paymentMethod: 'PAY_AT_COUNTER' })) === 'VOIDED / NO PAYMENT', 'Unpaid void label should be clear.');

const cashVoid = buildPaymentReversalAudit(order({ status: 'VOIDED', paymentMethod: 'CASH', grandTotal: 105 }));
assert(cashVoid.paymentReversalStatus === 'REFUNDED', 'Cash void should be marked refunded.');
assert(cashVoid.refundedAmount === 105, 'Cash void should count refunded amount.');
assert(cashVoid.paymentReversalBreakdown[0]?.reversalStatus === 'REFUNDED', 'Cash line should carry REFUNDED status.');

const upiVoid = buildPaymentReversalAudit(order({ status: 'VOIDED', paymentMethod: 'UPI', grandTotal: 105 }));
assert(upiVoid.paymentReversalStatus === 'MANUAL_REFUND_REQUIRED', 'UPI void should require manual refund verification.');
assert(upiVoid.manualRefundRequiredAmount === 105, 'UPI void should count manual refund amount.');

const splitVoidOrder = order({
  status: 'VOIDED',
  isSplitPayment: true,
  paymentMethod: 'CASH',
  paymentBreakdown: [
    { method: 'CASH', amount: 60 },
    { method: 'UPI', amount: 45 },
  ],
  grandTotal: 105,
});
const splitVoid = buildPaymentReversalAudit(splitVoidOrder);
assert(splitVoid.paymentReversalStatus === 'MANUAL_REFUND_REQUIRED', 'Split payment should surface the highest-risk reversal status.');
assert(splitVoid.refundedAmount === 60, 'Split cash component should be refunded.');
assert(splitVoid.manualRefundRequiredAmount === 45, 'Split UPI component should require manual refund.');
assert(splitVoid.paymentReversalBreakdown.length === 2, 'Split payment should keep per-tender reversal lines.');

const collectionSummary = summarizeCollections([
  order({ id: 'completed-cash', grandTotal: 100, paymentMethod: 'CASH' }),
  order({ id: 'voided-cash', status: 'VOIDED', grandTotal: 50, paymentMethod: 'CASH' }),
]);
assert(collectionSummary.grossPaymentsReceived === 150, 'Gross payments should include completed and voided collected payments.');
assert(collectionSummary.voidedPaymentTotal === 50, 'Voided payment total should include the voided payment.');
assert(collectionSummary.netCollections === 100, 'Net collections should exclude voided payment total.');

for (const staleItemStatus of ['PENDING', 'PREPARING', 'READY'] as OrderItem['status'][]) {
  assert(
    orderItemDisplayStatus(order({ status: 'VOIDED' }), orderItem(staleItemStatus)) === VOIDED_ITEM_STATUS_LABEL,
    `Voided orders must override stale item status ${staleItemStatus}.`,
  );
}
assert(orderItemDisplayStatus(order({ status: 'COMPLETED' }), orderItem('READY')) === 'READY', 'Completed orders should keep their item status presentation.');
assert(orderItemDisplayStatus(order({ status: 'COMPLETED' }), null) === 'PENDING', 'Missing item status should still default to pending for non-voided orders.');

const goldenVoidOrder = order({
  id: 'golden-order-id',
  orderNumber: 'CB-GOLDEN_I-20260715-0001',
  storeId: 'GOLDEN_I',
  storeCode: 'GOLDEN_I',
  storeName: 'Golden I',
  status: 'VOIDED',
});

function movement(overrides: Partial<StockMovement>): StockMovement {
  return {
    id: 'movement-test',
    storeId: 'GOLDEN_I',
    storeCode: 'GOLDEN_I',
    storeName: 'Golden I',
    inventoryItemId: 'UNKNOWN',
    inventoryItemName: 'Unknown',
    movementType: 'SALE_DEDUCTION',
    quantity: 0,
    quantityDelta: 0,
    unit: 'G',
    referenceType: 'ORDER',
    referenceId: goldenVoidOrder.id || null,
    orderId: goldenVoidOrder.id,
    orderNumber: goldenVoidOrder.orderNumber,
    notes: null,
    createdByUserId: 'cashier-golden',
    createdByName: 'Golden I Cashier',
    createdAt: new Date('2026-07-15T10:00:00+05:30'),
    ...overrides,
  };
}

const inventoryMovements: StockMovement[] = [
  movement({
    id: 'sale-milk',
    inventoryItemId: 'FRESH_MILK',
    inventoryItemName: 'Fresh Milk',
    stockItemType: 'RAW_INGREDIENT',
    stockItemCode: 'FRESH_MILK',
    quantity: -150,
    quantityDelta: -150,
    unit: 'ML',
    previousQty: 1000,
    newQty: 850,
    cogsAmount: 15,
  }),
  movement({
    id: 'reverse-milk',
    inventoryItemId: 'FRESH_MILK',
    inventoryItemName: 'Fresh Milk',
    stockItemType: 'RAW_INGREDIENT',
    stockItemCode: 'FRESH_MILK',
    movementType: 'ORDER_VOID_REVERSAL',
    quantity: 150,
    quantityDelta: 150,
    unit: 'ML',
    previousQty: 850,
    newQty: 1000,
    orderNumber: '',
    referenceId: goldenVoidOrder.id || null,
    cogsAmount: -15,
    notes: 'Void reversal',
  }),
  movement({
    id: 'sale-coffee',
    inventoryItemId: 'ROASTED_COFFEE_BEANS',
    inventoryItemName: 'Roasted Coffee Beans',
    stockItemType: 'RAW_INGREDIENT',
    stockItemCode: 'ROASTED_COFFEE_BEANS',
    quantity: -19,
    quantityDelta: -19,
    unit: 'G',
    previousQty: 500,
    newQty: 481,
    cogsAmount: 19,
  }),
  movement({
    id: 'reverse-coffee',
    inventoryItemId: 'ROASTED_COFFEE_BEANS',
    inventoryItemName: 'Roasted Coffee Beans',
    stockItemType: 'RAW_INGREDIENT',
    stockItemCode: 'ROASTED_COFFEE_BEANS',
    movementType: 'ORDER_VOID_REVERSAL',
    quantity: 19,
    quantityDelta: 19,
    unit: 'G',
    previousQty: 481,
    newQty: 500,
    orderId: '',
    referenceId: null,
    cogsAmount: -19,
    notes: 'Void reversal',
    ...( { sourceOrderId: goldenVoidOrder.id } as Partial<StockMovement> ),
  }),
];

const auditRows = buildInventoryMovementAuditRows(inventoryMovements, [goldenVoidOrder]);
const reversalRows = filterInventoryMovementAuditRows(auditRows, {
  movementType: 'ORDER_VOID_REVERSAL',
  itemType: 'RAW_INGREDIENT',
  search: '',
});
assert(reversalRows.length === 2, 'Void reversal movement filter should show exactly the two reversal rows.');
assert(reversalRows.every((row) => row.quantityDelta > 0), 'Void reversal rows should display positive quantity changes.');
assert(reversalRows.some((row) => row.itemName === 'Fresh Milk' && row.itemCode === 'FRESH_MILK' && row.quantityDelta === 150 && row.unit === 'ML'), 'Fresh Milk reversal should show item, code, quantity, and unit.');
assert(reversalRows.some((row) => row.itemName === 'Roasted Coffee Beans' && row.quantityDelta === 19 && row.unit === 'G'), 'Coffee reversal should show item and positive quantity.');
assert(reversalRows.every((row) => row.orderNumber === 'CB-GOLDEN_I-20260715-0001'), 'Reversal rows should resolve the order number from supported reference fields.');
const milkReversalRow = reversalRows.find((row) => row.itemCode === 'FRESH_MILK');
const coffeeReversalRow = reversalRows.find((row) => row.itemCode === 'ROASTED_COFFEE_BEANS');
assert(milkReversalRow?.previousQty === 850 && milkReversalRow?.newQty === 1000, '+150 ML should change stock before 850 to stock after 1000.');
assert(coffeeReversalRow?.previousQty === 481 && coffeeReversalRow?.newQty === 500, '+19 G should change stock before 481 to stock after 500.');
assert(filterInventoryMovementAuditRows(auditRows, { movementType: 'SALE_DEDUCTION', itemType: 'RAW_INGREDIENT', search: '' }).length === 2, 'Movement type filter should isolate sale deduction rows.');
assert(filterInventoryMovementAuditRows(auditRows, { movementType: 'ORDER_VOID_REVERSAL', itemType: 'PREP_ITEM', search: '' }).length === 0, 'Item type filter should exclude non-matching movement rows.');
assert(filterInventoryMovementAuditRows(auditRows, { movementType: 'ALL', itemType: 'ALL', search: 'fresh milk' }).length === 2, 'Order/item search should match item name.');
assert(filterInventoryMovementAuditRows(auditRows, { movementType: 'ALL', itemType: 'ALL', search: 'ROASTED_COFFEE' }).length === 2, 'Order/item search should match item code.');
assert(filterInventoryMovementAuditRows(auditRows, { movementType: 'ALL', itemType: 'ALL', search: '20260715-0001' }).length === 4, 'Order/item search should match order number.');

const snapshotRows = buildInventoryMovementAuditRows([
  movement({
    id: 'legacy-no-snapshot',
    inventoryItemId: 'LEGACY_ITEM',
    inventoryItemName: 'Legacy Item',
    stockItemType: 'RAW_INGREDIENT',
    stockItemCode: 'LEGACY_ITEM',
    movementType: 'ORDER_VOID_REVERSAL',
    quantity: 1,
    quantityDelta: 1,
    unit: 'PCS',
    previousQty: undefined,
    newQty: undefined,
  }),
  movement({
    id: 'real-zero-snapshot',
    inventoryItemId: 'ZERO_ITEM',
    inventoryItemName: 'Zero Item',
    stockItemType: 'RAW_INGREDIENT',
    stockItemCode: 'ZERO_ITEM',
    movementType: 'ORDER_VOID_REVERSAL',
    quantity: 150,
    quantityDelta: 150,
    unit: 'ML',
    previousQty: 0,
    newQty: 150,
  }),
  movement({
    id: 'alternate-snapshot-fields',
    inventoryItemId: 'ALT_ITEM',
    inventoryItemName: 'Alt Item',
    stockItemType: 'RAW_INGREDIENT',
    stockItemCode: 'ALT_ITEM',
    movementType: 'ORDER_VOID_REVERSAL',
    quantity: 19,
    quantityDelta: 19,
    unit: 'G',
    previousQty: undefined,
    newQty: undefined,
    ...( { stockBefore: 481, stockAfter: 500 } as Partial<StockMovement> ),
  }),
], [goldenVoidOrder]);
const legacySnapshotRow = snapshotRows.find((row) => row.itemCode === 'LEGACY_ITEM');
const zeroSnapshotRow = snapshotRows.find((row) => row.itemCode === 'ZERO_ITEM');
const alternateSnapshotRow = snapshotRows.find((row) => row.itemCode === 'ALT_ITEM');
assert(legacySnapshotRow?.previousQty === null && legacySnapshotRow?.newQty === null, 'Missing legacy stock snapshots should stay null for Not recorded display.');
assert(zeroSnapshotRow?.previousQty === 0 && zeroSnapshotRow?.newQty === 150, 'A stored zero stock snapshot should be displayed as genuine zero.');
assert(alternateSnapshotRow?.previousQty === 481 && alternateSnapshotRow?.newQty === 500, 'Alternate stockBefore/stockAfter fields should map into stock snapshots.');

const consumptionRows = buildInventoryRawConsumptionRows(inventoryMovements);
const milkConsumption = consumptionRows.find((row) => row.itemCode === 'FRESH_MILK');
const coffeeConsumption = consumptionRows.find((row) => row.itemCode === 'ROASTED_COFFEE_BEANS');
assert(milkConsumption?.grossConsumedQuantity === 150, 'Fresh Milk gross consumption should remain visible.');
assert(milkConsumption?.reversedQuantity === 150, 'Fresh Milk reversed quantity should be visible.');
assert(milkConsumption?.netConsumedQuantity === 0, 'Fully voided Fresh Milk consumption should net to zero.');
assert(coffeeConsumption?.grossConsumedQuantity === 19, 'Coffee gross consumption should remain visible.');
assert(coffeeConsumption?.reversedQuantity === 19, 'Coffee reversed quantity should be visible.');
assert(coffeeConsumption?.netConsumedQuantity === 0, 'Fully voided coffee consumption should net to zero.');
assert(consumptionRows.reduce((sum, row) => sum + row.netCogs, 0) === 0, 'Fully voided order should produce zero net COGS.');

const repoRoot = process.cwd();
const runningOrders = fs.readFileSync(path.join(repoRoot, 'frontend/pages/pos/RunningOrders.tsx'), 'utf8');
const reportsHome = fs.readFileSync(path.join(repoRoot, 'frontend/pages/reports/ReportsHome.tsx'), 'utf8');
const inventoryControl = fs.readFileSync(path.join(repoRoot, 'frontend/pages/inventory/InventoryControl.tsx'), 'utf8');

for (const [label, source] of [['RunningOrders', runningOrders], ['ReportsHome', reportsHome]] as const) {
  assert(source.includes('This order is already voided.'), `${label} must prevent duplicate void attempts.`);
  assert(source.includes('already has reversal stock movements'), `${label} must prevent duplicate stock reversals.`);
  assert(source.includes('Cannot reverse stock'), `${label} must fail safely when inventory reversal cannot be completed.`);
  assert(source.includes('paymentReversalStatus'), `${label} must write void payment audit fields.`);
  assert(source.includes('orderItemDisplayStatus'), `${label} must use void-aware item-status presentation.`);
}
assert(inventoryControl.includes('Stock Movement Audit Filters'), 'Inventory Control should clearly scope movement filters to the stock movement audit.');
assert(inventoryControl.includes('Gross consumed'), 'Inventory Control should show gross consumption.');
assert(inventoryControl.includes('Reversed'), 'Inventory Control should show reversed consumption.');
assert(inventoryControl.includes('Net consumed'), 'Inventory Control should show net consumption.');
assert(inventoryControl.includes('Order / item search'), 'Inventory Control should provide order/item search.');
assert(inventoryControl.includes('Not recorded'), 'Inventory Control should show Not recorded for missing legacy stock snapshots.');
for (const [label, source] of [['RunningOrders', runningOrders], ['ReportsHome', reportsHome]] as const) {
  assert(source.includes('stockBefore') && source.includes('stockAfter'), `${label} reversal writes must save stock before/after snapshots.`);
  assert(source.includes('previousQty') && source.includes('newQty'), `${label} reversal writes must save previousQty/newQty snapshots.`);
  assert(source.includes('quantityDelta: reversalQuantity'), `${label} reversal writes must save positive quantityDelta.`);
}

console.log('Void payment reversal checks passed:');
console.log('- unpaid order void');
console.log('- cash payment void');
console.log('- UPI payment void');
console.log('- split payment void');
console.log('- duplicate void prevention');
console.log('- failed inventory reversal guard');
console.log('- reporting net collection totals after void');
console.log('- voided orders override stale item status presentation');
console.log('- void reversal movements show item, positive quantity, and order reference');
console.log('- movement type, item type, and order/item search filters');
console.log('- gross, reversed, and net raw consumption after full void');
console.log('- stock before/after snapshots for new reversals and Not recorded for legacy rows');
