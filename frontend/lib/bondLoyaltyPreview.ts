import { explicitBondDemoKey } from './bondLoyalty';
import type { BondDemoQueryKey, BondSummary } from './bondLoyalty';

export type BondDemoStateKey = BondDemoQueryKey;

export type BondDemoState = {
  key: BondDemoStateKey;
  selectorLabel: string;
  memberLabel: string;
  points: number;
  visits: number;
  currentMilestone: string | null;
  nextMilestone: string | null;
  visitsToNext: number | null;
  clubActive: boolean;
  summary: BondSummary;
};

export const BOND_DEMO_SELECTOR_LABEL = 'Owner preview';
export const BOND_DEMO_SELECTOR_NOTE = 'Visual only · no account changes';
export const BOND_PREVIEW_ORDER_NOTICE = 'Owner preview · example order only · no ledger record created';

export const BOND_PREVIEW_ORDER = {
  trackingToken: 'bond-owner-preview-order',
  publicOrderReference: 'CBWEB-PREVIEW18',
  storeName: 'Coffee Bond · Golden I',
  orderType: 'PICKUP',
  total: 180,
  status: 'COMPLETED',
  paymentStatus: 'PAID',
  pointsEarned: 18,
  createdAt: '2026-08-16T04:15:00.000Z',
} as const;

const DEMO_POLICY_VERSION = 'BOND_UI_OWNER_PREVIEW_V1';

function demoSummary(points: number, visits: number, currentMilestone: string | null, nextMilestone: string | null): BondSummary {
  const visitsToNext = nextMilestone === 'First Bond'
    ? 1
    : nextMilestone === 'The Final 25'
      ? Math.max(0, 100 - visits)
      : nextMilestone === 'THE BOND CLUB'
        ? Math.max(0, 125 - visits)
        : 0;
  return {
    enabled: true,
    accountEnabled: true,
    shadowEnabled: false,
    earnEnabled: true,
    visitEnabled: true,
    expiryEnabled: false,
    redemptionEnabled: false,
    gamificationEnabled: true,
    clubEarnedEnabled: true,
    clubPaidEnabled: false,
    omakaseEnabled: false,
    customerOrderingOnly: true,
    policyVersion: DEMO_POLICY_VERSION,
    pointsBalance: points,
    qualifyingVisitCount: visits,
    currentClubStatus: visits >= 125 ? 'ACTIVE' : 'NOT_MEMBER',
    clubExpiresAt: null,
    lastQualifyingActivityAt: null,
    projectedPointsExpiryAt: null,
    journey: {
      validVisitCount: visits,
      currentMilestone: currentMilestone ? { visits, name: currentMilestone } : null,
      nextMilestone: nextMilestone ? { visits: visits + visitsToNext, name: nextMilestone } : null,
      visitsRemaining: Math.max(0, 125 - visits),
      visitsToNextMilestone: visitsToNext,
      progressPercentage: Math.min(100, Math.round((visits / 125) * 100)),
      clubProgressPercentage: Math.min(100, Math.round((visits / 125) * 100)),
      clubQualified: visits >= 125,
    },
  };
}

export const BOND_DEMO_STATES: Record<BondDemoStateKey, BondDemoState> = {
  new: {
    key: 'new', selectorLabel: 'New', memberLabel: 'New member', points: 0, visits: 0,
    currentMilestone: null, nextMilestone: 'First Bond', visitsToNext: 1, clubActive: false,
    summary: demoSummary(0, 0, null, 'First Bond'),
  },
  regular: {
    key: 'regular', selectorLabel: 'Regular', memberLabel: 'Regular member', points: 2480, visits: 83,
    currentMilestone: 'Deepening the Bond', nextMilestone: 'The Final 25', visitsToNext: 17, clubActive: false,
    summary: demoSummary(2480, 83, 'Deepening the Bond', 'The Final 25'),
  },
  'near-club': {
    key: 'near-club', selectorLabel: 'Near Club', memberLabel: 'Near Club', points: 4120, visits: 118,
    currentMilestone: 'The Final 25', nextMilestone: 'THE BOND CLUB', visitsToNext: 7, clubActive: false,
    summary: demoSummary(4120, 118, 'The Final 25', 'THE BOND CLUB'),
  },
  'club-member': {
    key: 'club-member', selectorLabel: 'Club Member', memberLabel: 'Club member', points: 7850, visits: 125,
    currentMilestone: 'THE BOND CLUB', nextMilestone: null, visitsToNext: null, clubActive: true,
    summary: demoSummary(7850, 125, 'THE BOND CLUB', null),
  },
};

export function bondDemoStateFromSearch(search: string): BondDemoState | null {
  const requested = explicitBondDemoKey(search);
  return requested ? BOND_DEMO_STATES[requested] : null;
}
