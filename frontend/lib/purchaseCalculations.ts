export const PURCHASE_UNITS = ['G', 'KG', 'ML', 'L', 'PCS', 'PACK', 'BOX', 'BOTTLE', 'BAG', 'TRAY'] as const;

export type PurchaseUnit = typeof PURCHASE_UNITS[number];
export type PriceBasis = 'RATE_PER_PURCHASE_UNIT' | 'RATE_PER_CONTENTS_UNIT' | 'RATE_PER_STOCK_UNIT';

export type PurchaseLineCalculationInput = {
  purchaseQuantity: number;
  purchaseUOM: string;
  stockUOM: string;
  packSize: number;
  packSizeUOM: string;
  priceBasis: PriceBasis;
  rate: number;
  taxPercent: number;
  discountPercent: number;
  landedCostAmount?: number;
  includeLandedCostInInventory?: boolean;
  itemConversionFactor?: number;
};

export type PurchaseLineCalculation = {
  purchaseUOM: string;
  stockUOM: string;
  conversionFactor: number;
  convertedStockQuantity: number;
  lineSubtotal: number;
  discountAmount: number;
  taxableAmount: number;
  taxAmount: number;
  lineTotal: number;
  inventoryCostAmount: number;
  landedCostAmountApplied: number;
  calculatedCostPerStockUnit: number;
  conversionPreview: string;
  pricingPreview: string;
};

const STANDARD_UNIT_TO_BASE: Record<string, { family: 'WEIGHT' | 'VOLUME' | 'COUNT'; factor: number }> = {
  G: { family: 'WEIGHT', factor: 1 },
  KG: { family: 'WEIGHT', factor: 1000 },
  ML: { family: 'VOLUME', factor: 1 },
  L: { family: 'VOLUME', factor: 1000 },
  PCS: { family: 'COUNT', factor: 1 },
};

const PACK_UNITS = new Set(['PACK', 'BOX', 'BOTTLE', 'BAG', 'TRAY']);

export function normalizePurchaseUnit(value: unknown): string {
  const unit = String(value || '').trim().toUpperCase();
  if (unit === 'GRAM' || unit === 'GRAMS') return 'G';
  if (unit === 'KGS' || unit === 'KILOGRAM' || unit === 'KILOGRAMS') return 'KG';
  if (unit === 'MILLILITER' || unit === 'MILLILITRE' || unit === 'MILLILITERS' || unit === 'MILLILITRES') return 'ML';
  if (unit === 'LITER' || unit === 'LITRE' || unit === 'LITERS' || unit === 'LITRES' || unit === 'LTR' || unit === 'LTRS') return 'L';
  if (unit === 'PC' || unit === 'PIECE' || unit === 'PIECES') return 'PCS';
  return unit;
}

export function parseNumber(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isSupportedPurchaseUnit(unit: string): boolean {
  return PURCHASE_UNITS.includes(normalizePurchaseUnit(unit) as PurchaseUnit);
}

function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000000) / 1000000;
}

function roundQuantity(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000000) / 1000000;
}

function conversionFactorBetweenUnits(fromUnit: string, toUnit: string): number | null {
  const from = STANDARD_UNIT_TO_BASE[fromUnit];
  const to = STANDARD_UNIT_TO_BASE[toUnit];
  if (!from || !to || from.family !== to.family) return null;
  return from.factor / to.factor;
}

function formatAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000000) / 1000000);
}

export function resolvePurchaseConversionFactor(input: {
  purchaseUOM: string;
  stockUOM: string;
  packSize: number;
  packSizeUOM: string;
  itemConversionFactor?: number;
}): { conversionFactor: number; normalizedPackSizeUOM: string } {
  const purchaseUOM = normalizePurchaseUnit(input.purchaseUOM);
  const stockUOM = normalizePurchaseUnit(input.stockUOM);
  const packSizeUOM = normalizePurchaseUnit(input.packSizeUOM);
  const itemConversionFactor = parseNumber(input.itemConversionFactor);

  if (!isSupportedPurchaseUnit(purchaseUOM)) {
    throw new Error(`Purchase unit ${purchaseUOM || 'blank'} is not supported.`);
  }
  if (!stockUOM) throw new Error('Stock unit is missing for this item.');
  if (purchaseUOM === stockUOM) return { conversionFactor: 1, normalizedPackSizeUOM: packSizeUOM };

  const standardFactor = conversionFactorBetweenUnits(purchaseUOM, stockUOM);
  if (standardFactor !== null) return { conversionFactor: standardFactor, normalizedPackSizeUOM: packSizeUOM };

  if (PACK_UNITS.has(purchaseUOM)) {
    const packSize = parseNumber(input.packSize);
    if (packSize <= 0) throw new Error(`${purchaseUOM} needs pack contents before posting.`);
    if (!packSizeUOM) throw new Error(`${purchaseUOM} needs a pack contents unit.`);

    if (packSizeUOM === stockUOM) return { conversionFactor: packSize, normalizedPackSizeUOM: packSizeUOM };

    const packFactor = conversionFactorBetweenUnits(packSizeUOM, stockUOM);
    if (packFactor !== null) {
      return { conversionFactor: packSize * packFactor, normalizedPackSizeUOM: packSizeUOM };
    }

    if (itemConversionFactor > 0) {
      return { conversionFactor: packSize * itemConversionFactor, normalizedPackSizeUOM: packSizeUOM };
    }

    throw new Error(`Cannot convert ${purchaseUOM} contents from ${packSizeUOM} to ${stockUOM}.`);
  }

  if (itemConversionFactor > 0) {
    return { conversionFactor: itemConversionFactor, normalizedPackSizeUOM: packSizeUOM };
  }

  throw new Error(`Cannot convert ${purchaseUOM} to ${stockUOM} without an item-specific conversion.`);
}

export function calculatePurchaseLine(input: PurchaseLineCalculationInput): PurchaseLineCalculation {
  const purchaseQuantity = parseNumber(input.purchaseQuantity);
  const rate = parseNumber(input.rate);
  const taxPercent = parseNumber(input.taxPercent);
  const discountPercent = parseNumber(input.discountPercent);
  const landedCostAmount = parseNumber(input.landedCostAmount);
  const purchaseUOM = normalizePurchaseUnit(input.purchaseUOM);
  const stockUOM = normalizePurchaseUnit(input.stockUOM);

  if (purchaseQuantity <= 0) throw new Error('Purchase quantity must be greater than 0.');
  if (rate < 0) throw new Error('Rate cannot be negative.');
  if (discountPercent < 0 || discountPercent > 100) throw new Error('Discount must be between 0 and 100%.');
  if (taxPercent < 0 || taxPercent > 100) throw new Error('Tax must be between 0 and 100%.');
  if (landedCostAmount < 0) throw new Error('Landed cost cannot be negative.');

  const { conversionFactor, normalizedPackSizeUOM } = resolvePurchaseConversionFactor(input);
  const convertedStockQuantity = roundQuantity(purchaseQuantity * conversionFactor);
  if (convertedStockQuantity <= 0) throw new Error('Converted stock quantity must be greater than 0.');

  const packSize = parseNumber(input.packSize);
  const lineSubtotal = (() => {
    if (input.priceBasis === 'RATE_PER_PURCHASE_UNIT') return roundCurrency(purchaseQuantity * rate);
    if (input.priceBasis === 'RATE_PER_CONTENTS_UNIT') {
      if (packSize <= 0 || !normalizedPackSizeUOM) {
        throw new Error('Rate per contents unit needs pack contents and contents unit.');
      }
      return roundCurrency(purchaseQuantity * packSize * rate);
    }
    if (input.priceBasis === 'RATE_PER_STOCK_UNIT') return roundCurrency(convertedStockQuantity * rate);
    throw new Error('Select a valid price basis.');
  })();
  const discountAmount = roundCurrency(lineSubtotal * discountPercent / 100);
  const taxableAmount = roundCurrency(lineSubtotal - discountAmount);
  const taxAmount = roundCurrency(taxableAmount * taxPercent / 100);
  const lineTotal = roundCurrency(taxableAmount + taxAmount);
  const landedCostAmountApplied = input.includeLandedCostInInventory ? roundCurrency(landedCostAmount) : 0;
  const inventoryCostAmount = roundCurrency(taxableAmount + landedCostAmountApplied);
  const calculatedCostPerStockUnit = convertedStockQuantity > 0
    ? Math.round((inventoryCostAmount / convertedStockQuantity) * 1000000) / 1000000
    : 0;
  const packPreview = PACK_UNITS.has(purchaseUOM)
    ? ` × ${formatAmount(packSize)} ${normalizedPackSizeUOM || stockUOM}`
    : '';
  const pricingPreview = (() => {
    if (input.priceBasis === 'RATE_PER_PURCHASE_UNIT') {
      return `${formatAmount(purchaseQuantity)} ${purchaseUOM} × ₹${formatAmount(rate)}/${purchaseUOM} = ₹${formatAmount(lineSubtotal)}`;
    }
    if (input.priceBasis === 'RATE_PER_CONTENTS_UNIT') {
      return `${formatAmount(purchaseQuantity)} ${purchaseUOM} × ${formatAmount(packSize)} ${normalizedPackSizeUOM} × ₹${formatAmount(rate)}/${normalizedPackSizeUOM} = ₹${formatAmount(lineSubtotal)}`;
    }
    return `${formatAmount(convertedStockQuantity)} ${stockUOM} × ₹${formatAmount(rate)}/${stockUOM} = ₹${formatAmount(lineSubtotal)}`;
  })();

  return {
    purchaseUOM,
    stockUOM,
    conversionFactor,
    convertedStockQuantity,
    lineSubtotal,
    discountAmount,
    taxableAmount,
    taxAmount,
    lineTotal,
    inventoryCostAmount,
    landedCostAmountApplied,
    calculatedCostPerStockUnit,
    conversionPreview: `${formatAmount(purchaseQuantity)} ${purchaseUOM}${packPreview} = ${formatAmount(convertedStockQuantity)} ${stockUOM}`,
    pricingPreview,
  };
}

export function emptyPurchaseTotals() {
  return {
    subtotal: 0,
    discountAmount: 0,
    taxableAmount: 0,
    taxAmount: 0,
    grandTotal: 0,
    itemRows: 0,
  };
}

export function calculatePurchaseTotals(lines: PurchaseLineCalculation[]) {
  return {
    subtotal: roundCurrency(lines.reduce((sum, line) => sum + line.lineSubtotal, 0)),
    discountAmount: roundCurrency(lines.reduce((sum, line) => sum + line.discountAmount, 0)),
    taxableAmount: roundCurrency(lines.reduce((sum, line) => sum + line.taxableAmount, 0)),
    taxAmount: roundCurrency(lines.reduce((sum, line) => sum + line.taxAmount, 0)),
    grandTotal: roundCurrency(lines.reduce((sum, line) => sum + line.lineTotal, 0)),
    itemRows: lines.length,
  };
}
