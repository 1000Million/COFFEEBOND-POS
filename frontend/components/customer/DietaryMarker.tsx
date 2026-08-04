import { dietaryLabel, DietaryClassification } from '../../lib/customerMenuPresentation';

export default function DietaryMarker({ value, compact = false }: { value: DietaryClassification; compact?: boolean }) {
  const label = dietaryLabel(value);
  const markerClass = value === 'VEGETARIAN'
    ? 'border-emerald-700 text-emerald-800'
    : value === 'NON_VEGETARIAN'
      ? 'border-red-700 text-red-800'
      : 'border-amber-700 text-amber-800';
  const dotClass = value === 'VEGETARIAN'
    ? 'bg-emerald-700'
    : value === 'NON_VEGETARIAN'
      ? 'bg-red-700'
      : 'bg-amber-700';

  return (
    <span className={`inline-flex items-center gap-1.5 font-bold ${compact ? 'text-[10px]' : 'text-xs'} ${markerClass}`} aria-label={label} title={label}>
      <span className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm border ${markerClass}`} aria-hidden="true">
        <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
      </span>
      {!compact && <span>{label}</span>}
    </span>
  );
}
