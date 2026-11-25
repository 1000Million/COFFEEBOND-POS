import { ChevronRight, MapPin } from 'lucide-react';

type Props = {
  /** Label the parent already derives, e.g. "Pickup" / "Dine-in". */
  contextLabel: string;
  storeName: string;
  /** Authoritative store status label from deriveCustomerOrderingState. */
  statusLabel: string;
  tone: 'green' | 'amber' | 'red';
  /** Existing prep-window text, or empty when the store publishes none. */
  prepLabel: string;
  onChangeStore: () => void;
};

const TONE: Record<Props['tone'], string> = {
  green: 'cb-customer-tone-green',
  amber: 'cb-customer-tone-amber',
  red: 'cb-customer-tone-red',
};

/**
 * Pickup context in the basket, as one compact row.
 *
 * The basket answers "what am I buying", so where it is going costs one row: the whole
 * row is the change-store control, in the same flat language as the menu's store row.
 * It used to be a bordered card with a pin badge and a separate "Change" pill, 83 px
 * tall, sitting above the first item.
 *
 * This is the one place in the app that still shows the prep window, so it stays here —
 * it is the fact a customer wants at the moment they are deciding to order, and it is
 * not repeated anywhere else. Every value is passed in from the parent's existing store
 * state; no hours, prep time or status is invented here, and changing store still routes
 * through the parent's existing handler.
 */
export default function CustomerPickupSummary({
  contextLabel,
  storeName,
  statusLabel,
  tone,
  prepLabel,
  onChangeStore,
}: Props) {
  return (
    <button
      type="button"
      onClick={onChangeStore}
      aria-label={`${contextLabel} ${storeName}. ${statusLabel}. Change store`}
      className="cb-customer-menu-row is-first"
    >
      <MapPin size={19} className="cb-customer-row-icon" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="cb-customer-menu-row-title block truncate">
          {contextLabel} · {storeName}
        </span>
        {/* Status is stated in words as well as colour. */}
        <span className={`cb-customer-menu-row-meta block truncate ${TONE[tone]}`}>
          {statusLabel}{prepLabel ? <span className="cb-customer-muted"> · {prepLabel}</span> : null}
        </span>
      </span>
      <ChevronRight size={18} className="cb-customer-row-chevron" aria-hidden="true" />
    </button>
  );
}
