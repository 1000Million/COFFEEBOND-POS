import assert from 'node:assert/strict';
import {
  calculatePurchaseLine,
  calculatePurchaseTotals,
  resolvePurchaseConversionFactor,
} from '../frontend/lib/purchaseCalculations';

const kgToG = calculatePurchaseLine({
  purchaseQuantity: 2,
  purchaseUOM: 'KG',
  stockUOM: 'G',
  packSize: 0,
  packSizeUOM: '',
  priceBasis: 'RATE_PER_PURCHASE_UNIT',
  rate: 250,
  taxPercent: 0,
  discountPercent: 0,
});
assert.equal(kgToG.convertedStockQuantity, 2000);
assert.equal(kgToG.lineSubtotal, 500);
assert.equal(kgToG.calculatedCostPerStockUnit, 0.25);

const lToMl = calculatePurchaseLine({
  purchaseQuantity: 1.5,
  purchaseUOM: 'L',
  stockUOM: 'ML',
  packSize: 0,
  packSizeUOM: '',
  priceBasis: 'RATE_PER_PURCHASE_UNIT',
  rate: 100,
  taxPercent: 5,
  discountPercent: 10,
});
assert.equal(lToMl.convertedStockQuantity, 1500);
assert.equal(lToMl.lineSubtotal, 150);
assert.equal(lToMl.discountAmount, 15);
assert.equal(lToMl.taxableAmount, 135);
assert.equal(lToMl.taxAmount, 6.75);
assert.equal(lToMl.lineTotal, 141.75);

const boxToPcs = calculatePurchaseLine({
  purchaseQuantity: 3,
  purchaseUOM: 'BOX',
  stockUOM: 'PCS',
  packSize: 10,
  packSizeUOM: 'PCS',
  priceBasis: 'RATE_PER_PURCHASE_UNIT',
  rate: 120,
  taxPercent: 0,
  discountPercent: 0,
});
assert.equal(boxToPcs.convertedStockQuantity, 30);
assert.equal(boxToPcs.lineSubtotal, 360);

const bagToKgToG = calculatePurchaseLine({
  purchaseQuantity: 2,
  purchaseUOM: 'BAG',
  stockUOM: 'G',
  packSize: 5,
  packSizeUOM: 'KG',
  priceBasis: 'RATE_PER_PURCHASE_UNIT',
  rate: 500,
  taxPercent: 0,
  discountPercent: 0,
});
assert.equal(bagToKgToG.conversionFactor, 5000);
assert.equal(bagToKgToG.convertedStockQuantity, 10000);
assert.equal(bagToKgToG.calculatedCostPerStockUnit, 0.1);

const gstExcludedFromInventoryCost = calculatePurchaseLine({
  purchaseQuantity: 2,
  purchaseUOM: 'BAG',
  stockUOM: 'G',
  packSize: 1,
  packSizeUOM: 'KG',
  priceBasis: 'RATE_PER_PURCHASE_UNIT',
  rate: 250,
  taxPercent: 5,
  discountPercent: 0,
});
assert.equal(gstExcludedFromInventoryCost.convertedStockQuantity, 2000);
assert.equal(gstExcludedFromInventoryCost.lineSubtotal, 500);
assert.equal(gstExcludedFromInventoryCost.taxableAmount, 500);
assert.equal(gstExcludedFromInventoryCost.taxAmount, 25);
assert.equal(gstExcludedFromInventoryCost.lineTotal, 525);
assert.equal(gstExcludedFromInventoryCost.inventoryCostAmount, 500);
assert.equal(gstExcludedFromInventoryCost.calculatedCostPerStockUnit, 0.25);

const discountReducesInventoryCost = calculatePurchaseLine({
  purchaseQuantity: 2,
  purchaseUOM: 'BAG',
  stockUOM: 'G',
  packSize: 1,
  packSizeUOM: 'KG',
  priceBasis: 'RATE_PER_PURCHASE_UNIT',
  rate: 250,
  taxPercent: 5,
  discountPercent: 10,
});
assert.equal(discountReducesInventoryCost.taxableAmount, 450);
assert.equal(discountReducesInventoryCost.lineTotal, 472.5);
assert.equal(discountReducesInventoryCost.inventoryCostAmount, 450);
assert.equal(discountReducesInventoryCost.calculatedCostPerStockUnit, 0.225);

const explicitLandedCostCanIncreaseInventoryCost = calculatePurchaseLine({
  purchaseQuantity: 2,
  purchaseUOM: 'BAG',
  stockUOM: 'G',
  packSize: 1,
  packSizeUOM: 'KG',
  priceBasis: 'RATE_PER_PURCHASE_UNIT',
  rate: 250,
  taxPercent: 5,
  discountPercent: 0,
  landedCostAmount: 50,
  includeLandedCostInInventory: true,
});
assert.equal(explicitLandedCostCanIncreaseInventoryCost.lineTotal, 525);
assert.equal(explicitLandedCostCanIncreaseInventoryCost.inventoryCostAmount, 550);
assert.equal(explicitLandedCostCanIncreaseInventoryCost.calculatedCostPerStockUnit, 0.275);

assert.throws(() => resolvePurchaseConversionFactor({
  purchaseUOM: 'G',
  stockUOM: 'ML',
  packSize: 0,
  packSizeUOM: '',
}), /Cannot convert G to ML/);

const ratePerPurchaseUnit = calculatePurchaseLine({
  purchaseQuantity: 1,
  purchaseUOM: 'BAG',
  stockUOM: 'G',
  packSize: 5,
  packSizeUOM: 'KG',
  priceBasis: 'RATE_PER_PURCHASE_UNIT',
  rate: 600,
  taxPercent: 5,
  discountPercent: 0,
});
assert.equal(ratePerPurchaseUnit.lineSubtotal, 600);
assert.equal(ratePerPurchaseUnit.convertedStockQuantity, 5000);
assert.equal(ratePerPurchaseUnit.taxAmount, 30);
assert.equal(ratePerPurchaseUnit.lineTotal, 630);
assert.equal(ratePerPurchaseUnit.calculatedCostPerStockUnit, 0.12);
assert.equal(ratePerPurchaseUnit.pricingPreview, '1 BAG × ₹600/BAG = ₹600');

const ratePerContentsUnit = calculatePurchaseLine({
  purchaseQuantity: 1,
  purchaseUOM: 'BAG',
  stockUOM: 'G',
  packSize: 5,
  packSizeUOM: 'KG',
  priceBasis: 'RATE_PER_CONTENTS_UNIT',
  rate: 120,
  taxPercent: 5,
  discountPercent: 0,
});
assert.equal(ratePerContentsUnit.lineSubtotal, 600);
assert.equal(ratePerContentsUnit.convertedStockQuantity, 5000);
assert.equal(ratePerContentsUnit.taxAmount, 30);
assert.equal(ratePerContentsUnit.lineTotal, 630);
assert.equal(ratePerContentsUnit.calculatedCostPerStockUnit, 0.12);
assert.equal(ratePerContentsUnit.pricingPreview, '1 BAG × 5 KG × ₹120/KG = ₹600');

const ratePerStockUnit = calculatePurchaseLine({
  purchaseQuantity: 1,
  purchaseUOM: 'BAG',
  stockUOM: 'G',
  packSize: 5,
  packSizeUOM: 'KG',
  priceBasis: 'RATE_PER_STOCK_UNIT',
  rate: 0.12,
  taxPercent: 5,
  discountPercent: 0,
});
assert.equal(ratePerStockUnit.lineSubtotal, 600);
assert.equal(ratePerStockUnit.convertedStockQuantity, 5000);
assert.equal(ratePerStockUnit.taxAmount, 30);
assert.equal(ratePerStockUnit.lineTotal, 630);
assert.equal(ratePerStockUnit.calculatedCostPerStockUnit, 0.12);
assert.equal(ratePerStockUnit.pricingPreview, '5000 G × ₹0.12/G = ₹600');

const totals = calculatePurchaseTotals([kgToG, lToMl, ratePerStockUnit]);
assert.equal(totals.subtotal, 1250);
assert.equal(totals.discountAmount, 15);
assert.equal(totals.taxAmount, 36.75);
assert.equal(totals.grandTotal, 1271.75);
assert.equal(totals.itemRows, 3);

console.log('Purchase calculation tests passed.');
console.log('- KG to G');
console.log('- L to ML');
console.log('- BOX to PCS');
console.log('- BAG to KG to G');
console.log('- incompatible G to ML blocked');
console.log('- GST excluded from inventory cost');
console.log('- discount reduces inventory cost');
console.log('- explicit landed cost can increase inventory cost');
console.log('- rate per purchase unit');
console.log('- rate per contents unit');
console.log('- rate per stock unit');
console.log('- subtotal/tax/discount/grand total/cost per stock unit');
