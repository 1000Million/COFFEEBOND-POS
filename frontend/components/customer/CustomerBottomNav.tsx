import { Link, useLocation } from 'react-router-dom';
import { ClipboardList, Sparkles, UserRound, UtensilsCrossed } from 'lucide-react';
import {
  CUSTOMER_ACCOUNT_PATH,
  CUSTOMER_BOND_PATH,
  CUSTOMER_HOME_PATH,
  CUSTOMER_MY_ORDERS_PATH,
} from '../../lib/customerRoutes';

/**
 * Persistent customer bottom navigation: Order, Orders, Bond, Account.
 *
 * Three DESTINATIONS, nothing else. The previous bar carried five actions, two of which
 * were not destinations at all:
 *
 *   Search  pointed back at the search field already on the Order screen, so tapping it
 *           never left the page it was on.
 *   Cart    was a permanently raised button that, with an empty basket, was a dead
 *           control occupying the most prominent position in the app.
 *
 * The basket is now contextual — CustomerBasketBar appears above this bar only once the
 * basket has something in it — so nothing here depends on cart state and this component
 * takes no cart props at all.
 *
 * Presentational and route-driven: it renders links and reads the current path. It owns
 * no cart, checkout or account state.
 */
export default function CustomerBottomNav() {
  const { pathname } = useLocation();

  const onHome = pathname === CUSTOMER_HOME_PATH;
  /* A live order opened from Orders keeps Orders lit, so tracking does not read as a
     place the customer has navigated out of the app. */
  const onMyOrders = pathname === CUSTOMER_MY_ORDERS_PATH || /(^|\/)status\//.test(pathname);
  const onBond = pathname === CUSTOMER_BOND_PATH;
  const onAccount = pathname === CUSTOMER_ACCOUNT_PATH;

  const itemClass = (active: boolean) => [
    'flex min-h-[44px] min-w-[44px] flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl px-1 text-[11px] font-black',
    active ? 'cb-customer-nav-item-active' : 'cb-customer-nav-item',
  ].join(' ');

  return (
    /* Mobile/tablet only. On lg the desktop layout keeps its sticky basket panel and the
       header basket entry, so showing this too would duplicate the control. */
    <nav aria-label="Customer app" className="cb-customer-bottom-nav fixed inset-x-0 bottom-0 z-40 lg:hidden">
      <div className="mx-auto flex h-16 max-w-lg items-center justify-around gap-1 px-2">
        <Link
          to={CUSTOMER_HOME_PATH}
          className={itemClass(onHome)}
          aria-current={onHome ? 'page' : undefined}
        >
          <UtensilsCrossed size={20} aria-hidden="true" />
          Order
        </Link>

        <Link
          to={CUSTOMER_MY_ORDERS_PATH}
          className={itemClass(onMyOrders)}
          aria-current={onMyOrders ? 'page' : undefined}
        >
          <ClipboardList size={20} aria-hidden="true" />
          Orders
        </Link>

        {/* THE BOND. A real destination backed by the Codex loyalty dashboard and the
            getCustomerBondSummary callable — never a placeholder or a fabricated
            balance. Its content is gated by the server's own feature flags. */}
        <Link
          to={CUSTOMER_BOND_PATH}
          className={itemClass(onBond)}
          aria-current={onBond ? 'page' : undefined}
        >
          <Sparkles size={20} aria-hidden="true" />
          Bond
        </Link>

        <Link
          to={CUSTOMER_ACCOUNT_PATH}
          className={itemClass(onAccount)}
          aria-current={onAccount ? 'page' : undefined}
        >
          <UserRound size={20} aria-hidden="true" />
          Account
        </Link>
      </div>
    </nav>
  );
}
