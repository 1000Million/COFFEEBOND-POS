var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// table-service/bridge.ts
var bridge_exports = {};
__export(bridge_exports, {
  buildVoidStockReversal: () => buildVoidStockReversal,
  customerMobile: () => customerMobile,
  deterministicVoidReversalMovementId: () => deterministicVoidReversalMovementId,
  effectiveInventoryPolicy: () => effectiveInventoryPolicy,
  tableLineTotals: () => tableLineTotals,
  tableTotals: () => tableTotals
});
module.exports = __toCommonJS(bridge_exports);

// staff/frontend/lib/addOns.ts
function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function addOnTotal(addOns) {
  return (addOns || []).reduce((sum, addOn) => sum + Math.max(0, number(addOn.totalPrice)), 0);
}
function unitPriceWithAddOns(baseUnitPrice, addOns) {
  return Math.max(0, number(baseUnitPrice)) + addOnTotal(addOns);
}
function addOnTaxForLine(addOns, parentQuantity, discountRatio) {
  const safeParentQuantity = Math.max(0, number(parentQuantity));
  const safeDiscountRatio = Math.min(1, Math.max(0, number(discountRatio)));
  return (addOns || []).reduce((sum, addOn) => {
    const taxable = Math.max(0, number(addOn.totalPrice) * safeParentQuantity * (1 - safeDiscountRatio));
    return sum + taxable * Math.max(0, number(addOn.taxRate)) / 100;
  }, 0);
}

// staff/frontend/lib/pos/posTax.ts
function toFiniteNumber(value) {
  if (value === null || value === void 0 || value === "") return null;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}
function normalizeTaxRate(value) {
  const parsed = toFiniteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : 0;
}
function getItemTaxRate(item, fallbackTaxRate) {
  const itemTax = normalizeTaxRate(item.taxRate);
  return itemTax > 0 ? itemTax : fallbackTaxRate;
}

// staff/frontend/lib/pos/posTotals.ts
function clampDiscountPercent(value) {
  const parsed = toFiniteNumber(value) || 0;
  if (parsed < 0) return 0;
  if (parsed > 100) return 100;
  return parsed;
}
function calculateTotals(items, discountPercentInput, fallbackTaxRate) {
  const subtotal = items.reduce(
    (sum, item) => sum + unitPriceWithAddOns(Number(item.price) || 0, item.addOns) * (Number(item.quantity) || 0),
    0
  );
  const discountPercent = clampDiscountPercent(discountPercentInput);
  const discountAmount = subtotal * (discountPercent / 100);
  const taxableAmount = Math.max(0, subtotal - discountAmount);
  const discountRatio = subtotal > 0 ? discountAmount / subtotal : 0;
  const taxTotal = items.reduce((sum, item) => {
    const quantity = Number(item.quantity) || 0;
    const baseSubtotal = (Number(item.price) || 0) * quantity;
    const baseTaxable = Math.max(0, baseSubtotal - baseSubtotal * discountRatio);
    return sum + baseTaxable * (getItemTaxRate(item, fallbackTaxRate) / 100) + addOnTaxForLine(item.addOns, quantity, discountRatio);
  }, 0);
  return {
    subtotal,
    discountPercent,
    discountAmount,
    taxableAmount,
    taxTotal,
    grandTotal: taxableAmount + taxTotal
  };
}

// staff/frontend/lib/complimentaryOrders.ts
function isValidIndianMobile(value) {
  return /^[6-9][0-9]{9}$/.test(value.trim());
}
function normalizeIndianPhoneE164(value) {
  const digits = value.replace(/\D/g, "");
  const nationalNumber = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits.length === 11 && digits.startsWith("0") ? digits.slice(1) : digits;
  return isValidIndianMobile(nationalNumber) ? `+91${nationalNumber}` : null;
}

// staff/frontend/lib/pos/customerMobile.ts
function customerMobile(value) {
  const raw = value.trim();
  if (!raw) return { normalized: null, error: null };
  if (!/^[+\d\s().-]+$/.test(raw) || raw.slice(1).includes("+")) return { normalized: null, error: "Enter a valid mobile number; masks, letters and extensions are not supported." };
  if (raw.startsWith("+") && !raw.startsWith("+91") || raw.replace(/\D/g, "").startsWith("00") && !raw.replace(/\D/g, "").startsWith("0091")) return { normalized: null, error: "Use an Indian mobile number with country code +91. Other country codes are not supported." };
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 14 && digits.startsWith("0091")) digits = digits.slice(2);
  const normalized = normalizeIndianPhoneE164(digits);
  if (!normalized || /^(\d)\1{9}$/.test(normalized.slice(3))) return { normalized: null, error: "Enter a valid Indian mobile number, or leave Mobile blank." };
  return { normalized, error: null };
}

// staff/frontend/lib/tables/domain.ts
function tableTotals(lines, discountPercent = 0) {
  const items = lines.filter((l) => !l.cancelled).map((l) => ({ price: l.baseUnitPrice, quantity: l.quantity, taxRate: l.taxRate, addOns: l.addOns }));
  const totals = calculateTotals(items, discountPercent, 0);
  const money = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  return { ...Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, money(v)])), gstTotal: money(totals.taxTotal) };
}
function tableLineTotals(line, discountPercent) {
  const totals = calculateTotals([{ price: line.baseUnitPrice, quantity: line.cancelled ? 0 : line.quantity, taxRate: line.taxRate, addOns: line.addOns }], discountPercent, 0);
  return { lineSubtotal: totals.subtotal, lineDiscount: totals.discountAmount, lineTaxable: totals.taxableAmount, lineTax: totals.taxTotal, lineTotal: totals.grandTotal };
}

// staff/frontend/lib/inventory/stockReversal.ts
function deterministicVoidReversalMovementId(originalMovementId) {
  return (String(`${originalMovementId}_VOID_REVERSAL`).trim().replace(/[^A-Za-z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "") || "ID").slice(0, 480);
}
function buildVoidStockReversal({ movement, order, store, inventoryStore, currentStock, staffUid, staffName, reason, timestamp }) {
  const stockItemType = String(movement.stockItemType || "RAW_INGREDIENT");
  const stockItemCode = String(movement.stockItemCode || movement.inventoryItemId || "");
  const reversalQuantity = Math.abs(Number(movement.quantity) || 0), stockBefore = Number(currentStock);
  if (!stockItemCode || !Number.isFinite(stockBefore)) throw Error("Cannot reverse stock; stock details are missing.");
  const stockAfter = Math.round((stockBefore + reversalQuantity) * 1e4) / 1e4;
  return {
    storeId: movement.storeId,
    storeCode: movement.storeCode || (movement.storeId === inventoryStore.id ? inventoryStore.code : movement.storeId),
    storeName: movement.storeName || (movement.storeId === inventoryStore.id ? inventoryStore.name : movement.storeId),
    inventoryStoreId: movement.inventoryStoreId || movement.storeId,
    logicalSalesStoreId: movement.logicalSalesStoreId || order.storeId,
    logicalSalesStoreCode: movement.logicalSalesStoreCode || order.storeCode || store.code,
    logicalSalesStoreName: movement.logicalSalesStoreName || order.storeName || store.name,
    inventoryItemId: stockItemCode,
    inventoryItemName: movement.inventoryItemName || stockItemCode,
    movementType: "ORDER_VOID_REVERSAL",
    reason: "ORDER_VOID_REVERSAL",
    quantity: reversalQuantity,
    quantityDelta: reversalQuantity,
    unit: movement.unit || "",
    referenceType: "ORDER",
    referenceId: order.id,
    orderId: order.id,
    orderNumber: order.orderNumber,
    sourceOrderId: order.id,
    voidedOrderId: order.id,
    originalMovementId: movement.id,
    originalMovementType: movement.movementType,
    notes: `Void order ${order.orderNumber}: ${reason}`,
    createdByUserId: staffUid,
    createdByName: staffName,
    createdAt: timestamp,
    stockSystem: movement.stockSystem || "MENU_MANAGEMENT",
    stockItemType,
    stockItemCode,
    previousQty: stockBefore,
    newQty: stockAfter,
    stockBefore,
    stockAfter,
    balanceBefore: stockBefore,
    balanceAfter: stockAfter
  };
}

// staff/frontend/lib/inventory/inventoryConsumption.ts
function effectiveInventoryPolicy(_store) {
  return "ALLOW_NEGATIVE_DEFER_BOM";
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildVoidStockReversal,
  customerMobile,
  deterministicVoidReversalMovementId,
  effectiveInventoryPolicy,
  tableLineTotals,
  tableTotals
});
