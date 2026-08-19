import React, { ReactNode, useEffect, useRef, useState } from 'react';
import { Loader2, UserCircle2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import coffeeBondLogo from '../../assets/coffee-bond-logo.png';
import { CustomerProfile } from '../../lib/customerAuth';
import CustomerAccountSheet, { maskedPhone } from './CustomerAccountSheet';
import { CUSTOMER_HOME_PATH, CUSTOMER_MY_ORDERS_PATH } from '../../lib/customerRoutes';

type Props = {
  title: string;
  profile: CustomerProfile | null;
  authRestored: boolean;
  onProfileUpdated?: (profile: CustomerProfile) => void;
  onSignedOut?: () => void;
  rightSlot?: ReactNode;
  sticky?: boolean;
  /**
   * Supplied by screens that already expose a My Orders destination in the bottom
   * navigation. When present, the signed-out header control becomes a plain account
   * button that raises this callback instead of linking to /my-orders, so the home
   * screen has exactly one direct My Orders link.
   *
   * When omitted (order status, and any screen without the bottom navigation) the
   * control stays a link to My Orders, so account access is never lost.
   */
  onSignedOutAccountPress?: () => void;
  /**
   * Raised by the account panel's "My Usual" row. Every screen routes this to the
   * existing home-screen Stage 2 surface rather than rendering a second copy of it.
   */
  onOpenMyUsual?: () => void;
};

export default function CustomerHeader({
  title,
  profile,
  authRestored,
  onProfileUpdated,
  onSignedOut,
  rightSlot,
  sticky = false,
  onSignedOutAccountPress,
  onOpenMyUsual,
}: Props) {
  const [accountOpen, setAccountOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  /* Set only on a plain close (X, scrim, Escape). The My Usual row hands focus to the
     home-screen card instead, so restoring here would immediately steal it back. */
  const restoreFocusRef = useRef(false);

  /* Focus returns to the control that opened the sheet — after the render that clears
     `inert`, never during the click handler, because an inert element cannot take focus. */
  useEffect(() => {
    if (accountOpen || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    triggerRef.current?.focus();
  }, [accountOpen]);

  /*
   * While the sheet is open it is the single owner of the customer's identity. The
   * trigger keeps its place in the header but falls back to its icon-only form, so the
   * name and masked phone are not printed a second time behind the scrim at >= 640 px,
   * where the trigger is otherwise wide enough to show them.
   */
  const identityOnTrigger = !accountOpen;

  return (
    <>
      <header className={`${sticky ? 'sticky top-0 z-30' : ''} border-b border-[#eadfd3]/80 bg-[#fbf7f1]/95 px-4 pt-[max(env(safe-area-inset-top),0px)] backdrop-blur`}>
        <div className="mx-auto flex min-h-[60px] w-full min-w-0 items-center justify-between gap-2 py-1.5 lg:max-w-6xl">
          <Link to={CUSTOMER_HOME_PATH} className="flex min-h-11 min-w-0 items-center gap-2 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5e42]/60">
            <img src={coffeeBondLogo} alt="" className="h-9 w-9 shrink-0 rounded-xl bg-white object-contain p-1 shadow-sm" />
            <div className="min-w-0">
              <p className="whitespace-nowrap text-sm font-black uppercase text-[#271a16]">Coffee Bond</p>
              {/* A brand subtitle, not the page heading. Each screen owns its own
                  h1, so promoting this one would give every page two. */}
              <p className="hidden truncate text-[11px] font-bold leading-tight text-[#8b5e42] sm:block">{title}</p>
            </div>
          </Link>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {!authRestored ? (
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white text-[#8b5e42]" aria-label="Restoring customer session">
                <Loader2 size={17} className="animate-spin" />
              </span>
            ) : profile ? (
              <button
                ref={triggerRef}
                type="button"
                onClick={() => setAccountOpen(true)}
                /* inert while the sheet is open: the scrim already blocks the pointer,
                   this is what also takes the trigger out of the tab order and out of
                   the accessibility tree, so it cannot be reached behind the dialog. */
                inert={accountOpen}
                aria-haspopup="dialog"
                aria-expanded={accountOpen}
                className={`inline-flex h-11 w-11 items-center justify-center rounded-full bg-white text-left shadow-sm ring-1 ring-[#e7ddd3] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5e42]/60${
                  identityOnTrigger ? ' sm:w-auto sm:max-w-[148px] sm:justify-start sm:gap-2 sm:px-2.5' : ''
                }`}
                aria-label="Open customer account"
              >
                <UserCircle2 size={20} className="shrink-0 text-[#8b5e42]" />
                <span className={identityOnTrigger ? 'hidden min-w-0 sm:block' : 'hidden'}>
                  <span className="block truncate text-xs font-black text-[#2d2019]">{profile.displayName || 'My account'}</span>
                  <span className="block truncate text-[11px] font-bold text-emerald-700">{maskedPhone(profile.normalisedPhone)}</span>
                </span>
              </button>
            ) : onSignedOutAccountPress ? (
              /* The bottom navigation owns the My Orders destination, but it is
                 mobile-only (lg:hidden). So below lg the header is a plain account
                 control, and from lg — where the bar is gone — it becomes the My
                 Orders link again. Exactly one visible entry at every breakpoint. */
              <>
                <button
                  type="button"
                  onClick={onSignedOutAccountPress}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-white text-xs font-black text-[#5c4033] shadow-sm ring-1 ring-[#e7ddd3] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5e42]/60 lg:hidden"
                  aria-label="Customer account"
                >
                  <UserCircle2 size={17} />
                </button>
                <Link
                  to={CUSTOMER_MY_ORDERS_PATH}
                  className="hidden h-11 items-center gap-1.5 rounded-full bg-white px-3 text-xs font-black text-[#5c4033] shadow-sm ring-1 ring-[#e7ddd3] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5e42]/60 lg:inline-flex"
                  aria-label="Customer account and My Orders"
                >
                  <UserCircle2 size={17} />
                  <span>Account</span>
                </Link>
              </>
            ) : (
              <Link
                to={CUSTOMER_MY_ORDERS_PATH}
                className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-white text-xs font-black text-[#5c4033] shadow-sm ring-1 ring-[#e7ddd3] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5e42]/60 sm:w-auto sm:gap-1.5 sm:px-3"
                aria-label="Customer account and My Orders"
              >
                <UserCircle2 size={17} />
                <span className="hidden sm:inline">Account</span>
              </Link>
            )}
            {rightSlot}
          </div>
        </div>
      </header>

      {/* One account surface for the whole customer app. Stage 5 removed the
          My Orders and Current Order rows from it — Orders owns both. */}
      {accountOpen && profile && (
        <CustomerAccountSheet
          profile={profile}
          onClose={() => {
            restoreFocusRef.current = true;
            setAccountOpen(false);
          }}
          onProfileUpdated={onProfileUpdated}
          onSignedOut={onSignedOut}
          onOpenMyUsual={() => {
            /* Focus follows the customer to the My Usual card, so it must not be
               pulled back to this trigger. */
            restoreFocusRef.current = false;
            setAccountOpen(false);
            onOpenMyUsual?.();
          }}
        />
      )}
    </>
  );
}
