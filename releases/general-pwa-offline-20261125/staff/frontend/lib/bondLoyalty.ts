import { httpsCallable } from 'firebase/functions';
import { customerFunctions } from './customerAuth';

export type BondMilestone = {
  visits: number;
  name: string;
};

export type BondSummary = {
  enabled: boolean;
  accountEnabled: boolean;
  shadowEnabled: boolean;
  earnEnabled: boolean;
  visitEnabled: boolean;
  expiryEnabled: boolean;
  redemptionEnabled: boolean;
  gamificationEnabled: boolean;
  clubEarnedEnabled: boolean;
  clubPaidEnabled: boolean;
  omakaseEnabled: boolean;
  customerOrderingOnly: true;
  policyVersion: string;
  pointsBalance?: number;
  qualifyingVisitCount?: number;
  currentClubStatus?: string;
  clubExpiresAt?: string | null;
  lastQualifyingActivityAt?: string | null;
  projectedPointsExpiryAt?: string | null;
  journey?: {
    validVisitCount: number;
    currentMilestone: BondMilestone | null;
    nextMilestone: BondMilestone | null;
    visitsRemaining: number;
    visitsToNextMilestone: number;
    progressPercentage: number;
    clubProgressPercentage: number;
    clubQualified: boolean;
  };
};

export const BOND_UI_DEMO_ENABLED = (
  import.meta.env.MODE === 'customer-preview'
  && import.meta.env.VITE_FIREBASE_PROJECT_ID === 'coffee-bond-pos-preview'
);

export type BondDemoQueryKey = 'new' | 'regular' | 'near-club' | 'club-member';

const BOND_DEMO_QUERY_KEYS: BondDemoQueryKey[] = ['new', 'regular', 'near-club', 'club-member'];

export function explicitBondDemoKey(search: string): BondDemoQueryKey | null {
  if (!BOND_UI_DEMO_ENABLED) return null;
  const requested = new URLSearchParams(search).get('bondDemo');
  return BOND_DEMO_QUERY_KEYS.includes(requested as BondDemoQueryKey)
    ? requested as BondDemoQueryKey
    : null;
}

const getSummary = httpsCallable<void, BondSummary>(customerFunctions, 'getCustomerBondSummary');

export async function getCustomerBondSummary(): Promise<BondSummary> {
  const response = await getSummary();
  return response.data;
}

export function estimateBondPoints(eligibleSpendRupees: number): number {
  const eligibleSpendPaise = Math.max(0, Math.round(Number(eligibleSpendRupees || 0) * 100));
  return Math.floor(eligibleSpendPaise / 1000);
}

export function formatBondDate(value: string | null | undefined): string {
  if (!value) return 'Not yet available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not yet available';
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}
