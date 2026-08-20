/**
 * Customer menu search matching.
 *
 * The previous implementation was a single `haystack.includes(query)` over one joined
 * string, which matched anywhere inside a word: searching "latte" returned
 * "Mediterranean Mezze Platter", because "platter" literally contains "latte". That is
 * the defect this module exists to fix (UI-3).
 *
 * The rule here is word-PREFIX matching over normalised tokens:
 *
 *   - text is lowercased, stripped of diacritics and split on anything that is not a
 *     letter or a number, so "Caffè Latte", "CAFFE-LATTE" and "caffe latte" tokenise
 *     identically;
 *   - every word of the query must match at least one word of the product, so "cold
 *     brew" narrows rather than widens;
 *   - a query word matches a product word only when the product word STARTS with it,
 *     so "latte" matches "Latte" and "Caffè Latte" but never "Platter".
 *
 * Prefix rather than whole-word matching is deliberate: customers type partial words
 * ("cap" for Cappuccino, "fra" for frappe) and expect results while typing.
 *
 * This is presentation-side filtering only. It issues no query, builds no index and
 * changes no product, pricing, availability or ordering behaviour.
 */

/**
 * Lowercase, strip diacritics, and reduce every run of punctuation or whitespace to a
 * single space. "Caffè Latte (Large)" becomes "caffe latte large".
 */
export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Normalised, de-duplicated words. An empty query yields an empty list. */
export function searchTokens(value: string): string[] {
  const normalized = normalizeSearchText(value);
  if (!normalized) return [];
  return Array.from(new Set(normalized.split(' ').filter(Boolean)));
}

/**
 * True when every query word prefixes at least one word of any supplied field.
 *
 * Fields are the customer-visible name, the product code and the description — the same
 * three the previous implementation concatenated, kept separate here only so a match in
 * one cannot bleed across a boundary into another.
 *
 * An empty query matches everything, which is what the unfiltered menu expects.
 */
export function matchesCustomerSearch(fields: Array<string | null | undefined>, query: string): boolean {
  const queryWords = searchTokens(query);
  if (queryWords.length === 0) return true;

  const productWords = new Set<string>();
  for (const field of fields) {
    if (!field) continue;
    for (const word of searchTokens(field)) productWords.add(word);
  }
  if (productWords.size === 0) return false;

  return queryWords.every(queryWord => {
    for (const productWord of productWords) {
      if (productWord.startsWith(queryWord)) return true;
    }
    return false;
  });
}
