'use strict';

const { createHash } = require('node:crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');

const REGION_FALLBACK = 'us-central1';
const GUARDRAIL_VERSIONS = 'bondPolicyGuardrails';
const POLICY_VERSIONS = 'bondPolicyVersions';
const CAMPAIGN_VERSIONS = 'bondCampaignVersions';
const POLICY_SCOPES = 'bondPolicyScopes';
const CAMPAIGN_SCOPES = 'bondCampaignScopes';
const CAMPAIGN_BUDGETS = 'bondCampaignBudgets';
const CAMPAIGN_CUSTOMER_USAGE = 'bondCampaignCustomerUsage';
const CAMPAIGN_QUALIFICATION_EVENTS = 'bondCampaignQualificationEvents';
const MANAGEMENT_AUDIT = 'bondPolicyAudit';
const REWARD_APPROVALS = 'bondRewardApprovals';
const REWARD_SCHEDULES = 'bondRewardSchedules';

const CONFIGURATION_TYPES = new Set(['GUARDRAIL', 'POLICY', 'CAMPAIGN']);
const MANAGER_ROLES = new Set(['ADMIN', 'FRANCHISE_MANAGER']);
const SUBMITTED_STATES = new Set(['PENDING_APPROVAL', 'APPROVED', 'SCHEDULED']);
const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 330 * 60 * 1000;

function fail(code, message) {
  throw new HttpsError(code, message);
}

function cleanText(value, maxLength = 240) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function requiredReason(value) {
  const reason = cleanText(value, 500);
  if (!reason) fail('invalid-argument', 'A business reason is required for the immutable audit history.');
  return reason;
}

function cleanId(value, field = 'Identifier') {
  const result = cleanText(value, 180);
  if (!result || !/^[A-Za-z0-9_-]+$/.test(result)) {
    fail('invalid-argument', `${field} is invalid.`);
  }
  return result;
}

function uniqueStrings(value, maxLength = 180) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(entry => cleanText(entry, maxLength)).filter(Boolean))].sort();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object' && !(value instanceof Date) && typeof value.toMillis !== 'function') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function definitionHash(definition) {
  return sha256(stableJson(definition));
}

function requestIdFrom(data) {
  const requestId = cleanText(data?.requestId, 180);
  if (requestId.length < 12 || !/^[A-Za-z0-9:_-]+$/.test(requestId)) {
    fail('invalid-argument', 'A stable requestId of at least 12 characters is required.');
  }
  return requestId;
}

function deterministicId(prefix, ...parts) {
  return `${prefix}_${sha256(parts.join(':')).slice(0, 40)}`;
}

function auditId(action, actorUid, requestId) {
  return deterministicId('BOND_AUDIT', action, actorUid, requestId);
}

function requiredInteger(value, field, { minimum = null } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (minimum !== null && parsed < minimum)) {
    fail('invalid-argument', `${field} must be a whole number${minimum === null ? '' : ` of at least ${minimum}`}.`);
  }
  return parsed;
}

function optionalInteger(value, field, options) {
  if (value === null || value === undefined || value === '') return null;
  return requiredInteger(value, field, options);
}

function timestampMillis(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(cleanText(value, 80));
  return Number.isFinite(parsed) ? parsed : null;
}

function inputMillis(value, field, { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) fail('invalid-argument', `${field} is required.`);
    return null;
  }
  const millis = timestampMillis(value);
  if (!Number.isFinite(millis) || millis <= 0) fail('invalid-argument', `${field} is invalid.`);
  return millis;
}

function firestoreTimestamp(admin, millis) {
  return admin.firestore.Timestamp.fromMillis(millis);
}

function serializableTimestamp(value) {
  const millis = timestampMillis(value);
  return millis === null ? null : new Date(millis).toISOString();
}

function istDayOrdinal(millis) {
  return Math.floor((millis + IST_OFFSET_MS) / DAY_MS);
}

function istBusinessDate(millis) {
  return new Date(istDayOrdinal(millis) * DAY_MS).toISOString().slice(0, 10);
}

function intersectingIstCalendarDays(startsAtMillis, endsAtMillis) {
  if (!Number.isFinite(startsAtMillis) || !Number.isFinite(endsAtMillis) || endsAtMillis <= startsAtMillis) return 0;
  return istDayOrdinal(endsAtMillis - 1) - istDayOrdinal(startsAtMillis) + 1;
}

function prospectiveIstVisitInstants(startsAtMillis, endsAtMillis, throughMillis = endsAtMillis - 1) {
  const effectiveEnd = Math.min(endsAtMillis - 1, throughMillis);
  if (effectiveEnd < startsAtMillis) return [];
  const instants = [];
  for (let day = istDayOrdinal(startsAtMillis); day <= istDayOrdinal(effectiveEnd); day += 1) {
    const dayStartsAt = (day * DAY_MS) - IST_OFFSET_MS;
    const instant = Math.max(startsAtMillis, dayStartsAt);
    if (instant <= effectiveEnd && instant < endsAtMillis) instants.push(instant);
  }
  return instants;
}

function assignedStoreIds(profile) {
  return uniqueStrings([
    ...(Array.isArray(profile?.storeIds) ? profile.storeIds : []),
    ...(Array.isArray(profile?.assignedStoreIds) ? profile.assignedStoreIds : []),
  ]);
}

function assertStoreScope(profile, storeIds, { allowGlobal = false } = {}) {
  if (profile.role === 'ADMIN') return;
  if (allowGlobal && storeIds.length === 0) return;
  const allowed = new Set(profile.assignedStoreIds);
  if (storeIds.length === 0 || !storeIds.every(storeId => allowed.has(storeId))) {
    fail('permission-denied', 'One or more stores are outside your assigned access.');
  }
}

async function loadManagerProfile(db, request) {
  const uid = cleanText(request.auth?.uid, 128);
  if (!uid) fail('unauthenticated', 'Staff sign-in is required.');
  const snapshot = await db.collection('users').doc(uid).get();
  if (!snapshot.exists) fail('permission-denied', 'An active staff profile is required.');
  const data = snapshot.data() || {};
  const role = cleanText(data.role, 40);
  if (data.isActive !== true || !MANAGER_ROLES.has(role)) {
    fail('permission-denied', 'BOND Policy Manager access is not available to this role.');
  }
  if (data.mustChangePassword === true) {
    fail('failed-precondition', 'Change the temporary password before opening BOND Policy Manager.');
  }
  return {
    uid,
    role,
    name: cleanText(data.displayName || data.name || request.auth?.token?.name, 120) || 'Staff',
    assignedStoreIds: assignedStoreIds(data),
  };
}

function normalizeConfigurationType(value, fallback = null) {
  const result = cleanText(value || fallback, 40).toUpperCase();
  if (!CONFIGURATION_TYPES.has(result)) fail('invalid-argument', 'Unknown BOND configuration type.');
  return result;
}

function normalizeGuardrails(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid-argument', 'HQ guardrails are required.');
  }
  const guardrails = {
    minEarnRateBps: requiredInteger(value.minEarnRateBps, 'Minimum earn percentage', { minimum: 0 }),
    maxEarnRateBps: requiredInteger(value.maxEarnRateBps, 'Maximum earn percentage', { minimum: 0 }),
    maxCombinedRewardRateBps: requiredInteger(value.maxCombinedRewardRateBps, 'Maximum combined base and campaign reward', { minimum: 0 }),
    maxMultiplierBps: requiredInteger(value.maxMultiplierBps, 'Maximum multiplier', { minimum: 0 }),
    maxFixedBonusPoints: requiredInteger(value.maxFixedBonusPoints, 'Maximum fixed bonus', { minimum: 0 }),
    maxCampaignDays: requiredInteger(value.maxCampaignDays, 'Maximum campaign days', { minimum: 1 }),
    maxCustomerAwards: requiredInteger(value.maxCustomerAwards, 'Maximum customer awards', { minimum: 1 }),
    maxCampaignBudgetPoints: requiredInteger(value.maxCampaignBudgetPoints, 'Maximum campaign budget', { minimum: 1 }),
    liabilityPaisePerPoint: requiredInteger(value.liabilityPaisePerPoint, 'Point liability', { minimum: 1 }),
  };
  if (guardrails.minEarnRateBps > guardrails.maxEarnRateBps) {
    fail('invalid-argument', 'Minimum earn percentage cannot exceed the maximum.');
  }
  if (guardrails.maxCombinedRewardRateBps < guardrails.maxEarnRateBps) {
    fail('invalid-argument', 'Maximum combined reward cannot be below the maximum base earn percentage.');
  }
  return guardrails;
}

function normalizePolicyInput(data) {
  const requestedType = cleanText(data?.configurationType, 40).toUpperCase();
  const scopeInput = cleanText(data?.scope, 40).toUpperCase();
  if (requestedType === 'GUARDRAIL' || scopeInput === 'GUARDRAIL') {
    const definition = {
      schemaVersion: 1,
      configurationType: 'GUARDRAIL',
      guardrails: normalizeGuardrails(data.guardrails || data.definition?.guardrails || data.definition),
      reason: requiredReason(data.reason || data.definition?.reason),
    };
    return { configurationType: 'GUARDRAIL', storeIds: [], definition };
  }
  const scope = scopeInput === 'STORE_OVERRIDE' ? 'STORE' : scopeInput;
  if (!['GLOBAL', 'STORE'].includes(scope)) fail('invalid-argument', 'Policy scope must be GLOBAL or STORE.');
  const storeIds = uniqueStrings(data.storeIds || data.definition?.storeIds);
  if (scope === 'GLOBAL' && storeIds.length !== 0) fail('invalid-argument', 'A global policy cannot select stores.');
  if (scope === 'STORE' && storeIds.length === 0) fail('invalid-argument', 'Select at least one store for an override.');
  const startsAtMillis = inputMillis(
    data.startsAt ?? data.definition?.startsAt,
    'Policy start',
    { required: true },
  );
  const endsAtMillis = inputMillis(data.endsAt ?? data.definition?.endsAt, 'Policy end');
  if (startsAtMillis !== null && endsAtMillis !== null && endsAtMillis <= startsAtMillis) {
    fail('invalid-argument', 'Policy end must be after its start.');
  }
  const definition = {
    schemaVersion: 1,
    configurationType: 'POLICY',
    scope,
    storeIds,
    earnRateBps: requiredInteger(data.earnRateBps ?? data.definition?.earnRateBps, 'Earn percentage', { minimum: 0 }),
    campaignStackingMode: cleanText(
      data.campaignStackingMode ?? data.stackingMode ?? data.definition?.campaignStackingMode ?? data.definition?.stackingMode ?? 'BASE_PLUS_ONE_CAMPAIGN',
      40,
    ).toUpperCase(),
    startsAt: new Date(startsAtMillis).toISOString(),
    endsAt: endsAtMillis === null ? null : new Date(endsAtMillis).toISOString(),
    reason: requiredReason(data.reason || data.definition?.reason),
    channel: 'CUSTOMER_ORDERING_ONLY',
    nativePosEligible: false,
  };
  if (!['NONE', 'BASE_PLUS_ONE_CAMPAIGN', 'EXCLUSIVE_ONE'].includes(definition.campaignStackingMode)) {
    fail('invalid-argument', 'Campaign stacking must be NONE or BASE_PLUS_ONE_CAMPAIGN.');
  }
  if (definition.campaignStackingMode === 'EXCLUSIVE_ONE') {
    definition.campaignStackingMode = 'BASE_PLUS_ONE_CAMPAIGN';
  }
  const embeddedGuardrails = data.guardrails || data.definition?.guardrails;
  return {
    configurationType: 'POLICY',
    storeIds,
    definition,
    embeddedGuardrails: embeddedGuardrails ? normalizeGuardrails(embeddedGuardrails) : null,
    requestedGuardrailVersionId: cleanText(data.guardrailVersionId || data.definition?.guardrailVersionId, 180) || null,
  };
}

function normalizeCampaignInput(data) {
  const source = data?.definition && typeof data.definition === 'object' ? { ...data.definition, ...data } : data;
  const storeIds = uniqueStrings(source?.storeIds);
  if (storeIds.length === 0) fail('invalid-argument', 'Select at least one campaign store.');
  const startsAtMillis = inputMillis(source.startsAt, 'Campaign start', { required: true });
  const endsAtMillis = inputMillis(source.endsAt, 'Campaign end', { required: true });
  if (endsAtMillis <= startsAtMillis) fail('invalid-argument', 'Campaign end must be after its start.');
  const rawRewardType = cleanText(source.rewardType, 40).toUpperCase();
  const rewardType = rawRewardType === 'FIXED_BONUS_POINTS' ? 'FIXED_POINTS'
    : rawRewardType === 'PERCENTAGE_BONUS_POINTS' ? 'PERCENTAGE_BONUS'
    : rawRewardType === 'MULTIPLIER' ? 'EARN_MULTIPLIER'
      : rawRewardType;
  if (!['FIXED_POINTS', 'PERCENTAGE_BONUS', 'EARN_MULTIPLIER'].includes(rewardType)) {
    fail('invalid-argument', 'Campaign reward must be fixed points, a percentage bonus, or an earn multiplier.');
  }
  const fixedBonusPoints = rewardType === 'FIXED_POINTS'
    ? requiredInteger(source.fixedBonusPoints, 'Fixed bonus points', { minimum: 1 })
    : null;
  const multiplierBps = rewardType === 'EARN_MULTIPLIER'
    ? requiredInteger(source.multiplierBps, 'Earn multiplier', { minimum: 10001 })
    : null;
  const percentageBonusBps = rewardType === 'PERCENTAGE_BONUS'
    ? requiredInteger(source.percentageBonusBps ?? source.bonusRateBps, 'Percentage bonus', { minimum: 1 })
    : null;
  const minimumUniqueVisitDays = requiredInteger(source.minimumUniqueVisitDays ?? 0, 'Minimum unique visit days', { minimum: 0 });
  const visitWindowMode = cleanText(
    source.visitWindowMode ?? (source.calendarWeekIST === true ? 'CALENDAR_WEEK_IST' : 'ROLLING_IST_DAYS'),
    40,
  ).toUpperCase();
  if (!['ROLLING_IST_DAYS', 'CALENDAR_WEEK_IST'].includes(visitWindowMode)) {
    fail('invalid-argument', 'Visit window must be rolling IST days or Monday–Sunday IST.');
  }
  const configuredVisitWindowDays = visitWindowMode === 'CALENDAR_WEEK_IST'
    ? (source.visitWindowDays === null || source.visitWindowDays === undefined || source.visitWindowDays === ''
      ? 7
      : requiredInteger(source.visitWindowDays, 'Visit window days', { minimum: 1 }))
    : minimumUniqueVisitDays > 0
      ? requiredInteger(source.visitWindowDays, 'Visit window days', { minimum: 1 })
      : optionalInteger(source.visitWindowDays, 'Visit window days', { minimum: 1 });
  if (visitWindowMode === 'CALENDAR_WEEK_IST' && configuredVisitWindowDays !== 7) {
    fail('invalid-argument', 'A Monday–Sunday IST visit window is always seven calendar days.');
  }
  const visitWindowDays = configuredVisitWindowDays;
  const stackingMode = cleanText(source.stackingMode || 'BASE_PLUS_ONE_CAMPAIGN', 40).toUpperCase();
  if (!['NONE', 'BASE_PLUS_ONE_CAMPAIGN', 'EXCLUSIVE_ONE'].includes(stackingMode)) {
    fail('invalid-argument', 'Campaign stacking must be NONE or BASE_PLUS_ONE_CAMPAIGN.');
  }
  const definition = {
    schemaVersion: 1,
    configurationType: 'CAMPAIGN',
    campaignId: cleanText(source.campaignId, 180) || null,
    name: cleanText(source.name, 120),
    storeIds,
    startsAt: new Date(startsAtMillis).toISOString(),
    endsAt: new Date(endsAtMillis).toISOString(),
    rewardType,
    fixedBonusPoints,
    percentageBonusBps,
    multiplierBps,
    minimumSpendPaise: requiredInteger(source.minimumSpendPaise ?? 0, 'Minimum spend', { minimum: 0 }),
    spendMilestonePaise: optionalInteger(source.spendMilestonePaise, 'Spend milestone', { minimum: 1 }),
    eligibleProductCodes: uniqueStrings(source.eligibleProductCodes, 80),
    eligibleCategoryCodes: uniqueStrings(source.eligibleCategoryCodes, 80),
    minimumUniqueVisitDays,
    visitWindowDays,
    visitWindowMode,
    visitBasis: 'UNIQUE_IST_VISIT_DAYS',
    visitCountingMode: 'PROSPECTIVE_CAMPAIGN_WINDOW',
    customerAwardLimit: requiredInteger(source.customerAwardLimit, 'Customer award limit', { minimum: 1 }),
    budgetPoints: requiredInteger(source.budgetPoints, 'Campaign point budget', { minimum: 1 }),
    maximumAwardPointsPerOrder: optionalInteger(
      source.maximumAwardPointsPerOrder ?? source.maxCampaignPointsPerOrder,
      'Maximum campaign points per order',
      { minimum: 1 },
    ),
    frequencyAwardLimit: optionalInteger(source.frequencyAwardLimit, 'Campaign frequency limit', { minimum: 1 }),
    frequencyWindow: source.frequencyAwardLimit === null || source.frequencyAwardLimit === undefined || source.frequencyAwardLimit === ''
      ? null
      : cleanText(source.frequencyWindow || 'CAMPAIGN', 40).toUpperCase(),
    frequencyWindowDays: optionalInteger(source.frequencyWindowDays, 'Campaign frequency window days', { minimum: 1 }),
    eligibleIstWeekdays: uniqueStrings(source.eligibleIstWeekdays, 20),
    startsAtMinuteIST: optionalInteger(source.startsAtMinuteIST, 'Campaign start minute IST', { minimum: 0 }),
    endsAtMinuteIST: optionalInteger(source.endsAtMinuteIST, 'Campaign end minute IST', { minimum: 0 }),
    stackingMode: stackingMode === 'EXCLUSIVE_ONE' ? 'BASE_PLUS_ONE_CAMPAIGN' : stackingMode,
    reason: requiredReason(source.reason),
    channel: 'CUSTOMER_ORDERING_ONLY',
    nativePosEligible: false,
  };
  if (!definition.name) fail('invalid-argument', 'Campaign name is required.');
  return {
    configurationType: 'CAMPAIGN',
    storeIds,
    definition,
    requestedGuardrailVersionId: cleanText(source.guardrailVersionId, 180) || null,
  };
}

function validatePolicyAgainstGuardrails(definition, guardrails) {
  if (definition.earnRateBps < guardrails.minEarnRateBps || definition.earnRateBps > guardrails.maxEarnRateBps) {
    fail('failed-precondition', 'The earn percentage is outside the approved HQ guardrails.');
  }
}

function validateCampaignAgainstGuardrails(definition, guardrails) {
  if (definition.rewardType === 'FIXED_POINTS' && definition.fixedBonusPoints > guardrails.maxFixedBonusPoints) {
    fail('failed-precondition', 'The fixed bonus exceeds the approved HQ guardrail.');
  }
  if (definition.rewardType === 'FIXED_POINTS' && definition.fixedBonusPoints > definition.budgetPoints) {
    fail('failed-precondition', 'The fixed bonus exceeds the campaign budget and could never be awarded.');
  }
  if (definition.rewardType === 'EARN_MULTIPLIER' && definition.multiplierBps > guardrails.maxMultiplierBps) {
    fail('failed-precondition', 'The earn multiplier exceeds the approved HQ guardrail.');
  }
  if (definition.rewardType === 'PERCENTAGE_BONUS' && definition.percentageBonusBps > guardrails.maxCombinedRewardRateBps) {
    fail('failed-precondition', 'The percentage campaign bonus exceeds the combined reward cap.');
  }
  if (definition.spendMilestonePaise !== null && definition.rewardType !== 'FIXED_POINTS') {
    fail('failed-precondition', 'A cumulative spend milestone must use fixed bonus points.');
  }
  if (definition.frequencyWindow !== null && !['CAMPAIGN', 'DAY_IST', 'WEEK_IST', 'ROLLING_DAYS'].includes(definition.frequencyWindow)) {
    fail('failed-precondition', 'Campaign frequency window is invalid.');
  }
  if (definition.frequencyWindow === 'ROLLING_DAYS' && definition.frequencyWindowDays === null) {
    fail('failed-precondition', 'A rolling campaign frequency limit requires a number of days.');
  }
  if ((definition.startsAtMinuteIST === null) !== (definition.endsAtMinuteIST === null)) {
    fail('failed-precondition', 'A day/time promotion requires both IST time bounds.');
  }
  if (
    (definition.startsAtMinuteIST !== null && definition.startsAtMinuteIST >= 1440)
    || (definition.endsAtMinuteIST !== null && definition.endsAtMinuteIST >= 1440)
  ) {
    fail('failed-precondition', 'IST time bounds must be between 00:00 and 23:59.');
  }
  if (definition.eligibleIstWeekdays.some(day => !['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].includes(day))) {
    fail('failed-precondition', 'Campaign weekdays must be uppercase Monday–Sunday names.');
  }
  const durationDays = intersectingIstCalendarDays(
    Date.parse(definition.startsAt),
    Date.parse(definition.endsAt),
  );
  if (durationDays > guardrails.maxCampaignDays) {
    fail('failed-precondition', 'The campaign duration exceeds the approved HQ guardrail.');
  }
  if (definition.minimumUniqueVisitDays > durationDays) {
    fail('failed-precondition', 'The campaign window cannot contain the configured number of prospective unique IST visit days.');
  }
  if (
    definition.minimumUniqueVisitDays > 0
    && definition.visitWindowDays < definition.minimumUniqueVisitDays
  ) {
    fail('failed-precondition', 'The visit lookback window cannot contain the configured number of unique IST visit days.');
  }
  if (definition.visitWindowMode === 'CALENDAR_WEEK_IST' && definition.visitWindowDays !== 7) {
    fail('failed-precondition', 'A Monday–Sunday IST visit window must be exactly seven days.');
  }
  if (definition.customerAwardLimit > guardrails.maxCustomerAwards) {
    fail('failed-precondition', 'The customer award limit exceeds the approved HQ guardrail.');
  }
  if (definition.budgetPoints > guardrails.maxCampaignBudgetPoints) {
    fail('failed-precondition', 'The campaign budget exceeds the approved HQ guardrail.');
  }
}

function versionCollection(db, configurationType) {
  if (configurationType === 'GUARDRAIL') return db.collection(GUARDRAIL_VERSIONS);
  if (configurationType === 'POLICY') return db.collection(POLICY_VERSIONS);
  if (configurationType === 'CAMPAIGN') return db.collection(CAMPAIGN_VERSIONS);
  fail('invalid-argument', 'Unknown BOND configuration type.');
}

function dataFromSnapshot(snapshot) {
  return snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
}

async function activeStoresInTransaction(transaction, db, storeIds) {
  if (storeIds.length === 0) return [];
  const snapshots = await Promise.all(storeIds.map(storeId => (
    transaction.get(db.collection('stores').doc(storeId))
  )));
  const stores = snapshots.map(dataFromSnapshot);
  if (stores.some(store => !store || store.isActive !== true)) {
    fail('failed-precondition', 'Every selected store must exist and be active.');
  }
  return stores;
}

function approvedAtMillis(value) {
  return timestampMillis(value?.approvedAt) || 0;
}

function latestApprovedGuardrail(documents) {
  return documents
    .filter(document => document.status === 'APPROVED' || document.status === 'SCHEDULED')
    .sort((left, right) => approvedAtMillis(right) - approvedAtMillis(left) || right.id.localeCompare(left.id))[0] || null;
}

async function approvedGuardrailInTransaction(transaction, db, requestedId) {
  if (requestedId) {
    const snapshot = await transaction.get(db.collection(GUARDRAIL_VERSIONS).doc(requestedId));
    const guardrail = dataFromSnapshot(snapshot);
    if (!guardrail || !['APPROVED', 'SCHEDULED'].includes(guardrail.status)) {
      fail('failed-precondition', 'The selected HQ guardrail version is not approved.');
    }
    return guardrail;
  }
  const snapshots = await transaction.get(db.collection(GUARDRAIL_VERSIONS).where('status', '==', 'APPROVED'));
  const guardrail = latestApprovedGuardrail(snapshots.docs.map(dataFromSnapshot));
  if (!guardrail) fail('failed-precondition', 'An approved HQ guardrail version is required before managed activation.');
  return guardrail;
}

function auditPayload({
  admin,
  action,
  actor,
  requestId,
  requestHash,
  configurationType,
  entityId,
  definitionHash: hash,
  linkedDefinitionHashes = null,
  storeIds,
  reason,
  result,
  effectiveAt = null,
}) {
  return {
    action,
    requestId,
    requestHash,
    actorUid: actor.uid,
    actorName: actor.name,
    actorRole: actor.role,
    actorAssignedStoreIds: actor.assignedStoreIds,
    configurationType,
    entityId,
    definitionHash: hash || null,
    linkedDefinitionHashes: linkedDefinitionHashes || {},
    storeIds: storeIds || [],
    reason: cleanText(reason, 500) || null,
    effectiveAt,
    result,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

function existingAuditResponse(snapshot, requestHash, action) {
  if (!snapshot.exists) return null;
  const audit = snapshot.data() || {};
  if (audit.requestHash !== requestHash || audit.action !== action) {
    fail('already-exists', 'This requestId was already used for a different BOND operation.');
  }
  return audit.result || { ok: true, idempotent: true };
}

function serializeDocument(document) {
  if (!document) return null;
  const output = { ...document };
  for (const field of ['createdAt', 'updatedAt', 'submittedAt', 'approvedAt', 'scheduledAt', 'startsAt', 'endsAt', 'pausedAt']) {
    if (Object.prototype.hasOwnProperty.call(output, field)) output[field] = serializableTimestamp(output[field]);
  }
  return output;
}

function createBondPolicyCampaignManagerService({ admin, db, now = () => Date.now() }) {
  async function savePolicyDraft(request) {
    const actor = await loadManagerProfile(db, request);
    const requestId = requestIdFrom(request.data);
    const normalized = normalizePolicyInput(request.data);
    if (normalized.configurationType === 'GUARDRAIL' && actor.role !== 'ADMIN') {
      fail('permission-denied', 'Only HQ Admin may define guardrails.');
    }
    if (normalized.configurationType === 'POLICY') {
      if (normalized.definition.scope === 'GLOBAL' && actor.role !== 'ADMIN') {
        fail('permission-denied', 'Only HQ Admin may define the global earn policy.');
      }
      assertStoreScope(actor, normalized.storeIds);
      if (normalized.embeddedGuardrails && actor.role !== 'ADMIN') {
        fail('permission-denied', 'Only HQ Admin may define guardrails.');
      }
    }
    const requestedDraftId = cleanText(request.data?.draftId, 180);
    const versionId = requestedDraftId
      ? cleanId(requestedDraftId, 'Draft identifier')
      : deterministicId(normalized.configurationType, actor.uid, requestId);
    const collection = versionCollection(db, normalized.configurationType);
    const versionRef = collection.doc(versionId);
    const linkedGuardrailVersionId = normalized.embeddedGuardrails
      ? deterministicId('GUARDRAIL', actor.uid, requestId)
      : normalized.requestedGuardrailVersionId;
    const definition = normalized.configurationType === 'POLICY'
      ? { ...normalized.definition, guardrailVersionId: linkedGuardrailVersionId || null }
      : normalized.definition;
    const embeddedGuardrailDefinition = normalized.embeddedGuardrails ? {
      schemaVersion: 1,
      configurationType: 'GUARDRAIL',
      guardrails: normalized.embeddedGuardrails,
      reason: definition.reason,
    } : null;
    const embeddedGuardrailDefinitionHash = embeddedGuardrailDefinition
      ? definitionHash(embeddedGuardrailDefinition)
      : null;
    const hash = definitionHash(definition);
    const action = normalized.configurationType === 'GUARDRAIL' ? 'SAVE_GUARDRAIL_DRAFT' : 'SAVE_POLICY_DRAFT';
    const requestHash = definitionHash({
      action,
      versionId,
      definition,
      embeddedGuardrailDefinition,
    });
    const auditRef = db.collection(MANAGEMENT_AUDIT).doc(auditId(action, actor.uid, requestId));
    const result = await db.runTransaction(async transaction => {
      const guardrailRef = normalized.embeddedGuardrails
        ? db.collection(GUARDRAIL_VERSIONS).doc(linkedGuardrailVersionId)
        : null;
      const [auditSnapshot, currentSnapshot, guardrailSnapshot, selectedStores] = await Promise.all([
        transaction.get(auditRef),
        transaction.get(versionRef),
        guardrailRef ? transaction.get(guardrailRef) : Promise.resolve(null),
        activeStoresInTransaction(transaction, db, normalized.storeIds),
      ]);
      void selectedStores;
      const prior = existingAuditResponse(auditSnapshot, requestHash, action);
      if (prior) return prior;
      const current = dataFromSnapshot(currentSnapshot);
      if (current && current.status !== 'DRAFT') {
        fail('failed-precondition', 'Submitted and approved definitions are immutable. Create a new version.');
      }
      if (current) assertStoreScope(actor, current.storeIds || []);
      const write = {
        versionId,
        configurationType: normalized.configurationType,
        definition,
        definitionHash: hash,
        storeIds: normalized.storeIds,
        status: 'DRAFT',
        immutable: false,
        guardrailVersionId: definition.guardrailVersionId || null,
        createdBy: current?.createdBy || actor.uid,
        createdByName: current?.createdByName || actor.name,
        createdAt: current?.createdAt || admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: actor.uid,
        updatedByName: actor.name,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (normalized.embeddedGuardrails) {
        const existingGuardrail = dataFromSnapshot(guardrailSnapshot);
        if (existingGuardrail && existingGuardrail.status !== 'DRAFT') {
          fail('failed-precondition', 'The linked HQ guardrail definition is immutable.');
        }
        transaction.set(guardrailRef, {
          versionId: linkedGuardrailVersionId,
          configurationType: 'GUARDRAIL',
          definition: embeddedGuardrailDefinition,
          definitionHash: embeddedGuardrailDefinitionHash,
          storeIds: [],
          status: 'DRAFT',
          immutable: false,
          linkedPolicyVersionId: versionId,
          createdBy: existingGuardrail?.createdBy || actor.uid,
          createdByName: existingGuardrail?.createdByName || actor.name,
          createdAt: existingGuardrail?.createdAt || admin.firestore.FieldValue.serverTimestamp(),
          updatedBy: actor.uid,
          updatedByName: actor.name,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: false });
      }
      transaction.set(versionRef, write, { merge: false });
      const response = {
        ok: true,
        configurationType: normalized.configurationType,
        versionId,
        draftId: versionId,
        definitionHash: hash,
        guardrailVersionId: linkedGuardrailVersionId || null,
        linkedGuardrailDefinitionHash: embeddedGuardrailDefinitionHash,
        status: 'DRAFT',
        immutable: false,
      };
      transaction.create(auditRef, auditPayload({
        admin, action, actor, requestId, requestHash,
        configurationType: normalized.configurationType,
        entityId: versionId,
        definitionHash: hash,
        linkedDefinitionHashes: embeddedGuardrailDefinitionHash
          ? { guardrail: embeddedGuardrailDefinitionHash }
          : null,
        storeIds: normalized.storeIds,
        reason: definition.reason,
        result: response,
      }));
      return response;
    });
    return result;
  }

  async function saveCampaignDraft(request) {
    const actor = await loadManagerProfile(db, request);
    const requestId = requestIdFrom(request.data);
    const normalized = normalizeCampaignInput(request.data);
    assertStoreScope(actor, normalized.storeIds);
    const requestedDraftId = cleanText(request.data?.draftId, 180);
    const versionId = requestedDraftId
      ? cleanId(requestedDraftId, 'Draft identifier')
      : deterministicId('CAMPAIGN', actor.uid, requestId);
    const campaignId = normalized.definition.campaignId || deterministicId('CAMPAIGN_FAMILY', versionId);
    const definition = {
      ...normalized.definition,
      campaignId,
      guardrailVersionId: normalized.requestedGuardrailVersionId || null,
    };
    const hash = definitionHash(definition);
    const action = 'SAVE_CAMPAIGN_DRAFT';
    const requestHash = definitionHash({ action, versionId, definition });
    const versionRef = db.collection(CAMPAIGN_VERSIONS).doc(versionId);
    const auditRef = db.collection(MANAGEMENT_AUDIT).doc(auditId(action, actor.uid, requestId));
    return db.runTransaction(async transaction => {
      const [auditSnapshot, currentSnapshot, selectedStores] = await Promise.all([
        transaction.get(auditRef),
        transaction.get(versionRef),
        activeStoresInTransaction(transaction, db, normalized.storeIds),
      ]);
      void selectedStores;
      const prior = existingAuditResponse(auditSnapshot, requestHash, action);
      if (prior) return prior;
      const current = dataFromSnapshot(currentSnapshot);
      if (current && current.status !== 'DRAFT') {
        fail('failed-precondition', 'Submitted and approved definitions are immutable. Create a new version.');
      }
      if (current) assertStoreScope(actor, current.storeIds || []);
      transaction.set(versionRef, {
        versionId,
        campaignId,
        configurationType: 'CAMPAIGN',
        definition,
        definitionHash: hash,
        storeIds: normalized.storeIds,
        guardrailVersionId: definition.guardrailVersionId,
        status: 'DRAFT',
        immutable: false,
        createdBy: current?.createdBy || actor.uid,
        createdByName: current?.createdByName || actor.name,
        createdAt: current?.createdAt || admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: actor.uid,
        updatedByName: actor.name,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: false });
      const response = {
        ok: true,
        configurationType: 'CAMPAIGN',
        versionId,
        draftId: versionId,
        campaignId,
        definitionHash: hash,
        status: 'DRAFT',
        immutable: false,
      };
      transaction.create(auditRef, auditPayload({
        admin, action, actor, requestId, requestHash,
        configurationType: 'CAMPAIGN', entityId: versionId,
        definitionHash: hash, storeIds: normalized.storeIds,
        reason: definition.reason, result: response,
      }));
      return response;
    });
  }

  async function submitVersion(request, expectedType) {
    const actor = await loadManagerProfile(db, request);
    const requestId = requestIdFrom(request.data);
    const configurationType = normalizeConfigurationType(request.data?.configurationType, expectedType);
    if (expectedType === 'POLICY' && !['POLICY', 'GUARDRAIL'].includes(configurationType)) {
      fail('invalid-argument', 'This endpoint submits policy or guardrail drafts only.');
    }
    if (expectedType === 'CAMPAIGN' && configurationType !== 'CAMPAIGN') {
      fail('invalid-argument', 'This endpoint submits campaign drafts only.');
    }
    if (configurationType === 'GUARDRAIL' && actor.role !== 'ADMIN') {
      fail('permission-denied', 'Only HQ Admin may submit guardrails.');
    }
    const versionId = cleanId(request.data?.versionId || request.data?.draftId, 'Version identifier');
    const versionRef = versionCollection(db, configurationType).doc(versionId);
    const action = `SUBMIT_${configurationType}_DRAFT`;
    const requestHash = definitionHash({ action, versionId });
    const auditRef = db.collection(MANAGEMENT_AUDIT).doc(auditId(action, actor.uid, requestId));
    return db.runTransaction(async transaction => {
      const [auditSnapshot, versionSnapshot] = await Promise.all([
        transaction.get(auditRef),
        transaction.get(versionRef),
      ]);
      const prior = existingAuditResponse(auditSnapshot, requestHash, action);
      if (prior) return prior;
      const version = dataFromSnapshot(versionSnapshot);
      if (!version) fail('not-found', 'BOND draft not found.');
      assertStoreScope(actor, version.storeIds || []);
      if (configurationType === 'POLICY' && version.definition?.scope === 'GLOBAL' && actor.role !== 'ADMIN') {
        fail('permission-denied', 'Only HQ Admin may submit the global policy.');
      }
      if (version.status !== 'DRAFT') {
        if (SUBMITTED_STATES.has(version.status)) {
          fail('failed-precondition', 'This definition was already submitted and is immutable.');
        }
        fail('failed-precondition', 'Only a draft may be submitted.');
      }
      const expectedHash = definitionHash(version.definition);
      if (expectedHash !== version.definitionHash) fail('data-loss', 'Draft definition integrity check failed.');
      let linkedGuardrail = null;
      let guardrailRef = null;
      if (configurationType === 'POLICY' && version.guardrailVersionId) {
        guardrailRef = db.collection(GUARDRAIL_VERSIONS).doc(version.guardrailVersionId);
        const guardrailSnapshot = await transaction.get(guardrailRef);
        linkedGuardrail = dataFromSnapshot(guardrailSnapshot);
      }
      transaction.update(versionRef, {
        status: 'PENDING_APPROVAL',
        immutable: true,
        submittedBy: actor.uid,
        submittedByName: actor.name,
        submittedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      if (guardrailRef && linkedGuardrail?.linkedPolicyVersionId === versionId && linkedGuardrail.status === 'DRAFT') {
          transaction.update(guardrailRef, {
            status: 'PENDING_APPROVAL',
            immutable: true,
            submittedBy: actor.uid,
            submittedByName: actor.name,
            submittedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
      }
      const response = { ok: true, configurationType, versionId, definitionHash: version.definitionHash, status: 'PENDING_APPROVAL' };
      transaction.create(auditRef, auditPayload({
        admin, action, actor, requestId, requestHash, configurationType,
        entityId: versionId, definitionHash: version.definitionHash,
        storeIds: version.storeIds || [], reason: request.data?.reason || version.definition?.reason,
        result: response,
      }));
      return response;
    });
  }

  async function approveConfiguration(request) {
    const actor = await loadManagerProfile(db, request);
    if (actor.role !== 'ADMIN') fail('permission-denied', 'Only HQ Admin may approve BOND configurations.');
    const requestId = requestIdFrom(request.data);
    const configurationType = normalizeConfigurationType(request.data?.configurationType);
    const versionId = cleanId(request.data?.versionId, 'Version identifier');
    const versionRef = versionCollection(db, configurationType).doc(versionId);
    const action = `APPROVE_${configurationType}`;
    const requestHash = definitionHash({ action, versionId });
    const auditRef = db.collection(MANAGEMENT_AUDIT).doc(auditId(action, actor.uid, requestId));
    return db.runTransaction(async transaction => {
      const [auditSnapshot, versionSnapshot] = await Promise.all([
        transaction.get(auditRef),
        transaction.get(versionRef),
      ]);
      const prior = existingAuditResponse(auditSnapshot, requestHash, action);
      if (prior) return prior;
      const version = dataFromSnapshot(versionSnapshot);
      if (!version) fail('not-found', 'Submitted BOND configuration not found.');
      if (version.status !== 'PENDING_APPROVAL') fail('failed-precondition', 'Only a submitted definition may be approved.');
      if (definitionHash(version.definition) !== version.definitionHash) fail('data-loss', 'Submitted definition integrity check failed.');

      let guardrail = null;
      let linkedGuardrailRef = null;
      let approveLinkedGuardrail = false;
      if (configurationType === 'GUARDRAIL') {
        guardrail = version;
      } else if (configurationType === 'POLICY' && version.guardrailVersionId) {
        linkedGuardrailRef = db.collection(GUARDRAIL_VERSIONS).doc(version.guardrailVersionId);
        const linkedSnapshot = await transaction.get(linkedGuardrailRef);
        const linked = dataFromSnapshot(linkedSnapshot);
        if (linked?.linkedPolicyVersionId === versionId && linked.status === 'PENDING_APPROVAL') {
          if (definitionHash(linked.definition) !== linked.definitionHash) fail('data-loss', 'Guardrail definition integrity check failed.');
          approveLinkedGuardrail = true;
          guardrail = { ...linked, status: 'APPROVED' };
        } else if (linked && ['APPROVED', 'SCHEDULED'].includes(linked.status)) {
          guardrail = linked;
        } else {
          fail('failed-precondition', 'An approved HQ guardrail version is required.');
        }
      } else if (configurationType !== 'GUARDRAIL') {
        guardrail = await approvedGuardrailInTransaction(transaction, db, version.guardrailVersionId);
      }
      if (configurationType === 'POLICY') validatePolicyAgainstGuardrails(version.definition, guardrail.definition.guardrails);
      if (configurationType === 'CAMPAIGN') validateCampaignAgainstGuardrails(version.definition, guardrail.definition.guardrails);
      const guardrailVersionId = configurationType === 'GUARDRAIL' ? versionId : guardrail.id;
      const linkedGuardrailDefinitionHash = configurationType === 'POLICY'
        ? (guardrail.definitionHash || definitionHash(guardrail.definition))
        : null;
      const budgetRef = configurationType === 'CAMPAIGN'
        ? db.collection(CAMPAIGN_BUDGETS).doc(versionId)
        : null;
      const budgetSnapshot = budgetRef ? await transaction.get(budgetRef) : null;
      if (budgetSnapshot?.exists && budgetSnapshot.data()?.budgetPoints !== version.definition.budgetPoints) {
        fail('data-loss', 'The campaign budget projection does not match its immutable definition.');
      }
      if (approveLinkedGuardrail) {
        transaction.update(linkedGuardrailRef, {
          status: 'APPROVED',
          immutable: true,
          approvalStatus: 'APPROVED',
          approvedBy: actor.uid,
          approvedByName: actor.name,
          approvedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        const linkedApprovalId = `GUARDRAIL__${guardrailVersionId}`;
        transaction.create(db.collection(REWARD_APPROVALS).doc(linkedApprovalId), {
          approvalId: linkedApprovalId,
          configurationType: 'GUARDRAIL',
          versionId: guardrailVersionId,
          definitionHash: linkedGuardrailDefinitionHash,
          linkedPolicyVersionId: versionId,
          storeIds: [],
          approvedBy: actor.uid,
          approvedByName: actor.name,
          approvedAt: admin.firestore.FieldValue.serverTimestamp(),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      transaction.update(versionRef, {
        status: 'APPROVED',
        immutable: true,
        approvalStatus: 'APPROVED',
        guardrailVersionId,
        guardrailSnapshot: guardrail.definition.guardrails,
        approvedBy: actor.uid,
        approvedByName: actor.name,
        approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      if (configurationType === 'CAMPAIGN') {
        if (!budgetSnapshot.exists) {
          transaction.create(budgetRef, {
            versionId,
            campaignId: version.campaignId || version.definition.campaignId,
            storeIds: version.storeIds,
            budgetPoints: version.definition.budgetPoints,
            awardedPoints: 0,
            reversedPoints: 0,
            netConsumedPoints: 0,
            awardCount: 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }
      const approvalId = `${configurationType}__${versionId}`;
      transaction.create(db.collection(REWARD_APPROVALS).doc(approvalId), {
        approvalId,
        configurationType,
        versionId,
        definitionHash: version.definitionHash,
        guardrailVersionId,
        linkedGuardrailDefinitionHash,
        storeIds: version.storeIds || [],
        approvedBy: actor.uid,
        approvedByName: actor.name,
        approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      const response = {
        ok: true,
        configurationType,
        versionId,
        definitionHash: version.definitionHash,
        guardrailVersionId,
        linkedGuardrailDefinitionHash,
        status: 'APPROVED',
      };
      transaction.create(auditRef, auditPayload({
        admin, action, actor, requestId, requestHash, configurationType,
        entityId: versionId, definitionHash: version.definitionHash,
        linkedDefinitionHashes: linkedGuardrailDefinitionHash
          ? { guardrail: linkedGuardrailDefinitionHash }
          : null,
        storeIds: version.storeIds || [], reason: request.data?.reason || version.definition?.reason,
        result: response,
      }));
      return response;
    });
  }

  async function segmentSnapshotsInTransaction(transaction, scopeRef) {
    const snapshots = await transaction.get(scopeRef.collection('segments'));
    return snapshots.docs.map(dataFromSnapshot);
  }

  function overlaps(leftStart, leftEnd, rightStart, rightEnd) {
    const leftUpper = leftEnd === null ? Number.POSITIVE_INFINITY : leftEnd;
    const rightUpper = rightEnd === null ? Number.POSITIVE_INFINITY : rightEnd;
    return leftStart < rightUpper && rightStart < leftUpper;
  }

  function scheduleAffectsEveryStore(schedule) {
    return schedule?.configurationType === 'POLICY'
      && Array.isArray(schedule.scopeKeys)
      && schedule.scopeKeys.includes('GLOBAL');
  }

  function scheduleStores(schedule) {
    return new Set(Array.isArray(schedule?.storeIds) ? schedule.storeIds : []);
  }

  function schedulesShareRewardScope(left, right) {
    if (scheduleAffectsEveryStore(left) || scheduleAffectsEveryStore(right)) return true;
    const rightStores = scheduleStores(right);
    return [...scheduleStores(left)].some(storeId => rightStores.has(storeId));
  }

  function assertGuardrailCompatibleSchedule({
    schedules,
    candidate,
    excludedScheduleIds = new Set(),
  }) {
    const conflict = schedules.find(schedule => (
      !excludedScheduleIds.has(schedule.scheduleId || schedule.id)
      && schedulesShareRewardScope(candidate, schedule)
      && overlaps(
        timestampMillis(candidate.startsAt),
        timestampMillis(candidate.endsAt),
        timestampMillis(schedule.startsAt),
        timestampMillis(schedule.endsAt),
      )
      && cleanText(schedule.guardrailVersionId, 180) !== cleanText(candidate.guardrailVersionId, 180)
    ));
    if (conflict) {
      fail(
        'failed-precondition',
        'The schedule overlaps a policy or campaign approved under different HQ guardrails. Close or reschedule the conflicting window first.',
      );
    }
  }

  function policyIntervalsForStore(schedules, storeId, guardrailVersionId) {
    return schedules
      .filter(schedule => schedule.configurationType === 'POLICY')
      .filter(schedule => scheduleAffectsEveryStore(schedule) || scheduleStores(schedule).has(storeId))
      .filter(schedule => cleanText(schedule.guardrailVersionId, 180) === cleanText(guardrailVersionId, 180))
      .map(schedule => ({
        start: timestampMillis(schedule.startsAt),
        end: timestampMillis(schedule.endsAt),
      }))
      .sort((left, right) => left.start - right.start);
  }

  function intervalIsCovered(intervals, startsAt, endsAt) {
    let cursor = startsAt;
    for (const interval of intervals) {
      const upper = interval.end === null ? Number.POSITIVE_INFINITY : interval.end;
      if (upper <= cursor || interval.start >= endsAt) continue;
      if (interval.start > cursor) return false;
      cursor = Math.max(cursor, upper);
      if (cursor >= endsAt) return true;
    }
    return cursor >= endsAt;
  }

  function assertCampaignPolicyCoverage(schedules, campaign) {
    const startsAt = timestampMillis(campaign.startsAt);
    const endsAt = timestampMillis(campaign.endsAt);
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) {
      fail('failed-precondition', 'A campaign requires a finite valid activation window.');
    }
    for (const storeId of campaign.storeIds || []) {
      const intervals = policyIntervalsForStore(schedules, storeId, campaign.guardrailVersionId);
      if (!intervalIsCovered(intervals, startsAt, endsAt)) {
        fail('failed-precondition', `Campaign activation at ${storeId} is not fully covered by an effective policy using the same HQ guardrails.`);
      }
    }
  }

  function assertAllCampaignsHavePolicyCoverage(schedules) {
    schedules
      .filter(schedule => schedule.configurationType === 'CAMPAIGN')
      .filter(schedule => !['PAUSED', 'ROLLED_BACK'].includes(schedule.status))
      .forEach(campaign => assertCampaignPolicyCoverage(schedules, campaign));
  }

  async function scheduleConfiguration(request) {
    const actor = await loadManagerProfile(db, request);
    if (actor.role !== 'ADMIN') fail('permission-denied', 'Only HQ Admin may schedule BOND configurations.');
    const requestId = requestIdFrom(request.data);
    const configurationType = normalizeConfigurationType(request.data?.configurationType);
    if (configurationType === 'GUARDRAIL') fail('invalid-argument', 'Guardrails are approved constraints, not runtime schedules.');
    const versionId = cleanId(request.data?.versionId, 'Version identifier');
    const versionRef = versionCollection(db, configurationType).doc(versionId);
    const action = `SCHEDULE_${configurationType}`;
    const scheduleId = cleanText(request.data?.scheduleId, 180)
      ? cleanId(request.data.scheduleId, 'Schedule identifier')
      : deterministicId('BOND_SCHEDULE', configurationType, actor.uid, requestId);
    const requestedStart = inputMillis(request.data?.startsAt, 'Schedule start');
    const requestedEnd = inputMillis(request.data?.endsAt, 'Schedule end');
    const requestHash = definitionHash({ action, versionId, scheduleId, requestedStart, requestedEnd });
    const auditRef = db.collection(MANAGEMENT_AUDIT).doc(auditId(action, actor.uid, requestId));
    return db.runTransaction(async transaction => {
      const [auditSnapshot, versionSnapshot] = await Promise.all([
        transaction.get(auditRef),
        transaction.get(versionRef),
      ]);
      const prior = existingAuditResponse(auditSnapshot, requestHash, action);
      if (prior) return prior;
      const version = dataFromSnapshot(versionSnapshot);
      if (!version) fail('not-found', 'Approved BOND configuration not found.');
      if (!['APPROVED', 'SCHEDULED'].includes(version.status)) fail('failed-precondition', 'Only an approved definition may be scheduled.');
      if (definitionHash(version.definition) !== version.definitionHash) fail('data-loss', 'Approved definition integrity check failed.');
      const startsAtMillis = requestedStart ?? inputMillis(version.definition.startsAt, 'Schedule start', { required: true });
      const endsAtMillis = requestedEnd ?? inputMillis(version.definition.endsAt, 'Schedule end');
      if (endsAtMillis !== null && endsAtMillis <= startsAtMillis) fail('invalid-argument', 'Schedule end must be after its start.');
      if (startsAtMillis < now()) fail('failed-precondition', 'BOND activation cannot be backdated. Choose a current or future start time.');
      const guardrail = await approvedGuardrailInTransaction(transaction, db, version.guardrailVersionId);
      if (configurationType === 'POLICY') validatePolicyAgainstGuardrails(version.definition, guardrail.definition.guardrails);
      const approvedStart = inputMillis(version.definition.startsAt, 'Approved schedule start', { required: true });
      const approvedEnd = inputMillis(version.definition.endsAt, 'Approved schedule end');
      if (startsAtMillis < approvedStart || (approvedEnd !== null && (endsAtMillis === null || endsAtMillis > approvedEnd))) {
        fail('failed-precondition', 'The activation window must remain inside the immutable approved window.');
      }
      if (configurationType === 'CAMPAIGN') {
        validateCampaignAgainstGuardrails({
          ...version.definition,
          startsAt: new Date(startsAtMillis).toISOString(),
          endsAt: endsAtMillis === null ? null : new Date(endsAtMillis).toISOString(),
        }, guardrail.definition.guardrails);
      }
      const scopeKeys = configurationType === 'POLICY'
        ? version.definition.scope === 'GLOBAL' ? ['GLOBAL'] : version.storeIds.map(storeId => `STORE_${storeId}`)
        : version.storeIds;
      const stores = configurationType === 'POLICY' && version.definition.scope === 'GLOBAL' ? [] : version.storeIds;
      await activeStoresInTransaction(transaction, db, stores);
      const rewardScheduleSnapshots = await transaction.get(db.collection(REWARD_SCHEDULES));
      const existingSchedules = rewardScheduleSnapshots.docs.map(dataFromSnapshot);
      const candidateSchedule = {
        scheduleId,
        configurationType,
        scopeKeys,
        storeIds: stores,
        guardrailVersionId: guardrail.id,
        startsAt: startsAtMillis,
        endsAt: endsAtMillis,
      };
      assertGuardrailCompatibleSchedule({
        schedules: existingSchedules,
        candidate: candidateSchedule,
      });
      assertAllCampaignsHavePolicyCoverage([...existingSchedules, candidateSchedule]);
      const scopeData = [];
      for (const scopeKey of scopeKeys) {
        const scopeRef = configurationType === 'POLICY'
          ? db.collection(POLICY_SCOPES).doc(scopeKey)
          : db.collection(CAMPAIGN_SCOPES).doc(scopeKey);
        const segments = await segmentSnapshotsInTransaction(transaction, scopeRef);
        if (segments.some(segment => overlaps(
          startsAtMillis,
          endsAtMillis,
          timestampMillis(segment.startsAt),
          timestampMillis(segment.endsAt),
        ))) {
          fail('failed-precondition', `The schedule overlaps another ${configurationType.toLowerCase()} at ${scopeKey}.`);
        }
        scopeData.push({ scopeKey, scopeRef });
      }
      for (const { scopeKey, scopeRef } of scopeData) {
        const storeId = configurationType === 'CAMPAIGN'
          ? scopeKey
          : scopeKey === 'GLOBAL' ? null : scopeKey.slice('STORE_'.length);
        transaction.create(scopeRef.collection('segments').doc(scheduleId), {
          scheduleId,
          scopeKey,
          storeId,
          configurationType,
          versionId,
          ...(configurationType === 'CAMPAIGN' ? { campaignId: version.campaignId || version.definition.campaignId } : {}),
          guardrailVersionId: guardrail.id,
          definitionHash: version.definitionHash,
          startsAt: firestoreTimestamp(admin, startsAtMillis),
          endsAt: endsAtMillis === null ? null : firestoreTimestamp(admin, endsAtMillis),
          status: 'SCHEDULED',
          scheduledBy: actor.uid,
          scheduledByName: actor.name,
          scheduledAt: admin.firestore.FieldValue.serverTimestamp(),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      transaction.create(db.collection(REWARD_SCHEDULES).doc(scheduleId), {
        scheduleId,
        configurationType,
        versionId,
        storeIds: stores,
        scopeKeys,
        guardrailVersionId: guardrail.id,
        definitionHash: version.definitionHash,
        startsAt: firestoreTimestamp(admin, startsAtMillis),
        endsAt: endsAtMillis === null ? null : firestoreTimestamp(admin, endsAtMillis),
        status: 'SCHEDULED',
        scheduledBy: actor.uid,
        scheduledByName: actor.name,
        scheduledAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      transaction.update(versionRef, {
        status: 'SCHEDULED',
        lastScheduleId: scheduleId,
        scheduledAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      const response = {
        ok: true,
        configurationType,
        versionId,
        scheduleId,
        storeIds: stores,
        startsAt: new Date(startsAtMillis).toISOString(),
        endsAt: endsAtMillis === null ? null : new Date(endsAtMillis).toISOString(),
        status: 'SCHEDULED',
      };
      transaction.create(auditRef, auditPayload({
        admin, action, actor, requestId, requestHash, configurationType,
        entityId: scheduleId, definitionHash: version.definitionHash,
        storeIds: stores, reason: request.data?.reason || version.definition?.reason,
        result: response,
        effectiveAt: firestoreTimestamp(admin, startsAtMillis),
      }));
      return response;
    });
  }

  async function pauseConfiguration(request) {
    const actor = await loadManagerProfile(db, request);
    const requestId = requestIdFrom(request.data);
    const configurationType = normalizeConfigurationType(request.data?.configurationType);
    if (configurationType === 'GUARDRAIL') fail('invalid-argument', 'A guardrail cannot be paused.');
    const versionId = cleanId(request.data?.versionId, 'Version identifier');
    const suppliedScheduleId = cleanText(request.data?.scheduleId, 180)
      ? cleanId(request.data.scheduleId, 'Schedule identifier')
      : null;
    const versionRef = versionCollection(db, configurationType).doc(versionId);
    const action = `PAUSE_${configurationType}`;
    const requestHash = definitionHash({ action, versionId, scheduleId: suppliedScheduleId });
    const auditRef = db.collection(MANAGEMENT_AUDIT).doc(auditId(action, actor.uid, requestId));
    const pauseMillis = now();
    return db.runTransaction(async transaction => {
      const [auditSnapshot, versionSnapshot] = await Promise.all([
        transaction.get(auditRef),
        transaction.get(versionRef),
      ]);
      const prior = existingAuditResponse(auditSnapshot, requestHash, action);
      if (prior) return prior;
      const version = dataFromSnapshot(versionSnapshot);
      if (!version) fail('not-found', 'Scheduled BOND configuration not found.');
      if (actor.role !== 'ADMIN') {
        if (configurationType === 'POLICY' && version.definition?.scope === 'GLOBAL') {
          fail('permission-denied', 'Only HQ Admin may pause the global policy.');
        }
        assertStoreScope(actor, version.storeIds || []);
      }
      const scopeKeys = configurationType === 'POLICY'
        ? version.definition.scope === 'GLOBAL' ? ['GLOBAL'] : version.storeIds.map(storeId => `STORE_${storeId}`)
        : version.storeIds;
      const scopeData = [];
      for (const scopeKey of scopeKeys) {
        const scopeRef = configurationType === 'POLICY'
          ? db.collection(POLICY_SCOPES).doc(scopeKey)
          : db.collection(CAMPAIGN_SCOPES).doc(scopeKey);
        const segments = await segmentSnapshotsInTransaction(transaction, scopeRef);
        const scheduleId = suppliedScheduleId || version.lastScheduleId;
        const segment = scheduleId
          ? segments.find(candidate => candidate.scheduleId === scheduleId && candidate.versionId === versionId)
          : segments
            .filter(candidate => candidate.versionId === versionId)
            .sort((left, right) => timestampMillis(right.startsAt) - timestampMillis(left.startsAt))[0];
        if (!segment) fail('not-found', `No schedule for ${versionId} is configured at ${scopeKey}.`);
        scopeData.push({ scopeKey, scopeRef, segment, segmentRef: scopeRef.collection('segments').doc(segment.scheduleId) });
      }
      const resolvedScheduleIds = [...new Set(scopeData.map(entry => entry.segment.scheduleId))];
      if (resolvedScheduleIds.length !== 1) fail('data-loss', 'The multi-store configuration does not share one schedule identifier.');
      const scheduleId = resolvedScheduleIds[0];
      const centralScheduleRef = db.collection(REWARD_SCHEDULES).doc(scheduleId);
      const centralScheduleSnapshot = await transaction.get(centralScheduleRef);
      if (!centralScheduleSnapshot.exists) fail('data-loss', 'The central BOND schedule record is missing.');
      const centralSchedule = dataFromSnapshot(centralScheduleSnapshot);
      const firstSegment = scopeData[0].segment;
      const expectedStart = timestampMillis(firstSegment.startsAt);
      const expectedEnd = timestampMillis(firstSegment.endsAt);
      const inconsistentScopeRow = scopeData.some(({ segment }) => (
        segment.status !== 'SCHEDULED'
        || timestampMillis(segment.startsAt) !== expectedStart
        || timestampMillis(segment.endsAt) !== expectedEnd
        || segment.configurationType !== configurationType
        || segment.versionId !== versionId
      ));
      if (
        inconsistentScopeRow
        || centralSchedule.status !== 'SCHEDULED'
        || centralSchedule.configurationType !== configurationType
        || centralSchedule.versionId !== versionId
        || timestampMillis(centralSchedule.startsAt) !== expectedStart
        || timestampMillis(centralSchedule.endsAt) !== expectedEnd
      ) {
        fail('data-loss', 'The central and per-store BOND schedule records are inconsistent.');
      }
      if (expectedEnd !== null && expectedEnd <= pauseMillis) {
        fail('failed-precondition', 'An ended or already-paused BOND schedule cannot be paused again.');
      }
      const rewardScheduleSnapshots = await transaction.get(db.collection(REWARD_SCHEDULES));
      const effectiveEnds = scopeData.map(({ segment }) => {
        const startsAtMillis = timestampMillis(segment.startsAt);
        return pauseMillis <= startsAtMillis ? startsAtMillis : pauseMillis;
      });
      const centralEffectiveEnd = Math.min(...effectiveEnds);
      const schedulesAfterPause = rewardScheduleSnapshots.docs.map(dataFromSnapshot).map(schedule => (
        (schedule.scheduleId || schedule.id) === scheduleId
          ? { ...schedule, endsAt: centralEffectiveEnd, status: 'PAUSED' }
          : schedule
      ));
      assertAllCampaignsHavePolicyCoverage(schedulesAfterPause);
      for (const { segment, segmentRef } of scopeData) {
        const startsAtMillis = timestampMillis(segment.startsAt);
        const effectiveEnd = pauseMillis <= startsAtMillis ? startsAtMillis : pauseMillis;
        transaction.update(segmentRef, {
          endsAt: firestoreTimestamp(admin, effectiveEnd),
          status: 'PAUSED',
          pausedBy: actor.uid,
          pausedByName: actor.name,
          pausedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      transaction.update(centralScheduleRef, {
        status: 'PAUSED',
        pausedBy: actor.uid,
        pausedByName: actor.name,
        pausedAt: admin.firestore.FieldValue.serverTimestamp(),
        endsAt: firestoreTimestamp(admin, centralEffectiveEnd),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      const response = {
        ok: true,
        configurationType,
        versionId,
        scheduleId,
        storeIds: version.storeIds || [],
        effectiveAt: new Date(pauseMillis).toISOString(),
        status: 'PAUSED',
      };
      transaction.create(auditRef, auditPayload({
        admin, action, actor, requestId, requestHash, configurationType,
        entityId: scheduleId, definitionHash: version.definitionHash,
        storeIds: version.storeIds || [], reason: request.data?.reason,
        result: response,
        effectiveAt: firestoreTimestamp(admin, pauseMillis),
      }));
      return response;
    });
  }

  async function rollbackConfiguration(request) {
    const actor = await loadManagerProfile(db, request);
    if (actor.role !== 'ADMIN') fail('permission-denied', 'Only HQ Admin may roll back BOND configurations.');
    const requestId = requestIdFrom(request.data);
    const configurationType = normalizeConfigurationType(request.data?.configurationType);
    if (configurationType === 'GUARDRAIL') fail('invalid-argument', 'Guardrails use new approved versions instead of runtime rollback.');
    const targetVersionId = cleanId(request.data?.versionId, 'Rollback version identifier');
    const suppliedCurrentScheduleId = cleanText(request.data?.scheduleId, 180)
      ? cleanId(request.data.scheduleId, 'Current schedule identifier')
      : null;
    const targetRef = versionCollection(db, configurationType).doc(targetVersionId);
    const action = `ROLLBACK_${configurationType}`;
    const newScheduleId = deterministicId('BOND_ROLLBACK', configurationType, actor.uid, requestId);
    const effectiveMillis = now();
    const requestedEndInput = inputMillis(request.data?.endsAt, 'Rollback end');
    if (requestedEndInput !== null && requestedEndInput <= effectiveMillis) {
      fail('invalid-argument', 'Rollback end must be after its activation time.');
    }
    const requestedEnd = requestedEndInput;
    const requestHash = definitionHash({ action, targetVersionId, currentScheduleId: suppliedCurrentScheduleId, requestedEndInput });
    const auditRef = db.collection(MANAGEMENT_AUDIT).doc(auditId(action, actor.uid, requestId));
    return db.runTransaction(async transaction => {
      const [auditSnapshot, targetSnapshot] = await Promise.all([
        transaction.get(auditRef),
        transaction.get(targetRef),
      ]);
      const prior = existingAuditResponse(auditSnapshot, requestHash, action);
      if (prior) return prior;
      const target = dataFromSnapshot(targetSnapshot);
      if (!target || !['APPROVED', 'SCHEDULED'].includes(target.status)) {
        fail('failed-precondition', 'Rollback target must be an approved version.');
      }
      if (definitionHash(target.definition) !== target.definitionHash || target.immutable !== true) {
        fail('data-loss', 'Rollback target failed its immutable definition check.');
      }
      const guardrail = await approvedGuardrailInTransaction(transaction, db, target.guardrailVersionId);
      if (configurationType === 'POLICY') validatePolicyAgainstGuardrails(target.definition, guardrail.definition.guardrails);
      if (configurationType === 'CAMPAIGN') validateCampaignAgainstGuardrails(target.definition, guardrail.definition.guardrails);
      const scopeKeys = configurationType === 'POLICY'
        ? target.definition.scope === 'GLOBAL' ? ['GLOBAL'] : target.storeIds.map(storeId => `STORE_${storeId}`)
        : target.storeIds;
      const stores = configurationType === 'POLICY' && target.definition.scope === 'GLOBAL' ? [] : target.storeIds;
      await activeStoresInTransaction(transaction, db, stores);
      const approvedStart = inputMillis(
        target.definition.startsAt,
        `Approved ${configurationType.toLowerCase()} start`,
        { required: true },
      );
      const approvedEnd = inputMillis(
        target.definition.endsAt,
        `Approved ${configurationType.toLowerCase()} end`,
        { required: configurationType === 'CAMPAIGN' },
      );
      if (effectiveMillis < approvedStart || (approvedEnd !== null && effectiveMillis >= approvedEnd)) {
        fail('failed-precondition', `A ${configurationType.toLowerCase()} rollback must start inside its immutable approved window.`);
      }
      let effectiveEnd = requestedEnd === null && approvedEnd !== null ? approvedEnd : requestedEnd;
      if (approvedEnd !== null && (effectiveEnd === null || effectiveEnd > approvedEnd)) {
        fail('failed-precondition', `A ${configurationType.toLowerCase()} rollback cannot extend beyond its immutable approved window.`);
      }
      if (configurationType === 'CAMPAIGN') {
        validateCampaignAgainstGuardrails({
          ...target.definition,
          startsAt: new Date(effectiveMillis).toISOString(),
          endsAt: new Date(effectiveEnd).toISOString(),
        }, guardrail.definition.guardrails);
      }
      const scopeData = [];
      for (const scopeKey of scopeKeys) {
        const scopeRef = configurationType === 'POLICY'
          ? db.collection(POLICY_SCOPES).doc(scopeKey)
          : db.collection(CAMPAIGN_SCOPES).doc(scopeKey);
        const segments = await segmentSnapshotsInTransaction(transaction, scopeRef);
        const current = suppliedCurrentScheduleId
          ? segments.find(segment => segment.scheduleId === suppliedCurrentScheduleId)
          : segments
            .filter(segment => {
              const start = timestampMillis(segment.startsAt);
              const end = timestampMillis(segment.endsAt);
              return start <= effectiveMillis && (end === null || effectiveMillis < end);
            })
            .sort((left, right) => timestampMillis(right.startsAt) - timestampMillis(left.startsAt))[0];
        if (!current) fail('not-found', `No active schedule was found at ${scopeKey}.`);
        const futureStarts = segments
          .filter(segment => segment.scheduleId !== current.scheduleId && timestampMillis(segment.startsAt) > effectiveMillis)
          .map(segment => timestampMillis(segment.startsAt))
          .sort((left, right) => left - right);
        if (requestedEnd === null && futureStarts.length > 0) {
          effectiveEnd = effectiveEnd === null ? futureStarts[0] : Math.min(effectiveEnd, futureStarts[0]);
        }
        scopeData.push({ scopeKey, scopeRef, segments, current });
      }
      const currentScheduleIds = [...new Set(scopeData.map(entry => entry.current.scheduleId))];
      if (currentScheduleIds.length !== 1) fail('data-loss', 'The active multi-store configuration does not share one schedule identifier.');
      const currentScheduleId = currentScheduleIds[0];
      const currentCentralRef = db.collection(REWARD_SCHEDULES).doc(currentScheduleId);
      const currentCentralSnapshot = await transaction.get(currentCentralRef);
      if (!currentCentralSnapshot.exists) fail('data-loss', 'The current central BOND schedule record is missing.');
      const firstCurrent = scopeData[0].current;
      const currentStart = timestampMillis(firstCurrent.startsAt);
      const currentEnd = timestampMillis(firstCurrent.endsAt);
      const currentVersionId = firstCurrent.versionId;
      if (
        firstCurrent.status !== 'SCHEDULED'
        || currentStart > effectiveMillis
        || (currentEnd !== null && effectiveMillis >= currentEnd)
        || scopeData.some(({ current }) => (
          current.status !== 'SCHEDULED'
          || current.configurationType !== configurationType
          || current.versionId !== currentVersionId
          || timestampMillis(current.startsAt) !== currentStart
          || timestampMillis(current.endsAt) !== currentEnd
        ))
      ) {
        fail('failed-precondition', 'Rollback requires one currently active and internally consistent schedule.');
      }
      const currentCentral = dataFromSnapshot(currentCentralSnapshot);
      if (
        currentCentral.status !== 'SCHEDULED'
        || currentCentral.configurationType !== configurationType
        || currentCentral.versionId !== currentVersionId
        || timestampMillis(currentCentral.startsAt) !== currentStart
        || timestampMillis(currentCentral.endsAt) !== currentEnd
      ) {
        fail('data-loss', 'The central and per-store rollback source schedules are inconsistent.');
      }
      const rewardScheduleSnapshots = await transaction.get(db.collection(REWARD_SCHEDULES));
      if (effectiveEnd !== null && effectiveEnd <= effectiveMillis) fail('invalid-argument', 'Rollback end must be after its start.');
      const existingSchedules = rewardScheduleSnapshots.docs.map(dataFromSnapshot);
      const candidateSchedule = {
        scheduleId: newScheduleId,
        configurationType,
        scopeKeys,
        storeIds: stores,
        guardrailVersionId: guardrail.id,
        startsAt: effectiveMillis,
        endsAt: effectiveEnd,
      };
      assertGuardrailCompatibleSchedule({
        schedules: existingSchedules,
        excludedScheduleIds: new Set([currentScheduleId]),
        candidate: candidateSchedule,
      });
      assertAllCampaignsHavePolicyCoverage([
        ...existingSchedules.map(schedule => (
          (schedule.scheduleId || schedule.id) === currentScheduleId
            ? { ...schedule, endsAt: effectiveMillis, status: 'ROLLED_BACK' }
            : schedule
        )),
        candidateSchedule,
      ]);
      for (const { scopeKey, scopeRef, segments, current } of scopeData) {
        if (segments.some(segment => segment.scheduleId !== currentScheduleId && overlaps(
          effectiveMillis,
          effectiveEnd,
          timestampMillis(segment.startsAt),
          timestampMillis(segment.endsAt),
        ))) {
          fail('failed-precondition', `The rollback would overlap another schedule at ${scopeKey}.`);
        }
        const currentRef = scopeRef.collection('segments').doc(currentScheduleId);
        const currentEnd = timestampMillis(current.endsAt);
        if (currentEnd === null || currentEnd > effectiveMillis) {
          transaction.update(currentRef, {
            endsAt: firestoreTimestamp(admin, Math.max(effectiveMillis, timestampMillis(current.startsAt))),
            status: 'ROLLED_BACK',
            rolledBackBy: actor.uid,
            rolledBackAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
        const storeId = configurationType === 'CAMPAIGN'
          ? scopeKey
          : scopeKey === 'GLOBAL' ? null : scopeKey.slice('STORE_'.length);
        transaction.create(scopeRef.collection('segments').doc(newScheduleId), {
          scheduleId: newScheduleId,
          scopeKey,
          storeId,
          configurationType,
          versionId: targetVersionId,
          ...(configurationType === 'CAMPAIGN' ? { campaignId: target.campaignId || target.definition.campaignId } : {}),
          guardrailVersionId: guardrail.id,
          definitionHash: target.definitionHash,
          startsAt: firestoreTimestamp(admin, effectiveMillis),
          endsAt: effectiveEnd === null ? null : firestoreTimestamp(admin, effectiveEnd),
          status: 'SCHEDULED',
          rollbackOfScheduleId: currentScheduleId,
          scheduledBy: actor.uid,
          scheduledByName: actor.name,
          scheduledAt: admin.firestore.FieldValue.serverTimestamp(),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      if (currentCentralSnapshot.exists) {
        transaction.update(currentCentralRef, {
          status: 'ROLLED_BACK',
          rolledBackBy: actor.uid,
          rolledBackAt: admin.firestore.FieldValue.serverTimestamp(),
          endsAt: firestoreTimestamp(admin, effectiveMillis),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      transaction.create(db.collection(REWARD_SCHEDULES).doc(newScheduleId), {
        scheduleId: newScheduleId,
        configurationType,
        versionId: targetVersionId,
        storeIds: target.storeIds || [],
        scopeKeys,
        guardrailVersionId: guardrail.id,
        definitionHash: target.definitionHash,
        startsAt: firestoreTimestamp(admin, effectiveMillis),
        endsAt: effectiveEnd === null ? null : firestoreTimestamp(admin, effectiveEnd),
        status: 'SCHEDULED',
        rollbackOfScheduleId: currentScheduleId,
        scheduledBy: actor.uid,
        scheduledByName: actor.name,
        scheduledAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      transaction.update(targetRef, {
        status: 'SCHEDULED',
        lastScheduleId: newScheduleId,
        scheduledAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      const response = {
        ok: true,
        configurationType,
        versionId: targetVersionId,
        scheduleId: newScheduleId,
        rollbackOfScheduleId: currentScheduleId,
        storeIds: target.storeIds || [],
        startsAt: new Date(effectiveMillis).toISOString(),
        endsAt: effectiveEnd === null ? null : new Date(effectiveEnd).toISOString(),
        status: 'SCHEDULED',
      };
      transaction.create(auditRef, auditPayload({
        admin, action, actor, requestId, requestHash, configurationType,
        entityId: newScheduleId, definitionHash: target.definitionHash,
        storeIds: target.storeIds || [], reason: request.data?.reason,
        result: response,
        effectiveAt: firestoreTimestamp(admin, effectiveMillis),
      }));
      return response;
    });
  }

  async function managerState(request) {
    const actor = await loadManagerProfile(db, request);
    const storesPromise = actor.role === 'ADMIN'
      ? db.collection('stores').where('isActive', '==', true).get()
      : actor.assignedStoreIds.length === 0
        ? Promise.resolve({ docs: [] })
        : db.getAll(...actor.assignedStoreIds.map(storeId => db.collection('stores').doc(storeId)));
    const [guardrailSnapshots, policySnapshots, campaignSnapshots, budgetSnapshots, qualificationSnapshots, auditSnapshots, segmentSnapshots, storeSnapshots] = await Promise.all([
      db.collection(GUARDRAIL_VERSIONS).limit(200).get(),
      db.collection(POLICY_VERSIONS).limit(500).get(),
      db.collection(CAMPAIGN_VERSIONS).limit(500).get(),
      db.collection(CAMPAIGN_BUDGETS).limit(500).get(),
      db.collection(CAMPAIGN_QUALIFICATION_EVENTS).limit(2_000).get(),
      db.collection(MANAGEMENT_AUDIT).orderBy('createdAt', 'desc').limit(250).get(),
      db.collectionGroup('segments').limit(1000).get(),
      storesPromise,
    ]);
    const allowed = new Set(actor.assignedStoreIds);
    const canSeeStores = storeIds => actor.role === 'ADMIN'
      || ((storeIds || []).length > 0 && (storeIds || []).every(storeId => allowed.has(storeId)));
    const guardrails = guardrailSnapshots.docs.map(dataFromSnapshot)
      .filter(document => actor.role === 'ADMIN' || ['APPROVED', 'SCHEDULED'].includes(document.status));
    const policies = policySnapshots.docs.map(dataFromSnapshot)
      .filter(document => (
        document.definition?.scope === 'GLOBAL'
          ? actor.role === 'ADMIN' || ['APPROVED', 'SCHEDULED'].includes(document.status)
          : canSeeStores(document.storeIds)
      ));
    const campaigns = campaignSnapshots.docs.map(dataFromSnapshot).filter(document => canSeeStores(document.storeIds));
    const visibleCampaignIds = new Set(campaigns.map(document => document.id));
    const budgets = budgetSnapshots.docs.map(dataFromSnapshot).filter(document => visibleCampaignIds.has(document.versionId || document.id));
    const qualificationStatsByVersion = new Map();
    qualificationSnapshots.docs.map(dataFromSnapshot)
      .filter(event => visibleCampaignIds.has(event.campaignVersionId))
      .forEach(event => {
        const current = qualificationStatsByVersion.get(event.campaignVersionId) || {
          evaluationCount: 0,
          qualifiedCount: 0,
        };
        current.evaluationCount += 1;
        if (event.qualified === true) current.qualifiedCount += 1;
        qualificationStatsByVersion.set(event.campaignVersionId, current);
      });
    const audits = auditSnapshots.docs.map(dataFromSnapshot).filter(document => (
      actor.role === 'ADMIN'
      || ((document.storeIds || []).length > 0 && (document.storeIds || []).every(storeId => allowed.has(storeId)))
    ));
    const segments = segmentSnapshots.docs.map(snapshot => ({ id: snapshot.id, ...snapshot.data() })).filter(document => (
      actor.role === 'ADMIN'
      || document.scopeKey === 'GLOBAL'
      || (document.storeId && allowed.has(document.storeId))
    ));
    const currentMillis = now();
    const schedulesByVersion = new Map();
    segments.forEach(segment => {
      const versionKey = `${segment.configurationType}:${segment.versionId}`;
      const scheduleId = cleanText(segment.scheduleId || segment.id, 180);
      const schedules = schedulesByVersion.get(versionKey) || new Map();
      const current = schedules.get(scheduleId);
      if (current) {
        const sameLifecycle = timestampMillis(current.startsAt) === timestampMillis(segment.startsAt)
          && timestampMillis(current.endsAt) === timestampMillis(segment.endsAt)
          && cleanText(current.status, 40) === cleanText(segment.status, 40)
          && cleanText(current.guardrailVersionId, 180) === cleanText(segment.guardrailVersionId, 180)
          && cleanText(current.definitionHash, 180) === cleanText(segment.definitionHash, 180)
          && cleanText(current.campaignId, 180) === cleanText(segment.campaignId, 180);
        if (!sameLifecycle) {
          fail('data-loss', `Multi-store ${segment.configurationType.toLowerCase()} schedule rows have inconsistent lifecycle state.`);
        }
      } else {
        schedules.set(scheduleId, segment);
      }
      schedulesByVersion.set(versionKey, schedules);
    });
    const selectedSegment = (configurationType, versionId) => {
      const candidates = [...(schedulesByVersion.get(`${configurationType}:${versionId}`)?.values() || [])];
      const active = candidates.filter(segment => {
        const start = timestampMillis(segment.startsAt);
        const end = timestampMillis(segment.endsAt);
        return start <= currentMillis && (end === null || currentMillis < end);
      }).sort((left, right) => timestampMillis(right.startsAt) - timestampMillis(left.startsAt));
      if (active.length > 1) fail('data-loss', `Multiple ${configurationType.toLowerCase()} schedules are active for one version.`);
      if (active[0]) return active[0];
      const future = candidates
        .filter(segment => timestampMillis(segment.startsAt) > currentMillis)
        .sort((left, right) => timestampMillis(left.startsAt) - timestampMillis(right.startsAt));
      if (future[0]) return future[0];
      return candidates.sort((left, right) => timestampMillis(right.startsAt) - timestampMillis(left.startsAt))[0] || null;
    };
    const lifecycle = (version, configurationType) => {
      const segment = selectedSegment(configurationType, version.id);
      if (!segment) return version.status;
      if (['PAUSED', 'ROLLED_BACK'].includes(segment.status)) return segment.status;
      const start = timestampMillis(segment.startsAt);
      const end = timestampMillis(segment.endsAt);
      if (start > currentMillis) return 'SCHEDULED';
      if (end !== null && currentMillis >= end) return 'SUPERSEDED';
      return 'ACTIVE';
    };
    const policyRow = version => {
      const segment = selectedSegment('POLICY', version.id);
      return {
        versionId: version.id,
        scope: version.definition.scope,
        storeIds: version.storeIds || [],
        earnRateBps: version.definition.earnRateBps,
        campaignStackingMode: version.definition.campaignStackingMode || 'BASE_PLUS_ONE_CAMPAIGN',
        status: lifecycle(version, 'POLICY'),
        startsAt: serializableTimestamp(segment?.startsAt) || version.definition.startsAt || null,
        endsAt: serializableTimestamp(segment?.endsAt) || version.definition.endsAt || null,
        approvedStartsAt: version.definition.startsAt || null,
        approvedEndsAt: version.definition.endsAt || null,
        guardrailVersionId: version.guardrailVersionId || version.definition.guardrailVersionId || '',
        createdByName: version.createdByName || null,
        scheduleId: segment?.scheduleId || version.lastScheduleId || null,
      };
    };
    const budgetByVersion = new Map(budgets.map(budget => [budget.versionId || budget.id, budget]));
    const campaignRows = campaigns.map(version => {
      const segment = selectedSegment('CAMPAIGN', version.id);
      const definition = version.definition;
      const budget = budgetByVersion.get(version.id);
      const qualification = qualificationStatsByVersion.get(version.id) || {
        evaluationCount: 0,
        qualifiedCount: 0,
      };
      return {
        versionId: version.id,
        campaignId: version.campaignId || definition.campaignId,
        name: definition.name,
        storeIds: version.storeIds || [],
        rewardType: definition.rewardType,
        fixedBonusPoints: definition.fixedBonusPoints,
        percentageBonusBps: definition.percentageBonusBps ?? null,
        multiplierBps: definition.multiplierBps,
        minimumSpendPaise: definition.minimumSpendPaise,
        spendMilestonePaise: definition.spendMilestonePaise ?? null,
        eligibleProductCodes: definition.eligibleProductCodes || [],
        eligibleCategoryCodes: definition.eligibleCategoryCodes || [],
        minimumUniqueVisitDays: definition.minimumUniqueVisitDays,
        visitWindowDays: definition.visitWindowDays || 0,
        visitWindowMode: definition.visitWindowMode || 'ROLLING_IST_DAYS',
        customerAwardLimit: definition.customerAwardLimit,
        budgetPoints: definition.budgetPoints,
        maximumAwardPointsPerOrder: definition.maximumAwardPointsPerOrder ?? null,
        frequencyAwardLimit: definition.frequencyAwardLimit ?? null,
        frequencyWindow: definition.frequencyWindow ?? null,
        frequencyWindowDays: definition.frequencyWindowDays ?? null,
        eligibleIstWeekdays: definition.eligibleIstWeekdays || [],
        startsAtMinuteIST: definition.startsAtMinuteIST ?? null,
        endsAtMinuteIST: definition.endsAtMinuteIST ?? null,
        stackingMode: definition.stackingMode || 'BASE_PLUS_ONE_CAMPAIGN',
        status: lifecycle(version, 'CAMPAIGN'),
        startsAt: serializableTimestamp(segment?.startsAt) || definition.startsAt || null,
        endsAt: serializableTimestamp(segment?.endsAt) || definition.endsAt || null,
        approvedStartsAt: definition.startsAt || null,
        approvedEndsAt: definition.endsAt || null,
        issuedPoints: Number(budget?.netConsumedPoints) || 0,
        customerAwards: Number(budget?.awardCount) || 0,
        qualificationCount: qualification.qualifiedCount,
        evaluationCount: qualification.evaluationCount,
        qualificationRateBps: qualification.evaluationCount === 0
          ? null
          : Math.floor((qualification.qualifiedCount * 10_000) / qualification.evaluationCount),
        scheduleId: segment?.scheduleId || version.lastScheduleId || null,
      };
    });
    const policyRows = policies.map(policyRow);
    const globalPolicies = policyRows.filter(policy => policy.scope === 'GLOBAL');
    globalPolicies.sort((left, right) => (Date.parse(right.startsAt || '') || 0) - (Date.parse(left.startsAt || '') || 0));
    const globalPolicy = globalPolicies.find(policy => policy.status === 'ACTIVE') || null;
    const latestGuardrail = latestApprovedGuardrail(guardrails)
      || guardrails.sort((left, right) => (timestampMillis(right.createdAt) || 0) - (timestampMillis(left.createdAt) || 0))[0]
      || null;
    const emptyGuardrails = {
      versionId: '',
      minEarnRateBps: null,
      maxEarnRateBps: null,
      maxCombinedRewardRateBps: null,
      maxMultiplierBps: null,
      maxFixedBonusPoints: null,
      maxCampaignDays: null,
      maxCustomerAwards: null,
      maxCampaignBudgetPoints: null,
      liabilityPaisePerPoint: null,
    };
    const guardrailState = latestGuardrail ? {
      versionId: latestGuardrail.id,
      ...latestGuardrail.definition.guardrails,
    } : emptyGuardrails;
    const reportingCampaignRows = campaignRows.map(campaign => ({
      ...campaign,
      budgetRemainingPoints: Math.max(0, campaign.budgetPoints - (campaign.issuedPoints || 0)),
      estimatedLoyaltyLiabilityPaise: (campaign.issuedPoints || 0)
        * (Number(guardrailState.liabilityPaisePerPoint) || 0),
      visitAwardCount: campaign.minimumUniqueVisitDays > 0
        ? Number(budgetByVersion.get(campaign.versionId)?.awardCount) || 0
        : 0,
    }));
    const stores = (Array.isArray(storeSnapshots) ? storeSnapshots : storeSnapshots.docs)
      .filter(snapshot => snapshot.exists && snapshot.data()?.isActive === true)
      .map(snapshot => ({
        id: snapshot.id,
        code: cleanText(snapshot.data()?.code || snapshot.data()?.storeCode || snapshot.id, 80),
        name: cleanText(snapshot.data()?.displayName || snapshot.data()?.name || snapshot.id, 120),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const effectivePolicies = stores.map(store => {
      const storeOverride = policyRows.find(policy => (
        policy.scope === 'STORE'
        && policy.status === 'ACTIVE'
        && policy.storeIds.includes(store.id)
      )) || null;
      const effectivePolicy = storeOverride || globalPolicy;
      const activeCampaigns = reportingCampaignRows.filter(campaign => (
        campaign.status === 'ACTIVE' && campaign.storeIds.includes(store.id)
      ));
      return {
        storeId: store.id,
        globalEarnRateBps: globalPolicy?.earnRateBps ?? 1000,
        globalPolicyVersionId: globalPolicy?.versionId ?? 'BOND_POLICY_V1_2026',
        storeOverrideEarnRateBps: storeOverride?.earnRateBps ?? null,
        storeOverridePolicyVersionId: storeOverride?.versionId ?? null,
        effectiveEarnRateBps: effectivePolicy?.earnRateBps ?? 1000,
        effectivePolicyVersionId: effectivePolicy?.versionId ?? 'BOND_POLICY_V1_2026',
        policySource: storeOverride ? 'STORE_OVERRIDE' : 'GLOBAL_DEFAULT',
        campaignStackingMode: effectivePolicy?.campaignStackingMode ?? 'BASE_PLUS_ONE_CAMPAIGN',
        activeCampaigns: activeCampaigns.map(campaign => ({
          versionId: campaign.versionId,
          name: campaign.name,
          rewardType: campaign.rewardType,
          contributionEnabled: (effectivePolicy?.campaignStackingMode ?? 'BASE_PLUS_ONE_CAMPAIGN') === 'BASE_PLUS_ONE_CAMPAIGN',
        })),
        maxCombinedRewardRateBps: guardrailState.maxCombinedRewardRateBps,
      };
    });
    const auditHistory = audits.map(document => ({
      auditId: document.id,
      action: document.action,
      entityType: document.configurationType,
      versionId: document.result?.versionId || document.entityId || null,
      actorName: document.actorName,
      actorRole: document.actorRole,
      storeIds: document.storeIds || [],
      reason: document.reason || null,
      createdAt: serializableTimestamp(document.createdAt),
    }));
    return {
      actorRole: actor.role,
      canApprove: actor.role === 'ADMIN',
      canEditGlobalPolicy: actor.role === 'ADMIN',
      canPause: true,
      redemptionEnabled: false,
      customerOrderingOnly: true,
      nativePosEligible: false,
      guardrails: guardrailState,
      stores,
      globalPolicy,
      globalPolicies,
      storePolicies: policyRows.filter(policy => policy.scope === 'STORE'),
      campaigns: reportingCampaignRows,
      effectivePolicies,
      auditHistory,
      budgetAggregates: budgets.map(budget => ({
        versionId: budget.versionId || budget.id,
        budgetPoints: Number(budget.budgetPoints) || 0,
        awardedPoints: Number(budget.awardedPoints) || 0,
        reversedPoints: Number(budget.reversedPoints) || 0,
        netConsumedPoints: Number(budget.netConsumedPoints) || 0,
        awardCount: Number(budget.awardCount) || 0,
      })),
      customerUsageIncluded: false,
    };
  }

  async function previewScheduledPolicies(storeId, eventAtMillis) {
    const queryFor = (scopeKey) => db.collection(POLICY_SCOPES)
      .doc(scopeKey)
      .collection('segments')
      .where('startsAt', '<=', admin.firestore.Timestamp.fromMillis(eventAtMillis))
      .orderBy('startsAt', 'desc')
      .limit(25)
      .get();
    const storeScopeKey = `STORE_${storeId}`;
    const [globalSnapshot, storeSnapshot] = await Promise.all([
      queryFor('GLOBAL'),
      queryFor(storeScopeKey),
    ]);
    const resolveActive = (snapshot, scopeKey) => {
      const active = snapshot.docs.map(dataFromSnapshot).filter(segment => {
        const start = timestampMillis(segment.startsAt);
        const end = timestampMillis(segment.endsAt);
        return segment.configurationType === 'POLICY'
          && start <= eventAtMillis
          && (end === null || eventAtMillis < end);
      });
      if (active.length > 1) fail('failed-precondition', `Multiple policy schedules are active at ${scopeKey}.`);
      return active[0] || null;
    };
    const globalSegment = resolveActive(globalSnapshot, 'GLOBAL');
    const storeSegment = resolveActive(storeSnapshot, storeScopeKey);
    const segments = [globalSegment, storeSegment].filter(Boolean);
    if (segments.length === 0) return { policyVersions: [], guardrailVersionId: null };
    const snapshots = await db.getAll(
      ...segments.map(segment => db.collection(POLICY_VERSIONS).doc(segment.versionId)),
    );
    const policyVersions = snapshots.map((snapshot, index) => {
      const segment = segments[index];
      const version = dataFromSnapshot(snapshot);
      if (
        !version
        || version.configurationType !== 'POLICY'
        || !['APPROVED', 'SCHEDULED'].includes(version.status)
        || version.immutable !== true
        || definitionHash(version.definition) !== version.definitionHash
        || version.definitionHash !== segment.definitionHash
        || cleanText(version.guardrailVersionId, 180) !== cleanText(segment.guardrailVersionId, 180)
      ) {
        fail('failed-precondition', 'The effective policy failed its immutable version check.');
      }
      return {
        ...version.definition,
        versionId: version.id,
        storeIds: version.storeIds || version.definition.storeIds || [],
        startsAt: serializableTimestamp(segment.startsAt),
        endsAt: serializableTimestamp(segment.endsAt),
        guardrailVersionId: cleanText(segment.guardrailVersionId, 180) || null,
        status: 'APPROVED',
        approvalStatus: 'APPROVED',
        immutable: true,
      };
    });
    const selectedSegment = storeSegment || globalSegment;
    return {
      policyVersions,
      guardrailVersionId: cleanText(selectedSegment.guardrailVersionId, 180) || null,
    };
  }

  async function previewScheduledCampaign(storeId, eventAtMillis) {
    const snapshot = await db.collection(CAMPAIGN_SCOPES)
      .doc(storeId)
      .collection('segments')
      .where('startsAt', '<=', admin.firestore.Timestamp.fromMillis(eventAtMillis))
      .orderBy('startsAt', 'desc')
      .limit(25)
      .get();
    const active = snapshot.docs.map(dataFromSnapshot).filter(segment => {
      const start = timestampMillis(segment.startsAt);
      const end = timestampMillis(segment.endsAt);
      return segment.configurationType === 'CAMPAIGN'
        && start <= eventAtMillis
        && (end === null || eventAtMillis < end);
    });
    if (active.length > 1) fail('failed-precondition', `Multiple campaign schedules are active at ${storeId}.`);
    const segment = active[0] || null;
    if (!segment) return { campaignVersions: [], guardrailVersionId: null, campaignAwardedPoints: 0 };
    const [versionSnapshot, budgetSnapshot] = await Promise.all([
      db.collection(CAMPAIGN_VERSIONS).doc(segment.versionId).get(),
      db.collection(CAMPAIGN_BUDGETS).doc(segment.versionId).get(),
    ]);
    const version = dataFromSnapshot(versionSnapshot);
    if (
      !version
      || version.configurationType !== 'CAMPAIGN'
      || !['APPROVED', 'SCHEDULED'].includes(version.status)
      || version.immutable !== true
      || definitionHash(version.definition) !== version.definitionHash
      || version.definitionHash !== segment.definitionHash
      || cleanText(version.guardrailVersionId, 180) !== cleanText(segment.guardrailVersionId, 180)
    ) {
      fail('failed-precondition', 'The effective campaign failed its immutable version check.');
    }
    const budget = dataFromSnapshot(budgetSnapshot);
    if (
      !budget
      || cleanText(budget.versionId, 180) !== version.id
      || Number(budget.budgetPoints) !== Number(version.definition.budgetPoints)
    ) {
      fail('failed-precondition', 'The effective campaign budget failed its immutable projection check.');
    }
    return {
      campaignVersions: [{
        ...version.definition,
        versionId: version.id,
        campaignId: version.campaignId || version.definition.campaignId,
        storeIds: version.storeIds || version.definition.storeIds || [],
        startsAt: serializableTimestamp(segment.startsAt),
        endsAt: serializableTimestamp(segment.endsAt),
        guardrailVersionId: cleanText(segment.guardrailVersionId, 180) || null,
        status: 'APPROVED',
        approvalStatus: 'APPROVED',
        immutable: true,
      }],
      guardrailVersionId: cleanText(segment.guardrailVersionId, 180) || null,
      campaignAwardedPoints: Number(budget.netConsumedPoints) || 0,
    };
  }

  async function previewPolicyCampaign(request) {
    const actor = await loadManagerProfile(db, request);
    const rawPolicy = request.data?.policyDraft || request.data?.policy || null;
    const rawCampaign = request.data?.campaignDraft || request.data?.campaign || null;
    const policy = rawPolicy ? normalizePolicyInput(rawPolicy) : null;
    const campaign = rawCampaign && (cleanText(rawCampaign.name, 120) || request.data?.campaign)
      ? normalizeCampaignInput(rawCampaign)
      : null;
    if (!policy && !campaign) fail('invalid-argument', 'A policy or campaign preview is required.');
    if (policy?.configurationType === 'GUARDRAIL' && actor.role !== 'ADMIN') {
      fail('permission-denied', 'Only HQ Admin may preview new guardrails.');
    }
    if (policy?.configurationType === 'POLICY') {
      if (policy.definition.scope === 'GLOBAL' && actor.role !== 'ADMIN') {
        fail('permission-denied', 'Only HQ Admin may preview a global policy.');
      }
      assertStoreScope(actor, policy.storeIds);
    }
    if (campaign) assertStoreScope(actor, campaign.storeIds);
    const storeId = cleanId(
      request.data?.storeId || campaign?.storeIds?.[0] || policy?.storeIds?.[0],
      'Preview store',
    );
    if (campaign && !campaign.storeIds.includes(storeId)) {
      fail('invalid-argument', 'The preview store must be one of the candidate campaign stores.');
    }
    if (
      policy?.configurationType === 'POLICY'
      && policy.definition.scope === 'STORE'
      && !policy.storeIds.includes(storeId)
    ) {
      fail('invalid-argument', 'The preview store must be one of the candidate policy stores.');
    }
    assertStoreScope(actor, [storeId]);
    const candidateStoreIds = uniqueStrings([
      storeId,
      ...(policy?.storeIds || []),
      ...(campaign?.storeIds || []),
    ]);
    const candidateStoreSnapshots = await Promise.all(candidateStoreIds.map(candidateStoreId => (
      db.collection('stores').doc(candidateStoreId).get()
    )));
    if (candidateStoreSnapshots.some(snapshot => !snapshot.exists || snapshot.data()?.isActive !== true)) {
      fail('failed-precondition', 'Every selected preview store must exist and be active.');
    }
    const visitCount = campaign?.definition?.minimumUniqueVisitDays || 0;
    const campaignStartMillis = campaign
      ? inputMillis(campaign.definition.startsAt, 'Campaign start', { required: true })
      : null;
    const campaignEndMillis = campaign
      ? inputMillis(campaign.definition.endsAt, 'Campaign end', { required: true })
      : null;
    const prospectiveVisitInstants = visitCount > 0
      ? prospectiveIstVisitInstants(campaignStartMillis, campaignEndMillis)
      : [];
    const prospectiveVisitEventMillis = visitCount > 0
      ? prospectiveVisitInstants[visitCount - 1]
      : campaignStartMillis;
    if (visitCount > 0 && !Number.isFinite(prospectiveVisitEventMillis)) {
      fail('failed-precondition', 'The campaign window is too short to preview the configured unique IST visit-day threshold prospectively.');
    }
    const eventAtMillis = inputMillis(
      request.data?.scenario?.eventAt
      || prospectiveVisitEventMillis
      || policy?.definition?.startsAt
      || now(),
      'Preview event time',
      { required: true },
    );
    let visitDates = [];
    if (visitCount > 0) {
      if (eventAtMillis < campaignStartMillis || eventAtMillis >= campaignEndMillis) {
        fail('failed-precondition', 'A visit-frequency preview event must fall inside the candidate campaign window.');
      }
      if (campaign.definition.visitWindowDays < visitCount) {
        fail('failed-precondition', 'The visit lookback window cannot contain the configured number of unique IST visit days.');
      }
      const eligibleVisitInstants = prospectiveIstVisitInstants(
        campaignStartMillis,
        campaignEndMillis,
        eventAtMillis,
      );
      if (eligibleVisitInstants.length < visitCount) {
        fail('failed-precondition', 'The preview event does not allow enough prospective unique IST visit days inside the campaign window.');
      }
      visitDates = eligibleVisitInstants.slice(-visitCount).map(istBusinessDate);
    }
    const [scheduledPolicy, scheduledCampaign] = await Promise.all([
      previewScheduledPolicies(storeId, eventAtMillis),
      previewScheduledCampaign(storeId, eventAtMillis),
    ]);

    let guardrailDefinition = policy?.embeddedGuardrails || null;
    const requestedGuardrailId = cleanText(
      request.data?.guardrailVersionId
      || policy?.requestedGuardrailVersionId
      || campaign?.requestedGuardrailVersionId,
      180,
    );
    if (requestedGuardrailId && scheduledPolicy.guardrailVersionId
      && requestedGuardrailId !== scheduledPolicy.guardrailVersionId
      && policy?.configurationType !== 'POLICY') {
      fail('failed-precondition', 'The candidate campaign and effective store policy use different HQ guardrail versions.');
    }
    let guardrailVersionId = policy?.embeddedGuardrails
      ? 'DRY_RUN_GUARDRAIL'
      : requestedGuardrailId
        || scheduledPolicy.guardrailVersionId
        || scheduledCampaign.guardrailVersionId
        || null;
    if (!guardrailDefinition) {
      let snapshots;
      if (guardrailVersionId) {
        const snapshot = await db.collection(GUARDRAIL_VERSIONS).doc(guardrailVersionId).get();
        snapshots = snapshot.exists ? [dataFromSnapshot(snapshot)] : [];
      } else {
        const querySnapshot = await db.collection(GUARDRAIL_VERSIONS).where('status', '==', 'APPROVED').get();
        snapshots = querySnapshot.docs.map(dataFromSnapshot);
      }
      const approved = guardrailVersionId
        ? snapshots.find(document => ['APPROVED', 'SCHEDULED'].includes(document.status))
        : latestApprovedGuardrail(snapshots);
      if (!approved) fail('failed-precondition', 'An approved HQ guardrail version or candidate guardrails are required for preview.');
      guardrailDefinition = approved.definition.guardrails;
      guardrailVersionId = approved.id;
    }
    if (policy?.configurationType === 'POLICY') validatePolicyAgainstGuardrails(policy.definition, guardrailDefinition);
    if (campaign) validateCampaignAgainstGuardrails(campaign.definition, guardrailDefinition);

    // The pure engine is deliberately shared with the runtime so this read-only
    // preview cannot drift from the eventual ledger calculation.
    const engine = require('./bondPolicyCampaignEngine');
    const eligibleSpendPaise = requiredInteger(
      request.data?.eligibleSpendPaise ?? request.data?.scenario?.eligibleSpendPaise ?? 0,
      'Preview eligible spend',
      { minimum: 0 },
    );
    const orderChannel = cleanText(
      request.data?.orderChannel || request.data?.scenario?.orderChannel || 'CUSTOMER_WEB',
      40,
    ).toUpperCase();
    if (!['CUSTOMER_WEB', 'NATIVE_POS'].includes(orderChannel)) {
      fail('invalid-argument', 'Preview order channel must be CUSTOMER_WEB or NATIVE_POS.');
    }
    const candidatePolicyVersion = policy?.configurationType === 'POLICY' ? {
      versionId: 'DRY_RUN_POLICY',
      scope: policy.definition.scope,
      storeIds: policy.definition.storeIds,
      earnRateBps: policy.definition.earnRateBps,
      campaignStackingMode: policy.definition.campaignStackingMode,
      startsAt: policy.definition.startsAt,
      endsAt: policy.definition.endsAt,
      guardrailVersionId,
      status: 'APPROVED',
      immutable: true,
    } : null;
    const policyVersions = candidatePolicyVersion
      ? [
        ...scheduledPolicy.policyVersions.filter(version => (
          candidatePolicyVersion.scope === 'GLOBAL'
            ? version.scope !== 'GLOBAL'
            : !(version.scope === 'STORE' && version.storeIds.includes(storeId))
        )),
        candidatePolicyVersion,
      ]
      : scheduledPolicy.policyVersions;
    const candidateCampaignVersion = campaign ? {
      ...campaign.definition,
      versionId: 'DRY_RUN_CAMPAIGN',
      campaignId: campaign.definition.campaignId || 'DRY_RUN_CAMPAIGN',
      guardrailVersionId,
      status: 'APPROVED',
      immutable: true,
    } : null;
    const campaignVersions = candidateCampaignVersion
      ? [candidateCampaignVersion]
      : scheduledCampaign.campaignVersions;
    const effectiveCampaign = campaignVersions[0] || null;
    const effectiveVisitCount = Number(
      effectiveCampaign?.minimumUniqueVisitDays
      ?? effectiveCampaign?.minimumUniqueIstVisitDays
      ?? 0,
    );
    if (!candidateCampaignVersion && effectiveVisitCount > 0) {
      const formatIstBusinessDate = millis => new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(millis));
      const effectiveStart = inputMillis(effectiveCampaign.startsAt, 'Effective campaign start', { required: true });
      const effectiveStartDate = formatIstBusinessDate(effectiveStart);
      visitDates = Array.from({ length: effectiveVisitCount }, (_, index) => (
        formatIstBusinessDate(eventAtMillis - (index * DAY_MS))
      )).filter((businessDate, index, values) => (
        businessDate >= effectiveStartDate && values.indexOf(businessDate) === index
      ));
    }
    const productCodes = uniqueStrings(request.data?.productCodes || request.data?.scenario?.productCodes, 80);
    const categoryCodes = uniqueStrings(request.data?.categoryCodes || request.data?.scenario?.categoryCodes, 80);
    const campaignProducts = new Set(effectiveCampaign?.eligibleProductCodes || []);
    const campaignCategories = new Set(effectiveCampaign?.eligibleCategoryCodes || []);
    const matchedProduct = productCodes.find(code => campaignProducts.has(code))
      || productCodes[0]
      || [...campaignProducts][0]
      || 'DRY_RUN_PRODUCT';
    const matchedCategory = categoryCodes.find(code => campaignCategories.has(code))
      || categoryCodes[0]
      || [...campaignCategories][0]
      || 'DRY_RUN_CATEGORY';
    const matchingEligibleSpendPaise = requiredInteger(
      request.data?.matchingEligibleSpendPaise
        ?? request.data?.scenario?.matchingEligibleSpendPaise
        ?? eligibleSpendPaise,
      'Preview campaign-matching spend',
      { minimum: 0 },
    );
    if (matchingEligibleSpendPaise > eligibleSpendPaise) {
      fail('invalid-argument', 'Campaign-matching spend cannot exceed total eligible pre-GST spend.');
    }
    let unmatchedProduct = 'DRY_RUN_UNMATCHED_PRODUCT';
    while (campaignProducts.has(unmatchedProduct)) unmatchedProduct += '_X';
    let unmatchedCategory = 'DRY_RUN_UNMATCHED_CATEGORY';
    while (campaignCategories.has(unmatchedCategory)) unmatchedCategory += '_X';
    const scenarioItems = [
      ...(matchingEligibleSpendPaise > 0 ? [{
        productCode: matchedProduct,
        categoryCode: matchedCategory,
        eligiblePreGstPaise: matchingEligibleSpendPaise,
      }] : []),
      ...(eligibleSpendPaise > matchingEligibleSpendPaise ? [{
        productCode: unmatchedProduct,
        categoryCode: unmatchedCategory,
        eligiblePreGstPaise: eligibleSpendPaise - matchingEligibleSpendPaise,
      }] : []),
    ];
    if (orderChannel !== 'CUSTOMER_WEB') {
      return {
        previewStoreId: storeId,
        policyVersionId: null,
        campaignVersionId: null,
        basePoints: 0,
        rawCampaignPoints: 0,
        adjustedCampaignPoints: 0,
        campaignPoints: 0,
        totalRewardPoints: 0,
        maxCombinedRewardRateBps: guardrailDefinition.maxCombinedRewardRateBps,
        combinedRewardCapPoints: 0,
        combinedRewardCapApplied: false,
        storeLiabilityPaise: 0,
        maximumCampaignLiabilityPaise: 0,
        budgetPointsRemaining: null,
        eligibleSpendPaise,
        matchedSpendPaise: 0,
        campaignTriggered: false,
        campaignIneligibilityReasons: ['NATIVE_POS_LOYALTY_EXCLUDED'],
        customerLimitImpact: null,
        validationErrors: [],
        warnings: ['Native POS is excluded from BOND earning, campaigns, and redemption.'],
        conflicts: [],
        writesPerformed: 0,
        guardrailVersionId,
      };
    }
    const scenarioVisitDates = uniqueStrings(
      request.data?.scenario?.visitBusinessDates,
      20,
    );
    if (scenarioVisitDates.length > 0) visitDates = scenarioVisitDates;
    const scenarioHistory = request.data?.scenario?.customerCampaignHistory || {};
    let evaluated;
    try {
      evaluated = engine.dryRunBondReward({
        order: {
          orderId: 'BOND_POLICY_MANAGER_DRY_RUN',
          source: 'CUSTOMER_WEB',
          storeId,
          eventAt: eventAtMillis,
          eventAtAuthoritative: true,
          eligibleSpendPaise,
          eligibleSpendAuthoritative: true,
          itemsAuthoritative: true,
          items: scenarioItems,
        },
        policyVersions,
        campaignVersions,
        guardrails: guardrailDefinition,
        campaignUsage: effectiveCampaign ? {
          authoritative: true,
          campaignId: campaignVersions[0].campaignId,
          campaignVersionId: campaignVersions[0].versionId,
          customerUses: requiredInteger(scenarioHistory.customerUses ?? 0, 'Preview customer campaign uses', { minimum: 0 }),
          campaignAwardedPoints: candidateCampaignVersion
            ? 0
            : scheduledCampaign.campaignAwardedPoints,
          customerEligibleSpendPaise: requiredInteger(scenarioHistory.customerEligibleSpendPaise ?? 0, 'Preview customer campaign spend', { minimum: 0 }),
          frequencyAwards: requiredInteger(scenarioHistory.frequencyAwards ?? scenarioHistory.customerUses ?? 0, 'Preview customer frequency awards', { minimum: 0 }),
        } : null,
        visitEvidence: effectiveVisitCount > 0 ? {
          authoritative: true,
          timezone: 'Asia/Kolkata',
          businessDates: visitDates,
        } : null,
      });
    } catch (error) {
      fail('failed-precondition', cleanText(error?.message, 500) || 'BOND dry-run validation failed.');
    }
    const conflicts = [];
    if (policy?.configurationType === 'POLICY' && policy.definition.startsAt) {
      const start = timestampMillis(policy.definition.startsAt);
      const end = timestampMillis(policy.definition.endsAt);
      const scopeKeys = policy.definition.scope === 'GLOBAL'
        ? ['GLOBAL']
        : policy.storeIds.map(selectedStoreId => `STORE_${selectedStoreId}`);
      const snapshots = await Promise.all(scopeKeys.map(scopeKey => (
        db.collection(POLICY_SCOPES).doc(scopeKey).collection('segments').get()
      )));
      snapshots.forEach((snapshot, index) => snapshot.docs.forEach(document => {
        const segment = document.data();
        if (
          segment.configurationType === 'POLICY'
          && overlaps(start, end, timestampMillis(segment.startsAt), timestampMillis(segment.endsAt))
        ) {
          conflicts.push(`POLICY:${scopeKeys[index]}:${segment.scheduleId || document.id}`);
        }
      }));
    }
    if (campaign) {
      const start = Date.parse(campaign.definition.startsAt);
      const end = Date.parse(campaign.definition.endsAt);
      const snapshots = await Promise.all(campaign.storeIds.map(selectedStoreId => (
        db.collection(CAMPAIGN_SCOPES).doc(selectedStoreId).collection('segments').get()
      )));
      snapshots.forEach((snapshot, index) => snapshot.docs.forEach(document => {
        const segment = document.data();
        if (overlaps(start, end, timestampMillis(segment.startsAt), timestampMillis(segment.endsAt))) {
          conflicts.push(`CAMPAIGN:${campaign.storeIds[index]}:${segment.scheduleId || document.id}`);
        }
      }));
    }
    const campaignResult = evaluated.campaign;
    const validationErrors = [...(campaignResult?.ineligibilityReasons || [])];
    const overlayGuardrails = new Set([
      ...policyVersions.map(version => cleanText(version.guardrailVersionId, 180)),
      ...campaignVersions.map(version => cleanText(version.guardrailVersionId, 180)),
    ].filter(Boolean));
    if (overlayGuardrails.size > 1) {
      validationErrors.push('The preview overlay spans more than one HQ guardrail version and cannot be activated together.');
    }
    if (campaign || candidatePolicyVersion) {
      const rewardScheduleSnapshot = await db.collection(REWARD_SCHEDULES).get();
      let coverageSchedules = rewardScheduleSnapshot.docs.map(dataFromSnapshot);
      if (candidatePolicyVersion) {
        const candidateScopeKeys = candidatePolicyVersion.scope === 'GLOBAL'
          ? ['GLOBAL']
          : policy.storeIds.map(selectedStoreId => `STORE_${selectedStoreId}`);
        const candidateStart = timestampMillis(candidatePolicyVersion.startsAt);
        const candidateEnd = timestampMillis(candidatePolicyVersion.endsAt);
        coverageSchedules = coverageSchedules.filter(schedule => !(
          schedule.configurationType === 'POLICY'
          && Array.isArray(schedule.scopeKeys)
          && schedule.scopeKeys.some(scopeKey => candidateScopeKeys.includes(scopeKey))
          && overlaps(
            candidateStart,
            candidateEnd,
            timestampMillis(schedule.startsAt),
            timestampMillis(schedule.endsAt),
          )
        ));
        coverageSchedules.push({
          scheduleId: 'DRY_RUN_POLICY',
          configurationType: 'POLICY',
          scopeKeys: candidateScopeKeys,
          storeIds: candidatePolicyVersion.scope === 'GLOBAL' ? [] : policy.storeIds,
          guardrailVersionId,
          startsAt: candidateStart,
          endsAt: candidateEnd,
          status: 'DRY_RUN',
        });
      }
      try {
        if (campaign) {
          assertCampaignPolicyCoverage(coverageSchedules, {
            scheduleId: 'DRY_RUN_CAMPAIGN',
            configurationType: 'CAMPAIGN',
            storeIds: campaign.storeIds,
            guardrailVersionId,
            startsAt: timestampMillis(campaign.definition.startsAt),
            endsAt: timestampMillis(campaign.definition.endsAt),
            status: 'DRY_RUN',
          });
        }
        assertAllCampaignsHavePolicyCoverage(coverageSchedules);
      } catch (error) {
        validationErrors.push(cleanText(error?.message, 500) || 'Campaign policy coverage validation failed.');
      }
    }
    let maximumCampaignLiabilityPaise = 0;
    if (campaign) {
      const maximumLiability = BigInt(campaign.definition.budgetPoints)
        * BigInt(guardrailDefinition.liabilityPaisePerPoint);
      if (maximumLiability > BigInt(Number.MAX_SAFE_INTEGER)) {
        fail('failed-precondition', 'Maximum campaign liability exceeds the supported accounting range.');
      }
      maximumCampaignLiabilityPaise = Number(maximumLiability);
    }
    return {
      previewStoreId: storeId,
      policyVersionId: evaluated.policy.policyVersionId || null,
      campaignVersionId: campaignResult?.campaignVersionId || null,
      basePoints: evaluated.reward.basePoints,
      rawCampaignPoints: evaluated.reward.rawCampaignPoints,
      adjustedCampaignPoints: evaluated.reward.adjustedCampaignPoints,
      campaignPoints: evaluated.reward.campaignPoints,
      totalRewardPoints: evaluated.reward.totalPoints,
      maxCombinedRewardRateBps: evaluated.reward.maxCombinedRewardRateBps,
      combinedRewardCapPoints: evaluated.reward.combinedRewardCapPoints,
      combinedRewardCapApplied: evaluated.reward.combinedRewardCapApplied,
      storeLiabilityPaise: evaluated.reward.totalLiabilityPaise,
      maximumCampaignLiabilityPaise,
      budgetPointsRemaining: campaignResult?.budgetRemainingAfter ?? null,
      eligibleSpendPaise,
      matchedSpendPaise: campaignResult?.campaignEligibleSpendPaise ?? eligibleSpendPaise,
      campaignTriggered: Boolean(campaignResult?.eligible && campaignResult?.campaignPoints > 0),
      campaignIneligibilityReasons: campaignResult?.ineligibilityReasons || [],
      customerLimitImpact: campaignResult ? {
        before: campaignResult.customerUsesBefore,
        after: campaignResult.customerUsesAfter,
        maximum: effectiveCampaign?.customerAwardLimit ?? effectiveCampaign?.maxUsesPerCustomer ?? null,
      } : null,
      validationErrors,
      warnings: effectiveVisitCount > 0 ? [
        effectiveCampaign?.visitWindowMode === 'CALENDAR_WEEK_IST'
          ? 'Visit-frequency preview uses unique Monday–Sunday IST visit days inside the campaign window.'
          : 'Visit-frequency preview uses unique rolling IST visit days inside the campaign window.',
      ] : [],
      conflicts,
      writesPerformed: 0,
      guardrailVersionId,
    };
  }

  return {
    approveConfiguration,
    managerState,
    pauseConfiguration,
    previewPolicyCampaign,
    rollbackConfiguration,
    saveCampaignDraft,
    savePolicyDraft,
    scheduleConfiguration,
    submitCampaignDraft: request => submitVersion(request, 'CAMPAIGN'),
    submitPolicyDraft: request => submitVersion(request, 'POLICY'),
  };
}

function createBondPolicyCampaignManagerFunctions({ admin, db, region = REGION_FALLBACK }) {
  const service = createBondPolicyCampaignManagerService({ admin, db });
  return {
    getBondPolicyCampaignManagerState: onCall({ region }, request => service.managerState(request)),
    previewBondPolicyCampaign: onCall({ region }, request => service.previewPolicyCampaign(request)),
    saveBondPolicyDraft: onCall({ region }, request => service.savePolicyDraft(request)),
    submitBondPolicyDraft: onCall({ region }, request => service.submitPolicyDraft(request)),
    saveBondCampaignDraft: onCall({ region }, request => service.saveCampaignDraft(request)),
    submitBondCampaignDraft: onCall({ region }, request => service.submitCampaignDraft(request)),
    approveBondConfiguration: onCall({ region }, request => service.approveConfiguration(request)),
    scheduleBondConfiguration: onCall({ region }, request => service.scheduleConfiguration(request)),
    pauseBondConfiguration: onCall({ region }, request => service.pauseConfiguration(request)),
    rollbackBondConfiguration: onCall({ region }, request => service.rollbackConfiguration(request)),
  };
}

module.exports = {
  CAMPAIGN_BUDGETS,
  CAMPAIGN_CUSTOMER_USAGE,
  CAMPAIGN_SCOPES,
  CAMPAIGN_VERSIONS,
  GUARDRAIL_VERSIONS,
  MANAGEMENT_AUDIT,
  POLICY_SCOPES,
  POLICY_VERSIONS,
  REWARD_APPROVALS,
  REWARD_SCHEDULES,
  assignedStoreIds,
  createBondPolicyCampaignManagerFunctions,
  createBondPolicyCampaignManagerService,
  definitionHash,
  normalizeCampaignInput,
  normalizeGuardrails,
  normalizePolicyInput,
  validateCampaignAgainstGuardrails,
  validatePolicyAgainstGuardrails,
};
