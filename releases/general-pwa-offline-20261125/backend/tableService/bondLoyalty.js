'use strict';

const { createHash } = require('node:crypto');
const {
  FieldValue: ModularFieldValue,
  Timestamp: ModularTimestamp,
} = require('firebase-admin/firestore');
const {
  BOND_POLICY,
  DEFAULT_LOYALTY_FLAGS,
  addCalendarMonthsIST,
  addDays,
  businessDateDaysBefore,
  calculateBondJourney,
  calculateBondPoints,
  calculateEligibleSpendPaise,
  calculateISTBusinessDate,
  resolveLoyaltyFlags,
  rupeesToPaise,
} = require('./bondLoyaltyPolicy');

const FLAGS_DOCUMENT = 'appSettings/loyalty';
const POINT_LEDGER = 'loyaltyPointLedger';
const ACCOUNTS = 'loyaltyAccounts';
const VISIT_EVENTS = 'qualifyingVisitEvents';
const VISIT_DAYS = 'qualifyingVisitDays';
/**
 * Provenance types that may earn BOND points. Online payment completed in the
 * customer app only - PRIVATE_CUSTOMER_SUBMISSION (Pay at Counter) is excluded by
 * policy. Qualifying visits use the broader origin.eligible check and are unaffected.
 */
const POINT_EARN_EVIDENCE_TYPES = new Set(['PRIVATE_CHECKOUT_SESSION']);
const MEMBERSHIPS = 'clubMemberships';
const SHADOW_LOGS = 'loyaltyShadowLogs';

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function safeDocumentId(...parts) {
  return parts
    .map(part => cleanText(part, 500).replace(/[^A-Za-z0-9_-]/g, '_'))
    .filter(Boolean)
    .join('__')
    .slice(0, 1400);
}

function pointEarnLedgerId(orderId) {
  return safeDocumentId('POINT_EARN', orderId, BOND_POLICY.policyVersion);
}

function pointEarnReversalLedgerId(orderId) {
  return safeDocumentId('POINT_EARN_REVERSAL', orderId, BOND_POLICY.policyVersion);
}

function visitEventId(orderId) {
  return safeDocumentId('QUALIFY_VISIT_ORDER', orderId, BOND_POLICY.policyVersion);
}

function visitReversalEventId(orderId) {
  return safeDocumentId('QUALIFY_VISIT_REVERSAL', orderId, BOND_POLICY.policyVersion);
}

function membershipId(customerId) {
  return safeDocumentId(customerId, BOND_POLICY.policyVersion);
}

function sha256(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function timestampMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (Number.isFinite(Number(value))) return Number(value);
  if (Number.isFinite(Number(value?._seconds))) return Number(value._seconds) * 1000;
  return 0;
}

function firestoreTypes(admin) {
  return {
    FieldValue: admin?.firestore?.FieldValue || ModularFieldValue,
    Timestamp: admin?.firestore?.Timestamp || ModularTimestamp,
  };
}

function asTimestamp(admin, value, fallbackMillis = Date.now()) {
  if (typeof value?.toMillis === 'function') return value;
  const millis = timestampMillis(value) || fallbackMillis;
  return firestoreTypes(admin).Timestamp.fromMillis(millis);
}

function authoritativeOrderTimestamp(admin, order) {
  return asTimestamp(admin, order?.settledAt || order?.createdAt || order?.updatedAt);
}

function isFinalSettledOrder(order) {
  return order?.status === 'COMPLETED'
    && order?.paymentStatus === 'PAID'
    && order?.commercialStatus !== 'COMPLIMENTARY';
}

function isVoidedOrder(order) {
  return ['VOIDED', 'CANCELLED'].includes(cleanText(order?.status, 40));
}

function isEligibleCustomerOrderingOrigin({
  orderId,
  order,
  onlineOrder,
  originEvidenceValid = false,
  originEvidenceType = null,
  allowReversedStatus = false,
}) {
  const exclusionReasons = [];
  if (order?.source !== 'CUSTOMER_WEB') exclusionReasons.push('ORDER_SOURCE_NOT_CUSTOMER_WEB');
  if (!cleanText(order?.onlineOrderId, 240)) exclusionReasons.push('MISSING_ONLINE_ORDER_ID');
  if (!onlineOrder) exclusionReasons.push('ONLINE_ORDER_NOT_FOUND');
  if (onlineOrder && onlineOrder.source !== 'CUSTOMER_WEB') exclusionReasons.push('ONLINE_ORDER_SOURCE_NOT_CUSTOMER_WEB');
  if (onlineOrder && cleanText(onlineOrder.linkedOrderId, 240) !== orderId) exclusionReasons.push('ONLINE_ORDER_LINK_MISMATCH');
  if (onlineOrder && cleanText(order?.onlineOrderId, 240) !== cleanText(onlineOrder.id, 240)) exclusionReasons.push('PROVENANCE_DOCUMENT_MISMATCH');
  if (onlineOrder && cleanText(order?.storeId, 240) !== cleanText(onlineOrder.storeId, 240)) exclusionReasons.push('STORE_MISMATCH');
  if (onlineOrder && rupeesToPaise(order?.grandTotal) !== rupeesToPaise(onlineOrder.grandTotal)) exclusionReasons.push('AMOUNT_MISMATCH');
  if (!originEvidenceValid) exclusionReasons.push('MISSING_SERVER_PROVENANCE');
  if (
    onlineOrder
    && !allowReversedStatus
    && !['CONVERTED', 'ACCEPTED'].includes(cleanText(onlineOrder.status, 60))
  ) exclusionReasons.push('ONLINE_ORDER_NOT_CONVERTED');
  const customerId = cleanText(onlineOrder?.customerUid, 128);
  if (!customerId) exclusionReasons.push('MISSING_VERIFIED_CUSTOMER_ID');
  return {
    eligible: exclusionReasons.length === 0,
    customerId: customerId || null,
    sourceOnlineOrderId: cleanText(order?.onlineOrderId, 240) || null,
    orderChannel: 'CUSTOMER_ORDERING',
    originEvidenceType: originEvidenceValid ? cleanText(originEvidenceType, 80) || null : null,
    exclusionReasons,
  };
}

function accountSeed(customerId) {
  return {
    customerId,
    pointsBalance: 0,
    lifetimePointsEarned: 0,
    lifetimePointsReversed: 0,
    qualifyingVisitCount: 0,
    rollingVisitBusinessDates: [],
    currentClubStatus: 'NONE',
    clubExpiresAt: null,
    lastQualifyingActivityAt: null,
    projectedPointsExpiryAt: null,
    policyVersion: BOND_POLICY.policyVersion,
  };
}

function currentNumber(data, field) {
  const value = Number(data?.[field]);
  return Number.isFinite(value) ? value : 0;
}

function createBondLoyaltyService({ admin, db, logger = console }) {
  const { FieldValue, Timestamp } = firestoreTypes(admin);
  async function getBondPolicy() {
    return BOND_POLICY;
  }

  async function getLoyaltyFlags() {
    const snapshot = await db.doc(FLAGS_DOCUMENT).get();
    return snapshot.exists ? resolveLoyaltyFlags(snapshot.data()) : DEFAULT_LOYALTY_FLAGS;
  }

  async function resolveOrigin(orderId, order, options = {}) {
    const onlineOrderId = cleanText(order?.onlineOrderId, 240);
    if (!onlineOrderId) {
      return isEligibleCustomerOrderingOrigin({ orderId, order, onlineOrder: null, ...options });
    }
    const snapshot = await db.collection('onlineOrders').doc(onlineOrderId).get();
    const onlineOrder = snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
    let originEvidenceValid = false;
    let originEvidenceType = null;
    if (onlineOrder) {
      const checkoutSessionId = cleanText(onlineOrder.checkoutSessionId, 240);
      const customerOrderSubmissionId = cleanText(onlineOrder.customerOrderSubmissionId, 240);
      if (checkoutSessionId) {
        const checkoutSnapshot = await db.collection('customerCheckoutSessions').doc(checkoutSessionId).get();
        const checkout = checkoutSnapshot.exists ? checkoutSnapshot.data() : null;
        originEvidenceValid = Boolean(
          checkout
          && checkout.status === 'ORDER_CREATED'
          && cleanText(checkout.customerUid, 128) === cleanText(onlineOrder.customerUid, 128)
          && cleanText(checkout.storeId, 240) === cleanText(onlineOrder.storeId, 240)
          && cleanText(checkout.onlineOrderId, 240) === onlineOrderId
        );
        if (originEvidenceValid) originEvidenceType = 'PRIVATE_CHECKOUT_SESSION';
      } else if (customerOrderSubmissionId) {
        const submissionSnapshot = await db.collection('customerOrderSubmissions').doc(customerOrderSubmissionId).get();
        const submission = submissionSnapshot.exists ? submissionSnapshot.data() : null;
        originEvidenceValid = Boolean(
          submission
          && cleanText(submission.customerUid, 128) === cleanText(onlineOrder.customerUid, 128)
          && cleanText(submission.storeId, 240) === cleanText(onlineOrder.storeId, 240)
          && cleanText(submission.onlineOrderId, 240) === onlineOrderId
        );
        if (originEvidenceValid) originEvidenceType = 'PRIVATE_CUSTOMER_SUBMISSION';
      }
    }
    return isEligibleCustomerOrderingOrigin({
      orderId,
      order,
      onlineOrder,
      originEvidenceValid,
      originEvidenceType,
      ...options,
    });
  }

  async function writeShadowLog({ orderId, order, origin, calculation, status }) {
    const ref = db.collection(SHADOW_LOGS).doc(safeDocumentId(orderId, BOND_POLICY.policyVersion));
    return db.runTransaction(async transaction => {
      const existing = await transaction.get(ref);
      if (existing.exists) return { status: 'DUPLICATE_EVENT', writes: 0 };
      const occurredAt = authoritativeOrderTimestamp(admin, order);
      transaction.create(ref, {
        orderId,
        sourceOnlineOrderId: origin.sourceOnlineOrderId,
        customerIdHash: origin.customerId ? sha256(origin.customerId).slice(0, 32) : null,
        storeId: cleanText(order?.storeId, 240) || null,
        channel: origin.eligible ? origin.orderChannel : 'INELIGIBLE',
        originEvidenceType: origin.originEvidenceType,
        eligibleSpendPaise: calculation.eligibleSpendPaise,
        expectedPoints: calculation.pointsEarned,
        expectedVisitEligibility: calculation.eligibleSpendPaise >= BOND_POLICY.visitMinimumPaise,
        istBusinessDate: calculateISTBusinessDate(occurredAt),
        exclusionReasons: origin.exclusionReasons,
        policyVersion: BOND_POLICY.policyVersion,
        sourceOrderUpdatedAt: order?.updatedAt || order?.createdAt || null,
        processedAt: FieldValue.serverTimestamp(),
        calculationStatus: status,
      });
      return { status, writes: 1 };
    });
  }

  async function ensureLoyaltyAccount(customerId) {
    const ref = db.collection(ACCOUNTS).doc(customerId);
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (snapshot.exists) return;
      transaction.create(ref, {
        ...accountSeed(customerId),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
    return ref.get();
  }

  async function postPointEarn({ orderId, order, origin, calculation, faultInjector }) {
    if (calculation.pointsEarned <= 0) return { status: 'ZERO_POINTS', writes: 0, ledgerEntryId: null };
    if (faultInjector) await faultInjector('BEFORE_LEDGER_TRANSACTION');
    const ledgerEntryId = pointEarnLedgerId(orderId);
    const ledgerRef = db.collection(POINT_LEDGER).doc(ledgerEntryId);
    const accountRef = db.collection(ACCOUNTS).doc(origin.customerId);
    const occurredAt = authoritativeOrderTimestamp(admin, order);
    const expiryAt = Timestamp.fromMillis(
      addCalendarMonthsIST(occurredAt, BOND_POLICY.pointInactivityMonths),
    );
    return db.runTransaction(async transaction => {
      const [ledgerSnapshot, accountSnapshot] = await Promise.all([
        transaction.get(ledgerRef),
        transaction.get(accountRef),
      ]);
      if (ledgerSnapshot.exists) {
        return { status: 'DUPLICATE_EVENT', writes: 0, ledgerEntryId };
      }
      const account = accountSnapshot.exists ? accountSnapshot.data() : accountSeed(origin.customerId);
      transaction.create(ledgerRef, {
        ledgerEntryId,
        customerId: origin.customerId,
        eventType: 'POINT_EARN',
        pointsDelta: calculation.pointsEarned,
        eligibleSpendPaise: calculation.eligibleSpendPaise,
        remainderPaise: calculation.remainderPaise,
        calculationEvidence: calculation.evidence,
        sourceOrderId: orderId,
        sourceOnlineOrderId: origin.sourceOnlineOrderId,
        storeId: cleanText(order?.storeId, 240),
        orderChannel: origin.orderChannel,
        originEvidenceType: origin.originEvidenceType,
        policyVersion: BOND_POLICY.policyVersion,
        idempotencyKey: ledgerEntryId,
        occurredAt,
        createdAt: FieldValue.serverTimestamp(),
      });
      const accountWrite = {
        customerId: origin.customerId,
        pointsBalance: currentNumber(account, 'pointsBalance') + calculation.pointsEarned,
        lifetimePointsEarned: currentNumber(account, 'lifetimePointsEarned') + calculation.pointsEarned,
        lifetimePointsReversed: currentNumber(account, 'lifetimePointsReversed'),
        qualifyingVisitCount: currentNumber(account, 'qualifyingVisitCount'),
        rollingVisitBusinessDates: Array.isArray(account.rollingVisitBusinessDates) ? account.rollingVisitBusinessDates : [],
        currentClubStatus: account.currentClubStatus || 'NONE',
        clubExpiresAt: account.clubExpiresAt || null,
        lastQualifyingActivityAt: occurredAt,
        projectedPointsExpiryAt: expiryAt,
        policyVersion: BOND_POLICY.policyVersion,
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (!accountSnapshot.exists) accountWrite.createdAt = FieldValue.serverTimestamp();
      transaction.set(accountRef, accountWrite, { merge: true });
      return {
        status: 'POSTED',
        writes: 2,
        ledgerEntryId,
      };
    });
  }

  async function reversePointEarn({ orderId, order, origin }) {
    const originalLedgerEntryId = pointEarnLedgerId(orderId);
    const reversalLedgerEntryId = pointEarnReversalLedgerId(orderId);
    const originalRef = db.collection(POINT_LEDGER).doc(originalLedgerEntryId);
    const reversalRef = db.collection(POINT_LEDGER).doc(reversalLedgerEntryId);
    const accountRef = db.collection(ACCOUNTS).doc(origin.customerId);
    const occurredAt = asTimestamp(admin, order?.voidedAt || order?.updatedAt || order?.createdAt);
    return db.runTransaction(async transaction => {
      const [originalSnapshot, reversalSnapshot, accountSnapshot] = await Promise.all([
        transaction.get(originalRef),
        transaction.get(reversalRef),
        transaction.get(accountRef),
      ]);
      if (reversalSnapshot.exists) return { status: 'DUPLICATE_EVENT', writes: 0 };
      if (!originalSnapshot.exists || originalSnapshot.data()?.eventType !== 'POINT_EARN') {
        return { status: 'NO_ORIGINAL_EARN', writes: 0 };
      }
      const original = originalSnapshot.data();
      const points = Math.max(0, currentNumber(original, 'pointsDelta'));
      const account = accountSnapshot.exists ? accountSnapshot.data() : accountSeed(origin.customerId);
      transaction.create(reversalRef, {
        ledgerEntryId: reversalLedgerEntryId,
        customerId: origin.customerId,
        eventType: 'POINT_EARN_REVERSAL',
        pointsDelta: -points,
        eligibleSpendPaise: currentNumber(original, 'eligibleSpendPaise'),
        sourceOrderId: orderId,
        sourceOnlineOrderId: origin.sourceOnlineOrderId,
        storeId: cleanText(order?.storeId, 240),
        orderChannel: origin.orderChannel,
        originEvidenceType: origin.originEvidenceType,
        policyVersion: BOND_POLICY.policyVersion,
        idempotencyKey: reversalLedgerEntryId,
        occurredAt,
        createdAt: FieldValue.serverTimestamp(),
        originalLedgerEntryId,
      });
      const accountWrite = {
        customerId: origin.customerId,
        pointsBalance: currentNumber(account, 'pointsBalance') - points,
        lifetimePointsEarned: currentNumber(account, 'lifetimePointsEarned'),
        lifetimePointsReversed: currentNumber(account, 'lifetimePointsReversed') + points,
        policyVersion: BOND_POLICY.policyVersion,
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (!accountSnapshot.exists) accountWrite.createdAt = FieldValue.serverTimestamp();
      transaction.set(accountRef, accountWrite, { merge: true });
      return { status: 'REVERSED', writes: 2, pointsDelta: -points };
    });
  }

  async function processCustomerOrderLoyalty({ orderId, order, flags, faultInjector } = {}) {
    if (!orderId || !order) return { status: 'INELIGIBLE_ORDER', writes: 0 };
    const effectiveFlags = flags || await getLoyaltyFlags();
    if (isVoidedOrder(order)) return reverseCustomerOrderLoyalty({ orderId, order, flags: effectiveFlags });
    if (!effectiveFlags.shadowEnabled && !effectiveFlags.earnEnabled) return { status: 'DISABLED', writes: 0 };
    const origin = await resolveOrigin(orderId, order);
    const evidence = calculateEligibleSpendPaise(order);
    const points = calculateBondPoints(evidence.eligibleSpendPaise);
    const calculation = { ...evidence, ...points, evidence };
    if (!origin.eligible) {
      if (effectiveFlags.shadowEnabled) {
        await writeShadowLog({ orderId, order, origin, calculation, status: 'INELIGIBLE_CHANNEL' });
      }
      return { status: 'INELIGIBLE_CHANNEL', writes: 0, exclusionReasons: origin.exclusionReasons };
    }
    // Points are earned only when payment completed online in the customer app.
    // PRIVATE_CHECKOUT_SESSION is the server-side proof of that: it is written solely
    // by the Razorpay payment-first flow, after signature + provider verification.
    // PRIVATE_CUSTOMER_SUBMISSION (Pay at Counter placed in the app) and POS/staff
    // orders therefore earn nothing. Applied here, at the point-earn path only, so
    // qualifying-visit eligibility is deliberately left untouched.
    if (!POINT_EARN_EVIDENCE_TYPES.has(origin.originEvidenceType)) {
      if (effectiveFlags.shadowEnabled) {
        await writeShadowLog({ orderId, order, origin, calculation, status: 'INELIGIBLE_PAYMENT_ORIGIN' });
      }
      return {
        status: 'INELIGIBLE_PAYMENT_ORIGIN',
        writes: 0,
        exclusionReasons: ['PAYMENT_NOT_COMPLETED_ONLINE'],
      };
    }
    if (!isFinalSettledOrder(order)) {
      if (effectiveFlags.shadowEnabled) {
        await writeShadowLog({ orderId, order, origin, calculation, status: 'INELIGIBLE_ORDER' });
      }
      return { status: 'INELIGIBLE_ORDER', writes: 0, exclusionReasons: ['ORDER_NOT_FINAL_AND_SETTLED'] };
    }
    if (effectiveFlags.shadowEnabled) {
      await writeShadowLog({ orderId, order, origin, calculation, status: 'MATCH' });
    }
    if (!effectiveFlags.earnEnabled) return { status: 'SHADOW_ONLY', writes: 0, calculation };
    return postPointEarn({ orderId, order, origin, calculation, faultInjector });
  }

  async function processQualifyingVisit({ orderId, order, completionTimestamp, flags } = {}) {
    const effectiveFlags = flags || await getLoyaltyFlags();
    if (!effectiveFlags.visitEnabled) return { status: 'VISITS_DISABLED', writes: 0 };
    if (!isFinalSettledOrder(order)) return { status: 'INELIGIBLE_ORDER', writes: 0 };
    if (order.orderType !== 'TAKEAWAY') {
      return { status: order.orderType === 'DELIVERY' ? 'DELIVERY_NO_VISIT' : 'NON_PICKUP_NO_VISIT', writes: 0 };
    }
    const origin = await resolveOrigin(orderId, order);
    if (!origin.eligible) return { status: 'INELIGIBLE_CHANNEL', writes: 0, exclusionReasons: origin.exclusionReasons };
    const spend = calculateEligibleSpendPaise(order);
    if (spend.eligibleSpendPaise < BOND_POLICY.visitMinimumPaise) {
      return { status: 'BELOW_VISIT_MINIMUM', writes: 0 };
    }
    const occurredAt = asTimestamp(admin, completionTimestamp);
    const businessDate = calculateISTBusinessDate(occurredAt);
    const dayLockId = safeDocumentId(origin.customerId, businessDate);
    const dayRef = db.collection(VISIT_DAYS).doc(dayLockId);
    const eventRef = db.collection(VISIT_EVENTS).doc(visitEventId(orderId));
    const accountRef = db.collection(ACCOUNTS).doc(origin.customerId);
    const clubRef = db.collection(MEMBERSHIPS).doc(membershipId(origin.customerId));
    return db.runTransaction(async transaction => {
      const [daySnapshot, eventSnapshot, accountSnapshot, membershipSnapshot] = await Promise.all([
        transaction.get(dayRef),
        transaction.get(eventRef),
        transaction.get(accountRef),
        transaction.get(clubRef),
      ]);
      if (eventSnapshot.exists) return { status: 'DUPLICATE_EVENT', writes: 0 };
      if (daySnapshot.exists) return { status: 'DAILY_VISIT_ALREADY_AWARDED', writes: 0 };
      const account = accountSnapshot.exists ? accountSnapshot.data() : accountSeed(origin.customerId);
      const windowStartDate = businessDateDaysBefore(businessDate, BOND_POLICY.qualificationWindowDays - 1);
      const currentDates = Array.isArray(account.rollingVisitBusinessDates)
        ? account.rollingVisitBusinessDates.filter(date => date >= windowStartDate && date <= businessDate)
        : [];
      const rollingDates = [...new Set([...currentDates, businessDate])].sort();
      const qualifyingVisitCount = rollingDates.length;
      const qualifiesForClub = effectiveFlags.clubEarnedEnabled
        && qualifyingVisitCount >= BOND_POLICY.clubVisitTarget
        && !membershipSnapshot.exists;
      transaction.create(dayRef, {
        lockId: dayLockId,
        customerId: origin.customerId,
        businessDate,
        sourceOrderId: orderId,
        sourceOnlineOrderId: origin.sourceOnlineOrderId,
        originEvidenceType: origin.originEvidenceType,
        policyVersion: BOND_POLICY.policyVersion,
        occurredAt,
        createdAt: FieldValue.serverTimestamp(),
      });
      transaction.create(eventRef, {
        eventId: eventRef.id,
        eventType: 'QUALIFYING_VISIT',
        visitDelta: 1,
        customerId: origin.customerId,
        businessDate,
        eligibleSpendPaise: spend.eligibleSpendPaise,
        sourceOrderId: orderId,
        sourceOnlineOrderId: origin.sourceOnlineOrderId,
        storeId: cleanText(order.storeId, 240),
        orderChannel: origin.orderChannel,
        originEvidenceType: origin.originEvidenceType,
        policyVersion: BOND_POLICY.policyVersion,
        idempotencyKey: eventRef.id,
        occurredAt,
        createdAt: FieldValue.serverTimestamp(),
      });
      const accountWrite = {
        customerId: origin.customerId,
        qualifyingVisitCount,
        rollingVisitBusinessDates: rollingDates,
        currentClubStatus: membershipSnapshot.exists || qualifiesForClub ? 'ACTIVE' : account.currentClubStatus || 'NONE',
        clubExpiresAt: membershipSnapshot.exists
          ? membershipSnapshot.data()?.expiresAt || account.clubExpiresAt || null
          : qualifiesForClub
            ? Timestamp.fromMillis(addDays(occurredAt, BOND_POLICY.membershipDays))
            : account.clubExpiresAt || null,
        policyVersion: BOND_POLICY.policyVersion,
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (!accountSnapshot.exists) Object.assign(accountWrite, {
        ...accountSeed(origin.customerId),
        qualifyingVisitCount,
        rollingVisitBusinessDates: rollingDates,
        currentClubStatus: qualifiesForClub ? 'ACTIVE' : 'NONE',
        clubExpiresAt: qualifiesForClub
          ? Timestamp.fromMillis(addDays(occurredAt, BOND_POLICY.membershipDays))
          : null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.set(accountRef, accountWrite, { merge: true });
      if (qualifiesForClub) {
        transaction.create(clubRef, {
          membershipId: clubRef.id,
          customerId: origin.customerId,
          route: 'EARNED',
          qualifiedAt: occurredAt,
          startsAt: occurredAt,
          expiresAt: Timestamp.fromMillis(addDays(occurredAt, BOND_POLICY.membershipDays)),
          qualificationWindowStart: Timestamp.fromMillis(
            addDays(occurredAt, -(BOND_POLICY.qualificationWindowDays - 1)),
          ),
          qualificationWindowEnd: occurredAt,
          qualifyingVisitCount,
          policyVersion: BOND_POLICY.policyVersion,
          status: 'ACTIVE',
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      return {
        status: qualifiesForClub ? 'VISIT_AND_CLUB_POSTED' : 'VISIT_POSTED',
        writes: qualifiesForClub ? 4 : 3,
        qualifyingVisitCount,
        businessDate,
      };
    });
  }

  async function processKotFulfillment({ before, after, kotId } = {}) {
    if (!after || before?.status === 'SERVED' || after.status !== 'SERVED') {
      return { status: 'NO_COMPLETION_TRANSITION', writes: 0 };
    }
    const orderId = cleanText(after.orderId, 240);
    if (!orderId) return { status: 'MISSING_ORDER_ID', writes: 0 };
    const flags = await getLoyaltyFlags();
    if (!flags.visitEnabled) return { status: 'VISITS_DISABLED', writes: 0 };
    const orderSnapshot = await db.collection('orders').doc(orderId).get();
    if (!orderSnapshot.exists) return { status: 'ORDER_NOT_FOUND', writes: 0 };
    return processOrderFulfillmentIfReady({
      orderId,
      order: orderSnapshot.data(),
      flags,
      sourceKotId: kotId,
    });
  }

  async function processOrderFulfillmentIfReady({ orderId, order, flags } = {}) {
    const effectiveFlags = flags || await getLoyaltyFlags();
    if (!effectiveFlags.visitEnabled) return { status: 'VISITS_DISABLED', writes: 0 };
    const kotSnapshot = await db.collection('kotItems').where('orderId', '==', orderId).get();
    const tickets = kotSnapshot.docs.map(snapshot => ({ id: snapshot.id, ...snapshot.data() }));
    const terminal = new Set(['SERVED', 'CANCELLED', 'WASTAGE_RECORDED']);
    if (!tickets.length || tickets.some(ticket => !terminal.has(ticket.status))) {
      return { status: 'PICKUP_NOT_FULLY_COMPLETED', writes: 0 };
    }
    const served = tickets.filter(ticket => ticket.status === 'SERVED');
    if (!served.length) return { status: 'NO_SERVED_ITEM', writes: 0 };
    const completionMillis = Math.max(...served.map(ticket => timestampMillis(ticket.servedAt)));
    return processQualifyingVisit({
      orderId,
      order,
      completionTimestamp: completionMillis || Date.now(),
      flags: effectiveFlags,
    });
  }

  async function reverseQualifyingVisit({ orderId, origin, order }) {
    const originalRef = db.collection(VISIT_EVENTS).doc(visitEventId(orderId));
    const reversalRef = db.collection(VISIT_EVENTS).doc(visitReversalEventId(orderId));
    const accountRef = db.collection(ACCOUNTS).doc(origin.customerId);
    const occurredAt = asTimestamp(admin, order?.voidedAt || order?.updatedAt || order?.createdAt);
    const result = await db.runTransaction(async transaction => {
      const [originalSnapshot, reversalSnapshot, accountSnapshot] = await Promise.all([
        transaction.get(originalRef),
        transaction.get(reversalRef),
        transaction.get(accountRef),
      ]);
      if (!originalSnapshot.exists) return { status: 'NO_ORIGINAL_VISIT', writes: 0 };
      if (reversalSnapshot.exists) return { status: 'DUPLICATE_EVENT', writes: 0 };
      const original = originalSnapshot.data();
      const dayRef = db.collection(VISIT_DAYS).doc(safeDocumentId(origin.customerId, original.businessDate));
      const daySnapshot = await transaction.get(dayRef);
      const account = accountSnapshot.exists ? accountSnapshot.data() : accountSeed(origin.customerId);
      const rollingDates = (Array.isArray(account.rollingVisitBusinessDates) ? account.rollingVisitBusinessDates : [])
        .filter(date => date !== original.businessDate);
      transaction.create(reversalRef, {
        eventId: reversalRef.id,
        eventType: 'QUALIFYING_VISIT_REVERSAL',
        visitDelta: -1,
        customerId: origin.customerId,
        businessDate: original.businessDate,
        sourceOrderId: orderId,
        sourceOnlineOrderId: origin.sourceOnlineOrderId,
        storeId: cleanText(order?.storeId, 240),
        orderChannel: origin.orderChannel,
        originEvidenceType: origin.originEvidenceType,
        policyVersion: BOND_POLICY.policyVersion,
        idempotencyKey: reversalRef.id,
        originalVisitEventId: originalRef.id,
        occurredAt,
        createdAt: FieldValue.serverTimestamp(),
      });
      if (daySnapshot.exists && daySnapshot.data()?.sourceOrderId === orderId) transaction.delete(dayRef);
      transaction.set(accountRef, {
        qualifyingVisitCount: rollingDates.length,
        rollingVisitBusinessDates: rollingDates,
        policyVersion: BOND_POLICY.policyVersion,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return { status: 'VISIT_REVERSED', writes: daySnapshot.exists ? 3 : 2, businessDate: original.businessDate };
    });
    if (result.businessDate) await reevaluateVisitDay(origin.customerId, result.businessDate, orderId);
    return result;
  }

  async function reevaluateVisitDay(customerId, businessDate, excludedOrderId) {
    const ledgerSnapshot = await db.collection(POINT_LEDGER).where('customerId', '==', customerId).get();
    const candidates = ledgerSnapshot.docs
      .map(snapshot => snapshot.data())
      .filter(entry => entry.eventType === 'POINT_EARN'
        && entry.sourceOrderId !== excludedOrderId
        && entry.eligibleSpendPaise >= BOND_POLICY.visitMinimumPaise
        && calculateISTBusinessDate(entry.occurredAt) === businessDate)
      .sort((left, right) => timestampMillis(left.occurredAt) - timestampMillis(right.occurredAt));
    for (const candidate of candidates) {
      const orderSnapshot = await db.collection('orders').doc(candidate.sourceOrderId).get();
      if (!orderSnapshot.exists || !isFinalSettledOrder(orderSnapshot.data())) continue;
      const kotSnapshot = await db.collection('kotItems').where('orderId', '==', candidate.sourceOrderId).get();
      const tickets = kotSnapshot.docs.map(snapshot => snapshot.data());
      if (!tickets.length || tickets.some(ticket => !['SERVED', 'CANCELLED', 'WASTAGE_RECORDED'].includes(ticket.status))) continue;
      const servedAt = Math.max(...tickets.map(ticket => timestampMillis(ticket.servedAt)), timestampMillis(candidate.occurredAt));
      const result = await processQualifyingVisit({
        orderId: candidate.sourceOrderId,
        order: orderSnapshot.data(),
        completionTimestamp: servedAt,
      });
      if (['VISIT_POSTED', 'VISIT_AND_CLUB_POSTED', 'DAILY_VISIT_ALREADY_AWARDED'].includes(result.status)) return result;
    }
    return { status: 'NO_REPLACEMENT_VISIT', writes: 0 };
  }

  async function reverseCustomerOrderLoyalty({ orderId, order, flags } = {}) {
    // Reversals are mandatory for any previously posted event even if earning is
    // subsequently switched off. With no original ledger/visit both paths are no-ops.
    void flags;
    const origin = await resolveOrigin(orderId, order, { allowReversedStatus: true });
    if (!origin.eligible) return { status: 'INELIGIBLE_CHANNEL', writes: 0, exclusionReasons: origin.exclusionReasons };
    const pointResult = await reversePointEarn({ orderId, order, origin });
    const visitResult = await reverseQualifyingVisit({ orderId, order, origin });
    return {
      status: 'REVERSAL_EVALUATED',
      writes: pointResult.writes + visitResult.writes,
      pointResult,
      visitResult,
    };
  }

  async function getCustomerOrderEarnings(customerId) {
    if (!customerId) return new Map();
    const snapshot = await db.collection(POINT_LEDGER).where('customerId', '==', customerId).get();
    const earnings = new Map();
    snapshot.docs.forEach(document => {
      const entry = document.data();
      if (entry.eventType !== 'POINT_EARN' || !entry.sourceOnlineOrderId) return;
      earnings.set(entry.sourceOnlineOrderId, currentNumber(entry, 'pointsDelta'));
    });
    return earnings;
  }

  async function getCustomerLoyaltySummary(customerId) {
    const flags = await getLoyaltyFlags();
    if (!flags.accountEnabled) {
      return { enabled: false, ...flags, policyVersion: BOND_POLICY.policyVersion };
    }
    const [accountSnapshot, membershipSnapshot] = await Promise.all([
      db.collection(ACCOUNTS).doc(customerId).get(),
      db.collection(MEMBERSHIPS).doc(membershipId(customerId)).get(),
    ]);
    const account = accountSnapshot.exists ? accountSnapshot.data() : accountSeed(customerId);
    const visits = currentNumber(account, 'qualifyingVisitCount');
    const journey = calculateBondJourney(visits);
    return {
      enabled: true,
      ...flags,
      policyVersion: BOND_POLICY.policyVersion,
      pointsBalance: currentNumber(account, 'pointsBalance'),
      qualifyingVisitCount: visits,
      currentClubStatus: membershipSnapshot.exists ? membershipSnapshot.data()?.status || 'ACTIVE' : account.currentClubStatus || 'NONE',
      clubExpiresAt: membershipSnapshot.data()?.expiresAt?.toDate?.().toISOString?.()
        || account.clubExpiresAt?.toDate?.().toISOString?.()
        || null,
      lastQualifyingActivityAt: account.lastQualifyingActivityAt?.toDate?.().toISOString?.() || null,
      projectedPointsExpiryAt: account.projectedPointsExpiryAt?.toDate?.().toISOString?.() || null,
      journey,
    };
  }

  async function getCustomerLoyaltySummaryHandler(request) {
    const customerId = cleanText(request.auth?.uid, 128);
    const signInProvider = cleanText(request.auth?.token?.firebase?.sign_in_provider, 80);
    if (!customerId || signInProvider !== 'phone') {
      const error = new Error('Verified customer phone sign-in is required.');
      error.code = 'unauthenticated';
      throw error;
    }
    return getCustomerLoyaltySummary(customerId);
  }

  async function reconcileLoyaltyAccount(customerId, { repair = false } = {}) {
    const [ledgerSnapshot, accountSnapshot, onlineOrdersSnapshot] = await Promise.all([
      db.collection(POINT_LEDGER).where('customerId', '==', customerId).get(),
      db.collection(ACCOUNTS).doc(customerId).get(),
      db.collection('onlineOrders').where('customerUid', '==', customerId).limit(100).get(),
    ]);
    const entries = ledgerSnapshot.docs.map(snapshot => ({ id: snapshot.id, ...snapshot.data() }));
    const ledgerBalance = entries.reduce((sum, entry) => sum + currentNumber(entry, 'pointsDelta'), 0);
    const projectedBalance = accountSnapshot.exists ? currentNumber(accountSnapshot.data(), 'pointsBalance') : null;
    const groups = new Map();
    entries.forEach(entry => {
      const key = `${entry.eventType}:${entry.sourceOrderId || entry.id}`;
      groups.set(key, (groups.get(key) || 0) + 1);
    });
    const duplicateEvents = [...groups.entries()].filter(([, count]) => count > 1).map(([key, count]) => ({ key, count }));
    const missingLoyaltyOrders = [];
    const missingReversals = [];
    for (const onlineSnapshot of onlineOrdersSnapshot.docs) {
      const onlineOrder = onlineSnapshot.data();
      const orderId = cleanText(onlineOrder.linkedOrderId, 240);
      if (!orderId) continue;
      const orderSnapshot = await db.collection('orders').doc(orderId).get();
      if (!orderSnapshot.exists) continue;
      const order = orderSnapshot.data();
      const earnExists = entries.some(entry => entry.id === pointEarnLedgerId(orderId));
      const reversalExists = entries.some(entry => entry.id === pointEarnReversalLedgerId(orderId));
      if (isFinalSettledOrder(order) && !earnExists) missingLoyaltyOrders.push(orderId);
      if (isVoidedOrder(order) && earnExists && !reversalExists) missingReversals.push(orderId);
    }
    const report = {
      customerId,
      ledgerBalance,
      projectedBalance,
      projectionMismatch: projectedBalance !== ledgerBalance,
      postedLedgerMissingAccountProjection: !accountSnapshot.exists && entries.length > 0,
      duplicateEvents,
      missingLoyaltyOrders,
      missingReversals,
    };
    if (repair) {
      const projectId = cleanText(process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT, 200);
      if (!projectId.startsWith('demo-')) throw new Error('Automatic loyalty repair is emulator-only.');
      await db.collection(ACCOUNTS).doc(customerId).set({
        customerId,
        pointsBalance: ledgerBalance,
        policyVersion: BOND_POLICY.policyVersion,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      report.repairedProjection = true;
    }
    return report;
  }

  async function handleOrderWrite({ before, after, orderId, faultInjector } = {}) {
    try {
      if (!after) return { status: 'ORDER_DELETED_IGNORED', writes: 0 };
      if (before?.status === after.status && before?.paymentStatus === after.paymentStatus) {
        return { status: 'NO_RELEVANT_TRANSITION', writes: 0 };
      }
      const flags = await getLoyaltyFlags();
      const orderResult = await processCustomerOrderLoyalty({
        orderId,
        order: after,
        flags,
        faultInjector,
      });
      const visitResult = !isVoidedOrder(after) && flags.visitEnabled && isFinalSettledOrder(after)
        ? await processOrderFulfillmentIfReady({ orderId, order: after, flags })
        : { status: 'VISIT_NOT_EVALUATED', writes: 0 };
      return {
        ...orderResult,
        writes: currentNumber(orderResult, 'writes') + currentNumber(visitResult, 'writes'),
        visitResult,
      };
    } catch (error) {
      logger.error('bond-loyalty-order-worker-failed', {
        orderId,
        code: cleanText(error?.code || error?.message, 160),
      });
      throw error;
    }
  }

  return {
    ensureLoyaltyAccount,
    getBondPolicy,
    getCustomerLoyaltySummary,
    getCustomerLoyaltySummaryHandler,
    getCustomerOrderEarnings,
    getLoyaltyFlags,
    handleOrderWrite,
    processCustomerOrderLoyalty,
    processKotFulfillment,
    processQualifyingVisit,
    reconcileLoyaltyAccount,
    reverseCustomerOrderLoyalty,
  };
}

module.exports = {
  ACCOUNTS,
  FLAGS_DOCUMENT,
  MEMBERSHIPS,
  POINT_LEDGER,
  SHADOW_LOGS,
  VISIT_DAYS,
  VISIT_EVENTS,
  accountSeed,
  createBondLoyaltyService,
  isEligibleCustomerOrderingOrigin,
  isFinalSettledOrder,
  membershipId,
  pointEarnLedgerId,
  pointEarnReversalLedgerId,
  safeDocumentId,
  visitEventId,
  visitReversalEventId,
};
