'use strict';

const { HttpsError } = require('firebase-functions/v2/https');
const MODES = ['NO_GST', 'ITEM_WISE', 'STORE_WIDE'];
function treatment(store = {}) {
  const value = store.gstTreatment;
  if (value == null) return { mode: 'ITEM_WISE', rate: null, revision: 0 };
  if (!MODES.includes(value.mode) || !Number.isSafeInteger(value.revision) || value.revision < 1
    || (value.mode === 'STORE_WIDE' && (typeof value.rate !== 'number' || !Number.isFinite(value.rate) || value.rate <= 0 || value.rate > 100))
    || (value.mode !== 'STORE_WIDE' && value.rate !== null)) {
    throw new HttpsError('failed-precondition', 'Store GST settings require Admin review.');
  }
  return { mode: value.mode, rate: value.rate, revision: value.revision };
}
function effectiveRate(store, legacyRate) {
  const config = treatment(store);
  return config.mode === 'NO_GST' ? 0 : config.mode === 'STORE_WIDE' ? config.rate : legacyRate;
}
function assertRevision(store, expectedRevision) {
  const config = treatment(store);
  if (config.revision > 0 && expectedRevision !== config.revision) throw new HttpsError('failed-precondition', 'Store GST changed. Review the basket before starting a new payment.');
}
function legalDetails(store) {
  const source = store.gstLegalDetails || store;
  const clean = value => String(value || '').trim() || null;
  return { legalName: clean(source.legalName), tradeName: clean(source.tradeName), legalAddress: clean(source.legalAddress), gstin: clean(source.gstin), stateName: clean(source.stateName), stateCode: clean(source.stateCode), gstRegistered: source.gstRegistered === true };
}
async function resolveGstStore(store, loadStore) {
  const sourceId = store.legalAndGstSourceStoreId;
  if (!sourceId || sourceId === store.id) return store;
  if (typeof sourceId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(sourceId)) throw new HttpsError('failed-precondition', 'Store legal/GST source requires Admin review.');
  const source = await loadStore(sourceId);
  if (!source || (source.legalAndGstSourceStoreId && source.legalAndGstSourceStoreId !== source.id)) throw new HttpsError('failed-precondition', 'Store legal/GST source is unavailable or chained.');
  const result = { ...store, gstTreatment: source.gstTreatment, gstSourceStoreId: source.id, gstSourceStoreCode: source.code, gstLegalDetails: legalDetails(source) };
  for (const key of ['gstRate', 'taxRate', 'defaultGstRate', 'defaultTaxRate', 'gstPercent', 'taxPercent']) {
    delete result[key];
    if (Object.hasOwn(source, key)) result[key] = source[key];
  }
  return result;
}
module.exports = { MODES, treatment, effectiveRate, assertRevision, legalDetails, resolveGstStore };
