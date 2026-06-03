import React from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Role } from '../types';
import AppLoading from './AppLoading';
import MissingProfile from '../pages/MissingProfile';
import InactiveProfile from '../pages/InactiveProfile';

interface ProtectedRouteProps {
  allowedRoles?: Role[];
  children?: React.ReactNode;
}

export default function ProtectedRoute({ allowedRoles, children }: ProtectedRouteProps) {
  const { authStatus, staffProfile } = useAuth();

  if (authStatus === 'checking-auth' || authStatus === 'checking-profile') {
    return <AppLoading />;
  }

  if (authStatus === 'signed-out') {
    return <Navigate to="/login" replace />;
  }

  if (authStatus === 'missing-profile') {
    return <MissingProfile />;
  }

  if (authStatus === 'inactive') {
    return <InactiveProfile />;
  }

  if (authStatus === 'permission-error') {
    return <MissingProfile />; // Reusing MissingProfile which shows the permission error block.
  }

  if (authStatus === 'ready' && staffProfile) {
    if (allowedRoles && !allowedRoles.includes(staffProfile.role)) {
      let fallback = '/';
      if (staffProfile.role === 'ADMIN') fallback = '/admin';
      else if (staffProfile.role === 'STORE_MANAGER' || staffProfile.role === 'CASHIER') fallback = '/pos';
      else if (staffProfile.role === 'BARISTA') fallback = '/kot/barista';
      else if (staffProfile.role === 'KITCHEN') fallback = '/kot/kitchen';
      
      return <Navigate to={fallback} replace />;
    }

    return children ? <>{children}</> : <Outlet />;
  }

  // Fallback
  return <Navigate to="/login" replace />;
}
