'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const { isAuthorizedStaffProfile } = require('./complimentaryAuthorizationPolicy');

const MESSAGE = 'Sorry, the store could not accept this order.';
const normalized = value => typeof value === 'string' ? value.trim().toUpperCase() : value == null ? '' : 'INVALID';
const hasValue = value => value !== undefined && value !== null && value !== '';
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 1500
  && !value.includes('/') && value !== '.' && value !== '..';

function assertUnpaidCounterOrder(order) {
  // Missing provider/status fields are valid in old counter orders. Any evidence
  // of a gateway/payment/refund keeps the order on the existing secured paid path.
  if (!['', 'PAY_AT_COUNTER'].includes(normalized(order.paymentProvider))
    || !['', 'PAY_AT_COUNTER'].includes(normalized(order.paymentMethod))
    || !['', 'NOT_STARTED', 'UNPAID'].includes(normalized(order.paymentStatus))
    || ['paymentCapturedAt', 'paidAt', 'providerPaymentId', 'providerOrderId',
      'razorpayPaymentId', 'razorpayOrderId', 'paymentIntentId', 'checkoutSessionId',
      'refundStatus', 'refundId', 'refundRequestedAt'].some(key => hasValue(order[key]))
    || order.isPaid === true || order.paid === true || order.paymentCaptured === true
    || ['amountPaid', 'paidAmount', 'capturedAmount'].some(key => hasValue(order[key]) && Number(order[key]) !== 0)) {
    throw new HttpsError('failed-precondition', 'Paid, gateway or payment-review orders must use the existing secured cancellation and refund workflow.');
  }
}

function createRejectCustomerOrderFunction({ db, region }) {
  return onCall({ region }, async request => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Staff sign-in is required.');
    const onlineOrderId = request.data?.onlineOrderId;
    const reason = typeof request.data?.reason === 'string' ? request.data.reason.trim() : '';
    if (!validId(onlineOrderId)) throw new HttpsError('invalid-argument', 'A valid online order reference is required.');
    if (!reason || reason.length > 500) throw new HttpsError('invalid-argument', 'Enter a rejection reason of 1 to 500 characters.');

    const orderRef = db.collection('onlineOrders').doc(onlineOrderId);
    return db.runTransaction(async transaction => {
      const [staffSnap, orderSnap] = await Promise.all([
        transaction.get(db.collection('users').doc(uid)),
        transaction.get(orderRef),
      ]);
      const staff = staffSnap.exists ? staffSnap.data() : null;
      if (!staff || staff.isActive !== true || !['ADMIN', 'STORE_MANAGER', 'CASHIER'].includes(staff.role)) {
        throw new HttpsError('permission-denied', 'An active checkout staff profile is required.');
      }
      if (!orderSnap.exists) throw new HttpsError('not-found', 'Online order request no longer exists.');
      const order = orderSnap.data();
      if (!validId(order.storeId) || !isAuthorizedStaffProfile(staff, order.storeId)) {
        throw new HttpsError('permission-denied', 'This staff account cannot reject orders at this store.');
      }
      assertUnpaidCounterOrder(order);
      if (['linkedOrderId', 'linkedOrderNumber', 'convertedAt', 'acceptedAt'].some(key => hasValue(order[key]))) {
        throw new HttpsError('failed-precondition', 'An accepted or converted order must use its existing cancellation workflow.');
      }
      if (order.status === 'REJECTED') return { status: 'REJECTED', alreadyRejected: true };
      if (!['PENDING', 'NEEDS_ATTENTION'].includes(order.status)) {
        throw new HttpsError('failed-precondition', 'Only pending or needs-attention counter orders can be rejected.');
      }

      const trackingRef = validId(order.trackingToken)
        ? db.collection('publicOrderTracking').doc(order.trackingToken) : null;
      const trackingSnap = trackingRef ? await transaction.get(trackingRef) : null;
      // No menu, canonical pricing, conversion, payment, KOT or stock operations.
      // Preserve all historical monetary fields. The status transition also lets
      // the existing coupon-release trigger and pending listeners react normally.
      transaction.update(orderRef, {
        status: 'REJECTED', rejectReason: reason, customerStatusMessage: MESSAGE,
        rejectedBy: uid, rejectedByName: String(staff.name || staff.displayName || 'Staff').slice(0, 120),
        rejectedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      });
      if (trackingSnap?.exists) transaction.update(trackingRef, {
        publicStatus: 'REJECTED', customerStatusMessage: MESSAGE,
      });
      return { status: 'REJECTED', alreadyRejected: false };
    });
  });
}

module.exports = { createRejectCustomerOrderFunction };
