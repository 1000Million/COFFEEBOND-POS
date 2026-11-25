import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { assignedStoreIds, DETAIL_MAX_DAYS, SUMMARY_MAX_DAYS } from '../../functions/reportingCore.mjs';
import { loadActiveReportStoreRecords } from '../data/stores/storeRepository';
import { db } from './firebase';
import type { StaffProfile, Store } from '../types';
import { EMPTY_FILTERS, reportingAccessKey, reportingParams, reportingRangeError, reportingToday } from './reportingUi';
import { reportingErrorMessage, type ReportDefinition, type ReportingRequest } from './reporting';

export function useReportingScope(profile: StaffProfile, definition: ReportDefinition) {
  const [params, setParams] = useSearchParams();
  const [stores, setStores] = useState<Store[]>([]);
  const [storesReady, setStoresReady] = useState(false);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [storeRetry, setStoreRetry] = useState(0);
  const accessKey = reportingAccessKey(profile);
  const today = reportingToday();
  const cashier = profile.role === 'CASHIER';
  useEffect(() => {
    let active = true;
    setStores([]); setStoresReady(false); setStoreError(null);
    loadActiveReportStoreRecords(db, profile.role === 'ADMIN' ? undefined : assignedStoreIds(profile))
      .then(data => { if (active) { setStores(data); setStoresReady(true); } })
      .catch(error => { if (active) setStoreError(reportingErrorMessage(error)); });
    return () => { active = false; };
  }, [accessKey, storeRetry]);
  const defaultStore = profile.role === 'ADMIN' ? 'ALL' : stores[0]?.id || '';
  const storeId = cashier ? defaultStore : params.get('storeId') || defaultStore;
  const startDate = cashier ? today : params.get('startDate') || today;
  const endDate = cashier ? today : params.get('endDate') || today;
  const filters = Object.fromEntries(Object.entries(EMPTY_FILTERS).map(([key, value]) => [key, params.get(key) || value])) as typeof EMPTY_FILTERS;
  const page = Math.max(1, Math.floor(Number(params.get('page')) || 1));
  const rangeError = reportingRangeError(startDate, endDate, definition.reportId === 'gst-report' ? Infinity : definition.detailReport ? DETAIL_MAX_DAYS : SUMMARY_MAX_DAYS);
  const scopeError = storeError || rangeError || (storesReady && (!stores.length ? 'No active assigned stores are available.' : storeId !== 'ALL' && !stores.some(s => s.id === storeId) ? 'This store is not available to your account. Select an accessible store.' : null));
  const request = useMemo<ReportingRequest>(() => ({ reportId: definition.reportId, storeIds: storeId === 'ALL' ? [] : [storeId], startDate, endDate, filters, page, pageSize: 50 }), [definition.reportId, storeId, startDate, endDate, JSON.stringify(filters), page]);
  const normalized = reportingParams(request, params);
  const update = (changes: Record<string, string | null>, resetPage = true) => {
    const next = new URLSearchParams(normalized);
    if (resetPage) { next.delete('page'); next.delete('bill'); }
    for (const [key, value] of Object.entries(changes)) { if (value === null || value === 'ALL' && key !== 'storeId') next.delete(key); else next.set(key, value); }
    setParams(next, { replace: true });
  };
  const reset = () => setParams({ storeId: defaultStore, startDate: today, endDate: today }, { replace: true });
  const urlFor = (path: string) => `${path}?${normalized}`;
  const storeLabel = storeId === 'ALL' ? 'All accessible stores' : stores.find(s => s.id === storeId)?.name || 'Select a store';
  return { params: normalized, update, reset, urlFor, request, stores, storeId, storeLabel, startDate, endDate, filters, cashier, today, page, scopeError, canQuery: storesReady && !scopeError && Boolean(storeId), retryStores: () => setStoreRetry(n => n + 1) };
}

// Results are keyed before render, so old rows cannot flash under a new store/account/filter.
export function useReportingResult<T>(key: string, enabled: boolean, load: () => Promise<T>) {
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>({ key: '' });
  const generation = `${key}:${refresh}`;
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setState({ key: generation });
    load().then(data => { if (active) setState({ key: generation, data }); }).catch(error => { if (active) setState({ key: generation, error: reportingErrorMessage(error) }); });
    return () => { active = false; };
  }, [generation, enabled]);
  const current = enabled && state.key === generation ? state : null;
  return { data: current?.data, error: current?.error, loading: enabled && !current?.data && !current?.error, refresh: () => setRefresh(n => n + 1), generation };
}
