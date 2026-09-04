'use strict';

function text(value) {
  return String(value ?? '').trim();
}

function effectiveInventoryStoreId(store) {
  const salesStoreId = text(store?.id);
  if (!salesStoreId) throw new Error('Sales store id is required to resolve inventory.');
  return text(store?.inventoryStoreId) || salesStoreId;
}

function storeIdentity(store, expectedId = '') {
  const id = text(store?.id) || text(expectedId);
  if (!id) throw new Error('Store id is required.');
  const code = text(store?.code || store?.storeCode) || id;
  const name = text(store?.name || store?.displayName) || code;
  return { id, code, name };
}

async function resolveInventoryStore(store, loadStoreById) {
  const salesStore = storeIdentity(store);
  const inventoryStoreId = effectiveInventoryStoreId(store);
  if (inventoryStoreId === salesStore.id) return salesStore;
  if (typeof loadStoreById !== 'function') {
    throw new Error(`Inventory store ${inventoryStoreId} must be loaded for sales store ${salesStore.id}.`);
  }

  const loaded = await loadStoreById(inventoryStoreId);
  if (!loaded) {
    throw new Error(`Inventory store ${inventoryStoreId} configured for sales store ${salesStore.id} does not exist.`);
  }
  const inventoryStore = storeIdentity(loaded, inventoryStoreId);
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
  const identity = storeIdentity(inventoryStore);
  return {
    storeId: identity.id,
    storeCode: identity.code,
    storeName: identity.name,
    inventoryStoreId: identity.id,
  };
}

function logicalSalesStoreAttribution(store) {
  const identity = storeIdentity(store);
  return {
    logicalSalesStoreId: identity.id,
    logicalSalesStoreCode: identity.code,
    logicalSalesStoreName: identity.name,
  };
}

module.exports = {
  effectiveInventoryStoreId,
  inventoryStoreAttribution,
  logicalSalesStoreAttribution,
  resolveInventoryStore,
  storeIdentity,
};
