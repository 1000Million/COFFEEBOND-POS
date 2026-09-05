import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PublicOrderStatus } from '../../types';

type Props = {
  status: PublicOrderStatus;
  statusLabel: string;
  statusMessage: string;
  itemSummary: string;
  orderReference: string | null;
  trackPath: string;
};

function bannerTone(status: PublicOrderStatus): string {
  if (status === 'READY') return 'is-ready';
  if (['NEEDS_ATTENTION', 'PAYMENT_REVIEW_REQUIRED', 'REFUND_PENDING'].includes(status)) {
    return 'is-attention';
  }
  return 'is-progress';
}

/**
 * The one live order on Home. Presentation only: status, summary and destination are
 * derived by CustomerOrder from the existing history callable and public tracking doc.
 * This surface performs no read, write, status transition or prep-time calculation.
 */
export default function CustomerLiveOrderBanner({
  status,
  statusLabel,
  statusMessage,
  itemSummary,
  orderReference,
  trackPath,
}: Props) {
  const ready = status === 'READY';

  return (
    <section
      className={`cb-customer-live-order cb-customer-hero ${bannerTone(status)}`}
      aria-labelledby="cb-home-live-order-status"
    >
      <div className="cb-customer-live-order-topline">
        <p className="cb-customer-hero-eyebrow">Live</p>
        <Link to={trackPath} className="cb-customer-live-order-track">
          Track <ChevronRight size={16} aria-hidden="true" />
        </Link>
      </div>

      <h2 id="cb-home-live-order-status" className="cb-customer-live-order-status">
        {statusLabel}
      </h2>
      <p className="cb-customer-live-order-message">{statusMessage}</p>

      {(itemSummary || (ready && orderReference)) && (
        <div className="cb-customer-live-order-summary">
          {itemSummary && <p>{itemSummary}</p>}
          {ready && orderReference && (
            <p className="cb-customer-live-order-reference" aria-label={`Order reference ${orderReference}`}>
              {orderReference}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
