import React, { useState, useEffect } from 'react';
import { collection, query, getDocs, doc, setDoc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { db } from './firebase';
import { StoreStock, RawIngredient } from '../types/menu-management';
import { Store } from '../types';

export async function createMissingStockRows(storeId: string, storeName: string, staffId: string, staffName: string, target: 'RAW_INGREDIENTS' | 'PREP_ITEMS' | 'FINISHED_GOODS' | 'ALL' = 'RAW_INGREDIENTS'): Promise<number> {
  const stockItemsToCreate: { type: string, code: string, name: string, uom: string, cost: number }[] = [];

  if (target === 'RAW_INGREDIENTS' || target === 'ALL') {
    const rawQuery = query(collection(db, 'rawIngredients'));
    const rawSnap = await getDocs(rawQuery);
    rawSnap.docs.forEach(doc => {
      const data = doc.data() as RawIngredient;
      if (data.isActive) {
        const type = data.category.toUpperCase().includes('PACKAGING') ? 'PACKAGING' : 'RAW_INGREDIENT';
        stockItemsToCreate.push({ type, code: data.code, name: data.name, uom: data.usageUOM, cost: data.costPerUsageUnit || 0 });
      }
    });
  }

  if (target === 'PREP_ITEMS' || target === 'ALL') {
    const prepQuery = query(collection(db, 'prepItems'));
    const prepSnap = await getDocs(prepQuery);
    prepSnap.docs.forEach(doc => {
      const data = doc.data() as any;
      if (data.isActive) {
        stockItemsToCreate.push({ type: 'PREP_ITEM', code: data.code, name: data.name, uom: data.yieldUOM || data.outputUOM, cost: data.costPerUnit || 0 });
      }
    });
  }

  if (target === 'FINISHED_GOODS' || target === 'ALL') {
    const fgQuery = query(collection(db, 'finishedGoods'));
    const fgSnap = await getDocs(fgQuery);
    fgSnap.docs.forEach(doc => {
      const data = doc.data() as any;
      if (data.isActive && data.itemType === 'DIRECT_STOCK') {
        stockItemsToCreate.push({ type: 'FINISHED_GOOD', code: data.code, name: data.name, uom: 'pcs', cost: data.recipeCost || 0 });
      }
    });
  }

  // Fetch current store stock
  const stockQuery = query(collection(db, 'storeStock'));
  const stockSnap = await getDocs(stockQuery);
  const existingStockIds = new Set(
    stockSnap.docs
      .map(doc => doc.data() as StoreStock)
      .filter(ss => ss.storeId === storeId)
      .map(ss => `${ss.stockItemType}_${ss.stockItemCode}`)
  );

  let newRowsCount = 0;
  let batch = writeBatch(db);
  let operationCount = 0;

  for (const item of stockItemsToCreate) {
    const idKey = `${item.type}_${item.code}`;
    if (!existingStockIds.has(idKey)) {
      const stockId = `${storeId}_${item.type}_${item.code}`;
      const stockRef = doc(db, 'storeStock', stockId);
      batch.set(stockRef, {
        storeId,
        storeName,
        stockItemType: item.type,
        stockItemCode: item.code,
        stockItemName: item.name,
        uom: item.uom,
        openingStock: 0,
        currentStock: 0,
        minimumStock: 0,
        costPerUnit: item.cost,
        updatedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
      });
      newRowsCount++;
      operationCount++;

      if (operationCount >= 400) {
        await batch.commit();
        batch = writeBatch(db);
        operationCount = 0;
      }
    }
  }

  if (operationCount > 0) {
    await batch.commit();
  }

  return newRowsCount;
}

export async function submitStockMovement(
  storeId: string,
  storeName: string,
  stockItem: StoreStock,
  movementType: 'PURCHASE' | 'WASTAGE' | 'ADJUSTMENT' | 'OPENING_STOCK',
  quantity: number, // always positive from UI, we negate it here if needed
  notes: string,
  staffId: string,
  staffName: string,
  newMinimumStock?: number
): Promise<void> {
  const batch = writeBatch(db);
  const stockId = stockItem.id || `${storeId}_${stockItem.stockItemType || 'RAW_INGREDIENT'}_${stockItem.stockItemCode}`;
  const stockRef = doc(db, 'storeStock', stockId);

  let actualStockChange = 0;
  if (movementType === 'PURCHASE') actualStockChange = quantity;
  else if (movementType === 'WASTAGE') actualStockChange = -Math.abs(quantity);
  else if (movementType === 'OPENING_STOCK') actualStockChange = quantity; // We just add
  else if (movementType === 'ADJUSTMENT') actualStockChange = quantity; // can be negative or positive

  const newCurrentStock = stockItem.currentStock + actualStockChange;
  
  // prepare stock update
  const stockUpdate: Partial<StoreStock> = {
    currentStock: newCurrentStock,
    updatedAt: serverTimestamp(),
  };

  if (movementType === 'OPENING_STOCK') {
    stockUpdate.openingStock = (stockItem.openingStock || 0) + quantity;
  }
  
  if (newMinimumStock !== undefined) {
    stockUpdate.minimumStock = newMinimumStock;
  }

  batch.set(stockRef, stockUpdate, { merge: true });

  // record movement
  const movRef = doc(collection(db, 'stockMovements'));
  batch.set(movRef, {
    storeId,
    storeName,
    inventoryItemId: stockItem.stockItemCode,
    inventoryItemName: stockItem.stockItemName,
    movementType,
    quantity: actualStockChange,
    unit: stockItem.uom,
    referenceType: 'MANUAL',
    referenceId: null,
    notes,
    createdByUserId: staffId,
    createdByName: staffName,
    createdAt: serverTimestamp(),
    stockSystem: 'MENU_MANAGEMENT',
    stockItemType: stockItem.stockItemType || 'RAW_INGREDIENT',
    stockItemCode: stockItem.stockItemCode
  });

  await batch.commit();
}
