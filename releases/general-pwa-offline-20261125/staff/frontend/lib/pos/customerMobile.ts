import { normalizeIndianPhoneE164 } from '../complimentaryOrders';
export function customerMobile(value: string): { normalized: string | null; error: string | null } {
  const raw=value.trim(); if(!raw)return{normalized:null,error:null};
  if(!/^[+\d\s().-]+$/.test(raw)||raw.slice(1).includes('+'))return{normalized:null,error:'Enter a valid mobile number; masks, letters and extensions are not supported.'};
  if(raw.startsWith('+')&&!raw.startsWith('+91')||raw.replace(/\D/g,'').startsWith('00')&&!raw.replace(/\D/g,'').startsWith('0091'))return{normalized:null,error:'Use an Indian mobile number with country code +91. Other country codes are not supported.'};
  let digits=raw.replace(/\D/g,'');if(digits.length===14&&digits.startsWith('0091'))digits=digits.slice(2);
  const normalized=normalizeIndianPhoneE164(digits);
  if(!normalized||/^(\d)\1{9}$/.test(normalized.slice(3)))return{normalized:null,error:'Enter a valid Indian mobile number, or leave Mobile blank.'};
  return{normalized,error:null};
}
export function maskMobile(value:string):string {const p=customerMobile(value).normalized;return p?'+91 '+p.slice(3,5)+'••••••'+p.slice(-2):'Not provided';}
