import { Minus, Plus } from 'lucide-react';

type Props = {
  value: number;
  /** Decrease is disabled at this value. */
  min?: number;
  /** Increase is disabled at this value. Omit for no ceiling. */
  max?: number;
  /** Used to build the accessible names, e.g. "Oat milk" -> "Add Oat milk". */
  label: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  onChange: (next: number) => void;
};

/**
 * Compact stepper shared by the product quantity and each add-on option.
 *
 * It owns no rules: the caller supplies the current value and the bounds it has
 * already derived from authoritative add-on data, and receives the requested next
 * value. Every control is a 44px touch target.
 */
export default function CustomerQuantityControl({
  value,
  min = 0,
  max,
  label,
  size = 'md',
  disabled = false,
  onChange,
}: Props) {
  const canDecrease = !disabled && value > min;
  const canIncrease = !disabled && (max === undefined || value < max);
  const button = size === 'sm' ? 'h-11 w-11' : 'h-11 w-11';

  return (
    <div className="cb-customer-stepper inline-flex shrink-0 items-center p-1">
      <button
        type="button"
        onClick={() => onChange(value - 1)}
        disabled={!canDecrease}
        aria-label={`Remove ${label}`}
        className={`flex ${button} items-center justify-center rounded-full text-[#5c4033] disabled:opacity-30`}
      >
        <Minus size={15} aria-hidden="true" />
      </button>
      <span className="w-7 text-center text-sm font-black tabular-nums" aria-hidden="true">{value}</span>
      <button
        type="button"
        onClick={() => onChange(value + 1)}
        disabled={!canIncrease}
        aria-label={`Add ${label}`}
        className={`flex ${button} items-center justify-center rounded-full bg-[#5c4033] text-white disabled:opacity-30`}
      >
        <Plus size={15} aria-hidden="true" />
      </button>
    </div>
  );
}
