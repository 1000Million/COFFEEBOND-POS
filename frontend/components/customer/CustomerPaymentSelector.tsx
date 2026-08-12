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
  Icon: typeof Store;
}> = [
  {
    value: 'PAY_AT_COUNTER',
    title: 'Pay at Counter',
    // Deliberately not "paid": nothing is collected until collection.
    description: 'Pay when you collect your order.',
    Icon: Store,
  },
  {
    value: 'RAZORPAY',
    title: 'Pay Online',
    // Deliberately not "payment complete": the cafe still has to accept.
    description: 'Pay securely online before the cafe accepts your order.',
    Icon: CreditCard,
  },
];

export default function CustomerPaymentSelector({ value, disabled = false, onChange }: Props) {
  return (
    <fieldset className="mt-4" disabled={disabled}>
      <legend className="cb-customer-usual-eyebrow text-[11px] font-black uppercase">Payment</legend>
      <div className="mt-2 space-y-2" role="radiogroup" aria-label="Payment method">
        {METHODS.map(({ value: methodValue, title, description, Icon }) => {
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
    </fieldset>
  );
}
