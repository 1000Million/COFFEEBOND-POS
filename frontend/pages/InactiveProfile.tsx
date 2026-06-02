import React from 'react';
import { useAuth } from '../contexts/AuthContext';
import { LogOut, XCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export default function InactiveProfile() {
  const { logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-[#f9f5f0] flex flex-col items-center justify-center p-4 font-sans text-neutral-800">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-sm border border-neutral-200 p-8 text-center">
        <div className="w-16 h-16 bg-amber-100 text-amber-600 rounded-full flex items-center justify-center mx-auto mb-6">
          <XCircle size={32} />
        </div>
        
        <h1 className="text-2xl font-bold mb-2">Account Inactive</h1>
        <p className="text-neutral-600 mb-8">
          Your staff account is currently inactive. Please contact a Store Manager or Admin to reactivate your access.
        </p>

        <button 
          onClick={handleLogout}
          className="w-full py-3 px-4 bg-neutral-800 hover:bg-neutral-900 text-white font-medium rounded-xl transition-colors flex items-center justify-center gap-2"
        >
          <LogOut size={18} />
          Sign Out
        </button>
      </div>
    </div>
  );
}
