export type GstMode = 'NO_GST' | 'ITEM_WISE' | 'STORE_WIDE';
export type GstTreatment = { mode: GstMode; rate: number | null; revision: number };

export function gstSourceStore<T extends { id: string; legalAndGstSourceStoreId?: string }>(store: T | null | undefined, stores: T[]): T | null {
  if (!store) return null;
  if (!store.legalAndGstSourceStoreId || store.legalAndGstSourceStoreId === store.id) return store;
  const source = stores.find(value => value.id === store.legalAndGstSourceStoreId);
  if (!source || (source.legalAndGstSourceStoreId && source.legalAndGstSourceStoreId !== source.id)) throw new Error('Store legal/GST source is unavailable.');
  return source;
}

export function storeGstTreatment(store: { gstTreatment?: GstTreatment } | null | undefined): GstTreatment {
  const value = store?.gstTreatment;
  if (!value) return { mode: 'ITEM_WISE', rate: null, revision: 0 };
  if (!['NO_GST', 'ITEM_WISE', 'STORE_WIDE'].includes(value.mode) || !Number.isSafeInteger(value.revision) || value.revision < 1
    || (value.mode === 'STORE_WIDE' && (typeof value.rate !== 'number' || !Number.isFinite(value.rate) || value.rate <= 0 || value.rate > 100))
    || (value.mode !== 'STORE_WIDE' && value.rate !== null)) throw new Error('Store GST settings require Admin review.');
  return { mode: value.mode, rate: value.rate, revision: value.revision };
}
export function effectiveStoreGstRate(store: { gstTreatment?: GstTreatment } | null | undefined, legacyRate: number): number {
  const config = storeGstTreatment(store);
  return config.mode === 'NO_GST' ? 0 : config.mode === 'STORE_WIDE' ? config.rate! : legacyRate;
}
