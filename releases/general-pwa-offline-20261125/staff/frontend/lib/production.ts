import { doc, collection, runTransaction, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';
import { PrepItem, StoreStock, PrepProduction } from '../types/menu-management';
import { StockMovement } from '../types';

export async function producePrepItem(
  storeId: string,
  storeName: string,
  prepItem: PrepItem,
  outputQuantity: number,
  notes: string,
  staffId: string,
  staffName: string
): Promise<void> {
  if (!prepItem.bom || prepItem.bom.length === 0) {
    throw new Error('Prep item has no BOM.');
  }
  if (!prepItem.isActive) {
    throw new Error('Prep item is inactive.');
  }

  const scaleFactor = outputQuantity / (prepItem.yieldQuantity || 1);

  await runTransaction(db, async (transaction) => {
    // 1. Read all needed component stock rows
    const componentStockRefs = new Map();
    const componentStocks = new Map();

    for (const line of prepItem.bom!) {
      const legacyId = `${storeId}_${line.componentCode}`;
      const newId = `${storeId}_${line.componentType}_${line.componentCode}`;
      
      const legacyRef = doc(db, 'storeStock', legacyId);
      const newRef = doc(db, 'storeStock', newId);
      
      let stockDoc = await transaction.get(newRef);
      let stockRef = newRef;
      
      if (!stockDoc.exists()) {
         stockDoc = await transaction.get(legacyRef);
         stockRef = legacyRef;
      }
      
      componentStockRefs.set(line.componentCode, stockRef);
      if (stockDoc.exists()) {
        componentStocks.set(line.componentCode, stockDoc.data() as StoreStock);
      }
    }

    // 2. Read output prep item stock (or check existence)
    const legacyOutputId = `${storeId}_${prepItem.code}`;
    const newOutputId = `${storeId}_PREP_ITEM_${prepItem.code}`;
    
    const legacyOutputRef = doc(db, 'storeStock', legacyOutputId);
    const newOutputRef = doc(db, 'storeStock', newOutputId);
    
    let outputStockDoc = await transaction.get(newOutputRef);
    let outputStockRef = newOutputRef;
    
    if (!outputStockDoc.exists()) {
        const legacyDoc = await transaction.get(legacyOutputRef);
        if (legacyDoc.exists()) {
            outputStockDoc = legacyDoc;
            outputStockRef = legacyOutputRef;
        }
    }

    let outputStock: StoreStock | null = null;
    if (outputStockDoc.exists()) {
      outputStock = outputStockDoc.data() as StoreStock;
    }

    // 3. Validation: Check if there's enough stock for all components
    for (const line of prepItem.bom!) {
      const neededQty = line.quantity * scaleFactor;
      const currentStoreStock = componentStocks.get(line.componentCode);
      const availableQty = currentStoreStock?.currentStock || 0;

      if (availableQty < neededQty) {
        throw new Error(`Insufficient ${line.componentName}. Required ${neededQty.toFixed(2)}${line.uom}, available ${availableQty.toFixed(2)}${line.uom}.`);
      }
    }

    // 4. Create references for new documents
    const productionRef = doc(collection(db, 'prepProductions'));
    const productionId = productionRef.id;

    // 5. Writes
    let totalCost = 0;

    // Deduct components
    for (const line of prepItem.bom!) {
      const neededQty = line.quantity * scaleFactor;
      const currentStoreStock = componentStocks.get(line.componentCode)!;
      const stockRef = componentStockRefs.get(line.componentCode)!;

      const newLineCost = line.costPerUnit * neededQty;
      totalCost += newLineCost;

      // Update current stock
      const newCurrentStock = currentStoreStock.currentStock - neededQty;
      transaction.update(stockRef, {
        currentStock: newCurrentStock,
        updatedAt: serverTimestamp(),
      });

      // Write movement for consumption
      const movRef = doc(collection(db, 'stockMovements'));
      const movement: StockMovement = {
        storeId,
        storeName,
        inventoryItemId: line.componentCode,
        inventoryItemName: line.componentName,
        movementType: 'PRODUCTION_CONSUMPTION',
        quantity: -neededQty,
        unit: line.uom,
        referenceType: 'PREP_PRODUCTION',
        referenceId: productionId,
        notes: `Consumed for producing ${outputQuantity}${prepItem.outputUOM} of ${prepItem.name}`,
        createdByUserId: staffId,
        createdByName: staffName,
        createdAt: serverTimestamp(),
        stockSystem: 'MENU_MANAGEMENT',
        stockItemType: line.componentType,
        stockItemCode: line.componentCode
      };
      transaction.set(movRef, movement);
    }

    const calculatedCostPerUnit = totalCost / outputQuantity;

    // Update Output Stock
    if (outputStock) {
      transaction.update(outputStockRef, {
        currentStock: outputStock.currentStock + outputQuantity,
        costPerUnit: prepItem.costPerUnit || calculatedCostPerUnit,
        updatedAt: serverTimestamp(),
      });
    } else {
      transaction.set(outputStockRef, {
        storeId,
        storeName,
        stockItemType: 'PREP_ITEM',
        stockItemCode: prepItem.code,
        stockItemName: prepItem.name,
        uom: prepItem.outputUOM,
        openingStock: 0,
        currentStock: outputQuantity,
        minimumStock: 0,
        costPerUnit: prepItem.costPerUnit || calculatedCostPerUnit,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    // Write movement for production output
    const outputMovRef = doc(collection(db, 'stockMovements'));
    const outputMovement: StockMovement = {
      storeId,
      storeName,
      inventoryItemId: prepItem.code,
      inventoryItemName: prepItem.name,
      movementType: 'PRODUCTION_OUTPUT',
      quantity: outputQuantity,
      unit: prepItem.outputUOM,
      referenceType: 'PREP_PRODUCTION',
      referenceId: productionId,
      notes: notes || `Produced ${outputQuantity}${prepItem.outputUOM} from BOM`,
      createdByUserId: staffId,
      createdByName: staffName,
      createdAt: serverTimestamp(),
      stockSystem: 'MENU_MANAGEMENT',
      stockItemType: 'PREP_ITEM',
      stockItemCode: prepItem.code
    };
    transaction.set(outputMovRef, outputMovement);

    // Write production record
    const prodData: PrepProduction = {
      storeId,
      storeName,
      prepItemCode: prepItem.code,
      prepItemName: prepItem.name,
      outputQuantity,
      outputUOM: prepItem.outputUOM,
      totalCost,
      costPerUnit: calculatedCostPerUnit,
      notes,
      createdByUserId: staffId,
      createdByName: staffName,
      createdAt: serverTimestamp(),
    };
    transaction.set(productionRef, prodData);
  });
}
