'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');

const PROJECT_ID = 'coffee-bond-pos';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_STORES = 25;
const MAX_SUMMARY_ORDERS = 10000;
const MAX_DETAIL_ORDERS = 2500;
const SUMMARY_CACHE_TTL_MS = 60 * 1000;
const summaryCache = new Map();

function fail(code, message) {
  throw new HttpsError(code, message);
}

function cleanText(value, maxLength = 120) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function uniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry) => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean))];
}

function isActiveProfile(profile) {
  return profile?.isActive === true;
}

async function loadProfile(db, uid) {
  if (!uid) fail('unauthenticated', 'Sign in is required.');
  const snapshot = await db.collection('users').doc(uid).get();
  if (!snapshot.exists) fail('permission-denied', 'An active staff profile is required.');
  const profile = { uid: snapshot.id, ...snapshot.data() };
  if (!isActiveProfile(profile)) fail('permission-denied', 'This staff profile is inactive.');
  return profile;
}

function timeZoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  ) - date.getTime();
}

function zonedMidnight(year, month, day, timeZone) {
  const utcGuess = Date.UTC(year, month - 1, day);
  let result = new Date(utcGuess - timeZoneOffsetMs(new Date(utcGuess), timeZone));
  result = new Date(utcGuess - timeZoneOffsetMs(result, timeZone));
  return result;
}

function parseDate(value, fieldName) {
  const date = cleanText(value, 10);
  if (!DATE_PATTERN.test(date)) fail('invalid-argument', `${fieldName} must use YYYY-MM-DD.`);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    fail('invalid-argument', `${fieldName} is invalid.`);
  }
  return date;
}

function dateRange(startDate, endDate, timeZone) {
  const startIso = parseDate(startDate, 'Start date');
  const endIso = parseDate(endDate, 'End date');
  if (endIso < startIso) fail('invalid-argument', 'End date must be on or after start date.');
  const [startYear, startMonth, startDay] = startIso.split('-').map(Number);
  const [endYear, endMonth, endDay] = endIso.split('-').map(Number);
  const start = zonedMidnight(startYear, startMonth, startDay, timeZone);
  const nextDate = new Date(Date.UTC(endYear, endMonth - 1, endDay + 1));
  const end = zonedMidnight(
    nextDate.getUTCFullYear(),
    nextDate.getUTCMonth() + 1,
    nextDate.getUTCDate(),
    timeZone,
  );
  const days = Math.round((Date.parse(`${endIso}T00:00:00Z`) - Date.parse(`${startIso}T00:00:00Z`)) / 86400000) + 1;
  return { startIso, endIso, start, end, days };
}

function todayInTimeZone(timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function reportingCore() {
  return import('./reportingCore.mjs');
}

async function loadAccessibleStores(db, profile, requestedStoreIds) {
  const core = await reportingCore();
  const role = String(profile.role || '');
  if (!['ADMIN', 'STORE_MANAGER', 'CASHIER'].includes(role)) {
    fail('permission-denied', 'This role cannot access the internal Reporting Centre.');
  }
  let snapshots;
  if (role === 'ADMIN') {
    const activeSnapshot = await db.collection('stores').where('isActive', '==', true).get();
    snapshots = activeSnapshot.docs;
  } else {
    const assigned = core.assignedStoreIds(profile);
    if (assigned.length === 0) fail('permission-denied', 'No stores are assigned to this staff profile.');
    snapshots = await db.getAll(...assigned.map((storeId) => db.collection('stores').doc(storeId)));
    snapshots = snapshots.filter((snapshot) => snapshot.exists && snapshot.data()?.isActive === true);
  }

  const available = snapshots.map((snapshot) => ({
    id: snapshot.id,
    code: cleanText(snapshot.data()?.code || snapshot.id, 80),
    name: cleanText(snapshot.data()?.name || snapshot.id, 120),
    timezone: cleanText(snapshot.data()?.timezone || core.REPORT_TIME_ZONE, 80),
    legalName: cleanText(snapshot.data()?.legalName, 160),
    tradeName: cleanText(snapshot.data()?.tradeName, 160),
    gstin: cleanText(snapshot.data()?.gstin, 30),
    gstRegistered: snapshot.data()?.gstRegistered === true,
  }));
  const allowedIds = new Set(available.map((store) => store.id));
  const selected = requestedStoreIds.length > 0 ? requestedStoreIds : available.map((store) => store.id);
  if (selected.length === 0) fail('failed-precondition', 'No active stores are available.');
  if (selected.length > MAX_STORES) fail('invalid-argument', 'Too many stores were selected.');
  if (!selected.every((storeId) => allowedIds.has(storeId))) {
    fail('permission-denied', 'One or more selected stores are outside your assigned access.');
  }
  return {
    selected,
    stores: available.filter((store) => selected.includes(store.id)),
    accessibleStores: available,
  };
}

function normalizedFilters(data, storeIds) {
  const pick = (key, maxLength = 100) => {
    const value = cleanText(data?.filters?.[key], maxLength);
    return value && value !== 'ALL' ? value : 'ALL';
  };
  return {
    storeIds,
    source: pick('source'),
    orderType: pick('orderType'),
    paymentMethod: pick('paymentMethod'),
    staffName: pick('staffName'),
    category: pick('category'),
    itemCode: pick('itemCode'),
    orderStatus: pick('orderStatus'),
    commercialStatus: pick('commercialStatus'),
  };
}

async function authorizeRequest(db, request, mode) {
  if (db.app?.options?.projectId && db.app.options.projectId !== PROJECT_ID) {
    fail('failed-precondition', 'Reporting is configured for the Coffee Bond production project only.');
  }
  const core = await reportingCore();
  const profile = await loadProfile(db, request.auth?.uid);
  const reportId = cleanText(request.data?.reportId, 100);
  const definition = core.reportDefinition(reportId);
  if (!definition) fail('invalid-argument', 'Unknown report.');
  if (!core.roleCanAccessReport(profile.role, reportId)) {
    fail('permission-denied', 'This report is not available to your role.');
  }

  const requestedStoreIds = uniqueStrings(request.data?.storeIds);
  const storeAccess = await loadAccessibleStores(db, profile, requestedStoreIds);
  const timeZones = [...new Set(storeAccess.stores.map((store) => store.timezone))];
  if (timeZones.length !== 1) {
    fail('failed-precondition', 'Select stores that use the same configured business timezone.');
  }
  const timeZone = timeZones[0] || core.REPORT_TIME_ZONE;
  const range = dateRange(request.data?.startDate, request.data?.endDate, timeZone);
  const maxDays = definition.detailReport ? core.DETAIL_MAX_DAYS : core.SUMMARY_MAX_DAYS;
  if (range.days > maxDays) {
    fail('invalid-argument', `${definition.detailReport ? 'Detailed' : 'Summary'} reports support at most ${maxDays} days.`);
  }
  if (profile.role === 'CASHIER') {
    const today = todayInTimeZone(timeZone);
    if (range.startIso !== today || range.endIso !== today) {
      fail('permission-denied', 'Cashier reports are limited to today.');
    }
    if (storeAccess.selected.length !== 1) {
      fail('permission-denied', 'Cashier reports are limited to one assigned store.');
    }
    if (mode === 'export' && definition.detailReport) {
      fail('permission-denied', 'Cashiers cannot export detailed customer or order reports.');
    }
  }

  return {
    profile,
    definition,
    reportId,
    range,
    timeZone,
    ...storeAccess,
    filters: normalizedFilters(request.data, storeAccess.selected),
  };
}

async function runInBatches(values, batchSize, mapper) {
  const output = [];
  for (let index = 0; index < values.length; index += batchSize) {
    const batch = values.slice(index, index + batchSize);
    output.push(...await Promise.all(batch.map(mapper)));
  }
  return output;
}

async function loadOrderRecords(admin, db, context) {
  const maxOrders = context.definition.detailReport ? MAX_DETAIL_ORDERS : MAX_SUMMARY_ORDERS;
  const snapshots = await Promise.all(context.selected.map((storeId) => (
    db.collection('orders')
      .where('storeId', '==', storeId)
      .where('createdAt', '>=', Timestamp.fromDate(context.range.start))
      .where('createdAt', '<', Timestamp.fromDate(context.range.end))
      .orderBy('createdAt', 'asc')
      .limit(maxOrders + 1)
      .get()
  )));
  const orders = snapshots.flatMap((snapshot) => snapshot.docs.map((orderDoc) => ({
    id: orderDoc.id,
    ...orderDoc.data(),
  })));
  if (orders.length > maxOrders) {
    fail('resource-exhausted', `This report exceeds ${maxOrders} orders. Narrow the date or store filter.`);
  }
  return runInBatches(orders, 25, async (order) => {
    const orderRef = db.collection('orders').doc(order.id);
    const [itemsSnapshot, paymentsSnapshot] = await Promise.all([
      orderRef.collection('items').get(),
      orderRef.collection('payments').get(),
    ]);
    return {
      order,
      items: itemsSnapshot.docs.map((itemDoc) => ({ id: itemDoc.id, ...itemDoc.data() })),
      payments: paymentsSnapshot.docs.map((paymentDoc) => ({ id: paymentDoc.id, ...paymentDoc.data() })),
    };
  });
}

async function loadOnlineOrders(admin, db, context) {
  if (!['online-order', 'customer-order', 'payment-collection', 'refund-reversal'].includes(context.reportId)) return [];
  const snapshots = await Promise.all(context.selected.map((storeId) => (
    db.collection('onlineOrders')
      .where('storeId', '==', storeId)
      .where('createdAt', '>=', Timestamp.fromDate(context.range.start))
      .where('createdAt', '<', Timestamp.fromDate(context.range.end))
      .orderBy('createdAt', 'asc')
      .limit(MAX_DETAIL_ORDERS + 1)
      .get()
  )));
  const rows = snapshots.flatMap((snapshot) => snapshot.docs.map((orderDoc) => ({
    id: orderDoc.id,
    ...orderDoc.data(),
  })));
  if (rows.length > MAX_DETAIL_ORDERS) {
    fail('resource-exhausted', `This report exceeds ${MAX_DETAIL_ORDERS} online orders. Narrow the date or store filter.`);
  }
  return rows;
}

function filterOptions(normalizedRecords) {
  const unique = (values) => [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
  return {
    sources: unique(normalizedRecords.map((record) => record.source)),
    orderTypes: unique(normalizedRecords.map((record) => record.orderType)),
    paymentMethods: unique(normalizedRecords.flatMap((record) => record.paymentMethods)),
    staff: unique(normalizedRecords.map((record) => record.staffName)),
    categories: unique(normalizedRecords.flatMap((record) => record.items.map((item) => item.categoryName))),
    items: [...new Map(normalizedRecords.flatMap((record) => record.items.map((item) => [
      item.itemCode,
      { code: item.itemCode, name: item.itemName },
    ]))).values()].sort((left, right) => left.name.localeCompare(right.name)),
  };
}

async function buildData(admin, db, context) {
  const core = await reportingCore();
  const [records, onlineOrders] = await Promise.all([
    loadOrderRecords(admin, db, context),
    loadOnlineOrders(admin, db, context),
  ]);
  const dataset = core.buildReportDataset(context.reportId, records, {
    filters: context.filters,
    timeZone: context.timeZone,
    onlineOrders,
    storeLegalDetails: Object.fromEntries(context.stores.map((store) => [store.id, {
      legalName: store.legalName,
      tradeName: store.tradeName,
      gstin: store.gstin,
      gstRegistered: store.gstRegistered,
    }])),
  });
  return {
    dataset,
    options: filterOptions(core.normalizeRecords(records)),
    sourceOrderCount: records.length,
  };
}

async function appendAccessAudit(admin, db, context, mode, rowCount) {
  try {
    await db.collection('reportAccessAudit').add({
      reportId: context.reportId,
      mode,
      actorUid: context.profile.uid,
      actorRole: context.profile.role,
      storeIds: context.selected,
      startDate: context.range.startIso,
      endDate: context.range.endIso,
      rowCount,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.error('report-access-audit-failed', {
      reportId: context.reportId,
      actorUid: context.profile.uid,
      code: error?.code || 'unknown',
      message: cleanText(error?.message, 160),
    });
  }
}

function baseResponse(context, data) {
  return {
    report: data.dataset.definition,
    summary: data.dataset.summary,
    availabilityStatus: data.dataset.availabilityStatus,
    unavailableReason: data.dataset.unavailableReason,
    columns: data.dataset.columns,
    accessibleStores: context.accessibleStores.map((store) => ({
      id: store.id,
      code: store.code,
      name: store.name,
    })),
    selectedStoreIds: context.selected,
    startDate: context.range.startIso,
    endDate: context.range.endIso,
    timeZone: context.timeZone,
    filters: context.filters,
    filterOptions: data.options,
    sourceOrderCount: data.sourceOrderCount,
    generatedAt: new Date().toISOString(),
  };
}

function errorResponse(error, context, operation) {
  console.error('reporting-centre-failed', {
    operation,
    reportId: context?.reportId || null,
    actorUid: context?.profile?.uid || null,
    storeIds: context?.selected || [],
    code: error?.code || 'unknown',
    message: cleanText(error?.message, 180),
  });
  if (error instanceof HttpsError) throw error;
  fail('internal', 'The report could not be generated. Please retry.');
}

function createGetReportingSummary({ admin, db, region }) {
  return onCall({ region, timeoutSeconds: 120, memory: '1GiB' }, async (request) => {
    let context;
    try {
      context = await authorizeRequest(db, request, 'summary');
      const cacheKey = JSON.stringify({
        reportId: context.reportId,
        stores: context.selected,
        startDate: context.range.startIso,
        endDate: context.range.endIso,
        filters: context.filters,
        role: context.profile.role,
      });
      const cached = summaryCache.get(cacheKey);
      if (cached && Date.now() - cached.createdAt < SUMMARY_CACHE_TTL_MS) return cached.value;
      const data = await buildData(admin, db, context);
      const response = baseResponse(context, data);
      summaryCache.set(cacheKey, { createdAt: Date.now(), value: response });
      await appendAccessAudit(admin, db, context, 'SUMMARY', data.dataset.rows.length);
      return response;
    } catch (error) {
      return errorResponse(error, context, 'SUMMARY');
    }
  });
}

function createGetReportingRows({ admin, db, region }) {
  return onCall({ region, timeoutSeconds: 120, memory: '1GiB' }, async (request) => {
    let context;
    try {
      context = await authorizeRequest(db, request, 'rows');
      const core = await reportingCore();
      const pageSize = Math.min(core.MAX_PAGE_SIZE, Math.max(10, Number(request.data?.pageSize) || core.DEFAULT_PAGE_SIZE));
      const page = Math.max(1, Math.floor(Number(request.data?.page) || 1));
      const data = await buildData(admin, db, context);
      const totalRows = data.dataset.rows.length;
      const start = (page - 1) * pageSize;
      const rows = data.dataset.rows.slice(start, start + pageSize);
      await appendAccessAudit(admin, db, context, 'ROWS', rows.length);
      return {
        ...baseResponse(context, data),
        rows,
        pagination: {
          page,
          pageSize,
          totalRows,
          totalPages: Math.max(1, Math.ceil(totalRows / pageSize)),
          hasNextPage: start + pageSize < totalRows,
        },
      };
    } catch (error) {
      return errorResponse(error, context, 'ROWS');
    }
  });
}

function createExportReportingData({ admin, db, region }) {
  return onCall({ region, timeoutSeconds: 180, memory: '1GiB' }, async (request) => {
    let context;
    try {
      context = await authorizeRequest(db, request, 'export');
      if (context.profile.role === 'CASHIER') {
        fail('permission-denied', 'Detailed exports are limited to Admin and Store Manager roles.');
      }
      const core = await reportingCore();
      const data = await buildData(admin, db, context);
      if (data.dataset.rows.length > core.MAX_EXPORT_ROWS) {
        fail('resource-exhausted', `Exports are limited to ${core.MAX_EXPORT_ROWS} rows. Narrow the filters.`);
      }
      await appendAccessAudit(admin, db, context, 'EXPORT', data.dataset.rows.length);
      return {
        ...baseResponse(context, data),
        rows: data.dataset.rows,
        totalRows: data.dataset.rows.length,
      };
    } catch (error) {
      return errorResponse(error, context, 'EXPORT');
    }
  });
}

function createReportingFunctions(dependencies) {
  return {
    getReportingSummary: createGetReportingSummary(dependencies),
    getReportingRows: createGetReportingRows(dependencies),
    exportReportingData: createExportReportingData(dependencies),
  };
}

module.exports = {
  createReportingFunctions,
};
