import { httpsCallable } from 'firebase/functions';
import {
  EmailAuthProvider, FacebookAuthProvider, GithubAuthProvider, GoogleAuthProvider,
  OAuthProvider, SAMLAuthProvider, TwitterAuthProvider,
  reauthenticateWithCredential, reauthenticateWithPopup,
} from 'firebase/auth';
import type { AuthProvider, User } from 'firebase/auth';
import { auth, functions } from './firebase';
import type { Role } from '../types';

export type StaffAccessRequest =
  | { action: 'CREATE'; displayName: string; email: string; password: string; role: Role; storeIds: string[]; requestId: string }
  | { action: 'UPDATE'; uid: string; displayName: string; role: Role; storeIds: string[]; isActive: boolean; expectedUpdatedAt?: string }
  | { action: 'PAUSE'; uid: string }
  | { action: 'ADMIN_PASSWORD'; uid: string; password: string; requestId: string }
  | { action: 'SELF_PASSWORD'; password: string; requestId: string };
export type StaffAccessResponse = {
  status: 'CREATED' | 'ALREADY_CREATED' | 'CREATE_UNKNOWN' | 'UPDATED' | 'PAUSED' | 'PASSWORD_CHANGED' | 'PASSWORD_CHANGE_UNKNOWN';
  staffUid?: string;
  sessionInvalidation?: 'REFRESH_TOKENS_REVOKED' | 'UNKNOWN';
  signInAgain?: boolean;
  alreadyApplied?: boolean;
};
const callable = httpsCallable<StaffAccessRequest, StaffAccessResponse>(functions, 'staffAccess');
export async function staffAccess(request: StaffAccessRequest): Promise<StaffAccessResponse> {
  return (await callable(request)).data;
}

export function passwordProblem(password: string, confirmation: string): string | null {
  if (password.length < 12 || password.length > 128 || !password.trim()) return 'Use a password with 12–128 characters.';
  if (password !== confirmation) return 'Enter the same new password twice.';
  return null;
}

export function staffAccessError(error: unknown): string {
  const reason = (error as { details?: { reason?: string } })?.details?.reason;
  const messages: Record<string, string> = {
    EXISTING_EMAIL_ACCOUNT: 'An account already uses this email. It was not changed or given new staff access. Use Edit for an existing staff member.',
    LAST_ACTIVE_ADMIN: 'Keep at least one active Admin before pausing or changing this account.',
    SELF_ADMIN_PROTECTION: 'You cannot remove your own active Admin access.',
    FRANCHISE_WORKFLOW: 'Manage this account through the separate Franchise Access workflow.',
    ACCOUNT_DISABLED: 'This account is disabled. No password or staff access was changed.',
    RECENT_LOGIN_REQUIRED: 'Confirm your own sign-in again before changing a password.',
    RECENT_AUTHENTICATION_REQUIRED: 'Confirm your own sign-in again before changing a password.',
    REAUTHENTICATION_REQUIRED: 'Confirm your own sign-in again before changing a password.',
    PASSWORD_REAUTHENTICATION_REQUIRED: 'Confirm your current password before changing your password.',
    PASSWORD_PROVIDER_REQUIRED: 'This account uses another sign-in provider. Its password cannot be changed here.',
    SELF_PASSWORD_REQUIRED: 'Use My account to change your own password.',
    USE_SELF_PASSWORD: 'Use My account to change your own password.',
    CREATE_ALREADY_PENDING: 'Staff creation is already in progress. Check the current staff list before retrying this same form.',
    CREATE_OUTCOME_UNKNOWN: 'Staff creation could not be confirmed. Keep this form and retry the same request after checking the staff list.',
    REQUEST_ID_REUSED: 'This request belongs to an earlier action. Review its current result before starting another change.',
    PASSWORD_CHANGE_ALREADY_PENDING: 'Another password change is already in progress. Check the account’s sign-in before requesting another change.',
    ACTIVE_ADMIN_REQUIRED: 'Only an active Admin can manage staff accounts.',
    ACTIVE_STAFF_REQUIRED: 'Only an active staff account can change its password here.',
  };
  if (reason && messages[reason]) return messages[reason];
  const code = (error as { code?: string })?.code?.replace(/^functions\//, '');
  if (code === 'unauthenticated') return 'Sign in again to continue.';
  if (code === 'permission-denied') return 'Your current account cannot perform this action.';
  if (code === 'already-exists') return 'This account or request already exists. Check the current staff list before making another change.';
  if (code === 'aborted') return 'This record changed. Open Edit again to review the latest details.';
  if (code === 'invalid-argument') return 'Check the name, email, password, role and store assignments.';
  if (code === 'failed-precondition') return 'This action is not available for the current account state. Check the staff record before retrying.';
  if (code === 'unavailable' || code === 'deadline-exceeded') return 'The result could not be confirmed. Check the current account status before retrying.';
  if (code === 'resource-exhausted') return 'Too many attempts. Wait a moment before trying again.';
  return 'The action could not be completed. Check the current account status before trying again.';
}

export function passwordAuthError(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (code === 'auth/network-request-failed') return 'Unable to confirm your sign-in. Check your connection and try again.';
  if (code === 'auth/too-many-requests') return 'Too many attempts. Wait a moment and try again.';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return 'Sign-in confirmation was cancelled. No password change was submitted.';
  if (code === 'auth/popup-blocked') return 'Allow the sign-in popup for this site, then try again.';
  if (code === 'auth/user-mismatch') return 'Confirm the same account that is currently signed in.';
  if (code === 'auth/user-token-expired' || code === 'auth/invalid-user-token') return 'Your sign-in has expired. Sign in again before changing a password.';
  return 'Your sign-in could not be confirmed. Check your own current password or linked sign-in account.';
}

const providerLabels: Record<string, string> = { password: 'Password', 'google.com': 'Google', 'microsoft.com': 'Microsoft', 'apple.com': 'Apple', 'yahoo.com': 'Yahoo', 'facebook.com': 'Facebook', 'github.com': 'GitHub', 'twitter.com': 'Twitter' };
export function reauthenticationMethods(user: User | null): { id: string; label: string }[] {
  return [...new Set(user?.providerData.map(p => p.providerId) || [])]
    .filter(id => !!providerLabels[id] || id.startsWith('oidc.') || id.startsWith('saml.'))
    .map(id => ({ id, label: providerLabels[id] || 'Existing linked sign-in' }));
}
function linkedProvider(id: string): AuthProvider {
  if (id === 'google.com') return new GoogleAuthProvider();
  if (id === 'facebook.com') return new FacebookAuthProvider();
  if (id === 'github.com') return new GithubAuthProvider();
  if (id === 'twitter.com') return new TwitterAuthProvider();
  if (id.startsWith('saml.')) return new SAMLAuthProvider(id);
  return new OAuthProvider(id);
}

// Only the current user's already-linked method is used; no account/provider is created.
export async function confirmOwnSignIn(user: User, providerId: string, currentPassword: string): Promise<void> {
  if (!reauthenticationMethods(user).some(method => method.id === providerId)) throw new Error('UNSUPPORTED_LINKED_PROVIDER');
  const uid = user.uid;
  if (providerId === 'password') {
    if (!user.email || !currentPassword) throw new Error('CURRENT_PASSWORD_REQUIRED');
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, currentPassword));
  } else {
    await reauthenticateWithPopup(user, linkedProvider(providerId));
  }
  if (auth.currentUser?.uid !== uid) throw new Error('CURRENT_IDENTITY_CHANGED');
  await user.getIdToken(true);
}
