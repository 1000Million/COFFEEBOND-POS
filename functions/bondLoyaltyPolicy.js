'use strict';

const BOND_POLICY = Object.freeze({
  policyVersion: 'BOND_POLICY_V1_2026',
  programmeName: 'BOND Rewards',
  clubName: 'The BOND Club',
  channel: 'CUSTOMER_ORDERING_ONLY',
  pointsDivisorPaise: 1000,
  visitMinimumPaise: 15000,
  clubVisitTarget: 125,
  qualificationWindowDays: 365,
  membershipDays: 365,
  pointInactivityMonths: 18,
  timezone: 'Asia/Kolkata',
});

const DEFAULT_LOYALTY_FLAGS = Object.freeze({
  accountEnabled: false,
  shadowEnabled: false,
  earnEnabled: false,
  visitEnabled: false,
  expiryEnabled: false,
  redemptionEnabled: false,
  gamificationEnabled: false,
  clubEarnedEnabled: false,
  clubPaidEnabled: false,
  omakaseEnabled: false,
  customerOrderingOnly: true,
});

const JOURNEY_MILESTONES = Object.freeze([
  Object.freeze({ visits: 1, name: 'First Bond' }),
  Object.freeze({ visits: 10, name: 'Familiar Face' }),
  Object.freeze({ visits: 25, name: 'Regular Rhythm' }),
  Object.freeze({ visits: 50, name: 'The 50' }),
  Object.freeze({ visits: 75, name: 'Deepening the Bond' }),
  Object.freeze({ visits: 100, name: 'The Final 25' }),
  Object.freeze({ visits: 125, name: 'The BOND Club' }),
]);

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rupeesToPaise(value) {
  return Math.max(0, Math.round(finiteNumber(value) * 100));
}

function calculateEligibleSpendPaise(order) {
  const subtotalPaise = rupeesToPaise(order?.subtotal);
  const discountPaise = rupeesToPaise(
    order?.discountAmount ?? order?.discountTotal ?? order?.discount ?? 0,
  );
  const authoritativeTaxablePaise = order?.taxableAmount === null || order?.taxableAmount === undefined
    ? null
    : rupeesToPaise(order.taxableAmount);
  const eligibleSpendPaise = authoritativeTaxablePaise === null
    ? Math.max(0, subtotalPaise - discountPaise)
    : authoritativeTaxablePaise;
  return {
    eligibleSpendPaise,
    subtotalPaise,
    discountPaise,
    gstExcludedPaise: rupeesToPaise(order?.gstTotal ?? order?.taxTotal ?? 0),
    sourceField: authoritativeTaxablePaise === null ? 'subtotal-minus-discount' : 'taxableAmount',
    excludedRepresentedAmounts: Object.freeze({
      deliveryFeesPaise: rupeesToPaise(order?.deliveryFee ?? order?.deliveryFees ?? 0),
      serviceFeesPaise: rupeesToPaise(order?.serviceFee ?? order?.serviceFees ?? 0),
      tipsPaise: rupeesToPaise(order?.tip ?? order?.tips ?? 0),
      giftCardsPaise: rupeesToPaise(order?.giftCardAmount ?? 0),
      membershipFeesPaise: rupeesToPaise(order?.membershipFee ?? 0),
      pointFundedPaise: rupeesToPaise(order?.pointFundedAmount ?? 0),
    }),
  };
}

function calculateBondPoints(eligibleSpendPaise) {
  const spend = Math.max(0, Math.trunc(finiteNumber(eligibleSpendPaise)));
  return {
    pointsEarned: Math.floor(spend / BOND_POLICY.pointsDivisorPaise),
    remainderPaise: spend % BOND_POLICY.pointsDivisorPaise,
  };
}

function calculateISTBusinessDate(value) {
  const millis = value instanceof Date
    ? value.getTime()
    : typeof value?.toMillis === 'function'
      ? value.toMillis()
      : finiteNumber(value);
  if (!Number.isFinite(millis) || millis <= 0) throw new Error('A valid authoritative event timestamp is required.');
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BOND_POLICY.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(millis));
}

function addCalendarMonthsIST(value, months) {
  const sourceMillis = value instanceof Date
    ? value.getTime()
    : typeof value?.toMillis === 'function'
      ? value.toMillis()
      : finiteNumber(value);
  const local = new Date(sourceMillis + IST_OFFSET_MS);
  const sourceDay = local.getUTCDate();
  const targetYear = local.getUTCFullYear() + Math.floor((local.getUTCMonth() + months) / 12);
  const targetMonth = ((local.getUTCMonth() + months) % 12 + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const shifted = Date.UTC(
    targetYear,
    targetMonth,
    Math.min(sourceDay, lastDay),
    local.getUTCHours(),
    local.getUTCMinutes(),
    local.getUTCSeconds(),
    local.getUTCMilliseconds(),
  );
  return shifted - IST_OFFSET_MS;
}

function addDays(value, days) {
  const millis = value instanceof Date
    ? value.getTime()
    : typeof value?.toMillis === 'function'
      ? value.toMillis()
      : finiteNumber(value);
  return millis + (days * DAY_MS);
}

function businessDateDaysBefore(businessDate, days) {
  const [year, month, day] = String(businessDate).split('-').map(Number);
  const utc = Date.UTC(year, month - 1, day);
  return new Date(utc - (days * DAY_MS)).toISOString().slice(0, 10);
}

function calculateBondJourney(validVisitCount) {
  const visits = Math.max(0, Math.trunc(finiteNumber(validVisitCount)));
  const current = [...JOURNEY_MILESTONES].reverse().find(milestone => visits >= milestone.visits) || null;
  const next = JOURNEY_MILESTONES.find(milestone => visits < milestone.visits) || null;
  const lowerBound = current?.visits || 0;
  const upperBound = next?.visits || BOND_POLICY.clubVisitTarget;
  const interval = Math.max(1, upperBound - lowerBound);
  const intervalProgress = next ? Math.max(0, Math.min(interval, visits - lowerBound)) : interval;
  return {
    validVisitCount: visits,
    currentMilestone: current,
    nextMilestone: next,
    visitsRemaining: Math.max(0, BOND_POLICY.clubVisitTarget - visits),
    visitsToNextMilestone: next ? Math.max(0, next.visits - visits) : 0,
    progressPercentage: Math.round((intervalProgress / interval) * 100),
    clubProgressPercentage: Math.min(100, Math.round((visits / BOND_POLICY.clubVisitTarget) * 100)),
    clubQualified: visits >= BOND_POLICY.clubVisitTarget,
  };
}

function resolveLoyaltyFlags(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const accountEnabled = raw.accountEnabled === true;
  return {
    accountEnabled,
    shadowEnabled: raw.shadowEnabled === true,
    earnEnabled: accountEnabled && raw.earnEnabled === true,
    visitEnabled: accountEnabled && raw.visitEnabled === true,
    expiryEnabled: false,
    redemptionEnabled: false,
    gamificationEnabled: accountEnabled && raw.gamificationEnabled === true,
    clubEarnedEnabled: accountEnabled && raw.visitEnabled === true && raw.clubEarnedEnabled === true,
    clubPaidEnabled: false,
    omakaseEnabled: false,
    customerOrderingOnly: true,
  };
}

module.exports = {
  BOND_POLICY,
  DAY_MS,
  DEFAULT_LOYALTY_FLAGS,
  JOURNEY_MILESTONES,
  addCalendarMonthsIST,
  addDays,
  businessDateDaysBefore,
  calculateBondJourney,
  calculateBondPoints,
  calculateEligibleSpendPaise,
  calculateISTBusinessDate,
  resolveLoyaltyFlags,
  rupeesToPaise,
};
