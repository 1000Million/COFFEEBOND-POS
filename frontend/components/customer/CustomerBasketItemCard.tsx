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
  /** Formatted unit price INCLUDING selected add-ons, from the parent. */
  unitPriceLabel: string;
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
 * One basket line.
 *
 * Presentation only: every money string arrives pre-formatted from the parent, which
 * remains the single source of pricing and GST. This card computes nothing, and its
 * quantity control calls straight back into the existing `setLineQuantity`.
 *
 * Long product names and add-on labels wrap rather than clip — the basket has one
 * scroll direction and a line must never be cut off horizontally.
 */
export default function CustomerBasketItemCard({
  productName,
  unitPriceLabel,
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
    <li className="cb-customer-basket-line flex gap-3 p-3">
      <CustomerProductImage
        src={imageUrl}
        alt=""
        icon={fallbackIcon}
        iconClassName="text-[#5c4033]"
        className="cb-customer-basket-thumb h-16 w-16"
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="break-words cb-customer-title text-sm font-black leading-tight">{productName}</p>
            {dietaryClassification && (
              <div className="mt-1"><DietaryMarker value={dietaryClassification} compact /></div>
            )}
            <p className="cb-customer-muted mt-1 text-xs font-bold">{unitPriceLabel} each</p>
          </div>
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${productName} from basket`}
            className="cb-customer-basket-remove flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
          >
            <Trash2 size={15} aria-hidden="true" />
          </button>
        </div>

        {addOns.length > 0 && (
          <ul className="mt-1.5 space-y-0.5">
            {addOns.map(addOn => (
              <li key={addOn.key} className="cb-customer-muted break-words text-[11px] font-semibold">
                + {addOn.name}{addOn.quantity > 1 ? ` × ${addOn.quantity}` : ''} · {addOn.priceLabel}
              </li>
            ))}
          </ul>
        )}

        {/* Wraps rather than overflowing: at 360px the stepper, Edit and the line
            total cannot all fit on one row, and the total must never be pushed past
            the viewport edge. */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-2 gap-y-2">
          <div className="flex min-w-0 items-center gap-2">
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
          </div>
          <span className="shrink-0 cb-customer-title text-sm font-black">{lineTotalLabel}</span>
        </div>
      </div>
    </li>
  );
}
