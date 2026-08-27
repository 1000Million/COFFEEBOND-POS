import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  BOND_TIMEZONE,
  BondPolicyCampaignError,
  LEGACY_DEFAULT_EARN_BASIS_POINTS,
  calculateEarnPoints,
  dryRunBondReward,
  resolveCampaignVersion,
  resolvePolicyVersion,
} = require('../functions/bondPolicyCampaignEngine');

const T0 = Date.parse('2026-08-21T09:00:00.000Z');
const T1 = Date.parse('2026-08-22T09:00:00.000Z');
const T2 = Date.parse('2026-08-31T09:00:00.000Z');

const guardrails = Object.freeze({
  minEarnRateBps: 500,
  maxEarnRateBps: 1500,
  maxCombinedRewardRateBps: 2000,
  maxMultiplierBps: 30_000,
  maxFixedBonusPoints: 100,
  maxCampaignDays: 31,
  maxCustomerAwards: 10,
  maxCampaignBudgetPoints: 10_000,
  liabilityPaisePerPoint: 125,
});

function policy(overrides = {}) {
  return {
    versionId: 'policy-global-v1',
    immutable: true,
    scope: 'GLOBAL',
    storeIds: [],
    earnRateBps: 1000,
    status: 'ACTIVE',
    startsAt: T0,
    endsAt: T2,
    ...overrides,
  };
}

function campaign(overrides = {}) {
  return {
    campaignId: 'campaign-1',
    versionId: 'campaign-1-v1',
    immutable: true,
    storeIds: ['STORE_A'],
    status: 'ACTIVE',
    startsAt: T0,
    endsAt: T2,
    stackingMode: 'EXCLUSIVE_ONE',
    rewardType: 'FIXED_POINTS',
    fixedBonusPoints: 7,
    minimumSpendPaise: 0,
    eligibleProductCodes: [],
    eligibleCategoryCodes: [],
    minimumUniqueVisitDays: 0,
    visitWindowDays: 0,
    customerAwardLimit: null,
    budgetPoints: null,
    ...overrides,
  };
}

function order(overrides = {}) {
  return {
    orderId: 'order-1',
    source: 'CUSTOMER_WEB',
    storeId: 'STORE_A',
    eventAt: T1,
    eventAtAuthoritative: true,
    eligibleSpendPaise: 25_000,
    eligibleSpendAuthoritative: true,
    itemsAuthoritative: true,
    items: [
      { finishedGoodId: 'fg-coffee', finishedGoodCode: 'COFFEE', categoryId: 'DRINKS', lineTaxable: 150 },
      { finishedGoodId: 'fg-food', finishedGoodCode: 'FOOD', categoryId: 'FOOD', lineTaxable: 100 },
    ],
    ...overrides,
  };
}

function expectCode(code, operation) {
  assert.throws(operation, error => error instanceof BondPolicyCampaignError && error.code === code);
}

const checks = [];
function check(name, operation) {
  operation();
  checks.push(name);
  console.log(`PASS ${checks.length}. ${name}`);
}

check('legacy default remains exactly 1000 integer basis points', () => {
  assert.equal(LEGACY_DEFAULT_EARN_BASIS_POINTS, 1000);
  assert.deepEqual(calculateEarnPoints(25_000), {
    points: 25,
    remainderRateUnits: 0,
    earnBasisPoints: 1000,
    eligibleSpendPaise: 25_000,
  });
  assert.equal(resolvePolicyVersion({ policyVersions: [], storeId: 'STORE_A', eventAt: T1 }).source, 'LEGACY_DEFAULT');
});

check('managed global default resolves inside its half-open activation window', () => {
  const selected = resolvePolicyVersion({
    policyVersions: [policy()],
    storeId: 'STORE_A',
    eventAt: T1,
    guardrails,
  });
  assert.equal(selected.versionId, 'policy-global-v1');
  assert.equal(selected.source, 'GLOBAL_DEFAULT');
  assert.equal(selected.earnRateBps, 1000);
});

check('assigned store override wins over the active global default', () => {
  const selected = resolvePolicyVersion({
    policyVersions: [
      policy(),
      policy({
        versionId: 'policy-store-v1',
        scope: 'STORE',
        storeIds: ['STORE_A', 'STORE_B'],
        earnRateBps: 1500,
      }),
    ],
    storeId: 'STORE_A',
    eventAt: T1,
    guardrails,
  });
  assert.equal(selected.versionId, 'policy-store-v1');
  assert.equal(selected.source, 'STORE_OVERRIDE');
  assert.equal(selected.earnBasisPoints, 1500);
});

check('adjacent policy versions use [start,end) without double activation', () => {
  const selected = resolvePolicyVersion({
    policyVersions: [
      policy({ versionId: 'old', startsAt: T0, endsAt: T1 }),
      policy({ versionId: 'new', startsAt: T1, endsAt: T2, status: 'SCHEDULED' }),
    ],
    storeId: 'STORE_A',
    eventAt: T1,
    guardrails,
  });
  assert.equal(selected.versionId, 'new');
});

check('policy overlap fails closed instead of silently picking a version', () => {
  expectCode('BOND_POLICY_WINDOW_OVERLAP', () => resolvePolicyVersion({
    policyVersions: [policy(), policy({ versionId: 'overlap' })],
    storeId: 'STORE_A',
    eventAt: T1,
    guardrails,
  }));
});

check('HQ earn-rate guardrails reject an out-of-range store override', () => {
  expectCode('BOND_EARN_RATE_OUTSIDE_GUARDRAILS', () => resolvePolicyVersion({
    policyVersions: [policy({
      versionId: 'unsafe-store',
      scope: 'STORE',
      storeIds: ['STORE_A'],
      earnRateBps: 1501,
    })],
    storeId: 'STORE_A',
    eventAt: T1,
    guardrails,
  }));
});

check('mutable policy versions are rejected', () => {
  expectCode('BOND_MUTABLE_VERSION_REJECTED', () => resolvePolicyVersion({
    policyVersions: [policy({ immutable: false })],
    storeId: 'STORE_A',
    eventAt: T1,
    guardrails,
  }));
});

check('two active store campaigns fail closed and never stack', () => {
  expectCode('BOND_CAMPAIGN_WINDOW_OVERLAP', () => resolveCampaignVersion({
    campaignVersions: [campaign(), campaign({ campaignId: 'campaign-2', versionId: 'campaign-2-v1' })],
    storeId: 'STORE_A',
    eventAt: T1,
    guardrails,
  }));
});

check('fixed campaign points use authoritative finished-good codes and lineTaxable', () => {
  const result = dryRunBondReward({
    order: order(),
    policyVersions: [policy()],
    campaignVersions: [campaign({
      eligibleProductCodes: ['COFFEE'],
      minimumSpendPaise: 15_000,
      customerAwardLimit: 2,
      budgetPoints: 20,
    })],
    guardrails,
    campaignUsage: {
      authoritative: true,
      campaignId: 'campaign-1',
      campaignVersionId: 'campaign-1-v1',
      customerUses: 0,
      campaignAwardedPoints: 7,
    },
  });
  assert.equal(result.campaign.eligible, true);
  assert.equal(result.campaign.campaignEligibleSpendPaise, 15_000);
  assert.deepEqual(result.campaign.matchedProductCodes, ['COFFEE']);
  assert.deepEqual(result.reward, {
    basePoints: 25,
    rawCampaignPoints: 7,
    adjustedCampaignPoints: 7,
    campaignPoints: 7,
    totalPoints: 32,
    finalRewardPoints: 32,
    maxCombinedRewardRateBps: 2000,
    combinedRewardCapPoints: 50,
    combinedRewardCapApplied: false,
    pointValuePaise: 125,
    baseLiabilityPaise: 3125,
    campaignLiabilityPaise: 875,
    totalLiabilityPaise: 4000,
    totalLiabilityRupees: 40,
  });
});

check('combined base and campaign reward is capped independently at 20 percent', () => {
  const result = dryRunBondReward({
    order: order({ eligibleSpendPaise: 15_000 }),
    policyVersions: [policy()],
    campaignVersions: [campaign({
      fixedBonusPoints: 25,
      minimumSpendPaise: 15_000,
      customerAwardLimit: 1,
      budgetPoints: 100,
    })],
    guardrails,
    campaignUsage: {
      authoritative: true,
      campaignId: 'campaign-1',
      campaignVersionId: 'campaign-1-v1',
      customerUses: 0,
      campaignAwardedPoints: 0,
    },
  });
  assert.equal(result.reward.basePoints, 15);
  assert.equal(result.campaign.configuredCampaignPoints, 25);
  assert.equal(result.reward.campaignPoints, 15);
  assert.equal(result.reward.totalPoints, 30);
  assert.equal(result.reward.combinedRewardCapPoints, 30);
  assert.equal(result.reward.combinedRewardCapApplied, true);
  assert.equal(result.campaign.budgetRemainingAfter, 85);
});

check('filtered products cannot pad campaign minimum spend with ineligible items', () => {
  const result = dryRunBondReward({
    order: order(),
    policyVersions: [policy()],
    campaignVersions: [campaign({
      eligibleProductCodes: ['FOOD'],
      minimumSpendPaise: 15_000,
    })],
    guardrails,
  });
  assert.equal(result.campaign.campaignEligibleSpendPaise, 10_000);
  assert.equal(result.campaign.eligible, false);
  assert.deepEqual(result.campaign.ineligibilityReasons, ['MINIMUM_SPEND_NOT_MET']);
  assert.equal(result.reward.campaignPoints, 0);
});

check('category-filtered multiplier adds only the incremental matching reward', () => {
  const result = dryRunBondReward({
    order: order(),
    policyVersions: [policy()],
    campaignVersions: [campaign({
      rewardType: 'MULTIPLIER',
      fixedBonusPoints: null,
      multiplierBps: 20_000,
      eligibleCategoryCodes: ['FOOD'],
    })],
    guardrails,
  });
  assert.equal(result.reward.basePoints, 25);
  assert.equal(result.reward.campaignPoints, 10);
  assert.equal(result.reward.totalPoints, 35);
  assert.deepEqual(result.campaign.matchedCategoryCodes, ['FOOD']);
});

check('percentage-bonus campaigns add the configured percentage of eligible pre-GST spend', () => {
  const result = dryRunBondReward({
    order: order(),
    policyVersions: [policy()],
    campaignVersions: [campaign({
      rewardType: 'PERCENTAGE_BONUS',
      fixedBonusPoints: null,
      percentageBonusBps: 500,
    })],
    guardrails,
  });
  assert.equal(result.reward.basePoints, 25);
  assert.equal(result.reward.rawCampaignPoints, 12);
  assert.equal(result.reward.adjustedCampaignPoints, 12);
  assert.equal(result.reward.finalRewardPoints, 37);
});

check('a policy with campaign stacking NONE exposes base earning only', () => {
  const result = dryRunBondReward({
    order: order(),
    policyVersions: [policy({ campaignStackingMode: 'NONE' })],
    campaignVersions: [campaign({ fixedBonusPoints: 25 })],
    guardrails,
  });
  assert.equal(result.policy.campaignStackingMode, 'NONE');
  assert.equal(result.campaign, null);
  assert.equal(result.reward.basePoints, 25);
  assert.equal(result.reward.finalRewardPoints, 25);
});

check('a spend milestone carries authoritative customer spend forward and still obeys the combined cap', () => {
  const result = dryRunBondReward({
    order: order({ eligibleSpendPaise: 10_000 }),
    policyVersions: [policy()],
    campaignVersions: [campaign({
      fixedBonusPoints: 100,
      spendMilestonePaise: 100_000,
    })],
    guardrails,
    campaignUsage: {
      authoritative: true,
      campaignId: 'campaign-1',
      campaignVersionId: 'campaign-1-v1',
      customerUses: 0,
      campaignAwardedPoints: 0,
      customerEligibleSpendPaise: 90_000,
    },
  });
  assert.equal(result.campaign.spendMilestonesCrossed, 1);
  assert.equal(result.campaign.rawCampaignPoints, 100);
  assert.equal(result.campaign.adjustedCampaignPoints, 10);
  assert.equal(result.reward.combinedRewardCapPoints, 20);
  assert.equal(result.reward.finalRewardPoints, 20);
});

check('a per-order campaign cap is enforced before the authoritative combined cap', () => {
  const result = dryRunBondReward({
    order: order({ eligibleSpendPaise: 30_000 }),
    policyVersions: [policy()],
    campaignVersions: [campaign({
      fixedBonusPoints: 25,
      maximumAwardPointsPerOrder: 5,
    })],
    guardrails,
  });
  assert.equal(result.campaign.rawCampaignPoints, 25);
  assert.equal(result.campaign.perOrderCappedPoints, 5);
  assert.equal(result.reward.adjustedCampaignPoints, 5);
  assert.equal(result.reward.finalRewardPoints, 35);
});

check('weekday and IST time campaigns evaluate in Asia/Kolkata, not browser time', () => {
  const eligible = dryRunBondReward({
    order: order({ eventAt: Date.parse('2026-08-24T06:00:00.000Z') }),
    policyVersions: [policy()],
    campaignVersions: [campaign({
      fixedBonusPoints: 7,
      eligibleIstWeekdays: ['MONDAY'],
      startsAtMinuteIST: 600,
      endsAtMinuteIST: 720,
    })],
    guardrails,
  });
  const ineligible = dryRunBondReward({
    order: order({ eventAt: Date.parse('2026-08-24T15:00:00.000Z') }),
    policyVersions: [policy()],
    campaignVersions: [campaign({
      fixedBonusPoints: 7,
      eligibleIstWeekdays: ['MONDAY'],
      startsAtMinuteIST: 600,
      endsAtMinuteIST: 720,
    })],
    guardrails,
  });
  assert.equal(eligible.campaign.eventIstWeekday, 'MONDAY');
  assert.equal(eligible.reward.campaignPoints, 7);
  assert.ok(ineligible.campaign.ineligibilityReasons.includes('IST_TIME_NOT_ELIGIBLE'));
});

check('visit-frequency eligibility deduplicates IST dates inside the configured window', () => {
  const result = dryRunBondReward({
    order: order({ eventAt: Date.parse('2026-08-22T18:00:00.000Z') }),
    policyVersions: [policy()],
    campaignVersions: [campaign({
      minimumUniqueVisitDays: 2,
      everyNthUniqueIstVisitDay: 2,
      visitWindowDays: 2,
    })],
    guardrails,
    visitEvidence: {
      authoritative: true,
      timezone: BOND_TIMEZONE,
      businessDates: ['2026-08-20', '2026-08-21', '2026-08-21', '2026-08-22', '2026-08-23'],
    },
  });
  assert.equal(result.campaign.eligible, true);
  assert.equal(result.campaign.uniqueIstVisitDays, 2);
});

check('calendar-week visit campaigns never count a prior Monday–Sunday IST week', () => {
  const result = dryRunBondReward({
    order: order({ eventAt: Date.parse('2026-08-26T06:30:00.000Z') }),
    policyVersions: [policy()],
    campaignVersions: [campaign({
      minimumUniqueVisitDays: 3,
      visitWindowDays: 7,
      visitWindowMode: 'CALENDAR_WEEK_IST',
    })],
    guardrails,
    visitEvidence: {
      authoritative: true,
      timezone: BOND_TIMEZONE,
      businessDates: ['2026-08-23', '2026-08-24', '2026-08-25', '2026-08-26'],
    },
  });
  assert.equal(result.campaign.uniqueIstVisitDays, 3);
  assert.equal(result.campaign.eligible, true);
});

check('frequency limits use authoritative campaign-window counters', () => {
  const result = dryRunBondReward({
    order: order(),
    policyVersions: [policy()],
    campaignVersions: [campaign({
      frequencyAwardLimit: 1,
      frequencyWindow: 'WEEK_IST',
    })],
    guardrails,
    campaignUsage: {
      authoritative: true,
      campaignId: 'campaign-1',
      campaignVersionId: 'campaign-1-v1',
      customerUses: 0,
      campaignAwardedPoints: 0,
      frequencyAwards: 1,
    },
  });
  assert.ok(result.campaign.ineligibilityReasons.includes('CAMPAIGN_FREQUENCY_LIMIT_REACHED'));
  assert.equal(result.reward.campaignPoints, 0);
});

check('visit-frequency evidence is prospective from campaign activation', () => {
  const result = dryRunBondReward({
    order: order({ eventAt: Date.parse('2026-08-22T18:00:00.000Z') }),
    policyVersions: [policy()],
    campaignVersions: [campaign({ minimumUniqueVisitDays: 3, visitWindowDays: 10 })],
    guardrails,
    visitEvidence: {
      authoritative: true,
      timezone: BOND_TIMEZONE,
      businessDates: ['2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22'],
    },
  });
  assert.equal(result.campaign.eligible, false);
  assert.equal(result.campaign.uniqueIstVisitDays, 2);
  assert.ok(result.campaign.ineligibilityReasons.includes('MINIMUM_UNIQUE_IST_VISIT_DAYS_NOT_MET'));
});

check('customer award limit prevents another campaign award', () => {
  const result = dryRunBondReward({
    order: order(),
    policyVersions: [policy()],
    campaignVersions: [campaign({ customerAwardLimit: 1 })],
    guardrails,
    campaignUsage: {
      authoritative: true,
      campaignId: 'campaign-1',
      campaignVersionId: 'campaign-1-v1',
      customerUses: 1,
      campaignAwardedPoints: 7,
    },
  });
  assert.deepEqual(result.campaign.ineligibilityReasons, ['CUSTOMER_USE_LIMIT_REACHED']);
  assert.equal(result.reward.totalPoints, result.reward.basePoints);
});

check('campaign points budget prevents overspend', () => {
  const result = dryRunBondReward({
    order: order(),
    policyVersions: [policy()],
    campaignVersions: [campaign({ budgetPoints: 10 })],
    guardrails,
    campaignUsage: {
      authoritative: true,
      campaignId: 'campaign-1',
      campaignVersionId: 'campaign-1-v1',
      customerUses: 0,
      campaignAwardedPoints: 5,
    },
  });
  assert.deepEqual(result.campaign.ineligibilityReasons, ['CAMPAIGN_POINTS_BUDGET_EXCEEDED']);
  assert.equal(result.campaign.campaignAwardedPointsAfter, 5);
});

check('configured campaign limits require authoritative counters', () => {
  expectCode('BOND_UNVERIFIED_CAMPAIGN_USAGE', () => dryRunBondReward({
    order: order(),
    policyVersions: [policy()],
    campaignVersions: [campaign({ budgetPoints: 10 })],
    guardrails,
  }));
});

check('non-customer-web and unverified order evidence are rejected', () => {
  expectCode('BOND_CHANNEL_INELIGIBLE', () => dryRunBondReward({
    order: order({ source: 'POS' }),
    policyVersions: [policy()],
    guardrails,
  }));
  expectCode('BOND_UNVERIFIED_ORDER_EVIDENCE', () => dryRunBondReward({
    order: order({ eligibleSpendAuthoritative: false }),
    policyVersions: [policy()],
    guardrails,
  }));
});

check('product campaigns reject non-authoritative items', () => {
  expectCode('BOND_UNVERIFIED_ITEM_EVIDENCE', () => dryRunBondReward({
    order: order({ itemsAuthoritative: false }),
    policyVersions: [policy()],
    campaignVersions: [campaign({ eligibleProductCodes: ['COFFEE'] })],
    guardrails,
  }));
});

check('order idempotency evidence remains stable across policy changes', () => {
  const first = dryRunBondReward({
    order: order(),
    policyVersions: [policy()],
    guardrails,
  });
  const second = dryRunBondReward({
    order: order(),
    policyVersions: [policy({ versionId: 'replacement', earnRateBps: 1500 })],
    guardrails,
  });
  assert.equal(first.idempotencyEvidence.logicalEventKey, second.idempotencyEvidence.logicalEventKey);
  assert.equal(second.idempotencyEvidence.excludesPolicyAndCampaignVersions, true);
  assert.equal(second.ledgerEvidence.policyVersionId, 'replacement');
  assert.equal(second.ledgerEvidence.issuingStoreId, 'STORE_A');
});

console.log(`\nBOND pure policy/campaign tests passed: ${checks.length}/${checks.length}.`);
