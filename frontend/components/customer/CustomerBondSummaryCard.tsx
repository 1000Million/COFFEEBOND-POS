import type { CSSProperties } from 'react';
import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { BondDemoQueryKey, BondSummary } from '../../lib/bondLoyalty';
import { CUSTOMER_BOND_PATH } from '../../lib/customerRoutes';

type Props = {
  summary?: BondSummary | null;
  state?: 'READY' | 'UNAVAILABLE' | 'LOADING' | 'SIGNED_OUT' | 'HIDDEN';
  demoStateKey?: BondDemoQueryKey | null;
};

const CLUB_VISIT_TARGET = 125;

export default function CustomerBondSummaryCard({ summary = null, state = 'READY', demoStateKey = null }: Props) {
  if (state === 'HIDDEN' || state === 'LOADING') return null;
  if (state === 'READY' && !summary?.enabled) return null;

  const destination = demoStateKey
    ? `${CUSTOMER_BOND_PATH}?bondDemo=${demoStateKey}`
    : CUSTOMER_BOND_PATH;
  const signedOut = state === 'SIGNED_OUT';
  const clubActive = state === 'READY' && summary?.currentClubStatus === 'ACTIVE';
  const rawVisits = state === 'READY' ? summary?.qualifyingVisitCount : null;
  const visits = state === 'READY'
    && summary?.enabled
    && summary.visitEnabled
    && typeof rawVisits === 'number'
    && Number.isFinite(rawVisits)
    && rawVisits >= 0
    ? rawVisits
    : null;
  const showProgress = !clubActive && visits !== null;
  const progress = showProgress
    ? Math.min(100, Math.max(0, (visits / CLUB_VISIT_TARGET) * 100))
    : 0;
  const label = signedOut
    ? 'THE BOND · Earn points when you order'
    : clubActive
      ? 'THE BOND CLUB'
      : showProgress
        ? `${visits} / ${CLUB_VISIT_TARGET} · to THE BOND CLUB`
        : 'View THE BOND';

  return (
    <Link
      to={destination}
      className={`cb-customer-bond-strip${clubActive ? ' is-club' : ''}`}
      aria-label={label}
    >
      <span className="cb-customer-bond-strip-row">
        <strong>{label}</strong>
        <ChevronRight size={17} aria-hidden="true" />
      </span>
      {showProgress && (
        <span
          className="cb-customer-bond-strip-progress"
          role="progressbar"
          aria-label="THE BOND CLUB visit progress"
          aria-valuemin={0}
          aria-valuemax={CLUB_VISIT_TARGET}
          aria-valuenow={Math.min(CLUB_VISIT_TARGET, visits)}
          aria-valuetext={`${visits} of ${CLUB_VISIT_TARGET} qualifying visits`}
        >
          <span
            aria-hidden="true"
            style={{ '--cb-bond-progress': `${progress}%` } as CSSProperties}
          />
        </span>
      )}
    </Link>
  );
}
