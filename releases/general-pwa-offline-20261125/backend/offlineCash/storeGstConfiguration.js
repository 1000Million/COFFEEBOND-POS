'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { createHash } = require('node:crypto');
const { treatment, MODES, resolveGstStore } = require('./storeGstTreatment');

function createStoreGstConfigurationFunction({ admin, db, region }) {
  return onCall({ region }, async request => {
    const fail = (code, message) => { throw new HttpsError(code, message); };
    if (!request.auth?.uid) fail('unauthenticated', 'Sign in is required.');
    const data = request.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || Object.keys(data).some(key => !['storeId', 'mode', 'rate', 'expectedRevision', 'operationId'].includes(key))
      || typeof data.storeId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(data.storeId)
      || typeof data.operationId !== 'string' || !/^[A-Za-z0-9_-]{16,120}$/.test(data.operationId)
      || !Number.isSafeInteger(data.expectedRevision) || data.expectedRevision < 0
      || !MODES.includes(data.mode)
      || (data.mode === 'STORE_WIDE' ? typeof data.rate !== 'number' || !Number.isFinite(data.rate) || data.rate <= 0 || data.rate > 100 : data.rate !== null)) {
      fail('invalid-argument', 'Select a GST treatment and a valid store-wide percentage.');
    }
    const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const fingerprint = digest([data.storeId, data.mode, data.rate, data.expectedRevision]);
    const storeRef = db.collection('stores').doc(data.storeId);
    const auditRef = db.collection('storeGstAudit').doc(digest([request.auth.uid, data.operationId]));
    return db.runTransaction(async transaction => {
      const [staff, store, audit] = await Promise.all([
        transaction.get(db.collection('users').doc(request.auth.uid)), transaction.get(storeRef), transaction.get(auditRef),
      ]);
      if (!staff.exists || staff.data().isActive !== true || staff.data().role !== 'ADMIN') fail('permission-denied', 'Only an active Admin can change store GST.');
      if (!store.exists) fail('not-found', 'Store not found.');
      if (audit.exists) {
        if (audit.data().fingerprint !== fingerprint) fail('failed-precondition', 'This save identity was already used for different settings.');
        return { storeId: data.storeId, gstSourceStoreId: audit.data().storeId, gstTreatment: audit.data().next, replayed: true };
      }
      const context = await resolveGstStore({ id: store.id, ...store.data() }, async sourceId => {
        const source = await transaction.get(db.collection('stores').doc(sourceId));
        return source.exists ? { id: source.id, ...source.data() } : null;
      });
      const sourceId = context.gstSourceStoreId || data.storeId;
      const previous = treatment(context);
      if (previous.revision !== data.expectedRevision) fail('failed-precondition', 'GST settings changed. Reload the current settings before saving.');
      const linked = await transaction.get(db.collection('stores').where('legalAndGstSourceStoreId', '==', sourceId));
      const affectedStoreIds = [...new Set([sourceId, ...linked.docs.map(snapshot => snapshot.id)])];
      if (affectedStoreIds.length > 30) fail('failed-precondition', 'Shared legal/GST configuration requires Admin review.');
      const tables = await transaction.get(db.collection('tableSessions').where('storeId', 'in', affectedStoreIds));
      if (tables.docs.some(snapshot => {
        const session = snapshot.data();
        return !session.closedAt && session.status !== 'PAID_AWAITING_CLEAR'
          && Array.isArray(session.lines) && session.lines.some(line => !line.cancelled);
      })) fail('failed-precondition', 'Finish active table bills before changing store GST. No settings were changed.');
      const next = { mode: data.mode, rate: data.rate, revision: previous.revision + 1 };
      const timestamp = admin.firestore.FieldValue.serverTimestamp();
      transaction.update(db.collection('stores').doc(sourceId), { gstTreatment: next, gstTreatmentUpdatedAt: timestamp, gstTreatmentUpdatedBy: request.auth.uid });
      transaction.create(auditRef, { storeId: sourceId, requestedStoreId: data.storeId, affectedStoreIds, actorUid: request.auth.uid, previous, next, fingerprint, createdAt: timestamp });
      return { storeId: data.storeId, gstSourceStoreId: sourceId, gstTreatment: next, replayed: false };
    });
  });
}
module.exports = { createStoreGstConfigurationFunction };
