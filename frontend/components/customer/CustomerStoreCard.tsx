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
      className="cb-customer-store-card"
    >
      <span className="cb-customer-store-pin" aria-hidden="true">
        <MapPin size={21} strokeWidth={2.2} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="cb-customer-store-title block truncate">
          {contextLabel === 'Dine-in' ? 'Dine in at' : 'Pickup from'} {storeName}
        </span>
        <span className="cb-customer-store-status block truncate">
          <span className={`cb-customer-store-status-dot ${TONE[tone]}`} aria-hidden="true" />
          <span>{statusLabel}</span>
        </span>
      </span>
      <ChevronRight size={20} className="cb-customer-store-chevron" aria-hidden="true" />
    </button>
  );
}
