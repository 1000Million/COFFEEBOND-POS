import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';

export type BondConfigurationType = 'POLICY' | 'CAMPAIGN';
export type BondConfigurationStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'SCHEDULED'
  | 'ACTIVE'
  | 'PAUSED'
  | 'ROLLED_BACK'
  | 'SUPERSEDED';
export type BondCampaignRewardType = 'FIXED_POINTS' | 'EARN_MULTIPLIER';

export type BondManagerStore = {
  id: string;
  code: string;
  name: string;
};

export type BondGuardrails = {
  versionId: string;
  minEarnRateBps: number | null;
  maxEarnRateBps: number | null;
  maxMultiplierBps: number | null;
  maxFixedBonusPoints: number | null;
  maxCampaignDays: number | null;
  maxCustomerAwards: number | null;
  maxCampaignBudgetPoints: number | null;
  liabilityPaisePerPoint: number | null;
};

export type BondPolicyVersion = {
  versionId: string;
  scope: 'GLOBAL' | 'STORE';
  storeIds: string[];
  earnRateBps: number;
  status: BondConfigurationStatus;
  startsAt: string | null;
  endsAt: string | null;
  approvedStartsAt: string | null;
  approvedEndsAt: string | null;
  guardrailVersionId: string;
  createdByName?: string | null;
  scheduleId?: string | null;
};

export type BondCampaignVersion = {
  versionId: string;
  name: string;
  storeIds: string[];
  rewardType: BondCampaignRewardType;
  fixedBonusPoints: number | null;
  multiplierBps: number | null;
  minimumSpendPaise: number;
  eligibleProductCodes: string[];
  eligibleCategoryCodes: string[];
  minimumUniqueVisitDays: number;
  visitWindowDays: number;
  customerAwardLimit: number;
  budgetPoints: number;
  stackingMode: 'EXCLUSIVE_ONE';
  status: BondConfigurationStatus;
  startsAt: string | null;
  endsAt: string | null;
  approvedStartsAt: string | null;
  approvedEndsAt: string | null;
  issuedPoints?: number;
  scheduleId?: string | null;
};

export type BondAuditEntry = {
  auditId: string;
  action: string;
  entityType: BondConfigurationType | 'GUARDRAIL';
  versionId?: string | null;
  actorName: string;
  actorRole: string;
  storeIds: string[];
  reason?: string | null;
  createdAt: string | null;
};

export type BondPolicyCampaignManagerState = {
  actorRole: 'ADMIN' | 'FRANCHISE_MANAGER';
  canApprove: boolean;
  canEditGlobalPolicy: boolean;
  canPause: boolean;
  redemptionEnabled: false;
  customerOrderingOnly: true;
  nativePosEligible: false;
  guardrails: BondGuardrails;
  stores: BondManagerStore[];
  globalPolicy: BondPolicyVersion | null;
  globalPolicies?: BondPolicyVersion[];
  storePolicies: BondPolicyVersion[];
  campaigns: BondCampaignVersion[];
  auditHistory: BondAuditEntry[];
};

export type BondPolicyDraftInput = {
  requestId?: string;
  draftId?: string;
  scope: 'GLOBAL' | 'STORE';
  storeIds: string[];
  earnRateBps: number;
  startsAt: string;
  endsAt: string | null;
  reason: string;
  guardrails?: Omit<BondGuardrails, 'versionId'>;
};

export type BondCampaignDraftInput = {
  requestId?: string;
  draftId?: string;
  name: string;
  storeIds: string[];
  startsAt: string;
  endsAt: string;
  rewardType: BondCampaignRewardType;
  fixedBonusPoints: number | null;
  multiplierBps: number | null;
  minimumSpendPaise: number;
  eligibleProductCodes: string[];
  eligibleCategoryCodes: string[];
  minimumUniqueVisitDays: number;
  visitWindowDays: number;
  customerAwardLimit: number;
  budgetPoints: number;
  stackingMode: 'EXCLUSIVE_ONE';
  reason: string;
};

export type BondDryRunResponse = {
  previewStoreId: string;
  policyVersionId: string | null;
  campaignVersionId: string | null;
  basePoints: number;
  campaignPoints: number;
  totalRewardPoints: number;
  storeLiabilityPaise: number;
  maximumCampaignLiabilityPaise: number;
  budgetPointsRemaining: number | null;
  eligibleSpendPaise: number;
  matchedSpendPaise: number;
  validationErrors: string[];
  warnings: string[];
  conflicts: string[];
  writesPerformed: 0;
};

type VersionResult = { ok: true; versionId: string; status: BondConfigurationStatus };
type WorkflowRequest = {
  requestId?: string;
  configurationType: BondConfigurationType;
  versionId?: string;
  scheduleId?: string;
  startsAt?: string;
  endsAt?: string | null;
  reason: string;
};

const getManagerStateCallable = httpsCallable<Record<string, never>, BondPolicyCampaignManagerState>(
  functions,
  'getBondPolicyCampaignManagerState',
);
const previewCallable = httpsCallable<{
  storeId: string;
  eligibleSpendPaise: number;
  matchingEligibleSpendPaise: number;
  productCodes: string[];
  categoryCodes: string[];
  scenario?: { eventAt?: string };
  policyDraft?: BondPolicyDraftInput;
  campaignDraft?: BondCampaignDraftInput;
}, BondDryRunResponse>(functions, 'previewBondPolicyCampaign');
const savePolicyCallable = httpsCallable<BondPolicyDraftInput, VersionResult>(functions, 'saveBondPolicyDraft');
const submitPolicyCallable = httpsCallable<{ requestId: string; versionId: string; reason: string }, VersionResult>(functions, 'submitBondPolicyDraft');
const saveCampaignCallable = httpsCallable<BondCampaignDraftInput, VersionResult>(functions, 'saveBondCampaignDraft');
const submitCampaignCallable = httpsCallable<{ requestId: string; versionId: string; reason: string }, VersionResult>(functions, 'submitBondCampaignDraft');
const approveCallable = httpsCallable<WorkflowRequest, VersionResult>(functions, 'approveBondConfiguration');
const scheduleCallable = httpsCallable<WorkflowRequest, VersionResult>(functions, 'scheduleBondConfiguration');
const pauseCallable = httpsCallable<WorkflowRequest, VersionResult>(functions, 'pauseBondConfiguration');
const rollbackCallable = httpsCallable<WorkflowRequest, VersionResult>(functions, 'rollbackBondConfiguration');

export async function getBondPolicyCampaignManagerState(): Promise<BondPolicyCampaignManagerState> {
  return (await getManagerStateCallable({})).data;
}

export async function previewBondPolicyCampaign(input: Parameters<typeof previewCallable>[0]): Promise<BondDryRunResponse> {
  return (await previewCallable(input)).data;
}

export async function saveBondPolicyDraft(input: BondPolicyDraftInput): Promise<VersionResult> {
  return (await savePolicyCallable({ ...input, requestId: input.requestId || newBondRequestId('save-policy') })).data;
}

export async function submitBondPolicyDraft(versionId: string, reason: string): Promise<VersionResult> {
  return (await submitPolicyCallable({ requestId: newBondRequestId('submit-policy'), versionId, reason })).data;
}

export async function saveBondCampaignDraft(input: BondCampaignDraftInput): Promise<VersionResult> {
  return (await saveCampaignCallable({ ...input, requestId: input.requestId || newBondRequestId('save-campaign') })).data;
}

export async function submitBondCampaignDraft(versionId: string, reason: string): Promise<VersionResult> {
  return (await submitCampaignCallable({ requestId: newBondRequestId('submit-campaign'), versionId, reason })).data;
}

export async function approveBondConfiguration(input: WorkflowRequest): Promise<VersionResult> {
  return (await approveCallable({ ...input, requestId: input.requestId || newBondRequestId('approve') })).data;
}

export async function scheduleBondConfiguration(input: WorkflowRequest): Promise<VersionResult> {
  return (await scheduleCallable({ ...input, requestId: input.requestId || newBondRequestId('schedule') })).data;
}

export async function pauseBondConfiguration(input: WorkflowRequest): Promise<VersionResult> {
  return (await pauseCallable({ ...input, requestId: input.requestId || newBondRequestId('pause') })).data;
}

export async function rollbackBondConfiguration(input: WorkflowRequest): Promise<VersionResult> {
  return (await rollbackCallable({ ...input, requestId: input.requestId || newBondRequestId('rollback') })).data;
}

export function newBondRequestId(action: string): string {
  const suffix = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `bond-${action}-${suffix}`;
}

export function splitCodes(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((entry) => entry.trim().toUpperCase()).filter(Boolean))];
}

export function earnRatePercent(basisPoints: number): string {
  return `${(Number(basisPoints || 0) / 100).toFixed(2)}%`;
}

export function formatBondMoneyPaise(paise: number): string {
  return `₹${(Number(paise || 0) / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
