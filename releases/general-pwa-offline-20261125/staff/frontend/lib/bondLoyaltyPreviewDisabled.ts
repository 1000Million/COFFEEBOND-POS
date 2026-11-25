// Production/customer builds resolve the preview-only module to this data-free
// implementation. The real demo states are bundled only for the exact preview
// mode + preview Firebase project pair in vite.customer.config.ts.
export const BOND_DEMO_STATES = {};
export const BOND_DEMO_SELECTOR_LABEL = '';
export const BOND_DEMO_SELECTOR_NOTE = '';
export const BOND_PREVIEW_ORDER = null;
export const BOND_PREVIEW_ORDER_NOTICE = '';

export function bondDemoStateFromSearch(): null {
  return null;
}
