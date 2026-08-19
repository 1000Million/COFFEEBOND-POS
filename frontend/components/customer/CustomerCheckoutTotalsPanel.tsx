type Props = {
  /** All strings arrive pre-formatted from the parent's authoritative totals. */
  subtotalLabel: string;
  gstLabel: string;
  /** Rendered only when the parent supplies a genuine discount. */
  discountLabel?: string | null;
  payableLabel: string;
};

/**
 * Order totals.
 *
 * Presentation only: it receives already-formatted amounts produced by the single
 * `totalsForLines` source and renders them. It performs no arithmetic and invents no
 * line — the customer app charges no delivery, service, handling or payment fee, so
 * none appears here. GST is shown as the one total the customer data model exposes;
 * CGST/SGST is deliberately NOT split, because that payload carries no state-level
 * breakdown to split it from.
 *
 * Two things changed from the previous version, both subtractions:
 *
 *  - "Taxable amount" is gone. In this app `totals.taxableAmount` IS `totals.subtotal`
 *    — the same number under a second name, printed directly beneath it. It was not a
 *    disclosure, it was a duplicate. The tax invoice the store issues is unaffected.
 *  - The espresso panel is gone. It was the tallest single element in the basket and
 *    the strongest colour on the screen, competing with the one action that matters.
 *    The total is now the largest type in a flat block, which is enough.
 */
export default function CustomerCheckoutTotalsPanel({
  subtotalLabel,
  gstLabel,
  discountLabel = null,
  payableLabel,
}: Props) {
  return (
    <section className="mt-4" aria-label="Order totals">
      <dl className="space-y-2">
        <div className="cb-customer-total-row">
          <dt className="cb-customer-total-label">Subtotal</dt>
          <dd className="cb-customer-total-value">{subtotalLabel}</dd>
        </div>
        {discountLabel && (
          <div className="cb-customer-total-row">
            <dt className="cb-customer-total-label">Discount</dt>
            <dd className="cb-customer-total-value">{discountLabel}</dd>
          </div>
        )}
        <div className="cb-customer-total-row">
          <dt className="cb-customer-total-label">GST</dt>
          <dd className="cb-customer-total-value">{gstLabel}</dd>
        </div>
        {/* The payable stays inside the same description list, so a screen reader still
            pairs it with its amount. A hairline and a size step are what separate it
            from the lines above — it no longer needs a panel of its own. */}
        <div className="cb-customer-total-row is-grand cb-customer-totals pt-3">
          <dt className="cb-customer-total-label">Total</dt>
          <dd className="cb-customer-total-value">{payableLabel}</dd>
        </div>
      </dl>
    </section>
  );
}
