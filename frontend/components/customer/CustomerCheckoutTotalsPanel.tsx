type Props = {
  /** All strings arrive pre-formatted from the parent's authoritative totals. */
  subtotalLabel: string;
  taxableAmountLabel: string;
  gstLabel: string;
  /** Rendered only when the parent supplies a genuine discount. */
  discountLabel?: string | null;
  payableLabel: string;
};

/**
 * Checkout totals.
 *
 * Presentation only: it receives already-formatted amounts produced by the single
 * `totalsForLines` source and renders them. It performs no arithmetic and invents no
 * line — the customer app charges no delivery, service, handling or payment fee, so
 * none appears here. GST is shown as the one total the customer data model exposes;
 * CGST/SGST is deliberately NOT split, because that payload carries no state-level
 * breakdown to split it from.
 */
export default function CustomerCheckoutTotalsPanel({
  subtotalLabel,
  taxableAmountLabel,
  gstLabel,
  discountLabel = null,
  payableLabel,
}: Props) {
  return (
    <section className="cb-customer-totals-panel mt-4 px-4 py-4" aria-label="Order totals">
      <dl className="space-y-2 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="cb-customer-totals-label font-bold">Subtotal</dt>
          <dd className="cb-customer-totals-value font-black tabular-nums">{subtotalLabel}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="cb-customer-totals-label font-bold">Taxable amount</dt>
          <dd className="cb-customer-totals-value font-black tabular-nums">{taxableAmountLabel}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="cb-customer-totals-label font-bold">GST</dt>
          <dd className="cb-customer-totals-value font-black tabular-nums">{gstLabel}</dd>
        </div>
        {discountLabel && (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="cb-customer-totals-label font-bold">Discount</dt>
            <dd className="cb-customer-totals-value font-black tabular-nums">{discountLabel}</dd>
          </div>
        )}
      </dl>
      <div className="cb-customer-totals-divider mt-3 flex items-baseline justify-between gap-3 pt-3">
        <span className="cb-customer-totals-payable text-base font-black">Total payable</span>
        <span className="cb-customer-totals-payable text-xl font-black tabular-nums">{payableLabel}</span>
      </div>
    </section>
  );
}
