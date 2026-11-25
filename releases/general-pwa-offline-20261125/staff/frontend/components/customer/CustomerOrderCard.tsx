import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';

type Props = {
  storeName: string;
  /** Public order reference, e.g. CBWEB-XXXXXXXXXX. Announced, not printed. */
  reference: string;
  /** Already-formatted date, or null when the order carries no timestamp. */
  dateLabel: string | null;
  /** Pickup / Dine-in, derived by the caller from the authoritative order type. */
  fulfilmentLabel: string;
  /** Authoritative status label from the existing status helper. */
  statusLabel: string;
  /** Tone for the status text. Meaning is carried by the label, never by hue alone. */
  statusTone: 'settled' | 'ended';
  /** Formatted total. */
  totalLabel: string;
  viewPath: string;
  /**
   * BOND points posted by the server's immutable POINT_EARN ledger entry, or null.
   * listMyOrders reads this from the ledger, so a number here means points were
   * actually awarded — the customer app never estimates a balance.
   */
  pointsEarned?: number | null;
};

/**
 * One past order, as a flat row.
 *
 * A history list is something a customer skims, so it is built like one: date and store
 * lead, the status is a quiet second line, the total aligns down the right edge, and a
 * single hairline separates one order from the next. There is no card, no border, no
 * pill and no panel.
 *
 * The machine reference (CBWEB-…) is deliberately not printed. People recognise their
 * order by "12 Aug, Golden I, ₹420", not by a token — printing the token on every row
 * is what made the list read as a table of database records. It stays in the accessible
 * name so the row is still unambiguous to a screen reader, and it is shown in full on
 * the order's own tracking screen.
 *
 * Only fields the existing authenticated history callable returns are used. Product
 * names are NOT shown, because that payload carries no order lines and Stage 5 adds no
 * second query.
 */
export default function CustomerOrderCard({
  storeName,
  reference,
  dateLabel,
  fulfilmentLabel,
  statusLabel,
  statusTone,
  totalLabel,
  viewPath,
  pointsEarned = null,
}: Props) {
  return (
    <li>
      <Link
        to={viewPath}
        className="cb-customer-row min-h-[44px]"
        aria-label={`${dateLabel ? `${dateLabel}, ` : ''}${storeName}, ${fulfilmentLabel}, ${statusLabel}, ${totalLabel}, reference ${reference}. View order`}
      >
        <span className="min-w-0 flex-1">
          <span className="cb-customer-row-title block truncate">
            {dateLabel ? `${dateLabel} · ` : ''}{storeName}
          </span>
          <span className={`cb-customer-row-sub block truncate ${statusTone === 'ended' ? 'is-ended' : ''}`}>
            {statusLabel} · {fulfilmentLabel}
          </span>
          {/* Posted BOND points only. `pointsEarned` arrives from listMyOrders, which
              reads the immutable POINT_EARN ledger entry — so this line appears only
              after the server actually awarded them. Nothing is estimated here. */}
          {typeof pointsEarned === 'number' && pointsEarned > 0 && (
            <span className="cb-customer-row-points block truncate">
              You earned {pointsEarned} BOND Points
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="cb-customer-row-amount">{totalLabel}</span>
          <ChevronRight size={17} className="cb-customer-row-chevron" aria-hidden="true" />
        </span>
      </Link>
    </li>
  );
}
