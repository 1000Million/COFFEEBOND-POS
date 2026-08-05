import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ClipboardList, Search, ShoppingBag, UserRound, UtensilsCrossed } from 'lucide-react';
import { CUSTOMER_HOME_PATH, CUSTOMER_MY_ORDERS_PATH } from '../../lib/customerRoutes';

type Props = {
  /** Total units in the basket. Drives the badge and the bump animation. */
  itemCount: number;
  /** Formatted basket total, announced with the basket action. */
  totalLabel?: string;
  /** Opens the existing basket sheet — this component owns no cart logic. */
  onOpenBasket: () => void;
  /** Focuses the existing menu search input. */
  onFocusSearch: () => void;
  /** Scrolls back to the top of the menu when already on the home route. */
  onGoToMenu: () => void;
  /** Opens the screen's existing account/verification affordance. */
  onOpenAccount: () => void;
};

/**
 * Persistent customer bottom navigation.
 *
 * Presentational only: it renders links and raises callbacks. Cart, checkout and
 * account state stay in the screens that already own them.
 *
 * The Account entry raises onOpenAccount rather than navigating: the customer origin
 * has no standalone account route, so this reuses the screen's existing account and
 * verification affordance instead of inventing one.
 *
 * The raised basket button bumps once whenever the item count increases; .cb-bump is
 * a no-op under prefers-reduced-motion.
 */
export default function CustomerBottomNav({
  itemCount,
  totalLabel,
  onOpenBasket,
  onFocusSearch,
  onGoToMenu,
  onOpenAccount,
}: Props) {
  const { pathname } = useLocation();
  const [bumpKey, setBumpKey] = useState(0);
  const previousCount = useRef(itemCount);

  useEffect(() => {
    if (itemCount > previousCount.current) setBumpKey((key) => key + 1);
    previousCount.current = itemCount;
  }, [itemCount]);

  const onHome = pathname === CUSTOMER_HOME_PATH;
  const onMyOrders = pathname === CUSTOMER_MY_ORDERS_PATH;

  const itemClass = (active: boolean) => [
    'flex min-h-[44px] min-w-[44px] flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl px-1 text-[11px] font-black',
    active ? 'cb-customer-nav-item-active' : 'cb-customer-nav-item',
  ].join(' ');

  const basketLabel = totalLabel
    ? `Open basket with ${itemCount} item${itemCount === 1 ? '' : 's'}, ${totalLabel}`
    : `Open basket with ${itemCount} item${itemCount === 1 ? '' : 's'}`;

  return (
    /* Mobile/tablet only. On lg the desktop layout keeps its sticky basket panel and
       the header basket entry, so showing this too would duplicate the control. */
    <nav aria-label="Customer app" className="cb-customer-bottom-nav fixed inset-x-0 bottom-0 z-40 lg:hidden">
      <div className="mx-auto flex h-16 max-w-lg items-center justify-around gap-1 px-2">
        <Link
          to={CUSTOMER_HOME_PATH}
          onClick={() => { if (onHome) onGoToMenu(); }}
          className={itemClass(onHome)}
          aria-current={onHome ? 'page' : undefined}
        >
          <UtensilsCrossed size={20} aria-hidden="true" />
          Menu
        </Link>

        <Link to={CUSTOMER_MY_ORDERS_PATH} className={itemClass(onMyOrders)} aria-current={onMyOrders ? 'page' : undefined}>
          <ClipboardList size={20} aria-hidden="true" />
          Orders
        </Link>

        {/* Raised basket action. The page reserves .cb-customer-page-bottom so this
            never covers content. */}
        <button
          type="button"
          onClick={onOpenBasket}
          data-requires-online="true"
          aria-label={basketLabel}
          className="cb-customer-basket-button relative -mt-7 flex h-14 w-14 shrink-0 items-center justify-center rounded-full"
        >
          <span key={bumpKey} className={bumpKey ? 'cb-bump flex items-center justify-center' : 'flex items-center justify-center'}>
            <ShoppingBag size={22} aria-hidden="true" />
          </span>
          {itemCount > 0 && (
            <span
              className="cb-customer-basket-badge absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-black"
              aria-hidden="true"
            >
              {itemCount}
            </span>
          )}
        </button>

        <button type="button" onClick={onFocusSearch} className={itemClass(false)}>
          <Search size={20} aria-hidden="true" />
          Search
        </button>

        {/* Invokes the screen's existing account/verification affordance. No new auth
            route or implementation is introduced here. */}
        <button type="button" onClick={onOpenAccount} className={itemClass(false)} aria-label="Customer account">
          <UserRound size={20} aria-hidden="true" />
          Account
        </button>
      </div>
    </nav>
  );
}
