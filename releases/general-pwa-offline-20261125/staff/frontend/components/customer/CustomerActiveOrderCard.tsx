import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';

type Props = {
  storeName: string;
  /** Authoritative status label, already derived by the caller. */
  statusLabel: string;
  /**
   * Compact item summary from the live tracking document, e.g. "Bond frappe · Cortado".
   * Empty while the tracking document is still loading — nothing is guessed.
   */
  itemSummary: string;
  /** Formatted payable total, or null while it is not yet authoritative. */
  totalLabel: string | null;
  trackPath: string;
};

/**
 * The customer's one live order, at the top of Orders.
 *
 * This is the single filled surface on the page: everything below it is a flat row on
 * the cream page, so the live order stands apart without needing a border, a badge or
 * a heading to announce itself. It is also the only gold action on the screen.
 *
 * Presentation only. Every string arrives already derived from the canonical status
 * helpers and the existing public tracking document — this card computes no status,
 * estimates no preparation time and invents no next step. There is no "ready in ~X min".
 *
 * The store's longer status sentence is deliberately NOT repeated here; the status
 * label answers the question this page is asking, and the full message is one tap away
 * on tracking. Two sentences saying the same thing is what made the old card sprawl.
 */
export default function CustomerActiveOrderCard({
  storeName,
  statusLabel,
  itemSummary,
  totalLabel,
  trackPath,
}: Props) {
  return (
    <section className="cb-customer-hero p-5" aria-labelledby="cb-active-order-heading">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="cb-active-order-heading" className="cb-customer-hero-eyebrow">Current order</h2>
        {totalLabel && (
          <p className="cb-customer-hero-amount shrink-0" aria-label={`Order total ${totalLabel}`}>{totalLabel}</p>
        )}
      </div>

      {/* The status is the headline: it is what the customer opened this page for. */}
      <p className="cb-customer-hero-status mt-2">{statusLabel}</p>

      {itemSummary && <p className="cb-customer-hero-line mt-2.5">{itemSummary}</p>}
      <p className="cb-customer-hero-meta mt-1 break-words">{storeName}</p>

      <Link
        to={trackPath}
        className="cb-customer-accent-button mt-5 flex min-h-13 w-full items-center justify-center gap-2 rounded-2xl px-4 text-sm font-black"
      >
        Track order
        <ArrowRight size={16} aria-hidden="true" />
      </Link>
    </section>
  );
}
