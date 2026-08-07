import { MapPin } from 'lucide-react';

type Props = {
  /** Label the parent already derives, e.g. "Pickup from" / "Dining at". */
  contextLabel: string;
  storeName: string;
  /** Authoritative store status label from deriveCustomerOrderingState. */
  statusLabel: string;
  tone: 'green' | 'amber' | 'red';
  /** Existing prep-window text, or empty when the store publishes none. */
  prepLabel: string;
  onChangeStore: () => void;
};

/**
 * Compact pickup context inside the basket.
 *
 * Every value is passed in from the parent's existing store state — no hours, prep
 * time or status is invented here, and changing store still routes through the
 * parent's existing `handleStoreChange` confirmation.
 */
export default function CustomerPickupSummary({
  contextLabel,
  storeName,
  statusLabel,
  tone,
  prepLabel,
  onChangeStore,
}: Props) {
  const toneClass = tone === 'green'
    ? 'cb-customer-status-green'
    : tone === 'amber' ? 'cb-customer-status-amber' : 'cb-customer-status-red';

  return (
    <section className="cb-customer-basket-pickup flex items-center gap-3 p-3" aria-label="Pickup details">
      <span className="cb-customer-basket-pickup-pin flex h-10 w-10 shrink-0 items-center justify-center rounded-full">
        <MapPin size={17} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="cb-customer-muted text-[11px] font-bold">{contextLabel}</p>
        <p className="truncate cb-customer-title text-sm font-black">{storeName}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-1.5">
          {/* Status is stated in words as well as colour. */}
          <span className={`${toneClass} rounded-full px-2 py-0.5 text-[11px] font-black`}>{statusLabel}</span>
          {prepLabel && <span className="cb-customer-muted text-[11px] font-bold">{prepLabel}</span>}
        </p>
      </div>
      <button
        type="button"
        onClick={onChangeStore}
        aria-label={`Change pickup store, currently ${storeName}`}
        className="cb-customer-basket-change shrink-0 rounded-full px-3 py-2 text-[12px] font-black"
      >
        Change
      </button>
    </section>
  );
}
