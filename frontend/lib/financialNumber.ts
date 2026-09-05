/**
 * Finite numeric coercion for money-shaped values. NOT a rounding policy - it introduces no
 * precision change at all, so it cannot drift a canonical value.
 *
 * Extracted verbatim from the identical private helpers that existed in
 * pages/pos/RunningOrders.tsx and pages/reports/DayClose.tsx, so both now share one definition
 * and the G7.3 drift guard can exercise it. Canonical quantization lives in
 * lib/posPricing.quantizeMoney and is unaffected.
 */
export function financialNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
