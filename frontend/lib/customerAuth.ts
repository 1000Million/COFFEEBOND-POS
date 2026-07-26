import { FirebaseApp, getApp, getApps, initializeApp } from 'firebase/app';
import {
  Auth,
  ConfirmationResult,
  RecaptchaVerifier,
  browserLocalPersistence,
  getAuth,
  setPersistence,
  signInWithPhoneNumber,
  signOut,
} from 'firebase/auth';
import { Functions, getFunctions, httpsCallable } from 'firebase/functions';
import { firebaseConfig } from './firebase';

const CUSTOMER_APP_NAME = 'coffee-bond-customer-auth';

function customerApp(): FirebaseApp {
  return getApps().some(candidate => candidate.name === CUSTOMER_APP_NAME)
    ? getApp(CUSTOMER_APP_NAME)
    : initializeApp(firebaseConfig, CUSTOMER_APP_NAME);
}

export const customerAuth: Auth = getAuth(customerApp());
export const customerFunctions: Functions = getFunctions(
  customerApp(),
  import.meta.env.VITE_FIREBASE_FUNCTIONS_REGION || 'us-central1',
);

export const customerAuthPersistenceReady = setPersistence(customerAuth, browserLocalPersistence);

export type CustomerProfile = {
  customerUid: string;
  normalisedPhone: string;
  displayName: string;
  defaultOrderType: 'PICKUP' | 'DINE_IN';
};

export type CustomerProfileUpdate = {
  displayName: string;
  defaultOrderType: 'PICKUP' | 'DINE_IN';
};

export const resolveCustomerProfile = httpsCallable<
  { displayName?: string; defaultOrderType?: 'PICKUP' | 'DINE_IN' },
  CustomerProfile
>(customerFunctions, 'resolveCustomerProfile');

export const updateCustomerProfile = httpsCallable<CustomerProfileUpdate, CustomerProfile>(
  customerFunctions,
  'updateCustomerProfile',
);

export async function waitForCustomerAuthRestoration() {
  await customerAuthPersistenceReady;
  await customerAuth.authStateReady();
  return customerAuth.currentUser;
}

export async function restoreCustomerProfile(): Promise<CustomerProfile | null> {
  const user = await waitForCustomerAuthRestoration();
  if (!user) return null;
  try {
    const result = await resolveCustomerProfile({});
    return result.data;
  } catch {
    if (!user.phoneNumber) return null;
    return {
      customerUid: user.uid,
      normalisedPhone: user.phoneNumber,
      displayName: user.displayName || '',
      defaultOrderType: 'PICKUP',
    };
  }
}

export function normalizedIndianE164(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  const national = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  return /^[6-9][0-9]{9}$/.test(national) ? `+91${national}` : null;
}

export async function sendCustomerOtp(
  mobile: string,
  container: HTMLElement,
): Promise<{ confirmation: ConfirmationResult; verifier: RecaptchaVerifier }> {
  const phoneNumber = normalizedIndianE164(mobile);
  if (!phoneNumber) throw new Error('Enter a valid 10-digit Indian mobile number.');
  const verifier = new RecaptchaVerifier(customerAuth, container, {
    size: 'invisible',
  });
  try {
    const confirmation = await signInWithPhoneNumber(customerAuth, phoneNumber, verifier);
    return { confirmation, verifier };
  } catch (error) {
    verifier.clear();
    const code = String((error as { code?: string })?.code || '');
    if (code.includes('too-many-requests')) {
      throw new Error('Too many OTP requests. Please wait before trying again.');
    }
    if (code.includes('invalid-phone-number')) {
      throw new Error('Enter a valid 10-digit Indian mobile number.');
    }
    throw new Error('We could not send the SMS code. Please try again.');
  }
}

export async function verifyCustomerOtp(
  confirmation: ConfirmationResult,
  code: string,
): Promise<CustomerProfile> {
  if (!/^[0-9]{6}$/.test(code)) throw new Error('Enter the 6-digit SMS code.');
  await confirmation.confirm(code);
  const result = await resolveCustomerProfile({});
  return result.data;
}

export async function invalidateCustomerVerification(): Promise<void> {
  if (customerAuth.currentUser) await signOut(customerAuth);
}

export async function signOutCustomer(): Promise<void> {
  await invalidateCustomerVerification();
}

export function customerPhoneFromAuth(): string {
  return customerAuth.currentUser?.phoneNumber || '';
}
