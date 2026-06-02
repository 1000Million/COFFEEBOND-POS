import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function EntryRedirect() {
  const { authStatus, staffProfile } = useAuth();

  if (authStatus !== 'ready' || !staffProfile) {
    return null;
  }

  if (staffProfile.role === 'ADMIN') return <Navigate to="/admin" replace />;
  if (staffProfile.role === 'STORE_MANAGER' || staffProfile.role === 'CASHIER') return <Navigate to="/pos" replace />;
  if (staffProfile.role === 'BARISTA') return <Navigate to="/kot/barista" replace />;
  if (staffProfile.role === 'KITCHEN') return <Navigate to="/kot/kitchen" replace />;

  return <Navigate to="/login" replace />;
}

