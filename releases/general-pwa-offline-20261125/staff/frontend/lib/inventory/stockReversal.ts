// Shared existing void-reversal payload and identity. Adapters own transaction reads/writes.
export function deterministicVoidReversalMovementId(originalMovementId:string):string {
  return (String(`${originalMovementId}_VOID_REVERSAL`).trim().replace(/[^A-Za-z0-9_-]/g,'_').replace(/_+/g,'_').replace(/^_+|_+$/g,'')||'ID').slice(0,480);
}

/** One physical balance update, with a chained audit row per original movement. */
export function planVoidStockBalances(rows: Array<{ stockKey: string; currentStock: number; reversalQuantity: number }>) {
  const initial = new Map<string, number>();
  const balances = new Map<string, number>();
  const steps = rows.map(row => {
    if (!row.stockKey || !Number.isFinite(row.currentStock) || !Number.isFinite(row.reversalQuantity) || row.reversalQuantity <= 0) {
      throw new Error('Cannot reverse stock; stock balance or reversal quantity is invalid.');
    }
    if (initial.has(row.stockKey) && initial.get(row.stockKey) !== row.currentStock) {
      throw new Error('Cannot reverse stock; repeated stock snapshots disagree.');
    }
    initial.set(row.stockKey, row.currentStock);
    const stockBefore = balances.get(row.stockKey) ?? row.currentStock;
    const stockAfter = Math.round((stockBefore + row.reversalQuantity) * 10000) / 10000;
    if (!Number.isFinite(stockAfter)) throw new Error('Cannot reverse stock; resulting balance is invalid.');
    balances.set(row.stockKey, stockAfter);
    return { stockKey: row.stockKey, stockBefore, stockAfter };
  });
  return { steps, stockBalances: [...balances].map(([stockKey, currentStock]) => ({ stockKey, currentStock })) };
}
export function buildVoidStockReversal({movement,order,store,inventoryStore,currentStock,staffUid,staffName,reason,timestamp}:any) {
 const stockItemType=String(movement.stockItemType||'RAW_INGREDIENT');
 const stockItemCode=String(movement.stockItemCode||movement.inventoryItemId||'');
 const reversalQuantity=Math.abs(Number(movement.quantity)||0),stockBefore=Number(currentStock);
 if(!stockItemCode||!Number.isFinite(stockBefore))throw Error('Cannot reverse stock; stock details are missing.');
 const stockAfter=Math.round((stockBefore+reversalQuantity)*10000)/10000;
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
            movementType: 'ORDER_VOID_REVERSAL',
            reason: 'ORDER_VOID_REVERSAL',
            quantity: reversalQuantity,
            quantityDelta: reversalQuantity,
            unit: movement.unit || '',
            referenceType: 'ORDER',
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
            stockSystem: movement.stockSystem || 'MENU_MANAGEMENT',
            stockItemType: stockItemType,
            stockItemCode: stockItemCode,
            previousQty: stockBefore,
            newQty: stockAfter,
            stockBefore,
            stockAfter,
            balanceBefore: stockBefore,
            balanceAfter: stockAfter,
          };
}
