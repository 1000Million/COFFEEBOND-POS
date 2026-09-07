'use strict';

const {
  inventoryStoreAttribution,
  logicalSalesStoreAttribution,
  resolveInventoryStore,
} = require('./inventoryStoreResolver');

const UOM_ALIASES = {
  G: 'G', GRAM: 'G', GRAMS: 'G',
  KG: 'KG', KGS: 'KG', KILOGRAM: 'KG', KILOGRAMS: 'KG',
  ML: 'ML', MILLILITRE: 'ML', MILLILITER: 'ML', MILLILITRES: 'ML', MILLILITERS: 'ML',
  L: 'L', LTR: 'L', LTRS: 'L', LITRE: 'L', LITER: 'L', LITRES: 'L', LITERS: 'L',
  PCS: 'PCS', PC: 'PCS', PIECE: 'PCS', PIECES: 'PCS',
};
const UOM_SCALE = {
  G: { family: 'WEIGHT', baseFactor: 1 },
  KG: { family: 'WEIGHT', baseFactor: 1000 },
  ML: { family: 'VOLUME', baseFactor: 1 },
  L: { family: 'VOLUME', baseFactor: 1000 },
  PCS: { family: 'COUNT', baseFactor: 1 },
};
const TAKEAWAY_PACKAGING_PATTERNS = [
  /\bbox(es)?\b/i, /\bcontainer(s)?\b/i, /\bcup(s)?\b/i, /\blid(s)?\b/i,
  /\bbag(s)?\b/i, /\bcarry\b/i, /\btake[\s_-]?away\b/i, /\bparcel\b/i,
  /\bcutlery\b/i, /\bspoon(s)?\b/i, /\bfork(s)?\b/i, /\bknife\b/i, /\bstraw(s)?\b/i,
];

function round(value, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function money(value) {
  return round(value, 2);
}

function number(value, fallback = 0) {
  const parsed = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function uom(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return UOM_ALIASES[normalized] || normalized;
}

function convert(quantity, fromUnit, toUnit) {
  const from = uom(fromUnit);
  const to = uom(toUnit);
  if (!from || !to) return null;
  if (from === to) return round(quantity);
  const fromMeta = UOM_SCALE[from];
  const toMeta = UOM_SCALE[to];
  if (!fromMeta || !toMeta || fromMeta.family !== toMeta.family) return null;
  return round(quantity * fromMeta.baseFactor / toMeta.baseFactor);
}

function stockId(storeId, type, code) {
  return `${storeId}_${type}_${code}`;
}

function isGoldenISalesFirstOrderingStore(store) {
  return store?.id === 'GOLDEN_I'
    && String(store.code || store.storeCode || '').trim() === 'GOLDEN_I';
}

function inventoryPolicy(store) {
  const configured = String(store.inventoryPolicy || '').trim().toUpperCase();
  if (['STRICT', 'ALLOW_NEGATIVE', 'ALLOW_NEGATIVE_DEFER_BOM'].includes(configured)) return configured;
  return isGoldenISalesFirstOrderingStore(store)
    ? 'ALLOW_NEGATIVE_DEFER_BOM'
    : 'STRICT';
}

// Stock shortage only blocks a sale for STRICT stores. A store opts out per-store by
// setting inventoryPolicy to ALLOW_NEGATIVE or ALLOW_NEGATIVE_DEFER_BOM; Golden I keeps
// its historical behaviour through the inventoryPolicy() fallback.
function shouldRequireAvailableStock(store, requested) {
  return requested === true && inventoryPolicy(store) === 'STRICT';
}

function usesBom(item) {
  return item.itemType === 'MADE_TO_ORDER'
    || (item.itemType === 'DIRECT_STOCK' && Array.isArray(item.bom) && item.bom.length > 0)
    || item.productionMode === 'MADE_TO_ORDER'
    || item.productionMode === 'ASSEMBLED_TO_ORDER';
}

function directStock(item) {
  return item.itemType === 'DIRECT_STOCK' || item.productionMode === 'BOUGHT_AND_SOLD';
}

function noStock(item) {
  return item.itemType === 'NO_STOCK' || item.productionMode === 'NO_STOCK';
}

function packagingApplicability(line) {
  const raw = line.applicableOrderTypes
    ?? line.packagingApplicability
    ?? line.orderTypes
    ?? line.serviceTypes
    ?? line.serviceType
    ?? line.applicability;
  const explicit = (Array.isArray(raw) ? raw : raw ? [raw] : [])
    .map(value => String(value).trim().toUpperCase().replace(/[\s-]+/g, '_'))
    .map(value => value === 'PICKUP' || value === 'TAKE_OUT' || value === 'TAKEOUT' ? 'TAKEAWAY' : value)
    .map(value => value === 'DINEIN' ? 'DINE_IN' : value)
    .filter(value => ['DINE_IN', 'TAKEAWAY', 'DELIVERY', 'ALL'].includes(value));
  if (explicit.length > 0) return [...new Set(explicit)];
  const label = `${line.componentCode || ''} ${line.componentName || ''}`.replace(/_/g, ' ');
  return TAKEAWAY_PACKAGING_PATTERNS.some(pattern => pattern.test(label))
    ? ['TAKEAWAY', 'DELIVERY']
    : ['ALL'];
}

function packagingApplies(line, orderType) {
  const applies = packagingApplicability(line);
  return applies.includes('ALL') || applies.includes(orderType);
}

function safeDocId(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, '_');
}

function insufficientStockBlockers(groupedMovements, store) {
  const blockers = [];
  for (const entries of groupedMovements.values()) {
    const row = entries[0].stock;
    const requiredQuantity = round(entries.reduce((sum, entry) => sum + entry.quantity, 0));
    if (row.currentStock >= requiredQuantity) continue;
    const affectedItems = [...new Set(entries.map(entry => entry.finishedGoodName).filter(Boolean))];
    blockers.push({
      itemName: affectedItems.join(', ') || row.name,
      itemCode: entries[0].finishedGoodCode,
      finishedGoodCode: entries[0].finishedGoodCode,
      blockerType: 'INSUFFICIENT_STOCK',
      storeId: store.id,
      storeName: store.name,
      componentType: row.type,
      componentCode: row.code,
      componentName: row.name,
      requiredQuantity,
      availableQuantity: row.currentStock,
      unit: row.unit,
      suggestedAdminAction: `Receive or correct ${row.name} stock before accepting this paid order.`,
    });
  }
  return blockers;
}

async function planOnlineOrderInventory({
  transaction,
  db,
  admin,
  store,
  orderId,
  orderNumber,
  orderType,
  businessDate,
  staff,
  lines,
  requireAvailableStock = false,
  source = 'CUSTOMER_WEB_ACCEPT',
}) {
  const inventoryStore = await resolveInventoryStore(store, async inventoryStoreId => {
    const snapshot = await transaction.get(db.collection('stores').doc(inventoryStoreId));
    return snapshot.exists ? { ...snapshot.data(), id: snapshot.id } : null;
  });
  const inventoryAttribution = inventoryStoreAttribution(inventoryStore);
  const logicalSalesAttribution = logicalSalesStoreAttribution(store);
  const blockers = [];
  const warnings = [];
  const movements = [];
  const pending = [];
  const perLineCogs = {};
  const perLineConsumptionStatus = {};
  const rawCache = new Map();
  const prepCache = new Map();
  const finishedCache = new Map();
  const stockCache = new Map();
  const warningKeys = new Set();
  const canDefer = inventoryPolicy(store) === 'ALLOW_NEGATIVE_DEFER_BOM';
  // Golden I historically deferred unresolved BOM expansion as well as a wholly
  // missing recipe. Preserve that exact-store invariant, but keep every other
  // explicit-policy store narrow: only an absent/empty top-level BOM may be deferred.
  const canDeferExpandedBomFailures = canDefer
    && isGoldenISalesFirstOrderingStore(store);

  const readDoc = async (collection, id, cache) => {
    if (cache.has(id)) return cache.get(id);
    const ref = db.collection(collection).doc(id);
    const snapshot = await transaction.get(ref);
    const data = snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
    cache.set(id, data);
    return data;
  };
  const warn = warning => {
    const key = JSON.stringify([warning.type, warning.stockItemCode, warning.finishedGoodCode, warning.message]);
    if (warningKeys.has(key)) return;
    warningKeys.add(key);
    warnings.push(warning);
  };
  const block = (line, type, details = {}) => blockers.push({
    itemName: line.finishedGood.displayName || line.finishedGood.name || line.finishedGood.code,
    itemCode: line.finishedGood.code,
    finishedGoodCode: line.finishedGood.code,
    blockerType: type,
    storeId: store.id,
    storeName: store.name,
    ...details,
  });

  const getStock = async (type, code, fallback) => {
    const directId = stockId(inventoryStore.id, type, code);
    if (stockCache.has(directId)) return stockCache.get(directId);
    let resolvedId = directId;
    let resolvedType = type;
    let ref = db.collection('storeStock').doc(resolvedId);
    let snapshot = await transaction.get(ref);
    if (!snapshot.exists && type === 'PACKAGING') {
      resolvedType = 'RAW_INGREDIENT';
      resolvedId = stockId(inventoryStore.id, resolvedType, code);
      ref = db.collection('storeStock').doc(resolvedId);
      snapshot = await transaction.get(ref);
    }
    const row = snapshot.exists ? {
      id: resolvedId,
      ref,
      exists: true,
      type: resolvedType,
      code,
      name: String(snapshot.data().stockItemName || fallback.name || code),
      currentStock: number(snapshot.data().currentStock),
      unit: uom(snapshot.data().uom || fallback.unit),
      costPerUnit: number(snapshot.data().costPerUnit),
    } : {
      id: directId,
      ref: db.collection('storeStock').doc(directId),
      exists: false,
      type: fallback.type || type,
      code,
      name: fallback.name || code,
      currentStock: 0,
      unit: uom(fallback.unit),
      costPerUnit: number(fallback.costPerUnit),
    };
    stockCache.set(directId, row);
    stockCache.set(row.id, row);
    return row;
  };

  const schedule = async (line, type, code, name, quantity, fromUnit, context = {}) => {
    const row = await getStock(type, code, {
      type: context.createType,
      name,
      unit: context.defaultUnit || fromUnit,
      costPerUnit: context.defaultCost,
    });
    const converted = convert(quantity, fromUnit, row.unit);
    if (converted === null) {
      block(line, 'Unit conversion impossible', {
        componentType: type,
        componentCode: code,
        componentName: name,
        requiredQuantity: quantity,
        availableQuantity: row.currentStock,
        unit: `${uom(fromUnit)} -> ${row.unit}`,
        suggestedAdminAction: `Align BOM and store stock units for ${code}.`,
      });
      return;
    }
    if (!row.exists) {
      warn({
        type: 'MISSING_STOCK_ROW_CREATED',
        message: `${name}: missing store stock row will be created at zero before deduction.`,
        storeId: inventoryStore.id,
        storeName: inventoryStore.name,
        stockItemType: row.type,
        stockItemCode: code,
        stockItemName: name,
        finishedGoodCode: line.finishedGood.code,
        finishedGoodName: line.finishedGood.name,
        previousQty: 0,
        newQty: 0,
        unit: row.unit,
      });
    }
    if (row.costPerUnit <= 0) {
      warn({
        type: 'MISSING_COST',
        message: `${name} has no configured cost; this component COGS is zero.`,
        storeId: inventoryStore.id,
        storeName: inventoryStore.name,
        stockItemType: row.type,
        stockItemCode: code,
        stockItemName: name,
        finishedGoodCode: line.finishedGood.code,
        finishedGoodName: line.finishedGood.name,
        unit: row.unit,
      });
    }
    movements.push({
      stock: row,
      quantity: converted,
      lineKey: line.lineKey,
      finishedGoodCode: line.finishedGood.code,
      finishedGoodName: line.finishedGood.displayName || line.finishedGood.name,
    });
  };

  const expandComponent = async (line, component, prepPath = []) => {
    const type = String(component.componentType || '').trim().toUpperCase();
    const code = String(component.componentCode || '').trim();
    const name = String(component.componentName || code).trim();
    const quantity = number(component.quantity);
    const unit = uom(component.unit || component.uom);
    if (!type || !code || quantity <= 0 || !unit) {
      block(line, 'Missing prep/raw ingredient reference', {
        componentType: type || 'UNKNOWN',
        componentCode: code || 'UNKNOWN',
        componentName: name || 'Missing component',
        requiredQuantity: quantity,
        unit,
        suggestedAdminAction: `Fix the BOM row for ${line.finishedGood.code}.`,
      });
      return;
    }
    if (['RAW_INGREDIENT', 'PACKAGING', 'BOUGHT_COMPONENT', 'FINISHED_GOOD'].includes(type)) {
      let master = null;
      if (type === 'RAW_INGREDIENT' || type === 'PACKAGING') {
        master = await readDoc('rawIngredients', code, rawCache);
        if (!master) {
          block(line, 'Missing prep/raw ingredient reference', {
            componentType: type, componentCode: code, componentName: name,
            requiredQuantity: quantity, unit,
            suggestedAdminAction: `Create raw ingredient master ${code} before billing.`,
          });
          return;
        }
      } else if (type === 'FINISHED_GOOD') {
        master = await readDoc('finishedGoods', code, finishedCache);
        if (!master) {
          block(line, 'Missing prep/raw ingredient reference', {
            componentType: type, componentCode: code, componentName: name,
            requiredQuantity: quantity, unit,
            suggestedAdminAction: `Create finished good master ${code} before billing.`,
          });
          return;
        }
      }
      await schedule(line, type, code, name, quantity, unit, {
        createType: type,
        defaultUnit: master?.usageUOM || unit,
        defaultCost: master?.costPerUsageUnit || master?.recipeCost,
      });
      return;
    }
    if (type !== 'PREP_ITEM') {
      block(line, 'Missing prep/raw ingredient reference', {
        componentType: type, componentCode: code, componentName: name,
        requiredQuantity: quantity, unit,
        suggestedAdminAction: `Unsupported BOM component type ${type}.`,
      });
      return;
    }
    const prep = await readDoc('prepItems', code, prepCache);
    if (!prep) {
      block(line, 'Missing prep/raw ingredient reference', {
        componentType: type, componentCode: code, componentName: name,
        requiredQuantity: quantity, unit,
        suggestedAdminAction: `Create prep item master ${code} before billing.`,
      });
      return;
    }
    const outputUnit = uom(prep.yieldUOM || prep.outputUOM);
    const converted = convert(quantity, unit, outputUnit || unit);
    if (converted === null) {
      block(line, 'Unit conversion impossible', {
        componentType: type, componentCode: code, componentName: prep.name,
        requiredQuantity: quantity, unit: `${unit} -> ${outputUnit || 'UNKNOWN'}`,
        suggestedAdminAction: `Align BOM units for prep item ${code}.`,
      });
      return;
    }
    if (prep.isStockTracked) {
      await schedule(line, 'PREP_ITEM', code, prep.name, converted, outputUnit, {
        createType: 'PREP_ITEM',
        defaultUnit: outputUnit,
        defaultCost: prep.costPerUnit,
      });
      return;
    }
    if (prepPath.includes(code) || !Array.isArray(prep.bom) || prep.bom.length === 0 || number(prep.yieldQuantity) <= 0) {
      block(line, 'Missing BOM', {
        componentType: 'PREP_ITEM', componentCode: code, componentName: prep.name,
        requiredQuantity: converted, unit: outputUnit,
        suggestedAdminAction: `Add a valid non-circular BOM and yield for prep item ${code}.`,
      });
      return;
    }
    const scale = converted / number(prep.yieldQuantity);
    for (const nested of prep.bom) {
      await expandComponent(line, {
        ...nested,
        quantity: number(nested.quantity) * scale,
        unit: nested.uom,
      }, [...prepPath, code]);
    }
  };

  const addOnInventory = async line => {
    let applied = false;
    for (const addOn of line.addOns || []) {
      if (
        addOn.inventoryTrackingStatus !== 'CONFIGURED'
        || !addOn.inventoryItemType
        || !addOn.inventoryItemCode
        || !addOn.consumptionUnit
        || number(addOn.consumptionQuantity) <= 0
      ) continue;
      applied = true;
      await expandComponent(line, {
        componentType: addOn.inventoryItemType,
        componentCode: addOn.inventoryItemCode,
        componentName: addOn.optionName,
        quantity: number(addOn.consumptionQuantity) * Math.max(1, number(addOn.quantity)) * line.quantity,
        unit: addOn.consumptionUnit,
      });
    }
    return applied;
  };

  for (const line of lines) {
    const blockerStart = blockers.length;
    const movementStart = movements.length;
    const item = line.finishedGood;
    if (!item?.code || number(line.quantity) <= 0) {
      block(line, 'Invalid quantity', { suggestedAdminAction: 'Fix the sale line before billing.' });
      continue;
    }
    const assigned = !Array.isArray(item.availableStoreIds)
      || item.availableStoreIds.length === 0
      || item.availableStoreIds.includes(store.id);
    const isCompositeComponent = !!line.component;
    if (
      item.isActive === false
      || (!isCompositeComponent && item.isSellable === false)
      || item.isAvailable === false
      || !assigned
    ) {
      block(line, 'Finished good unavailable', {
        suggestedAdminAction: 'Make the finished good active, sellable, available, and assigned before billing.',
      });
      continue;
    }
    if (noStock(item)) {
      perLineConsumptionStatus[line.lineKey] = await addOnInventory(line) ? 'APPLIED' : 'NOT_REQUIRED';
      continue;
    }
    if (usesBom(item)) {
      const bomMissing = item.bom === undefined || item.bom === null;
      const bomIsArray = Array.isArray(item.bom);
      const missingOrEmptyBom = bomMissing || (bomIsArray && item.bom.length === 0);
      if (!bomMissing && !bomIsArray) {
        block(line, 'Missing prep/raw ingredient reference', {
          suggestedAdminAction: 'Replace the malformed BOM value with a valid recipe array.',
        });
      } else if (missingOrEmptyBom) {
        block(line, 'Missing BOM', { suggestedAdminAction: 'Add a BOM/recipe for this finished good.' });
      } else {
        for (const component of item.bom) {
          if (String(component.componentType).toUpperCase() === 'PACKAGING' && !packagingApplies(component, orderType)) {
            continue;
          }
          await expandComponent(line, {
            ...component,
            quantity: number(component.quantity) * number(line.quantity),
            unit: component.uom,
          });
        }
      }
      if (
        canDefer
        && blockers.length > blockerStart
        && (missingOrEmptyBom || canDeferExpandedBomFailures)
      ) {
        const deferred = blockers.splice(blockerStart);
        movements.splice(movementStart);
        const idempotencyKey = safeDocId(`${store.id}_${orderId}_${line.lineKey}`);
        perLineConsumptionStatus[line.lineKey] = 'PENDING_BOM';
        pending.push({
          idempotencyKey,
          ...inventoryAttribution,
          ...logicalSalesAttribution,
          orderId,
          orderNumber,
          orderLineId: line.lineKey,
          finishedGoodId: item.id || item.code,
          finishedGoodCode: item.code,
          finishedGoodName: item.displayName || item.name,
          quantitySold: number(line.quantity),
          soldAt: admin.firestore.FieldValue.serverTimestamp(),
          source,
          status: 'PENDING_BOM',
          reason: deferred.map(row => row.blockerType).join('; '),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          resolvedAt: null,
          resolvedBy: null,
          appliedBomVersion: null,
          bomSnapshot: Array.isArray(item.bom) ? item.bom : [],
          bomVersionSnapshot: Number.isFinite(Number(item.bomVersion)) ? Number(item.bomVersion) : null,
          inventoryMovementIds: [],
        });
        warn({
          type: 'PENDING_BOM_DEFERRED',
          message: `${item.displayName || item.name}: inventory will be reconciled after BOM completion.`,
          storeId: inventoryStore.id,
          storeName: inventoryStore.name,
          finishedGoodCode: item.code,
          finishedGoodName: item.displayName || item.name,
          unit: 'BOM',
        });
        await addOnInventory(line);
        continue;
      }
      perLineConsumptionStatus[line.lineKey] = 'APPLIED';
      await addOnInventory(line);
      continue;
    }
    if (directStock(item)) {
      await schedule(line, 'FINISHED_GOOD', item.code, item.displayName || item.name, number(line.quantity), 'PCS', {
        createType: 'FINISHED_GOOD',
        defaultUnit: 'PCS',
        defaultCost: item.recipeCost,
      });
      perLineConsumptionStatus[line.lineKey] = 'APPLIED';
      await addOnInventory(line);
      continue;
    }
    perLineConsumptionStatus[line.lineKey] = await addOnInventory(line) ? 'APPLIED' : 'NOT_REQUIRED';
  }

  if (blockers.length > 0) {
    return {
      blockers, warnings, stockUpdates: [], movementPayloads: [], pendingConsumptionPayloads: [],
      totalCogs: 0, perLineCogs: {}, perLineConsumptionStatus: {},
    };
  }

  const grouped = new Map();
  for (const movement of movements) {
    if (!grouped.has(movement.stock.id)) grouped.set(movement.stock.id, []);
    grouped.get(movement.stock.id).push(movement);
  }
  if (shouldRequireAvailableStock(store, requireAvailableStock)) {
    blockers.push(...insufficientStockBlockers(grouped, inventoryStore));
    if (blockers.length > 0) {
      return {
        blockers, warnings, stockUpdates: [], movementPayloads: [], pendingConsumptionPayloads: [],
        totalCogs: 0, perLineCogs: {}, perLineConsumptionStatus: {},
      };
    }
  }
  const stockUpdates = [];
  const movementPayloads = [];
  for (const [id, entries] of grouped.entries()) {
    const row = entries[0].stock;
    let running = row.currentStock;
    for (const entry of entries) {
      const previousQty = running;
      const newQty = round(previousQty - entry.quantity);
      running = newQty;
      const cogsAmount = money(entry.quantity * row.costPerUnit);
      perLineCogs[entry.lineKey] = money((perLineCogs[entry.lineKey] || 0) + cogsAmount);
      if (newQty < 0) {
        warn({
          type: row.exists ? 'NEGATIVE_STOCK' : 'STOCK_ROW_CREATED_NEGATIVE',
          message: `${row.name} moved below zero (${previousQty.toFixed(2)} to ${newQty.toFixed(2)} ${row.unit}).`,
          storeId: inventoryStore.id,
          storeName: inventoryStore.name,
          stockItemType: row.type,
          stockItemCode: row.code,
          stockItemName: row.name,
          finishedGoodCode: entry.finishedGoodCode,
          finishedGoodName: entry.finishedGoodName,
          previousQty,
          newQty,
          unit: row.unit,
        });
      }
      movementPayloads.push({
        ...inventoryAttribution,
        ...logicalSalesAttribution,
        inventoryItemId: row.code,
        inventoryItemName: row.name,
        movementType: 'SALE_DEDUCTION',
        quantity: -entry.quantity,
        quantityDelta: -entry.quantity,
        unit: row.unit,
        referenceType: 'ORDER',
        referenceId: orderId,
        orderId,
        orderNumber,
        businessDate,
        notes: source === 'POS_RAZORPAY'
          ? `Razorpay POS order ${orderNumber}`
          : `Online order ${orderNumber}`,
        createdByUserId: staff.uid,
        createdByName: staff.name,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        stockSystem: 'MENU_MANAGEMENT',
        stockItemType: row.type,
        stockItemCode: row.code,
        previousQty,
        newQty,
        wentNegative: newQty < 0,
        cogsAmount,
        finishedGoodCode: entry.finishedGoodCode,
        finishedGoodName: entry.finishedGoodName,
        source,
        orderLineKey: entry.lineKey,
      });
    }
    stockUpdates.push({
      stockDocId: id,
      ref: row.ref,
      previousQty: row.currentStock,
      newQty: running,
      existed: row.exists,
      seedData: {
        storeId: inventoryStore.id,
        storeCode: inventoryStore.code,
        storeName: inventoryStore.name,
        stockItemType: row.type,
        stockItemCode: row.code,
        stockItemName: row.name,
        uom: row.unit,
        openingStock: 0,
        minimumStock: 0,
        costPerUnit: row.costPerUnit,
      },
    });
  }

  return {
    blockers,
    warnings,
    stockUpdates,
    movementPayloads,
    pendingConsumptionPayloads: pending,
    totalCogs: money(Object.values(perLineCogs).reduce((sum, value) => sum + value, 0)),
    perLineCogs,
    perLineConsumptionStatus,
  };
}

module.exports = {
  convert,
  insufficientStockBlockers,
  inventoryPolicy,
  isGoldenISalesFirstOrderingStore,
  packagingApplies,
  planOnlineOrderInventory,
  shouldRequireAvailableStock,
  uom,
};
