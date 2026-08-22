'use strict';

const {
  calculateEarnPoints,
  evaluateBondReward,
} = require('./bondPolicyCampaignEngine');
const {
  CAMPAIGN_BUDGETS,
  CAMPAIGN_CUSTOMER_USAGE,
  CAMPAIGN_SCOPES,
  CAMPAIGN_VERSIONS,
  GUARDRAIL_VERSIONS,
  POLICY_SCOPES,
  POLICY_VERSIONS,
  definitionHash,
} = require('./bondPolicyCampaignManager');

const SEGMENT_LIMIT = 25;
const QUALIFYING_VISIT_DAYS = 'qualifyingVisitDays';
const SUPPORTED_VERSION_STATES = new Set(['APPROVED', 'SCHEDULED']);

class BondPolicyRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BondPolicyRuntimeError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new BondPolicyRuntimeError(code, message, details);
}

function cleanText(value, maxLength = 240) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function timestampMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (typeof value === 'string') return Date.parse(value);
  if (Number.isFinite(Number(value))) return Number(value);
  return 0;
}

function currentNumber(data, field) {
  const value = Number(data?.[field]);
  return Number.isFinite(value) ? value : 0;
}

function campaignCustomerUsageId(versionId, customerId) {
  const left = cleanText(versionId, 180).replace(/[^A-Za-z0-9_-]/g, '_');
  const right = cleanText(customerId, 180).replace(/[^A-Za-z0-9_-]/g, '_');
  if (!left || !right) fail('BOND_INVALID_CAMPAIGN_USAGE_KEY', 'Campaign usage requires a version and customer.');
  return `${left}__${right}`;
}

function activeSegment(snapshot, eventAtMillis, expectedType, scopeKey) {
  const candidates = snapshot.docs
    .map(document => ({ id: document.id, ...document.data() }))
    .filter(segment => segment.configurationType === expectedType)
    .filter(segment => timestampMillis(segment.startsAt) <= eventAtMillis)
    .filter(segment => {
      const endsAt = timestampMillis(segment.endsAt);
      return !endsAt || eventAtMillis < endsAt;
    });
  if (candidates.length > 1) {
    fail(
      expectedType === 'CAMPAIGN' ? 'BOND_CAMPAIGN_WINDOW_OVERLAP' : 'BOND_POLICY_WINDOW_OVERLAP',
      `Multiple ${expectedType.toLowerCase()} schedules are active for ${scopeKey}.`,
      { scopeKey, scheduleIds: candidates.map(candidate => candidate.scheduleId || candidate.id) },
    );
  }
  return candidates[0] || null;
}

function segmentQuery(db, admin, collectionName, scopeKey, eventAtMillis) {
  return db.collection(collectionName)
    .doc(scopeKey)
    .collection('segments')
    .where('startsAt', '<=', admin.firestore.Timestamp.fromMillis(eventAtMillis))
    .orderBy('startsAt', 'desc')
    .limit(SEGMENT_LIMIT);
}

function versionFromSnapshot(snapshot, segment, expectedType) {
  if (!snapshot?.exists) {
    fail('BOND_VERSION_NOT_FOUND', `The scheduled ${expectedType.toLowerCase()} version does not exist.`, {
      versionId: segment.versionId,
    });
  }
  const version = { id: snapshot.id, ...snapshot.data() };
  if (
    version.configurationType !== expectedType
    || !SUPPORTED_VERSION_STATES.has(version.status)
    || version.immutable !== true
  ) {
    fail('BOND_UNAPPROVED_VERSION', `The scheduled ${expectedType.toLowerCase()} version is not immutable and approved.`, {
      versionId: segment.versionId,
    });
  }
  const computedHash = definitionHash(version.definition);
  if (computedHash !== version.definitionHash || computedHash !== segment.definitionHash) {
    fail('BOND_VERSION_INTEGRITY_FAILURE', `The scheduled ${expectedType.toLowerCase()} definition failed its integrity check.`, {
      versionId: segment.versionId,
      scheduleId: segment.scheduleId,
    });
  }
  if (
    cleanText(version.guardrailVersionId, 180)
    && cleanText(version.guardrailVersionId, 180) !== cleanText(segment.guardrailVersionId, 180)
  ) {
    fail('BOND_GUARDRAIL_VERSION_MISMATCH', 'The schedule and immutable definition reference different guardrails.', {
      versionId: segment.versionId,
      scheduleId: segment.scheduleId,
    });
  }
  return version;
}

function guardrailsFromSnapshot(snapshot, guardrailVersionId) {
  if (!snapshot?.exists) {
    fail('BOND_GUARDRAILS_NOT_FOUND', 'The scheduled HQ guardrail version does not exist.', {
      guardrailVersionId,
    });
  }
  const version = { id: snapshot.id, ...snapshot.data() };
  if (
    version.configurationType !== 'GUARDRAIL'
    || !SUPPORTED_VERSION_STATES.has(version.status)
    || version.immutable !== true
    || definitionHash(version.definition) !== version.definitionHash
  ) {
    fail('BOND_GUARDRAIL_INTEGRITY_FAILURE', 'The scheduled HQ guardrail version is not immutable and approved.', {
      guardrailVersionId,
    });
  }
  return version.definition?.guardrails;
}

function scheduledPolicyVersion(version, segment) {
  return {
    ...version.definition,
    versionId: version.id,
    scope: version.definition.scope,
    storeIds: version.storeIds || version.definition.storeIds || [],
    earnRateBps: version.definition.earnRateBps,
    startsAt: timestampMillis(segment.startsAt),
    endsAt: timestampMillis(segment.endsAt) || null,
    status: 'APPROVED',
    approvalStatus: 'APPROVED',
    immutable: true,
  };
}

function scheduledCampaignVersion(version, segment) {
  return {
    ...version.definition,
    versionId: version.id,
    campaignId: version.campaignId || version.definition.campaignId,
    storeIds: version.storeIds || version.definition.storeIds || [],
    startsAt: timestampMillis(segment.startsAt),
    endsAt: timestampMillis(segment.endsAt) || null,
    status: 'APPROVED',
    approvalStatus: 'APPROVED',
    immutable: true,
  };
}

function canonicalOrderItems(documents) {
  return documents.map((document, index) => {
    const item = typeof document?.data === 'function' ? document.data() : document;
    const lineTaxable = Number(item?.lineTaxable ?? item?.lineSubtotal);
    if (!Number.isFinite(lineTaxable) || lineTaxable < 0) {
      fail('BOND_INVALID_ORDER_ITEM_EVIDENCE', 'A canonical order item has no valid pre-GST spend.', {
        itemIndex: index,
      });
    }
    return {
      productId: cleanText(item?.menuItemId || item?.finishedGoodId, 180) || null,
      productCode: cleanText(item?.finishedGoodCode || item?.itemCode, 180) || null,
      categoryId: cleanText(item?.categoryId, 180) || null,
      categoryCode: cleanText(item?.categoryCode || item?.categoryId, 180) || null,
      eligiblePreGstPaise: Math.round(lineTaxable * 100),
    };
  });
}

function createBondPolicyCampaignRuntime({ admin, db }) {
  async function resolveConfigurationInTransaction(transaction, { storeId, eventAt }) {
    const normalizedStoreId = cleanText(storeId, 180);
    const eventAtMillis = timestampMillis(eventAt);
    if (!normalizedStoreId || !eventAtMillis) {
      fail('BOND_INVALID_RUNTIME_CONTEXT', 'A store and authoritative event time are required.');
    }
    const globalQuery = segmentQuery(db, admin, POLICY_SCOPES, 'GLOBAL', eventAtMillis);
    const storeScopeKey = `STORE_${normalizedStoreId}`;
    const storeQuery = segmentQuery(db, admin, POLICY_SCOPES, storeScopeKey, eventAtMillis);
    const campaignQuery = segmentQuery(db, admin, CAMPAIGN_SCOPES, normalizedStoreId, eventAtMillis);
    const [globalSnapshot, storeSnapshot, campaignSnapshot] = await Promise.all([
      transaction.get(globalQuery),
      transaction.get(storeQuery),
      transaction.get(campaignQuery),
    ]);
    const globalSegment = activeSegment(globalSnapshot, eventAtMillis, 'POLICY', 'GLOBAL');
    const storeSegment = activeSegment(storeSnapshot, eventAtMillis, 'POLICY', storeScopeKey);
    const campaignSegment = activeSegment(campaignSnapshot, eventAtMillis, 'CAMPAIGN', normalizedStoreId);
    const segments = [globalSegment, storeSegment, campaignSegment].filter(Boolean);
    if (segments.length === 0) {
      return {
        managed: false,
        policyVersions: [],
        campaignVersions: [],
        guardrails: null,
        campaignSegment: null,
      };
    }

    const versionRequests = [];
    if (globalSegment) versionRequests.push({
      key: 'global',
      type: 'POLICY',
      segment: globalSegment,
      ref: db.collection(POLICY_VERSIONS).doc(globalSegment.versionId),
    });
    if (storeSegment) versionRequests.push({
      key: 'store',
      type: 'POLICY',
      segment: storeSegment,
      ref: db.collection(POLICY_VERSIONS).doc(storeSegment.versionId),
    });
    if (campaignSegment) versionRequests.push({
      key: 'campaign',
      type: 'CAMPAIGN',
      segment: campaignSegment,
      ref: db.collection(CAMPAIGN_VERSIONS).doc(campaignSegment.versionId),
    });
    const versionSnapshots = await Promise.all(versionRequests.map(request => transaction.get(request.ref)));
    const versions = new Map();
    versionRequests.forEach((request, index) => {
      versions.set(request.key, versionFromSnapshot(versionSnapshots[index], request.segment, request.type));
    });

    const guardrailVersionIds = [...new Set(segments.map(segment => cleanText(segment.guardrailVersionId, 180)).filter(Boolean))];
    if (guardrailVersionIds.length !== 1) {
      fail('BOND_GUARDRAIL_VERSION_CONFLICT', 'Active policy and campaign schedules must use one HQ guardrail version.', {
        guardrailVersionIds,
      });
    }
    const guardrailVersionId = guardrailVersionIds[0];
    const guardrailSnapshot = await transaction.get(db.collection(GUARDRAIL_VERSIONS).doc(guardrailVersionId));
    const guardrails = guardrailsFromSnapshot(guardrailSnapshot, guardrailVersionId);
    const policyVersions = [];
    if (globalSegment) policyVersions.push(scheduledPolicyVersion(versions.get('global'), globalSegment));
    if (storeSegment) policyVersions.push(scheduledPolicyVersion(versions.get('store'), storeSegment));
    const campaignVersions = campaignSegment
      ? [scheduledCampaignVersion(versions.get('campaign'), campaignSegment)]
      : [];
    return {
      managed: true,
      guardrailVersionId,
      guardrails,
      policyVersions,
      campaignVersions,
      globalSegment,
      storeSegment,
      campaignSegment,
    };
  }

  async function resolveRewardInTransaction(transaction, {
    orderId,
    order,
    customerId,
    account,
    eligibleSpendPaise,
    itemDocuments,
    eventAtOverride = null,
    deferVisitCampaign = false,
  }) {
    const eventAt = eventAtOverride || order?.settledAt || order?.createdAt || order?.updatedAt;
    const configuration = await resolveConfigurationInTransaction(transaction, {
      storeId: order?.storeId,
      eventAt,
    });
    const activeCampaign = configuration.campaignVersions[0] || null;
    const eventAtMillis = timestampMillis(eventAt);
    let budgetRef = null;
    let usageRef = null;
    let budgetSnapshot = null;
    let usageSnapshot = null;
    let campaignUsage = null;
    const requiresVisitEvidence = Boolean(activeCampaign) && (
      Number(activeCampaign.minimumUniqueVisitDays || activeCampaign.minimumUniqueIstVisitDays || 0) > 0
      || Number(activeCampaign.everyNthUniqueIstVisitDay || 0) > 0
    );
    const campaignDeferred = deferVisitCampaign && requiresVisitEvidence;
    if (activeCampaign && !campaignDeferred) {
      budgetRef = db.collection(CAMPAIGN_BUDGETS).doc(activeCampaign.versionId);
      usageRef = db.collection(CAMPAIGN_CUSTOMER_USAGE)
        .doc(campaignCustomerUsageId(activeCampaign.versionId, customerId));
      [budgetSnapshot, usageSnapshot] = await Promise.all([
        transaction.get(budgetRef),
        transaction.get(usageRef),
      ]);
      if (!budgetSnapshot.exists) {
        fail('BOND_CAMPAIGN_BUDGET_NOT_FOUND', 'The approved campaign budget projection is missing.', {
          campaignVersionId: activeCampaign.versionId,
        });
      }
      const budget = budgetSnapshot.data();
      if (
        cleanText(budget.versionId, 180) !== activeCampaign.versionId
        || currentNumber(budget, 'budgetPoints') !== activeCampaign.budgetPoints
      ) {
        fail('BOND_CAMPAIGN_BUDGET_MISMATCH', 'The campaign budget does not match its immutable definition.', {
          campaignVersionId: activeCampaign.versionId,
        });
      }
      const usage = usageSnapshot.exists ? usageSnapshot.data() : {};
      campaignUsage = {
        authoritative: true,
        campaignId: activeCampaign.campaignId,
        campaignVersionId: activeCampaign.versionId,
        customerUses: currentNumber(usage, 'netAwardCount'),
        campaignAwardedPoints: currentNumber(budget, 'netConsumedPoints'),
      };
    }
    void account;
    let visitDates = [];
    if (requiresVisitEvidence && !campaignDeferred) {
      const campaignStartsAtMillis = timestampMillis(
        configuration.campaignSegment?.startsAt || activeCampaign?.startsAt,
      );
      const visitSnapshot = await transaction.get(
        db.collection(QUALIFYING_VISIT_DAYS).where('customerId', '==', customerId),
      );
      visitDates = [...new Set(visitSnapshot.docs
        .map(document => document.data())
        .filter(day => (
          timestampMillis(day?.occurredAt) >= campaignStartsAtMillis
          && timestampMillis(day.occurredAt) <= eventAtMillis
        ))
        .map(day => cleanText(day.businessDate, 20))
        .filter(Boolean))].sort();
    }
    const evaluation = evaluateBondReward({
      order: {
        orderId,
        source: order?.source,
        storeId: order?.storeId,
        eventAt: eventAtMillis,
        eventAtAuthoritative: true,
        eligibleSpendPaise,
        eligibleSpendAuthoritative: true,
        itemsAuthoritative: true,
        items: canonicalOrderItems(itemDocuments),
      },
      policyVersions: configuration.policyVersions,
      campaignVersions: campaignDeferred ? [] : configuration.campaignVersions,
      guardrails: configuration.guardrails,
      campaignUsage,
      visitEvidence: requiresVisitEvidence && !campaignDeferred ? {
        authoritative: true,
        timezone: 'Asia/Kolkata',
        businessDates: visitDates,
      } : null,
    });
    const baseCalculation = calculateEarnPoints(
      eligibleSpendPaise,
      evaluation.policy.earnRateBps,
    );
    return {
      configuration,
      evaluation,
      baseCalculation,
      budgetRef,
      usageRef,
      budgetSnapshot,
      usageSnapshot,
      campaignDeferred,
      requiresVisitEvidence,
    };
  }

  function applyCampaignAwardInTransaction(transaction, rewardContext, { customerId, storeId, FieldValue }) {
    const campaign = rewardContext.evaluation.campaign;
    const points = rewardContext.evaluation.reward.campaignPoints;
    if (!campaign || points <= 0) return 0;
    const budget = rewardContext.budgetSnapshot.data();
    const usage = rewardContext.usageSnapshot.exists ? rewardContext.usageSnapshot.data() : {};
    const awardedPoints = currentNumber(budget, 'awardedPoints') + points;
    const reversedPoints = currentNumber(budget, 'reversedPoints');
    const netConsumedPoints = currentNumber(budget, 'netConsumedPoints') + points;
    const awardCount = currentNumber(budget, 'awardCount') + 1;
    if (netConsumedPoints > currentNumber(budget, 'budgetPoints')) {
      fail('BOND_CAMPAIGN_POINTS_BUDGET_EXCEEDED', 'The campaign budget was exhausted concurrently.');
    }
    transaction.update(rewardContext.budgetRef, {
      awardedPoints,
      reversedPoints,
      netConsumedPoints,
      awardCount,
      updatedAt: FieldValue.serverTimestamp(),
    });
    const usageWrite = {
      versionId: campaign.campaignVersionId,
      campaignId: campaign.campaignId,
      customerId,
      issuingStoreId: cleanText(storeId, 180),
      awardCount: currentNumber(usage, 'awardCount') + 1,
      reversedAwardCount: currentNumber(usage, 'reversedAwardCount'),
      netAwardCount: currentNumber(usage, 'netAwardCount') + 1,
      awardedPoints: currentNumber(usage, 'awardedPoints') + points,
      reversedPoints: currentNumber(usage, 'reversedPoints'),
      netPoints: currentNumber(usage, 'netPoints') + points,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (!rewardContext.usageSnapshot.exists) usageWrite.createdAt = FieldValue.serverTimestamp();
    transaction.set(rewardContext.usageRef, usageWrite, { merge: true });
    return 2;
  }

  async function resolveCurrentPolicy({ storeId, eventAt = Date.now() }) {
    return db.runTransaction(async transaction => {
      const configuration = await resolveConfigurationInTransaction(transaction, { storeId, eventAt });
      const evaluation = evaluateBondReward({
        order: {
          orderId: 'BOND_POLICY_SUMMARY',
          source: 'CUSTOMER_WEB',
          storeId,
          eventAt: timestampMillis(eventAt),
          eventAtAuthoritative: true,
          eligibleSpendPaise: 0,
          eligibleSpendAuthoritative: true,
          itemsAuthoritative: true,
          items: [],
        },
        policyVersions: configuration.policyVersions,
        campaignVersions: [],
        guardrails: configuration.guardrails,
      });
      return {
        effectiveEarnRateBps: evaluation.policy.earnRateBps,
        effectivePolicyVersionId: evaluation.policy.policyVersionId,
        policySource: evaluation.policy.source,
      };
    });
  }

  async function resolveReward({ orderId, order, customerId, eligibleSpendPaise }) {
    return db.runTransaction(async transaction => {
      const accountRef = db.collection('loyaltyAccounts').doc(customerId);
      const itemsQuery = db.collection('orders').doc(orderId).collection('items');
      const [accountSnapshot, itemSnapshot] = await Promise.all([
        transaction.get(accountRef),
        transaction.get(itemsQuery),
      ]);
      return resolveRewardInTransaction(transaction, {
        orderId,
        order,
        customerId,
        account: accountSnapshot.exists ? accountSnapshot.data() : {},
        eligibleSpendPaise,
        itemDocuments: itemSnapshot.docs,
      });
    });
  }

  return {
    applyCampaignAwardInTransaction,
    resolveConfigurationInTransaction,
    resolveCurrentPolicy,
    resolveReward,
    resolveRewardInTransaction,
  };
}

module.exports = {
  BondPolicyRuntimeError,
  campaignCustomerUsageId,
  canonicalOrderItems,
  createBondPolicyCampaignRuntime,
};
