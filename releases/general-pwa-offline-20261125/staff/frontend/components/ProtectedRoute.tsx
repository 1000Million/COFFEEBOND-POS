import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Role } from '../types';
import {useConnectivity} from '../contexts/ConnectivityContext';
import OfflinePosAccess from './OfflinePosAccess';
import OfflineDraftRecovery from './OfflineDraftRecovery';
import AppLoading from './AppLoading';
import MissingProfile from '../pages/MissingProfile';
import InactiveProfile from '../pages/InactiveProfile';

interface ProtectedRouteProps {
  allowedRoles?: Role[];
  children?: React.ReactNode;
  signInPath?: string;
}

export default function ProtectedRoute({ allowedRoles, children, signInPath = '/login' }: ProtectedRouteProps) {
  const { authStatus, staffProfile, firebaseUser } = useAuth();
  const {isOffline}=useConnectivity();
  const location=useLocation();
  if(location.pathname==='/pos' && firebaseUser && authStatus==='checking-profile')return <OfflinePosAccess key={firebaseUser.uid} uid={firebaseUser.uid}/>;
  if(isOffline && firebaseUser && authStatus!=='ready')return <OfflineDraftRecovery key={firebaseUser.uid} uid={firebaseUser.uid}/>;

  if (authStatus === 'checking-auth' || authStatus === 'checking-profile') {
    return <AppLoading />;
  }

  if (authStatus === 'signed-out') {
    return <Navigate to={signInPath} replace />;
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
      else if (staffProfile.role === 'FRANCHISE_VIEWER') fallback = '/franchise/daily-sales';
      
      return <Navigate to={fallback} replace />;
    }

    return children ? <>{children}</> : <Outlet />;
  }

  // Fallback
  return <Navigate to={signInPath} replace />;
}
