import { ComponentType, memo } from 'react';
import { Minus, Plus } from 'lucide-react';
import CustomerProductImage from './CustomerProductImage';
import DietaryMarker from './DietaryMarker';
import { DietaryClassification } from '../../lib/customerMenuPresentation';

type Props = {
  name: string;
  /** Authoritative formatted price. This component never computes money. */
  priceLabel: string;
  imageUrl: string | null;
  /** Icon used for the branded fallback when no image exists or it fails. */
  fallbackIcon: ComponentType<{ size?: number; className?: string }>;
  /** Authoritative classification only; null when product data has none. */
  dietary: DietaryClassification | null;
  /** Units of this product currently in the cart. */
  quantity: number;
  /** Authoritative availability + store ordering policy, decided by the caller. */
  canOrder: boolean;
  /** Exact authoritative reason shown when the item cannot be ordered. */
  unavailableReason?: string;
  /** Only above-the-fold cards should load eagerly. */
  priority?: boolean;
  /** Add / open-customization. The caller decides which flow this triggers. */
  onAdd: () => void;
  onIncrement: () => void;
  onDecrement: () => void;
  /** True when the product has add-on groups, so Add opens customization. */
  opensCustomization: boolean;
};

/**
 * Image-led product card for the customer menu grid.
 *
 * Four things, in this order: picture, name, price, action. Nothing else competes.
 *
 * Three things were taken away to get there. The category label went first — it sat
 * above the name in terracotta caps and repeated the section heading the card was
 * already filed under, so the first thing the eye met on every card was a word the
 * customer had just read. The white panel and its shadow went next: 84 floating boxes
 * on a cream page is a lot of container for very little content, and the photograph is
 * a better edge than a border. Finally the floating round "+" that overlapped the
 * card's corner, along with the 56 px of padding reserved underneath it so long names
 * could not run beneath it, became a plain full-width action row.
 *
 * Both action states occupy the same 44 px row, so a card does not change height when
 * the item enters the basket and the grid never re-flows under the customer's thumb.
 * Gold is reserved for the stepper — it marks "this is in your basket", which is the
 * one thing on the card worth a colour.
 *
 * Presentation only. Pricing, GST, availability, add-on resolution and every cart
 * mutation stay with the screen — this card renders what it is given and calls back.
 */
function CustomerProductCard({
  name,
  priceLabel,
  imageUrl,
  fallbackIcon,
  dietary,
  quantity,
  canOrder,
  unavailableReason,
  priority = false,
  onAdd,
  onIncrement,
  onDecrement,
  opensCustomization,
}: Props) {
  const showStepper = quantity > 0;

  return (
    <article className={`cb-customer-card flex flex-col ${canOrder ? '' : 'cb-customer-unavailable'}`}>
      <CustomerProductImage
        src={imageUrl}
        alt={name}
        icon={fallbackIcon}
        iconClassName="text-[#b99b7d]"
        /* 1:1 keeps the picture dominant and every card in a row the same height. */
        className="cb-customer-product-media aspect-square w-full"
        priority={priority}
      />

      <div className="flex flex-1 flex-col px-0.5 pt-2.5">
        {/* The marker rides inside the heading rather than beside it, so a two-line
            name wraps under itself instead of into a narrower column. */}
        <h3 className="cb-clamp-2 cb-customer-product-name">
          {dietary && (
            <span className="mr-1 inline-block align-[1px]"><DietaryMarker value={dietary} compact /></span>
          )}
          {name}
        </h3>

        {/* Availability is stated in words, never by dimming alone. */}
        {!canOrder && unavailableReason && (
          <p className="cb-customer-product-unavailable mt-1">{unavailableReason}</p>
        )}

        <p className="cb-customer-product-price mt-1.5">{priceLabel}</p>

        {/* mt-auto pins the action to the bottom of the stretched grid cell, so a
            one-line name and a two-line name still line their buttons up. */}
        <div className="mt-auto flex pt-2">
          {showStepper ? (
            /* 44 px per control, the touch-target floor. Full width because at 320 px
               the card is 138 px and 2x44 plus a count column will not fit inside a
               right-anchored island. */
            <div className="cb-customer-stepper flex h-11 w-full items-center justify-between rounded-full">
              <button
                type="button"
                onClick={onDecrement}
                data-requires-online="true"
                aria-label={`Decrease ${name}`}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
              >
                <Minus size={16} aria-hidden="true" />
              </button>
              <span
                className="min-w-4 text-center text-sm font-black tabular-nums"
                aria-live="polite"
                aria-label={`${name} quantity ${quantity}`}
              >
                {quantity}
              </span>
              <button
                type="button"
                onClick={onIncrement}
                data-requires-online="true"
                aria-label={`Increase ${name}`}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
              >
                <Plus size={16} aria-hidden="true" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={onAdd}
              disabled={!canOrder}
              data-requires-online="true"
              aria-label={opensCustomization ? `Choose options for ${name}` : `Add ${name}`}
              className="cb-customer-add-button flex h-11 w-full items-center justify-center gap-1"
            >
              <Plus size={16} aria-hidden="true" />
              Add
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

/** Memoised: the grid renders up to 80 cards and re-renders on every search keystroke. */
export default memo(CustomerProductCard);
