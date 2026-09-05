export type CustomerSignatureCandidate = {
  code: string;
  name?: string;
  displayName?: string;
};

const SIGNATURE_IDENTITIES = [
  ['BOND FRAPPE'],
  ['ICED VIETNAMESE'],
  ['MAGIK', 'MAGIK TEAM FAVORITE'],
] as const;

function normalizeSignatureIdentity(value: string | undefined): string {
  return (value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toUpperCase();
}

/**
 * Finds the owner-approved signature drinks by exact, normalized menu identity.
 *
 * The caller supplies only items already proven orderable at the current store. This
 * helper deliberately does not infer availability, prices or fallback products, and
 * exact matching prevents an unrelated product with a similar name from becoming a
 * first-open shortcut.
 */
export function selectCustomerHomeSignatures<T extends CustomerSignatureCandidate>(
  orderableItems: readonly T[],
): T[] {
  const claimedCodes = new Set<string>();

  return SIGNATURE_IDENTITIES.flatMap(aliases => {
    const item = orderableItems.find(candidate => {
      if (claimedCodes.has(candidate.code)) return false;
      const identities = [candidate.code, candidate.displayName, candidate.name]
        .map(normalizeSignatureIdentity)
        .filter(Boolean);
      return aliases.some(alias => identities.includes(alias));
    });
    if (!item) return [];
    claimedCodes.add(item.code);
    return [item];
  });
}
