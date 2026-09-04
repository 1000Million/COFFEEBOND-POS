import { Check, CreditCard, Store } from 'lucide-react';
import type { PaymentProvider } from '../../types';

type Props = {
  value: PaymentProvider;
  disabled?: boolean;
  onChange: (next: PaymentProvider) => void;
};

/**
 * Customer payment method choice.
 *
 * Exactly the two methods the customer app already supports. Staff POS tender types
 * are intentionally absent — this surface must never offer them.
 *
 * The component only reports the chosen provider back to the parent: it creates no
 * order, no checkout session and no payment, and it never touches the cart or the
 * totals. Selection is conveyed by a tick, a border AND the word "Selected", so it
 * never rests on colour alone, and the cards stack vertically — no carousel.
 */
const METHODS: Array<{
  value: PaymentProvider;
  title: string;
  description: string;
  loyaltyNote: string;
  Icon: typeof Store;
}> = [
  {
    value: 'PAY_AT_COUNTER',
    title: 'Pay at Counter',
    // Deliberately not "paid": nothing is collected until collection.
    description: 'Pay when you collect your order.',
    /* BOND points require payment completed online in the app, so this method earns
       none. Stated on the card as well as in the selected-state warning below, so the
       customer sees it while comparing rather than only after choosing. */
    loyaltyNote: 'No BOND points are earned on counter or staff payments. Pay online in the app to earn points.',
    Icon: Store,
  },
  {
    value: 'RAZORPAY',
    title: 'Pay Online',
    /* Deliberately not "payment complete": the cafe still has to accept, so the card
       says so. Shortening this to "Pay securely online." removed the only place the
       customer was told that before paying — the action bar's footnote is about the
       cart, and the tracking screen only exists after the money has moved. */
    description: 'Pay securely in the app before the café accepts your order.',
    loyaltyNote: 'Earn BOND points on eligible orders.',
    Icon: CreditCard,
  },
];

export default function CustomerPaymentSelector({ value, disabled = false, onChange }: Props) {
  return (
    <fieldset className="mt-4" disabled={disabled}>
      <legend className="cb-customer-eyebrow">Payment</legend>
      <div className="mt-2 space-y-2" role="radiogroup" aria-label="Payment method">
        {METHODS.map(({ value: methodValue, title, description, loyaltyNote, Icon }) => {
          const selected = value === methodValue;
          return (
            <button
              key={methodValue}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(methodValue)}
              className={`cb-customer-payment-card flex w-full items-start gap-3 p-3 text-left ${selected ? 'is-selected' : ''}`}
            >
              <span className="cb-customer-payment-icon flex h-11 w-11 shrink-0 items-center justify-center rounded-full">
                <Icon size={18} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block cb-customer-title text-sm font-black">{title}</span>
                <span className="block cb-customer-muted break-words text-[12px] font-semibold">{description}</span>
                <span className="mt-1 block cb-customer-muted break-words text-[11px] font-semibold opacity-80">{loyaltyNote}</span>
              </span>
              <span
                className={`cb-customer-payment-tick flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${selected ? 'is-on' : ''}`}
                aria-hidden="true"
              >
                {selected && <Check size={14} />}
              </span>
              <span className="sr-only">{selected ? 'Selected' : 'Not selected'}</span>
            </button>
          );
        })}
      </div>
      {/* Rendered only while Pay at Counter is the selection, immediately below the
          options. role="status" announces it to screen readers when the customer
          switches to it, without stealing focus the way an alert would. */}
      {value === 'PAY_AT_COUNTER' && (
        <p
          role="status"
          data-testid="cb-counter-loyalty-warning"
          className="cb-customer-muted mt-2 break-words rounded-lg border border-amber-300/60 bg-amber-50/60 p-3 text-[12px] font-semibold leading-snug text-amber-900"
        >
          BOND points won’t be earned on this order.
          <span className="mt-0.5 block font-medium">
            To earn points, choose Pay Online and complete payment in the app.
          </span>
        </p>
      )}
    </fieldset>
  );
}
