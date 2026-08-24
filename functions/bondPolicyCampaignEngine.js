'use strict';

const LEGACY_DEFAULT_EARN_BASIS_POINTS = 1000;
const EARN_RATE_DENOMINATOR = 1_000_000;
const MULTIPLIER_BASIS_POINTS = 10_000;
const POINT_VALUE_PAISE = 100;
const BOND_TIMEZONE = 'Asia/Kolkata';
const DAY_MS = 24 * 60 * 60 * 1000;

const POLICY_SCOPES = Object.freeze({
  GLOBAL: 'GLOBAL',
  STORE: 'STORE',
});

const CAMPAIGN_REWARD_TYPES = Object.freeze({
  FIXED_POINTS: 'FIXED_POINTS',
  FIXED_BONUS_POINTS: 'FIXED_BONUS_POINTS',
  EARN_MULTIPLIER: 'EARN_MULTIPLIER',
  MULTIPLIER: 'MULTIPLIER',
});

const RESOLVABLE_STATUSES = new Set(['APPROVED', 'SCHEDULED', 'ACTIVE']);
const IST_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

class BondPolicyCampaignError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BondPolicyCampaignError';
    this.code = code;
    this.details = deepFreeze({ ...details });
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function fail(code, message, details) {
  throw new BondPolicyCampaignError(code, message, details);
}

function requiredString(value, field) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) fail('BOND_INVALID_CONFIGURATION', `${field} is required.`, { field });
  return normalized;
}

function nonNegativeSafeInteger(value, field, options = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || (options.positive && value === 0)) {
    fail('BOND_INVALID_CONFIGURATION', `${field} must be ${options.positive ? 'a positive' : 'a non-negative'} safe integer.`, {
      field,
    });
  }
  return value;
}

function optionalNonNegativeSafeInteger(value, field, options = {}) {
  if (value === null || value === undefined) return null;
  return nonNegativeSafeInteger(value, field, options);
}

function timestampMillis(value, field) {
  let millis;
  if (value instanceof Date) {
    millis = value.getTime();
  } else if (typeof value?.toMillis === 'function') {
    millis = value.toMillis();
  } else if (typeof value === 'string') {
    millis = Date.parse(value);
  } else {
    millis = value;
  }
  if (!Number.isSafeInteger(millis) || millis <= 0) {
    fail('BOND_INVALID_CONFIGURATION', `${field} must be a valid timestamp.`, { field });
  }
  return millis;
}

function optionalTimestampMillis(value, field) {
  return value === null || value === undefined ? null : timestampMillis(value, field);
}

function normalizeStatus(version, field) {
  const configuredStatus = String(version?.status || '').trim().toUpperCase();
  const configuredApproval = String(version?.approvalStatus || '').trim().toUpperCase();
  const lifecycleStatus = String(
    version?.lifecycleStatus || configuredStatus || configuredApproval,
  ).trim().toUpperCase();
  if (!lifecycleStatus) {
    fail('BOND_INVALID_CONFIGURATION', `${field}.approvalStatus is required.`, { field: `${field}.approvalStatus` });
  }
  const approvalStatus = configuredApproval
    || (RESOLVABLE_STATUSES.has(lifecycleStatus) ? 'APPROVED' : lifecycleStatus);
  return { approvalStatus, lifecycleStatus };
}

function isResolvableVersion(version) {
  return version.approvalStatus === 'APPROVED'
    && RESOLVABLE_STATUSES.has(version.lifecycleStatus)
    && version.paused !== true;
}

function normalizeWindow(value, field) {
  const effectiveFromMs = timestampMillis(
    value?.effectiveFrom ?? value?.startsAt,
    `${field}.effectiveFrom`,
  );
  const effectiveToMs = optionalTimestampMillis(
    value?.effectiveTo ?? value?.endsAt,
    `${field}.effectiveTo`,
  );
  if (effectiveToMs !== null && effectiveToMs <= effectiveFromMs) {
    fail('BOND_INVALID_CONFIGURATION', `${field} must use a non-empty half-open activation window.`, {
      field,
      effectiveFromMs,
      effectiveToMs,
    });
  }
  return { effectiveFromMs, effectiveToMs };
}

function windowContains(version, eventAtMs) {
  return eventAtMs >= version.effectiveFromMs
    && (version.effectiveToMs === null || eventAtMs < version.effectiveToMs);
}

function normalizeGuardrails(value) {
  if (!value || typeof value !== 'object') {
    return deepFreeze({
      minEarnRateBps: 0,
      maxEarnRateBps: 10_000,
      maxCombinedRewardRateBps: 10_000,
      minEarnBasisPoints: 0,
      maxEarnBasisPoints: 10_000,
      liabilityPaisePerPoint: POINT_VALUE_PAISE,
      maxMultiplierBps: null,
      maxFixedBonusPoints: null,
      maxCampaignDays: null,
      maxCustomerAwards: null,
      maxCampaignBudgetPoints: null,
      source: 'LEGACY_DEFAULT',
    });
  }
  const minEarnRateBps = nonNegativeSafeInteger(
    value.minEarnRateBps ?? value.minEarnBasisPoints,
    'guardrails.minEarnRateBps',
  );
  const maxEarnRateBps = nonNegativeSafeInteger(
    value.maxEarnRateBps ?? value.maxEarnBasisPoints,
    'guardrails.maxEarnRateBps',
  );
  if (minEarnRateBps > maxEarnRateBps) {
    fail('BOND_INVALID_GUARDRAILS', 'The HQ minimum earn rate cannot exceed the maximum.', {
      minEarnRateBps,
      maxEarnRateBps,
    });
  }
  const maxCombinedRewardRateBps = nonNegativeSafeInteger(
    value.maxCombinedRewardRateBps ?? 10_000,
    'guardrails.maxCombinedRewardRateBps',
  );
  if (maxCombinedRewardRateBps < maxEarnRateBps) {
    fail('BOND_INVALID_GUARDRAILS', 'The combined base and campaign reward cap cannot be below the maximum base earn rate.', {
      maxEarnRateBps,
      maxCombinedRewardRateBps,
    });
  }
  return deepFreeze({
    minEarnRateBps,
    maxEarnRateBps,
    minEarnBasisPoints: minEarnRateBps,
    maxEarnBasisPoints: maxEarnRateBps,
    maxCombinedRewardRateBps,
    liabilityPaisePerPoint: nonNegativeSafeInteger(
      value.liabilityPaisePerPoint,
      'guardrails.liabilityPaisePerPoint',
      { positive: true },
    ),
    maxMultiplierBps: optionalNonNegativeSafeInteger(
      value.maxMultiplierBps,
      'guardrails.maxMultiplierBps',
      { positive: true },
    ),
    maxFixedBonusPoints: optionalNonNegativeSafeInteger(
      value.maxFixedBonusPoints,
      'guardrails.maxFixedBonusPoints',
      { positive: true },
    ),
    maxCampaignDays: optionalNonNegativeSafeInteger(
      value.maxCampaignDays,
      'guardrails.maxCampaignDays',
      { positive: true },
    ),
    maxCustomerAwards: optionalNonNegativeSafeInteger(
      value.maxCustomerAwards,
      'guardrails.maxCustomerAwards',
      { positive: true },
    ),
    maxCampaignBudgetPoints: optionalNonNegativeSafeInteger(
      value.maxCampaignBudgetPoints,
      'guardrails.maxCampaignBudgetPoints',
      { positive: true },
    ),
    source: 'HQ_VERSIONED',
  });
}

function enforceGuardrails(earnBasisPoints, guardrails, evidence = {}) {
  if (
    earnBasisPoints < guardrails.minEarnRateBps
    || earnBasisPoints > guardrails.maxEarnRateBps
  ) {
    fail('BOND_EARN_RATE_OUTSIDE_GUARDRAILS', 'The selected earn rate is outside HQ guardrails.', {
      earnBasisPoints,
      ...guardrails,
      ...evidence,
    });
  }
}

function validatePolicyVersion(value, index = 0) {
  const field = `policyVersions[${index}]`;
  if (!value || typeof value !== 'object') {
    fail('BOND_INVALID_CONFIGURATION', `${field} must be an object.`, { field });
  }
  if (value.immutable !== true) {
    fail('BOND_MUTABLE_VERSION_REJECTED', `${field} must be marked immutable.`, { field });
  }
  const versionId = requiredString(value.versionId, `${field}.versionId`);
  const scope = String(value.scope || '').trim().toUpperCase();
  if (!Object.values(POLICY_SCOPES).includes(scope)) {
    fail('BOND_INVALID_CONFIGURATION', `${field}.scope must be GLOBAL or STORE.`, { field: `${field}.scope` });
  }
  const configuredStoreIds = value.storeIds ?? (value.storeId ? [value.storeId] : []);
  const storeIds = normalizedStringList(configuredStoreIds, `${field}.storeIds`);
  if (scope === POLICY_SCOPES.STORE && storeIds.length === 0) {
    fail('BOND_INVALID_CONFIGURATION', 'A store policy version must select at least one store.', { versionId });
  }
  if (scope === POLICY_SCOPES.GLOBAL && storeIds.length > 0) {
    fail('BOND_INVALID_CONFIGURATION', 'A global policy version cannot name a store.', { versionId });
  }
  const earnBasisPoints = nonNegativeSafeInteger(
    value.earnRateBps ?? value.earnBasisPoints,
    `${field}.earnRateBps`,
  );
  const { effectiveFromMs, effectiveToMs } = normalizeWindow(value, field);
  const { approvalStatus, lifecycleStatus } = normalizeStatus(value, field);
  return deepFreeze({
    versionId,
    scope,
    storeIds,
    earnBasisPoints,
    earnRateBps: earnBasisPoints,
    effectiveFromMs,
    effectiveToMs,
    approvalStatus,
    lifecycleStatus,
    paused: value.paused === true,
    immutable: true,
  });
}

function resolvePolicyVersion({ policyVersions = [], storeId, eventAt, guardrails }) {
  const normalizedStoreId = requiredString(storeId, 'storeId');
  const eventAtMs = timestampMillis(eventAt, 'eventAt');
  const normalizedGuardrails = normalizeGuardrails(guardrails);
  if (!Array.isArray(policyVersions)) {
    fail('BOND_INVALID_CONFIGURATION', 'policyVersions must be an array.', { field: 'policyVersions' });
  }
  const active = policyVersions
    .map((value, index) => validatePolicyVersion(value, index))
    .filter(isResolvableVersion)
    .filter(version => windowContains(version, eventAtMs));

  const storeMatches = active.filter(version => (
    version.scope === POLICY_SCOPES.STORE && version.storeIds.includes(normalizedStoreId)
  ));
  if (storeMatches.length > 1) {
    fail('BOND_POLICY_WINDOW_OVERLAP', 'Multiple store policy versions are active at the event time.', {
      storeId: normalizedStoreId,
      versionIds: storeMatches.map(version => version.versionId),
      eventAtMs,
    });
  }

  const globalMatches = active.filter(version => version.scope === POLICY_SCOPES.GLOBAL);
  const selected = storeMatches[0] || (() => {
    if (globalMatches.length > 1) {
      fail('BOND_POLICY_WINDOW_OVERLAP', 'Multiple global policy versions are active at the event time.', {
        versionIds: globalMatches.map(version => version.versionId),
        eventAtMs,
      });
    }
    return globalMatches[0] || null;
  })();

  if (!selected) {
    enforceGuardrails(LEGACY_DEFAULT_EARN_BASIS_POINTS, normalizedGuardrails, {
      versionId: 'BOND_POLICY_V1_2026',
    });
    return deepFreeze({
      versionId: 'BOND_POLICY_V1_2026',
      scope: POLICY_SCOPES.GLOBAL,
      storeIds: [],
      earnBasisPoints: LEGACY_DEFAULT_EARN_BASIS_POINTS,
      earnRateBps: LEGACY_DEFAULT_EARN_BASIS_POINTS,
      effectiveFromMs: null,
      effectiveToMs: null,
      source: 'LEGACY_DEFAULT',
      windowSemantics: '[effectiveFrom,effectiveTo)',
    });
  }

  if (normalizedGuardrails.source !== 'HQ_VERSIONED') {
    fail('BOND_GUARDRAILS_REQUIRED', 'A managed policy version requires versioned HQ guardrails.', {
      versionId: selected.versionId,
    });
  }
  enforceGuardrails(selected.earnBasisPoints, normalizedGuardrails, {
    versionId: selected.versionId,
    storeIds: selected.storeIds,
  });
  return deepFreeze({
    ...selected,
    source: selected.scope === POLICY_SCOPES.STORE ? 'STORE_OVERRIDE' : 'GLOBAL_DEFAULT',
    windowSemantics: '[effectiveFrom,effectiveTo)',
  });
}

function normalizedStringList(value, field) {
  if (value === null || value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    fail('BOND_INVALID_CONFIGURATION', `${field} must be an array.`, { field });
  }
  const normalized = value.map((entry, index) => requiredString(entry, `${field}[${index}]`));
  return Object.freeze([...new Set(normalized)].sort());
}

function validateCampaignVersion(value, index = 0, guardrails = null) {
  const field = `campaignVersions[${index}]`;
  if (!value || typeof value !== 'object') {
    fail('BOND_INVALID_CONFIGURATION', `${field} must be an object.`, { field });
  }
  if (value.immutable !== true) {
    fail('BOND_MUTABLE_VERSION_REJECTED', `${field} must be marked immutable.`, { field });
  }
  const versionId = requiredString(value.versionId, `${field}.versionId`);
  const campaignId = requiredString(value.campaignId || versionId, `${field}.campaignId`);
  if (value.stackingMode && value.stackingMode !== 'EXCLUSIVE_ONE') {
    fail('BOND_CAMPAIGN_STACKING_REJECTED', 'Campaigns must use EXCLUSIVE_ONE stacking.', {
      campaignId,
      versionId,
    });
  }
  const storeIds = normalizedStringList(value.storeIds, `${field}.storeIds`);
  if (storeIds.length === 0) {
    fail('BOND_INVALID_CONFIGURATION', `${field}.storeIds must select at least one store or '*'.`, {
      field: `${field}.storeIds`,
    });
  }
  if (storeIds.includes('*') && storeIds.length > 1) {
    fail('BOND_INVALID_CONFIGURATION', `${field}.storeIds cannot combine '*' with explicit stores.`, {
      field: `${field}.storeIds`,
    });
  }
  const { effectiveFromMs, effectiveToMs } = normalizeWindow(value, field);
  const { approvalStatus, lifecycleStatus } = normalizeStatus(value, field);
  const configuredRewardType = String(value.rewardType || '').trim().toUpperCase();
  const rewardType = configuredRewardType === CAMPAIGN_REWARD_TYPES.FIXED_BONUS_POINTS
    ? CAMPAIGN_REWARD_TYPES.FIXED_POINTS
    : configuredRewardType === CAMPAIGN_REWARD_TYPES.MULTIPLIER
      ? CAMPAIGN_REWARD_TYPES.EARN_MULTIPLIER
      : configuredRewardType;
  if (![CAMPAIGN_REWARD_TYPES.FIXED_POINTS, CAMPAIGN_REWARD_TYPES.EARN_MULTIPLIER].includes(rewardType)) {
    fail('BOND_INVALID_CONFIGURATION', `${field}.rewardType is not supported.`, {
      field: `${field}.rewardType`,
    });
  }
  const fixedBonusPoints = rewardType === CAMPAIGN_REWARD_TYPES.FIXED_POINTS
    ? nonNegativeSafeInteger(value.fixedBonusPoints, `${field}.fixedBonusPoints`, { positive: true })
    : null;
  const earnMultiplierBasisPoints = rewardType === CAMPAIGN_REWARD_TYPES.EARN_MULTIPLIER
    ? nonNegativeSafeInteger(
      value.multiplierBps ?? value.earnMultiplierBasisPoints,
      `${field}.multiplierBps`,
      { positive: true },
    )
    : null;
  if (
    rewardType === CAMPAIGN_REWARD_TYPES.EARN_MULTIPLIER
    && earnMultiplierBasisPoints < MULTIPLIER_BASIS_POINTS
  ) {
    fail('BOND_INVALID_CONFIGURATION', 'An earn multiplier cannot reduce the base reward.', {
      field: `${field}.multiplierBps`,
    });
  }

  const normalizedGuardrails = guardrails ? normalizeGuardrails(guardrails) : null;
  if (
    normalizedGuardrails?.maxFixedBonusPoints !== null
    && fixedBonusPoints !== null
    && fixedBonusPoints > normalizedGuardrails.maxFixedBonusPoints
  ) {
    fail('BOND_CAMPAIGN_OUTSIDE_GUARDRAILS', 'Fixed campaign points exceed HQ guardrails.', {
      fixedBonusPoints,
      maxFixedBonusPoints: normalizedGuardrails.maxFixedBonusPoints,
    });
  }
  if (
    normalizedGuardrails?.maxMultiplierBps !== null
    && earnMultiplierBasisPoints !== null
    && earnMultiplierBasisPoints > normalizedGuardrails.maxMultiplierBps
  ) {
    fail('BOND_CAMPAIGN_OUTSIDE_GUARDRAILS', 'Campaign multiplier exceeds HQ guardrails.', {
      multiplierBps: earnMultiplierBasisPoints,
      maxMultiplierBps: normalizedGuardrails.maxMultiplierBps,
    });
  }

  const minimumEligibleSpendPaise = optionalNonNegativeSafeInteger(
    value.minimumSpendPaise ?? value.minimumEligibleSpendPaise,
    `${field}.minimumSpendPaise`,
  ) || 0;
  const minimumUniqueIstVisitDays = optionalNonNegativeSafeInteger(
    value.minimumUniqueVisitDays ?? value.minimumUniqueIstVisitDays,
    `${field}.minimumUniqueVisitDays`,
  ) || 0;
  const visitWindowDays = optionalNonNegativeSafeInteger(
    value.visitWindowDays,
    `${field}.visitWindowDays`,
  ) || 0;
  const maxUsesPerCustomer = optionalNonNegativeSafeInteger(
    value.customerAwardLimit ?? value.maxUsesPerCustomer,
    `${field}.customerAwardLimit`,
    { positive: true },
  );
  const budgetPoints = optionalNonNegativeSafeInteger(value.budgetPoints, `${field}.budgetPoints`);
  if (
    normalizedGuardrails?.maxCustomerAwards !== null
    && maxUsesPerCustomer !== null
    && maxUsesPerCustomer > normalizedGuardrails.maxCustomerAwards
  ) {
    fail('BOND_CAMPAIGN_OUTSIDE_GUARDRAILS', 'Customer award limit exceeds HQ guardrails.', {
      customerAwardLimit: maxUsesPerCustomer,
      maxCustomerAwards: normalizedGuardrails.maxCustomerAwards,
    });
  }
  if (
    normalizedGuardrails?.maxCampaignBudgetPoints !== null
    && budgetPoints !== null
    && budgetPoints > normalizedGuardrails.maxCampaignBudgetPoints
  ) {
    fail('BOND_CAMPAIGN_OUTSIDE_GUARDRAILS', 'Campaign budget exceeds HQ guardrails.', {
      budgetPoints,
      maxCampaignBudgetPoints: normalizedGuardrails.maxCampaignBudgetPoints,
    });
  }
  if (
    normalizedGuardrails?.maxCampaignDays !== null
    && effectiveToMs !== null
    && effectiveToMs - effectiveFromMs > normalizedGuardrails.maxCampaignDays * DAY_MS
  ) {
    fail('BOND_CAMPAIGN_OUTSIDE_GUARDRAILS', 'Campaign duration exceeds HQ guardrails.', {
      maxCampaignDays: normalizedGuardrails.maxCampaignDays,
    });
  }

  return deepFreeze({
    campaignId,
    versionId,
    storeIds,
    effectiveFromMs,
    effectiveToMs,
    approvalStatus,
    lifecycleStatus,
    paused: value.paused === true,
    immutable: true,
    rewardType,
    fixedBonusPoints,
    earnMultiplierBasisPoints,
    multiplierBps: earnMultiplierBasisPoints,
    minimumEligibleSpendPaise,
    minimumSpendPaise: minimumEligibleSpendPaise,
    eligibleProductIds: normalizedStringList(
      value.eligibleProductCodes ?? value.eligibleProductIds,
      `${field}.eligibleProductCodes`,
    ),
    eligibleCategoryIds: normalizedStringList(
      value.eligibleCategoryCodes ?? value.eligibleCategoryIds,
      `${field}.eligibleCategoryCodes`,
    ),
    minimumUniqueIstVisitDays,
    minimumUniqueVisitDays: minimumUniqueIstVisitDays,
    visitWindowDays,
    everyNthUniqueIstVisitDay: optionalNonNegativeSafeInteger(
      value.everyNthUniqueIstVisitDay,
      `${field}.everyNthUniqueIstVisitDay`,
      { positive: true },
    ),
    maxUsesPerCustomer,
    customerAwardLimit: maxUsesPerCustomer,
    budgetPoints,
  });
}

function resolveCampaignVersion({ campaignVersions = [], storeId, eventAt, guardrails = null }) {
  const normalizedStoreId = requiredString(storeId, 'storeId');
  const eventAtMs = timestampMillis(eventAt, 'eventAt');
  if (!Array.isArray(campaignVersions)) {
    fail('BOND_INVALID_CONFIGURATION', 'campaignVersions must be an array.', { field: 'campaignVersions' });
  }
  const active = campaignVersions
    .map((value, index) => validateCampaignVersion(value, index, guardrails))
    .filter(isResolvableVersion)
    .filter(version => windowContains(version, eventAtMs))
    .filter(version => version.storeIds.includes('*') || version.storeIds.includes(normalizedStoreId));
  if (active.length > 1) {
    fail('BOND_CAMPAIGN_WINDOW_OVERLAP', 'Multiple campaigns target this store at the event time; rewards fail closed.', {
      storeId: normalizedStoreId,
      campaignVersions: active.map(version => ({
        campaignId: version.campaignId,
        versionId: version.versionId,
      })),
      eventAtMs,
    });
  }
  return active[0] || null;
}

function checkedBigIntResult(value, field) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail('BOND_REWARD_OVERFLOW', `${field} exceeds the supported safe-integer range.`, { field });
  }
  return Number(value);
}

function calculateEarnPoints(eligibleSpendPaise, earnBasisPoints = LEGACY_DEFAULT_EARN_BASIS_POINTS) {
  const spend = nonNegativeSafeInteger(eligibleSpendPaise, 'eligibleSpendPaise');
  const basisPoints = nonNegativeSafeInteger(earnBasisPoints, 'earnBasisPoints');
  const numerator = BigInt(spend) * BigInt(basisPoints);
  return deepFreeze({
    points: checkedBigIntResult(numerator / BigInt(EARN_RATE_DENOMINATOR), 'points'),
    remainderRateUnits: checkedBigIntResult(
      numerator % BigInt(EARN_RATE_DENOMINATOR),
      'remainderRateUnits',
    ),
    earnBasisPoints: basisPoints,
    eligibleSpendPaise: spend,
  });
}

function rupeesToPaise(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail('BOND_INVALID_ORDER_EVIDENCE', `${field} must be a non-negative rupee amount.`, { field });
  }
  const paise = Math.round(value * 100);
  if (!Number.isSafeInteger(paise)) {
    fail('BOND_REWARD_OVERFLOW', `${field} exceeds the supported range.`, { field });
  }
  return paise;
}

function normalizeOrder(value) {
  if (!value || typeof value !== 'object') {
    fail('BOND_INVALID_ORDER_EVIDENCE', 'Authoritative order evidence is required.');
  }
  const source = requiredString(value.source, 'order.source').toUpperCase();
  if (source !== 'CUSTOMER_WEB') {
    fail('BOND_CHANNEL_INELIGIBLE', 'Only verified customer-web orders can earn BOND rewards.', { source });
  }
  if (value.eligibleSpendAuthoritative !== true || value.eventAtAuthoritative !== true) {
    fail('BOND_UNVERIFIED_ORDER_EVIDENCE', 'Eligible spend and event time must be server-authoritative.', {
      eligibleSpendAuthoritative: value.eligibleSpendAuthoritative === true,
      eventAtAuthoritative: value.eventAtAuthoritative === true,
    });
  }
  return deepFreeze({
    orderId: requiredString(value.orderId, 'order.orderId'),
    source,
    storeId: requiredString(value.storeId, 'order.storeId'),
    eventAtMs: timestampMillis(value.eventAt, 'order.eventAt'),
    eligibleSpendPaise: nonNegativeSafeInteger(value.eligibleSpendPaise, 'order.eligibleSpendPaise'),
    itemsAuthoritative: value.itemsAuthoritative === true,
    items: Array.isArray(value.items) ? value.items : [],
  });
}

function campaignEligibleSpend(order, campaign) {
  const hasProductFilter = campaign.eligibleProductIds.length > 0;
  const hasCategoryFilter = campaign.eligibleCategoryIds.length > 0;
  if (!hasProductFilter && !hasCategoryFilter) {
    return deepFreeze({
      eligibleSpendPaise: order.eligibleSpendPaise,
      matchedProductIds: [],
      matchedCategoryIds: [],
      filterApplied: false,
    });
  }
  if (!order.itemsAuthoritative) {
    fail('BOND_UNVERIFIED_ITEM_EVIDENCE', 'Product/category campaigns require authoritative canonical order items.', {
      campaignId: campaign.campaignId,
      campaignVersionId: campaign.versionId,
    });
  }
  const productSet = new Set(campaign.eligibleProductIds);
  const categorySet = new Set(campaign.eligibleCategoryIds);
  let representedSpendPaise = 0;
  let matchedSpendPaise = 0;
  const matchedProductIds = new Set();
  const matchedCategoryIds = new Set();
  for (const [index, item] of order.items.entries()) {
    if (!item || typeof item !== 'object') {
      fail('BOND_INVALID_ORDER_EVIDENCE', `order.items[${index}] must be an object.`);
    }
    const productCandidates = [
      item.productId,
      item.productCode,
      item.finishedGoodId,
      item.finishedGoodCode,
    ].filter(candidate => typeof candidate === 'string' && candidate.trim()).map(candidate => candidate.trim());
    const categoryCandidates = [item.categoryId, item.categoryCode]
      .filter(candidate => typeof candidate === 'string' && candidate.trim())
      .map(candidate => candidate.trim());
    const itemSpendPaise = item.eligiblePreGstPaise !== null && item.eligiblePreGstPaise !== undefined
      ? nonNegativeSafeInteger(
        item.eligiblePreGstPaise,
        `order.items[${index}].eligiblePreGstPaise`,
      )
      : rupeesToPaise(item.lineTaxable, `order.items[${index}].lineTaxable`);
    representedSpendPaise += itemSpendPaise;
    if (!Number.isSafeInteger(representedSpendPaise)) {
      fail('BOND_REWARD_OVERFLOW', 'Canonical item spend exceeds the supported range.');
    }
    const productMatches = productCandidates.filter(candidate => productSet.has(candidate));
    const categoryMatches = categoryCandidates.filter(candidate => categorySet.has(candidate));
    if (productMatches.length > 0 || categoryMatches.length > 0) {
      matchedSpendPaise += itemSpendPaise;
      for (const candidate of productMatches) matchedProductIds.add(candidate);
      for (const candidate of categoryMatches) matchedCategoryIds.add(candidate);
    }
  }
  if (representedSpendPaise > order.eligibleSpendPaise) {
    fail('BOND_INVALID_ORDER_EVIDENCE', 'Canonical item spend cannot exceed authoritative eligible spend.', {
      representedSpendPaise,
      eligibleSpendPaise: order.eligibleSpendPaise,
    });
  }
  return deepFreeze({
    eligibleSpendPaise: matchedSpendPaise,
    matchedProductIds: [...matchedProductIds].sort(),
    matchedCategoryIds: [...matchedCategoryIds].sort(),
    filterApplied: true,
  });
}

function businessDateInTimeZone(eventAtMs) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BOND_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(eventAtMs));
}

function strictBusinessDateOrdinal(value) {
  if (!IST_DATE_PATTERN.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const ordinal = Date.UTC(year, month - 1, day);
  return new Date(ordinal).toISOString().slice(0, 10) === value ? ordinal : null;
}

function uniqueIstVisitDayEvidence(campaign, visitEvidence, eventAtMs) {
  const hasVisitRule = campaign.minimumUniqueIstVisitDays > 0
    || campaign.everyNthUniqueIstVisitDay !== null;
  if (!hasVisitRule) {
    return deepFreeze({ authoritative: false, timezone: BOND_TIMEZONE, uniqueDayCount: 0 });
  }
  if (
    !visitEvidence
    || visitEvidence.authoritative !== true
    || visitEvidence.timezone !== BOND_TIMEZONE
    || !Array.isArray(visitEvidence.businessDates)
  ) {
    fail('BOND_UNVERIFIED_VISIT_EVIDENCE', 'Visit-frequency campaigns require authoritative unique IST business dates.', {
      campaignId: campaign.campaignId,
      campaignVersionId: campaign.versionId,
    });
  }
  const dates = new Set();
  const eventBusinessDate = businessDateInTimeZone(eventAtMs);
  const eventOrdinal = strictBusinessDateOrdinal(eventBusinessDate);
  const lookbackOrdinal = campaign.visitWindowDays > 0
    ? eventOrdinal - ((campaign.visitWindowDays - 1) * DAY_MS)
    : null;
  const campaignStartBusinessDate = businessDateInTimeZone(campaign.effectiveFromMs);
  const campaignStartOrdinal = strictBusinessDateOrdinal(campaignStartBusinessDate);
  const minimumOrdinal = lookbackOrdinal === null
    ? campaignStartOrdinal
    : Math.max(lookbackOrdinal, campaignStartOrdinal);
  for (const value of visitEvidence.businessDates) {
    const date = requiredString(value, 'visitEvidence.businessDates[]');
    const ordinal = strictBusinessDateOrdinal(date);
    if (ordinal === null) {
      fail('BOND_INVALID_VISIT_EVIDENCE', 'Visit evidence contains an invalid IST business date.', {
        businessDate: date,
      });
    }
    if (ordinal <= eventOrdinal && (minimumOrdinal === null || ordinal >= minimumOrdinal)) {
      dates.add(date);
    }
  }
  return deepFreeze({
    authoritative: true,
    timezone: BOND_TIMEZONE,
    uniqueDayCount: dates.size,
    businessDates: [...dates].sort(),
    visitWindowDays: campaign.visitWindowDays,
    campaignStartBusinessDate,
    eventBusinessDate,
  });
}

function normalizeCampaignUsage(campaign, value) {
  const countersRequired = campaign.maxUsesPerCustomer !== null || campaign.budgetPoints !== null;
  if (!countersRequired) {
    return deepFreeze({ customerUses: 0, campaignAwardedPoints: 0, authoritative: false });
  }
  if (!value || value.authoritative !== true) {
    fail('BOND_UNVERIFIED_CAMPAIGN_USAGE', 'Campaign limits require authoritative transactional usage counters.', {
      campaignId: campaign.campaignId,
      campaignVersionId: campaign.versionId,
    });
  }
  if (
    requiredString(value.campaignId, 'campaignUsage.campaignId') !== campaign.campaignId
    || requiredString(value.campaignVersionId, 'campaignUsage.campaignVersionId') !== campaign.versionId
  ) {
    fail('BOND_CAMPAIGN_USAGE_MISMATCH', 'Usage counters do not belong to the resolved campaign version.', {
      campaignId: campaign.campaignId,
      campaignVersionId: campaign.versionId,
    });
  }
  return deepFreeze({
    customerUses: nonNegativeSafeInteger(value.customerUses, 'campaignUsage.customerUses'),
    campaignAwardedPoints: nonNegativeSafeInteger(
      value.campaignAwardedPoints,
      'campaignUsage.campaignAwardedPoints',
    ),
    authoritative: true,
  });
}

function calculateCampaignPoints(campaign, matchingSpendPaise, earnBasisPoints) {
  if (campaign.rewardType === CAMPAIGN_REWARD_TYPES.FIXED_POINTS) {
    return campaign.fixedBonusPoints;
  }
  const matchingBasePoints = calculateEarnPoints(matchingSpendPaise, earnBasisPoints).points;
  const multipliedPoints = checkedBigIntResult(
    (BigInt(matchingBasePoints) * BigInt(campaign.earnMultiplierBasisPoints))
      / BigInt(MULTIPLIER_BASIS_POINTS),
    'campaignPoints',
  );
  return Math.max(0, multipliedPoints - matchingBasePoints);
}

function calculateLiabilityPaise(points, liabilityPaisePerPoint) {
  return checkedBigIntResult(
    BigInt(nonNegativeSafeInteger(points, 'points'))
      * BigInt(nonNegativeSafeInteger(liabilityPaisePerPoint, 'liabilityPaisePerPoint', { positive: true })),
    'liabilityPaise',
  );
}

function evaluateCampaign({
  campaign,
  order,
  policy,
  campaignUsage,
  visitEvidence,
  liabilityPaisePerPoint,
  maximumCampaignPoints,
}) {
  if (!campaign) return null;
  const filteredSpend = campaignEligibleSpend(order, campaign);
  const visits = uniqueIstVisitDayEvidence(campaign, visitEvidence, order.eventAtMs);
  const usage = normalizeCampaignUsage(campaign, campaignUsage);
  const reasons = [];

  const thresholdSpendPaise = filteredSpend.filterApplied
    ? filteredSpend.eligibleSpendPaise
    : order.eligibleSpendPaise;
  if (thresholdSpendPaise < campaign.minimumEligibleSpendPaise) {
    reasons.push('MINIMUM_SPEND_NOT_MET');
  }
  if (filteredSpend.filterApplied && filteredSpend.eligibleSpendPaise === 0) {
    reasons.push('NO_ELIGIBLE_PRODUCT_OR_CATEGORY');
  }
  if (visits.uniqueDayCount < campaign.minimumUniqueIstVisitDays) {
    reasons.push('MINIMUM_UNIQUE_IST_VISIT_DAYS_NOT_MET');
  }
  if (
    campaign.everyNthUniqueIstVisitDay !== null
    && (
      visits.uniqueDayCount === 0
      || visits.uniqueDayCount % campaign.everyNthUniqueIstVisitDay !== 0
    )
  ) {
    reasons.push('NOT_FREQUENCY_VISIT_DAY');
  }
  if (
    campaign.maxUsesPerCustomer !== null
    && usage.customerUses >= campaign.maxUsesPerCustomer
  ) {
    reasons.push('CUSTOMER_USE_LIMIT_REACHED');
  }

  const configuredCampaignPoints = reasons.length === 0
    ? calculateCampaignPoints(campaign, filteredSpend.eligibleSpendPaise, policy.earnBasisPoints)
    : 0;
  const preliminaryPoints = Math.min(configuredCampaignPoints, maximumCampaignPoints);
  if (
    campaign.budgetPoints !== null
    && usage.campaignAwardedPoints + preliminaryPoints > campaign.budgetPoints
  ) {
    reasons.push('CAMPAIGN_POINTS_BUDGET_EXCEEDED');
  }
  const campaignPoints = reasons.length === 0 ? preliminaryPoints : 0;

  return deepFreeze({
    campaignId: campaign.campaignId,
    campaignVersionId: campaign.versionId,
    rewardType: campaign.rewardType,
    eligible: reasons.length === 0,
    ineligibilityReasons: reasons,
    campaignEligibleSpendPaise: filteredSpend.eligibleSpendPaise,
    campaignPoints,
    configuredCampaignPoints,
    combinedRewardCapApplied: campaignPoints > 0 && campaignPoints < configuredCampaignPoints,
    maximumCampaignPoints,
    liabilityPaise: calculateLiabilityPaise(campaignPoints, liabilityPaisePerPoint),
    matchedProductIds: filteredSpend.matchedProductIds,
    matchedCategoryIds: filteredSpend.matchedCategoryIds,
    matchedProductCodes: filteredSpend.matchedProductIds,
    matchedCategoryCodes: filteredSpend.matchedCategoryIds,
    uniqueIstVisitDays: visits.uniqueDayCount,
    customerUsesBefore: usage.customerUses,
    customerUsesAfter: usage.customerUses + (campaignPoints > 0 ? 1 : 0),
    campaignAwardedPointsBefore: usage.campaignAwardedPoints,
    campaignAwardedPointsAfter: usage.campaignAwardedPoints + campaignPoints,
    budgetPoints: campaign.budgetPoints,
    budgetRemainingAfter: campaign.budgetPoints === null
      ? null
      : campaign.budgetPoints - usage.campaignAwardedPoints - campaignPoints,
    windowSemantics: '[effectiveFrom,effectiveTo)',
  });
}

function evaluateBondReward({
  order,
  policyVersions = [],
  campaignVersions = [],
  guardrails,
  campaignUsage = null,
  visitEvidence = null,
}) {
  const normalizedOrder = normalizeOrder(order);
  const normalizedGuardrails = normalizeGuardrails(guardrails);
  const policy = resolvePolicyVersion({
    policyVersions,
    storeId: normalizedOrder.storeId,
    eventAt: normalizedOrder.eventAtMs,
    guardrails,
  });
  const campaign = resolveCampaignVersion({
    campaignVersions,
    storeId: normalizedOrder.storeId,
    eventAt: normalizedOrder.eventAtMs,
    guardrails,
  });
  if (campaign && normalizedGuardrails.source !== 'HQ_VERSIONED') {
    fail('BOND_GUARDRAILS_REQUIRED', 'A managed campaign version requires versioned HQ guardrails.', {
      campaignId: campaign.campaignId,
      campaignVersionId: campaign.versionId,
    });
  }
  const base = calculateEarnPoints(normalizedOrder.eligibleSpendPaise, policy.earnBasisPoints);
  const combinedRewardCap = calculateEarnPoints(
    normalizedOrder.eligibleSpendPaise,
    normalizedGuardrails.maxCombinedRewardRateBps,
  );
  const maximumCampaignPoints = Math.max(0, combinedRewardCap.points - base.points);
  const campaignResult = evaluateCampaign({
    campaign,
    order: normalizedOrder,
    policy,
    campaignUsage,
    visitEvidence,
    liabilityPaisePerPoint: normalizedGuardrails.liabilityPaisePerPoint,
    maximumCampaignPoints,
  });
  const campaignPoints = campaignResult?.campaignPoints || 0;
  const totalPoints = base.points + campaignPoints;
  if (!Number.isSafeInteger(totalPoints)) {
    fail('BOND_REWARD_OVERFLOW', 'Total points exceed the supported safe-integer range.');
  }
  const totalLiabilityPaise = calculateLiabilityPaise(
    totalPoints,
    normalizedGuardrails.liabilityPaisePerPoint,
  );
  const baseLiabilityPaise = calculateLiabilityPaise(
    base.points,
    normalizedGuardrails.liabilityPaisePerPoint,
  );
  const campaignLiabilityPaise = calculateLiabilityPaise(
    campaignPoints,
    normalizedGuardrails.liabilityPaisePerPoint,
  );

  return deepFreeze({
    mode: 'DRY_RUN',
    source: normalizedOrder.source,
    orderId: normalizedOrder.orderId,
    storeId: normalizedOrder.storeId,
    eventAtMs: normalizedOrder.eventAtMs,
    eligibleSpendPaise: normalizedOrder.eligibleSpendPaise,
    policy: {
      policyVersionId: policy.versionId,
      scope: policy.scope,
      source: policy.source,
      issuingStoreId: normalizedOrder.storeId,
      earnBasisPoints: policy.earnBasisPoints,
      earnRateBps: policy.earnBasisPoints,
      effectiveFromMs: policy.effectiveFromMs,
      effectiveToMs: policy.effectiveToMs,
      windowSemantics: policy.windowSemantics,
    },
    campaign: campaignResult,
    reward: {
      basePoints: base.points,
      campaignPoints,
      totalPoints,
      maxCombinedRewardRateBps: normalizedGuardrails.maxCombinedRewardRateBps,
      combinedRewardCapPoints: combinedRewardCap.points,
      combinedRewardCapApplied: Boolean(campaignResult?.combinedRewardCapApplied),
      pointValuePaise: normalizedGuardrails.liabilityPaisePerPoint,
      baseLiabilityPaise,
      campaignLiabilityPaise,
      totalLiabilityPaise,
      totalLiabilityRupees: totalLiabilityPaise / 100,
    },
    ledgerEvidence: {
      issuingStoreId: normalizedOrder.storeId,
      policyVersionId: policy.versionId,
      campaignId: campaignResult?.campaignId || null,
      campaignVersionId: campaignResult?.campaignVersionId || null,
    },
    idempotencyEvidence: {
      logicalEventType: 'ORDER_POINT_EARN',
      logicalEventKey: `ORDER_POINT_EARN:${normalizedOrder.orderId}`,
      sourceOrderId: normalizedOrder.orderId,
      stableAcrossPolicyOrCampaignChanges: true,
      excludesPolicyAndCampaignVersions: true,
    },
  });
}

function dryRunBondReward(input) {
  return evaluateBondReward(input);
}

module.exports = {
  BOND_TIMEZONE,
  BondPolicyCampaignError,
  CAMPAIGN_REWARD_TYPES,
  LEGACY_DEFAULT_EARN_BASIS_POINTS,
  MULTIPLIER_BASIS_POINTS,
  POINT_VALUE_PAISE,
  POLICY_SCOPES,
  calculateEarnPoints,
  dryRunBondReward,
  evaluateBondReward,
  normalizeGuardrails,
  resolveCampaignVersion,
  resolvePolicyVersion,
  validateCampaignVersion,
  validatePolicyVersion,
};
