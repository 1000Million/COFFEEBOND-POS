import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { LogOut, Copy, AlertCircle, Database, CheckCircle2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';

export default function MissingProfile() {
  const { firebaseUser, logout, error } = useAuth();
  const navigate = useNavigate();
  const [isCreatingAdmin, setIsCreatingAdmin] = useState(false);
  const [createAdminError, setCreateAdminError] = useState<string | null>(null);
  const [showSetupDiagnostics, setShowSetupDiagnostics] = useState(false);

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

  const handleCreateRootAdmin = async () => {
    if (!firebaseUser) return;
    setIsCreatingAdmin(true);
    setCreateAdminError(null);
    try {
      const displayName = firebaseUser.displayName || firebaseUser.email?.split('@')[0] || 'Root Admin';
      await setDoc(doc(db, 'users', firebaseUser.uid), {
        uid: firebaseUser.uid,
        displayName,
        name: displayName,
        email: firebaseUser.email || '',
        role: 'ADMIN',
        isActive: true,
        assignedStoreIds: [],
        storeIds: [],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      // The onSnapshot in AuthContext will automatically pick this up and redirect!
    } catch (err: any) {
      console.error(err);
      setCreateAdminError(err.message || 'Failed to create admin profile');
    } finally {
      setIsCreatingAdmin(false);
    }
  };

  if (!firebaseUser) return null;

  const isRootAdmin = firebaseUser.uid === '51eEH5q0wVXe5aIPERsqOO8zx8A2';
  const setupModeEnabled = import.meta.env.DEV || import.meta.env.VITE_ENABLE_BOOTSTRAP_ADMIN === 'true';
  const canShowBootstrapAdmin = isRootAdmin && !error && (setupModeEnabled || showSetupDiagnostics);

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

        {canShowBootstrapAdmin && (
           <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-6 mb-8 text-left">
             <div className="flex items-center gap-3 mb-2">
               <CheckCircle2 className="text-emerald-600" size={24} />
               <h3 className="font-bold text-emerald-900">Setup Mode: Root Admin Recognized</h3>
             </div>
             <p className="text-sm text-emerald-700 mb-4">
               This bootstrap shortcut is hidden during normal use. Use it only during controlled setup, then manage staff from Admin &rarr; Staff Management.
             </p>
             {createAdminError && (
               <p className="text-xs text-red-600 mb-4 bg-red-100 p-2 rounded">{createAdminError}</p>
             )}
             <button
               onClick={handleCreateRootAdmin}
               disabled={isCreatingAdmin}
               className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg font-medium text-sm transition-colors w-full"
             >
               {isCreatingAdmin ? 'Creating...' : 'Initialize Root Admin Profile'}
             </button>
           </div>
        )}

        {isRootAdmin && !error && !canShowBootstrapAdmin && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-8 text-left">
            <h3 className="font-bold text-amber-900 mb-1">Setup diagnostics available</h3>
            <p className="text-sm text-amber-800 mb-3">
              The bootstrap admin shortcut is hidden in normal mode. Open diagnostics only during initial setup.
            </p>
            <button
              type="button"
              onClick={() => setShowSetupDiagnostics(true)}
              className="bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded-lg font-medium text-sm transition-colors"
            >
              Open setup diagnostics
            </button>
          </div>
        )}

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
              <h3 className="text-sm font-bold text-neutral-800 mb-2">How to create the first Admin:</h3>
              <ol className="text-xs text-neutral-600 space-y-2 list-decimal list-inside">
                <li>Open the Firebase Console.</li>
                <li>Go to Firestore Database.</li>
                <li>Create a collection named <code>users</code>.</li>
                <li>Add a document with the Document ID exactly matching your Firebase UID above.</li>
                <li>Add these fields:
                  <ul className="list-disc list-inside ml-4 mt-1 space-y-1">
                    <li><code>email</code> (string)</li>
                    <li><code>name</code> (string)</li>
                    <li><code>role</code> (string) = <code>ADMIN</code></li>
                    <li><code>isActive</code> (boolean) = <code>true</code></li>
                    <li><code>uid</code> (string) = your UID</li>
                    <li><code>storeIds</code> (array) = empty or custom</li>
                  </ul>
                </li>
              </ol>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
