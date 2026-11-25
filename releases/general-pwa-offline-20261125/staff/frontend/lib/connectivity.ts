export const STAFF_OFFLINE_MESSAGE = "You’re offline. Payments, orders, KOT actions and stock changes are unavailable until the connection returns.";
export const CUSTOMER_OFFLINE_MESSAGE = "You’re offline. You can review your basket, but checkout and payment are unavailable until the connection returns.";
export const OFFLINE_ACTION_MESSAGE = 'This action requires an internet connection and has not been submitted.';

export const OFFLINE_ACTION_BLOCKED_EVENT = 'coffee-bond:offline-action-blocked';
export const CRITICAL_OPERATION_EVENT = 'coffee-bond:critical-operation';

let criticalOperationCount = 0;

function dispatchWindowEvent<T>(name: string, detail: T): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function browserIsOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

export function requireOnlineAction(): boolean {
  if (browserIsOnline()) return true;
  dispatchWindowEvent(OFFLINE_ACTION_BLOCKED_EVENT, { message: OFFLINE_ACTION_MESSAGE });
  return false;
}

export function beginCriticalOperation(): () => void {
  criticalOperationCount += 1;
  dispatchWindowEvent(CRITICAL_OPERATION_EVENT, { count: criticalOperationCount });
  let ended = false;

  return () => {
    if (ended) return;
    ended = true;
    criticalOperationCount = Math.max(0, criticalOperationCount - 1);
    dispatchWindowEvent(CRITICAL_OPERATION_EVENT, { count: criticalOperationCount });
  };
}

export async function runCriticalOnlineAction<T>(action: () => Promise<T>): Promise<T> {
  if (!requireOnlineAction()) throw new Error(OFFLINE_ACTION_MESSAGE);
  const end = beginCriticalOperation();
  try {
    return await action();
  } finally {
    end();
  }
}

const updateBlockers = new Set<symbol>();
export const UPDATE_SAFETY_EVENT = 'coffee-bond:update-safety';
let updateAccount:string|null|undefined;
let posBoundaries=0;
export function setUpdateAccount(uid:string|null|undefined){updateAccount=uid;dispatchWindowEvent(UPDATE_SAFETY_EVENT,{})}
export function registerPosUpdateBoundary(){posBoundaries++;dispatchWindowEvent(UPDATE_SAFETY_EVENT,{});return()=>{posBoundaries--;dispatchWindowEvent(UPDATE_SAFETY_EVENT,{})}}
export function updatesAreSafe():boolean {
  if(!browserIsOnline()||criticalOperationCount!==0||updateBlockers.size!==0||updateAccount===undefined)return false;
  if(typeof window==='undefined')return true;
  if(window.location?.pathname.startsWith('/pos')&&posBoundaries===0)return false;
  if(updateAccount){
    try{
      // Read only the established recovery markers. Never export, rewrite or clear them.
      if(window.localStorage.getItem('coffee-bond-table-command:'+updateAccount))return false;
      const counter=JSON.parse(window.localStorage.getItem('coffeeBondPos:pendingCheckoutAttempt:v1')||'null');
      if(counter?.payloadHash||counter?.previousPayloadHashes?.length)return false;
      const payment=JSON.parse(window.localStorage.getItem('coffeeBondPos:pendingRazorpaySession:v1')||'null');
      if(payment&&['CREATING','WAITING_FOR_PAYMENT','RECOVERING','PAYMENT_CAPTURED'].includes(payment.status))return false;
    }catch{return false}
  }
  return true;
}
export function blockAppUpdate():()=>void {
  const token=Symbol();updateBlockers.add(token);dispatchWindowEvent(UPDATE_SAFETY_EVENT,{});
  return ()=>{updateBlockers.delete(token);dispatchWindowEvent(UPDATE_SAFETY_EVENT,{})};
}
