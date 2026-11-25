import {useEffect, useState} from 'react';
import type {ConfirmationResult} from 'firebase/auth';
import type {TableOrder} from '../../lib/tables/useTableOrder';
import {validateComplimentaryCheckout, isComplimentaryVerificationExpired, type ComplimentaryOtpVerification} from '../../lib/complimentaryOrders';
import {sendComplimentaryPhoneOtp, verifyComplimentaryPhoneOtp, disposeComplimentaryPhoneVerification, complimentaryPhoneErrorMessage, complimentaryPhoneErrorCode, complimentaryRecaptchaContainerId} from '../../lib/complimentaryPhoneVerification';
import {useUpdateBlocker} from '../../lib/useUpdateBlocker';
import {requireOnlineAction, OFFLINE_ACTION_MESSAGE} from '../../lib/connectivity';

export default function TableComplimentaryClosing({table,onSettled}:{table:TableOrder;onSettled:()=>Promise<void>}) {
  const [name,setName]=useState(''),[phone,setPhone]=useState(''),[reason,setReason]=useState(''),[code,setCode]=useState('');
  const [confirmation,setConfirmation]=useState<ConfirmationResult|null>(null);
  const [verification,setVerification]=useState<ComplimentaryOtpVerification|null>(null);
  const [working,setWorking]=useState(false),[message,setMessage]=useState(''),[cooldown,setCooldown]=useState(0),[clock,setClock]=useState(Date.now());
  const {session,busy,pending,locked}=table;
  const blocked=!table.operationalReady||working||busy||!!pending||locked||!!table.draft.length||table.externalLocked;
  const expired=isComplimentaryVerificationExpired(verification,clock);
  const errors=validateComplimentaryCheckout({customerName:name,customerPhone:phone,reason,verification});
  useUpdateBlocker(working||!!name||!!phone||!!reason||!!confirmation||!!verification);
  useEffect(()=>{const id=setInterval(()=>{setClock(Date.now());setCooldown(n=>Math.max(0,n-1));},1000);return()=>{clearInterval(id);void disposeComplimentaryPhoneVerification();};},[]);
  const resetPhone=(value:string)=>{setPhone(value.replace(/\D/g,'').slice(0,10));setVerification(null);setConfirmation(null);setCode('');setMessage('');setCooldown(0);void disposeComplimentaryPhoneVerification();};
  const send=async()=>{
    if(blocked||cooldown||!/^[6-9][0-9]{9}$/.test(phone))return;
    if(!requireOnlineAction()){setMessage(OFFLINE_ACTION_MESSAGE);return;}
    setWorking(true);setMessage('Sending SMS verification…');setVerification(null);setCode('');
    try{setConfirmation(await sendComplimentaryPhoneOtp(phone));setCooldown(30);setMessage('Enter the six-digit SMS code.');}
    catch(e){setMessage(complimentaryPhoneErrorMessage(e));}finally{setWorking(false);}
  };
  const verify=async()=>{
    if(blocked||!confirmation||!session?.orderId)return;
    if(!requireOnlineAction()){setMessage(OFFLINE_ACTION_MESSAGE);return;}
    setWorking(true);setMessage('Verifying the exact table bill…');
    try{const result=await verifyComplimentaryPhoneOtp({confirmationResult:confirmation,code,expectedPhone:phone,storeId:table.storeId,tableContext:{sessionId:session.id,orderId:session.orderId,version:session.version}});setVerification(result);setConfirmation(null);setCode('');setMessage('Phone verified for this exact table bill. Authorization expires in five minutes.');}
    catch(e){setMessage(complimentaryPhoneErrorMessage(e));setVerification(null);setCode('');if(complimentaryPhoneErrorCode(e)!=='auth/invalid-verification-code')setConfirmation(null);}
    finally{setWorking(false);}
  };
  const close=async()=>{
    if(blocked||errors.length||!verification||expired)return;
    setWorking(true);
    try{const result=await table.command('COMPLIMENTARY_CLOSE',{customerName:name.trim(),customerPhone:phone,reason:reason.trim(),authorizationId:verification.authorizationId},verification.expiresAtIso);if(result)await onSettled();}
    finally{setWorking(false);}
  };
  return <section className="table-card table-complimentary" aria-label="Complimentary closing">
    <h3>Complimentary closing · customer OTP</h3>
    <p>No payment is collected. Menu value is retained in the Complimentary report; taxable amount, GST and payable become ₹0 only after server confirmation.</p>
    <p>Kitchen items must be served or cancellations reconciled before the table is released. Existing KOT and stock effects are retained.</p>
    <label>Customer name<input aria-label="Complimentary customer name" autoComplete="off" maxLength={120} value={name} disabled={blocked} onChange={e=>setName(e.target.value)}/></label>
    <label>Customer mobile<input aria-label="Complimentary customer phone" autoComplete="off" inputMode="tel" maxLength={10} value={phone} disabled={blocked} onChange={e=>resetPhone(e.target.value)}/></label>
    <label>Complimentary reason<textarea aria-label="Complimentary reason" maxLength={240} value={reason} disabled={blocked} onChange={e=>setReason(e.target.value)}/></label>
    {verification&&!expired?<p role="status">Phone verified · ••••••{phone.slice(-4)} · five-minute, single-use authorization</p>:<>
      {expired&&<p role="alert">Verification expired. Send a new OTP.</p>}
      <button type="button" disabled={blocked||cooldown>0||!/^[6-9][0-9]{9}$/.test(phone)} onClick={()=>void send()}>{cooldown?`Resend in ${cooldown}s`:confirmation?'Resend OTP':'Send OTP'}</button>
      {confirmation&&<><label>SMS code<input aria-label="Complimentary OTP" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} disabled={blocked} onChange={e=>setCode(e.target.value.replace(/\D/g,'').slice(0,6))}/></label><button type="button" disabled={blocked||code.length!==6} onClick={()=>void verify()}>Verify OTP</button></>}
    </>}
    <div id={complimentaryRecaptchaContainerId()}/>
    {message&&<p role="status">{message}</p>}
    <button type="button" disabled={blocked||errors.length>0||expired} onClick={()=>void close()}>Close as complimentary · ₹0</button>
    <p>OTP codes, phone-auth credentials and this form are not saved on this device. Do not use complimentary closing to resolve a paid or uncertain payment.</p>
  </section>;
}
