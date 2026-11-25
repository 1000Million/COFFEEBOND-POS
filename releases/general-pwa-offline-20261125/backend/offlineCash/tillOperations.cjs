'use strict';

const { createHash } = require('node:crypto');
const { HttpsError } = require('firebase-functions/v2/https');
const { contentDigest } = require('./posCheckoutFinancials');
const { tableTotals, tableLineTotals } = require('./tableDomain.cjs');
const { createTableService } = require('./deployed-table/tableService');
const { revision, tableCanBeEdited, hasPaymentRecord } = require('./tillSnapshot.cjs');
const { legalDetails, treatment } = require('./storeGstTreatment');
const types = new Set(['TABLE_OPEN', 'TABLE_ROUND', 'TABLE_CASH']);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const equal = (a, b) => contentDigest(a) === contentDigest(b);
const invalid = message => { throw new HttpsError('invalid-argument', message); };
const amountFields = ({ subtotal, discountAmount, taxTotal, grandTotal }) => ({ subtotal, discountAmount, taxTotal, grandTotal });

function printMarker(snapshot, payload) {
  if (!payload.printAuthority && !payload.printStationId) return null;
  if (snapshot.tableWorkflowVersion !== 1 || !snapshot.printStationId || !snapshot.printRoutes ||
      payload.printAuthority !== 'DESIGNATED_TILL' || payload.printStationId !== snapshot.printStationId) {
    invalid('Receipt or KOT print authority does not match the signed station binding.');
  }
  return { offlinePrintAuthority: 'DESIGNATED_TILL', offlineOperationId: payload.id, offlinePrintStationId: snapshot.printStationId };
}

// Capture the existing writer's mutations before applying them to the enclosing
// Firestore transaction. A rejected table command can then journal a conflict
// without committing a partial round. Reads are performed by Firestore itself.
function stagedTransaction(tx, marker) {
  const writes = [];
  const staged = { get: tx.get.bind(tx), getAll: tx.getAll.bind(tx) };
  for (const method of ['create', 'set', 'update', 'delete']) {
    staged[method] = (ref, ...args) => {
      if (method === 'create' && marker && ref.parent.path === 'kotItems') args[0] = { ...args[0], ...marker };
      writes.push({ method, ref, args });
      return staged;
    };
  }
  return { staged, writes, flush() { for (const w of writes) tx[w.method](w.ref, ...w.args); } };
}

function roundRequests(payload, snapshot) {
  if (!Array.isArray(payload.items) || !payload.items.length || payload.items.length > 30 ||
      new Set(payload.items.map(item => item.orderItemId)).size !== payload.items.length) invalid('The saved round needs distinct approved lines.');
  return payload.items.map(item => {
    const approved = snapshot.menu.find(p => p.id === item.productId);
    if (!approved || !validId(item.orderItemId) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20 ||
        !Array.isArray(item.selectedAddOns) || !equal(item.selectedAddOns, approved.request.selectedAddOns)) {
      invalid('An item, option or quantity is outside the prepared menu.');
    }
    return { ...approved.request, quantity: item.quantity, orderItemId: item.orderItemId };
  });
}

async function applyTableOperation({ tx, db, admin, uid, profile, store, lease, payload, entryRef,
    digest, progressRef, progress, conflicts, catalog, canonical, stamp, action, reason, old, pilotAllowed }) {
  const snapshot = lease.snapshot, t = payload.table, kind = payload.kind;
  if (snapshot.tableWorkflowVersion !== 1 || snapshot.tableOwnership?.deviceId !== payload.deviceId ||
      snapshot.tableOwnership.storeId !== store.id || !snapshot.tableBoard?.complete || !t ||
      !validId(t.id) || !validId(t.tableId) || !validId(t.orderId) || !Number.isSafeInteger(t.version) ||
      t.version < 0 || (payload.predecessorId != null && !validId(payload.predecessorId))) invalid('Original table and ownership snapshot required.');
  const reconciling = action === 'RECONCILE';
  if (reconciling && (!['ADMIN', 'STORE_MANAGER'].includes(profile.role) || !old || old.status !== 'CONFLICT' || typeof reason !== 'string' || reason.trim().length < 8)) {
    throw new HttpsError('permission-denied', 'A manager must document original-operation reconciliation.');
  }
  const avoid = code => {
    const reasons = [...new Set([...conflicts, code].filter(Boolean))];
    tx.set(entryRef, { uid: payload.uid, storeId: store.id, deviceId: payload.deviceId, digest, payload,
      status: 'CONFLICT', conflicts: reasons, updatedAt: stamp() }, { merge: true });
    return { status: 'CONFLICT', conflicts: reasons };
  };
  // Owner, original lock, stock, price and order conflicts are never bypassed.
  // An expired capture can use the existing manager workflow for this exact saved record.
  if (reconciling && pilotAllowed) {
    for (let i = conflicts.length - 1; i >= 0; i--) {
      if (conflicts[i] === 'OFFLINE_AUTH_EXPIRED') conflicts.splice(i, 1);
    }
  }
  if (!equal(treatment(store), snapshot.gst) || !equal(legalDetails(store), snapshot.legal)) conflicts.push('GST_OR_LEGAL_CHANGED');
  if (conflicts.length) return avoid();
  const def = snapshot.tableBoard.tables.find(table => table.tableId === t.tableId);
  if (!def) return avoid('TABLE_CONFIGURATION');
  const lockRef = db.doc('tables/' + store.id + '_' + t.tableId);
  const sessionRef = db.doc('tableSessions/' + t.id), orderRef = db.doc('orders/' + t.orderId);
  const opHash = createHash('sha256').update(JSON.stringify([uid, payload.id])).digest('hex');
  const [lock, sessionDoc, orderDoc, config, tableOp] = await Promise.all([
    tx.get(lockRef), tx.get(sessionRef), tx.get(orderRef), tx.get(db.doc('tableServiceConfig/' + store.id)), tx.get(db.doc('tableOperations/' + opHash)),
  ]);
  if (snapshot.offlinePolicyVersion === 2 && config.get('enabled') !== true && config.get('recoveryMode') !== true) return avoid('TABLE_SERVICE_PAUSED');
  if (!lock.exists || lock.get('tableId') !== t.tableId || lock.get('storeId') !== store.id || tableOp.exists) return avoid('TABLE_REVISION');
  const session = sessionDoc.data(), order = orderDoc.data();
  if (kind === 'TABLE_OPEN') {
    if (t.version !== 0 || t.orderId !== 'TABLE_' + t.id || payload.predecessorId || def.activeSessionId ||
        !snapshot.tableBoard.enableNewSessions || config.get('enabled') !== true || config.get('enableNewSessions') !== true ||
        config.get('recoveryMode') || lock.get('activeSessionId') || session || order || revision(lock) !== def.sourceRevision) return avoid('TABLE_REVISION');
  } else {
    if (payload.predecessorId) {
      const parent = (await tx.get(db.doc('offlineTransactions/' + payload.predecessorId))).data();
      if (!parent) return { status: 'DEPENDENCY_PENDING', conflicts: ['PREDECESSOR_NOT_SYNCED'] };
      if (parent.status !== 'SYNCED' || parent.uid !== payload.uid || parent.deviceId !== payload.deviceId ||
          parent.storeId !== store.id || parent.payload?.snapshotId !== snapshot.id ||
          parent.result?.sessionId !== t.id || parent.result?.tableId !== t.tableId ||
          parent.result?.tableVersion !== t.version || parent.result?.orderId !== t.orderId) return avoid('TABLE_PREDECESSOR');
    }
    if (!session || session.id !== t.id || session.storeId !== store.id || session.version !== t.version ||
        session.tableId !== t.tableId || (session.orderId || 'TABLE_' + t.id) !== t.orderId ||
        !!session.orderId !== !!order || tableCanBeEdited(session, order, lock.data())) return avoid('TABLE_REVISION');
    if (!payload.predecessorId) {
      const original = snapshot.tableSessions.find(s => s.id === t.id);
      if (!original?.offlineEligible || original.tableId !== t.tableId || original.version !== t.version ||
          (original.orderId || 'TABLE_' + t.id) !== t.orderId || !equal(original.lines, session.lines)) return avoid('TABLE_REVISION');
    }
    if (order) {
      const payments = await tx.get(orderRef.collection('payments'));
      if (hasPaymentRecord(payments)) {
        return avoid('TABLE_PAYMENT_RECEIVED_OR_UNCERTAIN');
      }
    }
  }

  const marker = printMarker(snapshot, payload);
  let result;
  if (kind === 'TABLE_CASH') {
    if (!order || !session.lines.some(line => !line.cancelled) || payload.items?.length) return avoid('TABLE_REVISION');
    const total = tableTotals(session.lines, payload.discountPercent);
    if (!(total.grandTotal > 0) || !equal(payload.totals, amountFields(total)) || !Number.isFinite(payload.cashReceived) ||
        payload.cashReceived < total.grandTotal) return avoid('SAVED_RECEIPT_AMOUNT');
    // Identical saved receipt and official discount/tax arithmetic; no order/item/KOT recreation.
    const paymentRef = orderRef.collection('payments').doc('OFF_' + payload.id);
    for (const line of session.lines) tx.update(orderRef.collection('items').doc(line.id), tableLineTotals(line, payload.discountPercent));
    const payment = { method: 'CASH', amount: total.grandTotal };
    tx.create(paymentRef, { ...payment, offlineId: payload.id, paymentIndex: 1, createdAt: stamp(), settledBy: uid });
    tx.update(orderRef, { ...total, paymentStatus: 'PAID', paymentMethod: 'CASH', isSplitPayment: false,
      paymentBreakdown: [payment], offlineId: payload.id, offlineFinancialSnapshot: payload, settledAt: stamp(), settledBy: uid, updatedAt: stamp() });
    tx.update(sessionRef, { status: 'PAID_AWAITING_CLEAR', version: t.version + 1, total: total.grandTotal, outstanding: 0,
      discountPercent: payload.discountPercent, payments: [payment], paymentAttempt: null, paidAt: Date.now(), offlineId: payload.id });
    result = { tableVersion: t.version + 1, tableStatus: 'PAID_AWAITING_CLEAR', grandTotal: total.grandTotal, orderNumber: order.orderNumber };
  } else {
    if (payload.cashReceived != null || payload.paymentMethod != null || payload.discountPercent !== 0) invalid('Table edits cannot collect tender or apply a discount.');
    let items, current, stock, expectedTableTotals;
    if (kind === 'TABLE_ROUND') {
      if (config.get('enabled') !== true || !snapshot.tableBoard.enabled || config.get('recoveryMode') || snapshot.tableBoard.recoveryMode) return avoid('TABLE_SERVICE_PAUSED');
      if (payload.roundId !== payload.id) invalid('Saved round must retain its original operation identity.');
      items = roundRequests(payload, snapshot);
      const approved = canonical(lease.store, lease.catalog, items);
      current = await catalog(tx, store);
      let live;
      try { live = canonical(store, current, items); } catch { return avoid('PRODUCT_UNAVAILABLE'); }
      if (!equal(live, approved) || !equal(lease.catalog.gst, current.gst)) return avoid('PRICE_OR_PRODUCT');
      if (items.some(item => !equal(current.products[item.parentProductId], lease.catalog.products[item.parentProductId]))) return avoid('PRODUCT_OR_RECIPE');
      if (!equal(current.stock, progress?.stock || lease.catalog.stock)) return avoid('STOCK_CHANGED');
      stock = { ...current.stock };
      const lines = items.map(item => ({ ...approved.canonicalItems[item.orderItemId], quantity: item.quantity }));
      if (!Array.isArray(payload.roundLines) || payload.roundLines.length !== lines.length || lines.some((line,index) => {
        const saved=payload.roundLines[index], item=items[index], product=lease.catalog.products[item.parentProductId];
        return !saved || saved.id!==item.orderItemId || saved.roundId!==payload.id || saved.parentProductId!==item.parentProductId ||
          saved.itemCode!==line.parentProductCode || saved.itemName!==(product.displayName||product.name||product.code) ||
          saved.quantity!==line.quantity || saved.baseUnitPrice!==line.baseUnitPrice || saved.taxRate!==line.taxRate ||
          !equal(saved.addOns,line.addOns) || saved.cancelled!==false;
      })) return avoid('SAVED_ROUND_CHANGED');
      if (!equal(payload.totals, amountFields(tableTotals(lines, 0)))) return avoid('ROUND_TOTAL_CHANGED');
      expectedTableTotals = amountFields(tableTotals([...session.lines, ...lines], 0));
    } else if (payload.items?.length) invalid('Opening a table cannot send a round.');
    const journal = stagedTransaction(tx, marker);
    const scoped = { doc: db.doc.bind(db), collection: db.collection.bind(db), runTransaction: fn => fn(journal.staged) };
    const handler = createTableService({ db: scoped, admin });
    const command = { action: kind === 'TABLE_OPEN' ? 'OPEN' : 'SEND', storeId: store.id, sessionId: t.id, opId: payload.id, version: t.version };
    if (kind === 'TABLE_OPEN') Object.assign(command, { tableId: t.tableId, guestCount: payload.guestCount ?? null });
    else Object.assign(command, { items, note: typeof payload.note === 'string' ? payload.note : '' });
    let reply;
    try { reply = await handler.run({ auth: { uid }, data: command }); } catch (e) {
      if (['failed-precondition','aborted','already-exists','not-found','resource-exhausted'].includes(e.code)) return avoid('TABLE_COMMAND_' + e.code.toUpperCase().replace(/-/g, '_'));
      throw e;
    }
    const saved = journal.writes.find(w => w.ref.path === orderRef.path);
    if (items) {
      if (!saved?.args[0]?.orderNumber || (order && saved.args[0].orderNumber !== order.orderNumber)) return avoid('TABLE_ORDER_IDENTITY');
      if (!equal(amountFields(saved.args[0]), expectedTableTotals)) return avoid('ROUND_TOTAL_CHANGED');
      const savedItems = new Map(journal.writes.filter(w => w.ref.parent.path === orderRef.collection('items').path)
        .map(w => [w.ref.id, w.args[0]]));
      if (payload.roundLines.some(line => {
        const item = savedItems.get(line.id);
        return !item || line.baseUnitPrice !== item.baseUnitPrice || line.taxRate !== item.taxRate ||
          line.quantity !== item.quantity || line.itemName !== item.itemName || line.itemCode !== item.itemCode ||
          !equal(line.addOns, item.addOns);
      })) return avoid('SAVED_ROUND_CHANGED');
      for (const write of journal.writes.filter(w => w.ref.parent.path === 'storeStock')) {
        const update = write.args[0];
        stock[write.ref.id] = { currentStock: update.currentStock, costPerUnit: stock[write.ref.id]?.costPerUnit ?? update.costPerUnit ?? null };
      }
    }
    journal.flush();
    if (stock) tx.set(progressRef, { stock, lastOfflineId: payload.id, updatedAt: stamp() });
    result = { tableVersion: reply.version, tableStatus: reply.status, grandTotal: saved?.args[0].grandTotal || 0,
      orderNumber: saved?.args[0].orderNumber || null };
  }
  Object.assign(result, { sessionId: t.id, orderId: t.orderId, tableId: t.tableId });
  tx.set(entryRef, { uid: payload.uid, storeId: store.id, deviceId: payload.deviceId, digest, payload, status: 'SYNCED', result,
    reconciliation: reconciling ? { uid, reason: reason.trim(), at: Date.now() } : null, synchronizedAt: stamp() });
  return { status: 'SYNCED', result };
}

module.exports = { types, applyTableOperation, printMarker, stagedTransaction };
