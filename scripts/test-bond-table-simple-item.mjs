import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import {
  bondTableFinishedGood,
  bondTablePublicAvailability,
  bondTablePublicMenuItem,
} from './activate-bond-table-simple-item.mjs';
import {
  calculateOnlineOrderLineMoney,
  calculateOnlineOrderTotals,
} from '../frontend/lib/onlineOrderMoney.mjs';

const root = process.cwd();
const require = createRequire(import.meta.url);
const {
  canonicalizeCustomerCheckout,
  roundMoney,
} = require(resolve(root, 'functions/customerCheckoutCanonicalization.js'));
const { planOnlineOrderInventory } = require(resolve(root, 'functions/onlineOrderInventory.js'));
const {
  customerOrderLineMoney,
  customerOrderTotals,
} = require(resolve(root, 'functions/customerOrderMoney.js'));
const { rupeesToPaise } = require(resolve(root, 'functions/razorpayCheckoutPolicy.js'));

const passed = [];
function check(name, condition) {
  assert(condition, name);
  passed.push(name);
}

function snapshot(id, value) {
  return {
    id,
    exists: value !== undefined,
    data: () => value,
  };
}

function fakeFirestore(documents) {
  return {
    collection(collectionName) {
      return {
        doc(documentId) {
          return {
            async get() {
              return snapshot(documentId, documents.get(`${collectionName}/${documentId}`));
            },
          };
        },
      };
    },
  };
}

const store = {
  code: 'TASTING_ROOM_29',
  name: 'Coffee Bond Tasting Room',
  isActive: true,
  onlineOrderingEnabled: true,
};
const documents = new Map([
  ['stores/TASTING_ROOM_29', store],
  ['appSettings/gstConfig', { defaultGstRate: 5 }],
  ['finishedGoods/TR_BOND_TABLE', bondTableFinishedGood],
  ['publicMenuAvailability/TASTING_ROOM_29', {
    items: { TR_BOND_TABLE: bondTablePublicAvailability },
    menuItems: { TR_BOND_TABLE: bondTablePublicMenuItem },
  }],
]);

const checkout = await canonicalizeCustomerCheckout({
  db: fakeFirestore(documents),
  sessionId: 'bond_table_catalogue_payload_test',
  data: {
    storeId: 'TASTING_ROOM_29',
    storeCode: 'TASTING_ROOM_29',
    customerName: 'Catalogue Test',
    orderType: 'PICKUP',
    items: [{
      parentProductId: 'TR_BOND_TABLE',
      parentProductCode: 'TR_BOND_TABLE',
      quantity: 1,
      selectedAddOns: [],
    }],
  },
});

const payAtCounterLine = customerOrderLineMoney({
  baseUnitPrice: bondTableFinishedGood.salePrice,
  addOnUnitTotal: 0,
  quantity: 1,
  taxRate: bondTableFinishedGood.taxRate,
  addOns: [],
});
const payAtCounterTotals = customerOrderTotals([payAtCounterLine]);
const acceptedPayAtCounterLine = calculateOnlineOrderLineMoney({
  baseUnitPrice: bondTableFinishedGood.salePrice,
  selectedAddOnTotal: 0,
  quantity: 1,
  appliedTaxRate: bondTableFinishedGood.taxRate,
  addOnLineTax: 0,
});
const acceptedPayAtCounterTotals = calculateOnlineOrderTotals([acceptedPayAtCounterLine]);

check('activation payload creates exactly one canonical line', checkout.items.length === 1);
check('activation payload keeps the taxable price at 4761.90', checkout.taxableAmount === 4761.9);
check('activation payload applies the existing 5% item GST rate', checkout.items[0].taxRate === 5);
check('canonical GST rounds to 238.10', checkout.gstTotal === 238.1);
check('canonical final payable rounds to 5000.00', checkout.grandTotal === 5000);
check('Razorpay receives exactly 500000 paise', rupeesToPaise(checkout.grandTotal) === 500000);
check('Pay at Counter executes the same exact 4761.90 + 238.10 = 5000.00 result',
  payAtCounterLine.lineSubtotal === 4761.9
  && payAtCounterLine.lineTax === 238.1
  && payAtCounterLine.lineTotal === 5000
  && payAtCounterTotals.taxableAmount === 4761.9
  && payAtCounterTotals.gstTotal === 238.1
  && payAtCounterTotals.grandTotal === 5000);
check('staff acceptance preserves the submitted Pay-at-Counter money snapshot exactly',
  acceptedPayAtCounterLine.lineSubtotal === payAtCounterLine.lineSubtotal
  && acceptedPayAtCounterLine.lineTax === payAtCounterLine.lineTax
  && acceptedPayAtCounterLine.lineTotal === payAtCounterLine.lineTotal
  && acceptedPayAtCounterTotals.taxableAmount === payAtCounterTotals.taxableAmount
  && acceptedPayAtCounterTotals.gstTotal === payAtCounterTotals.gstTotal
  && acceptedPayAtCounterTotals.grandTotal === payAtCounterTotals.grandTotal);
check('line arithmetic is internally exact after paise rounding',
  checkout.items[0].lineSubtotal === 4761.9
  && checkout.items[0].lineTax === 238.1
  && checkout.items[0].lineTotal === 5000);

check('catalogue item uses the supported no-stock mode',
  bondTableFinishedGood.itemType === 'NO_STOCK'
  && bondTableFinishedGood.productionMode === 'NO_STOCK'
  && Array.isArray(bondTableFinishedGood.bom)
  && bondTableFinishedGood.bom.length === 0);
check('catalogue item is active, sellable, available, and assigned only to the Tasting Room',
  bondTableFinishedGood.isActive === true
  && bondTableFinishedGood.isSellable === true
  && bondTableFinishedGood.isAvailable === true
  && JSON.stringify(bondTableFinishedGood.availableStoreIds) === '["TASTING_ROOM_29"]');
check('catalogue and public payload agree on customer copy and price',
  bondTableFinishedGood.description === 'For 2 guests'
  && bondTablePublicMenuItem.description === 'For 2 guests'
  && bondTablePublicMenuItem.salePrice === bondTableFinishedGood.salePrice
  && bondTablePublicAvailability.available === true);

const inventory = await planOnlineOrderInventory({
  transaction: { get: async () => { throw new Error('NO_STOCK must not read inventory'); } },
  db: { collection: () => { throw new Error('NO_STOCK must not read inventory'); } },
  admin: {},
  store: { id: 'TASTING_ROOM_29', ...store },
  orderId: 'BOND_TABLE_NO_STOCK_TEST',
  orderNumber: 'BT-TEST',
  orderType: 'TAKEAWAY',
  businessDate: '2026-09-06',
  staff: { uid: 'test', name: 'Test' },
  lines: [{
    lineKey: 'BT_ITEM_01',
    quantity: 1,
    finishedGood: bondTableFinishedGood,
    addOns: [],
  }],
});
check('accepted no-stock item produces zero stock movements',
  inventory.movementPayloads.length === 0
  && inventory.stockUpdates.length === 0
  && inventory.pendingConsumptionPayloads.length === 0
  && inventory.perLineConsumptionStatus.BT_ITEM_01 === 'NOT_REQUIRED');

const functionSource = readFileSync(resolve(root, 'functions/index.js'), 'utf8');
check('Pay at Counter callable uses the tested money helper',
  functionSource.includes('customerOrderLineMoney,')
  && functionSource.includes('customerOrderTotals,')
  && functionSource.includes('const money = customerOrderLineMoney({')
  && functionSource.includes('customerOrderTotals(onlineItems)'));

const acceptanceSource = readFileSync(resolve(root, 'frontend/lib/onlineOrderConversion.ts'), 'utf8');
check('Pay-at-Counter staff acceptance uses the tested paise-rounding helper',
  acceptanceSource.includes('calculateOnlineOrderLineMoney({')
  && acceptanceSource.includes('calculateOnlineOrderTotals(calculatedLines)'));

const customerSource = readFileSync(resolve(root, 'frontend/pages/customer/CustomerOrder.tsx'), 'utf8');
check('customer menu uses the normal item path and no booking intercept',
  !customerSource.includes('renderBondTableInformation')
  && !customerSource.includes('Booking information')
  && !customerSource.includes('CustomerBondTableBooking'));
check('the final-price presentation is scoped to TR_BOND_TABLE',
  customerSource.includes("const BOND_TABLE_ITEM_CODE = 'TR_BOND_TABLE';")
  && customerSource.includes('return `${formatMyUsualPrice(roundMoney(salePrice + gst))} final`;'));

check('shared money helper still produces the owner-approved exact values',
  roundMoney(4761.9 * 0.05) === 238.1
  && roundMoney(4761.9 + roundMoney(4761.9 * 0.05)) === 5000);

console.log(`Bond Table simple-item tests passed (${passed.length}/${passed.length}).`);
