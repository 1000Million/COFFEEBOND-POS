/**
 * Pure POS pricing helpers.
 *
 * Extracted verbatim from POSHome so the money maths can be exercised directly by tests.
 * No behaviour is changed here: POSHome imports these and calls them exactly as before.
 * `price` is the EFFECTIVE store price — see lib/storeItemConfig.resolvePosMenuItems.
 */
import type { AddOnSelection } from '../types';
import { addOnTaxForLine, unitPriceWithAddOns } from './addOns';

export type TotalsInput = {
  price: number;
  quantity: number;
  taxRate?: number | null;
  addOns?: AddOnSelection[];
};

export type CalculatedTotals = {
  subtotal: number;
  discountPercent: number;
  discountAmount: number;
  taxableAmount: number;
  taxTotal: number;
  grandTotal: number;
};

/**
 * Canonical Coffee Bond money quantization: 2 decimal places, ROUND_HALF_UP by magnitude.
 *
 * This is the ONE quantization point for transaction totals. Every downstream surface
 * (tender, receipt, reporting, day close, reversal) must consume the values it produces
 * rather than rounding again.
 *
 * Why not `Math.round(value * 100) / 100`: that is not half-up on the decimal the user sees.
 * `1.005 * 100` is `100.49999999999999` in IEEE-754, so it rounds DOWN to 1.00. This helper
 * first recovers the intended decimal with `toFixed(12)` and then rounds the digit string, so
 * 1.005 -> 1.01 and 2.675 -> 2.68 as an accounting policy requires.
 *
 * Half-up is applied BY MAGNITUDE, so a tie rounds away from zero on both signs:
 * 1.005 -> 1.01 and -1.005 -> -1.01. A refund therefore mirrors its sale exactly.
 *
 * Non-finite input yields 0 rather than propagating NaN into a payable.
 */
export function quantizeMoney(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  if (parsed === 0) return 0;
  const negative = parsed < 0;
  // 12 decimals is far beyond money precision and is what recovers 2.675 from its binary form.
  const [intPart, fracPart = ''] = Math.abs(parsed).toFixed(12).split('.');
  const keptPaise = fracPart.slice(0, 2).padEnd(2, '0');
  const roundUp = Number(fracPart.charAt(2) || '0') >= 5;
  const paise = BigInt(intPart) * 100n + BigInt(keptPaise) + (roundUp ? 1n : 0n);
  const result = Number(paise) / 100;
  return negative ? -result : result;
}

/**
 * Splits a canonical GST total into CGST and SGST halves that sum back to it EXACTLY.
 *
 * An odd number of paise cannot halve evenly. The extra paisa is deterministically assigned
 * to CGST, so CGST + SGST === gstTotal always and no paisa is lost.
 */
export function splitGstHalves(gstTotal: number): { cgst: number; sgst: number } {
  const canonical = quantizeMoney(gstTotal);
  const totalPaise = Math.round(Math.abs(canonical) * 100);
  const sgstPaise = Math.floor(totalPaise / 2);
  const cgstPaise = totalPaise - sgstPaise;
  const sign = canonical < 0 ? -1 : 1;
  return { cgst: (sign * cgstPaise) / 100, sgst: (sign * sgstPaise) / 100 };
}

export function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeTaxRate(value: unknown): number {
  const parsed = toFiniteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : 0;
}

export function getItemTaxRate(item: { taxRate?: number | null }, fallbackTaxRate: number): number {
  const itemTax = normalizeTaxRate(item.taxRate);
  return itemTax > 0 ? itemTax : fallbackTaxRate;
}

export function clampDiscountPercent(value: unknown): number {
  const parsed = toFiniteNumber(value) || 0;
  if (parsed < 0) return 0;
  if (parsed > 100) return 100;
  return parsed;
}

export function getMaxDiscountPercent(role?: string): number {
  if (role === 'ADMIN') return 100;
  if (role === 'STORE_MANAGER') return 20;
  return 10;
}

export function calculateTotals(items: TotalsInput[], discountPercentInput: unknown, fallbackTaxRate: number): CalculatedTotals {
  const subtotal = items.reduce(
    (sum, item) => sum + unitPriceWithAddOns(Number(item.price) || 0, item.addOns) * (Number(item.quantity) || 0),
    0,
  );
  const discountPercent = clampDiscountPercent(discountPercentInput);
  const discountAmount = subtotal * (discountPercent / 100);
  const taxableAmount = Math.max(0, subtotal - discountAmount);
  const discountRatio = subtotal > 0 ? discountAmount / subtotal : 0;
  const taxTotal = items.reduce((sum, item) => {
    const quantity = Number(item.quantity) || 0;
    const baseSubtotal = (Number(item.price) || 0) * quantity;
    const baseTaxable = Math.max(0, baseSubtotal - (baseSubtotal * discountRatio));
    return sum
      + baseTaxable * (getItemTaxRate(item, fallbackTaxRate) / 100)
      + addOnTaxForLine(item.addOns, quantity, discountRatio);
  }, 0);

  // Canonicalize the transaction totals here - this is the single quantization boundary.
  // Line-level arithmetic above stays exact because firestore.rules enforces
  // lineSubtotal == unitPriceWithAddOns * quantity on the order item document.
  const canonicalSubtotal = quantizeMoney(subtotal);
  const canonicalDiscount = quantizeMoney(discountAmount);
  const canonicalTaxable = quantizeMoney(canonicalSubtotal - canonicalDiscount);
  const canonicalTax = quantizeMoney(taxTotal);
  return {
    subtotal: canonicalSubtotal,
    discountPercent,
    discountAmount: canonicalDiscount,
    taxableAmount: canonicalTaxable,
    taxTotal: canonicalTax,
    grandTotal: quantizeMoney(canonicalTaxable + canonicalTax),
  };
}
