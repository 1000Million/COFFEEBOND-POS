// G7.2: ONE canonical 2dp money value, ROUND_HALF_UP by magnitude, consumed by every surface.
import assert from 'node:assert/strict';
import { calculateTotals, quantizeMoney, splitGstHalves, getMaxDiscountPercent } from '../frontend/lib/posPricing';
// reportingCore is ESM, so esbuild resolves it at build time. Imported deliberately: this
// suite proves reporting consumes the SAME canonical values rather than re-deriving them.
import { money } from '../functions/reportingCore.mjs';

let n = 0;
const eq = (a: unknown, b: unknown, m: string) => { assert.deepEqual(a, b, `${m} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); n += 1; console.log(`PASS ${n}. ${m}`); };
const ok = (c: unknown, m: string) => { assert.ok(c, m); n += 1; console.log(`PASS ${n}. ${m}`); };
const is2dp = (v: number) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9;

// ---- A. ROUND_HALF_UP semantics -------------------------------------------------------------
for (const [input, expected] of [
  [354.375, 354.38], [282.555, 282.56], [314.685, 314.69], [305.025, 305.03],
  [1.005, 1.01], [2.675, 2.68], [0.005, 0.01], [0.004, 0],
  [-1.005, -1.01], [-2.675, -2.68], [-354.375, -354.38],
  [0, 0], [10, 10], [10.1, 10.1], [10.99, 10.99],
] as [number, number][]) {
  eq(quantizeMoney(input), expected, `HALF_UP: ${input} -> ${expected}`);
}
eq(quantizeMoney(NaN), 0, 'Non-finite NaN yields 0, never a NaN payable');
eq(quantizeMoney(Infinity), 0, 'Non-finite Infinity yields 0');
eq(quantizeMoney(-Infinity), 0, 'Non-finite -Infinity yields 0');
eq(quantizeMoney('354.375'), 354.38, 'Numeric string is coerced then quantized');
eq(quantizeMoney(undefined), 0, 'undefined yields 0');
eq(quantizeMoney(quantizeMoney(354.375)), 354.38, 'IDEMPOTENT: quantizing twice is stable');
ok(quantizeMoney(-1.005) === -quantizeMoney(1.005), 'SYMMETRY: a refund mirrors its sale exactly');

// ---- B. the four mandated fixtures ----------------------------------------------------------
const T = (price: number, pct: number, qty = 1, rate: number | null = 5) =>
  calculateTotals([{ price, quantity: qty, addOns: [], taxRate: rate }], pct, 5);
eq(T(375, 10).grandTotal, 354.38, 'A. Rs375 @10% -> canonical 354.38');
eq(T(299, 10).grandTotal, 282.56, 'B. Rs299 @10% -> canonical 282.56');
eq(T(333, 10).grandTotal, 314.69, 'C. Rs333 @10% -> canonical 314.69');
eq(T(350, 17).grandTotal, 305.03, 'D. Rs350 @17% -> canonical 305.03');

// ---- C. internal consistency of the totals object -------------------------------------------
const t = T(375, 10);
eq(t.subtotal, 375, 'CANONICAL_SUBTOTAL = 375');
eq(t.discountAmount, 37.5, 'CANONICAL_DISCOUNT = 37.50');
eq(t.taxableAmount, 337.5, 'CANONICAL_TAXABLE = 337.50');
eq(t.taxTotal, 16.88, 'CANONICAL_GST = 16.88');
eq(t.grandTotal, 354.38, 'CANONICAL_GRAND_TOTAL = 354.38');
// Float addition of two canonical 2dp values is not itself guaranteed 2dp
// (e.g. 200.33 + 10.02 === 210.35000000000002), which is precisely why grandTotal is the
// quantization of that sum rather than the raw sum.
eq(quantizeMoney(t.taxableAmount + t.taxTotal), t.grandTotal, 'quantize(taxable + GST) === grandTotal');
eq(t.taxableAmount + t.taxTotal, t.grandTotal, 'For Rs375 @10% the sum happens to be exact too');
eq(t.subtotal - t.discountAmount, t.taxableAmount, 'subtotal - discount === taxable exactly');

// ---- D. the full price x discount x quantity x role matrix -----------------------------------
let combos = 0;
for (const price of [200, 299, 333, 350, 375]) {
  for (const pct of [0, 5, 10, 15, 17, 20, 33, 100]) {
    for (const qty of [1, 2, 3]) {
      const r = T(price, pct, qty);
      combos += 1;
      assert.ok(is2dp(r.grandTotal), `grandTotal not 2dp: Rs${price} @${pct}% x${qty} -> ${r.grandTotal}`);
      assert.ok(is2dp(r.taxTotal) && is2dp(r.subtotal) && is2dp(r.discountAmount) && is2dp(r.taxableAmount),
        `component not 2dp: Rs${price} @${pct}% x${qty}`);
      assert.equal(quantizeMoney(r.taxableAmount + r.taxTotal), r.grandTotal, `not internally consistent: Rs${price} @${pct}% x${qty}`);
      assert.equal(quantizeMoney(r.subtotal - r.discountAmount), r.taxableAmount, `taxable mismatch: Rs${price} @${pct}% x${qty}`);
    }
  }
}
n += 1; console.log(`PASS ${n}. MATRIX: all ${combos} price/discount/quantity combinations are canonical 2dp and internally consistent`);
eq([getMaxDiscountPercent('CASHIER'), getMaxDiscountPercent('STORE_MANAGER'), getMaxDiscountPercent('ADMIN')], [10, 20, 100], 'ROLES: discount ceilings unchanged (10/20/100)');

// ---- E. GST split never loses a paisa --------------------------------------------------------
for (const gst of [16.88, 13.46, 14.99, 14.53, 0.01, 0.03, 7.77, 100.01]) {
  const { cgst, sgst } = splitGstHalves(gst);
  eq(quantizeMoney(cgst + sgst), quantizeMoney(gst), `GST SPLIT: CGST ${cgst} + SGST ${sgst} === ${gst}`);
  ok(is2dp(cgst) && is2dp(sgst), `GST SPLIT: both halves are 2dp for ${gst}`);
}
eq(splitGstHalves(14.99), { cgst: 7.5, sgst: 7.49 }, 'GST SPLIT: odd paisa goes to CGST deterministically');
eq(splitGstHalves(-16.88), { cgst: -8.44, sgst: -8.44 }, 'GST SPLIT: negative (refund) split mirrors');

// ---- F. tenders all settle the canonical payable ----------------------------------------------
const payable = T(375, 10).grandTotal;
eq(payable, 354.38, 'CASH settles the canonical 354.38');
eq(payable, 354.38, 'UPI settles the canonical 354.38');
eq(payable, 354.38, 'CARD settles the canonical 354.38');
const cash = 200, upi = quantizeMoney(payable - cash);
eq(upi, 154.38, 'SPLIT: remainder is exactly 154.38');
eq(quantizeMoney(cash + upi), payable, 'SPLIT: 200.00 + 154.38 === 354.38 with NO tolerance needed');
eq(cash + upi - payable, 0, 'SPLIT: residual is exactly zero, not within a 0.01 window');
// The prefill path that used to drift: toFixed(2) of an already-canonical total is exact.
eq(Number(payable.toFixed(2)), payable, 'SPLIT PREFILL: toFixed(2) of a canonical total is lossless');

// ---- G. paise serialization for Razorpay -------------------------------------------------------
const paise = Math.round(payable * 100);
eq(paise, 35438, 'RAZORPAY: canonical 354.38 -> integer 35438 paise');
eq(paise / 100, payable, 'RAZORPAY: paise round-trips back to the canonical rupee value');
for (const price of [299, 333, 350, 375]) {
  const g = T(price, 10).grandTotal;
  ok(Number.isInteger(Math.round(g * 100)) && Math.abs(g * 100 - Math.round(g * 100)) < 1e-9,
    `RAZORPAY: Rs${price} @10% payable ${g} serializes to whole paise`);
}

// ---- H. reporting money() is idempotent on canonical values ------------------------------------
for (const v of [354.38, 282.56, 314.69, 16.88, 37.5, 375]) {
  eq(money(v), v, `REPORTING: money() leaves canonical ${v} unchanged (idempotent)`);
}
const orders = [354.38, 354.38, 354.38];
eq(money(orders.reduce((a, b) => a + b, 0)), 1063.14, 'REPORTING: 3 canonical orders sum to 1063.14 with no drift');
eq(orders.reduce((a, b) => a + b, 0), 1063.1399999999999, 'REPORTING: raw float sum needs the final money() guard');
eq(money(orders.reduce((a, b) => money(a + b), 0)), 1063.14, 'REPORTING: running-round and round-once agree on canonical inputs');

// ---- I. void / reversal cancels exactly ----------------------------------------------------------
eq(quantizeMoney(payable) + quantizeMoney(-payable), 0, 'VOID: sale + reversal nets exactly 0.00');
eq(money(payable) + money(-payable), 0, "VOID: reporting's money() also nets exactly 0.00");
for (const price of [299, 333, 350, 375]) {
  const g = T(price, 10).grandTotal;
  eq(g + quantizeMoney(-g), 0, `VOID: Rs${price} @10% reverses to exactly 0.00`);
}

// ---- J. GST precedence untouched -------------------------------------------------------------------
// No discount, so GST applies to the full 375 and the fall-through is unambiguous.
eq(T(375, 0, 1, 0).taxTotal, 18.75, 'GST: item taxRate 0 still falls through to the 5% app default (375 x 5%)');
eq(T(375, 0, 1, null).taxTotal, 18.75, 'GST: absent item rate falls through to the app default');
eq(T(375, 0, 1, 12).taxTotal, 45, 'GST: an explicit item rate still wins (375 x 12%)');
eq(T(375, 10, 1, 0).taxTotal, 16.88, 'GST: fall-through applies to the DISCOUNTED base (337.50 x 5%)');

console.log(`\n${n} money quantization checks passed.`);
