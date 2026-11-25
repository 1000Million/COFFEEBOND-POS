import { ShoppingBag } from 'lucide-react';

type Props = {
  /** Total units in the basket. The bar renders nothing at zero. */
  itemCount: number;
  /** Formatted basket total, announced with the action. */
  totalLabel: string;
  /** Opens the existing basket sheet — this component owns no cart logic. */
  onOpenBasket: () => void;
};

/**
 * Contextual basket access.
 *
 * The basket used to be a permanently raised button in the bottom navigation, which
 * meant the most prominent control in the app was a dead action whenever the basket was
 * empty — and it cost a navigation slot that a real destination could use.
 *
 * This bar takes its place: absent at zero, and directly above the navigation once
 * there is something to check out. It sits in the same fixed stack as the bar, offset by
 * the navigation's height plus the safe-area inset, so it can never overlap the
 * navigation or sit under a home indicator.
 *
 * It opens the existing basket sheet and nothing else. No cart mutation, no totals
 * calculation and no checkout logic lives here — the count and the total both arrive
 * already computed by the screen that owns them.
 */
export default function CustomerBasketBar({ itemCount, totalLabel, onOpenBasket }: Props) {
  if (itemCount <= 0) return null;

  const label = `Open basket with ${itemCount} item${itemCount === 1 ? '' : 's'}, ${totalLabel}`;

  return (
    <div className="cb-customer-basket-bar lg:hidden">
      <button
        type="button"
        onClick={onOpenBasket}
        data-requires-online="true"
        aria-label={label}
        className="cb-customer-basket-bar-action"
      >
        <ShoppingBag size={19} aria-hidden="true" />
        <span className="flex-1 text-left">
          {itemCount} item{itemCount === 1 ? '' : 's'}
        </span>
        <span className="cb-customer-basket-bar-total">{totalLabel}</span>
        <span className="cb-customer-basket-bar-cta">View basket</span>
      </button>
    </div>
  );
}
