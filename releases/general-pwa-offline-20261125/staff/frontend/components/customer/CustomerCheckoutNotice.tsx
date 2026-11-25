import { AlertTriangle, Info, WifiOff } from 'lucide-react';

export type CheckoutNoticeTone = 'info' | 'warning' | 'error' | 'offline';

type Props = {
  tone: CheckoutNoticeTone;
  message: string;
};

/**
 * One consistent checkout notice.
 *
 * It renders a message the parent already derived from existing state — offline,
 * store status, revalidation, payment cancellation/failure/recovery or a submission
 * error. It invents no lifecycle status and decides nothing: the parent owns whether
 * a notice exists at all.
 *
 * Every notice is a live region so a state change is announced, and each tone carries
 * an icon plus words so meaning never rests on colour alone.
 */
export default function CustomerCheckoutNotice({ tone, message }: Props) {
  const Icon = tone === 'offline' ? WifiOff : tone === 'info' ? Info : AlertTriangle;
  return (
    <p
      role="status"
      aria-live="polite"
      className={`cb-customer-checkout-notice tone-${tone} mt-3 flex items-start gap-2 px-3 py-2.5 text-[12px] font-bold`}
    >
      <Icon size={15} className="mt-px shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">{message}</span>
    </p>
  );
}
