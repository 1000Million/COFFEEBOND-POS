import { useEffect, useState } from 'react';

/**
 * Anything the customer could be part-way through, where a bottom-anchored install
 * banner would sit on top of the control they are reaching for:
 *
 *   [aria-modal="true"]          any dialog — customisation, basket, My Usual, store
 *   .cb-customer-layer-modal     the app's modal layer wrapper
 *   .cb-customer-sheet           bottom sheets
 *   .cb-customer-action-bar      the sticky checkout CTA and its pre-payment caveat
 *
 * The action bar matters as much as the dialogs: it is the control that opens Razorpay,
 * and the caveat above it is the last thing the customer reads before paying.
 */
export const TRANSACTIONAL_OVERLAY_SELECTOR = [
  '[aria-modal="true"]',
  '.cb-customer-layer-modal',
  '.cb-customer-sheet',
  '.cb-customer-action-bar',
].join(',');

/**
 * True while any transactional overlay is on screen.
 *
 * UI-9. This is deliberately presence-based rather than a z-index race. The install
 * prompt renders at z-95 while the modal layer sits at z-85, so it out-ranks every
 * sheet; stacking it below them instead would mean every future overlay has to remember
 * to out-rank it, and the first one that forgets covers a payment button. Asking "is the
 * customer mid-transaction?" and standing down is the rule that cannot be forgotten.
 *
 * A MutationObserver is used rather than polling so the banner disappears in the same
 * frame the sheet opens. This reads the DOM only — it changes no install, service-worker
 * or update behaviour.
 */
export function useTransactionalOverlayOpen(): boolean {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const read = () => setOpen(Boolean(document.querySelector(TRANSACTIONAL_OVERLAY_SELECTOR)));
    read();

    const observer = new MutationObserver(read);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'aria-modal'],
    });
    return () => observer.disconnect();
  }, []);

  return open;
}
