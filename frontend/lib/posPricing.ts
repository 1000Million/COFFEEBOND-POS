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

  return {
    subtotal,
    discountPercent,
    discountAmount,
    taxableAmount,
    taxTotal,
    grandTotal: taxableAmount + taxTotal,
  };
}
