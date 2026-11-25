'use strict';

const { gzipSync, gunzipSync } = require('node:zlib');
const { contentDigest, stableJson } = require('./posCheckoutFinancials');
const { buildKotTasks } = require('./compositeFulfillment');
const { readTillPrintBinding } = require('./tillPrintBinding.cjs');
const { legalDetails, treatment } = require('./storeGstTreatment');
const { HttpsError } = require('firebase-functions/v2/https');

function revision(doc) {
  return doc.updateTime ? [doc.updateTime.seconds, doc.updateTime.nanoseconds].join('.') : null;
}
function hasPaymentRecord(payments) {
  return payments.docs.some(doc => doc.id !== 'PAY_AT_COUNTER' || doc.get('method') !== 'PAY_AT_COUNTER' ||
    doc.get('amount') !== 0 || (doc.get('reference') != null && doc.get('reference') !== ''));
}
function tableCanBeEdited(session, order, lock) {
  if (!lock || lock.activeSessionId !== session.id) return 'Table assignment requires reconciliation.';
  if (session.closedAt || !['OCCUPIED', 'BILL_REQUESTED'].includes(session.status) || session.paymentAttempt) return 'Existing payment or table status requires online review.';
  if (session.orderId && (!order || order.tableSessionId !== session.id || order.storeId !== session.storeId ||
      order.status !== 'COMPLETED' || order.commercialStatus !== 'SALE' || order.paymentStatus !== 'UNPAID' ||
      order.paymentMethod !== 'PAY_AT_COUNTER' || order.tablePaymentAttemptId || order.razorpaySessionId ||
      order.providerPaymentId || order.razorpayOrderId || order.razorpayPaymentId ||
      (order.amountPaid !== undefined && order.amountPaid !== 0) ||
      (order.paymentBreakdown !== undefined && (!Array.isArray(order.paymentBreakdown) || order.paymentBreakdown.length)))) return 'Original unpaid order cannot be verified.';
  if (!session.orderId && session.lines.length) return 'Original order is missing.';
  return '';
}

async function prepareTables(tx, db, store, deviceId, policyVersion=1) {
  const storeId = store.id;
  const [definitions, configuration] = await Promise.all([
    tx.get(db.collection('tables').where('storeId', '==', storeId)),
    tx.get(db.doc('tableServiceConfig/' + storeId)),
  ]);
  const config = configuration.data() || {};
  const tableEnabled = config.enabled === true || config.recoveryMode === true;
  const definitionsForStore = policyVersion === 2 && !tableEnabled ? [] : definitions.docs;
  const tables = definitionsForStore.map(doc => {
    const t = doc.data();
    if (!t.tableId || doc.id !== storeId + '_' + t.tableId) throw new HttpsError('failed-precondition', 'Table configuration is incomplete.');
    return { tableId: t.tableId, label: t.label || t.tableId, capacity: t.capacity ?? null,
      activeSessionId: t.activeSessionId || null, sourceRevision: revision(doc) };
  }).sort((a, b) => a.tableId.localeCompare(b.tableId, 'en', { numeric: true }));
  const occupied = tables.filter(t => t.activeSessionId);
  const sessions = occupied.length ? await tx.getAll(...occupied.map(t => db.doc('tableSessions/' + t.activeSessionId))) : [];
  const orderIds = [...new Set(sessions.map(doc => doc.data()?.orderId).filter(Boolean))];
  const references = orderIds.map(id => db.doc('orders/' + id));
  const [orders, payments] = await Promise.all([
    references.length ? tx.getAll(...references) : [],
    Promise.all(references.map(ref => tx.get(ref.collection('payments')))),
  ]);
  const ordersById = new Map(orders.map(doc => [doc.id, doc.data()]));
  const pendingPaymentIds = new Set(orderIds.filter((id, i) => hasPaymentRecord(payments[i])));
  const tableSessions = [];
  for (const [i, doc] of sessions.entries()) {
    const s = doc.data(), t = occupied[i];
    if (!s || s.id !== t.activeSessionId || s.storeId !== storeId || s.tableId !== t.tableId || !Array.isArray(s.lines) || !Array.isArray(s.rounds)) {
      if (policyVersion === 2) {
        t.unavailableReason = 'Occupied table details could not be verified. Reconnect to retrieve the original bill.';
        continue;
      }
      throw new HttpsError('failed-precondition', 'An occupied table has an incomplete server snapshot. Refresh online.');
    }
    const linkedOrder = ordersById.get(s.orderId);
    const order = linkedOrder?.storeId === storeId && linkedOrder?.tableSessionId === s.id ? linkedOrder : null;
    const unavailableReason = tableCanBeEdited(s, order, t) ||
      (pendingPaymentIds.has(s.orderId) ? 'A payment record requires online reconciliation.' : '');
    tableSessions.push({
      id: s.id, storeId, tableId: t.tableId, tableLabel: t.label, version: s.version, orderId: s.orderId || null,
      status: s.status, lines: s.lines, rounds: s.rounds, openedAt: s.openedAt, guestCount: s.guestCount ?? null,
      assignedStaff: s.assignedStaff || null, total: s.total, outstanding: s.outstanding, closedAt: s.closedAt ?? null,
      paymentAttempt: s.paymentAttempt ? { id: s.paymentAttempt.id, amount: s.paymentAttempt.amount } : null,
      offlineEligible: !unavailableReason, unavailableReason,
      legal: order?.receiptLegalDetails || legalDetails(store), gst: order?.gstTreatmentSnapshot || treatment(store),
    });
  }
  return {
    tableWorkflowVersion: 1, tableOwnership: { deviceId, storeId },
    tableBoard: { complete: true, enabled: config.enabled === true, recoveryMode: config.recoveryMode === true,
      enableNewSessions: config.enabled === true && config.enableNewSessions === true && config.recoveryMode !== true, tables },
    tableSessions, ...await readTillPrintBinding(tx, db, storeId, deviceId),
  };
}

function printTasks(product, canonical) {
  return buildKotTasks({ quantity: 1, finishedGood: product, components: canonical.components || [] })
    .map(({ taskKey, station, itemCode, itemName, quantity }) => ({ taskKey, station, itemCode, itemName, quantity }));
}

// Keep full catalog, stock and every active table without hitting Firestore's per-document
// limit. stableJson preserves the same canonical representation used to sign and compare.
function storeLease(tx, ref, lease) {
  const { snapshot } = lease;
  const compressed = gzipSync(stableJson({ snapshot, catalog: lease.catalog, store: lease.store }));
  const size = 400 * 1024;
  const chunkCount = Math.ceil(compressed.length / size);
  if (chunkCount > 20) throw new HttpsError('resource-exhausted', 'Store snapshot exceeds the preparation transaction size.');
  for (let index = 0; index < chunkCount; index++) {
    tx.create(ref.collection('parts').doc(String(index)), { data: compressed.subarray(index * size, (index + 1) * size) });
  }
  const summary = Object.fromEntries(['id','storeId','uid','role','deviceId','offlinePolicyVersion','issuedAt','expiresAt','tableWorkflowVersion','printStationId','printRoutes','printStationPublicKey'].filter(k => snapshot[k] !== undefined).map(k => [k, snapshot[k]]));
  tx.create(ref, { snapshot: summary, snapshotDigest: contentDigest(snapshot), chunkCount, createdAt: lease.createdAt });
}
async function readLease(tx, ref) {
  const doc = (await tx.get(ref)).data();
  if (!doc?.chunkCount) return doc;
  const parts = await tx.getAll(...Array.from({ length: doc.chunkCount }, (_, index) => ref.collection('parts').doc(String(index))));
  const lease = JSON.parse(gunzipSync(Buffer.concat(parts.map(part => part.get('data')))).toString('utf8'));
  if (contentDigest(lease.snapshot) !== doc.snapshotDigest) throw new HttpsError('data-loss', 'Signed store snapshot is incomplete.');
  return lease;
}
module.exports = { revision, tableCanBeEdited, hasPaymentRecord, prepareTables, printTasks, storeLease, readLease };
