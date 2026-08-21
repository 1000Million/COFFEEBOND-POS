import type { CSSProperties } from 'react';
import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { BondDemoQueryKey, BondSummary } from '../../lib/bondLoyalty';
import { CUSTOMER_BOND_PATH } from '../../lib/customerRoutes';

type Props = {
  summary?: BondSummary | null;
  state?: 'READY' | 'LOADING' | 'SIGNED_OUT' | 'HIDDEN';
  demoStateKey?: BondDemoQueryKey | null;
};

export default function CustomerBondSummaryCard({ summary = null, state = 'READY', demoStateKey = null }: Props) {
  if (state === 'HIDDEN') return null;
  if (state === 'LOADING') {
    return (
      <section className="cb-bond-order-card is-loading" aria-label="Loading THE BOND summary" aria-busy="true">
        <div className="cb-customer-skeleton cb-bond-order-card-balance motion-reduce:animate-none" />
        <div className="cb-bond-order-card-copy">
          <p className="cb-bond-order-card-title">THE BOND</p>
          <div className="cb-customer-skeleton mt-2 h-3 w-4/5 rounded-full" />
          <div className="cb-customer-skeleton mt-2 h-3 w-20 rounded-full" />
        </div>
      </section>
    );
  }
  if (state === 'SIGNED_OUT') {
    return (
      <section className="cb-bond-order-card is-signed-out" aria-label="THE BOND summary">
        <div className="cb-bond-order-card-balance is-empty" aria-label="Sign in to view BOND points">
          <strong aria-hidden="true">—</strong><span>pts</span>
        </div>
        <div className="cb-bond-order-card-copy">
          <p className="cb-bond-order-card-title">THE BOND</p>
          <p className="cb-bond-order-card-summary">Sign in to see your real balance and progress.</p>
          <Link to={CUSTOMER_BOND_PATH} className="cb-bond-order-card-link">
            View BOND <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </div>
      </section>
    );
  }
  if (!summary?.enabled) return null;
  const visits = Number(summary.qualifyingVisitCount || 0);
  const visitsRemaining = Math.max(0, 125 - visits);
  const progress = Math.min(100, (visits / 125) * 100);
  const points = Number(summary.pointsBalance || 0);
  const compactPoints = new Intl.NumberFormat('en-IN', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(points);
  const summaryCopy = points === 0 && visits === 0
    ? (summary.earnEnabled ? 'Start earning points with your next order.' : 'Your BOND account is ready.')
    : summary.visitEnabled
      ? (visitsRemaining === 0 ? 'THE BOND CLUB is active.' : `${visits} of 125 qualifying visits.`)
      : summary.earnEnabled
        ? 'Earn points with every eligible order.'
        : 'Your real BOND balance.';
  return (
    <section className="cb-bond-order-card" aria-label="THE BOND summary">
      <div className="cb-bond-order-card-balance" aria-label={`${points.toLocaleString('en-IN')} BOND points`}>
        <strong>{compactPoints}</strong>
        <span>pts</span>
        <i aria-hidden="true" style={{ '--cb-bond-progress': `${progress}%` } as CSSProperties} />
      </div>
      <div className="cb-bond-order-card-copy">
        <p className="cb-bond-order-card-title">THE BOND</p>
        <p className="cb-bond-order-card-summary">{summaryCopy}</p>
        <Link
          to={demoStateKey ? `${CUSTOMER_BOND_PATH}?bondDemo=${demoStateKey}` : CUSTOMER_BOND_PATH}
          className="cb-bond-order-card-link"
        >
          View BOND <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
}
