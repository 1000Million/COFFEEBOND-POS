import React from 'react';
import { useAuth } from '../contexts/AuthContext';
import { LogOut, Copy, AlertCircle, Database } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export default function MissingProfile() {
  const { firebaseUser, logout, error } = useAuth();
  const navigate = useNavigate();

  const handleCopyUid = () => {
    if (firebaseUser?.uid) {
      navigator.clipboard.writeText(firebaseUser.uid);
      // Could add a toast notification here
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  if (!firebaseUser) return null;

  return (
    <div className="min-h-screen bg-[#f9f5f0] flex flex-col items-center justify-center p-4 font-sans text-neutral-800">
      <div className="max-w-xl w-full bg-white rounded-2xl shadow-sm border border-neutral-200 p-8 text-center">
        <div className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-6 ${error ? 'bg-orange-100 text-orange-600' : 'bg-red-100 text-red-600'}`}>
          {error ? <Database size={32} /> : <AlertCircle size={32} />}
        </div>
        
        <h1 className="text-2xl font-bold mb-2">
          {error ? 'Firestore Permissions Error' : 'Staff Profile Not Found'}
        </h1>
        
        <p className="text-neutral-600 mb-8">
          {error 
            ? "Your Firebase project rejected the read request. This usually happens if you haven't deployed the latest firestore.rules to your own Firebase project." 
            : "You have successfully logged into Firebase, but your staff profile has not been created yet in Firestore. Please ask an Admin to create your staff profile."}
        </p>

        {error && (
          <div className="bg-red-50 text-red-800 border border-red-200 rounded-xl p-4 mb-8 text-left text-sm font-medium overflow-x-auto whitespace-pre-wrap">
            {error}
          </div>
        )}

        <div className="bg-neutral-50 rounded-xl p-4 mb-8 text-left border border-neutral-200">
          <div className="mb-4">
            <span className="text-xs font-bold text-neutral-500 uppercase tracking-widest block mb-1">Email</span>
            <span className="text-sm font-medium">{firebaseUser.email}</span>
          </div>
          <div>
            <span className="text-xs font-bold text-neutral-500 uppercase tracking-widest block mb-1">Firebase UID</span>
            <div className="flex items-center gap-2">
              <code className="text-xs font-mono bg-neutral-200 px-2 py-1 rounded text-neutral-700 flex-1 overflow-hidden text-ellipsis">
                {firebaseUser.uid}
              </code>
              <button 
                onClick={handleCopyUid}
                className="p-2 text-neutral-500 hover:text-neutral-800 hover:bg-neutral-200 rounded-lg transition-colors"
                title="Copy UID"
              >
                <Copy size={16} />
              </button>
            </div>
          </div>
        </div>

        <button 
          onClick={handleLogout}
          className="w-full py-3 px-4 bg-neutral-800 hover:bg-neutral-900 text-white font-medium rounded-xl transition-colors flex items-center justify-center gap-2"
        >
          <LogOut size={18} />
          Sign Out
        </button>
        
        <div className="mt-8 pt-6 border-t border-neutral-100 text-left">
          {error ? (
            <>
              <h3 className="text-sm font-bold text-neutral-800 mb-2">How to fix permissions:</h3>
              <ol className="text-xs text-neutral-600 space-y-2 list-decimal list-inside">
                <li>Copy the contents of the <code>firestore.rules</code> file from the root of this project.</li>
                <li>Go to the Firebase Console &rarr; Firestore Database &rarr; Rules tab.</li>
                <li>Paste the updated rules and click <b>Publish</b>.</li>
                <li>Refresh this page.</li>
              </ol>
            </>
          ) : (
            <>
              <h3 className="text-sm font-bold text-neutral-800 mb-2">How to resolve a missing profile:</h3>
              <ol className="text-xs text-neutral-600 space-y-2 list-decimal list-inside">
                <li>Share the Firebase UID above with an existing active Admin.</li>
                <li>The Admin should create or activate your staff profile from Admin &rarr; Staff Management.</li>
                <li>After your profile is active and assigned to the right store, refresh this page.</li>
              </ol>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
