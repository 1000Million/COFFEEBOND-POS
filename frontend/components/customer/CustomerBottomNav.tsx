import { Link, useLocation } from 'react-router-dom';
import { ClipboardList, ShoppingBag, Sparkles, UserRound, UtensilsCrossed } from 'lucide-react';
import {
  CUSTOMER_ACCOUNT_PATH,
  CUSTOMER_BOND_PATH,
  CUSTOMER_HOME_PATH,
  CUSTOMER_MY_ORDERS_PATH,
} from '../../lib/customerRoutes';

type Props = {
  /** Real count from CustomerOrder's existing basket state. */
  itemCount?: number;
  /** On home this opens the existing basket sheet; other routes use router state. */
  onOpenBasket?: () => void;
  basketOpen?: boolean;
};

/** Five-tab customer navigation. Cart is a doorway to the existing basket, not state. */
export default function CustomerBottomNav({ itemCount, onOpenBasket, basketOpen = false }: Props) {
  const { pathname } = useLocation();

  const onHome = pathname === CUSTOMER_HOME_PATH;
  /* A live order opened from Orders keeps Orders lit, so tracking does not read as a
     place the customer has navigated out of the app. */
  const onMyOrders = pathname === CUSTOMER_MY_ORDERS_PATH || /(^|\/)status\//.test(pathname);
  const onBond = pathname === CUSTOMER_BOND_PATH;
  const onAccount = pathname === CUSTOMER_ACCOUNT_PATH;

  const itemClass = (active: boolean) => [
    'cb-customer-nav-link flex min-h-[44px] min-w-[44px] flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl px-0.5 text-[11px] font-bold',
    active ? 'cb-customer-nav-item-active' : 'cb-customer-nav-item',
  ].join(' ');

  const cartContents = (
    <>
      <span className="cb-customer-nav-cart-disc relative flex h-14 w-14 items-center justify-center rounded-full">
        <ShoppingBag size={23} aria-hidden="true" />
        {typeof itemCount === 'number' && itemCount > 0 && (
          <span className="cb-customer-nav-cart-count" aria-hidden="true">{itemCount}</span>
        )}
      </span>
      <span className="cb-customer-nav-cart-label">Cart</span>
    </>
  );

  const cartLabel = typeof itemCount === 'number'
    ? `Open cart with ${itemCount} item${itemCount === 1 ? '' : 's'}`
    : 'Open cart';

  return (
    /* Mobile/tablet only. On lg the desktop layout keeps its sticky basket panel and the
       header basket entry, so showing this too would duplicate the control. */
    <nav aria-label="Customer app" className="cb-customer-bottom-nav fixed inset-x-0 bottom-0 z-40 lg:hidden">
      <div className="cb-customer-bottom-nav-inner mx-auto flex max-w-lg items-center justify-around px-1">
        <Link
          to={CUSTOMER_HOME_PATH}
          className={itemClass(onHome)}
          aria-current={onHome ? 'page' : undefined}
        >
          <UtensilsCrossed size={20} aria-hidden="true" />
          Menu
        </Link>

        <Link
          to={CUSTOMER_MY_ORDERS_PATH}
          className={itemClass(onMyOrders)}
          aria-current={onMyOrders ? 'page' : undefined}
        >
          <ClipboardList size={20} aria-hidden="true" />
          Orders
        </Link>

        {onHome && onOpenBasket ? (
          <button
            type="button"
            onClick={onOpenBasket}
            aria-label={cartLabel}
            aria-expanded={basketOpen}
            aria-haspopup="dialog"
            className={`cb-customer-nav-cart flex min-h-[64px] min-w-[58px] flex-1 flex-col items-center justify-start ${basketOpen ? 'is-active' : ''}`}
          >
            {cartContents}
          </button>
        ) : (
          <Link
            to={CUSTOMER_HOME_PATH}
            state={{ openBasket: true }}
            aria-label={cartLabel}
            className="cb-customer-nav-cart flex min-h-[64px] min-w-[58px] flex-1 flex-col items-center justify-start"
          >
            {cartContents}
          </Link>
        )}

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
