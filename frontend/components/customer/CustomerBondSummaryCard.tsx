import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { BondDemoQueryKey, BondSummary } from '../../lib/bondLoyalty';
import { CUSTOMER_BOND_PATH } from '../../lib/customerRoutes';

type Props = {
  summary: BondSummary;
  demoStateKey?: BondDemoQueryKey | null;
};

export default function CustomerBondSummaryCard({ summary, demoStateKey = null }: Props) {
  if (!summary.enabled) return null;
  const visits = Number(summary.qualifyingVisitCount || 0);
  const visitsRemaining = Math.max(0, 125 - visits);
  const progress = Math.min(100, (visits / 125) * 100);
  return (
    <section className="cb-bond-order-card" aria-label="THE BOND summary">
      <div className="cb-bond-order-card-topline">
        <p>THE BOND</p>
        <Link
          to={demoStateKey ? `${CUSTOMER_BOND_PATH}?bondDemo=${demoStateKey}` : CUSTOMER_BOND_PATH}
          className="cb-bond-order-card-link"
        >
          View BOND <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </div>
      <div className="cb-bond-order-card-metrics">
        <span><strong>{Number(summary.pointsBalance || 0).toLocaleString('en-IN')}</strong> Points</span>
        {summary.visitEnabled && <span><strong>{visits}</strong> / 125 Visits</span>}
      </div>
      {summary.visitEnabled ? (
        <div className="cb-bond-order-card-progress">
          <div aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>
          <p>{visitsRemaining === 0 ? 'THE BOND CLUB active' : `${visitsRemaining} visits to THE BOND CLUB`}</p>
        </div>
      ) : (
        <p className="cb-bond-order-card-paused">Visit progress begins after pickup completion is enabled.</p>
      )}
    </section>
  );
}
