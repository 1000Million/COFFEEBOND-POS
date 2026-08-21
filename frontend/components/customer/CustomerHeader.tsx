import React, { ReactNode, useEffect, useRef, useState } from 'react';
import { Loader2, UserRound, Wheat } from 'lucide-react';
import { Link } from 'react-router-dom';
import { CustomerProfile } from '../../lib/customerAuth';
import CustomerAccountSheet from './CustomerAccountSheet';
import {
  CUSTOMER_ACCOUNT_PATH,
  CUSTOMER_HOME_PATH,
  CUSTOMER_MY_ORDERS_PATH,
  IS_CUSTOMER_ORIGIN_BUILD,
} from '../../lib/customerRoutes';

type Props = {
  title: string;
  profile: CustomerProfile | null;
  authRestored: boolean;
  onProfileUpdated?: (profile: CustomerProfile) => void;
  onSignedOut?: () => void;
  rightSlot?: ReactNode;
  /** Real balance from getCustomerBondSummary. Omitted when the summary is unavailable. */
  pointsBalance?: number | null;
  /**
   * Suppresses the header's own account control.
   *
   * Screens may use this only when they deliberately supply an equivalent account
   * control elsewhere. The Order home keeps the compact avatar because it is part of
   * the approved composition; the mobile Account tab remains the route-level doorway.
   */
  hideAccountAction?: boolean;
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
  pointsBalance = null,
  hideAccountAction = false,
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
  const initials = profile?.displayName
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase())
    .join('') || '';
  const showPointsBadge = Number.isFinite(pointsBalance);
  const compactPoints = showPointsBadge
    ? new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(pointsBalance))
    : '';

  return (
    <>
      <header className={`${sticky ? 'sticky top-0 z-30' : ''} cb-customer-header`}>
        <div className="mx-auto flex h-[58px] w-full min-w-0 items-center justify-between gap-2 px-4 lg:max-w-6xl lg:px-6">
          <Link to={CUSTOMER_HOME_PATH} className="cb-customer-brand flex min-h-11 min-w-0 items-center gap-2 focus:outline-none">
            <span
              className={`cb-customer-brand-mark${IS_CUSTOMER_ORIGIN_BUILD ? ' is-official' : ''}`}
              aria-hidden="true"
            >
              {IS_CUSTOMER_ORIGIN_BUILD ? (
                <img
                  src="/pwa/coffee-bond-mark.svg"
                  alt=""
                  width="38"
                  height="38"
                  className="cb-customer-official-mark"
                />
              ) : (
                <Wheat size={29} strokeWidth={1.6} />
              )}
            </span>
            <span className="cb-customer-wordmark whitespace-nowrap">
              Coffee <em>Bond</em>
            </span>
            <span className="sr-only">{title}</span>
          </Link>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {hideAccountAction ? null : !authRestored ? (
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
                className="cb-customer-avatar-button relative inline-flex h-11 w-11 items-center justify-center rounded-full text-left focus:outline-none"
                aria-label={`Open customer account${showPointsBadge ? `, ${Number(pointsBalance).toLocaleString('en-IN')} BOND points` : ''}`}
              >
                <span className="cb-customer-avatar" aria-hidden="true">
                  {initials ? <span>{initials}</span> : <UserRound size={20} />}
                </span>
                {showPointsBadge && identityOnTrigger && (
                  <span className="cb-customer-avatar-points" aria-hidden="true">
                    {compactPoints}
                  </span>
                )}
              </button>
            ) : onSignedOutAccountPress ? (
              /* Below lg the route bar owns navigation and this stays a compact account
                 control. On desktop the account route is explicit; the home screen
                 supplies its separate Orders link alongside the basket. */
              <>
                <button
                  type="button"
                  onClick={onSignedOutAccountPress}
                  className="cb-customer-avatar-button inline-flex h-11 w-11 items-center justify-center rounded-full focus:outline-none lg:hidden"
                  aria-label="Customer account"
                >
                  <UserRound size={19} />
                </button>
                <Link
                  to={CUSTOMER_ACCOUNT_PATH}
                  className="cb-customer-avatar-button hidden h-11 items-center gap-1.5 rounded-full px-3 text-xs font-bold focus:outline-none lg:inline-flex"
                  aria-label="Customer account"
                >
                  <UserRound size={17} />
                  <span>Account</span>
                </Link>
              </>
            ) : (
              <Link
                to={CUSTOMER_MY_ORDERS_PATH}
                className="cb-customer-avatar-button inline-flex h-11 w-11 items-center justify-center rounded-full text-xs font-bold focus:outline-none sm:w-auto sm:gap-1.5 sm:px-3"
                aria-label="Customer account and My Orders"
              >
                <UserRound size={17} />
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
