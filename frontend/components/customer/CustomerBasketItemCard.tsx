import { ComponentType } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import CustomerProductImage from './CustomerProductImage';
import CustomerQuantityControl from './CustomerQuantityControl';
import DietaryMarker from './DietaryMarker';
import type { DietaryClassification } from '../../lib/customerMenuPresentation';

export type BasketAddOnLabel = {
  key: string;
  /** Live option name from the current menu. */
  name: string;
  quantity: number;
  /** Already-formatted money string from the parent. */
  priceLabel: string;
};

type Props = {
  productName: string;
  /** Formatted line total, from the parent. */
  lineTotalLabel: string;
  quantity: number;
  maxQuantity: number;
  imageUrl: string | null;
  fallbackIcon: ComponentType<{ size?: number; className?: string }>;
  dietaryClassification?: DietaryClassification | null;
  addOns: BasketAddOnLabel[];
  /** Only offered when the product actually has customisable groups. */
  canEdit: boolean;
  onQuantityChange: (next: number) => void;
  onEdit: () => void;
  onRemove: () => void;
};

/**
 * One basket line, as a row.
 *
 * It shows what was bought and nothing else: picture, name, the add-ons that were
 * chosen, the quantity, the line total, and the two actions that change it. The
 * per-unit price is deliberately gone — with a line total on the same row it was a
 * second price saying the same thing, and at quantity 1 the two were identical.
 *
 * The veg / non-veg marker stays. It is not decoration in this market, and it costs
 * one 14 px glyph beside the name.
 *
 * Presentation only: every money string arrives pre-formatted from the parent, which
 * remains the single source of pricing and GST. This row computes nothing, and its
 * quantity control calls straight back into the existing `setLineQuantity`.
 *
 * Long product names and add-on labels wrap rather than clip — the basket has one
 * scroll direction and a line must never be cut off horizontally.
 */
export default function CustomerBasketItemCard({
  productName,
  lineTotalLabel,
  quantity,
  maxQuantity,
  imageUrl,
  fallbackIcon,
  dietaryClassification = null,
  addOns,
  canEdit,
  onQuantityChange,
  onEdit,
  onRemove,
}: Props) {
  return (
    <li className="cb-customer-basket-line flex gap-3 py-3">
      <CustomerProductImage
        src={imageUrl}
        alt=""
        icon={fallbackIcon}
        iconClassName="text-[#5c4033]"
        className="cb-customer-basket-thumb h-14 w-14 shrink-0"
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-3">
          <p className="break-words cb-customer-title min-w-0 text-sm font-black leading-tight">
            {dietaryClassification && (
              <span className="mr-1.5 inline-block align-[1px]"><DietaryMarker value={dietaryClassification} compact /></span>
            )}
            {productName}
          </p>
          <span className="shrink-0 cb-customer-title text-sm font-black tabular-nums">{lineTotalLabel}</span>
        </div>

        {addOns.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {addOns.map(addOn => (
              <li key={addOn.key} className="cb-customer-muted break-words text-[11.5px] font-semibold">
                + {addOn.name}{addOn.quantity > 1 ? ` × ${addOn.quantity}` : ''} · {addOn.priceLabel}
              </li>
            ))}
          </ul>
        )}

        {/* Wraps rather than overflowing: at 320px the stepper, Edit and Remove cannot
            always share one row. */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <CustomerQuantityControl
            value={quantity}
            min={1}
            max={maxQuantity}
            label={productName}
            size="sm"
            onChange={onQuantityChange}
          />
          {canEdit && (
            <button
              type="button"
              onClick={onEdit}
              aria-label={`Edit ${productName} options`}
              className="cb-customer-basket-edit inline-flex h-11 items-center gap-1.5 rounded-full px-3 text-[12px] font-black"
            >
              <Pencil size={13} aria-hidden="true" />
              Edit
            </button>
          )}
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${productName} from basket`}
            className="cb-customer-basket-remove flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
          >
            <Trash2 size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
    </li>
  );
}
