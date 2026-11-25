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

// <stdin>
var stdin_exports = {};
__export(stdin_exports, {
  buildPaymentReversalAudit: () => buildPaymentReversalAudit,
  buildRazorpayRefundAudit: () => buildRazorpayRefundAudit,
  buildVoidStockReversal: () => buildVoidStockReversal,
  deterministicVoidReversalMovementId: () => deterministicVoidReversalMovementId,
  planVoidStockBalances: () => planVoidStockBalances
});
module.exports = __toCommonJS(stdin_exports);

// financial-integrity-repair-20261101/candidate/staff/frontend/lib/complimentaryOrders.ts
function isComplimentaryOrder(order) {
  if (order.commercialStatus === "COMPLIMENTARY") return true;
  if (order.paymentMethod === "COMPLIMENTARY") return true;
  return Array.isArray(order.paymentBreakdown) && order.paymentBreakdown.some((payment) => payment?.method === "COMPLIMENTARY");
}

// financial-integrity-repair-20261101/candidate/staff/frontend/lib/paymentReversal.ts
function money(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}
function normalizePaymentRows(order, payments) {
  if (isComplimentaryOrder(order)) return [];
  const sourceRows = payments && payments.length > 0 ? payments : Array.isArray(order.paymentBreakdown) && order.paymentBreakdown.length > 0 ? order.paymentBreakdown : [{ method: order.paymentMethod, amount: order.grandTotal }];
  return sourceRows.map((payment) => {
    const method = payment.provider === "RAZORPAY" || order.paymentProvider === "RAZORPAY" ? "RAZORPAY" : String(payment.method || "UNKNOWN");
    const amount = money(payment.amount);
    return {
      method,
      originalAmount: amount,
      amount,
      reversalStatus: "NOT_REQUIRED",
      reason: ""
    };
  }).filter((payment) => payment.amount > 0 && payment.method !== "PAY_AT_COUNTER");
}
function tenderReversalStatus(method) {
  if (method === "CASH") return "REFUNDED";
  if (method === "CREDIT") return "REVERSED";
  if (method === "COMPLIMENTARY") return "NOT_REQUIRED";
  if (method === "UPI" || method === "CARD" || method === "SWIGGY" || method === "ZOMATO" || method === "ONLINE" || method === "RAZORPAY") {
    return "MANUAL_REFUND_REQUIRED";
  }
  return "REFUND_PENDING";
}
function statusReason(status) {
  if (status === "REFUNDED") return "Cash received for the voided order should be returned to the customer.";
  if (status === "REVERSED") return "Non-cash liability/complimentary tender reversed for the voided order.";
  if (status === "MANUAL_REFUND_REQUIRED") return "Gateway refund required. Refund and verification must be completed outside POS.";
  if (status === "REFUND_PENDING") return "Refund is pending manual confirmation.";
  return "No payment was collected for this order.";
}
function aggregateStatus(lines) {
  if (lines.length === 0) return "NOT_REQUIRED";
  if (lines.some((line) => line.reversalStatus === "MANUAL_REFUND_REQUIRED")) return "MANUAL_REFUND_REQUIRED";
  if (lines.some((line) => line.reversalStatus === "REFUND_PENDING")) return "REFUND_PENDING";
  if (lines.some((line) => line.reversalStatus === "REFUNDED")) return "REFUNDED";
  return "REVERSED";
}
function buildPaymentReversalAudit(order, payments) {
  if (isComplimentaryOrder(order)) {
    return {
      paymentReversalStatus: "NOT_REQUIRED",
      paymentReversalBreakdown: [],
      paymentReversalTotal: 0,
      refundedAmount: 0,
      reversedAmount: 0,
      refundPendingAmount: 0,
      manualRefundRequiredAmount: 0,
      netCollectionAmount: 0
    };
  }
  const paidRows = normalizePaymentRows(order, payments);
  const lines = paidRows.map((line) => {
    const reversalStatus = tenderReversalStatus(line.method);
    return {
      ...line,
      reversalStatus,
      reason: statusReason(reversalStatus)
    };
  });
  const paymentReversalStatus = aggregateStatus(lines);
  const paymentReversalTotal = money(lines.reduce((sum, line) => sum + line.amount, 0));
  const refundedAmount = money(lines.filter((line) => line.reversalStatus === "REFUNDED").reduce((sum, line) => sum + line.amount, 0));
  const reversedAmount = money(lines.filter((line) => line.reversalStatus === "REVERSED").reduce((sum, line) => sum + line.amount, 0));
  const refundPendingAmount = money(lines.filter((line) => line.reversalStatus === "REFUND_PENDING").reduce((sum, line) => sum + line.amount, 0));
  const manualRefundRequiredAmount = money(lines.filter((line) => line.reversalStatus === "MANUAL_REFUND_REQUIRED").reduce((sum, line) => sum + line.amount, 0));
  return {
    paymentReversalStatus,
    paymentReversalBreakdown: lines,
    paymentReversalTotal,
    refundedAmount,
    reversedAmount,
    refundPendingAmount,
    manualRefundRequiredAmount,
    netCollectionAmount: money(paymentReversalTotal - refundedAmount - reversedAmount - refundPendingAmount - manualRefundRequiredAmount)
  };
}
function buildRazorpayRefundAudit(order, payments, refundStatus) {
  const paidRows = normalizePaymentRows(order, payments);
  const amount = money(paidRows.reduce((sum, row) => sum + row.amount, 0));
  const reversalStatus = refundStatus;
  return {
    paymentReversalStatus: reversalStatus,
    paymentReversalBreakdown: paidRows.map((row) => ({
      ...row,
      reversalStatus,
      reason: refundStatus === "REFUNDED" ? "Razorpay confirmed the full provider refund." : "The full Razorpay refund was initiated and awaits provider confirmation."
    })),
    paymentReversalTotal: amount,
    refundedAmount: refundStatus === "REFUNDED" ? amount : 0,
    reversedAmount: 0,
    refundPendingAmount: refundStatus === "REFUND_PENDING" ? amount : 0,
    manualRefundRequiredAmount: 0,
    netCollectionAmount: 0
  };
}

// financial-integrity-repair-20261101/candidate/staff/frontend/lib/inventory/stockReversal.ts
function deterministicVoidReversalMovementId(originalMovementId) {
  return (String(`${originalMovementId}_VOID_REVERSAL`).trim().replace(/[^A-Za-z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "") || "ID").slice(0, 480);
}
function planVoidStockBalances(rows) {
  const initial = /* @__PURE__ */ new Map();
  const balances = /* @__PURE__ */ new Map();
  const steps = rows.map((row) => {
    if (!row.stockKey || !Number.isFinite(row.currentStock) || !Number.isFinite(row.reversalQuantity) || row.reversalQuantity <= 0) {
      throw new Error("Cannot reverse stock; stock balance or reversal quantity is invalid.");
    }
    if (initial.has(row.stockKey) && initial.get(row.stockKey) !== row.currentStock) {
      throw new Error("Cannot reverse stock; repeated stock snapshots disagree.");
    }
    initial.set(row.stockKey, row.currentStock);
    const stockBefore = balances.get(row.stockKey) ?? row.currentStock;
    const stockAfter = Math.round((stockBefore + row.reversalQuantity) * 1e4) / 1e4;
    if (!Number.isFinite(stockAfter)) throw new Error("Cannot reverse stock; resulting balance is invalid.");
    balances.set(row.stockKey, stockAfter);
    return { stockKey: row.stockKey, stockBefore, stockAfter };
  });
  return { steps, stockBalances: [...balances].map(([stockKey, currentStock]) => ({ stockKey, currentStock })) };
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildPaymentReversalAudit,
  buildRazorpayRefundAudit,
  buildVoidStockReversal,
  deterministicVoidReversalMovementId,
  planVoidStockBalances
});
