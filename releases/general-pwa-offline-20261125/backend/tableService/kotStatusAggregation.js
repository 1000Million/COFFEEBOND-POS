'use strict';

const ATTENTION_STATUSES = new Set(['CANCELLED', 'RETURNED', 'WASTAGE_RECORDED']);
const KNOWN_STATUSES = new Set([
  'PENDING',
  'PREPARING',
  'READY',
  'SERVED',
  'RETURNED',
  'WASTAGE_RECORDED',
  'REMAKE_REQUESTED',
  'CANCELLED',
]);

function cleanText(value, maxLength = 240) {
  return String(value || '').trim().slice(0, maxLength);
}

function publicStatusMessage(status) {
  if (status === 'PREPARING') return 'Your order is being prepared.';
  if (status === 'READY') return 'Your order is ready for pickup.';
  if (status === 'SERVED') return 'Your order has been completed.';
  if (status === 'NEEDS_ATTENTION') return 'The store is reviewing your order.';
  return 'We are checking your order status.';
}

function effectiveKotTasks(tasks) {
  const replacements = new Set(tasks
    .map(task => cleanText(task?.remakeOfKotItemId))
    .filter(Boolean));

  // A REMAKE_REQUESTED ticket is superseded only when its linked replacement
  // exists in the same authoritative query. The replacement then carries the
  // parent through PENDING -> PREPARING -> READY -> SERVED again.
  return tasks.filter(task => !(
    cleanText(task?.status, 40) === 'REMAKE_REQUESTED'
    && replacements.has(cleanText(task?.id))
  ));
}

function summarizeKotOrderItem(tasks) {
  const effectiveTasks = effectiveKotTasks(Array.isArray(tasks) ? tasks : []);
  if (effectiveTasks.length === 0) {
    return {
      orderItemStatus: 'PENDING',
      needsAttention: true,
      blockingStatuses: ['MISSING_ACTIVE_KOT'],
    };
  }

  const statuses = effectiveTasks.map(task => cleanText(task?.status, 40));
  const blockingStatuses = [...new Set(statuses.filter(status => (
    !KNOWN_STATUSES.has(status)
    || ATTENTION_STATUSES.has(status)
    || status === 'REMAKE_REQUESTED'
  )))];

  // A cancelled/returned/wasted component makes the whole commercial line
  // require attention. It must never be treated as a successful READY/SERVED
  // sibling. A REMAKE_REQUESTED ticket without its replacement is also unsafe.
  if (blockingStatuses.length > 0) {
    return {
      orderItemStatus: 'CANCELLED',
      needsAttention: true,
      blockingStatuses,
    };
  }

  if (statuses.includes('PENDING')) {
    return { orderItemStatus: 'PENDING', needsAttention: false, blockingStatuses: [] };
  }
  if (statuses.includes('PREPARING')) {
    return { orderItemStatus: 'PREPARING', needsAttention: false, blockingStatuses: [] };
  }
  if (statuses.includes('READY')) {
    return { orderItemStatus: 'READY', needsAttention: false, blockingStatuses: [] };
  }
  if (statuses.every(status => status === 'SERVED')) {
    return { orderItemStatus: 'SERVED', needsAttention: false, blockingStatuses: [] };
  }

  return {
    orderItemStatus: 'CANCELLED',
    needsAttention: true,
    blockingStatuses: ['UNRESOLVED_KOT_STATE'],
  };
}

function summarizeKotOrder(tasks) {
  const groups = new Map();
  (Array.isArray(tasks) ? tasks : []).forEach((task, index) => {
    const orderItemId = cleanText(task?.orderItemId) || `__MISSING_${cleanText(task?.id) || index}`;
    if (!groups.has(orderItemId)) groups.set(orderItemId, []);
    groups.get(orderItemId).push(task);
  });
  const itemSummaries = [...groups.entries()].map(([orderItemId, itemTasks]) => ({
    orderItemId,
    ...summarizeKotOrderItem(itemTasks),
  }));

  if (itemSummaries.length === 0 || itemSummaries.some(summary => summary.needsAttention)) {
    return { publicStatus: 'NEEDS_ATTENTION', itemSummaries };
  }
  if (itemSummaries.every(summary => summary.orderItemStatus === 'SERVED')) {
    return { publicStatus: 'SERVED', itemSummaries };
  }
  if (itemSummaries.every(summary => ['READY', 'SERVED'].includes(summary.orderItemStatus))) {
    return { publicStatus: 'READY', itemSummaries };
  }
  return { publicStatus: 'PREPARING', itemSummaries };
}

function validDocumentId(value) {
  const id = cleanText(value);
  return Boolean(id && !id.includes('/'));
}

function createKotStatusAggregationHandler({ admin, db, logger = console }) {
  const { FieldValue } = admin.firestore;

  return async function handleKotStatusAggregation({ kotId, before, after }) {
    if (cleanText(before?.status, 40) === cleanText(after?.status, 40)) {
      return { skipped: 'STATUS_UNCHANGED' };
    }

    const orderId = cleanText(after?.orderId);
    const orderItemId = cleanText(after?.orderItemId);
    const storeId = cleanText(after?.storeId);
    if (![kotId, orderId, orderItemId, storeId].every(validDocumentId)) {
      logger.error('KOT status aggregation skipped invalid identity', { kotId, orderId, orderItemId, storeId });
      return { skipped: 'INVALID_IDENTITY' };
    }

    return db.runTransaction(async transaction => {
      // This query runs with Admin SDK authority. Station users never need to
      // read the sibling station in order to move their own ticket forward.
      const orderKotSnapshot = await transaction.get(
        db.collection('kotItems').where('orderId', '==', orderId),
      );
      const orderTasks = orderKotSnapshot.docs
        .map(snapshot => ({ id: snapshot.id, ...snapshot.data() }))
        .filter(task => cleanText(task.storeId) === storeId);
      const currentTask = orderTasks.find(task => task.id === kotId);
      if (!currentTask) return { skipped: 'KOT_NOT_CURRENT' };

      const itemTasks = orderTasks.filter(task => cleanText(task.orderItemId) === orderItemId);
      const itemSummary = summarizeKotOrderItem(itemTasks);
      const orderSummary = summarizeKotOrder(orderTasks);
      const orderItemRef = db.collection('orders').doc(orderId).collection('items').doc(orderItemId);

      const trackingTokens = [...new Set(orderTasks
        .map(task => cleanText(task.onlineOrderTrackingToken))
        .filter(Boolean))];
      const trackingToken = trackingTokens.length === 1 ? trackingTokens[0] : null;
      if (trackingTokens.length > 1) {
        logger.error('KOT status aggregation found conflicting tracking tokens', {
          orderId,
          storeId,
          trackingTokenCount: trackingTokens.length,
        });
      }
      const trackingRef = trackingToken
        ? db.collection('publicOrderTracking').doc(trackingToken)
        : null;

      // Complete every read before any write so Firestore can safely retry the
      // transaction if a sibling station changes while aggregation is running.
      const orderItemSnapshot = await transaction.get(orderItemRef);
      const trackingSnapshot = trackingRef ? await transaction.get(trackingRef) : null;

      let parentUpdated = false;
      if (orderItemSnapshot.exists && cleanText(orderItemSnapshot.data()?.status, 40) !== itemSummary.orderItemStatus) {
        transaction.update(orderItemRef, { status: itemSummary.orderItemStatus });
        parentUpdated = true;
      }

      let trackingUpdated = false;
      if (trackingRef && trackingSnapshot?.exists) {
        const tracking = trackingSnapshot.data() || {};
        const nextMessage = publicStatusMessage(orderSummary.publicStatus);
        const update = {};
        if (cleanText(tracking.publicStatus, 40) !== orderSummary.publicStatus) {
          update.publicStatus = orderSummary.publicStatus;
        }
        if (cleanText(tracking.customerStatusMessage, 180) !== nextMessage) {
          update.customerStatusMessage = nextMessage;
        }
        if (orderSummary.publicStatus === 'READY' && !tracking.readyAt) {
          update.readyAt = FieldValue.serverTimestamp();
        }
        if (orderSummary.publicStatus === 'SERVED' && !tracking.servedAt) {
          update.servedAt = FieldValue.serverTimestamp();
        }
        if (Object.keys(update).length > 0) {
          transaction.update(trackingRef, update);
          trackingUpdated = true;
        }
      }

      return {
        skipped: null,
        orderId,
        orderItemId,
        itemStatus: itemSummary.orderItemStatus,
        publicStatus: orderSummary.publicStatus,
        parentUpdated,
        trackingUpdated,
      };
    });
  };
}

module.exports = {
  ATTENTION_STATUSES,
  createKotStatusAggregationHandler,
  effectiveKotTasks,
  publicStatusMessage,
  summarizeKotOrder,
  summarizeKotOrderItem,
};
