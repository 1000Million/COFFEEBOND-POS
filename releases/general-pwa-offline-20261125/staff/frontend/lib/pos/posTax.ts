import { gstSourceStore, storeGstTreatment, type GstMode, type GstTreatment } from '../storeGstTreatment';
import type { Store } from '../../types';

type ReceiptOrderSnapshot = { gstTreatmentSnapshot?: GstTreatment; gstTotal: number; receiptLegalDetails?: { gstRegistered?: boolean; stateCode?: string | null } | null };

export type TaxConfig = {
  rate: number;
  source: string;
  mode?: GstMode;
};

export type AppGstConfig = {
  defaultRate: number;
  defaultSource: string;
  storeOverrides: Record<string, number>;
};

export const GST_CONFIG_DOC_ID = 'gstConfig';

export const APP_TAX_RATE_KEYS = ['defaultGstRate', 'gstRate', 'taxRate', 'defaultTaxRate', 'defaultGSTPercent', 'gstPercent', 'taxPercent'];

export const STORE_TAX_RATE_KEYS = ['gstRate', 'taxRate', 'defaultGstRate', 'defaultTaxRate', 'gstPercent', 'taxPercent'];

export const ITEM_TAX_RATE_KEYS = ['taxRate', 'gstRate', 'taxPercent', 'gstPercent'];

export function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeTaxRate(value: unknown): number {
  const parsed = toFiniteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : 0;
}

export function pickTaxConfig(data: Record<string, unknown>, source: string, keys = APP_TAX_RATE_KEYS): TaxConfig | null {
  for (const key of keys) {
    const rate = normalizeTaxRate(data[key]);
    if (rate > 0) return { rate, source: `${source}.${key}` };
  }
  return null;
}

export function normalizeStoreOverrides(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, number>>((acc, [key, rate]) => {
    const normalizedRate = normalizeTaxRate(rate);
    if (normalizedRate > 0) acc[key] = normalizedRate;
    return acc;
  }, {});
}

export function pickItemTaxRate(item: Record<string, unknown>): number {
  const picked = pickTaxConfig(item, 'item', ITEM_TAX_RATE_KEYS);
  return picked?.rate || 0;
}

export function getItemTaxRate(item: { taxRate?: number | null }, fallbackTaxRate: number | TaxConfig): number {
  if (typeof fallbackTaxRate === 'object') {
    if (fallbackTaxRate.mode === 'NO_GST') return 0;
    if (fallbackTaxRate.mode === 'STORE_WIDE') return fallbackTaxRate.rate;
    return getItemTaxRate(item, fallbackTaxRate.rate);
  }
  const itemTax = normalizeTaxRate(item.taxRate);
  return itemTax > 0 ? itemTax : fallbackTaxRate;
}

export function receiptGstSplit(order: ReceiptOrderSnapshot): { cgst: number; sgst: number } | null {
  if (order.gstTreatmentSnapshot?.mode === 'NO_GST' || !order.receiptLegalDetails?.gstRegistered || !order.receiptLegalDetails.stateCode || order.gstTotal <= 0) {
    return null;
  }
  const half = Math.round((order.gstTotal / 2) * 100) / 100;
  return {
    cgst: half,
    sgst: Math.round((order.gstTotal - half) * 100) / 100,
  };
}

export function resolveStoreTaxConfig(stores: Store[], selectedStoreId: string, appGstConfig: AppGstConfig): TaxConfig {
    const selectedStore = gstSourceStore(stores.find(s => s.id === selectedStoreId), stores);
    const treatment = storeGstTreatment(selectedStore);
    if (treatment.mode !== 'ITEM_WISE') return { mode: treatment.mode, rate: treatment.mode === 'NO_GST' ? 0 : treatment.rate!, source: `stores/${selectedStoreId}.gstTreatment` };

    const configuredStoreOverride = selectedStore
      ? appGstConfig.storeOverrides[selectedStore.id] || appGstConfig.storeOverrides[selectedStore.code]
      : 0;
    if (configuredStoreOverride > 0 && selectedStore) {
      return {
        rate: configuredStoreOverride,
        source: `appSettings/${GST_CONFIG_DOC_ID}.storeOverrides.${selectedStore.code}`,
      };
    }

    const storeTaxConfig = selectedStore
      ? pickTaxConfig(selectedStore as unknown as Record<string, unknown>, `stores/${selectedStore.id}`, STORE_TAX_RATE_KEYS)
      : null;
    if (storeTaxConfig) return storeTaxConfig;

    return {
      rate: appGstConfig.defaultRate,
      source: appGstConfig.defaultSource,
    };
  }
