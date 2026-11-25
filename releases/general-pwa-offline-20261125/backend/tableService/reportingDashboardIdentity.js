'use strict';

// Reuse the existing server-provenance validator, never loyalty visits/account age.
const { isEligibleCustomerOrderingOrigin } = require('./bondLoyalty');
const MAX_PERIOD_BILLS = 200;
const MAX_CUSTOMERS = 50;
const MAX_HISTORY_ROWS = 200;
const MAX_PROVENANCE_READS = 2000;

async function returningCustomerAggregates({ records, filters, selected, db, core }) {
  const eligible = core.filterNormalizedRecords(core.normalizeRecords(records), filters)
    .filter(r => r.status === 'COMPLETED' && r.commercial === 'PAID');
  const base = { eligibleBills: eligible.length, identifiedBills: null, distinctIdentified: null, returningCustomers: null, confirmedReturning: null, historyEstablished: null, percentage: null, identificationPercent: null, unknownBills: null };
  const insufficient = reason => ({ ...base, status: 'INSUFFICIENT_HISTORY', reason });
  if (selected.length !== 1) return insufficient('Select one store to establish returning customers at this store.');
  if (eligible.length > MAX_PERIOD_BILLS) return insufficient('Verified identity coverage requires at most 200 eligible bills per request. Narrow the selected dates; no partial percentage is reported.');
  const raw = new Map(records.map(r => [String(r.order.id), r.order]));
  const memo = new Map(); let reads = 0;
  const get = async (collection, id) => {
    if (typeof id !== 'string' || !id || id.includes('/') || id.length > 240) return null;
    const key = collection + '/' + id;
    if (!memo.has(key)) {
      if (++reads > MAX_PROVENANCE_READS) throw Object.assign(Error('Verified purchase provenance exceeds the 2000-document read budget; narrow the dates.'), { code: 'resource-exhausted' });
      memo.set(key, db.collection(collection).doc(id).get().then(s => s.exists ? { id: s.id, ...s.data() } : null));
    }
    return memo.get(key);
  };
  const identity = async (order, online = null) => {
    if (!order || order.source !== 'CUSTOMER_WEB' || !order.onlineOrderId) return null;
    online ||= await get('onlineOrders', order.onlineOrderId);
    if (!online || online.storeId !== selected[0]) return null;
    let valid = false;
    if (online.checkoutSessionId) {
      const session = await get('customerCheckoutSessions', online.checkoutSessionId);
      valid = !!session && session.status === 'ORDER_CREATED' && session.customerUid === online.customerUid && session.storeId === online.storeId && session.onlineOrderId === online.id;
    } else if (online.customerOrderSubmissionId) {
      const submission = await get('customerOrderSubmissions', online.customerOrderSubmissionId);
      valid = !!submission && submission.customerUid === online.customerUid && submission.storeId === online.storeId && submission.onlineOrderId === online.id;
    }
    const result = isEligibleCustomerOrderingOrigin({ orderId: order.id, order, onlineOrder: online, originEvidenceValid: valid });
    return result.eligible ? result.customerId : null;
  };
  const customers = new Map(); let identifiedBills = 0;
  for (const record of eligible) {
    const uid = await identity(raw.get(record.orderId));
    if (!uid) continue;
    identifiedBills++;
    const purchases = customers.get(uid) || [];
    purchases.push({ id: record.orderId, time: Date.parse(record.createdAt) }); customers.set(uid, purchases);
  }
  Object.assign(base, { identifiedBills, distinctIdentified: customers.size, unknownBills: eligible.length - identifiedBills, identificationPercent: eligible.length ? Math.round(identifiedBills * 10000 / eligible.length) / 100 : null });
  if (!customers.size) return insufficient('No server-verified purchasing identities in this period. Anonymous/unverified bills are UNKNOWN; names, phone numbers and staff-entered customerId are not identity evidence.');
  if (customers.size > MAX_CUSTOMERS) return insufficient('Full verified history is bounded to 50 identified customers per request. Narrow the dates; no partial percentage is reported.');
  let returning = 0, established = 0, incomplete = 0;
  for (const [uid, purchases] of customers) {
    const latest = Math.max(...purchases.map(p => p.time));
    // An earlier distinct purchase within the selected period is already sufficient.
    if (purchases.some(p => p.time < latest)) { returning++; established++; continue; }
    const snapshot = await db.collection('onlineOrders').where('customerUid', '==', uid).where('storeId', '==', selected[0]).limit(MAX_HISTORY_ROWS + 1).get();
    let found = false, uncertain = snapshot.docs.length > MAX_HISTORY_ROWS || new Set(purchases.map(p => p.id)).size > 1;
    for (const document of snapshot.docs.slice(0, MAX_HISTORY_ROWS)) {
      const online = { id: document.id, ...document.data() };
      if (purchases.some(p => p.id === online.linkedOrderId)) continue;
      if (!['ACCEPTED', 'CONVERTED'].includes(online.status)) { if (online.linkedOrderId) uncertain = true; continue; }
      if (!online.linkedOrderId) { uncertain = true; continue; }
      const order = await get('orders', online.linkedOrderId);
      if (!order || order.storeId !== selected[0]) { uncertain = true; continue; }
      const normalized = core.normalizeRecords([{ order, items: [], payments: [] }])[0];
      if (!normalized || normalized.status !== 'COMPLETED' || normalized.commercial !== 'PAID') continue;
      const purchasedAt = Date.parse(normalized.createdAt);
      if (!Number.isFinite(purchasedAt)) { uncertain = true; continue; }
      if (purchasedAt >= latest) continue;
      const historicalUid = await identity(order, online);
      if (historicalUid === uid) { found = true; break; }
      uncertain = true;
    }
    if (found) { returning++; established++; } else if (uncertain) incomplete++; else established++;
  }
  Object.assign(base, { confirmedReturning: returning, historyEstablished: established });
  if (incomplete) return insufficient('Insufficient verified history for ' + incomplete + ' identified customer(s): the all-history query reached 200 rows or a purchase lacks verified links, chronology or server provenance. No date lookback was substituted.');
  return { ...base, status: 'AVAILABLE', returningCustomers: returning, percentage: Math.round(returning * 10000 / customers.size) / 100, reason: null };
}

module.exports = { returningCustomerAggregates };
