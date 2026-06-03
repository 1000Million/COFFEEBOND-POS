import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, onAuthStateChanged, signOut as firebaseSignOut } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import { StaffProfile, AuthStatus } from '../types';

interface AuthContextType {
  firebaseUser: User | null;
  staffProfile: StaffProfile | null;
  authStatus: AuthStatus;
  loading: boolean;
  error: string | null;
  logout: () => Promise<void>;
  login: () => void;
}

const AuthContext = createContext<AuthContextType>({
  firebaseUser: null,
  staffProfile: null,
  authStatus: "checking-auth",
  loading: true,
  error: null,
  logout: async () => {},
  login: () => {},
});

export const useAuth = () => useContext(AuthContext);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [staffProfile, setStaffProfile] = useState<StaffProfile | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>("checking-auth");
  const [errorParse, setErrorParse] = useState<string | null>(null);

  const loading = authStatus === "checking-auth" || authStatus === "checking-profile";

  useEffect(() => {
    let unsubscribeProfile: (() => void) | null = null;

    const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      if (unsubscribeProfile) {
        unsubscribeProfile();
        unsubscribeProfile = null;
      }

      setFirebaseUser(user);
      
      if (!user) {
        setStaffProfile(null);
        setAuthStatus("signed-out");
        setErrorParse(null);
        return;
      }

      setAuthStatus("checking-profile");
      setErrorParse(null);

      const profileRef = doc(db, 'users', user.uid);
      
      unsubscribeProfile = onSnapshot(profileRef, (docSnap) => {
        if (!docSnap.exists()) {
          setStaffProfile(null);
          setAuthStatus("missing-profile");
          return;
        }

        const data = docSnap.data();
        const assignedStoreIds = Array.isArray(data.assignedStoreIds)
          ? data.assignedStoreIds
          : Array.isArray(data.storeIds)
            ? data.storeIds
            : [];
        const displayName = data.displayName || data.name || user.displayName || user.email || "Staff";
        const newProfile = {
          id: docSnap.id,
          ...data,
          uid: data.uid || docSnap.id,
          name: data.name || displayName,
          displayName,
          storeIds: assignedStoreIds,
          assignedStoreIds,
        } as unknown as StaffProfile;
        
        setStaffProfile(prevProfile => {
          if (JSON.stringify(prevProfile) === JSON.stringify(newProfile)) {
            return prevProfile;
          }
          return newProfile;
        });

        if (data.isActive === false) {
          setAuthStatus("inactive");
        } else {
          setAuthStatus("ready");
        }
        setErrorParse(null);
      }, (error: any) => {
        setErrorParse(error.message || "Unknown permission error");
        setStaffProfile(null);
        setAuthStatus("permission-error");
      });
    });

    return () => {
      unsubscribeAuth();
      if (unsubscribeProfile) unsubscribeProfile();
    };
  }, []);

  const logout = async () => {
    await firebaseSignOut(auth);
  };
  
  const login = () => {};

  return (
    <AuthContext.Provider value={{ firebaseUser, staffProfile, authStatus, loading, logout, login, error: errorParse }}>
      {children}
    </AuthContext.Provider>
  );
};
