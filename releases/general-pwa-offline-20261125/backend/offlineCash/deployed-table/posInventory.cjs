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
  planPosInventory: () => planPosInventory
});
module.exports = __toCommonJS(stdin_exports);

// admin:admin-context
var import_node_async_hooks = require("node:async_hooks");
var storage = new import_node_async_hooks.AsyncLocalStorage();

// admin:firebase/firestore
var import_firestore = require("firebase-admin/firestore");
var doc = (base, ...p) => storage.getStore().db.doc([base.path, ...p].filter(Boolean).join("/"));
var serverTimestamp = () => import_firestore.FieldValue.serverTimestamp();

// admin:./firebase
var db = { path: "" };

// staff/frontend/lib/packagingApplicability.ts
var TAKEAWAY_PACKAGING_PATTERNS = [
  /\bbox(es)?\b/i,
  /\bcontainer(s)?\b/i,
  /\bcup(s)?\b/i,
  /\blid(s)?\b/i,
  /\bbag(s)?\b/i,
  /\bcarry\b/i,
  /\btake[\s_-]?away\b/i,
  /\bparcel\b/i,
  /\bcutlery\b/i,
  /\bspoon(s)?\b/i,
  /\bfork(s)?\b/i,
  /\bknife\b/i,
  /\bstraw(s)?\b/i
];
function normalizePackagingApplicabilityValue(value) {
  const normalized = String(value || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (normalized === "DINE_IN" || normalized === "DINEIN") return "DINE_IN";
  if (normalized === "TAKEAWAY" || normalized === "PICKUP" || normalized === "TAKE_OUT" || normalized === "TAKEOUT") return "TAKEAWAY";
  if (normalized === "DELIVERY") return "DELIVERY";
  if (normalized === "ALL" || normalized === "ANY") return "ALL";
  return null;
}
function readPackagingApplicabilityList(line) {
  const record = line;
  const rawValue = record.applicableOrderTypes ?? record.packagingApplicability ?? record.orderTypes ?? record.serviceTypes ?? record.serviceType ?? record.applicability;
  const values = Array.isArray(rawValue) ? rawValue : rawValue ? [rawValue] : [];
  const parsed = values.map(normalizePackagingApplicabilityValue).filter((value) => Boolean(value));
  return Array.from(new Set(parsed));
}
function inferPackagingApplicability(line) {
  const label = `${line.componentCode || ""} ${line.componentName || ""}`.replace(/_/g, " ");
  if (TAKEAWAY_PACKAGING_PATTERNS.some((pattern) => pattern.test(label))) {
    return ["TAKEAWAY", "DELIVERY"];
  }
  return ["ALL"];
}
function resolvePackagingApplicability(line) {
  const explicit = readPackagingApplicabilityList(line);
  return explicit.length > 0 ? explicit : inferPackagingApplicability(line);
}
function isPackagingComponentApplicable(line, orderType) {
  const applicability = resolvePackagingApplicability(line);
  return applicability.includes("ALL") || applicability.includes(orderType);
}

// staff/frontend/lib/inventory/inventoryConsumption.ts
var UOM_ALIASES = {
  G: "G",
  GRAM: "G",
  GRAMS: "G",
  KG: "KG",
  KGS: "KG",
  KILOGRAM: "KG",
  KILOGRAMS: "KG",
  ML: "ML",
  MILLILITRE: "ML",
  MILLILITER: "ML",
  MILLILITRES: "ML",
  MILLILITERS: "ML",
  L: "L",
  LTR: "L",
  LTRS: "L",
  LITRE: "L",
  LITER: "L",
  LITRES: "L",
  LITERS: "L",
  PCS: "PCS",
  PC: "PCS",
  PIECE: "PCS",
  PIECES: "PCS"
};
var UOM_SCALE = {
  G: { family: "WEIGHT", baseFactor: 1 },
  KG: { family: "WEIGHT", baseFactor: 1e3 },
  ML: { family: "VOLUME", baseFactor: 1 },
  L: { family: "VOLUME", baseFactor: 1e3 },
  PCS: { family: "COUNT", baseFactor: 1 }
};
function roundValue(value, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
function roundMoney(value) {
  return roundValue(value, 2);
}
function toNumber(value, fallback = 0) {
  if (value === null || value === void 0 || value === "") return fallback;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}
function normalizeUom(value) {
  const raw = String(value || "").trim().toUpperCase();
  return UOM_ALIASES[raw] || raw;
}
function convertQuantity(quantity, fromUom, toUom) {
  const from = normalizeUom(fromUom);
  const to = normalizeUom(toUom);
  if (!from || !to) return null;
  if (from === to) return { quantity: roundValue(quantity), normalized: false };
  const fromMeta = UOM_SCALE[from];
  const toMeta = UOM_SCALE[to];
  if (!fromMeta || !toMeta || fromMeta.family !== toMeta.family) {
    return null;
  }
  const baseQuantity = quantity * fromMeta.baseFactor;
  return {
    quantity: roundValue(baseQuantity / toMeta.baseFactor),
    normalized: true
  };
}
function usesBom(item) {
  return item.itemType === "MADE_TO_ORDER" || item.itemType === "DIRECT_STOCK" && Array.isArray(item.bom) && item.bom.length > 0 || item.productionMode === "MADE_TO_ORDER" || item.productionMode === "ASSEMBLED_TO_ORDER";
}
function isDirectStockSale(item) {
  return item.itemType === "DIRECT_STOCK" || item.productionMode === "BOUGHT_AND_SOLD";
}
function isNoStockItem(item) {
  return item.itemType === "NO_STOCK" || item.productionMode === "NO_STOCK";
}
function isStoreAssigned(item, storeId) {
  const availableStoreIds = Array.isArray(item.availableStoreIds) ? item.availableStoreIds : [];
  return availableStoreIds.length === 0 || availableStoreIds.includes(storeId);
}
function getStockDocId(storeId, stockItemType, stockItemCode) {
  return `${storeId}_${stockItemType}_${stockItemCode}`;
}
function buildSaleNote(source, orderNumber) {
  if (source === "CUSTOMER_WEB_ACCEPT") return `Online order ${orderNumber}`;
  if (source === "REMAKE") return `Remake for order ${orderNumber}`;
  return `Order ${orderNumber}`;
}
function effectiveInventoryPolicy(_store) {
  return "ALLOW_NEGATIVE_DEFER_BOM";
}
function pendingConsumptionDocId(storeId, orderId, orderLineId) {
  return `${storeId}_${orderId}_${orderLineId}`.replace(/[^A-Za-z0-9_-]/g, "_");
}
function isFinishedGoodAvailable(item, storeId) {
  return item.isActive !== false && item.isSellable !== false && item.isAvailable !== false && isStoreAssigned(item, storeId);
}
function allowsExpandedBomFailureDeferral(store) {
  return effectiveInventoryPolicy(store) === "ALLOW_NEGATIVE_DEFER_BOM";
}
function buildPendingConsumptionIntent(input) {
  const { salesStoreId, blockers, ...fields } = input;
  const reason = blockers.map((blocker) => `${blocker.blockerType}${blocker.componentCode ? ` ${blocker.componentType || ""}/${blocker.componentCode}` : ""}`).join("; ");
  return {
    ...fields,
    status: "PENDING_BOM",
    reason: reason || "Finished good BOM is incomplete or not approved for immediate inventory consumption.",
    resolvedAt: null,
    resolvedBy: null,
    appliedBomVersion: null,
    inventoryMovementIds: [],
    idempotencyKey: pendingConsumptionDocId(salesStoreId, fields.orderId, fields.orderLineId)
  };
}
function aggregateConsumptionEntries(entries) {
  return Array.from(entries.reduce((groups, entry) => {
    const key = [
      entry.stockDocId,
      entry.lineKey,
      entry.stockItemType,
      entry.stockItemCode,
      entry.unit,
      entry.finishedGoodCode
    ].join("|");
    const current = groups.get(key);
    if (current) {
      current.quantity = roundValue(current.quantity + entry.quantity);
      current.costPerUnit = entry.costPerUnit;
      current.finishedGoodName = entry.finishedGoodName;
      current.itemName = entry.itemName;
      current.warnings.push(...entry.warnings);
      return groups;
    }
    groups.set(key, { ...entry, warnings: [...entry.warnings] });
    return groups;
  }, /* @__PURE__ */ new Map()).values()).sort((left, right) => [
    left.lineKey,
    left.stockItemType,
    left.stockItemCode,
    left.unit,
    left.finishedGoodCode
  ].join("|").localeCompare([
    right.lineKey,
    right.stockItemType,
    right.stockItemCode,
    right.unit,
    right.finishedGoodCode
  ].join("|")));
}

// staff/frontend/lib/inventoryStoreResolver.ts
function text(value) {
  return String(value ?? "").trim();
}
function effectiveInventoryStoreId(store) {
  const salesStoreId = text(store?.id);
  if (!salesStoreId) throw new Error("Sales store id is required to resolve inventory.");
  return text(store.inventoryStoreId) || salesStoreId;
}
function inventoryStoreIdentity(store, expectedId = "") {
  const id = text(store?.id) || text(expectedId);
  if (!id) throw new Error("Store id is required.");
  const code = text(store.code || store.storeCode) || id;
  const name = text(store.name || store.displayName) || code;
  return { id, code, name };
}
async function resolveInventoryStore(store, loadStoreById) {
  const salesStore = inventoryStoreIdentity(store);
  const inventoryStoreId = effectiveInventoryStoreId(store);
  if (inventoryStoreId === salesStore.id) return salesStore;
  const loaded = await loadStoreById(inventoryStoreId);
  if (!loaded) {
    throw new Error(`Inventory store ${inventoryStoreId} configured for sales store ${salesStore.id} does not exist.`);
  }
  const inventoryStore = inventoryStoreIdentity(loaded, inventoryStoreId);
  if (inventoryStore.id !== inventoryStoreId) {
    throw new Error(`Inventory store loader returned ${inventoryStore.id} instead of ${inventoryStoreId}.`);
  }
  const chainedInventoryStoreId = effectiveInventoryStoreId({ ...loaded, id: inventoryStore.id });
  if (chainedInventoryStoreId !== inventoryStore.id) {
    throw new Error(`Inventory store ${inventoryStore.id} cannot alias another inventory store (${chainedInventoryStoreId}).`);
  }
  return inventoryStore;
}
function inventoryStoreAttribution(inventoryStore) {
  const identity = inventoryStoreIdentity(inventoryStore);
  return {
    storeId: identity.id,
    storeCode: identity.code,
    storeName: identity.name,
    inventoryStoreId: identity.id
  };
}
function logicalSalesStoreAttribution(store) {
  const identity = inventoryStoreIdentity(store);
  return {
    logicalSalesStoreId: identity.id,
    logicalSalesStoreCode: identity.code,
    logicalSalesStoreName: identity.name
  };
}

// staff/frontend/lib/inventoryDeduction.ts
async function planInventoryDeductionForSale(input) {
  const { transaction, store, orderId, orderNumber, orderType, businessDate, source, staffProfile, lines } = input;
  const inventoryStore = await resolveInventoryStore(store, async (inventoryStoreId) => {
    const snapshot = await transaction.get(doc(db, "stores", inventoryStoreId));
    return snapshot.exists() ? { ...snapshot.data(), id: snapshot.id } : null;
  });
  const inventoryAttribution = inventoryStoreAttribution(inventoryStore);
  const logicalSalesAttribution = logicalSalesStoreAttribution(store);
  const inventoryPolicy = effectiveInventoryPolicy(store);
  const allowDeferredBom = inventoryPolicy === "ALLOW_NEGATIVE_DEFER_BOM";
  const allowExpandedBomFailureDeferral = allowsExpandedBomFailureDeferral(store);
  const blockers = [];
  const warnings = [];
  const warningKeys = /* @__PURE__ */ new Set();
  const movementEntries = [];
  const perLineCogs = {};
  const perLineConsumptionStatus = {};
  const pendingConsumptionPayloads = [];
  const rawCache = /* @__PURE__ */ new Map();
  const prepCache = /* @__PURE__ */ new Map();
  const finishedCache = /* @__PURE__ */ new Map();
  const stockCache = /* @__PURE__ */ new Map();
  const pushWarning = (warning) => {
    const key = JSON.stringify([
      warning.type,
      warning.finishedGoodCode || "",
      warning.stockItemType || "",
      warning.stockItemCode || "",
      warning.message,
      warning.previousQty ?? "",
      warning.newQty ?? ""
    ]);
    if (warningKeys.has(key)) return;
    warningKeys.add(key);
    warnings.push(warning);
  };
  const addBlocker = (blocker) => {
    blockers.push({
      ...blocker,
      storeName: store.name,
      storeId: store.id
    });
  };
  const deferLineBomIfAllowed = (line, lineMeta) => {
    const lineBlockers = blockers.slice(lineMeta.blockerStart);
    if (!allowDeferredBom || lineBlockers.length === 0) return false;
    blockers.splice(lineMeta.blockerStart);
    movementEntries.splice(lineMeta.movementStart);
    perLineConsumptionStatus[line.lineKey] = "PENDING_BOM";
    pendingConsumptionPayloads.push(buildPendingConsumptionIntent({
      salesStoreId: store.id,
      blockers: lineBlockers,
      ...inventoryAttribution,
      ...logicalSalesAttribution,
      orderId,
      orderNumber,
      orderLineId: line.lineKey,
      finishedGoodId: lineMeta.finishedGoodId,
      finishedGoodCode: lineMeta.finishedGoodCode,
      finishedGoodName: lineMeta.finishedGoodName,
      quantitySold: lineMeta.soldQuantity,
      soldAt: serverTimestamp(),
      source,
      createdAt: serverTimestamp()
    }));
    pushWarning({
      type: "PENDING_BOM_DEFERRED",
      message: `${lineMeta.finishedGoodName}: inventory will be reconciled after BOM completion.`,
      storeId: inventoryStore.id,
      storeName: inventoryStore.name,
      finishedGoodCode: lineMeta.finishedGoodCode,
      finishedGoodName: lineMeta.finishedGoodName,
      unit: "BOM"
    });
    return true;
  };
  const getRawIngredient = async (code) => {
    if (rawCache.has(code)) return rawCache.get(code) || null;
    const snap = await transaction.get(doc(db, "rawIngredients", code));
    const value = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    rawCache.set(code, value);
    return value;
  };
  const getPrepItem = async (code) => {
    if (prepCache.has(code)) return prepCache.get(code) || null;
    const snap = await transaction.get(doc(db, "prepItems", code));
    const value = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    prepCache.set(code, value);
    return value;
  };
  const getFinishedGood = async (code) => {
    if (finishedCache.has(code)) return finishedCache.get(code) || null;
    const snap = await transaction.get(doc(db, "finishedGoods", code));
    const value = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    finishedCache.set(code, value);
    return value;
  };
  const getStockRow = async (stockItemType, stockItemCode, fallback) => {
    const directId = getStockDocId(inventoryStore.id, stockItemType, stockItemCode);
    if (stockCache.has(directId)) return stockCache.get(directId) || null;
    let stockRef = doc(db, "storeStock", directId);
    let stockSnap = await transaction.get(stockRef);
    let resolvedType = stockItemType;
    if (!stockSnap.exists() && stockItemType === "PACKAGING") {
      const fallbackId = getStockDocId(inventoryStore.id, "RAW_INGREDIENT", stockItemCode);
      stockRef = doc(db, "storeStock", fallbackId);
      stockSnap = await transaction.get(stockRef);
      resolvedType = "RAW_INGREDIENT";
      if (stockSnap.exists()) {
        const data2 = stockSnap.data();
        const resolved2 = {
          id: fallbackId,
          ref: stockRef,
          stockItemType: resolvedType,
          stockItemCode,
          stockItemName: String(data2.stockItemName || stockItemCode),
          currentStock: toNumber(data2.currentStock),
          uom: normalizeUom(data2.uom),
          costPerUnit: toNumber(data2.costPerUnit),
          confirmedZero: data2.confirmedZero === true,
          exists: true
        };
        stockCache.set(fallbackId, resolved2);
        stockCache.set(directId, resolved2);
        return resolved2;
      }
    }
    if (!stockSnap.exists()) {
      if (!fallback) {
        stockCache.set(directId, null);
        return null;
      }
      const resolvedType2 = fallback.stockItemType || stockItemType;
      const resolvedId = getStockDocId(inventoryStore.id, resolvedType2, stockItemCode);
      const syntheticRef = doc(db, "storeStock", resolvedId);
      const synthetic = {
        id: resolvedId,
        ref: syntheticRef,
        stockItemType: resolvedType2,
        stockItemCode,
        stockItemName: String(fallback.stockItemName || stockItemCode),
        currentStock: 0,
        uom: normalizeUom(fallback.unit),
        costPerUnit: toNumber(fallback.costPerUnit),
        confirmedZero: false,
        exists: false
      };
      stockCache.set(resolvedId, synthetic);
      stockCache.set(directId, synthetic);
      return synthetic;
    }
    const data = stockSnap.data();
    const resolved = {
      id: stockRef.id,
      ref: stockRef,
      stockItemType: resolvedType,
      stockItemCode,
      stockItemName: String(data.stockItemName || stockItemCode),
      currentStock: toNumber(data.currentStock),
      uom: normalizeUom(data.uom),
      costPerUnit: toNumber(data.costPerUnit),
      confirmedZero: data.confirmedZero === true,
      exists: true
    };
    stockCache.set(directId, resolved);
    return resolved;
  };
  const scheduleMovement = async (stockItemType, stockItemCode, stockItemName, requiredQuantity, fromUnit, context) => {
    const stockRow = await getStockRow(stockItemType, stockItemCode, {
      stockItemName,
      stockItemType: context.createMissingStockType,
      unit: context.defaultStockUnit || fromUnit,
      costPerUnit: context.defaultCostPerUnit
    });
    if (!stockRow) {
      addBlocker({
        itemName: context.itemName,
        itemCode: context.itemCode,
        finishedGoodCode: context.finishedGoodCode,
        blockerType: "Missing stock record",
        componentType: context.componentType,
        componentCode: stockItemCode,
        componentName: context.componentName,
        requiredQuantity,
        availableQuantity: 0,
        unit: normalizeUom(fromUnit),
        suggestedAdminAction: context.suggestedAction || `Create a storeStock row for ${context.componentType} / ${stockItemCode} at ${inventoryStore.name}.`
      });
      return;
    }
    const stockUnit = normalizeUom(stockRow.uom || fromUnit);
    if (!stockRow.exists) {
      pushWarning({
        type: "MISSING_STOCK_ROW_CREATED",
        message: `${context.finishedGoodName}: created missing store stock row for ${stockRow.stockItemType} / ${stockItemCode} at ${inventoryStore.name} with a starting quantity of 0 ${stockUnit}.`,
        storeId: inventoryStore.id,
        storeName: inventoryStore.name,
        stockItemType: stockRow.stockItemType,
        stockItemCode,
        stockItemName,
        finishedGoodCode: context.finishedGoodCode,
        finishedGoodName: context.finishedGoodName,
        previousQty: 0,
        newQty: 0,
        unit: stockUnit
      });
    }
    const conversion = convertQuantity(requiredQuantity, fromUnit, stockUnit);
    if (!conversion) {
      addBlocker({
        itemName: context.itemName,
        itemCode: context.itemCode,
        finishedGoodCode: context.finishedGoodCode,
        blockerType: "Unit conversion impossible",
        componentType: stockRow.stockItemType,
        componentCode: stockItemCode,
        componentName: stockItemName,
        requiredQuantity,
        availableQuantity: stockRow.currentStock,
        unit: `${normalizeUom(fromUnit)} -> ${stockUnit}`,
        suggestedAdminAction: `Align BOM and store stock units for ${stockItemCode}.`
      });
      return;
    }
    if (conversion.normalized) {
      pushWarning({
        type: "UNIT_NORMALIZED",
        message: `${context.finishedGoodName}: normalized ${stockItemCode} from ${normalizeUom(fromUnit)} to ${stockUnit}.`,
        storeId: inventoryStore.id,
        storeName: inventoryStore.name,
        stockItemType: stockRow.stockItemType,
        stockItemCode,
        stockItemName,
        finishedGoodCode: context.finishedGoodCode,
        finishedGoodName: context.finishedGoodName,
        unit: stockUnit
      });
    }
    const costPerUnit = stockRow.costPerUnit > 0 ? stockRow.costPerUnit : 0;
    if (costPerUnit <= 0) {
      pushWarning({
        type: "MISSING_COST",
        message: `${context.finishedGoodName}: ${stockItemName} has no cost configured, so COGS was recorded as 0 for this component.`,
        storeId: inventoryStore.id,
        storeName: inventoryStore.name,
        stockItemType: stockRow.stockItemType,
        stockItemCode,
        stockItemName,
        finishedGoodCode: context.finishedGoodCode,
        finishedGoodName: context.finishedGoodName,
        unit: stockUnit
      });
    }
    movementEntries.push({
      stockDocId: stockRow.id,
      stockRef: stockRow.ref,
      stockItemType: stockRow.stockItemType,
      stockItemCode,
      stockItemName,
      unit: stockUnit,
      quantity: conversion.quantity,
      lineKey: context.lineKey,
      finishedGoodCode: context.finishedGoodCode,
      finishedGoodName: context.finishedGoodName,
      itemCode: context.itemCode,
      itemName: context.itemName,
      costPerUnit,
      warnings: []
    });
  };
  const expandPrepBom = async (prepItem, requiredOutputQuantity, context) => {
    const prepYieldUom = normalizeUom(prepItem.yieldUOM || prepItem.outputUOM);
    const yieldQuantity = toNumber(prepItem.yieldQuantity, 0);
    if (!prepYieldUom || yieldQuantity <= 0) {
      addBlocker({
        itemName: context.itemName,
        itemCode: context.itemCode,
        finishedGoodCode: context.finishedGoodCode,
        blockerType: "Invalid quantity",
        componentType: "PREP_ITEM",
        componentCode: prepItem.code,
        componentName: prepItem.name,
        requiredQuantity: requiredOutputQuantity,
        availableQuantity: 0,
        unit: prepYieldUom || "PREP",
        suggestedAdminAction: `Fix yieldQuantity/yieldUOM for prep item ${prepItem.code}.`
      });
      return;
    }
    if (!Array.isArray(prepItem.bom) || prepItem.bom.length === 0) {
      addBlocker({
        itemName: context.itemName,
        itemCode: context.itemCode,
        finishedGoodCode: context.finishedGoodCode,
        blockerType: "Missing BOM",
        componentType: "PREP_ITEM",
        componentCode: prepItem.code,
        componentName: prepItem.name,
        requiredQuantity: requiredOutputQuantity,
        availableQuantity: 0,
        unit: prepYieldUom,
        suggestedAdminAction: `Add a BOM for prep item ${prepItem.code} or mark it as stock-tracked and maintain prep stock.`
      });
      return;
    }
    const scaleFactor = requiredOutputQuantity / yieldQuantity;
    for (const line of prepItem.bom) {
      const componentCode = String(line?.componentCode || "").trim();
      const componentType = String(line?.componentType || "").trim();
      const componentName = String(line?.componentName || componentCode).trim();
      const componentQuantity = toNumber(line?.quantity, 0);
      const componentUnit = normalizeUom(line?.uom);
      if (!componentCode || !componentType || componentQuantity <= 0 || !componentUnit) {
        addBlocker({
          itemName: context.itemName,
          itemCode: context.itemCode,
          finishedGoodCode: context.finishedGoodCode,
          blockerType: "Missing prep/raw ingredient reference",
          componentType: componentType || "UNKNOWN",
          componentCode: componentCode || "UNKNOWN",
          componentName: componentName || "Missing component",
          requiredQuantity: componentQuantity,
          availableQuantity: 0,
          unit: componentUnit || prepYieldUom,
          suggestedAdminAction: `Fix the BOM row on prep item ${prepItem.code}.`
        });
        continue;
      }
      await expandComponent({
        ...context,
        componentType,
        componentCode,
        componentName,
        quantity: componentQuantity * scaleFactor,
        unit: componentUnit,
        prepPath: [...context.prepPath, prepItem.code]
      });
    }
  };
  const expandComponent = async (component) => {
    const {
      lineKey,
      finishedGoodCode,
      finishedGoodName,
      itemCode,
      itemName,
      componentType,
      componentCode,
      componentName,
      quantity,
      unit,
      prepPath
    } = component;
    const normalizedType = String(componentType || "").trim();
    const normalizedUnit = normalizeUom(unit);
    const normalizedQuantity = toNumber(quantity, 0);
    if (!componentCode || !normalizedType || normalizedQuantity <= 0 || !normalizedUnit) {
      addBlocker({
        itemName,
        itemCode,
        finishedGoodCode,
        blockerType: "Missing prep/raw ingredient reference",
        componentType: normalizedType || "UNKNOWN",
        componentCode: componentCode || "UNKNOWN",
        componentName: componentName || "Missing component",
        requiredQuantity: normalizedQuantity,
        availableQuantity: 0,
        unit: normalizedUnit,
        suggestedAdminAction: `Fix the BOM row for ${finishedGoodCode}.`
      });
      return;
    }
    if (normalizedType === "RAW_INGREDIENT" || normalizedType === "PACKAGING" || normalizedType === "BOUGHT_COMPONENT" || normalizedType === "FINISHED_GOOD") {
      let rawIngredient = null;
      if (normalizedType === "RAW_INGREDIENT" || normalizedType === "PACKAGING") {
        rawIngredient = await getRawIngredient(componentCode);
        if (!rawIngredient) {
          addBlocker({
            itemName,
            itemCode,
            finishedGoodCode,
            blockerType: "Missing prep/raw ingredient reference",
            componentType: normalizedType,
            componentCode,
            componentName,
            requiredQuantity: normalizedQuantity,
            availableQuantity: 0,
            unit: normalizedUnit,
            suggestedAdminAction: `Create raw ingredient master ${componentCode} before billing.`
          });
          return;
        }
      }
      if (normalizedType === "FINISHED_GOOD") {
        const componentFinishedGood = await getFinishedGood(componentCode);
        if (!componentFinishedGood) {
          addBlocker({
            itemName,
            itemCode,
            finishedGoodCode,
            blockerType: "Missing prep/raw ingredient reference",
            componentType: normalizedType,
            componentCode,
            componentName,
            requiredQuantity: normalizedQuantity,
            availableQuantity: 0,
            unit: normalizedUnit,
            suggestedAdminAction: `Create finished good master ${componentCode} before billing.`
          });
          return;
        }
      }
      await scheduleMovement(normalizedType, componentCode, componentName, normalizedQuantity, normalizedUnit, {
        lineKey,
        itemCode,
        itemName,
        finishedGoodCode,
        finishedGoodName,
        componentName,
        componentType: normalizedType,
        defaultStockUnit: rawIngredient?.usageUOM || normalizedUnit,
        defaultCostPerUnit: rawIngredient?.costPerUsageUnit,
        createMissingStockType: normalizedType
      });
      return;
    }
    if (normalizedType === "PREP_ITEM") {
      const prepItem = await getPrepItem(componentCode);
      if (!prepItem) {
        addBlocker({
          itemName,
          itemCode,
          finishedGoodCode,
          blockerType: "Missing prep/raw ingredient reference",
          componentType: normalizedType,
          componentCode,
          componentName,
          requiredQuantity: normalizedQuantity,
          availableQuantity: 0,
          unit: normalizedUnit,
          suggestedAdminAction: `Create prep item master ${componentCode} before billing.`
        });
        return;
      }
      const prepOutputUom = normalizeUom(prepItem.yieldUOM || prepItem.outputUOM);
      const prepQuantityConversion = convertQuantity(normalizedQuantity, normalizedUnit, prepOutputUom || normalizedUnit);
      if (!prepQuantityConversion) {
        addBlocker({
          itemName,
          itemCode,
          finishedGoodCode,
          blockerType: "Unit conversion impossible",
          componentType: normalizedType,
          componentCode,
          componentName: prepItem.name,
          requiredQuantity: normalizedQuantity,
          availableQuantity: 0,
          unit: `${normalizedUnit} -> ${prepOutputUom || "UNKNOWN"}`,
          suggestedAdminAction: `Align BOM units for prep item ${componentCode}.`
        });
        return;
      }
      if (prepItem.isStockTracked) {
        await scheduleMovement("PREP_ITEM", componentCode, prepItem.name, prepQuantityConversion.quantity, prepOutputUom || normalizedUnit, {
          lineKey,
          itemCode,
          itemName,
          finishedGoodCode,
          finishedGoodName,
          componentName: prepItem.name,
          componentType: "PREP_ITEM",
          defaultStockUnit: prepOutputUom || normalizedUnit,
          defaultCostPerUnit: prepItem.costPerUnit,
          createMissingStockType: "PREP_ITEM"
        });
        return;
      }
      if (prepPath.includes(componentCode)) {
        addBlocker({
          itemName,
          itemCode,
          finishedGoodCode,
          blockerType: "Missing BOM",
          componentType: "PREP_ITEM",
          componentCode,
          componentName: prepItem.name,
          requiredQuantity: prepQuantityConversion.quantity,
          availableQuantity: 0,
          unit: prepOutputUom || normalizedUnit,
          suggestedAdminAction: `Resolve circular prep BOM references involving ${componentCode}.`
        });
        return;
      }
      await expandPrepBom(prepItem, prepQuantityConversion.quantity, {
        lineKey,
        soldQuantity: component.soldQuantity,
        finishedGoodCode,
        finishedGoodName,
        itemCode,
        itemName,
        prepPath
      });
      return;
    }
    addBlocker({
      itemName,
      itemCode,
      finishedGoodCode,
      blockerType: "Missing prep/raw ingredient reference",
      componentType: normalizedType,
      componentCode,
      componentName,
      requiredQuantity: normalizedQuantity,
      availableQuantity: 0,
      unit: normalizedUnit,
      suggestedAdminAction: `Unsupported BOM component type ${normalizedType} for ${componentCode}.`
    });
  };
  const processLineAddOns = async (line, finishedGoodCode, finishedGoodName, soldQuantity) => {
    let processed = false;
    for (const addOn of line.addOns || []) {
      if (addOn.inventoryTrackingStatus !== "CONFIGURED" || !addOn.inventoryItemType || !addOn.inventoryItemCode || !addOn.consumptionUnit || toNumber(addOn.consumptionQuantity) <= 0) {
        continue;
      }
      processed = true;
      await expandComponent({
        lineKey: line.lineKey,
        soldQuantity,
        finishedGoodCode,
        finishedGoodName,
        itemCode: finishedGoodCode,
        itemName: `${finishedGoodName} + ${addOn.optionName}`,
        componentType: addOn.inventoryItemType,
        componentCode: addOn.inventoryItemCode,
        componentName: addOn.optionName,
        quantity: toNumber(addOn.consumptionQuantity) * Math.max(1, toNumber(addOn.quantity)) * soldQuantity,
        unit: addOn.consumptionUnit,
        prepPath: []
      });
    }
    return processed;
  };
  for (const line of lines) {
    const finishedGoodCode = String(line.finishedGood.code || "").trim();
    const finishedGoodName = String(line.finishedGood.displayName || line.finishedGood.name || finishedGoodCode).trim();
    const soldQuantity = toNumber(line.quantity, 0);
    const itemType = String(line.finishedGood.itemType || "");
    const bom = Array.isArray(line.finishedGood.bom) ? line.finishedGood.bom : [];
    const lineBlockerStart = blockers.length;
    const lineMovementStart = movementEntries.length;
    if (!finishedGoodCode || !finishedGoodName || soldQuantity <= 0) {
      addBlocker({
        itemName: finishedGoodName || "Unknown item",
        itemCode: finishedGoodCode || "UNKNOWN",
        finishedGoodCode: finishedGoodCode || "UNKNOWN",
        blockerType: "Invalid quantity",
        requiredQuantity: soldQuantity,
        availableQuantity: 0,
        unit: "QTY",
        suggestedAdminAction: "Fix the sale line before billing."
      });
      continue;
    }
    const isAvailable = isFinishedGoodAvailable(line.finishedGood, store.id);
    if (!isAvailable) {
      addBlocker({
        itemName: finishedGoodName,
        itemCode: finishedGoodCode,
        finishedGoodCode,
        blockerType: "Finished good unavailable",
        requiredQuantity: soldQuantity,
        availableQuantity: 0,
        unit: "QTY",
        suggestedAdminAction: "Make the finished good active, sellable, available, and assigned to this store before billing."
      });
      continue;
    }
    if (isNoStockItem(line.finishedGood)) {
      const processedAddOnInventory2 = await processLineAddOns(line, finishedGoodCode, finishedGoodName, soldQuantity);
      perLineConsumptionStatus[line.lineKey] = processedAddOnInventory2 ? "APPLIED" : "NOT_REQUIRED";
      continue;
    }
    if (usesBom(line.finishedGood)) {
      const bomMissing = line.finishedGood.bom === void 0 || line.finishedGood.bom === null;
      const bomMalformed = !bomMissing && !Array.isArray(line.finishedGood.bom);
      if (bomMalformed) {
        addBlocker({
          itemName: finishedGoodName,
          itemCode: finishedGoodCode,
          finishedGoodCode,
          blockerType: "Missing prep/raw ingredient reference",
          requiredQuantity: soldQuantity,
          availableQuantity: 0,
          unit: "BOM",
          suggestedAdminAction: "Replace the malformed BOM value with a valid recipe array."
        });
        if (allowExpandedBomFailureDeferral && deferLineBomIfAllowed(line, {
          blockerStart: lineBlockerStart,
          movementStart: lineMovementStart,
          finishedGoodCode,
          finishedGoodName,
          soldQuantity,
          finishedGoodId: String(line.finishedGood.id || finishedGoodCode),
          bomVersion: typeof line.finishedGood.bomVersion === "number" ? line.finishedGood.bomVersion : null
        })) {
          await processLineAddOns(line, finishedGoodCode, finishedGoodName, soldQuantity);
          continue;
        }
        continue;
      }
      if (bom.length === 0) {
        addBlocker({
          itemName: finishedGoodName,
          itemCode: finishedGoodCode,
          finishedGoodCode,
          blockerType: "Missing BOM",
          requiredQuantity: soldQuantity,
          availableQuantity: 0,
          unit: "BOM",
          suggestedAdminAction: "Add a BOM/recipe for this finished good in Menu Management."
        });
        if (deferLineBomIfAllowed(line, {
          blockerStart: lineBlockerStart,
          movementStart: lineMovementStart,
          finishedGoodCode,
          finishedGoodName,
          soldQuantity,
          finishedGoodId: String(line.finishedGood.id || finishedGoodCode),
          bomVersion: typeof line.finishedGood.bomVersion === "number" ? line.finishedGood.bomVersion : null
        })) {
          await processLineAddOns(line, finishedGoodCode, finishedGoodName, soldQuantity);
          continue;
        }
        continue;
      }
      for (const bomLine of bom) {
        const componentCode = String(bomLine?.componentCode || "").trim();
        const componentType = String(bomLine?.componentType || "").trim();
        const componentName = String(bomLine?.componentName || componentCode).trim();
        const componentQuantity = toNumber(bomLine?.quantity, 0);
        const componentUnit = normalizeUom(bomLine?.uom);
        if (componentType === "PACKAGING" && !isPackagingComponentApplicable(bomLine, orderType)) {
          continue;
        }
        if (!componentCode || !componentType || componentQuantity <= 0 || !componentUnit) {
          addBlocker({
            itemName: finishedGoodName,
            itemCode: finishedGoodCode,
            finishedGoodCode,
            blockerType: "Missing prep/raw ingredient reference",
            componentType: componentType || "UNKNOWN",
            componentCode: componentCode || "UNKNOWN",
            componentName: componentName || "Missing component",
            requiredQuantity: componentQuantity,
            availableQuantity: 0,
            unit: componentUnit,
            suggestedAdminAction: "Fix the BOM row so it has a valid component type, component code, quantity, and UOM."
          });
          continue;
        }
        await expandComponent({
          lineKey: line.lineKey,
          soldQuantity,
          finishedGoodCode,
          finishedGoodName,
          itemCode: finishedGoodCode,
          itemName: finishedGoodName,
          componentType,
          componentCode,
          componentName,
          quantity: componentQuantity * soldQuantity,
          unit: componentUnit,
          prepPath: []
        });
      }
      if (allowExpandedBomFailureDeferral && deferLineBomIfAllowed(line, {
        blockerStart: lineBlockerStart,
        movementStart: lineMovementStart,
        finishedGoodCode,
        finishedGoodName,
        soldQuantity,
        finishedGoodId: String(line.finishedGood.id || finishedGoodCode),
        bomVersion: typeof line.finishedGood.bomVersion === "number" ? line.finishedGood.bomVersion : null
      })) {
        await processLineAddOns(line, finishedGoodCode, finishedGoodName, soldQuantity);
        continue;
      }
      if (!perLineConsumptionStatus[line.lineKey]) perLineConsumptionStatus[line.lineKey] = "APPLIED";
      await processLineAddOns(line, finishedGoodCode, finishedGoodName, soldQuantity);
      continue;
    }
    if (isDirectStockSale(line.finishedGood)) {
      await scheduleMovement("FINISHED_GOOD", finishedGoodCode, finishedGoodName, soldQuantity, "PCS", {
        lineKey: line.lineKey,
        itemCode: finishedGoodCode,
        itemName: finishedGoodName,
        finishedGoodCode,
        finishedGoodName,
        componentName: finishedGoodName,
        componentType: "FINISHED_GOOD",
        defaultStockUnit: "PCS",
        defaultCostPerUnit: toNumber(line.finishedGood.recipeCost),
        createMissingStockType: "FINISHED_GOOD"
      });
      if (!perLineConsumptionStatus[line.lineKey]) perLineConsumptionStatus[line.lineKey] = "APPLIED";
      await processLineAddOns(line, finishedGoodCode, finishedGoodName, soldQuantity);
      continue;
    }
    const processedAddOnInventory = await processLineAddOns(line, finishedGoodCode, finishedGoodName, soldQuantity);
    if (!perLineConsumptionStatus[line.lineKey]) {
      perLineConsumptionStatus[line.lineKey] = processedAddOnInventory ? "APPLIED" : "NOT_REQUIRED";
    }
  }
  if (blockers.length > 0) {
    return {
      blockers,
      warnings,
      totalCogs: 0,
      perLineCogs: {},
      perLineConsumptionStatus: {},
      stockUpdates: [],
      movementPayloads: [],
      pendingConsumptionPayloads: []
    };
  }
  const movementGroups = /* @__PURE__ */ new Map();
  movementEntries.forEach((entry) => {
    if (!movementGroups.has(entry.stockDocId)) movementGroups.set(entry.stockDocId, []);
    movementGroups.get(entry.stockDocId).push(entry);
  });
  const stockUpdates = [];
  const movementPayloads = [];
  for (const [stockDocId, entries] of movementGroups.entries()) {
    const stockRow = await getStockRow(entries[0].stockItemType, entries[0].stockItemCode, {
      stockItemName: entries[0].stockItemName,
      stockItemType: entries[0].stockItemType,
      unit: entries[0].unit,
      costPerUnit: entries[0].costPerUnit
    });
    if (!stockRow) continue;
    const aggregatedEntries = aggregateConsumptionEntries(entries);
    let runningQty = stockRow.currentStock;
    aggregatedEntries.forEach((entry) => {
      const previousQty = runningQty;
      const newQty = roundValue(previousQty - entry.quantity);
      runningQty = newQty;
      const cogsAmount = roundMoney(entry.quantity * entry.costPerUnit);
      perLineCogs[entry.lineKey] = roundMoney((perLineCogs[entry.lineKey] || 0) + cogsAmount);
      if (newQty < 0) {
        if (!stockRow.exists) {
          pushWarning({
            type: "STOCK_ROW_CREATED_NEGATIVE",
            message: `${entry.finishedGoodName}: created ${entry.stockItemName} store stock at ${inventoryStore.name} and immediately deducted it below zero (${previousQty.toFixed(2)} \u2192 ${newQty.toFixed(2)} ${entry.unit}).`,
            storeId: inventoryStore.id,
            storeName: inventoryStore.name,
            stockItemType: entry.stockItemType,
            stockItemCode: entry.stockItemCode,
            stockItemName: entry.stockItemName,
            finishedGoodCode: entry.finishedGoodCode,
            finishedGoodName: entry.finishedGoodName,
            previousQty,
            newQty,
            unit: entry.unit
          });
        } else {
          pushWarning({
            type: "NEGATIVE_STOCK",
            message: `${entry.finishedGoodName}: ${entry.stockItemName} dropped below zero (${previousQty.toFixed(2)} \u2192 ${newQty.toFixed(2)} ${entry.unit}).`,
            storeId: inventoryStore.id,
            storeName: inventoryStore.name,
            stockItemType: entry.stockItemType,
            stockItemCode: entry.stockItemCode,
            stockItemName: entry.stockItemName,
            finishedGoodCode: entry.finishedGoodCode,
            finishedGoodName: entry.finishedGoodName,
            previousQty,
            newQty,
            unit: entry.unit
          });
        }
      }
      movementPayloads.push({
        stockDocId,
        ...inventoryAttribution,
        ...logicalSalesAttribution,
        inventoryItemId: entry.stockItemCode,
        inventoryItemName: entry.stockItemName,
        movementType: "SALE_DEDUCTION",
        quantity: -entry.quantity,
        quantityDelta: -entry.quantity,
        unit: entry.unit,
        referenceType: "ORDER",
        referenceId: orderId,
        orderId,
        orderNumber,
        businessDate,
        notes: buildSaleNote(source, orderNumber),
        createdByUserId: staffProfile.uid,
        createdByName: staffProfile.name,
        createdAt: serverTimestamp(),
        stockSystem: "MENU_MANAGEMENT",
        stockItemType: entry.stockItemType,
        stockItemCode: entry.stockItemCode,
        previousQty: roundValue(previousQty),
        newQty: roundValue(newQty),
        wentNegative: newQty < 0,
        cogsAmount,
        finishedGoodCode: entry.finishedGoodCode,
        finishedGoodName: entry.finishedGoodName,
        source,
        orderLineKey: entry.lineKey
      });
    });
    stockUpdates.push({
      stockDocId,
      stockRef: stockRow.ref,
      previousQty: roundValue(stockRow.currentStock),
      newQty: roundValue(runningQty),
      existed: stockRow.exists,
      seedData: {
        storeId: inventoryStore.id,
        storeCode: inventoryStore.code,
        storeName: inventoryStore.name,
        stockItemType: stockRow.stockItemType,
        stockItemCode: stockRow.stockItemCode,
        stockItemName: stockRow.stockItemName,
        uom: stockRow.uom,
        openingStock: 0,
        minimumStock: 0,
        costPerUnit: stockRow.costPerUnit
      }
    });
  }
  const totalCogs = roundMoney(Object.values(perLineCogs).reduce((sum, value) => sum + value, 0));
  return {
    blockers,
    warnings,
    totalCogs,
    perLineCogs,
    perLineConsumptionStatus,
    stockUpdates,
    movementPayloads,
    pendingConsumptionPayloads
  };
}

// <stdin>
async function planPosInventory({ db: db2, admin, transaction, ...input }) {
  return storage.run({ db: db2, admin }, async () => {
    const result = await planInventoryDeductionForSale({ ...input, transaction: { get: async (ref) => {
      const snap = await transaction.get(ref);
      return { id: snap.id, ref: snap.ref, exists: () => snap.exists, data: () => snap.data() };
    } } });
    return { ...result, stockUpdates: result.stockUpdates.map((s) => ({ ...s, ref: s.stockRef })) };
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  planPosInventory
});
