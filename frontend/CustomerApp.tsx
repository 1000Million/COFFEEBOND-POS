/**
 * Customer-only application router for the dedicated customer origin.
 *
 * This entry mounts ONLY the three customer ordering screens. No POS, admin,
 * reports, inventory, KOT, franchise or staff authentication route is imported or
 * mounted here, so the staff router is never bundled into the customer site and a
 * private path cannot render a staff screen on order.coffeebond.in.
 *
 * The customer pages, cart persistence, public menu, add-ons, OTP, checkout,
 * payment and tracking logic are the existing shared implementations — nothing is
 * forked or duplicated.
 */
import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes, Link } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ConnectivityProvider } from './contexts/ConnectivityContext';
import ConnectionStatusBanner from './components/ConnectionStatusBanner';
import CustomerPwaStatusUI from './components/CustomerPwaStatusUI';

const CustomerOrder = lazy(() => import('./pages/customer/CustomerOrder'));
const CustomerOrderStatus = lazy(() => import('./pages/customer/CustomerOrderStatus'));
const CustomerMyOrders = lazy(() => import('./pages/customer/CustomerMyOrders'));

/**
 * Customer-branded route fallback. The shared AppLoading component renders
 * "Loading Coffee Bond POS...", which must never appear on the customer origin.
 */
function RouteLoading() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[#fbf7f1]">
      <span className="animate-pulse font-medium text-[#5c4033] motion-reduce:animate-none">Loading Coffee Bond...</span>
    </div>
  );
}

/**
 * Safe customer-only screen for any path this origin does not serve, including the
 * staff paths (/pos, /admin/**, /reports/**, /inventory/**, /kot/**, /franchise/**).
 * It renders no staff UI and links back to ordering.
 */
function CustomerNotFound() {
  return (
    <main className="flex min-h-[100dvh] min-w-0 flex-col items-center justify-center overflow-x-hidden bg-[#fbf7f1] px-6 text-center font-sans text-[#271a16] [padding-left:env(safe-area-inset-left)] [padding-right:env(safe-area-inset-right)]">
      <h1 className="text-xl font-black">Page not available</h1>
      <p className="mt-2 max-w-sm text-sm font-semibold text-neutral-600">
        This address is not part of Coffee Bond ordering.
      </p>
      <Link to="/" className="mt-6 rounded-2xl bg-[#3b261d] px-5 py-3 text-sm font-black text-white">
        Go to ordering
      </Link>
    </main>
  );
}

export default function CustomerApp() {
  return (
    <AuthProvider>
      <ConnectivityProvider>
        <BrowserRouter>
          <ConnectionStatusBanner />
          <CustomerPwaStatusUI />
          <Suspense fallback={<RouteLoading />}>
            <Routes>
              {/* Canonical customer-origin routes. */}
              <Route path="/" element={<CustomerOrder />} />
              <Route path="/my-orders" element={<CustomerMyOrders />} />
              <Route path="/status/:onlineOrderId" element={<CustomerOrderStatus />} />

              {/* Compatibility aliases so links and server-supplied tracking paths
                  minted on the staff origin keep resolving here. */}
              <Route path="/order" element={<Navigate to="/" replace />} />
              <Route path="/order/my-orders" element={<Navigate to="/my-orders" replace />} />
              <Route path="/order/status/:onlineOrderId" element={<CustomerOrderStatus />} />

              <Route path="*" element={<CustomerNotFound />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </ConnectivityProvider>
    </AuthProvider>
  );
}
