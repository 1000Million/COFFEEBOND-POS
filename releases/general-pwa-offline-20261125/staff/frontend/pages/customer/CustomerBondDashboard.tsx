import { useEffect, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Circle,
  Coffee,
  Compass,
  Crown,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import CustomerHeader from '../../components/customer/CustomerHeader';
import CustomerBottomNav from '../../components/customer/CustomerBottomNav';
import {
  CustomerProfile,
  customerAuth,
  restoreCustomerProfile,
  waitForCustomerAuthRestoration,
} from '../../lib/customerAuth';
import {
  BondSummary,
  explicitBondDemoKey,
  formatBondDate,
  getCustomerBondSummary,
} from '../../lib/bondLoyalty';
import type { BondDemoState, BondDemoStateKey } from '../../lib/bondLoyaltyPreview';
import { CUSTOMER_HOME_PATH } from '../../lib/customerRoutes';

type BondPreviewModule = typeof import('@bond-preview');

const JOURNEY = [
  { name: 'First Bond', visits: 1 },
  { name: 'Familiar Face', visits: 5 },
  { name: 'Regular Rhythm', visits: 15 },
  { name: 'The 50', visits: 50 },
  { name: 'Deepening the Bond', visits: 75 },
  { name: 'The Final 25', visits: 100 },
  { name: 'THE BOND CLUB', visits: 125 },
];

const CLUB_BENEFITS = [
  'Annual Coffee Omakase for member + guest',
  'Priority reservation / waitlist access',
  'Private cuppings and member events',
  'Early menu access',
  'First access to limited bean releases',
];

function stateFromSummary(summary: BondSummary): BondDemoState {
  const visits = Number(summary.qualifyingVisitCount || 0);
  const points = Number(summary.pointsBalance || 0);
  const clubActive = summary.currentClubStatus === 'ACTIVE' || visits >= 125;
  return {
    key: clubActive ? 'club-member' : visits >= 100 ? 'near-club' : visits > 0 ? 'regular' : 'new',
    selectorLabel: '',
    memberLabel: clubActive ? 'Club member' : visits === 0 ? 'New member' : 'Member',
    points,
    visits,
    currentMilestone: summary.journey?.currentMilestone?.name || null,
    nextMilestone: summary.journey?.nextMilestone?.name || null,
    visitsToNext: summary.journey?.visitsToNextMilestone ?? null,
    clubActive,
    summary,
  };
}

function DemoSelector({ states, active, onSelect, label, note }: {
  states: BondPreviewModule['BOND_DEMO_STATES'];
  active: BondDemoStateKey;
  onSelect: (key: BondDemoStateKey) => void;
  label: string;
  note: string;
}) {
  return (
    <aside className="cb-bond-demo" aria-label={`${label} loyalty state`}>
      <div className="cb-bond-demo-heading">
        <span>{label}</span>
        <small>{note}</small>
      </div>
      <div className="cb-bond-demo-options" role="group" aria-label="Choose demo member state">
        {(Object.values(states) as BondDemoState[]).map(state => (
          <button
            key={state.key}
            type="button"
            className={state.key === active ? 'is-active' : ''}
            aria-pressed={state.key === active}
            onClick={() => onSelect(state.key)}
          >
            {state.selectorLabel}
          </button>
        ))}
      </div>
    </aside>
  );
}

function BondExperience({ state, isDemo }: { state: BondDemoState; isDemo: boolean }) {
  const visitsRemaining = Math.max(0, 125 - state.visits);
  const progress = Math.min(100, (state.visits / 125) * 100);

  return (
    <div className="cb-bond-experience">
      <section className={`cb-bond-hero${state.clubActive ? ' is-club' : ''}`}>
        <div className="cb-bond-hero-topline">
          <div>
            <p className="cb-bond-kicker">Coffee Bond</p>
            <h1>THE BOND</h1>
          </div>
          <span className="cb-bond-member-chip">{state.memberLabel}</span>
        </div>

        <div className="cb-bond-balance">
          <strong>{state.points.toLocaleString('en-IN')}</strong>
          <span>BOND POINTS</span>
        </div>

        {state.clubActive ? (
          <div className="cb-bond-club-active" aria-label="THE BOND CLUB active">
            <Crown size={20} aria-hidden="true" />
            <span>THE BOND CLUB</span>
            <strong>ACTIVE</strong>
          </div>
        ) : (
          <div className="cb-bond-progress-block">
            <div className="cb-bond-progress-meta">
              <span>Club progress</span>
              <strong>{state.visits} / 125</strong>
            </div>
            <div className="cb-bond-progress" role="progressbar" aria-valuemin={0} aria-valuemax={125} aria-valuenow={state.visits}>
              <span style={{ width: `${progress}%` }} />
            </div>
            <p>{visitsRemaining} visit{visitsRemaining === 1 ? '' : 's'} to THE BOND CLUB</p>
          </div>
        )}
      </section>

      <div className="cb-bond-layout">
        <div className="cb-bond-main-column">
          <section className="cb-bond-panel cb-bond-journey">
            <header className="cb-bond-section-heading">
              <div>
                <p className="cb-bond-kicker">Your journey</p>
                <h2>Built one cup at a time.</h2>
              </div>
              <span>{state.visits} visits</span>
            </header>
            <ol>
              {JOURNEY.map(milestone => {
                const current = state.currentMilestone === milestone.name;
                const complete = state.visits >= milestone.visits && !current;
                return (
                  <li key={milestone.name} className={current ? 'is-current' : complete ? 'is-complete' : ''}>
                    <span className="cb-bond-journey-mark" aria-hidden="true">
                      {complete ? <Check size={14} /> : current ? <span /> : <Circle size={12} />}
                    </span>
                    <div>
                      <strong>{milestone.name}</strong>
                      {current && <small>Where you are now</small>}
                    </div>
                    <span>{milestone.visits}</span>
                  </li>
                );
              })}
            </ol>
          </section>

          {isDemo && <section className="cb-bond-month">
            <header className="cb-bond-section-heading">
              <div>
                <p className="cb-bond-kicker">This month</p>
                <h2>Keep your rhythm.</h2>
              </div>
            </header>
            <div className="cb-bond-month-grid">
              <article>
                <Sparkles size={18} aria-hidden="true" />
                <p>In rhythm</p>
                <strong>2 of 3 visits</strong>
                <span>1 visit remaining</span>
                <div className="cb-bond-mini-progress"><i style={{ width: '66.66%' }} /></div>
              </article>
              <article>
                <Compass size={18} aria-hidden="true" />
                <p>Coffee compass</p>
                <strong>2 of 3 styles</strong>
                <span>Explore one more style</span>
                <div className="cb-bond-mini-progress"><i style={{ width: '66.66%' }} /></div>
              </article>
            </div>
          </section>}
        </div>

        <div className="cb-bond-side-column">
          <section className="cb-bond-next">
            <p className="cb-bond-kicker">{state.clubActive ? 'Your status' : 'Next unlock'}</p>
            <div className="cb-bond-next-icon">{state.clubActive ? <Crown size={22} /> : <ChevronRight size={22} />}</div>
            <h2>{state.clubActive ? 'THE BOND CLUB' : state.nextMilestone || 'First Bond'}</h2>
            <strong>
              {state.clubActive
                ? 'ACTIVE'
                : state.key === 'new'
                  ? 'Your first visit starts the journey'
                  : `${state.visitsToNext} visits away`}
            </strong>
          </section>

          {!isDemo && (
            <section className="cb-bond-panel p-5">
              <p className="cb-bond-kicker">Account activity</p>
              <h2 className="mt-1 text-lg font-black">Your real BOND record.</h2>
              <dl className="mt-4 space-y-3 text-sm">
                <div className="flex items-start justify-between gap-4">
                  <dt className="font-bold text-neutral-500">Last qualifying activity</dt>
                  <dd className="text-right font-black">{formatBondDate(state.summary.lastQualifyingActivityAt)}</dd>
                </div>
                <div className="flex items-start justify-between gap-4">
                  <dt className="font-bold text-neutral-500">Projected points expiry</dt>
                  <dd className="text-right font-black">{formatBondDate(state.summary.projectedPointsExpiryAt)}</dd>
                </div>
                {state.clubActive && (
                  <div className="flex items-start justify-between gap-4">
                    <dt className="font-bold text-neutral-500">Club expiry</dt>
                    <dd className="text-right font-black">{formatBondDate(state.summary.clubExpiresAt)}</dd>
                  </div>
                )}
              </dl>
            </section>
          )}

          {isDemo && <section className="cb-bond-panel cb-bond-passport">
            <p className="cb-bond-kicker">Your passport</p>
            <h2>Find your favourites.</h2>
            <ul>
              <li><span>Espresso</span><Check size={15} /></li>
              <li><span>Cold Brew</span><Check size={15} /></li>
              <li><span>Matcha</span><Circle size={13} /></li>
              <li><span>Manual Brew</span><Circle size={13} /></li>
            </ul>
          </section>}

          <section className="cb-bond-club-panel">
            <div className="cb-bond-club-title">
              <Coffee size={20} aria-hidden="true" />
              <div>
                <p className="cb-bond-kicker">125 visits unlocks</p>
                <h2>THE BOND CLUB</h2>
              </div>
            </div>
            <ul>
              {CLUB_BENEFITS.map(benefit => <li key={benefit}><Check size={13} /> <span>{benefit}</span></li>)}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

export default function CustomerBondDashboard() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [summary, setSummary] = useState<BondSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [authRestored, setAuthRestored] = useState(false);
  const [error, setError] = useState('');
  const [previewModule, setPreviewModule] = useState<BondPreviewModule | null>(null);
  const requestedDemoKey = explicitBondDemoKey(`?${searchParams.toString()}`);
  const demoRequested = Boolean(requestedDemoKey);

  useEffect(() => {
    if (!demoRequested) {
      setPreviewModule(null);
      return undefined;
    }
    let active = true;
    void import('@bond-preview').then(module => {
      if (active) setPreviewModule(module);
    });
    return () => { active = false; };
  }, [demoRequested]);

  useEffect(() => {
    if (demoRequested) {
      setProfile(null);
      setSummary(null);
      setAuthRestored(true);
      setLoading(false);
      setError('');
      return undefined;
    }
    setLoading(true);
    setAuthRestored(false);
    let active = true;
    let unsubscribe = () => {};
    waitForCustomerAuthRestoration().then(() => {
      if (!active) return;
      setAuthRestored(true);
      unsubscribe = onAuthStateChanged(customerAuth, async user => {
        if (!active) return;
        if (!user) {
          setProfile(null);
          setSummary(null);
          setLoading(false);
          return;
        }
        setLoading(true);
        try {
          const [nextProfile, nextSummary] = await Promise.all([
            restoreCustomerProfile(),
            getCustomerBondSummary(),
          ]);
          if (!active) return;
          setProfile(nextProfile);
          setSummary(nextSummary);
          setError('');
        } catch {
          if (active) setError('We could not load THE BOND right now. Please retry.');
        } finally {
          if (active) setLoading(false);
        }
      });
    }).catch(() => {
      if (!active) return;
      setAuthRestored(true);
      setLoading(false);
      setError('We could not restore your verified session.');
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [demoRequested]);

  const demoState = previewModule?.bondDemoStateFromSearch(`?${searchParams.toString()}`) || null;
  const displayState = demoRequested
    ? demoState
    : summary?.enabled
      ? stateFromSummary(summary)
      : null;

  const chooseDemoState = (key: BondDemoStateKey) => {
    const next = new URLSearchParams(searchParams);
    next.set('bondDemo', key);
    setSearchParams(next, { replace: true });
  };

  return (
    <main className="cb-app cb-bond-page cb-customer-page-bottom">
      <CustomerHeader
        title="THE BOND"
        profile={profile}
        authRestored={authRestored}
        onProfileUpdated={setProfile}
        onSignedOut={() => {
          setProfile(null);
          setSummary(null);
        }}
      />

      <div className="cb-bond-shell">
        <Link to={CUSTOMER_HOME_PATH} className="cb-bond-back">
          <ArrowLeft size={16} /> Back to ordering
        </Link>

        {demoRequested && previewModule && demoState && (
          <DemoSelector
            states={previewModule.BOND_DEMO_STATES}
            active={demoState.key}
            onSelect={chooseDemoState}
            label={previewModule.BOND_DEMO_SELECTOR_LABEL}
            note={previewModule.BOND_DEMO_SELECTOR_NOTE}
          />
        )}

        {demoRequested && !previewModule ? (
          <div className="cb-bond-state-card"><Loader2 className="animate-spin" /><p>Preparing preview...</p></div>
        ) : loading ? (
          <div className="cb-bond-state-card"><Loader2 className="animate-spin" /><p>Loading THE BOND...</p></div>
        ) : error ? (
          <p className="cb-bond-state-card is-error">{error}</p>
        ) : !demoRequested && !profile ? (
          <section className="cb-bond-state-card">
            <h2>Verify your mobile number</h2>
            <p>THE BOND uses the same verified customer account as Pay Online, My Orders and My Usual.</p>
          </section>
        ) : !displayState ? (
          <section className="cb-bond-state-card">
            <h2>THE BOND preview is not enabled</h2>
            <p>Your orders are unchanged. BOND earning will appear here only after the server-side preview flag is enabled.</p>
          </section>
        ) : (
          <BondExperience state={displayState} isDemo={demoRequested} />
        )}
      </div>

      {/* INTEGRATION ADDITION (release/customer-order-bond-20260820): Bond is now a
          bottom-navigation destination, so the bar must be present here or the tab is a
          one-way trip. Presentational only — no BOND state, callable or policy is
          touched. */}
      <CustomerBottomNav />
    </main>
  );
}
