import { useEffect,useRef,useState } from 'react';
import type { ReceiptSnapshot } from '../../lib/pos/posOrderLifecycle';
import { customerMobile } from '../../lib/pos/customerMobile';
import { receiptShareText,whatsAppReceiptUrl } from '../../lib/pos/whatsAppReceipt';
export default function WhatsAppReceiptShare({prepare}:{prepare?:()=>Promise<ReceiptSnapshot>}) {
  const[loading,setLoading]=useState(false),[loaded,setLoaded]=useState(false),[text,setText]=useState(''),[recipient,setRecipient]=useState(''),[consent,setConsent]=useState(false),[destination,setDestination]=useState(false),[message,setMessage]=useState('');
  const active=useRef(true);useEffect(()=>{active.current=true;return()=>{active.current=false}},[]);
  async function load(){if(!prepare||loading)return;setLoading(true);setMessage('');try{const r=await prepare(),t=receiptShareText(r);if(active.current){setText(t);setRecipient(customerMobile(r.order.customerPhone||'').normalized||'');setLoaded(true);setConsent(false);setDestination(false);}}catch{if(active.current)setMessage('The final saved completed bill could not be prepared. Review it in Running Orders, or use the existing Print action.');}finally{if(active.current)setLoading(false);}}
  const phone=customerMobile(recipient),link=loaded?whatsAppReceiptUrl(recipient,text):{};
  return <section aria-label="WhatsApp receipt sharing" className="max-h-[45vh] shrink-0 overflow-y-auto border-t border-neutral-200 bg-white p-4 text-sm">
    {!loaded?<><button type="button" disabled={!prepare||loading} onClick={()=>void load()} className="w-full rounded-xl border border-[#5c4033] px-3 py-3 font-bold text-[#5c4033] disabled:opacity-50">{loading?'Loading saved bill…':'Share bill on WhatsApp'}</button>{!prepare&&<p className="mt-2 text-xs text-neutral-600">Reopen this saved bill to share. Print remains available.</p>}</>:<>
      <label className="block font-bold" htmlFor="whatsapp-recipient">WhatsApp recipient</label><input id="whatsapp-recipient" type="tel" autoComplete="off" value={recipient} onChange={e=>{setRecipient(e.target.value);setConsent(false);setDestination(false);setMessage('');}} aria-invalid={Boolean(phone.error)} className="mt-1 w-full rounded-lg border border-neutral-400 p-2 focus-visible:outline-2 focus-visible:outline-[#5c4033]"/>
      <p className="mt-1 text-xs text-neutral-600">For this receipt only; changing this recipient does not edit the saved bill.</p>
      {link.error&&<p role="alert" className="mt-2 text-sm font-semibold text-red-700">{link.error}</p>}
      <details className="mt-2"><summary className="cursor-pointer font-semibold">Review saved receipt text</summary><pre className="mt-2 whitespace-pre-wrap break-words text-xs">{text}</pre></details>
      <label className="mt-3 flex gap-2"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>The customer requested this WhatsApp receipt.</label>
      <label className="mt-2 flex gap-2"><input type="checkbox" checked={destination} disabled={!phone.normalized} onChange={e=>setDestination(e.target.checked)}/>I checked the destination: {phone.normalized||'enter a valid recipient'}.</label>
      <button type="button" disabled={!link.url||!consent||!destination} onClick={()=>{if(!link.url||!consent||!destination)return;window.open(link.url,'_blank','noopener,noreferrer');setMessage('WhatsApp opening requested. Review the receipt and press Send from the café’s authorized account. Sending and delivery are not confirmed. If no chat opens, allow pop-ups and try again.');}} className="mt-3 w-full rounded-xl bg-[#5c4033] px-3 py-3 font-bold text-white disabled:opacity-40">Open WhatsApp for staff review</button>
      <p className="mt-2 text-xs text-neutral-600">Text only; no PDF attachment. Providing a receipt number is not marketing consent.</p>
    </>}
    {message&&<p role="status" className="mt-2 text-sm text-neutral-700">{message}</p>}
  </section>;
}
