export type InventoryStoreLike = {
  id: string;
  code?: string;
  storeCode?: string;
  name?: string;
  displayName?: string;
  inventoryStoreId?: string | null;
};

export type InventoryStoreIdentity = {
  id: string;
  code: string;
  name: string;
};

function text(value: unknown): string {
  return String(value ?? '').trim();
}

export function effectiveInventoryStoreId(store: InventoryStoreLike): string {
  const salesStoreId = text(store?.id);
  if (!salesStoreId) throw new Error('Sales store id is required to resolve inventory.');
  return text(store.inventoryStoreId) || salesStoreId;
}

export function inventoryStoreIdentity(store: InventoryStoreLike, expectedId = ''): InventoryStoreIdentity {
  const id = text(store?.id) || text(expectedId);
  if (!id) throw new Error('Store id is required.');
  const code = text(store.code || store.storeCode) || id;
  const name = text(store.name || store.displayName) || code;
  return { id, code, name };
}

export async function resolveInventoryStore(
  store: InventoryStoreLike,
  loadStoreById: (storeId: string) => Promise<InventoryStoreLike | null>,
): Promise<InventoryStoreIdentity> {
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

export function inventoryStoreAttribution(inventoryStore: InventoryStoreLike) {
  const identity = inventoryStoreIdentity(inventoryStore);
  return {
    storeId: identity.id,
    storeCode: identity.code,
    storeName: identity.name,
    inventoryStoreId: identity.id,
  };
}

export function logicalSalesStoreAttribution(store: InventoryStoreLike) {
  const identity = inventoryStoreIdentity(store);
  return {
    logicalSalesStoreId: identity.id,
    logicalSalesStoreCode: identity.code,
    logicalSalesStoreName: identity.name,
  };
}
