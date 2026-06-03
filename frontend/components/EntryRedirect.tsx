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

  return (
    <div className="max-w-xl mx-auto w-full bg-white border border-neutral-200 rounded-2xl p-8 text-center shadow-sm">
      <h2 className="text-2xl font-black text-[#5c4033] mb-3">No Workspace Assigned</h2>
      <p className="text-sm text-neutral-600">
        Your staff profile is active, but this role does not have a POS, KOT, Reports, or Admin workspace yet.
        Please ask an Admin to update your role or store assignment.
      </p>
    </div>
  );
}
