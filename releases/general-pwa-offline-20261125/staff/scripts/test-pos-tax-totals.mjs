import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import * as esbuild from 'esbuild';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/pos-tax-totals.baseline.json', import.meta.url)));
const root = new URL('../', import.meta.url).pathname;
const clone = value => JSON.parse(JSON.stringify(value));
function load(file) {
  const code = esbuild.buildSync({ entryPoints: [root + file], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
  const context = { module: { exports: {} }, exports: {} };
  vm.runInNewContext(code, context);
  return context.module.exports;
}
const addOns = load('frontend/lib/addOns.ts');
const complimentary = load('frontend/lib/complimentaryOrders.ts');
const baselineSource = Object.values(fixture.declarations).join('\n')
  + '\nfunction resolveStoreTaxConfig(stores, selectedStoreId, appGstConfig) ' + fixture.selectorBody
  + '\nmodule.exports = {' + Object.keys(fixture.declarations).join(',') + ',resolveStoreTaxConfig};';
const context = { ...addOns, module: { exports: {} }, exports: {} };
vm.runInNewContext(esbuild.transformSync(baselineSource, { loader: 'ts', format: 'cjs' }).code, context);
const before = context.module.exports;
const beforeMode = process.argv.includes('--before');
if (beforeMode) {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(root + 'frontend/pages/pos/POSHome.tsx')).digest('hex'), fixture.sourceSha256);
}
const payments = beforeMode ? before : load('frontend/lib/pos/posPayments.ts');
const after = beforeMode ? before : { ...load('frontend/lib/pos/posTax.ts'), ...load('frontend/lib/pos/posTotals.ts') };
let assertions = 0;
function parity(name, args, expected) {
  const old = before[name](...clone(args));
  const actual = after[name](...clone(args));
  assert.deepStrictEqual(clone(actual), clone(old), name + ' before/after');
  if (expected !== undefined) assert.deepStrictEqual(clone(actual), expected, name + ' expected behavior');
  assertions += 1;
  return actual;
}
const item = { price: 100, quantity: 1, taxRate: 5 };
for (const [discount, grandTotal] of [[0, 105], [10, 94.5], [20, 84], [100, 0]]) {
  parity('calculateTotals', [[item], discount, 18], {
    subtotal: 100, discountPercent: discount, discountAmount: discount,
    taxableAmount: 100 - discount, taxTotal: (100 - discount) * 0.05, grandTotal,
  });
}
const store = { id: 'store', code: 'GOLDEN_I', gstRate: 12 };
const app = { defaultRate: 5, defaultSource: 'app', storeOverrides: {} };
parity('getItemTaxRate', [{ taxRate: 18 }, 12], 18);
parity('resolveStoreTaxConfig', [[store], 'store', app], { rate: 12, source: 'stores/store.gstRate' });
parity('resolveStoreTaxConfig', [[{ id: 'store', code: 'GOLDEN_I' }], 'store', app], { rate: 5, source: 'app' });
parity('resolveStoreTaxConfig', [[store], 'store', { ...app, storeOverrides: { store: 8, GOLDEN_I: 9 } }], {
  rate: 8, source: 'appSettings/gstConfig.storeOverrides.GOLDEN_I',
});
parity('resolveStoreTaxConfig', [[store], 'missing', app], { rate: 5, source: 'app' });
parity('pickTaxConfig', [{ defaultGstRate: '5', gstRate: 18 }, 'app'], { rate: 5, source: 'app.defaultGstRate' });
parity('pickItemTaxRate', [{ taxRate: 12, gstRate: 18 }], 12);
parity('normalizeStoreOverrides', [{ a: '5', b: 0, c: -2, d: 'invalid' }], { a: 5 });
// Existing POS treats nonpositive item/store rates as fallback, not exemptions.
parity('getItemTaxRate', [{ taxRate: 0 }, 5], 5);
parity('resolveStoreTaxConfig', [[{ ...store, gstRate: 0 }], 'store', app], { rate: 5, source: 'app' });
assert.equal(parity('calculateTotals', [[{ ...item, taxRate: 0 }], 0, 0]).grandTotal, 100);
const withAddOn = { ...item, quantity: 2, addOns: [{ totalPrice: 20, taxRate: 18, quantity: 1 }] };
const addOnTotals = parity('calculateTotals', [[withAddOn], 10, 5]);
assert.equal(addOnTotals.subtotal, 240);
assert.equal(addOnTotals.discountAmount, 24);
assert.equal(addOnTotals.taxTotal, 15.48);
assert.equal(addOnTotals.grandTotal, 231.48);
const tiny = parity('calculateTotals', [[{ price: 0.1, quantity: 1, taxRate: 5 }], 0, 0]);
assert.equal(tiny.taxTotal, 0.005000000000000001);
assert.equal(tiny.grandTotal, 0.10500000000000001); // No new rounding in calculation.
for (const gstTotal of [0.01, 0.03, 1.005, 3.33, 12.345]) {
  parity('receiptGstSplit', [{ gstTotal, receiptLegalDetails: { gstRegistered: true, stateCode: '09' } }]);
}
parity('receiptGstSplit', [{ gstTotal: 0.01, receiptLegalDetails: { gstRegistered: true, stateCode: '09' } }], { cgst: 0.01, sgst: 0 });
for (const receipt of [{ gstTotal: 0 }, { gstTotal: 5 }, { gstTotal: 5, receiptLegalDetails: { gstRegistered: false, stateCode: '09' } }, { gstTotal: 5, receiptLegalDetails: { gstRegistered: true } }]) {
  parity('receiptGstSplit', [receipt], null);
}
for (const discount of [-1, 150, '', null, 'invalid', '10.25']) parity('calculateTotals', [[item], discount, 5]);
const rows = [{ method: 'CASH', amountStr: '100' }, { method: 'UPI', amountStr: '131.48' }];
assert.equal(payments.paymentRowsAllocated(rows), addOnTotals.grandTotal);
assert(payments.paymentRowsAreBalanced(addOnTotals.grandTotal, payments.paymentRowsAllocated(rows)));
assert(!payments.paymentRowsAreBalanced(addOnTotals.grandTotal, 230));
assert.deepStrictEqual(clone(complimentary.buildComplimentaryTotals(addOnTotals.subtotal)), {
  subtotal: 240, discountPercent: 100, discountAmount: 240, taxableAmount: 0, taxTotal: 0, grandTotal: 0,
});
assert.deepStrictEqual(['CASHIER', 'STORE_MANAGER', 'ADMIN'].map(before.getMaxDiscountPercent), [10, 20, 100]);
// Deterministic mixed-rate/add-on coverage, including awkward fractional rupees.
for (let i = 1; i <= 120; i++) {
  parity('calculateTotals', [[{ price: i / 17, quantity: i % 4 + 1, taxRate: [0, 5, 12, 18][i % 4], addOns: [{ totalPrice: i / 31, taxRate: 18 }] }, { price: 7.005, quantity: 2, taxRate: 5 }], i % 101, 5]);
}
const current = fs.readFileSync(root + 'frontend/pages/pos/POSHome.tsx', 'utf8');
assert(current.includes(fixture.declarations.getMaxDiscountPercent), 'getMaxDiscountPercent must stay unchanged in POSHome');
for (const value of [null, '', 'invalid', -1, 0, '1,234.005']) {
  assert.equal(payments.normalizePaymentAmount(value), before.normalizePaymentAmount(value));
}
assert.equal(payments.paymentRowsAllocated(rows), before.paymentRowsAllocated(rows));
for (const allocated of [0, 230, addOnTotals.grandTotal, addOnTotals.grandTotal + 0.01]) {
  assert.equal(payments.paymentRowsAreBalanced(addOnTotals.grandTotal, allocated), before.paymentRowsAreBalanced(addOnTotals.grandTotal, allocated));
}
console.log(`POS tax/totals ${beforeMode ? 'BEFORE' : 'AFTER'}: PASS; ${assertions} parity cases plus split, complimentary and role invariants.`);
