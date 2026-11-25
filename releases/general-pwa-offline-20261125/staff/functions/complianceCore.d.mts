export function safeCell(value: unknown): string | number | boolean;
export function normalizeBill(record?: Record<string, unknown>, context?: Record<string, unknown>): import('../frontend/lib/gstReporting').GstRecord;
export function createComplianceAccumulator(context?: Record<string, unknown>): {
  add(record: import('../frontend/lib/gstReporting').GstRecord): unknown;
  finish(): import('../frontend/lib/gstReporting').GstAggregate;
};
