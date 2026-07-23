/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import Login from './pages/Login';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import EntryRedirect from './components/EntryRedirect';
import AppLoading from './components/AppLoading';
import ConnectionStatusBanner from './components/ConnectionStatusBanner';
import MissingProfile from './pages/MissingProfile';
import InactiveProfile from './pages/InactiveProfile';

const CustomerOrder = lazy(() => import('./pages/customer/CustomerOrder'));
const CustomerOrderStatus = lazy(() => import('./pages/customer/CustomerOrderStatus'));
const KOTScreen = lazy(() => import('./pages/kot/KOTScreen'));
const ReadyToServe = lazy(() => import('./pages/kot/ReadyToServe'));
const ReportsHome = lazy(() => import('./pages/reports/ReportsHome'));
const DayClose = lazy(() => import('./pages/reports/DayClose'));
const AuditControl = lazy(() => import('./pages/reports/AuditControl'));
const InventoryControl = lazy(() => import('./pages/inventory/InventoryControl'));
const StockCorrection = lazy(() => import('./pages/inventory/StockCorrection'));
const PurchaseEntry = lazy(() => import('./pages/inventory/PurchaseEntry'));
const AdminHome = lazy(() => import('./pages/admin/AdminHome'));
const Stores = lazy(() => import('./pages/admin/Stores'));
const Categories = lazy(() => import('./pages/admin/Categories'));
const MenuItems = lazy(() => import('./pages/admin/MenuItems'));
const InventoryItems = lazy(() => import('./pages/admin/InventoryItems'));
const StoreInventory = lazy(() => import('./pages/admin/StoreInventory'));
const Recipes = lazy(() => import('./pages/admin/Recipes'));
const Seed = lazy(() => import('./pages/admin/Seed'));
const MenuImport = lazy(() => import('./pages/admin/MenuImport'));
const DataManagement = lazy(() => import('./pages/admin/DataManagement'));
const StaffManagement = lazy(() => import('./pages/admin/StaffManagement'));
const GoLiveReadiness = lazy(() => import('./pages/admin/GoLiveReadiness'));
const Phase7AValidation = lazy(() => import('./pages/admin/Phase7AValidation'));
const Phase7HStockCosting = lazy(() => import('./pages/admin/Phase7HStockCosting'));
const Phase7IBomAliasCorrection = lazy(() => import('./pages/admin/Phase7IBomAliasCorrection'));
const POSReadiness = lazy(() => import('./pages/admin/POSReadiness'));
const ProductImages = lazy(() => import('./pages/admin/ProductImages'));
const MenuManagementHub = lazy(() => import('./pages/admin/MenuManagementHub'));
const POSHome = lazy(() => import('./pages/pos/POSHome'));
const IncomingOnlineOrders = lazy(() => import('./pages/pos/IncomingOnlineOrders'));
const RunningOrders = lazy(() => import('./pages/pos/RunningOrders'));
const FranchiseLogin = lazy(() => import('./pages/franchise/FranchiseLogin'));
const FranchiseDailySales = lazy(() => import('./pages/franchise/FranchiseDailySales'));

function RouteLoading() {
  return (
    <main className="min-h-[60vh] bg-[#f9f5f0] flex items-center justify-center p-6">
      <div className="rounded-2xl border border-[#eadfd2] bg-white px-6 py-5 text-center shadow-sm">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-[#f4eadf] text-[#4b2d22] font-black">
          CB
        </div>
        <p className="text-sm font-semibold text-[#4b2d22]">Loading Coffee Bond...</p>
      </div>
    </main>
  );
}

function LoginRoute() {
  const { authStatus } = useAuth();
  
  if (authStatus === 'checking-auth' || authStatus === 'checking-profile') {
    return <AppLoading />;
  }
  
  if (authStatus === 'signed-out') {
    return <Login />;
  }

  if (authStatus === 'missing-profile') {
    return <MissingProfile />;
  }

  if (authStatus === 'inactive') {
    return <InactiveProfile />;
  }

  if (authStatus === 'permission-error') {
    return <MissingProfile />;
  }
  
  // If fully logged in & ready, jump to EntryRedirect via "/"
  if (authStatus === 'ready') {
    return <Navigate to="/" replace />;
  }
  
  return <Login />;
}

function FranchiseLoginRoute() {
  const { authStatus, staffProfile } = useAuth();

  if (authStatus === 'checking-auth' || authStatus === 'checking-profile') return <AppLoading />;
  if (authStatus === 'signed-out') return <FranchiseLogin />;
  if (authStatus === 'missing-profile' || authStatus === 'permission-error') return <MissingProfile />;
  if (authStatus === 'inactive') return <InactiveProfile />;
  if (authStatus === 'ready' && staffProfile?.role === 'FRANCHISE_VIEWER') {
    return <Navigate to="/franchise/daily-sales" replace />;
  }
  if (authStatus === 'ready') return <Navigate to="/" replace />;
  return <FranchiseLogin />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <ConnectionStatusBanner />
        <Suspense fallback={<RouteLoading />}>
          <Routes>
            <Route path="/order" element={<CustomerOrder />} />
            <Route path="/order/status/:onlineOrderId" element={<CustomerOrderStatus />} />
            <Route path="/login" element={<LoginRoute />} />
            <Route path="/franchise/login" element={<FranchiseLoginRoute />} />
            <Route element={<ProtectedRoute allowedRoles={['FRANCHISE_VIEWER']} signInPath="/franchise/login" />}>
              <Route path="/franchise/daily-sales" element={<FranchiseDailySales />} />
            </Route>

            {/* Main App Layout - Protected by Auth */}
            <Route element={<ProtectedRoute />}>
              <Route element={<Layout />}>
                <Route path="/" element={<EntryRedirect />} />

                <Route element={<ProtectedRoute allowedRoles={['ADMIN']} />}>
                  <Route path="/admin" element={<AdminHome />} />
                  <Route path="/admin/stores" element={<Stores />} />
                  <Route path="/admin/categories" element={<Categories />} />
                  <Route path="/admin/inventory" element={<InventoryItems />} />
                  <Route path="/admin/recipes" element={<Recipes />} />
                  <Route path="/admin/menu-import" element={<MenuImport />} />
                  <Route path="/admin/data" element={<DataManagement />} />
                  <Route path="/admin/phase-7a-validation" element={<Phase7AValidation />} />
                  <Route path="/admin/phase-7h-stock-costing" element={<Phase7HStockCosting />} />
                  <Route path="/admin/phase-7i-bom-alias-correction" element={<Phase7IBomAliasCorrection />} />
                  <Route path="/admin/pos-readiness" element={<POSReadiness />} />
                  <Route path="/admin/product-images" element={<ProductImages />} />
                  <Route path="/admin/seed" element={<Seed />} />
                  <Route path="/admin/staff" element={<StaffManagement />} />
                </Route>

                <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'STORE_MANAGER']} />}>
                  <Route path="/admin/menu" element={<MenuItems />} />
                  <Route path="/admin/store-inventory" element={<StoreInventory />} />
                  <Route path="/admin/menu-management" element={<MenuManagementHub />} />
                  <Route path="/admin/go-live-readiness" element={<GoLiveReadiness />} />
                </Route>

                <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'STORE_MANAGER', 'CASHIER']} />}>
                  <Route path="/pos" element={<POSHome />} />
                  <Route path="/pos/running-orders" element={<RunningOrders />} />
                  <Route path="/pos/incoming-orders" element={<IncomingOnlineOrders />} />
                </Route>

                <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'STORE_MANAGER']} />}>
                  <Route path="/reports" element={<ReportsHome />} />
                  <Route path="/reports/day-close" element={<DayClose />} />
                  <Route path="/reports/audit-control" element={<AuditControl />} />
                  <Route path="/inventory" element={<Navigate to="/inventory/control" replace />} />
                  <Route path="/inventory/control" element={<InventoryControl />} />
                  <Route path="/inventory/stock-correction" element={<StockCorrection />} />
                  <Route path="/inventory/purchase-entry" element={<PurchaseEntry />} />
                </Route>

                <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'STORE_MANAGER', 'CASHIER', 'BARISTA', 'KITCHEN']} />}>
                  <Route path="/kot/barista" element={<KOTScreen station="BARISTA" />} />
                  <Route path="/kot/kitchen" element={<KOTScreen station="KITCHEN" />} />
                  <Route path="/kot/ready" element={<ReadyToServe />} />
                </Route>
              </Route>
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthProvider>
  );
}
