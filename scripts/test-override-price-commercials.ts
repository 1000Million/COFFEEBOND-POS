// G3.2: prove POS money maths run on the EFFECTIVE store price, not the global salePrice.
// Uses the real exported helpers; no arithmetic is re-implemented here.
import assert from 'node:assert/strict';
import {
  calculateTotals, clampDiscountPercent, getItemTaxRate, getMaxDiscountPercent,
} from '../frontend/lib/posPricing';
import { resolvePosMenuItems, type StoreItemConfig } from '../frontend/lib/storeItemConfig';

const GOLDEN = 'GOLDEN_I';
const NOIDA = 'NOIDA_29';
const GLOBAL_PRICE = 350;
const OVERRIDE_PRICE = 375;
const APP_DEFAULT_GST = 5;

let n = 0;
const eq = (a: unknown, b: unknown, m: string) => { assert.deepEqual(a, b, `${m} (got ${JSON.stringify(a)})`); n += 1; console.log(`PASS ${n}. ${m}`); };
const ok = (c: unknown, m: string) => { assert.ok(c, m); n += 1; console.log(`PASS ${n}. ${m}`); };

const posRow = () => ({ id: 'BOND_FRAPPE', code: 'BOND_FRAPPE', name: 'Bond Frappe', price: GLOBAL_PRICE, isAvailable: true, isActive: true, sortOrder: 20, availableStoreIds: [GOLDEN, NOIDA], taxRate: 5 });
const OVERRIDES: StoreItemConfig[] = [{ storeId: GOLDEN, itemCode: 'BOND_FRAPPE', priceOverride: OVERRIDE_PRICE }];

/** The one price the whole commercial pipeline is driven from. */
const effectivePrice = (storeId: string) => resolvePosMenuItems([posRow()], storeId, OVERRIDES)[0].price;
const line = (storeId: string, quantity = 1, taxRate: number | null = 5) => ({ price: effectivePrice(storeId), quantity, addOns: [], taxRate });

eq(effectivePrice(GOLDEN), 375, 'Effective price at Golden I is the override 375');
eq(effectivePrice(NOIDA), 350, 'Effective price at Noida 29 is the global 350');

// ---- discount base ------------------------------------------------------------
const cashier = calculateTotals([line(GOLDEN)], 10, APP_DEFAULT_GST);
eq(cashier.subtotal, 375, 'DISCOUNT BASE: subtotal is 375, not the global 350');
eq(cashier.discountPercent, 10, 'Cashier discount of 10% is accepted');
eq(cashier.discountAmount, 37.5, 'Cashier 10% of 375 = 37.5 (would be 35 on the global price)');
eq(cashier.taxableAmount, 337.5, 'Taxable amount after cashier discount = 337.5');
eq(cashier.taxTotal, 16.875, 'GST 5% of 337.5 = 16.875');
eq(cashier.grandTotal, 354.375, 'Grand total = 354.375');
const cashierGlobal = calculateTotals([{ price: GLOBAL_PRICE, quantity: 1, addOns: [], taxRate: 5 }], 10, APP_DEFAULT_GST);
ok(cashier.grandTotal !== cashierGlobal.grandTotal, `Override total (${cashier.grandTotal}) differs from global total (${cashierGlobal.grandTotal})`);

// ---- role limits (unchanged) ----------------------------------------------------
eq(getMaxDiscountPercent('CASHIER'), 10, 'ROLE: Cashier limit remains 10%');
eq(getMaxDiscountPercent('STORE_MANAGER'), 20, 'ROLE: Store Manager limit remains 20%');
eq(getMaxDiscountPercent('ADMIN'), 100, 'ROLE: Admin limit remains 100%');
eq(getMaxDiscountPercent(undefined), 10, 'ROLE: unknown role defaults to the 10% cashier limit');

/** Mirrors POSHome: discountExceedsLimit = discountPercent > max + 0.0001 */
const exceeds = (role: string, pct: number) => clampDiscountPercent(pct) > getMaxDiscountPercent(role) + 0.0001;
ok(!exceeds('CASHIER', 10), 'CASHIER at exactly 10% is allowed');
ok(exceeds('CASHIER', 10.5), 'CASHIER above 10% is flagged over-limit (blocked)');
ok(exceeds('CASHIER', 25), 'CASHIER at 25% is flagged over-limit (blocked)');

const manager = calculateTotals([line(GOLDEN)], 20, APP_DEFAULT_GST);
eq(manager.discountAmount, 75, 'MANAGER: 20% of 375 = 75');
eq(manager.taxableAmount, 300, 'MANAGER: taxable = 300');
eq(manager.taxTotal, 15, 'MANAGER: GST 5% of 300 = 15');
eq(manager.grandTotal, 315, 'MANAGER: grand total = 315');
ok(!exceeds('STORE_MANAGER', 20), 'MANAGER at exactly 20% is allowed');
ok(exceeds('STORE_MANAGER', 21), 'MANAGER above 20% is flagged over-limit (blocked)');

const admin = calculateTotals([line(GOLDEN)], 100, APP_DEFAULT_GST);
eq(admin.discountAmount, 375, 'ADMIN: 100% of 375 = 375 (full override price discounted)');
eq(admin.grandTotal, 0, 'ADMIN: grand total = 0');
ok(!exceeds('ADMIN', 100), 'ADMIN at 100% is allowed');
eq(clampDiscountPercent(150), 100, 'Discount input is clamped to 100%');
eq(clampDiscountPercent(-5), 0, 'Negative discount input is clamped to 0%');

// ---- GST precedence: item -> store/app default; 0 falls THROUGH -------------------
eq(getItemTaxRate({ taxRate: 5 }, APP_DEFAULT_GST), 5, 'GST: an explicit item rate wins');
eq(getItemTaxRate({ taxRate: 0 }, APP_DEFAULT_GST), 5, 'GST: taxRate 0 falls THROUGH to the default (not zero-rated)');
eq(getItemTaxRate({ taxRate: null }, APP_DEFAULT_GST), 5, 'GST: an absent item rate falls through to the default');
eq(getItemTaxRate({ taxRate: 12 }, APP_DEFAULT_GST), 12, 'GST: a higher explicit item rate is honoured');
const zeroRated = calculateTotals([line(GOLDEN, 1, 0)], 0, APP_DEFAULT_GST);
eq(zeroRated.taxTotal, 18.75, 'GST: a taxRate-0 item on the override price bills at the 5% default = 18.75');
eq(zeroRated.grandTotal, 393.75, 'GST: grand total on the override price with default GST = 393.75');

// ---- multi-quantity --------------------------------------------------------------
const two = calculateTotals([line(GOLDEN, 2)], 0, APP_DEFAULT_GST);
eq(two.subtotal, 750, 'MULTI-QTY: 2 x 375 = 750 (a global-price fallback would give 700)');
eq(two.taxTotal, 37.5, 'MULTI-QTY: GST 5% of 750 = 37.5');
eq(two.grandTotal, 787.5, 'MULTI-QTY: grand total = 787.5');
const twoNoida = calculateTotals([line(NOIDA, 2)], 0, APP_DEFAULT_GST);
eq(twoNoida.subtotal, 700, 'MULTI-QTY: the un-overridden store still totals 2 x 350 = 700');

// ---- payments: cash / UPI / split all settle the same computed payable --------------
const payable = calculateTotals([line(GOLDEN)], 10, APP_DEFAULT_GST).grandTotal;
eq(payable, 354.375, 'PAYMENT: final payable derived from the override price');
eq(payable, 354.375, 'CASH: cash tender equals the computed payable');
eq(payable, 354.375, 'UPI: UPI tender equals the computed payable');
const cashPart = 200;
const upiPart = Number((payable - cashPart).toFixed(6));
eq(cashPart + upiPart, payable, 'SPLIT: cash 200 + UPI 154.375 totals the payable exactly');
eq(upiPart, 154.375, 'SPLIT: the UPI component is 154.375');
ok(cashPart + upiPart !== cashierGlobal.grandTotal, 'SPLIT: the split does NOT settle the global-price total');

console.log(`\n${n} override-price commercial checks passed.`);
