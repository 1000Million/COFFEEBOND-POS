import type { ReceiptSnapshot } from './posOrderLifecycle';
import { customerMobile } from './customerMobile';
// Conservative limit for this first text-only flow; no truncation/attachment claim.
export const WHATSAPP_URL_LIMIT = 2000;
const rupees=(n:number)=>'₹'+n.toFixed(2);
export function receiptShareText(receipt:ReceiptSnapshot):string {
  const o=receipt.order;
  if(!receipt.savedDataLoaded||!o.sourceOrderId||o.savedStatus!=='COMPLETED'||!Number.isFinite(Date.parse(o.createdAtIso))||!receipt.items.length)throw Error('Load the final saved completed bill before sharing.');
  const legal=o.receiptLegalDetails,lines=[legal?.tradeName||o.storeName];
  if(legal?.legalName&&legal.legalName!==lines[0])lines.push(legal.legalName);
  if(legal?.legalAddress)lines.push(legal.legalAddress);
  const gst=o.gstTreatmentSnapshot?.mode!=='NO_GST'&&legal?.gstRegistered===true&&Boolean(legal.gstin);
  if(gst){lines.push('GSTIN: '+legal!.gstin);if(legal?.stateName)lines.push(legal.stateName+(legal.stateCode?' ('+legal.stateCode+')':''));}
  lines.push('Bill: '+o.orderNumber,new Date(o.createdAtIso).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})+' IST','');
  for(const item of receipt.items){lines.push(`${item.itemName} × ${item.quantity} @ ${rupees(item.unitPrice)} — ${rupees(item.lineTotal)}`);for(const a of item.addOns||[])lines.push(`  + ${a.optionName} × ${a.quantity} — ${rupees(a.totalPrice)}`);}
  lines.push('',`Subtotal: ${rupees(o.subtotal)}`);
  if(o.discountAmount>0)lines.push(`Discount (${o.discountPercent.toFixed(2)}%): -${rupees(o.discountAmount)}`);
  lines.push(`${o.gstTreatmentSnapshot?.mode==='NO_GST'?'Amount after discount':'Taxable amount'}: ${rupees(o.taxableAmount)}`);
  if(gst){const cgst=Math.round(o.gstTotal*50)/100;lines.push(`CGST: ${rupees(cgst)}`,`SGST: ${rupees(Math.round((o.gstTotal-cgst)*100)/100)}`,`Total GST: ${rupees(o.gstTotal)}`);}else if(o.gstTotal>0)lines.push(`Tax on saved bill: ${rupees(o.gstTotal)}`);
  lines.push(`Bill total: ${rupees(o.grandTotal)}`,`Payment status: ${o.paymentStatus||'UNKNOWN'}`);
  if(o.commercialStatus==='COMPLIMENTARY')lines.push('COMPLIMENTARY — NO PAYMENT REQUIRED');
  else for(const p of receipt.payments)lines.push(`${p.method}: ${rupees(p.amount)}`);
  lines.push('Thank you! Keep Brewing.');return lines.join('\n');
}
export function whatsAppReceiptUrl(recipient:string,text:string):{url?:string;error?:string} {
  const p=customerMobile(recipient);if(p.error||!p.normalized)return{error:p.error||'Enter a recipient mobile number.'};
  const url='https://wa.me/'+p.normalized.slice(1)+'?text='+encodeURIComponent(text);
  if(url.length>WHATSAPP_URL_LIMIT)return{error:'This receipt is too long for this WhatsApp text flow. Use Print and, if needed, your print dialog’s Save as PDF. No text has been truncated.'};
  return{url};
}
