import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  History,
  Loader2,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  Store as StoreIcon,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  approveBondConfiguration,
  BondCampaignDraftInput,
  BondCampaignRewardType,
  BondCampaignVersion,
  BondConfigurationType,
  BondDryRunResponse,
  BondGuardrails,
  BondPolicyCampaignManagerState,
  BondPolicyDraftInput,
  BondPolicyVersion,
  earnRatePercent,
  formatBondMoneyPaise,
  getBondPolicyCampaignManagerState,
  pauseBondConfiguration,
  previewBondPolicyCampaign,
  rollbackBondConfiguration,
  saveBondCampaignDraft,
  saveBondPolicyDraft,
  scheduleBondConfiguration,
  splitCodes,
  submitBondCampaignDraft,
  submitBondPolicyDraft,
} from '../../lib/bondPolicyCampaigns';

type WorkspaceMode = 'HQ_ADMIN' | 'FRANCHISE_MANAGER';
type Notice = { tone: 'success' | 'error'; message: string } | null;

type PolicyForm = {
  scope: 'GLOBAL' | 'STORE';
  storeIds: string[];
  earnPercent: string;
  startsAt: string;
  endsAt: string;
  reason: string;
  guardrails: Record<Exclude<keyof BondGuardrails, 'versionId'>, string>;
};

type CampaignForm = {
  name: string;
  storeIds: string[];
  startsAt: string;
  endsAt: string;
  rewardType: BondCampaignRewardType;
  fixedBonusPoints: string;
  multiplierPercent: string;
  minimumSpendRupees: string;
  productCodes: string;
  categoryCodes: string;
  minimumUniqueVisitDays: string;
  visitWindowDays: string;
  customerAwardLimit: string;
  budgetPoints: string;
  reason: string;
};

const EMPTY_GUARDRAILS: PolicyForm['guardrails'] = {
  minEarnRateBps: '',
  maxEarnRateBps: '',
  maxCombinedRewardRateBps: '',
  maxMultiplierBps: '',
  maxFixedBonusPoints: '',
  maxCampaignDays: '',
  maxCustomerAwards: '',
  maxCampaignBudgetPoints: '',
  liabilityPaisePerPoint: '',
};

const EMPTY_POLICY: PolicyForm = {
  scope: 'STORE',
  storeIds: [],
  earnPercent: '',
  startsAt: '',
  endsAt: '',
  reason: '',
  guardrails: EMPTY_GUARDRAILS,
};

const EMPTY_CAMPAIGN: CampaignForm = {
  name: '',
  storeIds: [],
  startsAt: '',
  endsAt: '',
  rewardType: 'FIXED_POINTS',
  fixedBonusPoints: '',
  multiplierPercent: '',
  minimumSpendRupees: '',
  productCodes: '',
  categoryCodes: '',
  minimumUniqueVisitDays: '',
  visitWindowDays: '',
  customerAwardLimit: '',
  budgetPoints: '',
  reason: '',
};

function integer(value: string): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : 0;
}

function guardrailField(value: number | null): string {
  return value == null ? '' : String(value);
}

function percentField(value: number | null): string {
  return value == null ? '' : String(value / 100);
}

function multiplierField(value: number | null): string {
  return value == null ? '' : String(value / 10_000);
}

function moneyField(value: number | null): string {
  return value == null ? '' : String(value / 100);
}

function basisPoints(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

function multiplierBasisPoints(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 10_000) : 0;
}

function paise(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

function iso(value: string): string {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

function friendlyError(error: unknown): string {
  const source = error as { message?: string };
  return String(source?.message || 'The BOND configuration request could not be completed.')
    .replace(/^FirebaseError:\s*/i, '');
}

function statusTone(status: string): string {
  if (status === 'ACTIVE') return 'bg-emerald-100 text-emerald-800';
  if (status === 'PAUSED' || status === 'ROLLED_BACK') return 'bg-red-100 text-red-800';
  if (status === 'APPROVED' || status === 'SCHEDULED') return 'bg-blue-100 text-blue-800';
  return 'bg-amber-100 text-amber-800';
}

function Card({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="bond-print-card rounded-3xl border border-[#e3d7cc] bg-white p-5 shadow-sm md:p-6">
      <div className="mb-5">
        <h2 className="text-lg font-black text-[#3e2723]">{title}</h2>
        {note && <p className="mt-1 text-sm font-medium text-neutral-500">{note}</p>}
      </div>
      {children}
    </section>
  );
}

function Field({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="text-[11px] font-black uppercase tracking-wider text-neutral-500">{label}</span>
      <div className="mt-1">{children}</div>
      {note && <span className="mt-1 block text-[11px] leading-4 text-neutral-500">{note}</span>}
    </label>
  );
}

function StoreSelector({
  stores,
  selected,
  onChange,
}: {
  stores: BondPolicyCampaignManagerState['stores'];
  selected: string[];
  onChange: (storeIds: string[]) => void;
}) {
  return (
    <div className="max-h-44 divide-y divide-neutral-100 overflow-y-auto rounded-2xl border border-neutral-200">
      {stores.length === 0 ? (
        <p className="p-3 text-sm font-bold text-neutral-400">No assigned stores are available.</p>
      ) : stores.map((store) => (
        <label key={store.id} className="flex min-h-11 items-center gap-3 px-3 py-2 text-sm font-bold">
          <input
            type="checkbox"
            checked={selected.includes(store.id)}
            onChange={() => onChange(selected.includes(store.id)
              ? selected.filter((storeId) => storeId !== store.id)
              : [...selected, store.id])}
          />
          <StoreIcon size={15} className="text-[#5c4033]" />
          <span>{store.name}</span>
          <span className="ml-auto font-mono text-[10px] text-neutral-400">{store.code}</span>
        </label>
      ))}
    </div>
  );
}

function versionTime(startsAt: string | null, endsAt: string | null): string {
  const start = startsAt ? new Date(startsAt).toLocaleString('en-IN') : 'Not scheduled';
  const end = endsAt ? new Date(endsAt).toLocaleString('en-IN') : 'No end';
  return `${start} → ${end}`;
}

export default function BondPolicyCampaignWorkspace({ mode }: { mode: WorkspaceMode }) {
  const isAdmin = mode === 'HQ_ADMIN';
  const [state, setState] = useState<BondPolicyCampaignManagerState | null>(null);
  const [policy, setPolicy] = useState<PolicyForm>({ ...EMPTY_POLICY, scope: isAdmin ? 'GLOBAL' : 'STORE' });
  const [campaign, setCampaign] = useState<CampaignForm>(EMPTY_CAMPAIGN);
  const [policyVersionId, setPolicyVersionId] = useState('');
  const [campaignVersionId, setCampaignVersionId] = useState('');
  const [dryRun, setDryRun] = useState<BondDryRunResponse | null>(null);
  const [previewSpend, setPreviewSpend] = useState('');
  const [previewMatchingSpend, setPreviewMatchingSpend] = useState('');
  const [previewStoreId, setPreviewStoreId] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState('');
  const [notice, setNotice] = useState<Notice>(null);

  const loadState = async () => {
    setLoading(true);
    try {
      const next = await getBondPolicyCampaignManagerState();
      setState(next);
      setPreviewStoreId((current) => next.stores.some((store) => store.id === current)
        ? current
        : (next.stores[0]?.id || ''));
      setPolicy((current) => ({
        ...current,
        scope: isAdmin ? current.scope : 'STORE',
        storeIds: current.storeIds.filter((storeId) => next.stores.some((store) => store.id === storeId)),
        guardrails: isAdmin ? {
          minEarnRateBps: percentField(next.guardrails.minEarnRateBps),
          maxEarnRateBps: percentField(next.guardrails.maxEarnRateBps),
          maxCombinedRewardRateBps: percentField(next.guardrails.maxCombinedRewardRateBps),
          maxMultiplierBps: multiplierField(next.guardrails.maxMultiplierBps),
          maxFixedBonusPoints: guardrailField(next.guardrails.maxFixedBonusPoints),
          maxCampaignDays: guardrailField(next.guardrails.maxCampaignDays),
          maxCustomerAwards: guardrailField(next.guardrails.maxCustomerAwards),
          maxCampaignBudgetPoints: guardrailField(next.guardrails.maxCampaignBudgetPoints),
          liabilityPaisePerPoint: moneyField(next.guardrails.liabilityPaisePerPoint),
        } : current.guardrails,
      }));
    } catch (error) {
      setNotice({ tone: 'error', message: friendlyError(error) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadState();
  }, []);

  const policyInput = useMemo<BondPolicyDraftInput>(() => ({
    scope: isAdmin ? policy.scope : 'STORE',
    storeIds: policy.scope === 'GLOBAL' ? [] : policy.storeIds,
    earnRateBps: basisPoints(policy.earnPercent),
    startsAt: iso(policy.startsAt),
    endsAt: policy.endsAt ? iso(policy.endsAt) : null,
    reason: policy.reason.trim(),
    ...(isAdmin && policy.scope === 'GLOBAL' ? {
      guardrails: {
        minEarnRateBps: basisPoints(policy.guardrails.minEarnRateBps),
        maxEarnRateBps: basisPoints(policy.guardrails.maxEarnRateBps),
        maxCombinedRewardRateBps: basisPoints(policy.guardrails.maxCombinedRewardRateBps),
        maxMultiplierBps: multiplierBasisPoints(policy.guardrails.maxMultiplierBps),
        maxFixedBonusPoints: integer(policy.guardrails.maxFixedBonusPoints),
        maxCampaignDays: integer(policy.guardrails.maxCampaignDays),
        maxCustomerAwards: integer(policy.guardrails.maxCustomerAwards),
        maxCampaignBudgetPoints: integer(policy.guardrails.maxCampaignBudgetPoints),
        liabilityPaisePerPoint: paise(policy.guardrails.liabilityPaisePerPoint),
      },
    } : {}),
  }), [isAdmin, policy]);

  const campaignInput = useMemo<BondCampaignDraftInput>(() => ({
    name: campaign.name.trim(),
    storeIds: campaign.storeIds,
    startsAt: iso(campaign.startsAt),
    endsAt: iso(campaign.endsAt),
    rewardType: campaign.rewardType,
    fixedBonusPoints: campaign.rewardType === 'FIXED_POINTS' ? integer(campaign.fixedBonusPoints) : null,
    multiplierBps: campaign.rewardType === 'EARN_MULTIPLIER' ? multiplierBasisPoints(campaign.multiplierPercent) : null,
    minimumSpendPaise: paise(campaign.minimumSpendRupees),
    eligibleProductCodes: splitCodes(campaign.productCodes),
    eligibleCategoryCodes: splitCodes(campaign.categoryCodes),
    minimumUniqueVisitDays: integer(campaign.minimumUniqueVisitDays),
    visitWindowDays: integer(campaign.visitWindowDays),
    customerAwardLimit: integer(campaign.customerAwardLimit),
    budgetPoints: integer(campaign.budgetPoints),
    stackingMode: 'EXCLUSIVE_ONE',
    reason: campaign.reason.trim(),
  }), [campaign]);

  const previewStores = useMemo(() => (state?.stores || []).filter((store) => {
    const policyAllowsStore = policy.earnPercent.trim() === ''
      || policy.scope === 'GLOBAL'
      || policy.storeIds.includes(store.id);
    const campaignAllowsStore = campaign.name.trim() === ''
      || campaign.storeIds.includes(store.id);
    return policyAllowsStore && campaignAllowsStore;
  }), [campaign.name, campaign.storeIds, policy.earnPercent, policy.scope, policy.storeIds, state?.stores]);

  const run = async (key: string, operation: () => Promise<unknown>, success: string) => {
    setWorking(key);
    setNotice(null);
    try {
      await operation();
      setNotice({ tone: 'success', message: success });
      await loadState();
    } catch (error) {
      setNotice({ tone: 'error', message: friendlyError(error) });
    } finally {
      setWorking('');
    }
  };

  const savePolicy = async () => {
    if (isAdmin && policy.scope === 'GLOBAL'
      && Object.values(policy.guardrails).some((value) => value.trim() === '')) {
      setNotice({ tone: 'error', message: 'Complete every HQ guardrail field before saving a global policy version.' });
      return;
    }
    setWorking('save-policy');
    setNotice(null);
    try {
      const result = await saveBondPolicyDraft(policyInput);
      setPolicyVersionId(result.versionId);
      setNotice({ tone: 'success', message: `Immutable policy version ${result.versionId} saved as Draft.` });
      await loadState();
    } catch (error) {
      setNotice({ tone: 'error', message: friendlyError(error) });
    } finally {
      setWorking('');
    }
  };

  const saveCampaign = async () => {
    setWorking('save-campaign');
    setNotice(null);
    try {
      const result = await saveBondCampaignDraft(campaignInput);
      setCampaignVersionId(result.versionId);
      setNotice({ tone: 'success', message: `Immutable campaign version ${result.versionId} saved as Draft.` });
      await loadState();
    } catch (error) {
      setNotice({ tone: 'error', message: friendlyError(error) });
    } finally {
      setWorking('');
    }
  };

  const preview = async () => {
    const includePolicy = policy.earnPercent.trim() !== '';
    const includeCampaign = campaign.name.trim() !== '';
    if (!includePolicy && !includeCampaign) {
      setNotice({ tone: 'error', message: 'Enter a candidate policy rate or campaign before running a dry-run.' });
      return;
    }
    const storeId = previewStores.some((store) => store.id === previewStoreId)
      ? previewStoreId
      : (previewStores[0]?.id || '');
    if (!storeId) {
      setNotice({ tone: 'error', message: 'Select one store covered by every candidate configuration before running a dry-run.' });
      return;
    }
    setWorking('preview');
    setNotice(null);
    try {
      const result = await previewBondPolicyCampaign({
        storeId,
        eligibleSpendPaise: paise(previewSpend),
        matchingEligibleSpendPaise: previewMatchingSpend.trim()
          ? paise(previewMatchingSpend)
          : paise(previewSpend),
        productCodes: splitCodes(campaign.productCodes),
        categoryCodes: splitCodes(campaign.categoryCodes),
        ...(includePolicy ? { policyDraft: policyInput } : {}),
        ...(includeCampaign ? { campaignDraft: campaignInput } : {}),
      });
      setDryRun(result);
      setNotice({ tone: 'success', message: 'Dry-run complete. No points, budgets, schedules, or ledger entries were changed.' });
    } catch (error) {
      setDryRun(null);
      setNotice({ tone: 'error', message: friendlyError(error) });
    } finally {
      setWorking('');
    }
  };

  const workflow = async (
    action: 'APPROVE' | 'SCHEDULE' | 'PAUSE' | 'ROLLBACK',
    type: BondConfigurationType,
    version: BondPolicyVersion | BondCampaignVersion,
  ) => {
    const reason = window.prompt(`${action.replace('_', ' ')} reason (recorded in the immutable audit):`, '')?.trim();
    if (!reason) return;
    let scheduleWindow: { startsAt?: string; endsAt?: string | null } = {};
    if (action === 'SCHEDULE') {
      const approvedStartMillis = Date.parse(version.startsAt || '');
      const suggestedStart = Number.isFinite(approvedStartMillis) && approvedStartMillis > Date.now()
        ? new Date(approvedStartMillis).toISOString()
        : new Date(Date.now() + 5 * 60_000).toISOString();
      const startValue = window.prompt(
        'Activation start (ISO timestamp, inside the approved window):',
        suggestedStart,
      )?.trim();
      if (!startValue) return;
      const startMillis = Date.parse(startValue);
      if (!Number.isFinite(startMillis)) {
        setNotice({ tone: 'error', message: 'Enter a valid activation start timestamp.' });
        return;
      }
      const endValue = window.prompt(
        'Activation end (ISO timestamp; leave blank only for an open-ended policy):',
        version.endsAt || '',
      );
      if (endValue === null) return;
      const trimmedEnd = endValue.trim();
      if (trimmedEnd && !Number.isFinite(Date.parse(trimmedEnd))) {
        setNotice({ tone: 'error', message: 'Enter a valid activation end timestamp.' });
        return;
      }
      scheduleWindow = {
        startsAt: new Date(startMillis).toISOString(),
        endsAt: trimmedEnd ? new Date(Date.parse(trimmedEnd)).toISOString() : null,
      };
    }
    let rollbackEnd: string | null | undefined;
    if (action === 'ROLLBACK') {
      const approvedEndMillis = Date.parse(version.approvedEndsAt || '');
      if (Number.isFinite(approvedEndMillis) && approvedEndMillis <= Date.now()) {
        setNotice({ tone: 'error', message: 'This immutable version has no remaining approved activation window to roll back into.' });
        return;
      }
      const endValue = window.prompt(
        'Rollback end (ISO timestamp inside the original approved window; blank only for an open-ended policy):',
        version.approvedEndsAt || '',
      );
      if (endValue === null) return;
      const trimmedEnd = endValue.trim();
      if (trimmedEnd && !Number.isFinite(Date.parse(trimmedEnd))) {
        setNotice({ tone: 'error', message: 'Enter a valid rollback end timestamp.' });
        return;
      }
      rollbackEnd = trimmedEnd ? new Date(Date.parse(trimmedEnd)).toISOString() : null;
    }
    const input = {
      configurationType: type,
      versionId: version.versionId,
      ...(action === 'PAUSE' ? { scheduleId: version.scheduleId || undefined } : {}),
      ...(action === 'SCHEDULE' ? scheduleWindow : {}),
      ...(action === 'ROLLBACK' ? { endsAt: rollbackEnd } : {}),
      reason,
    };
    if (action === 'APPROVE') return run(`approve-${version.versionId}`, () => approveBondConfiguration(input), 'Configuration approved by HQ Admin.');
    if (action === 'SCHEDULE') return run(`schedule-${version.versionId}`, () => scheduleBondConfiguration(input), 'Approved configuration scheduled.');
    if (action === 'PAUSE') return run(`pause-${version.versionId}`, () => pauseBondConfiguration(input), 'Configuration paused. Future rewards will not use it.');
    return run(`rollback-${version.versionId}`, () => rollbackBondConfiguration(input), 'Rollback recorded as a new audited activation.');
  };

  const submitPersistedDraft = async (
    type: BondConfigurationType,
    version: BondPolicyVersion | BondCampaignVersion,
  ) => {
    const reason = window.prompt('Submission reason (recorded in the immutable audit):', '')?.trim();
    if (!reason) return;
    return run(
      `submit-${version.versionId}`,
      () => type === 'POLICY'
        ? submitBondPolicyDraft(version.versionId, reason)
        : submitBondCampaignDraft(version.versionId, reason),
      'Configuration submitted for HQ approval.',
    );
  };

  const configurations = useMemo(() => [
    ...((state?.globalPolicies?.length ? state.globalPolicies : state?.globalPolicy ? [state.globalPolicy] : []))
      .map((value) => ({ type: 'POLICY' as const, value })),
    ...(state?.storePolicies || []).map((value) => ({ type: 'POLICY' as const, value })),
    ...(state?.campaigns || []).map((value) => ({ type: 'CAMPAIGN' as const, value })),
  ], [state]);

  const weeklyCampaign = useMemo(() => (state?.campaigns || [])
    .filter((entry) => (
      entry.minimumUniqueVisitDays === 3
      && entry.visitWindowDays === 7
      && entry.minimumSpendPaise === 15_000
      && entry.rewardType === 'FIXED_POINTS'
      && entry.fixedBonusPoints === 25
      && entry.customerAwardLimit === 1
    ))
    .sort((left, right) => {
      const rank = (status: string) => (status === 'ACTIVE' ? 0 : status === 'SCHEDULED' ? 1 : 2);
      return rank(left.status) - rank(right.status)
        || (Date.parse(right.startsAt || '') || 0) - (Date.parse(left.startsAt || '') || 0);
    })[0] || null, [state?.campaigns]);

  if (loading && !state) {
    return <div className="flex min-h-[50vh] items-center justify-center gap-2 font-bold text-neutral-500"><Loader2 className="animate-spin" /> Loading BOND controls…</div>;
  }

  return (
    <div className="bond-policy-manager mx-auto w-full max-w-7xl space-y-6 pb-20">
      <header className="bond-print-card flex flex-col gap-4 rounded-3xl bg-[#3e2723] p-6 text-white md:flex-row md:items-end md:justify-between">
        <div>
          <Link to={isAdmin ? '/admin' : '/'} className="mb-4 inline-flex items-center gap-1 text-xs font-black uppercase tracking-wider text-white/70">
            <ArrowLeft size={14} /> Back
          </Link>
          <p className="text-xs font-black uppercase tracking-[0.2em] text-amber-300">BOND governance</p>
          <h1 className="mt-1 text-3xl font-black">Policy & Campaign Manager</h1>
          <p className="mt-2 max-w-2xl text-sm font-medium text-white/70">
            Versioned, approval-gated customer-ordering rewards. Native POS remains excluded.
          </p>
        </div>
        <button onClick={() => void loadState()} className="bond-print-controls inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-white/10 px-4 text-sm font-black hover:bg-white/15">
          <RefreshCw size={16} /> Refresh
        </button>
      </header>

      {notice && (
        <div role="status" className={`flex items-start gap-2 rounded-2xl border p-4 text-sm font-bold ${
          notice.tone === 'error' ? 'border-red-200 bg-red-50 text-red-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'
        }`}>
          {notice.tone === 'error' ? <AlertCircle size={19} className="shrink-0" /> : <CheckCircle2 size={19} className="shrink-0" />}
          {notice.message}
        </div>
      )}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-emerald-700">Effective global earn</p>
          <p className="mt-2 text-2xl font-black text-emerald-950">{state?.globalPolicy ? earnRatePercent(state.globalPolicy.earnRateBps) : 'Legacy fallback'}</p>
          <p className="mt-1 text-xs font-bold text-emerald-700">Version {state?.globalPolicy?.versionId || 'BOND_POLICY_V1_2026'}</p>
        </div>
        <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-blue-700">Assigned scope</p>
          <p className="mt-2 text-2xl font-black text-blue-950">{state?.stores.length || 0} store{state?.stores.length === 1 ? '' : 's'}</p>
          <p className="mt-1 text-xs font-bold text-blue-700">{isAdmin ? 'HQ all-store authority' : 'Profile-assigned stores only'}</p>
        </div>
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-red-700">Points redemption</p>
          <p className="mt-2 text-2xl font-black text-red-950">OFF</p>
          <p className="mt-1 text-xs font-bold text-red-700">Read-only · not controlled here</p>
        </div>
        <div className="rounded-2xl border border-neutral-200 bg-white p-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-neutral-500">Campaign stacking</p>
          <p className="mt-2 text-2xl font-black text-neutral-900">EXCLUSIVE</p>
          <p className="mt-1 text-xs font-bold text-neutral-500">At most one campaign per order</p>
        </div>
      </section>

      {weeklyCampaign && (
        <section className="bond-print-card rounded-3xl border border-amber-300 bg-amber-50 p-5 text-[#3e2723] shadow-sm">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-700">Weekly Noida 29 campaign</p>
          <h2 className="mt-2 text-xl font-black">3 unique qualifying visit days · ₹150 minimum per visit</h2>
          <p className="mt-2 text-sm font-bold text-amber-950">Monday–Sunday IST · +25 points · maximum once per customer per week.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl bg-white/80 p-3"><p className="text-[10px] font-black uppercase tracking-wider text-neutral-500">Budget used</p><p className="mt-1 text-xl font-black">{weeklyCampaign.issuedPoints || 0} points</p></div>
            <div className="rounded-2xl bg-white/80 p-3"><p className="text-[10px] font-black uppercase tracking-wider text-neutral-500">Budget remaining</p><p className="mt-1 text-xl font-black">{Math.max(0, weeklyCampaign.budgetPoints - (weeklyCampaign.issuedPoints || 0))} points</p></div>
            <div className="rounded-2xl bg-white/80 p-3"><p className="text-[10px] font-black uppercase tracking-wider text-neutral-500">Combined reward ceiling</p><p className="mt-1 text-xl font-black">{earnRatePercent(state?.guardrails.maxCombinedRewardRateBps || 0)}</p></div>
          </div>
        </section>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Earn policy" note={isAdmin ? 'Create a global default or store override. Global versions include HQ guardrails.' : 'Franchise Managers may propose overrides only for assigned stores.'}>
          <div className="grid gap-4 sm:grid-cols-2">
            {isAdmin && <Field label="Scope">
              <select value={policy.scope} onChange={(event) => setPolicy({ ...policy, scope: event.target.value as PolicyForm['scope'], storeIds: [] })} className="h-11 w-full rounded-xl border border-neutral-200 bg-white px-3 text-sm font-bold">
                <option value="GLOBAL">Global default + guardrails</option>
                <option value="STORE">Per-store override</option>
              </select>
            </Field>}
            <Field label="Earn percentage" note="Calculated on eligible pre-GST spend. Store and franchise rates must stay between the HQ minimum and maximum.">
              <input type="number" min="0" step="0.01" value={policy.earnPercent} onChange={(event) => setPolicy({ ...policy, earnPercent: event.target.value })} className="h-11 w-full rounded-xl border border-neutral-200 px-3 text-sm" placeholder="Percent" />
            </Field>
            <Field label="Starts at"><input type="datetime-local" value={policy.startsAt} onChange={(event) => setPolicy({ ...policy, startsAt: event.target.value })} className="h-11 w-full rounded-xl border border-neutral-200 px-3 text-sm" /></Field>
            <Field label="Ends at" note="Optional for the base policy."><input type="datetime-local" value={policy.endsAt} onChange={(event) => setPolicy({ ...policy, endsAt: event.target.value })} className="h-11 w-full rounded-xl border border-neutral-200 px-3 text-sm" /></Field>
          </div>
          {policy.scope === 'STORE' && <div className="mt-4"><p className="mb-2 text-[11px] font-black uppercase tracking-wider text-neutral-500">Selected stores</p><StoreSelector stores={state?.stores || []} selected={policy.storeIds} onChange={(storeIds) => setPolicy({ ...policy, storeIds })} /></div>}

          {isAdmin && policy.scope === 'GLOBAL' && (
            <div className="mt-5 rounded-2xl border border-blue-200 bg-blue-50/60 p-4">
              <div className="mb-3 flex items-center gap-2"><ShieldCheck size={17} className="text-blue-700" /><h3 className="font-black text-blue-950">HQ guardrail version</h3></div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Minimum store/franchise earn (%)"><input type="number" min="0" step="0.01" value={policy.guardrails.minEarnRateBps} onChange={(event) => setPolicy({ ...policy, guardrails: { ...policy.guardrails, minEarnRateBps: event.target.value } })} className="h-10 w-full rounded-xl border border-blue-200 bg-white px-3 text-sm" /></Field>
                <Field label="Maximum store/franchise earn (%)"><input type="number" min="0" step="0.01" value={policy.guardrails.maxEarnRateBps} onChange={(event) => setPolicy({ ...policy, guardrails: { ...policy.guardrails, maxEarnRateBps: event.target.value } })} className="h-10 w-full rounded-xl border border-blue-200 bg-white px-3 text-sm" /></Field>
                <Field label="Maximum combined base + campaign reward (%)"><input type="number" min="0" step="0.01" value={policy.guardrails.maxCombinedRewardRateBps} onChange={(event) => setPolicy({ ...policy, guardrails: { ...policy.guardrails, maxCombinedRewardRateBps: event.target.value } })} className="h-10 w-full rounded-xl border border-blue-200 bg-white px-3 text-sm" /></Field>
                <Field label="Maximum campaign multiplier (×)"><input type="number" min="1" step="0.01" value={policy.guardrails.maxMultiplierBps} onChange={(event) => setPolicy({ ...policy, guardrails: { ...policy.guardrails, maxMultiplierBps: event.target.value } })} className="h-10 w-full rounded-xl border border-blue-200 bg-white px-3 text-sm" /></Field>
                <Field label="Maximum fixed points"><input type="number" min="0" step="1" value={policy.guardrails.maxFixedBonusPoints} onChange={(event) => setPolicy({ ...policy, guardrails: { ...policy.guardrails, maxFixedBonusPoints: event.target.value } })} className="h-10 w-full rounded-xl border border-blue-200 bg-white px-3 text-sm" /></Field>
                <Field label="Maximum campaign days"><input type="number" min="1" step="1" value={policy.guardrails.maxCampaignDays} onChange={(event) => setPolicy({ ...policy, guardrails: { ...policy.guardrails, maxCampaignDays: event.target.value } })} className="h-10 w-full rounded-xl border border-blue-200 bg-white px-3 text-sm" /></Field>
                <Field label="Maximum awards per customer (per campaign)" note="This limit resets only with a new approved campaign version."><input type="number" min="1" step="1" value={policy.guardrails.maxCustomerAwards} onChange={(event) => setPolicy({ ...policy, guardrails: { ...policy.guardrails, maxCustomerAwards: event.target.value } })} className="h-10 w-full rounded-xl border border-blue-200 bg-white px-3 text-sm" /></Field>
                <Field label="Maximum campaign budget (points)"><input type="number" min="1" step="1" value={policy.guardrails.maxCampaignBudgetPoints} onChange={(event) => setPolicy({ ...policy, guardrails: { ...policy.guardrails, maxCampaignBudgetPoints: event.target.value } })} className="h-10 w-full rounded-xl border border-blue-200 bg-white px-3 text-sm" /></Field>
                <Field label="Store liability (₹ per point)"><input type="number" min="0.01" step="0.01" value={policy.guardrails.liabilityPaisePerPoint} onChange={(event) => setPolicy({ ...policy, guardrails: { ...policy.guardrails, liabilityPaisePerPoint: event.target.value } })} className="h-10 w-full rounded-xl border border-blue-200 bg-white px-3 text-sm" /></Field>
              </div>
              <p className="mt-3 text-xs font-bold text-blue-700">Guardrails are versioned with the global policy and must be approved before activation.</p>
            </div>
          )}

          <Field label="Business reason"><textarea value={policy.reason} onChange={(event) => setPolicy({ ...policy, reason: event.target.value })} maxLength={300} className="mt-4 min-h-20 w-full rounded-xl border border-neutral-200 p-3 text-sm" placeholder="Required audit reason" /></Field>
          <div className="mt-4 flex flex-wrap gap-2">
            <button onClick={() => void savePolicy()} disabled={Boolean(working)} className="inline-flex h-10 items-center gap-2 rounded-xl bg-[#5c4033] px-4 text-sm font-black text-white disabled:opacity-40"><Save size={16} /> Save immutable version</button>
            <button onClick={() => void run('submit-policy', () => submitBondPolicyDraft(policyVersionId, policy.reason), 'Policy submitted for HQ approval.')} disabled={!policyVersionId || Boolean(working)} className="inline-flex h-10 items-center gap-2 rounded-xl border border-[#5c4033] px-4 text-sm font-black text-[#5c4033] disabled:opacity-40"><ClipboardCheck size={16} /> Submit</button>
          </div>
        </Card>

        <Card title="Campaign" note="A scheduled campaign awards either fixed bonus points or an earn multiplier—never both.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Campaign name"><input value={campaign.name} onChange={(event) => setCampaign({ ...campaign, name: event.target.value })} maxLength={80} className="h-11 w-full rounded-xl border border-neutral-200 px-3 text-sm" /></Field>
            <Field label="Reward type">
              <select value={campaign.rewardType} onChange={(event) => setCampaign({ ...campaign, rewardType: event.target.value as BondCampaignRewardType })} className="h-11 w-full rounded-xl border border-neutral-200 bg-white px-3 text-sm font-bold">
                <option value="FIXED_POINTS">Fixed bonus points</option>
                <option value="EARN_MULTIPLIER">Earn multiplier</option>
              </select>
            </Field>
            {campaign.rewardType === 'FIXED_POINTS' ? (
              <Field label="Fixed bonus points"><input type="number" min="0" step="1" value={campaign.fixedBonusPoints} onChange={(event) => setCampaign({ ...campaign, fixedBonusPoints: event.target.value, multiplierPercent: '' })} className="h-11 w-full rounded-xl border border-neutral-200 px-3 text-sm" /></Field>
            ) : (
              <Field label="Total earn multiplier (×)" note="Enter 2 for a 2× reward."><input type="number" min="1" step="0.01" value={campaign.multiplierPercent} onChange={(event) => setCampaign({ ...campaign, multiplierPercent: event.target.value, fixedBonusPoints: '' })} className="h-11 w-full rounded-xl border border-neutral-200 px-3 text-sm" placeholder="Multiplier" /></Field>
            )}
            <Field label="Minimum eligible spend"><input type="number" min="0" step="0.01" value={campaign.minimumSpendRupees} onChange={(event) => setCampaign({ ...campaign, minimumSpendRupees: event.target.value })} className="h-11 w-full rounded-xl border border-neutral-200 px-3 text-sm" placeholder="₹" /></Field>
            <Field label="Starts at"><input type="datetime-local" value={campaign.startsAt} onChange={(event) => setCampaign({ ...campaign, startsAt: event.target.value })} className="h-11 w-full rounded-xl border border-neutral-200 px-3 text-sm" /></Field>
            <Field label="Ends at"><input type="datetime-local" value={campaign.endsAt} onChange={(event) => setCampaign({ ...campaign, endsAt: event.target.value })} className="h-11 w-full rounded-xl border border-neutral-200 px-3 text-sm" /></Field>
            <Field label="Unique IST visit days" note="Completed qualifying days before this order, within the campaign window; repeat orders on one IST day count once."><input type="number" min="0" step="1" value={campaign.minimumUniqueVisitDays} onChange={(event) => setCampaign({ ...campaign, minimumUniqueVisitDays: event.target.value })} className="h-11 w-full rounded-xl border border-neutral-200 px-3 text-sm" /></Field>
            <Field label="Visit lookback days"><input type="number" min="0" step="1" value={campaign.visitWindowDays} onChange={(event) => setCampaign({ ...campaign, visitWindowDays: event.target.value })} className="h-11 w-full rounded-xl border border-neutral-200 px-3 text-sm" /></Field>
            <Field label="Maximum awards per customer for this campaign" note="Campaign-specific; it does not change limits for any other campaign."><input type="number" min="0" step="1" value={campaign.customerAwardLimit} onChange={(event) => setCampaign({ ...campaign, customerAwardLimit: event.target.value })} className="h-11 w-full rounded-xl border border-neutral-200 px-3 text-sm" /></Field>
            <Field label="Campaign budget (points)"><input type="number" min="0" step="1" value={campaign.budgetPoints} onChange={(event) => setCampaign({ ...campaign, budgetPoints: event.target.value })} className="h-11 w-full rounded-xl border border-neutral-200 px-3 text-sm" /></Field>
          </div>
          <div className="mt-4"><p className="mb-2 text-[11px] font-black uppercase tracking-wider text-neutral-500">Selected stores</p><StoreSelector stores={state?.stores || []} selected={campaign.storeIds} onChange={(storeIds) => setCampaign({ ...campaign, storeIds })} /></div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Eligible product codes" note="Comma or line separated; blank means all products."><textarea value={campaign.productCodes} onChange={(event) => setCampaign({ ...campaign, productCodes: event.target.value })} className="min-h-20 w-full rounded-xl border border-neutral-200 p-3 font-mono text-xs" /></Field>
            <Field label="Eligible category codes" note="Comma or line separated; blank means all categories."><textarea value={campaign.categoryCodes} onChange={(event) => setCampaign({ ...campaign, categoryCodes: event.target.value })} className="min-h-20 w-full rounded-xl border border-neutral-200 p-3 font-mono text-xs" /></Field>
          </div>
          <div className="mt-4 flex items-center justify-between rounded-xl bg-neutral-100 px-3 py-2 text-xs font-black text-neutral-700"><span>Stacking mode</span><span>EXCLUSIVE_ONE</span></div>
          <Field label="Business reason"><textarea value={campaign.reason} onChange={(event) => setCampaign({ ...campaign, reason: event.target.value })} maxLength={300} className="mt-4 min-h-20 w-full rounded-xl border border-neutral-200 p-3 text-sm" placeholder="Required audit reason" /></Field>
          <div className="mt-4 flex flex-wrap gap-2">
            <button onClick={() => void saveCampaign()} disabled={Boolean(working)} className="inline-flex h-10 items-center gap-2 rounded-xl bg-[#5c4033] px-4 text-sm font-black text-white disabled:opacity-40"><Save size={16} /> Save immutable version</button>
            <button onClick={() => void run('submit-campaign', () => submitBondCampaignDraft(campaignVersionId, campaign.reason), 'Campaign submitted for HQ approval.')} disabled={!campaignVersionId || Boolean(working)} className="inline-flex h-10 items-center gap-2 rounded-xl border border-[#5c4033] px-4 text-sm font-black text-[#5c4033] disabled:opacity-40"><ClipboardCheck size={16} /> Submit</button>
          </div>
        </Card>
      </div>

      <Card title="Preview / dry-run" note="Server-canonical reward and store-liability forecast. This action performs zero writes.">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-[220px_220px_260px_auto] xl:items-end">
          <Field label="Example eligible pre-GST spend"><input type="number" min="0" step="0.01" value={previewSpend} onChange={(event) => setPreviewSpend(event.target.value)} className="h-11 w-full rounded-xl border border-neutral-200 px-3 text-sm" placeholder="₹" /></Field>
          <Field label="Campaign-matching spend" note="Use this to model a mixed basket; blank means the full eligible spend matches."><input type="number" min="0" step="0.01" value={previewMatchingSpend} onChange={(event) => setPreviewMatchingSpend(event.target.value)} className="h-11 w-full rounded-xl border border-neutral-200 px-3 text-sm" placeholder="₹" /></Field>
          <Field label="Preview store" note="Required for store-rate and liability parity.">
            <select value={previewStores.some((store) => store.id === previewStoreId) ? previewStoreId : (previewStores[0]?.id || '')} onChange={(event) => setPreviewStoreId(event.target.value)} className="h-11 w-full rounded-xl border border-neutral-200 bg-white px-3 text-sm font-bold">
              {previewStores.length === 0 && <option value="">No common selected store</option>}
              {previewStores.map((store) => <option key={store.id} value={store.id}>{store.name} · {store.code}</option>)}
            </select>
          </Field>
          <button onClick={() => void preview()} disabled={Boolean(working)} className="inline-flex h-11 w-fit items-center gap-2 rounded-xl bg-blue-700 px-5 text-sm font-black text-white disabled:opacity-40">{working === 'preview' ? <Loader2 size={17} className="animate-spin" /> : <Sparkles size={17} />} Preview customer reward & liability</button>
        </div>
        {dryRun && (
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-2xl bg-emerald-50 p-4"><p className="text-[10px] font-black uppercase tracking-widest text-emerald-700">Customer reward</p><p className="mt-2 text-2xl font-black text-emerald-950">{dryRun.totalRewardPoints} points</p><p className="text-xs font-bold text-emerald-700">{dryRun.basePoints} base + {dryRun.campaignPoints} campaign</p><p className="mt-1 text-[11px] font-bold text-emerald-700">Combined cap {earnRatePercent(dryRun.maxCombinedRewardRateBps)}{dryRun.combinedRewardCapApplied ? ' · cap applied' : ''}</p></div>
            <div className="rounded-2xl bg-blue-50 p-4"><p className="text-[10px] font-black uppercase tracking-widest text-blue-700">Store liability</p><p className="mt-2 text-2xl font-black text-blue-950">{formatBondMoneyPaise(dryRun.storeLiabilityPaise)}</p><p className="text-xs font-bold text-blue-700">Accounting forecast, not redemption</p></div>
            <div className="rounded-2xl bg-amber-50 p-4"><p className="text-[10px] font-black uppercase tracking-widest text-amber-700">Campaign maximum</p><p className="mt-2 text-2xl font-black text-amber-950">{formatBondMoneyPaise(dryRun.maximumCampaignLiabilityPaise)}</p><p className="text-xs font-bold text-amber-700">Budget-backed liability</p></div>
            <div className="rounded-2xl bg-neutral-100 p-4"><p className="text-[10px] font-black uppercase tracking-widest text-neutral-500">Dry-run writes</p><p className="mt-2 text-2xl font-black text-neutral-900">{dryRun.writesPerformed}</p><p className="text-xs font-bold text-neutral-500">Store {dryRun.previewStoreId} · must remain zero</p></div>
            {[...dryRun.validationErrors, ...dryRun.conflicts, ...dryRun.warnings].length > 0 && <div className="sm:col-span-2 lg:col-span-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-bold text-amber-900"><ul className="list-disc space-y-1 pl-5">{[...dryRun.validationErrors, ...dryRun.conflicts, ...dryRun.warnings].map((message) => <li key={message}>{message}</li>)}</ul></div>}
          </div>
        )}
      </Card>

      <Card title="Approval, schedule, pause & rollback" note="HQ approval is mandatory. Franchise Managers can pause only assigned-store configurations.">
        {configurations.length === 0 ? <p className="text-sm font-bold text-neutral-400">No policy or campaign versions returned.</p> : (
          <div className="space-y-3">
            {configurations.map(({ type, value }) => (
              <article key={`${type}-${value.versionId}`} className="bond-print-row rounded-2xl border border-neutral-200 p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-black uppercase tracking-wider text-neutral-400">{type}</span>
                      <span className={`rounded-full px-2 py-1 text-[10px] font-black ${statusTone(value.status)}`}>{value.status}</span>
                      <strong className="truncate font-mono text-xs text-neutral-700">{value.versionId}</strong>
                    </div>
                    <p className="mt-2 text-sm font-black text-neutral-900">{'name' in value ? value.name : `${value.scope} ${earnRatePercent(value.earnRateBps)}`}</p>
                    <p className="mt-1 text-xs font-bold text-neutral-500">{versionTime(value.startsAt, value.endsAt)} · {value.storeIds.length ? `${value.storeIds.length} store(s)` : 'Global'}</p>
                    {'budgetPoints' in value && <p className="mt-1 text-xs font-black text-amber-700">Campaign budget: {value.issuedPoints || 0} used · {Math.max(0, value.budgetPoints - (value.issuedPoints || 0))} remaining of {value.budgetPoints} points</p>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {value.status === 'DRAFT' && <button onClick={() => void submitPersistedDraft(type, value)} disabled={Boolean(working)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#5c4033] px-3 text-xs font-black text-[#5c4033]"><ClipboardCheck size={14} /> Submit</button>}
                    {isAdmin && value.status === 'PENDING_APPROVAL' && <button onClick={() => void workflow('APPROVE', type, value)} disabled={Boolean(working)} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-700 px-3 text-xs font-black text-white"><ShieldCheck size={14} /> Approve</button>}
                    {isAdmin && value.status === 'APPROVED' && <button onClick={() => void workflow('SCHEDULE', type, value)} disabled={Boolean(working)} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-700 px-3 text-xs font-black text-white"><CalendarClock size={14} /> Schedule</button>}
                    {['ACTIVE', 'SCHEDULED'].includes(value.status)
                      && (isAdmin || (state?.canPause && (!('scope' in value) || value.scope !== 'GLOBAL')))
                      && <button onClick={() => void workflow('PAUSE', type, value)} disabled={Boolean(working)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-red-200 px-3 text-xs font-black text-red-700"><PauseCircle size={14} /> Pause</button>}
                    {isAdmin
                      && ['PAUSED', 'ROLLED_BACK', 'SUPERSEDED'].includes(value.status)
                      && (value.approvedEndsAt === null || Date.parse(value.approvedEndsAt) > Date.now())
                      && <button onClick={() => void workflow('ROLLBACK', type, value)} disabled={Boolean(working)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-neutral-200 px-3 text-xs font-black"><RotateCcw size={14} /> Roll back to this version</button>}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </Card>

      <Card title="Immutable audit history" note="Every save, submission, approval, schedule, pause, and rollback is server-authored.">
        {!state?.auditHistory.length ? <p className="text-sm font-bold text-neutral-400">No audit entries returned for this scope.</p> : (
          <div className="space-y-2">
            {state.auditHistory.map((entry) => (
              <div key={entry.auditId} className="bond-print-row flex flex-col gap-2 rounded-xl border border-neutral-100 bg-neutral-50 p-3 sm:flex-row sm:items-start">
                <History size={16} className="mt-0.5 shrink-0 text-[#5c4033]" />
                <div className="min-w-0 flex-1"><p className="text-sm font-black text-neutral-900">{entry.action} · {entry.entityType}</p><p className="mt-0.5 text-xs font-bold text-neutral-500">{entry.actorName} ({entry.actorRole}) · {entry.storeIds.length ? `${entry.storeIds.length} store(s)` : 'Global'} · {entry.createdAt ? new Date(entry.createdAt).toLocaleString('en-IN') : 'Pending timestamp'}</p>{entry.reason && <p className="mt-1 text-xs text-neutral-600">{entry.reason}</p>}</div>
                {entry.versionId && <code className="truncate text-[10px] text-neutral-400">{entry.versionId}</code>}
              </div>
            ))}
          </div>
        )}
      </Card>

      <aside className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-bold text-amber-900">
        <div className="flex items-start gap-2"><PlayCircle size={18} className="mt-0.5 shrink-0" /><p>Activation changes only approved customer-ordering earn policy. Production redemption remains OFF; native POS loyalty remains excluded.</p></div>
      </aside>
    </div>
  );
}
