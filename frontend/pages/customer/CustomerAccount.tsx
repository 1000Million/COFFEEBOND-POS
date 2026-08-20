import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, UserRound } from 'lucide-react';
import CustomerHeader from '../../components/customer/CustomerHeader';
import CustomerBottomNav from '../../components/customer/CustomerBottomNav';
import CustomerAccountSheet from '../../components/customer/CustomerAccountSheet';
import {
  CustomerProfile,
  restoreCustomerProfile,
  waitForCustomerAuthRestoration,
} from '../../lib/customerAuth';
import { CUSTOMER_HOME_PATH } from '../../lib/customerRoutes';

/**
 * The /account route.
 *
 * Account used to exist only as a sheet raised from the header, which meant it could not
 * be refreshed, deep-linked or reached with the back button. This page gives it a real
 * URL while reusing the very same panel component in its 'page' presentation, so there
 * is still exactly one account implementation and one place that writes a profile.
 *
 * It owns no auth: it restores the existing verified session and renders a prompt when
 * there is none. No OTP, order, basket or payment logic appears here.
 */
export default function CustomerAccount() {
  const navigate = useNavigate();
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [authRestored, setAuthRestored] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      await waitForCustomerAuthRestoration();
      const restored = await restoreCustomerProfile();
      if (!active) return;
      setProfile(restored);
      setAuthRestored(true);
    })();
    return () => { active = false; };
  }, []);

  const goHome = () => navigate(CUSTOMER_HOME_PATH);

  return (
    <div className="cb-app cb-customer-page-bottom min-h-[100dvh] min-w-0 overflow-x-hidden bg-[#fbf7f1] font-sans text-[#271a16] [padding-left:env(safe-area-inset-left)] [padding-right:env(safe-area-inset-right)]">
      <CustomerHeader
        title="Account"
        profile={profile}
        authRestored={authRestored}
        onProfileUpdated={setProfile}
        onSignedOut={() => setProfile(null)}
        /* This page IS Account, so the header must not offer a second way in. */
        onSignedOutAccountPress={goHome}
        onOpenMyUsual={goHome}
      />

      <main className="mx-auto min-w-0 max-w-2xl px-4 pt-6">
        <h1 className="cb-customer-screen-title">Your account</h1>

        {!authRestored ? (
          <p className="sr-only" role="status" aria-live="polite">Loading your account</p>
        ) : profile ? (
          <div className="mt-5">
            <CustomerAccountSheet
              presentation="page"
              profile={profile}
              onClose={goHome}
              onProfileUpdated={setProfile}
              onSignedOut={() => setProfile(null)}
              onOpenMyUsual={goHome}
            />
          </div>
        ) : (
          <div className="cb-customer-orders-void">
            <p className="cb-customer-standfirst">Verify your mobile number to see your account.</p>
            <p className="cb-customer-lede mt-2">You’ll be asked to verify securely at checkout.</p>
            <button
              type="button"
              onClick={goHome}
              className="cb-customer-accent-button mt-6 inline-flex min-h-12 items-center gap-2 rounded-2xl px-5 text-sm font-black"
            >
              <UserRound size={17} aria-hidden="true" />
              Browse menu
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </div>
        )}
      </main>

      <CustomerBottomNav />
    </div>
  );
}
