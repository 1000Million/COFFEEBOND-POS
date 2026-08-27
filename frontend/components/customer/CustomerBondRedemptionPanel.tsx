import { Minus, Plus } from 'lucide-react';
import type { BondRedemptionQuote } from '../../lib/razorpayCheckout';

type Props = {
  quote: BondRedemptionQuote | null;
  selectedPoints: number;
  loading: boolean;
  stale: boolean;
  error?: string | null;
  disabled?: boolean;
  onSelectedPointsChange: (points: number) => void;
  onRetry: () => void;
};

function pointsLabel(value: number): string {
  return `${value.toLocaleString('en-IN')} pts`;
}
/**
 * Point selection only. The panel never converts points to money and never derives a
 * discount or payable: those values arrive together in the server quote and are
 * rendered by the checkout totals component.
 */
export default function CustomerBondRedemptionPanel({
  quote,
  selectedPoints,
  loading,
  stale,
  error = null,
  disabled = false,
  onSelectedPointsChange,
  onRetry,
}: Props) {
  if (!quote) {
    return (
      <section
        className="mt-4 border-t border-[#e4d7c8] pt-4"
        aria-label="BOND Points Redemption"
        aria-busy={loading}
      >
        <p className="cb-customer-eyebrow">BOND Points Redemption</p>
        {loading ? (
          <p role="status" className="cb-customer-muted mt-2 text-sm font-bold">Checking your available BOND Points…</p>
        ) : (
          <div className="mt-2 flex items-center justify-between gap-3">
            <p role="alert" className="cb-customer-muted text-sm font-bold">
              {error || 'BOND redemption is unavailable right now. You can continue without points.'}
            </p>
            <button
              type="button"
              onClick={onRetry}
              className="cb-customer-inline-action inline-flex min-h-11 shrink-0 items-center px-3.5"
            >
              Retry
            </button>
          </div>
        )}
      </section>
    );
  }

  const { policy } = quote;
  const controlsDisabled = disabled || loading || stale;
  const canRedeem = quote.maximumUsablePoints >= policy.minimumPoints;
  const nextLower = selectedPoints <= policy.minimumPoints
    ? 0
    : Math.max(policy.minimumPoints, selectedPoints - policy.incrementPoints);
  const nextHigher = selectedPoints === 0
    ? policy.minimumPoints
    : Math.min(quote.maximumUsablePoints, selectedPoints + policy.incrementPoints);

  return (
    <section
      className="mt-4 border-t border-[#e4d7c8] pt-4"
      aria-labelledby="cb-bond-redemption-heading"
      aria-busy={loading || stale}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p id="cb-bond-redemption-heading" className="cb-customer-eyebrow">{policy.label}</p>
          <p className="cb-customer-muted mt-1 text-xs font-semibold">
            Available {pointsLabel(quote.availablePoints)} · Maximum for this order {pointsLabel(quote.maximumUsablePoints)}
          </p>
          {quote.reservedPoints > 0 && (
            <p className="cb-customer-muted mt-1 text-xs font-semibold">
              {pointsLabel(quote.reservedPoints)} reserved in another checkout
            </p>
          )}
        </div>
        {selectedPoints > 0 && (
          <button
            type="button"
            onClick={() => onSelectedPointsChange(0)}
            disabled={disabled}
            className="cb-customer-inline-action inline-flex min-h-11 shrink-0 items-center px-3 disabled:opacity-50"
          >
            Don’t use
          </button>
        )}
      </div>

      {canRedeem ? (
        <>
          <div className="mt-3 flex items-center justify-between gap-3" role="group" aria-label="BOND points to redeem">
            <button
              type="button"
              onClick={() => onSelectedPointsChange(nextLower)}
              disabled={controlsDisabled || selectedPoints === 0}
              className="cb-customer-icon-button flex h-11 w-11 shrink-0 items-center justify-center rounded-full disabled:opacity-40"
              aria-label={`Use fewer BOND Points. Next value ${pointsLabel(nextLower)}`}
            >
              <Minus size={17} aria-hidden="true" />
            </button>
            <output className="min-w-0 flex-1 text-center" aria-live="polite">
              <strong className="block text-lg font-black text-[#2d2019]">{pointsLabel(selectedPoints)}</strong>
              <span className="cb-customer-muted block text-[11px] font-semibold">
                Minimum {pointsLabel(policy.minimumPoints)} · steps of {pointsLabel(policy.incrementPoints)}
              </span>
            </output>
            <button
              type="button"
              onClick={() => onSelectedPointsChange(nextHigher)}
              disabled={controlsDisabled || selectedPoints >= quote.maximumUsablePoints}
              className="cb-customer-icon-button flex h-11 w-11 shrink-0 items-center justify-center rounded-full disabled:opacity-40"
              aria-label={`Use more BOND Points. Next value ${pointsLabel(nextHigher)}`}
            >
              <Plus size={17} aria-hidden="true" />
            </button>
          </div>
          {selectedPoints !== quote.maximumUsablePoints && (
            <button
              type="button"
              onClick={() => onSelectedPointsChange(quote.maximumUsablePoints)}
              disabled={controlsDisabled}
              className="cb-customer-menu-row mt-2 w-full disabled:opacity-50"
            >
              <span className="cb-customer-menu-row-title min-w-0 flex-1 text-left">Use maximum for this order</span>
              <span className="shrink-0 font-black">{pointsLabel(quote.maximumUsablePoints)}</span>
            </button>
          )}
        </>
      ) : (
        <p className="cb-customer-muted mt-3 text-sm font-semibold">
          You need at least {pointsLabel(policy.minimumPoints)} available for this order.
        </p>
      )}

      {(loading || stale) && (
        <p role="status" className="cb-customer-muted mt-2 text-xs font-bold">Updating the server quote…</p>
      )}
      {error && !loading && !stale && (
        <div className="mt-2 flex items-center justify-between gap-3">
          <p role="alert" className="text-xs font-bold text-red-700">{error}</p>
          <button type="button" onClick={onRetry} className="cb-customer-inline-action min-h-11 px-3">Retry</button>
        </div>
      )}
    </section>
  );
}
