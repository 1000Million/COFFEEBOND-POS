import {requireOnlineAction,OFFLINE_ACTION_MESSAGE} from '../connectivity';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';
export const TABLE_STORE = 'HCLGB7BRuIxp9gLjDdca';
export const SECTOR51_TABLE_STORE = 'L0qB13uuPxHvv089YtGQ';
export const isLegacyTableStore = (storeId:string) => storeId===TABLE_STORE||storeId===SECTOR51_TABLE_STORE;
export const validPosStoreId = (storeId:unknown):storeId is string =>
  typeof storeId==='string' && storeId.length>0 && storeId.length<=120 && /^[A-Za-z0-9_-]+$/.test(storeId);
export const tableStoreName = (storeId:string) => storeId===TABLE_STORE?'Uday Park':storeId===SECTOR51_TABLE_STORE?'Noida Sector 51':'Selected store';
const callable=httpsCallable<any,any>(functions,'tableService');
export async function tableCall(data:any) { if(!requireOnlineAction())throw Object.assign(new Error(OFFLINE_ACTION_MESSAGE),{code:'client/offline'}); const storeId=data.storeId??TABLE_STORE;if(!validPosStoreId(storeId))throw Object.assign(new Error('Table service is unavailable for this store.'),{code:'functions/permission-denied'});return (await callable({storeId,...data})).data; }
export function tableError(error:unknown) {
  const code=(error as any)?.code;
  if(code==='client/offline')return OFFLINE_ACTION_MESSAGE;
  if(['functions/aborted','functions/already-exists','functions/failed-precondition','functions/invalid-argument','functions/permission-denied','functions/not-found','functions/resource-exhausted'].includes(code))return String((error as any).message);
  return 'Table service is unavailable. Refresh to check the saved state. Keep the same operation when retrying; do not start another payment.';
}
