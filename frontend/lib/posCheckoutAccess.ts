export function canReadMissingCheckoutOrder(role?: string): boolean {
  return role === 'ADMIN';
}

export function isCheckoutPermissionError(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const code = String(candidate?.code || '').toLowerCase();
  const message = String(candidate?.message || '').toLowerCase();
  return code.includes('permission-denied') || message.includes('permission');
}

export function canTreatCheckoutOrderReadAsMissing(error: unknown, role?: string): boolean {
  return !canReadMissingCheckoutOrder(role) && isCheckoutPermissionError(error);
}
