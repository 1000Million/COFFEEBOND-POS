import { httpsCallable } from 'firebase/functions';
import { customerFunctions } from './customerAuth';
import { CUSTOMER_MY_USUAL_VERSION, CustomerMyUsual, parseCustomerMyUsual } from './customerMyUsual';

/**
 * The only route between the customer app and a saved "My Usual".
 *
 * Every call travels over the authenticated customer session created by the existing
 * OTP flow, so the backend derives the owning uid from the verified token. No function
 * here takes a uid argument — there is deliberately no way for the UI to ask for
 * somebody else's usual. There is no Firestore read or write on this path either:
 * `customerProfiles` is closed to clients by firestore.rules.
 */

export type MyUsualApiResponse = {
  myUsual: CustomerMyUsual | null;
  schemaVersion: number;
  /** Server write time, or null when nothing is saved. */
  updatedAt: string | null;
};

export type MyUsualSaveResponse = MyUsualApiResponse & {
  saved: boolean;
  /** True when the payload matched what was already stored and nothing was rewritten. */
  unchanged: boolean;
};

export type MyUsualDeleteResponse = {
  deleted: boolean;
  existed: boolean;
};

/** The reference-only payload the backend accepts. Prices and identity never appear. */
export type MyUsualSavePayload = {
  schemaVersion: typeof CUSTOMER_MY_USUAL_VERSION;
  preferredStoreId: string;
  orderType: CustomerMyUsual['orderType'];
  items: CustomerMyUsual['items'];
};

const getCallable = httpsCallable<Record<string, never>, MyUsualApiResponse>(
  customerFunctions,
  'getCustomerMyUsual',
);
const saveCallable = httpsCallable<MyUsualSavePayload, MyUsualSaveResponse>(
  customerFunctions,
  'saveCustomerMyUsual',
);
const deleteCallable = httpsCallable<Record<string, never>, MyUsualDeleteResponse>(
  customerFunctions,
  'deleteCustomerMyUsual',
);

export class CustomerMyUsualError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'CustomerMyUsualError';
    this.code = code;
  }
}

/**
 * Turns a callable rejection into a short, retryable sentence. The raw error and the
 * payload are never logged — a My Usual request carries the customer's session, and a
 * console entry is the easiest place for that to leak.
 */
function normalizeError(error: unknown): CustomerMyUsualError {
  const code = String((error as { code?: string })?.code || 'unknown').replace('functions/', '');
  if (code === 'unauthenticated') {
    return new CustomerMyUsualError('Sign in again to use My Usual.', code);
  }
  if (code === 'permission-denied' || code === 'failed-precondition') {
    return new CustomerMyUsualError('We could not reach your Coffee Bond profile. Sign in and try again.', code);
  }
  if (code === 'invalid-argument') {
    return new CustomerMyUsualError('That basket cannot be saved as My Usual. Please adjust it and try again.', code);
  }
  return new CustomerMyUsualError('We could not reach your Coffee Bond profile. Please try again.', code);
}

/**
 * Re-parses whatever the server returned through the same schema guard the app uses
 * everywhere else, so a malformed or future-version document can never render.
 */
function parseResponse(data: MyUsualApiResponse | undefined): MyUsualApiResponse {
  if (!data || !data.myUsual) {
    return { myUsual: null, schemaVersion: CUSTOMER_MY_USUAL_VERSION, updatedAt: data?.updatedAt ?? null };
  }
  const parsed = parseCustomerMyUsual(data.myUsual);
  return {
    myUsual: parsed.status === 'VALID' ? parsed.usual : null,
    schemaVersion: data.schemaVersion ?? CUSTOMER_MY_USUAL_VERSION,
    updatedAt: data.updatedAt ?? null,
  };
}

export async function getCustomerMyUsual(): Promise<MyUsualApiResponse> {
  try {
    const result = await getCallable({});
    return parseResponse(result.data);
  } catch (error) {
    throw normalizeError(error);
  }
}

export async function saveCustomerMyUsual(payload: MyUsualSavePayload): Promise<MyUsualApiResponse> {
  try {
    const result = await saveCallable(payload);
    return parseResponse(result.data);
  } catch (error) {
    throw normalizeError(error);
  }
}

export async function deleteCustomerMyUsual(): Promise<MyUsualDeleteResponse> {
  try {
    const result = await deleteCallable({});
    return { deleted: Boolean(result.data?.deleted), existed: Boolean(result.data?.existed) };
  } catch (error) {
    throw normalizeError(error);
  }
}
