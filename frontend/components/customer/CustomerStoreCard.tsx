import { ChevronDown, MapPin } from 'lucide-react';

type Props = {
  /** "Pickup from" / "Dining at" — decided by the screen, not here. */
  contextLabel: string;
  storeName: string;
  /** Authoritative status label: Accepting orders / Busy / Closed / Opens at… / Menu unavailable. */
  statusLabel: string;
  tone: 'green' | 'amber' | 'red';
  /** Pickup estimate or other store message. Never fabricated — passed through as-is. */
  message?: string;
  onOpenSelector: () => void;
};

const TONE: Record<Props['tone'], string> = {
  green: 'cb-customer-status-green',
  amber: 'cb-customer-status-amber',
  red: 'cb-customer-status-red',
};

/**
 * Selected-store control for the customer home screen.
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
  message,
  onOpenSelector,
}: Props) {
  return (
    <button
      type="button"
      onClick={onOpenSelector}
      aria-label={`${contextLabel} ${storeName}. ${statusLabel}. Change store`}
      /* Compact strip: two tight rows inside a 72–96 px band, no empty white panel. */
      className="cb-customer-store-card flex min-h-[72px] w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
    >
      <MapPin size={18} className="cb-customer-meta shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="cb-customer-muted text-[11px] font-bold leading-tight">{contextLabel}</p>
        <h2 className="cb-customer-title truncate text-base font-black leading-tight">{storeName}</h2>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
          <span className={`inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-black ${TONE[tone]}`}>
            {statusLabel}
          </span>
          {message && <span className="cb-customer-muted truncate text-[11px] font-bold">{message}</span>}
        </div>
      </div>
      <ChevronDown size={18} className="cb-customer-meta shrink-0" aria-hidden="true" />
    </button>
  );
}
