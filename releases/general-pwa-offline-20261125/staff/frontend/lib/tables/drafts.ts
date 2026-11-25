// This feature stores references only. Prices, labels and contact details are never cached.
export type TableDraftLine = {
  orderItemId:string; parentProductId:string; parentProductCode:string; quantity:number;
  selectedAddOns:{groupId:string;optionId:string;quantity:number}[];
  label:string; optionsLabel:string; price:number;
};
export type TableDraft = {id:string;items:TableDraftLine[]};
export type DraftStatus = 'saved'|'memory-only'|'corrupt';
const PREFIX='coffee-bond-pos-draft:v1:'; // Keep the scoped legacy key; version the value.
const memory=new Map<string,any>();
const statuses=new Map<string,DraftStatus>();
const reference=(v:unknown):v is string=>typeof v==='string' && v.length>0 && v.length<=200;
const quantity=(v:unknown):v is number=>Number.isInteger(v) && Number(v)>0 && Number(v)<=1000;
const options=(value:any)=>{
  if(!Array.isArray(value)||value.length>40)throw Error('Invalid option references');
  return value.map(a=>{if(!a||!reference(a.groupId)||!reference(a.optionId)||!quantity(a.quantity))throw Error('Invalid option');return {groupId:a.groupId,optionId:a.optionId,quantity:a.quantity}});
};
export const draftKey=(uid:string,storeId:string,sessionId:string|null)=>PREFIX+[uid,storeId,sessionId||'counter'].map(encodeURIComponent).join(':');
export function sanitizeDraft(value:any):any {
  if(!value || typeof value!=='object')throw Error('Invalid draft');
  if(Array.isArray(value.cart))return {schemaVersion:2,orderType:['DINE_IN','TAKEAWAY','DELIVERY'].includes(value.orderType)?value.orderType:'DINE_IN',cart:value.cart.map((l:any)=>{
    if(!l||!reference(l.id)||!reference(l.menuItemId)||!quantity(l.quantity))throw Error('Invalid item');
    return {id:l.id,menuItemId:l.menuItemId,quantity:l.quantity,addOns:options(l.addOns||[])};
  })};
  if(reference(value.id)&&Array.isArray(value.items))return {schemaVersion:2,id:value.id,items:value.items.map((l:any)=>{
    if(!l||!reference(l.orderItemId)||!reference(l.parentProductId)||!reference(l.parentProductCode)||!quantity(l.quantity)||l.quantity>20)throw Error('Invalid table item');
    return {orderItemId:l.orderItemId,parentProductId:l.parentProductId,parentProductCode:l.parentProductCode,quantity:l.quantity,selectedAddOns:options(l.selectedAddOns)};
  })};
  throw Error('Invalid draft');
}
export function draftStatus(key:string):DraftStatus{return statuses.get(key)||'saved'}
export function readLocalDraft<T>(key:string,fallback:T,storage?:Pick<Storage,'getItem'>):T {
  if(!key.startsWith(PREFIX))throw Error('Unscoped draft key');
  if(memory.has(key))return memory.get(key) as T;
  try {
    const target=storage??window.localStorage,raw=target.getItem(key);if(!raw)return fallback;
    const clean=sanitizeDraft(JSON.parse(raw));memory.set(key,clean);
    // Sanitize only this feature's record; never touch held bills or payment markers.
    if(JSON.stringify(clean)!==raw){try{(target as Storage).setItem(key,JSON.stringify(clean));statuses.set(key,'saved')}catch{statuses.set(key,'memory-only');try{(target as Storage).removeItem(key)}catch{/* show warning; prohibited data is never restored */}}}
    return clean as T;
  } catch {statuses.set(key,'corrupt');return fallback}
}
export function writeLocalDraft(key:string,value:unknown,storage?:Pick<Storage,'setItem'>):boolean {
  if(!key.startsWith(PREFIX))throw Error('Unscoped draft key');
  const clean=sanitizeDraft(value);memory.set(key,clean);
  try{(storage??window.localStorage).setItem(key,JSON.stringify(clean));statuses.set(key,'saved');return true}
  catch{statuses.set(key,'memory-only');return false}
}
export function readTableDraft(key:string):TableDraft {
  const empty=()=>({id:crypto.randomUUID(),items:[]});const v=readLocalDraft<any>(key,null);
  if(!v?.items)return empty();
  return {id:v.id,items:v.items.map((l:any)=>({...l,label:l.parentProductCode,optionsLabel:l.selectedAddOns.length?'Saved options · review after reconnect':'',price:0}))};
}
export function listLockedDrafts(uid:string,storage:Storage=window.localStorage) {
  const prefix=PREFIX+encodeURIComponent(uid)+':';const records:{scope:string;count:number}[]=[];
  for(let i=0;i<storage.length;i++){const key=storage.key(i);if(!key?.startsWith(prefix))continue;const v=readLocalDraft<any>(key,null,storage);if(v)records.push({scope:key.slice(prefix.length).split(':').map(decodeURIComponent).join(' / '),count:(v.cart||v.items||[]).reduce((n:number,l:any)=>n+l.quantity,0)})}
  return records;
}
export function assertCounterContext(tableActive:boolean){if(tableActive)throw Error('A running table must use tableService; counter checkout is blocked.')}
