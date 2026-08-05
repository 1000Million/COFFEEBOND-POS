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
  /** From visualMeta(item) — the caller's category/visual label. */
  metaLabel?: string;
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
 * Presentation only. Pricing, GST, availability, add-on resolution and every cart
 * mutation stay with the screen — this card just renders what it is given and calls
 * back. There is no second cart state here.
 *
 * Card heights stay consistent across a two-column grid via a fixed image aspect
 * ratio plus a two-line name clamp, so a long name can never push the price or the
 * action control out of alignment.
 */
function CustomerProductCard({
  name,
  priceLabel,
  imageUrl,
  fallbackIcon,
  metaLabel,
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
    <article
      className={`cb-customer-card relative flex flex-col overflow-hidden ${canOrder ? '' : 'cb-customer-unavailable'}`}
    >
      <CustomerProductImage
        src={imageUrl}
        alt={name}
        icon={fallbackIcon}
        iconClassName="text-[#b99b7d]"
        /* 1:1 keeps the card image-led while holding total height near 220 px. */
        className="aspect-square w-full rounded-none"
        priority={priority}
      />

      <div className="flex flex-1 flex-col gap-0.5 px-2.5 pb-12 pt-2">
        {metaLabel && (
          <p className="cb-customer-meta truncate text-[10px] font-black uppercase tracking-wide">{metaLabel}</p>
        )}
        <div className="flex items-start gap-1">
          {dietary && <DietaryMarker value={dietary} compact />}
          <h3 className="cb-clamp-2 cb-customer-title min-w-0 text-[13px] font-black leading-tight">{name}</h3>
        </div>
        <p className="cb-customer-price mt-auto text-sm font-black">{priceLabel}</p>
        {/* Availability is stated in words, never by dimming alone. */}
        {!canOrder && unavailableReason && (
          <p className="cb-customer-muted text-[11px] font-bold leading-snug">{unavailableReason}</p>
        )}
      </div>

      {showStepper ? (
        <div className="cb-customer-stepper absolute bottom-2 right-2 inline-flex h-10 items-center rounded-full p-0.5">
          <button
            type="button"
            onClick={onDecrement}
            data-requires-online="true"
            aria-label={`Decrease ${name}`}
            className="flex h-9 w-9 items-center justify-center rounded-full"
          >
            <Minus size={16} aria-hidden="true" />
          </button>
          <span className="min-w-6 text-center text-sm font-black" aria-live="polite" aria-label={`${name} quantity ${quantity}`}>
            {quantity}
          </span>
          <button
            type="button"
            onClick={onIncrement}
            data-requires-online="true"
            aria-label={`Increase ${name}`}
            className="flex h-9 w-9 items-center justify-center rounded-full"
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
          className="cb-customer-accent-button absolute bottom-3 right-3 flex h-11 w-11 items-center justify-center rounded-full"
        >
          <Plus size={20} aria-hidden="true" />
        </button>
      )}
    </article>
  );
}

/** Memoised: the grid renders up to 80 cards and re-renders on every search keystroke. */
export default memo(CustomerProductCard);
