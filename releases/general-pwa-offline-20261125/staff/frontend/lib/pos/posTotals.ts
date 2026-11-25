import type { AddOnSelection } from '../../types';
import { unitPriceWithAddOns, addOnTaxForLine } from '../addOns';
import { toFiniteNumber, getItemTaxRate, type TaxConfig } from './posTax';

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

export function clampDiscountPercent(value: unknown): number {
  const parsed = toFiniteNumber(value) || 0;
  if (parsed < 0) return 0;
  if (parsed > 100) return 100;
  return parsed;
}

export function calculateTotals(items: TotalsInput[], discountPercentInput: unknown, fallbackTaxRate: number | TaxConfig): CalculatedTotals {
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
      + addOnTaxForLine(typeof fallbackTaxRate === 'object' && fallbackTaxRate.mode && fallbackTaxRate.mode !== 'ITEM_WISE'
        ? item.addOns?.map(addOn => ({ ...addOn, taxRate: fallbackTaxRate.mode === 'NO_GST' ? 0 : fallbackTaxRate.rate })) : item.addOns, quantity, discountRatio);
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
