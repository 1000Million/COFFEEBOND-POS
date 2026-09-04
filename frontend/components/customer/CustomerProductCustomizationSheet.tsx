import { ComponentType, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import type { AddOnSelection } from '../../types';
import type { AddOnGroup } from '../../types/menu-management';
import type { DietaryClassification } from '../../lib/customerMenuPresentation';
import {
  AddOnQuantityByOption,
  buildAddOnSelections,
  validateAddOnQuantities,
} from '../../lib/addOns';
import CustomerProductImage from './CustomerProductImage';
import CustomerQuantityControl from './CustomerQuantityControl';
import DietaryMarker from './DietaryMarker';

/**
 * Customer product customization sheet.
 *
 * Presentation only. Every rule it displays comes from authoritative data the parent
 * supplied: the groups are already filtered to the selected store by
 * `activeAddOnGroupsForProduct`, minimum/maximum/selection mode come off those groups,
 * and the money shown is produced by the SAME `buildAddOnSelections` helper the cart
 * and POS use. It invents no ingredient, size, rating or dietary value, and it never
 * writes to the cart — it hands the built selections back and the parent canonicalises
 * them through `commitCartItem`.
 *
 * The staff POS keeps using `components/add-ons/AddOnSelector`; this component is
 * customer-only so the two surfaces can diverge visually without touching each other.
 */

type Props = {
  productName: string;
  description?: string;
  categoryLabel?: string;
  /** Authoritative current base price for one unit, before add-ons. */
  basePrice: number;
  imageUrl: string | null;
  fallbackIcon: ComponentType<{ size?: number; className?: string }>;
  dietaryClassification?: DietaryClassification | null;
  /** Already scoped to the selected store by the parent. */
  groups: AddOnGroup[];
  /** Fallback tax rate used by buildAddOnSelections, from the parent. */
  taxRate: number;
  initialSelections?: AddOnSelection[];
  initialQuantity?: number;
  isEditing: boolean;
  submitting?: boolean;
  /** Ceiling that matches the order backend's per-line maximum. */
  maxQuantity: number;
  formatMoney: (value: number) => string;
  onCancel: () => void;
  onConfirm: (addOns: AddOnSelection[], quantity: number) => void;
};

type QuantitiesByGroup = Record<string, AddOnQuantityByOption>;

function seedQuantities(groups: AddOnGroup[], selections: AddOnSelection[]): QuantitiesByGroup {
  const result: QuantitiesByGroup = {};
  groups.forEach(group => {
    if (group.id) result[group.id] = {};
  });
  selections.forEach(selection => {
    // A saved option that this store no longer offers is deliberately NOT seeded:
    // it is surfaced separately so the customer chooses, rather than substituted.
    const group = groups.find(candidate => candidate.id === selection.groupId);
    if (!group?.options?.some(option => option.id === selection.optionId)) return;
    if (!result[selection.groupId]) result[selection.groupId] = {};
    result[selection.groupId][selection.optionId] = selection.quantity;
  });
  return result;
}

/** Human rule label, built only from rules the group actually declares. */
function groupRuleLabel(group: AddOnGroup): string {
  const minimum = Math.max(0, Number(group.minimumSelections) || 0);
  const maximum = group.maximumSelections === null || group.maximumSelections === undefined
    ? null
    : Math.max(0, Number(group.maximumSelections));
  if (group.selectionMode === 'EXACT_DISTINCT' && minimum > 0 && maximum === minimum) {
    return `Required · Choose exactly ${minimum} different options`;
  }
  const parts: string[] = [];
  if (minimum > 0) parts.push(`Required · Choose ${minimum}`);
  else parts.push('Optional');
  if (maximum !== null && maximum !== minimum) parts.push(`Choose up to ${maximum}`);
  return parts.join(' · ');
}

export default function CustomerProductCustomizationSheet({
  productName,
  description,
  categoryLabel,
  basePrice,
  imageUrl,
  fallbackIcon,
  dietaryClassification = null,
  groups,
  taxRate,
  initialSelections = [],
  initialQuantity = 1,
  isEditing,
  submitting = false,
  maxQuantity,
  formatMoney,
  onCancel,
  onConfirm,
}: Props) {
  const titleId = useId();
  const summaryId = useId();
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [quantities, setQuantities] = useState<QuantitiesByGroup>(
    () => seedQuantities(groups, initialSelections),
  );
  const [quantity, setQuantity] = useState(() => Math.min(Math.max(1, initialQuantity), maxQuantity));

  /** Saved selections this store can no longer honour — named, never swapped. */
  const droppedSelections = useMemo(() => initialSelections.filter(selection => {
    const group = groups.find(candidate => candidate.id === selection.groupId);
    return !group?.options?.some(option => option.id === selection.optionId);
  }), [groups, initialSelections]);

  // --- Authoritative derivations, all from the shared add-on library ---------
  const validation = useMemo(
    () => groups.map(group => ({
      group,
      result: validateAddOnQuantities(group, quantities[group.id || ''] || {}),
    })),
    [groups, quantities],
  );
  const selections = useMemo(
    () => buildAddOnSelections(groups, quantities, taxRate),
    [groups, quantities, taxRate],
  );
  const addOnValue = selections.reduce((sum, selection) => sum + selection.totalPrice, 0);
  const unitPrice = basePrice + addOnValue;
  const itemTotal = unitPrice * quantity;
  const firstProblem = validation.find(entry => !entry.result.ok)?.result.message || null;
  const isValid = !firstProblem;

  // --- Modal behaviour ------------------------------------------------------
  useEffect(() => {
    // Focus lands inside the sheet, and the page behind must not scroll.
    closeRef.current?.focus();
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = overflow; };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.key !== 'Tab' || !sheetRef.current) return;
      const focusable = [...sheetRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )].filter(element => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel]);

  const setOptionQuantity = (group: AddOnGroup, optionId: string, next: number) => {
    const groupId = group.id || '';
    setQuantities(current => {
      const groupQuantities = current[groupId] || {};
      // Exact-distinct choices are a set, never a quantity. This mirrors the
      // server rule and prevents a flight slot being filled by repeating one drink.
      const value = group.selectionMode === 'EXACT_DISTINCT'
        ? (next > 0 ? 1 : 0)
        : Math.max(0, next);
      const updated = { ...groupQuantities, [optionId]: value };
      // Single-select groups behave like radios: choosing one clears the rest.
      if (group.selectionMode === 'SINGLE' && value > 0) {
        Object.keys(updated).forEach(id => { if (id !== optionId) updated[id] = 0; });
      }
      return { ...current, [groupId]: updated };
    });
  };

  const selectedCount = (group: AddOnGroup) => Object.values(quantities[group.id || ''] || {})
    .reduce((sum, value) => sum + Math.max(0, value), 0);

  const chosenSummary = selections
    .map(selection => (selection.quantity > 1 ? `${selection.optionName} × ${selection.quantity}` : selection.optionName))
    .join(' · ');

  return (
    <div className="cb-customer-sheet-scrim fixed inset-0 z-[80] flex items-end justify-center sm:items-center sm:p-4">
      <button type="button" aria-label="Close customization" className="absolute inset-0 h-full w-full" onClick={onCancel} />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="cb-customer-customize relative z-10 flex w-full flex-col overflow-hidden sm:max-w-md lg:max-w-lg"
      >
        {/* ---- Hero ------------------------------------------------------- */}
        <div className="cb-customer-customize-hero relative w-full shrink-0">
          <CustomerProductImage
            src={imageUrl}
            alt={productName}
            icon={fallbackIcon}
            iconClassName="text-[#5c4033]"
            className="h-full w-full rounded-none"
            priority
          />
          <div className="cb-customer-customize-scrim pointer-events-none absolute inset-x-0 top-0 h-24" aria-hidden="true" />
          <button
            ref={closeRef}
            type="button"
            onClick={onCancel}
            aria-label={`Close ${productName} options`}
            className="cb-customer-customize-close absolute left-4 top-4 flex h-11 w-11 items-center justify-center rounded-full"
          >
            <ArrowLeft size={19} aria-hidden="true" />
          </button>
        </div>

        {/* ---- Curved panel ----------------------------------------------- */}
        <div className="cb-customer-customize-panel relative -mt-7 flex min-h-0 flex-1 flex-col">
          <div className="cb-customer-customize-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-5 pb-4 pt-5">
            {categoryLabel && (
              <p className="cb-customer-usual-eyebrow text-[11px] font-black uppercase">{categoryLabel}</p>
            )}
            <div className="mt-1 flex items-start justify-between gap-3">
              <h2 id={titleId} className="min-w-0 cb-customer-title text-[22px] font-black leading-tight">
                {productName}
              </h2>
              <p className="shrink-0 cb-customer-title text-lg font-black">{formatMoney(basePrice)}</p>
            </div>
            {dietaryClassification && (
              <div className="mt-2"><DietaryMarker value={dietaryClassification} /></div>
            )}
            {description && (
              <p className="cb-customer-muted mt-2 text-[13px] font-semibold leading-relaxed">{description}</p>
            )}

            {droppedSelections.length > 0 && (
              <p className="cb-customer-usual-blocker mt-4 px-3 py-2 text-[12px] font-bold" role="status">
                {droppedSelections.map(selection => selection.optionName).join(', ')} is no longer available here.
                Choose again before updating.
              </p>
            )}

            {/* ---- Add-on groups ------------------------------------------ */}
            {groups.map(group => {
              const groupId = group.id || '';
              const entry = validation.find(candidate => candidate.group.id === group.id);
              const single = group.selectionMode === 'SINGLE';
              const exactDistinct = group.selectionMode === 'EXACT_DISTINCT';
              const maximum = group.maximumSelections === null || group.maximumSelections === undefined
                ? null
                : Math.max(0, Number(group.maximumSelections));
              const chosen = selectedCount(group);
              const remaining = maximum === null ? Number.POSITIVE_INFINITY : Math.max(0, maximum - chosen);
              const required = Math.max(0, Number(group.minimumSelections) || 0) > 0;

              return (
                <section key={groupId} className="mt-5" aria-labelledby={`${titleId}-${groupId}`}>
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 id={`${titleId}-${groupId}`} className="cb-customer-title text-[15px] font-black">
                      {group.name}
                    </h3>
                    {/* Stated in words, never colour alone. */}
                    <span className={`shrink-0 text-[11px] font-black uppercase ${required ? 'cb-customer-customize-required' : 'cb-customer-muted'}`}>
                      {groupRuleLabel(group)}
                    </span>
                  </div>

                  <div
                    className="cb-customer-customize-options mt-2 overflow-hidden"
                    role={single ? 'radiogroup' : 'group'}
                    aria-labelledby={`${titleId}-${groupId}`}
                  >
                    {(group.options || []).map(option => {
                      const optionQuantity = quantities[groupId]?.[option.id] || 0;
                      const selected = optionQuantity > 0;
                      const unavailable = option.isActive === false;
                      const atCeiling = !selected && remaining <= 0;
                      const price = Math.max(0, Number(option.price) || 0);
                      const priceLabel = price > 0 ? `+${formatMoney(price)}` : 'No extra charge';

                      return (
                        <div
                          key={option.id}
                          className={`cb-customer-customize-option flex min-h-14 items-center justify-between gap-3 px-3 py-2.5 ${
                            selected ? 'is-selected' : ''
                          } ${unavailable ? 'is-unavailable' : ''}`}
                        >
                          <button
                            type="button"
                            role={single ? 'radio' : 'checkbox'}
                            aria-checked={selected}
                            aria-label={`${option.name}, ${priceLabel}${unavailable ? ', unavailable' : ''}`}
                            disabled={unavailable || (atCeiling && !single)}
                            onClick={() => setOptionQuantity(group, option.id, selected ? 0 : 1)}
                            className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:opacity-45"
                          >
                            <span className={`cb-customer-customize-tick flex h-5 w-5 shrink-0 items-center justify-center ${single ? 'is-radio' : ''} ${selected ? 'is-on' : ''}`} aria-hidden="true">
                              {selected ? '✓' : ''}
                            </span>
                            <span className="min-w-0">
                              <span className="block break-words cb-customer-title text-sm font-black">{option.name}</span>
                              <span className="block cb-customer-muted text-xs font-bold">
                                {priceLabel}{unavailable ? ' · Unavailable' : ''}
                              </span>
                            </span>
                          </button>

                          {/* Ordinary multi-select options retain their existing quantity
                              control. Single and exact-distinct choices stay at one. */}
                          {!single && !exactDistinct && selected && !unavailable && (
                            <CustomerQuantityControl
                              value={optionQuantity}
                              min={0}
                              max={maximum === null ? undefined : optionQuantity + remaining}
                              label={option.name}
                              size="sm"
                              onChange={next => setOptionQuantity(group, option.id, next)}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {entry && !entry.result.ok && (
                    <p className="cb-customer-customize-problem mt-2 text-[12px] font-black" role="status">
                      {entry.result.message}
                    </p>
                  )}
                </section>
              );
            })}

            {/* ---- Quantity ------------------------------------------------ */}
            <section className="mt-6 flex items-center justify-between gap-3" aria-label="Quantity">
              <div>
                <h3 className="cb-customer-title text-[15px] font-black">Quantity</h3>
                {chosenSummary && (
                  <p id={summaryId} className="cb-customer-muted mt-0.5 text-[12px] font-bold">{chosenSummary}</p>
                )}
              </div>
              <CustomerQuantityControl
                value={quantity}
                min={1}
                max={maxQuantity}
                label={productName}
                onChange={next => setQuantity(Math.min(Math.max(1, next), maxQuantity))}
              />
            </section>
          </div>

          {/* ---- Sticky action ------------------------------------------- */}
          <div className="cb-customer-customize-footer shrink-0 px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
            <p className="sr-only" role="status" aria-live="polite">
              {firstProblem || `Item total ${formatMoney(itemTotal)}`}
            </p>
            {firstProblem && (
              <p className="cb-customer-customize-problem mb-2 text-center text-[12px] font-black">{firstProblem}</p>
            )}
            <button
              type="button"
              disabled={!isValid || submitting}
              onClick={() => onConfirm(selections, quantity)}
              aria-label={`${isEditing ? 'Update item' : 'Add item'}, total ${formatMoney(itemTotal)}`}
              className="cb-customer-accent-button min-h-12 w-full rounded-2xl px-5 text-sm font-black disabled:cursor-not-allowed disabled:opacity-45"
            >
              {isEditing ? 'Update item' : 'Add item'} · {formatMoney(itemTotal)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
