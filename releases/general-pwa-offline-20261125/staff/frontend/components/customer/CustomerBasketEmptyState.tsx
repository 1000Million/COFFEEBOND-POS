import { ShoppingBag } from 'lucide-react';

type Props = {
  /** Closes the basket and returns the customer to the menu. */
  onBrowseMenu: () => void;
};

/** Polished empty basket. Presentation only — it owns no cart state. */
export default function CustomerBasketEmptyState({ onBrowseMenu }: Props) {
  return (
    <div className="cb-customer-basket-empty p-6 text-center">
      <span className="cb-customer-basket-empty-badge mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full">
        <ShoppingBag size={24} aria-hidden="true" />
      </span>
      <p className="cb-customer-usual-eyebrow text-[11px] font-black uppercase">Your basket is empty</p>
      <p className="cb-customer-muted mt-2 text-sm font-bold">
        Add your Coffee Bond favourites to continue.
      </p>
      <button
        type="button"
        onClick={onBrowseMenu}
        className="cb-customer-accent-button mt-4 inline-flex min-h-11 items-center rounded-2xl px-5 text-sm font-black"
      >
        Browse menu
      </button>
    </div>
  );
}
