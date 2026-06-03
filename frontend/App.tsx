/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import Login from './pages/Login';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import EntryRedirect from './components/EntryRedirect';
import AppLoading from './components/AppLoading';
import MissingProfile from './pages/MissingProfile';
import InactiveProfile from './pages/InactiveProfile';
import { KOTBarista, KOTKitchen } from './pages/Placeholders';
import ReadyToServe from './pages/kot/ReadyToServe';
import ReportsHome from './pages/reports/ReportsHome';
import AdminHome from './pages/admin/AdminHome';
import Stores from './pages/admin/Stores';
import Categories from './pages/admin/Categories';
import MenuItems from './pages/admin/MenuItems';
import InventoryItems from './pages/admin/InventoryItems';
import StoreInventory from './pages/admin/StoreInventory';
import Recipes from './pages/admin/Recipes';
import Seed from './pages/admin/Seed';
import MenuImport from './pages/admin/MenuImport';
import DataManagement from './pages/admin/DataManagement';
import StaffManagement from './pages/admin/StaffManagement';
import POSHome from './pages/pos/POSHome';

import MenuManagementHub from './pages/admin/MenuManagementHub';

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

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginRoute />} />
          
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
                <Route path="/admin/seed" element={<Seed />} />
                <Route path="/admin/staff" element={<StaffManagement />} />
              </Route>

              <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'STORE_MANAGER']} />}>
                <Route path="/admin/menu" element={<MenuItems />} />
                <Route path="/admin/store-inventory" element={<StoreInventory />} />
                <Route path="/admin/menu-management" element={<MenuManagementHub />} />
              </Route>

              <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'STORE_MANAGER', 'CASHIER']} />}>
                <Route path="/pos" element={<POSHome />} />
                <Route path="/reports" element={<ReportsHome />} />
                <Route path="/kot/ready" element={<ReadyToServe />} />
              </Route>
              
              <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'STORE_MANAGER', 'BARISTA', 'CASHIER']} />}>
                <Route path="/kot/barista" element={<KOTBarista />} />
              </Route>
              
              <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'STORE_MANAGER', 'KITCHEN', 'CASHIER']} />}>
                <Route path="/kot/kitchen" element={<KOTKitchen />} />
              </Route>
            </Route>
          </Route>
          
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
