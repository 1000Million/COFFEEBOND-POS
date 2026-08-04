import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { applyPwaIdentityForPath } from '../lib/customerPwaIdentity';

/**
 * Keeps the advertised web app manifest and Apple metadata aligned with the
 * current route, so the customer ordering app and the staff POS app install as
 * two separate home-screen apps. Renders nothing.
 *
 * See frontend/lib/customerPwaIdentity.ts for the documented Chromium limitation
 * around swapping manifests inside an already-open tab.
 */
export default function PwaIdentitySync() {
  const { pathname } = useLocation();

  useEffect(() => {
    applyPwaIdentityForPath(pathname);
  }, [pathname]);

  return null;
}
