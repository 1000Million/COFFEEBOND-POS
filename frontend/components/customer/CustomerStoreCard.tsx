import { ChevronRight, MapPin } from 'lucide-react';

type Props = {
  /** "Pickup" / "Dine-in" — decided by the screen, not here. */
  contextLabel: string;
  storeName: string;
  /** Authoritative status label: Accepting orders / Busy / Closed / Opens at… / Menu unavailable. */
  statusLabel: string;
  tone: 'green' | 'amber' | 'red';
  onOpenSelector: () => void;
};

const TONE: Record<Props['tone'], string> = {
  green: 'cb-customer-tone-green',
  amber: 'cb-customer-tone-amber',
  red: 'cb-customer-tone-red',
};

/**
 * Selected-store control for the customer home screen.
 *
 * A compact row, not a card. This sits between the customer and the menu, so it earns
 * two lines and nothing more: where the order is going, and whether the store is taking
 * orders. The white panel, the status pill and the pickup-window sentence together made
 * it a 76 px block at the very top of the screen.
 *
 * The pickup estimate is no longer shown here. It is not lost: the basket's pickup
 * summary carries the same authoritative prep window, at the point where the customer
 * is actually committing to a collection time.
 *
 * Every string is supplied by the caller from authoritative store and availability
 * data — this component derives no hours, no estimates and no status. Status is
 * conveyed by the label text as well as the tone colour, so it is never colour-only.
 */
export default function CustomerStoreCard({
  contextLabel,
  storeName,
  statusLabel,
  tone,
  onOpenSelector,
}: Props) {
  return (
    <button
      type="button"
      onClick={onOpenSelector}
      aria-label={`${contextLabel} ${storeName}. ${statusLabel}. Change store`}
      className="cb-customer-menu-row is-first"
    >
      <MapPin size={19} className="cb-customer-row-icon" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="cb-customer-menu-row-title block truncate">
          {contextLabel} · {storeName}
        </span>
        <span className={`cb-customer-menu-row-meta block truncate ${TONE[tone]}`}>{statusLabel}</span>
      </span>
      <ChevronRight size={18} className="cb-customer-row-chevron" aria-hidden="true" />
    </button>
  );
}
