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
const {
  CAMPAIGN_BUDGETS,
  CAMPAIGN_CUSTOMER_USAGE,
} = require('./bondPolicyCampaignManager');
const { LEGACY_DEFAULT_EARN_BASIS_POINTS } = require('./bondPolicyCampaignEngine');
const {
  campaignCustomerUsageId,
  createBondPolicyCampaignRuntime,
} = require('./bondPolicyCampaignRuntime');

const FLAGS_DOCUMENT = 'appSettings/loyalty';
const POINT_LEDGER = 'loyaltyPointLedger';
const ACCOUNTS = 'loyaltyAccounts';
const VISIT_EVENTS = 'qualifyingVisitEvents';
const VISIT_DAYS = 'qualifyingVisitDays';
const MEMBERSHIPS = 'clubMemberships';
const SHADOW_LOGS = 'loyaltyShadowLogs';
const POINT_EARN_ZERO_DECISION = 'POINT_EARN_ZERO_DECISION';
const LEGACY_STATIC_POLICY_VERSIONS = Object.freeze(['BOND_POLICY_V1_2026']);

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
  return safeDocumentId('POINT_EARN', orderId);
}

function pointEarnReversalLedgerId(orderId) {
  return safeDocumentId('POINT_EARN_REVERSAL', orderId);
}

function visitCampaignEarnLedgerId(orderId) {
  return safeDocumentId('CAMPAIGN_VISIT_EARN', orderId);
}

function visitCampaignReversalLedgerId(orderId) {
  return safeDocumentId('CAMPAIGN_VISIT_EARN_REVERSAL', orderId);
}

function legacyPointEarnLedgerId(orderId, policyVersion = LEGACY_STATIC_POLICY_VERSIONS[0]) {
  return safeDocumentId('POINT_EARN', orderId, policyVersion);
}

function legacyPointEarnReversalLedgerId(orderId, policyVersion = LEGACY_STATIC_POLICY_VERSIONS[0]) {
  return safeDocumentId('POINT_EARN_REVERSAL', orderId, policyVersion);
}

function legacyPointEarnLedgerIds(orderId) {
  return LEGACY_STATIC_POLICY_VERSIONS.map(version => legacyPointEarnLedgerId(orderId, version));
}

function legacyPointEarnReversalLedgerIds(orderId) {
  return LEGACY_STATIC_POLICY_VERSIONS.map(version => legacyPointEarnReversalLedgerId(orderId, version));
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
  const policyCampaignRuntime = createBondPolicyCampaignRuntime({ admin, db });
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
        basePoints: currentNumber(calculation, 'basePoints'),
        campaignBonusPoints: currentNumber(calculation, 'campaignBonusPoints'),
        campaignId: calculation.campaignId || null,
        campaignVersionId: calculation.campaignVersionId || null,
        liabilityPaise: currentNumber(calculation, 'liabilityPaise'),
        expectedVisitEligibility: calculation.eligibleSpendPaise >= BOND_POLICY.visitMinimumPaise,
        istBusinessDate: calculateISTBusinessDate(occurredAt),
        exclusionReasons: origin.exclusionReasons,
        policyVersion: calculation.policyVersionId || BOND_POLICY.policyVersion,
        effectiveEarnRateBps: calculation.effectiveEarnRateBps || LEGACY_DEFAULT_EARN_BASIS_POINTS,
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

  function calculationFromRewardContext(rewardContext, legacyCalculation) {
    const { evaluation } = rewardContext;
    return {
      ...legacyCalculation,
      pointsEarned: evaluation.reward.totalPoints,
      basePoints: evaluation.reward.basePoints,
      campaignBonusPoints: evaluation.reward.campaignPoints,
      policyVersionId: evaluation.policy.policyVersionId,
      effectiveEarnRateBps: evaluation.policy.earnRateBps,
      campaignId: evaluation.campaign?.campaignId || null,
      campaignVersionId: evaluation.campaign?.campaignVersionId || null,
      liabilityPaise: evaluation.reward.totalLiabilityPaise,
    };
  }

  async function postPointEarn({ orderId, order, origin, calculation, faultInjector }) {
    if (faultInjector) await faultInjector('BEFORE_LEDGER_TRANSACTION');
    const ledgerEntryId = pointEarnLedgerId(orderId);
    const ledgerRef = db.collection(POINT_LEDGER).doc(ledgerEntryId);
    const legacyLedgerRefs = legacyPointEarnLedgerIds(orderId)
      .filter(id => id !== ledgerEntryId)
      .map(id => db.collection(POINT_LEDGER).doc(id));
    const accountRef = db.collection(ACCOUNTS).doc(origin.customerId);
    const orderRef = db.collection('orders').doc(orderId);
    const itemQuery = db.collection('orders').doc(orderId).collection('items');
    return db.runTransaction(async transaction => {
      const [ledgerSnapshot, legacyLedgerSnapshots, accountSnapshot, itemSnapshot, orderSnapshot] = await Promise.all([
        transaction.get(ledgerRef),
        Promise.all(legacyLedgerRefs.map(ref => transaction.get(ref))),
        transaction.get(accountRef),
        transaction.get(itemQuery),
        transaction.get(orderRef),
      ]);
      const existingSnapshot = ledgerSnapshot.exists
        ? ledgerSnapshot
        : legacyLedgerSnapshots.find(snapshot => snapshot.exists) || null;
      if (existingSnapshot) {
        const existing = existingSnapshot.data();
        return {
          status: 'DUPLICATE_EVENT',
          writes: 0,
          ledgerEntryId: existingSnapshot.id,
          calculation: {
            eligibleSpendPaise: currentNumber(existing, 'eligibleSpendPaise'),
            pointsEarned: currentNumber(existing, 'pointsDelta'),
            policyVersionId: existing.policyVersionId || existing.policyVersion || BOND_POLICY.policyVersion,
            campaignId: existing.campaignId || null,
            campaignVersionId: existing.campaignVersionId || null,
          },
        };
      }
      if (!orderSnapshot.exists || !isFinalSettledOrder(orderSnapshot.data())) {
        return {
          status: 'INELIGIBLE_ORDER',
          writes: 0,
          ledgerEntryId: null,
          exclusionReasons: ['AUTHORITATIVE_ORDER_NOT_FINAL_AND_SETTLED'],
        };
      }
      const authoritativeOrder = orderSnapshot.data();
      const authoritativeEvidence = calculateEligibleSpendPaise(authoritativeOrder);
      const authoritativePoints = calculateBondPoints(authoritativeEvidence.eligibleSpendPaise);
      const authoritativeCalculation = {
        ...authoritativeEvidence,
        ...authoritativePoints,
        evidence: authoritativeEvidence,
      };
      const occurredAt = authoritativeOrderTimestamp(admin, authoritativeOrder);
      const expiryAt = Timestamp.fromMillis(
        addCalendarMonthsIST(occurredAt, BOND_POLICY.pointInactivityMonths),
      );
      const account = accountSnapshot.exists ? accountSnapshot.data() : accountSeed(origin.customerId);
      const rewardContext = await policyCampaignRuntime.resolveRewardInTransaction(transaction, {
        orderId,
        order: authoritativeOrder,
        customerId: origin.customerId,
        account,
        eligibleSpendPaise: authoritativeCalculation.eligibleSpendPaise,
        itemDocuments: itemSnapshot.docs,
        deferVisitCampaign: true,
      });
      const { evaluation, baseCalculation } = rewardContext;
      const pointsEarned = evaluation.reward.totalPoints;
      if (pointsEarned <= 0) {
        const policyVersionId = evaluation.policy.policyVersionId;
        transaction.create(ledgerRef, {
          ledgerEntryId,
          customerId: origin.customerId,
          eventType: POINT_EARN_ZERO_DECISION,
          pointsDelta: 0,
          basePoints: 0,
          campaignBonusPoints: 0,
          eligibleSpendPaise: authoritativeCalculation.eligibleSpendPaise,
          remainderPaise: evaluation.policy.source === 'LEGACY_DEFAULT'
            ? authoritativeCalculation.remainderPaise
            : null,
          remainderRateUnits: baseCalculation.remainderRateUnits,
          calculationEvidence: {
            ...authoritativeCalculation.evidence,
            effectiveEarnRateBps: evaluation.policy.earnRateBps,
            basePoints: 0,
            campaignBonusPoints: 0,
            matchedProductCodes: evaluation.campaign?.matchedProductCodes || [],
            matchedCategoryCodes: evaluation.campaign?.matchedCategoryCodes || [],
            uniqueIstVisitDays: evaluation.campaign?.uniqueIstVisitDays || 0,
            decision: 'ZERO_POINTS',
          },
          sourceOrderId: orderId,
          sourceOnlineOrderId: origin.sourceOnlineOrderId,
          storeId: cleanText(authoritativeOrder?.storeId, 240),
          issuingStoreId: cleanText(authoritativeOrder?.storeId, 240),
          orderChannel: origin.orderChannel,
          originEvidenceType: origin.originEvidenceType,
          policyVersion: policyVersionId,
          policyVersionId,
          effectiveEarnRateBps: evaluation.policy.earnRateBps,
          policySource: evaluation.policy.source,
          campaignId: evaluation.campaign?.campaignId || null,
          campaignVersionId: evaluation.campaign?.campaignVersionId || null,
          campaignRewardType: evaluation.campaign?.rewardType || null,
          liabilityPaise: 0,
          baseLiabilityPaise: 0,
          campaignLiabilityPaise: 0,
          idempotencyKey: ledgerEntryId,
          occurredAt,
          createdAt: FieldValue.serverTimestamp(),
        });
        return {
          status: 'ZERO_POINTS',
          writes: 1,
          ledgerEntryId,
          calculation: {
            eligibleSpendPaise: authoritativeCalculation.eligibleSpendPaise,
            pointsEarned: 0,
            policyVersionId,
            campaignId: evaluation.campaign?.campaignId || null,
            campaignVersionId: evaluation.campaign?.campaignVersionId || null,
          },
        };
      }
      const campaignBonusPoints = evaluation.reward.campaignPoints;
      const policyVersionId = evaluation.policy.policyVersionId;
      transaction.create(ledgerRef, {
        ledgerEntryId,
        customerId: origin.customerId,
        eventType: 'POINT_EARN',
        pointsDelta: pointsEarned,
        basePoints: evaluation.reward.basePoints,
        campaignBonusPoints,
        eligibleSpendPaise: authoritativeCalculation.eligibleSpendPaise,
        remainderPaise: evaluation.policy.source === 'LEGACY_DEFAULT' ? authoritativeCalculation.remainderPaise : null,
        remainderRateUnits: baseCalculation.remainderRateUnits,
        calculationEvidence: {
          ...authoritativeCalculation.evidence,
          effectiveEarnRateBps: evaluation.policy.earnRateBps,
          basePoints: evaluation.reward.basePoints,
          campaignBonusPoints,
          matchedProductCodes: evaluation.campaign?.matchedProductCodes || [],
          matchedCategoryCodes: evaluation.campaign?.matchedCategoryCodes || [],
          uniqueIstVisitDays: evaluation.campaign?.uniqueIstVisitDays || 0,
        },
        sourceOrderId: orderId,
        sourceOnlineOrderId: origin.sourceOnlineOrderId,
        storeId: cleanText(authoritativeOrder?.storeId, 240),
        issuingStoreId: cleanText(authoritativeOrder?.storeId, 240),
        orderChannel: origin.orderChannel,
        originEvidenceType: origin.originEvidenceType,
        policyVersion: policyVersionId,
        policyVersionId,
        effectiveEarnRateBps: evaluation.policy.earnRateBps,
        policySource: evaluation.policy.source,
        campaignId: evaluation.campaign?.campaignId || null,
        campaignVersionId: evaluation.campaign?.campaignVersionId || null,
        campaignRewardType: evaluation.campaign?.rewardType || null,
        liabilityPaise: evaluation.reward.totalLiabilityPaise,
        baseLiabilityPaise: evaluation.reward.baseLiabilityPaise,
        campaignLiabilityPaise: evaluation.reward.campaignLiabilityPaise,
        idempotencyKey: ledgerEntryId,
        occurredAt,
        createdAt: FieldValue.serverTimestamp(),
      });
      const accountWrite = {
        customerId: origin.customerId,
        pointsBalance: currentNumber(account, 'pointsBalance') + pointsEarned,
        lifetimePointsEarned: currentNumber(account, 'lifetimePointsEarned') + pointsEarned,
        lifetimePointsReversed: currentNumber(account, 'lifetimePointsReversed'),
        qualifyingVisitCount: currentNumber(account, 'qualifyingVisitCount'),
        rollingVisitBusinessDates: Array.isArray(account.rollingVisitBusinessDates) ? account.rollingVisitBusinessDates : [],
        currentClubStatus: account.currentClubStatus || 'NONE',
        clubExpiresAt: account.clubExpiresAt || null,
        lastQualifyingActivityAt: occurredAt,
        projectedPointsExpiryAt: expiryAt,
        policyVersion: policyVersionId,
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (!accountSnapshot.exists) accountWrite.createdAt = FieldValue.serverTimestamp();
      transaction.set(accountRef, accountWrite, { merge: true });
      const campaignWrites = policyCampaignRuntime.applyCampaignAwardInTransaction(
        transaction,
        rewardContext,
        {
          customerId: origin.customerId,
          storeId: authoritativeOrder?.storeId,
          FieldValue,
        },
      );
      return {
        status: 'POSTED',
        writes: 2 + campaignWrites,
        ledgerEntryId,
        calculation: {
          eligibleSpendPaise: authoritativeCalculation.eligibleSpendPaise,
          pointsEarned,
          basePoints: evaluation.reward.basePoints,
          campaignBonusPoints,
          policyVersionId,
          effectiveEarnRateBps: evaluation.policy.earnRateBps,
          campaignId: evaluation.campaign?.campaignId || null,
          campaignVersionId: evaluation.campaign?.campaignVersionId || null,
          liabilityPaise: evaluation.reward.totalLiabilityPaise,
        },
      };
    });
  }

  async function postVisitCampaignBonus({ orderId, origin, completionTimestamp }) {
    const ledgerEntryId = visitCampaignEarnLedgerId(orderId);
    const ledgerRef = db.collection(POINT_LEDGER).doc(ledgerEntryId);
    const accountRef = db.collection(ACCOUNTS).doc(origin.customerId);
    const orderRef = db.collection('orders').doc(orderId);
    const itemQuery = orderRef.collection('items');
    const occurredAt = asTimestamp(admin, completionTimestamp);
    return db.runTransaction(async transaction => {
      const [ledgerSnapshot, accountSnapshot, itemSnapshot, orderSnapshot] = await Promise.all([
        transaction.get(ledgerRef),
        transaction.get(accountRef),
        transaction.get(itemQuery),
        transaction.get(orderRef),
      ]);
      if (ledgerSnapshot.exists) {
        return { status: 'DUPLICATE_CAMPAIGN_EVENT', writes: 0, ledgerEntryId };
      }
      if (!orderSnapshot.exists || !isFinalSettledOrder(orderSnapshot.data())) {
        return { status: 'INELIGIBLE_ORDER', writes: 0 };
      }
      const authoritativeOrder = orderSnapshot.data();
      const evidence = calculateEligibleSpendPaise(authoritativeOrder);
      const account = accountSnapshot.exists ? accountSnapshot.data() : accountSeed(origin.customerId);
      const rewardContext = await policyCampaignRuntime.resolveRewardInTransaction(transaction, {
        orderId,
        order: authoritativeOrder,
        customerId: origin.customerId,
        account,
        eligibleSpendPaise: evidence.eligibleSpendPaise,
        itemDocuments: itemSnapshot.docs,
        eventAtOverride: occurredAt,
      });
      const { evaluation } = rewardContext;
      const campaignBonusPoints = evaluation.reward.campaignPoints;
      if (!rewardContext.requiresVisitEvidence || !evaluation.campaign || campaignBonusPoints <= 0) {
        return {
          status: 'NO_VISIT_CAMPAIGN_AWARD',
          writes: 0,
          reasons: evaluation.campaign?.ineligibilityReasons || [],
        };
      }
      const policyVersionId = evaluation.policy.policyVersionId;
      transaction.create(ledgerRef, {
        ledgerEntryId,
        customerId: origin.customerId,
        eventType: 'CAMPAIGN_BONUS_EARN',
        pointsDelta: campaignBonusPoints,
        basePoints: 0,
        campaignBonusPoints,
        eligibleSpendPaise: evidence.eligibleSpendPaise,
        calculationEvidence: {
          ...evidence,
          effectiveEarnRateBps: evaluation.policy.earnRateBps,
          basePoints: 0,
          campaignBonusPoints,
          matchedProductCodes: evaluation.campaign.matchedProductCodes || [],
          matchedCategoryCodes: evaluation.campaign.matchedCategoryCodes || [],
          uniqueIstVisitDays: evaluation.campaign.uniqueIstVisitDays || 0,
          qualifyingVisitBusinessDate: calculateISTBusinessDate(occurredAt),
        },
        sourceOrderId: orderId,
        sourceOnlineOrderId: origin.sourceOnlineOrderId,
        storeId: cleanText(authoritativeOrder.storeId, 240),
        issuingStoreId: cleanText(authoritativeOrder.storeId, 240),
        orderChannel: origin.orderChannel,
        originEvidenceType: origin.originEvidenceType,
        policyVersion: policyVersionId,
        policyVersionId,
        effectiveEarnRateBps: evaluation.policy.earnRateBps,
        policySource: evaluation.policy.source,
        campaignId: evaluation.campaign.campaignId,
        campaignVersionId: evaluation.campaign.campaignVersionId,
        campaignRewardType: evaluation.campaign.rewardType,
        liabilityPaise: evaluation.reward.campaignLiabilityPaise,
        baseLiabilityPaise: 0,
        campaignLiabilityPaise: evaluation.reward.campaignLiabilityPaise,
        idempotencyKey: ledgerEntryId,
        occurredAt,
        createdAt: FieldValue.serverTimestamp(),
      });
      const expiryAt = Timestamp.fromMillis(
        addCalendarMonthsIST(occurredAt, BOND_POLICY.pointInactivityMonths),
      );
      const accountWrite = {
        customerId: origin.customerId,
        pointsBalance: currentNumber(account, 'pointsBalance') + campaignBonusPoints,
        lifetimePointsEarned: currentNumber(account, 'lifetimePointsEarned') + campaignBonusPoints,
        lifetimePointsReversed: currentNumber(account, 'lifetimePointsReversed'),
        policyVersion: policyVersionId,
        lastQualifyingActivityAt: occurredAt,
        projectedPointsExpiryAt: expiryAt,
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (!accountSnapshot.exists) accountWrite.createdAt = FieldValue.serverTimestamp();
      transaction.set(accountRef, accountWrite, { merge: true });
      const campaignWrites = policyCampaignRuntime.applyCampaignAwardInTransaction(
        transaction,
        rewardContext,
        {
          customerId: origin.customerId,
          storeId: authoritativeOrder.storeId,
          FieldValue,
        },
      );
      return {
        status: 'CAMPAIGN_BONUS_POSTED',
        writes: 2 + campaignWrites,
        ledgerEntryId,
        pointsEarned: campaignBonusPoints,
        campaignId: evaluation.campaign.campaignId,
        campaignVersionId: evaluation.campaign.campaignVersionId,
      };
    });
  }

  async function reversePointEarn({ orderId, order, origin }) {
    const stableOriginalLedgerEntryId = pointEarnLedgerId(orderId);
    const reversalLedgerEntryId = pointEarnReversalLedgerId(orderId);
    const originalRefs = [
      db.collection(POINT_LEDGER).doc(stableOriginalLedgerEntryId),
      ...legacyPointEarnLedgerIds(orderId)
        .filter(id => id !== stableOriginalLedgerEntryId)
        .map(id => db.collection(POINT_LEDGER).doc(id)),
    ];
    const reversalRef = db.collection(POINT_LEDGER).doc(reversalLedgerEntryId);
    const legacyReversalRefs = legacyPointEarnReversalLedgerIds(orderId)
      .filter(id => id !== reversalLedgerEntryId)
      .map(id => db.collection(POINT_LEDGER).doc(id));
    const accountRef = db.collection(ACCOUNTS).doc(origin.customerId);
    const occurredAt = asTimestamp(admin, order?.voidedAt || order?.updatedAt || order?.createdAt);
    return db.runTransaction(async transaction => {
      const [originalSnapshots, reversalSnapshot, legacyReversalSnapshots, accountSnapshot] = await Promise.all([
        Promise.all(originalRefs.map(ref => transaction.get(ref))),
        transaction.get(reversalRef),
        Promise.all(legacyReversalRefs.map(ref => transaction.get(ref))),
        transaction.get(accountRef),
      ]);
      if (reversalSnapshot.exists || legacyReversalSnapshots.some(snapshot => snapshot.exists)) {
        return { status: 'DUPLICATE_EVENT', writes: 0 };
      }
      const originalSnapshot = originalSnapshots.find(snapshot => (
        snapshot.exists && snapshot.data()?.eventType === 'POINT_EARN'
      )) || originalSnapshots.find(snapshot => snapshot.exists) || null;
      if (!originalSnapshot || originalSnapshot.data()?.eventType !== 'POINT_EARN') {
        return { status: 'NO_ORIGINAL_EARN', writes: 0 };
      }
      const originalLedgerEntryId = originalSnapshot.id;
      const original = originalSnapshot.data();
      const points = Math.max(0, currentNumber(original, 'pointsDelta'));
      const campaignBonusPoints = Math.max(0, currentNumber(original, 'campaignBonusPoints'));
      const account = accountSnapshot.exists ? accountSnapshot.data() : accountSeed(origin.customerId);
      let budgetRef = null;
      let usageRef = null;
      let budgetSnapshot = null;
      let usageSnapshot = null;
      if (campaignBonusPoints > 0) {
        const campaignVersionId = cleanText(original.campaignVersionId, 180);
        if (!campaignVersionId) {
          throw new Error('Campaign reward ledger is missing its immutable campaign version.');
        }
        budgetRef = db.collection(CAMPAIGN_BUDGETS).doc(campaignVersionId);
        usageRef = db.collection(CAMPAIGN_CUSTOMER_USAGE)
          .doc(campaignCustomerUsageId(campaignVersionId, origin.customerId));
        [budgetSnapshot, usageSnapshot] = await Promise.all([
          transaction.get(budgetRef),
          transaction.get(usageRef),
        ]);
        if (!budgetSnapshot.exists || !usageSnapshot.exists) {
          throw new Error('Campaign reward projections are missing; reversal failed closed.');
        }
      }
      transaction.create(reversalRef, {
        ledgerEntryId: reversalLedgerEntryId,
        customerId: origin.customerId,
        eventType: 'POINT_EARN_REVERSAL',
        pointsDelta: -points,
        basePoints: -Math.max(0, currentNumber(original, 'basePoints')),
        campaignBonusPoints: -campaignBonusPoints,
        eligibleSpendPaise: currentNumber(original, 'eligibleSpendPaise'),
        sourceOrderId: orderId,
        sourceOnlineOrderId: origin.sourceOnlineOrderId,
        storeId: cleanText(order?.storeId, 240),
        issuingStoreId: original.issuingStoreId || cleanText(order?.storeId, 240),
        orderChannel: origin.orderChannel,
        originEvidenceType: origin.originEvidenceType,
        policyVersion: original.policyVersionId || original.policyVersion || BOND_POLICY.policyVersion,
        policyVersionId: original.policyVersionId || original.policyVersion || BOND_POLICY.policyVersion,
        effectiveEarnRateBps: original.effectiveEarnRateBps || null,
        campaignId: original.campaignId || null,
        campaignVersionId: original.campaignVersionId || null,
        campaignRewardType: original.campaignRewardType || null,
        liabilityPaise: -Math.max(0, currentNumber(original, 'liabilityPaise')),
        baseLiabilityPaise: -Math.max(0, currentNumber(original, 'baseLiabilityPaise')),
        campaignLiabilityPaise: -Math.max(0, currentNumber(original, 'campaignLiabilityPaise')),
        calculationEvidence: {
          reversalOfLedgerEntryId: originalLedgerEntryId,
          originalCalculationEvidence: original.calculationEvidence || null,
        },
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
        policyVersion: original.policyVersionId || original.policyVersion || BOND_POLICY.policyVersion,
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (!accountSnapshot.exists) accountWrite.createdAt = FieldValue.serverTimestamp();
      transaction.set(accountRef, accountWrite, { merge: true });
      let campaignWrites = 0;
      if (campaignBonusPoints > 0) {
        const budget = budgetSnapshot.data();
        const usage = usageSnapshot.data();
        const budgetNet = currentNumber(budget, 'netConsumedPoints') - campaignBonusPoints;
        const usageNetPoints = currentNumber(usage, 'netPoints') - campaignBonusPoints;
        const usageNetAwards = currentNumber(usage, 'netAwardCount') - 1;
        if (budgetNet < 0 || usageNetPoints < 0 || usageNetAwards < 0) {
          throw new Error('Campaign reversal would make an immutable projection negative.');
        }
        transaction.update(budgetRef, {
          reversedPoints: currentNumber(budget, 'reversedPoints') + campaignBonusPoints,
          netConsumedPoints: budgetNet,
          updatedAt: FieldValue.serverTimestamp(),
        });
        transaction.update(usageRef, {
          reversedAwardCount: currentNumber(usage, 'reversedAwardCount') + 1,
          netAwardCount: usageNetAwards,
          reversedPoints: currentNumber(usage, 'reversedPoints') + campaignBonusPoints,
          netPoints: usageNetPoints,
          updatedAt: FieldValue.serverTimestamp(),
        });
        campaignWrites = 2;
      }
      return { status: 'REVERSED', writes: 2 + campaignWrites, pointsDelta: -points };
    });
  }

  async function reverseVisitCampaignBonus({ orderId, order, origin }) {
    const originalRef = db.collection(POINT_LEDGER).doc(visitCampaignEarnLedgerId(orderId));
    const reversalLedgerEntryId = visitCampaignReversalLedgerId(orderId);
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
      if (!originalSnapshot.exists || originalSnapshot.data()?.eventType !== 'CAMPAIGN_BONUS_EARN') {
        return { status: 'NO_ORIGINAL_CAMPAIGN_BONUS', writes: 0 };
      }
      const original = originalSnapshot.data();
      const points = Math.max(0, currentNumber(original, 'pointsDelta'));
      const campaignVersionId = cleanText(original.campaignVersionId, 180);
      if (!points || !campaignVersionId) {
        throw new Error('Campaign bonus ledger is missing immutable reversal evidence.');
      }
      const budgetRef = db.collection(CAMPAIGN_BUDGETS).doc(campaignVersionId);
      const usageRef = db.collection(CAMPAIGN_CUSTOMER_USAGE)
        .doc(campaignCustomerUsageId(campaignVersionId, origin.customerId));
      const [budgetSnapshot, usageSnapshot] = await Promise.all([
        transaction.get(budgetRef),
        transaction.get(usageRef),
      ]);
      if (!budgetSnapshot.exists || !usageSnapshot.exists) {
        throw new Error('Campaign bonus projections are missing; reversal failed closed.');
      }
      const budget = budgetSnapshot.data();
      const usage = usageSnapshot.data();
      const account = accountSnapshot.exists ? accountSnapshot.data() : accountSeed(origin.customerId);
      const budgetNet = currentNumber(budget, 'netConsumedPoints') - points;
      const usageNetPoints = currentNumber(usage, 'netPoints') - points;
      const usageNetAwards = currentNumber(usage, 'netAwardCount') - 1;
      if (budgetNet < 0 || usageNetPoints < 0 || usageNetAwards < 0) {
        throw new Error('Campaign bonus reversal would make an immutable projection negative.');
      }
      transaction.create(reversalRef, {
        ledgerEntryId: reversalLedgerEntryId,
        customerId: origin.customerId,
        eventType: 'CAMPAIGN_BONUS_REVERSAL',
        pointsDelta: -points,
        basePoints: 0,
        campaignBonusPoints: -points,
        eligibleSpendPaise: currentNumber(original, 'eligibleSpendPaise'),
        sourceOrderId: orderId,
        sourceOnlineOrderId: origin.sourceOnlineOrderId,
        storeId: cleanText(order?.storeId, 240),
        issuingStoreId: original.issuingStoreId || cleanText(order?.storeId, 240),
        orderChannel: origin.orderChannel,
        originEvidenceType: origin.originEvidenceType,
        policyVersion: original.policyVersionId || original.policyVersion || BOND_POLICY.policyVersion,
        policyVersionId: original.policyVersionId || original.policyVersion || BOND_POLICY.policyVersion,
        effectiveEarnRateBps: original.effectiveEarnRateBps || null,
        campaignId: original.campaignId,
        campaignVersionId,
        campaignRewardType: original.campaignRewardType || null,
        liabilityPaise: -Math.max(0, currentNumber(original, 'liabilityPaise')),
        baseLiabilityPaise: 0,
        campaignLiabilityPaise: -Math.max(0, currentNumber(original, 'campaignLiabilityPaise')),
        calculationEvidence: {
          reversalOfLedgerEntryId: originalRef.id,
          originalCalculationEvidence: original.calculationEvidence || null,
        },
        originalLedgerEntryId: originalRef.id,
        idempotencyKey: reversalLedgerEntryId,
        occurredAt,
        createdAt: FieldValue.serverTimestamp(),
      });
      transaction.set(accountRef, {
        customerId: origin.customerId,
        pointsBalance: currentNumber(account, 'pointsBalance') - points,
        lifetimePointsEarned: currentNumber(account, 'lifetimePointsEarned'),
        lifetimePointsReversed: currentNumber(account, 'lifetimePointsReversed') + points,
        policyVersion: original.policyVersionId || original.policyVersion || BOND_POLICY.policyVersion,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.update(budgetRef, {
        reversedPoints: currentNumber(budget, 'reversedPoints') + points,
        netConsumedPoints: budgetNet,
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.update(usageRef, {
        reversedAwardCount: currentNumber(usage, 'reversedAwardCount') + 1,
        netAwardCount: usageNetAwards,
        reversedPoints: currentNumber(usage, 'reversedPoints') + points,
        netPoints: usageNetPoints,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { status: 'CAMPAIGN_BONUS_REVERSED', writes: 4, pointsDelta: -points };
    });
  }

  async function processCustomerOrderLoyalty({ orderId, order, flags, faultInjector } = {}) {
    if (!orderId || !order) return { status: 'INELIGIBLE_ORDER', writes: 0 };
    const effectiveFlags = flags || await getLoyaltyFlags();
    if (isVoidedOrder(order)) {
      return reverseCustomerOrderLoyalty({
        orderId,
        order,
        flags: effectiveFlags,
        faultInjector,
      });
    }
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
    if (!isFinalSettledOrder(order)) {
      if (effectiveFlags.shadowEnabled) {
        await writeShadowLog({ orderId, order, origin, calculation, status: 'INELIGIBLE_ORDER' });
      }
      return { status: 'INELIGIBLE_ORDER', writes: 0, exclusionReasons: ['ORDER_NOT_FINAL_AND_SETTLED'] };
    }
    if (!effectiveFlags.earnEnabled) {
      const rewardContext = await policyCampaignRuntime.resolveReward({
        orderId,
        order,
        customerId: origin.customerId,
        eligibleSpendPaise: calculation.eligibleSpendPaise,
      });
      const managedCalculation = calculationFromRewardContext(rewardContext, calculation);
      if (effectiveFlags.shadowEnabled) {
        await writeShadowLog({ orderId, order, origin, calculation: managedCalculation, status: 'MATCH' });
      }
      return { status: 'SHADOW_ONLY', writes: 0, calculation: managedCalculation };
    }
    const result = await postPointEarn({ orderId, order, origin, calculation, faultInjector });
    if (effectiveFlags.shadowEnabled) {
      await writeShadowLog({
        orderId,
        order,
        origin,
        calculation: { ...calculation, ...(result.calculation || {}) },
        status: 'MATCH',
      });
    }
    return result;
  }

  async function processQualifyingVisit({ orderId, order, completionTimestamp, flags, faultInjector } = {}) {
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
    const orderRef = db.collection('orders').doc(orderId);
    if (faultInjector) await faultInjector('BEFORE_VISIT_TRANSACTION');
    const visitResult = await db.runTransaction(async transaction => {
      const [daySnapshot, eventSnapshot, accountSnapshot, membershipSnapshot, orderSnapshot] = await Promise.all([
        transaction.get(dayRef),
        transaction.get(eventRef),
        transaction.get(accountRef),
        transaction.get(clubRef),
        transaction.get(orderRef),
      ]);
      if (eventSnapshot.exists) return { status: 'DUPLICATE_EVENT', writes: 0 };
      if (daySnapshot.exists) return { status: 'DAILY_VISIT_ALREADY_AWARDED', writes: 0 };
      if (!orderSnapshot.exists || !isFinalSettledOrder(orderSnapshot.data())) {
        return {
          status: 'INELIGIBLE_ORDER',
          writes: 0,
          exclusionReasons: ['AUTHORITATIVE_ORDER_NOT_FINAL_AND_SETTLED'],
        };
      }
      const authoritativeOrder = orderSnapshot.data();
      if (authoritativeOrder.orderType !== 'TAKEAWAY') {
        return {
          status: authoritativeOrder.orderType === 'DELIVERY' ? 'DELIVERY_NO_VISIT' : 'NON_PICKUP_NO_VISIT',
          writes: 0,
        };
      }
      const authoritativeSpend = calculateEligibleSpendPaise(authoritativeOrder);
      if (authoritativeSpend.eligibleSpendPaise < BOND_POLICY.visitMinimumPaise) {
        return { status: 'BELOW_VISIT_MINIMUM', writes: 0 };
      }
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
        eligibleSpendPaise: authoritativeSpend.eligibleSpendPaise,
        sourceOrderId: orderId,
        sourceOnlineOrderId: origin.sourceOnlineOrderId,
        storeId: cleanText(authoritativeOrder.storeId, 240),
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
    const visitBelongsToOrder = ['VISIT_POSTED', 'VISIT_AND_CLUB_POSTED', 'DUPLICATE_EVENT']
      .includes(visitResult.status);
    if (!visitBelongsToOrder || !effectiveFlags.earnEnabled) return visitResult;
    if (faultInjector) await faultInjector('AFTER_VISIT_TRANSACTION_BEFORE_CAMPAIGN');
    const campaignResult = await postVisitCampaignBonus({
      orderId,
      origin,
      completionTimestamp: occurredAt,
    });
    return {
      ...visitResult,
      writes: currentNumber(visitResult, 'writes') + currentNumber(campaignResult, 'writes'),
      campaignResult,
    };
  }

  async function processKotFulfillment({ before, after, kotId, faultInjector } = {}) {
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
      faultInjector,
    });
  }

  async function processOrderFulfillmentIfReady({ orderId, order, flags, faultInjector } = {}) {
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
      faultInjector,
    });
  }

  async function reverseQualifyingVisit({ orderId, origin, order, faultInjector }) {
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
      if (reversalSnapshot.exists) {
        return {
          status: 'DUPLICATE_EVENT',
          writes: 0,
          businessDate: cleanText(originalSnapshot.data()?.businessDate, 20) || null,
        };
      }
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
    if (result.businessDate) {
      if (faultInjector) await faultInjector('AFTER_VISIT_REVERSAL_TRANSACTION');
      await reevaluateVisitDay(origin.customerId, result.businessDate, orderId);
    }
    return result;
  }

  async function reevaluateVisitDay(customerId, businessDate, excludedOrderId) {
    const ledgerSnapshot = await db.collection(POINT_LEDGER).where('customerId', '==', customerId).get();
    const candidates = ledgerSnapshot.docs
      .map(snapshot => snapshot.data())
      .filter(entry => ['POINT_EARN', POINT_EARN_ZERO_DECISION].includes(entry.eventType)
        && entry.sourceOrderId !== excludedOrderId
        && entry.eligibleSpendPaise >= BOND_POLICY.visitMinimumPaise)
      .sort((left, right) => timestampMillis(left.occurredAt) - timestampMillis(right.occurredAt));
    for (const candidate of candidates) {
      const orderSnapshot = await db.collection('orders').doc(candidate.sourceOrderId).get();
      if (!orderSnapshot.exists || !isFinalSettledOrder(orderSnapshot.data())) continue;
      const kotSnapshot = await db.collection('kotItems').where('orderId', '==', candidate.sourceOrderId).get();
      const tickets = kotSnapshot.docs.map(snapshot => snapshot.data());
      if (!tickets.length || tickets.some(ticket => !['SERVED', 'CANCELLED', 'WASTAGE_RECORDED'].includes(ticket.status))) continue;
      const servedTickets = tickets.filter(ticket => ticket.status === 'SERVED');
      if (!servedTickets.length) continue;
      const servedAt = Math.max(...servedTickets.map(ticket => timestampMillis(ticket.servedAt)));
      if (!servedAt || calculateISTBusinessDate(servedAt) !== businessDate) continue;
      const result = await processQualifyingVisit({
        orderId: candidate.sourceOrderId,
        order: orderSnapshot.data(),
        completionTimestamp: servedAt,
      });
      if (['VISIT_POSTED', 'VISIT_AND_CLUB_POSTED', 'DAILY_VISIT_ALREADY_AWARDED'].includes(result.status)) return result;
    }
    return { status: 'NO_REPLACEMENT_VISIT', writes: 0 };
  }

  async function reverseCustomerOrderLoyalty({ orderId, order, flags, faultInjector } = {}) {
    // Reversals are mandatory for any previously posted event even if earning is
    // subsequently switched off. With no original ledger/visit both paths are no-ops.
    void flags;
    const origin = await resolveOrigin(orderId, order, { allowReversedStatus: true });
    if (!origin.eligible) return { status: 'INELIGIBLE_CHANNEL', writes: 0, exclusionReasons: origin.exclusionReasons };
    const pointResult = await reversePointEarn({ orderId, order, origin });
    const campaignResult = await reverseVisitCampaignBonus({ orderId, order, origin });
    const visitResult = await reverseQualifyingVisit({ orderId, order, origin, faultInjector });
    return {
      status: 'REVERSAL_EVALUATED',
      writes: pointResult.writes + campaignResult.writes + visitResult.writes,
      pointResult,
      campaignResult,
      visitResult,
    };
  }

  async function getCustomerOrderEarnings(customerId) {
    if (!customerId) return new Map();
    const snapshot = await db.collection(POINT_LEDGER).where('customerId', '==', customerId).get();
    const earnings = new Map();
    snapshot.docs.forEach(document => {
      const entry = document.data();
      if (!['POINT_EARN', 'CAMPAIGN_BONUS_EARN'].includes(entry.eventType) || !entry.sourceOnlineOrderId) return;
      earnings.set(
        entry.sourceOnlineOrderId,
        (earnings.get(entry.sourceOnlineOrderId) || 0) + currentNumber(entry, 'pointsDelta'),
      );
    });
    return earnings;
  }

  async function getCustomerLoyaltySummary(customerId, storeId = null) {
    const flags = await getLoyaltyFlags();
    if (!flags.accountEnabled) {
      return { enabled: false, ...flags, policyVersion: BOND_POLICY.policyVersion };
    }
    const effectivePolicyPromise = storeId
      ? policyCampaignRuntime.resolveCurrentPolicy({ storeId })
      : Promise.resolve({
        effectiveEarnRateBps: LEGACY_DEFAULT_EARN_BASIS_POINTS,
        effectivePolicyVersionId: BOND_POLICY.policyVersion,
        policySource: 'LEGACY_DEFAULT',
      });
    const [accountSnapshot, membershipSnapshot, effectivePolicy] = await Promise.all([
      db.collection(ACCOUNTS).doc(customerId).get(),
      db.collection(MEMBERSHIPS).doc(membershipId(customerId)).get(),
      effectivePolicyPromise,
    ]);
    const account = accountSnapshot.exists ? accountSnapshot.data() : accountSeed(customerId);
    const visits = currentNumber(account, 'qualifyingVisitCount');
    const journey = calculateBondJourney(visits);
    return {
      enabled: true,
      ...flags,
      policyVersion: effectivePolicy.effectivePolicyVersionId,
      effectivePolicyVersionId: effectivePolicy.effectivePolicyVersionId,
      effectiveEarnRateBps: effectivePolicy.effectiveEarnRateBps,
      policySource: effectivePolicy.policySource,
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
    const storeId = cleanText(request.data?.storeId, 180) || null;
    return getCustomerLoyaltySummary(customerId, storeId);
  }

  async function reconcileLoyaltyAccount(customerId, { repair = false } = {}) {
    const [ledgerSnapshot, accountSnapshot, onlineOrdersSnapshot] = await Promise.all([
      db.collection(POINT_LEDGER).where('customerId', '==', customerId).get(),
      db.collection(ACCOUNTS).doc(customerId).get(),
      db.collection('onlineOrders').where('customerUid', '==', customerId).limit(100).get(),
    ]);
    const entries = ledgerSnapshot.docs.map(snapshot => ({ id: snapshot.id, ...snapshot.data() }));
    const financialEntries = entries.filter(entry => entry.eventType !== POINT_EARN_ZERO_DECISION);
    const ledgerBalance = financialEntries.reduce((sum, entry) => sum + currentNumber(entry, 'pointsDelta'), 0);
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
      const pointDecision = entries.find(entry => (
        entry.sourceOrderId === orderId
        && ['POINT_EARN', POINT_EARN_ZERO_DECISION].includes(entry.eventType)
      ));
      const reversalExists = entries.some(entry => (
        entry.sourceOrderId === orderId && entry.eventType === 'POINT_EARN_REVERSAL'
      ));
      if (isFinalSettledOrder(order) && !pointDecision) missingLoyaltyOrders.push(orderId);
      if (isVoidedOrder(order) && pointDecision?.eventType === 'POINT_EARN' && !reversalExists) {
        missingReversals.push(orderId);
      }
    }
    const report = {
      customerId,
      ledgerBalance,
      projectedBalance,
      projectionMismatch: financialEntries.length > 0 ? projectedBalance !== ledgerBalance : false,
      postedLedgerMissingAccountProjection: !accountSnapshot.exists && financialEntries.length > 0,
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
  POINT_EARN_ZERO_DECISION,
  SHADOW_LOGS,
  VISIT_DAYS,
  VISIT_EVENTS,
  accountSeed,
  createBondLoyaltyService,
  isEligibleCustomerOrderingOrigin,
  isFinalSettledOrder,
  legacyPointEarnLedgerId,
  legacyPointEarnReversalLedgerId,
  membershipId,
  pointEarnLedgerId,
  pointEarnReversalLedgerId,
  safeDocumentId,
  visitCampaignEarnLedgerId,
  visitCampaignReversalLedgerId,
  visitEventId,
  visitReversalEventId,
};
