import { Link, useLocation } from 'react-router-dom';
import { House, ReceiptText, Sparkles, UtensilsCrossed } from 'lucide-react';
import {
  CUSTOMER_BOND_PATH,
  CUSTOMER_HOME_PATH,
  CUSTOMER_MY_ORDERS_PATH,
} from '../../lib/customerRoutes';

const MENU_HASH = '#cb-full-menu';

/** Four destinations only. Basket access is contextual and stays with the Menu screen. */
export default function CustomerBottomNav() {
  const { pathname, hash } = useLocation();

  const onHomeRoute = pathname === CUSTOMER_HOME_PATH;
  const onMenu = onHomeRoute && hash === MENU_HASH;
  const onHome = onHomeRoute && !onMenu;
  /* A live order opened from Orders keeps Orders lit, so tracking does not read as a
     place the customer has navigated out of the app. */
  const onMyOrders = pathname === CUSTOMER_MY_ORDERS_PATH || /(^|\/)status\//.test(pathname);
  const onBond = pathname === CUSTOMER_BOND_PATH;

  const itemClass = (active: boolean) => [
    'cb-customer-nav-link flex min-h-[44px] min-w-[44px] flex-1 flex-col items-center justify-center gap-1 rounded-2xl px-1 text-[11px] font-bold',
    active ? 'cb-customer-nav-item-active' : 'cb-customer-nav-item',
  ].join(' ');

  return (
    /* Mobile/tablet only. On lg the desktop layout keeps its sticky basket panel and the
       header basket entry, so showing this too would duplicate the control. */
    <nav aria-label="Customer app" className="cb-customer-bottom-nav fixed inset-x-0 bottom-0 z-40 lg:hidden">
      <div className="cb-customer-bottom-nav-inner mx-auto flex max-w-lg items-center justify-around px-1">
        <Link
          to={{ pathname: CUSTOMER_HOME_PATH, hash: '#cb-home' }}
          className={itemClass(onHome)}
          aria-current={onHome ? 'page' : undefined}
        >
          <House size={20} aria-hidden="true" />
          Home
        </Link>

        <Link
          to={{ pathname: CUSTOMER_HOME_PATH, hash: MENU_HASH }}
          className={itemClass(onMenu)}
          aria-current={onMenu ? 'page' : undefined}
        >
          <UtensilsCrossed size={20} aria-hidden="true" />
          Menu
        </Link>

        <Link
          to={CUSTOMER_MY_ORDERS_PATH}
          className={itemClass(onMyOrders)}
          aria-current={onMyOrders ? 'page' : undefined}
        >
          <ReceiptText size={20} aria-hidden="true" />
          Orders
        </Link>

        <Link
          to={CUSTOMER_BOND_PATH}
          className={itemClass(onBond)}
          aria-current={onBond ? 'page' : undefined}
        >
          <Sparkles size={20} aria-hidden="true" />
          Bond
        </Link>
      </div>
    </nav>
  );
}
