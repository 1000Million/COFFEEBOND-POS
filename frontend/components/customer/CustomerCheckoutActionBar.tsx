import { Loader2 } from 'lucide-react';

type Props = {
  /** Full label the parent derived from the existing checkout state. */
  label: string;
  /** Reason the action is unavailable, announced for assistive tech. Empty when ready. */
  disabledReason?: string;
  disabled: boolean;
  busy: boolean;
  /** Reassurance line the existing flow already showed beneath the action. */
  footnote: string;
  onSubmit: () => void;
};

/**
 * The single checkout action.
 *
 * It calls the parent's existing submit handler and nothing else — there is no second
 * submission path, no idempotency logic and no payment call here. The label, the
 * disabled state and the reason all arrive already decided by the parent, so this bar
 * can never make an order possible that the screen considers invalid.
 */
export default function CustomerCheckoutActionBar({
  label,
  disabledReason = '',
  disabled,
  busy,
  footnote,
  onSubmit,
}: Props) {
  return (
    <div className="cb-customer-action-bar sticky bottom-0 z-10 -mx-4 mt-4 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:-mx-5 sm:px-5">
      {/* A disabled action must say why, not just look dead. */}
      <p className="sr-only" role="status" aria-live="polite">
        {disabled && disabledReason ? disabledReason : label}
      </p>
      <button
        type="button"
        onClick={onSubmit}
        data-requires-online="true"
        disabled={disabled}
        aria-label={label}
        aria-describedby={disabled && disabledReason ? 'cb-checkout-disabled-reason' : undefined}
        className="cb-customer-accent-button inline-flex min-h-13 w-full items-center justify-center gap-2 rounded-2xl px-4 py-4 text-sm font-black disabled:cursor-not-allowed"
      >
        {busy && <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
        {label}
      </button>
      {disabled && disabledReason && (
        <p id="cb-checkout-disabled-reason" className="cb-customer-muted mt-2 text-center text-[11px] font-bold">
          {disabledReason}
        </p>
      )}
      <p className="cb-customer-muted mt-2 text-center text-[11px] font-medium">{footnote}</p>
    </div>
  );
}
