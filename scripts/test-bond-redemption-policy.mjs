import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  BOND_REDEMPTION_POLICY,
  BondRedemptionPolicyError,
  allocateDiscountPaise,
  applyBondRedemptionToCheckout,
  calculateMaximumUsablePoints,
  validateBondRedemptionRequest,
} = require('../functions/bondRedemptionPolicy');

const passed = [];
function check(name, fn) {
  fn();
  passed.push(name);
  console.log(`PASS ${passed.length}. ${name}`);
}

function expectPolicyError(code, fn) {
  assert.throws(fn, error => (
    error instanceof BondRedemptionPolicyError && error.code === code
  ));
}

const baseCheckout = {
  store: { id: 'STORE_A', code: 'STORE_A' },
  items: [{
    lineId: 'CHECKOUT_ITEM_01',
    finishedGoodId: 'PRODUCT_A',
    finishedGoodCode: 'PRODUCT_A',
    itemName: 'Product A',
    quantity: 1,
    baseUnitPrice: 200,
    unitPrice: 250,
    taxRate: 5,
    addOns: [{
      groupId: 'GROUP_A',
      optionId: 'ADD_ON_A',
      quantity: 1,
      unitPrice: 50,
      totalPrice: 50,
      taxRate: 18,
    }],
    addOnTotal: 50,
    lineSubtotal: 250,
    lineTaxable: 250,
    lineTax: 19,
    lineTotal: 269,
  }],
  subtotal: 250,
  discount: 0,
  taxableAmount: 250,
  gstTotal: 19,
  grandTotal: 269,
};

check('policy is customer ordering only and values one point at one rupee', () => {
  assert.equal(BOND_REDEMPTION_POLICY.eligibleChannel, 'CUSTOMER_WEB');
  assert.equal(BOND_REDEMPTION_POLICY.pointValuePaise, 100);
  assert.equal(BOND_REDEMPTION_POLICY.minimumPoints, 50);
  assert.equal(BOND_REDEMPTION_POLICY.incrementPoints, 10);
  assert.equal(BOND_REDEMPTION_POLICY.maximumEligibleSubtotalBasisPoints, 2000);
});

check('a 56-point balance can use 50 points on an eligible ₹250 basket', () => {
  const limits = calculateMaximumUsablePoints({
    eligibleSubtotalPaise: 25000,
    pointsBalance: 56,
  });
  assert.equal(limits.maximumBySubtotalPoints, 50);
  assert.equal(limits.maximumUsablePoints, 50);
  assert.equal(limits.maximumDiscountPaise, 5000);
  const accepted = validateBondRedemptionRequest({
    requestedPoints: 50,
    pointsBalance: 56,
    eligibleSubtotalPaise: 25000,
    redemptionEnabled: true,
    channel: 'CUSTOMER_WEB',
  });
  assert.equal(accepted.discountPaise, 5000);
});

check('zero points is a safe no-op even while redemption is disabled', () => {
  const accepted = validateBondRedemptionRequest({
    requestedPoints: 0,
    pointsBalance: 56,
    eligibleSubtotalPaise: 25000,
    redemptionEnabled: false,
    channel: 'POS',
  });
  assert.equal(accepted.discountPaise, 0);
  assert.equal(accepted.maximumUsablePoints, 0);
});

check('a positive redemption below 50 points is rejected', () => {
  expectPolicyError('REDEMPTION_BELOW_MINIMUM', () => validateBondRedemptionRequest({
    requestedPoints: 40,
    pointsBalance: 56,
    eligibleSubtotalPaise: 25000,
    redemptionEnabled: true,
    channel: 'CUSTOMER_WEB',
  }));
});

check('a redemption above the 20% basket cap is rejected', () => {
  expectPolicyError('REDEMPTION_EXCEEDS_MAXIMUM', () => validateBondRedemptionRequest({
    requestedPoints: 60,
    pointsBalance: 100,
    eligibleSubtotalPaise: 25000,
    redemptionEnabled: true,
    channel: 'CUSTOMER_WEB',
  }));
});

check('a redemption not divisible by ten is rejected', () => {
  expectPolicyError('REDEMPTION_INCREMENT_REQUIRED', () => validateBondRedemptionRequest({
    requestedPoints: 55,
    pointsBalance: 100,
    eligibleSubtotalPaise: 30000,
    redemptionEnabled: true,
    channel: 'CUSTOMER_WEB',
  }));
});

check('an insufficient available balance is rejected', () => {
  expectPolicyError('INSUFFICIENT_POINTS', () => validateBondRedemptionRequest({
    requestedPoints: 60,
    pointsBalance: 56,
    eligibleSubtotalPaise: 40000,
    redemptionEnabled: true,
    channel: 'CUSTOMER_WEB',
  }));
});

check('redemption cannot combine with another discount', () => {
  expectPolicyError('REDEMPTION_WITH_DISCOUNT_NOT_ALLOWED', () => validateBondRedemptionRequest({
    requestedPoints: 50,
    pointsBalance: 100,
    eligibleSubtotalPaise: 30000,
    existingDiscountPaise: 1,
    redemptionEnabled: true,
    channel: 'CUSTOMER_WEB',
  }));
});

check('native POS redemption remains ineligible', () => {
  expectPolicyError('REDEMPTION_CHANNEL_INELIGIBLE', () => validateBondRedemptionRequest({
    requestedPoints: 50,
    pointsBalance: 100,
    eligibleSubtotalPaise: 30000,
    redemptionEnabled: true,
    channel: 'POS',
  }));
});

check('largest-remainder allocation is exact and resolves ties by stable key', () => {
  const allocation = allocateDiscountPaise([
    { key: 'B', subtotalPaise: 1 },
    { key: 'A', subtotalPaise: 1 },
    { key: 'C', subtotalPaise: 1 },
  ], 2);
  assert.deepEqual(
    Object.fromEntries(allocation.map(component => [component.key, component.discountPaise])),
    { B: 1, A: 1, C: 0 },
  );
  assert.equal(allocation.reduce((sum, component) => sum + component.discountPaise, 0), 2);
});

check('discount is allocated before GST across base and add-on tax components', () => {
  const input = structuredClone(baseCheckout);
  const priced = applyBondRedemptionToCheckout({
    checkout: input,
    requestedPoints: 50,
    pointsBalance: 56,
    redemptionEnabled: true,
  });

  assert.equal(priced.subtotal, 250);
  assert.equal(priced.discount, 50);
  assert.equal(priced.taxableAmount, 200);
  assert.equal(priced.gstTotal, 15.2);
  assert.equal(priced.grandTotal, 215.2);
  assert.equal(priced.bondRedemptionPoints, 50);
  assert.equal(priced.bondRedemptionDiscount, 50);
  assert.equal(priced.discountReason, 'BOND Points Redemption');
  assert.equal(priced.discountSource, 'BOND_REDEMPTION');
  assert.deepEqual(
    priced.redemptionComponents.map(component => ({
      kind: component.kind,
      subtotalPaise: component.subtotalPaise,
      discountPaise: component.discountPaise,
      taxablePaise: component.taxablePaise,
      taxPaise: component.taxPaise,
    })),
    [
      { kind: 'BASE', subtotalPaise: 20000, discountPaise: 4000, taxablePaise: 16000, taxPaise: 800 },
      { kind: 'ADD_ON', subtotalPaise: 5000, discountPaise: 1000, taxablePaise: 4000, taxPaise: 720 },
    ],
  );
  assert.equal(
    priced.redemptionComponents.reduce((sum, component) => sum + component.discountPaise, 0),
    5000,
  );
  assert.deepEqual(input, baseCheckout, 'the canonical input must not be mutated');
});

check('post-redemption taxable spend is the only points-earning base', () => {
  const priced = applyBondRedemptionToCheckout({
    checkout: baseCheckout,
    requestedPoints: 50,
    pointsBalance: 56,
    redemptionEnabled: true,
  });
  assert.equal(priced.eligibleSpendPaise, 20000);
  assert.equal(Math.floor(priced.eligibleSpendPaise / 1000), 20);
  assert.notEqual(Math.floor((priced.subtotal * 100) / 1000), 20);
});

check('odd-paise proportional allocation remains exact and deterministic', () => {
  const checkout = {
    items: [
      {
        lineId: 'ODD_A',
        quantity: 1,
        baseUnitPrice: 125.01,
        taxRate: 5,
        addOns: [],
      },
      {
        lineId: 'ODD_B',
        quantity: 1,
        baseUnitPrice: 124.99,
        taxRate: 18,
        addOns: [],
      },
    ],
    discount: 0,
  };
  const first = applyBondRedemptionToCheckout({
    checkout,
    requestedPoints: 50,
    pointsBalance: 56,
    redemptionEnabled: true,
  });
  const second = applyBondRedemptionToCheckout({
    checkout,
    requestedPoints: 50,
    pointsBalance: 56,
    redemptionEnabled: true,
  });
  assert.deepEqual(first.redemptionComponents, second.redemptionComponents);
  assert.equal(first.discount, 50);
  assert.equal(first.taxableAmount, 200);
  assert.equal(first.redemptionComponents.reduce((sum, component) => sum + component.discountPaise, 0), 5000);
  assert.equal(first.grandTotal, first.taxableAmount + first.gstTotal);
});

console.log(`\n${passed.length} BOND redemption policy checks passed.`);
