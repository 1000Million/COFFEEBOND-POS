import {
  deleteApp,
  getApp,
  getApps,
  initializeApp,
  type FirebaseApp,
} from 'firebase/app';
import {
  getAuth,
  inMemoryPersistence,
  RecaptchaVerifier,
  setPersistence,
  signInWithPhoneNumber,
  signOut,
  type Auth,
  type ConfirmationResult,
} from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { auth, firebaseConfig, functions } from './firebase';
import {
  COMPLIMENTARY_PHONE_PROVIDER,
  normalizeIndianPhoneE164,
  type ComplimentaryOtpVerification,
} from './complimentaryOrders';

const SECONDARY_APP_NAME = 'complimentary-phone-verification';
const RECAPTCHA_CONTAINER_ID = 'complimentary-phone-recaptcha';

type RecaptchaMode = 'invisible' | 'normal';

type AuthorizationRequest = {
  storeId: string;
  customerPhone: string;
  customerIdToken: string;
};

type AuthorizationResponse = {
  authorizationId: string;
  verifiedPhone: string;
  expiresAt: string;
};

let secondaryApp: FirebaseApp | null = null;
let secondaryAuth: Auth | null = null;
let recaptchaVerifier: RecaptchaVerifier | null = null;
let persistenceReady: Promise<void> | null = null;

function getSecondaryApp(): FirebaseApp {
  if (secondaryApp) return secondaryApp;
  secondaryApp = getApps().some((candidate) => candidate.name === SECONDARY_APP_NAME)
    ? getApp(SECONDARY_APP_NAME)
    : initializeApp(firebaseConfig, SECONDARY_APP_NAME);
  return secondaryApp;
}

function getSecondaryAuth(): Auth {
  if (!secondaryAuth) {
    secondaryAuth = getAuth(getSecondaryApp());
    persistenceReady = setPersistence(secondaryAuth, inMemoryPersistence);
  }
  return secondaryAuth;
}

async function prepareSecondaryAuth(): Promise<Auth> {
  const authInstance = getSecondaryAuth();
  await persistenceReady;
  return authInstance;
}

function resetRecaptchaVerifier() {
  recaptchaVerifier?.clear();
  recaptchaVerifier = null;
}

function createRecaptchaVerifier(mode: RecaptchaMode): RecaptchaVerifier {
  resetRecaptchaVerifier();
  recaptchaVerifier = new RecaptchaVerifier(getSecondaryAuth(), RECAPTCHA_CONTAINER_ID, {
    size: mode,
    callback: () => undefined,
    'expired-callback': () => resetRecaptchaVerifier(),
  });
  return recaptchaVerifier;
}

export function complimentaryPhoneErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  return String((error as { code?: unknown }).code || '');
}

export function complimentaryPhoneErrorMessage(error: unknown): string {
  const code = complimentaryPhoneErrorCode(error);
  const messages: Record<string, string> = {
    'auth/invalid-phone-number': 'Enter a valid Indian 10-digit mobile number.',
    'auth/too-many-requests': 'Too many verification attempts. Please wait before trying again.',
    'auth/quota-exceeded': 'SMS verification quota is currently unavailable. Please contact an Admin.',
    'auth/code-expired': 'This verification code has expired. Send a new code.',
    'auth/invalid-verification-code': 'The verification code is incorrect.',
    'auth/captcha-check-failed': 'The security check failed. Please try again.',
    'auth/network-request-failed': 'Network error while verifying the phone number. Please retry.',
    'functions/unauthenticated': 'The staff session has expired. Sign in again.',
    'functions/permission-denied': 'This staff account is not authorised for complimentary orders at this store.',
    'functions/failed-precondition': 'Phone verification could not be authorised. Send a new code.',
  };
  return messages[code] || 'Phone verification could not be completed. Please try again.';
}

export async function sendComplimentaryPhoneOtp(
  phone: string,
): Promise<ConfirmationResult> {
  const phoneE164 = normalizeIndianPhoneE164(phone);
  if (!phoneE164) {
    throw Object.assign(new Error('Invalid phone number.'), { code: 'auth/invalid-phone-number' });
  }

  try {
    await prepareSecondaryAuth();
    const verifier = createRecaptchaVerifier('invisible');
    await verifier.render();
    return await signInWithPhoneNumber(getSecondaryAuth(), phoneE164, verifier);
  } catch (error) {
    const code = complimentaryPhoneErrorCode(error);
    resetRecaptchaVerifier();
    if (code !== 'auth/captcha-check-failed') throw error;

    const verifier = createRecaptchaVerifier('normal');
    await verifier.render();
    return signInWithPhoneNumber(getSecondaryAuth(), phoneE164, verifier);
  }
}

export async function verifyComplimentaryPhoneOtp(args: {
  confirmationResult: ConfirmationResult;
  code: string;
  expectedPhone: string;
  storeId: string;
}): Promise<ComplimentaryOtpVerification> {
  const code = args.code.trim();
  if (!/^[0-9]{6}$/.test(code)) {
    throw Object.assign(new Error('OTP must be six digits.'), { code: 'auth/invalid-verification-code' });
  }

  const expectedPhoneE164 = normalizeIndianPhoneE164(args.expectedPhone);
  if (!expectedPhoneE164) {
    throw Object.assign(new Error('Invalid phone number.'), { code: 'auth/invalid-phone-number' });
  }

  const staffUidBefore = auth.currentUser?.uid;
  if (!staffUidBefore) {
    throw Object.assign(new Error('Staff session is unavailable.'), { code: 'functions/unauthenticated' });
  }

  const customerCredential = await args.confirmationResult.confirm(code);
  if (customerCredential.user.phoneNumber !== expectedPhoneE164) {
    await disposeComplimentaryPhoneVerification();
    throw Object.assign(new Error('Verified phone does not match.'), { code: 'functions/failed-precondition' });
  }

  try {
    const customerIdToken = await customerCredential.user.getIdToken(true);
    const createAuthorization = httpsCallable<AuthorizationRequest, AuthorizationResponse>(
      functions,
      'createComplimentaryAuthorization',
    );
    const response = await createAuthorization({
      storeId: args.storeId,
      customerPhone: args.expectedPhone.trim(),
      customerIdToken,
    });

    if (auth.currentUser?.uid !== staffUidBefore) {
      throw Object.assign(new Error('Staff session changed during phone verification.'), { code: 'functions/unauthenticated' });
    }

    const data = response.data;
    if (!data.authorizationId || !data.verifiedPhone || !data.expiresAt) {
      throw Object.assign(new Error('Authorization response is incomplete.'), { code: 'functions/internal' });
    }

    return {
      authorizationId: data.authorizationId,
      provider: COMPLIMENTARY_PHONE_PROVIDER,
      verifiedPhone: data.verifiedPhone,
      expiresAtIso: data.expiresAt,
    };
  } finally {
    await disposeComplimentaryPhoneVerification();
  }
}

export async function disposeComplimentaryPhoneVerification(): Promise<void> {
  resetRecaptchaVerifier();
  const authInstance = secondaryAuth;
  const appInstance = secondaryApp;
  secondaryAuth = null;
  secondaryApp = null;
  persistenceReady = null;

  if (authInstance?.currentUser) {
    try {
      await signOut(authInstance);
    } catch {
      // The temporary session is best-effort cleanup; default staff Auth is untouched.
    }
  }
  if (appInstance) {
    try {
      await deleteApp(appInstance);
    } catch {
      // A later request safely reuses or recreates the named app.
    }
  }
}

export function complimentaryRecaptchaContainerId(): string {
  return RECAPTCHA_CONTAINER_ID;
}
