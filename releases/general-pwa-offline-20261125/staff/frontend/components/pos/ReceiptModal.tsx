import React from 'react';
import WhatsAppReceiptShare from './WhatsAppReceiptShare';
import { maskMobile } from '../../lib/pos/customerMobile';
import { CheckCircle, FileText, Printer } from 'lucide-react';
import type { ReceiptSnapshot } from '../../lib/pos/posOrderLifecycle';
export interface ReceiptModalProps {
  receiptView: ReceiptSnapshot;
  receiptViewTitle: string;
  receiptGst: { cgst: number; sgst: number } | null;
  showGstin: boolean;
  showState: boolean;
  printReceiptElement: () => void;
  onClose: () => void;
  prepareWhatsAppReceipt?: () => Promise<ReceiptSnapshot>;
  unpaidPreview?: boolean;
  closeLabel?: string;
}
export default function ReceiptModal({ receiptView, receiptViewTitle, receiptGst, showGstin, showState, printReceiptElement, onClose, prepareWhatsAppReceipt, unpaidPreview=false, closeLabel='New Order' }: ReceiptModalProps) {
  return (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-3 sm:p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden flex flex-col max-h-[90vh]">
            <div className="bg-[#5c4033] p-6 text-center text-white shrink-0 relative">
               {unpaidPreview?<FileText size={48} className="mx-auto mb-3"/>:<CheckCircle size={48} className="mx-auto mb-3 text-emerald-400" />}
               <h2 className="text-2xl font-black mb-1 tracking-tight">{receiptViewTitle}</h2>
               <p className="text-white/80 font-mono text-sm">{receiptView.order.orderNumber}</p>
            </div>

            {/* Printable Receipt Area */}
            <div id="receipt-area" className="p-6 bg-white flex-1 overflow-y-auto custom-scrollbar text-neutral-800 text-sm">
               {unpaidPreview&&<p className="mb-4 border-2 border-neutral-800 p-3 text-center font-black">UNPAID BILL PREVIEW — NOT A PAYMENT RECEIPT</p>}
               <div className="text-center mb-6 border-b border-dashed border-neutral-300 pb-6">
	                 <h1 className="text-xl font-black uppercase tracking-widest mb-1">
	                   {receiptView.order.receiptLegalDetails?.tradeName || receiptView.order.receiptLegalDetails?.legalName || 'Coffee Bond'}
	                 </h1>
	                 <p className="font-bold text-neutral-600">{receiptView.order.storeName}</p>
	                 {receiptView.order.receiptLegalDetails?.legalAddress && (
	                   <p className="mt-1 text-xs text-neutral-500">{receiptView.order.receiptLegalDetails.legalAddress}</p>
	                 )}
	                 {showGstin && (
	                   <p className="mt-1 text-xs font-bold text-neutral-600">GSTIN: {receiptView.order.receiptLegalDetails!.gstin}</p>
	                 )}
	                 {showState && (
	                   <p className="text-xs text-neutral-500">
	                     {receiptView.order.receiptLegalDetails!.stateName}
	                     {receiptView.order.receiptLegalDetails!.stateCode ? ` (${receiptView.order.receiptLegalDetails!.stateCode})` : ''}
	                   </p>
	                 )}
                 <p className="text-neutral-500 mt-2 text-xs">{new Date(receiptView.order.createdAtIso).toLocaleString()}</p>
                 <p className="text-neutral-500 text-xs">Staff: {receiptView.order.createdByName}</p>
                 {receiptView.order.customerName && <p className="text-neutral-500 text-xs mt-1">Guest: {receiptView.order.customerName} {receiptView.order.customerPhone ? `(${maskMobile(receiptView.order.customerPhone)})` : ''}</p>}
                 <p className="font-bold mt-3 border border-neutral-200 inline-block px-3 py-1 rounded-md">{receiptView.order.orderType.replace('_', ' ')} {receiptView.order.tableNumber ? `- Table ${receiptView.order.tableNumber}` : ''}</p>
               </div>

               <div className="space-y-3 mb-6 border-b border-dashed border-neutral-300 pb-6">
                 <div className="flex justify-between font-bold text-xs text-neutral-500 uppercase pb-1 border-b border-neutral-100">
                    <span>Item</span>
                    <span>Total</span>
                 </div>
                 {receiptView.items.map((item, i) => (
                   <div key={i} className="flex justify-between items-start text-sm">
                     <div>
                       <p className="font-bold leading-tight">{item.itemName}</p>
                       <p className="text-xs text-neutral-500 font-mono">{item.quantity} x ₹{item.unitPrice.toFixed(2)}</p>
                       {(item.addOns || []).map(addOn => (
                         <p key={`${addOn.groupId}-${addOn.optionId}`} className="pl-2 text-xs text-neutral-500">
                           + {addOn.optionName}{addOn.quantity > 1 ? ` x ${addOn.quantity}` : ''} ₹{addOn.totalPrice.toFixed(2)}
                         </p>
                       ))}
                     </div>
                     <span className="font-bold font-mono">₹{item.lineTotal.toFixed(2)}</span>
                   </div>
                 ))}
               </div>

               <div className="space-y-2 mb-6 text-sm">
	                 <div className="flex justify-between text-neutral-500">
	                    <span>{receiptView.order.commercialStatus === 'COMPLIMENTARY' ? 'Menu Value' : 'Subtotal'}</span>
	                    <span className="font-mono text-neutral-800">₹{(receiptView.order.menuValue ?? receiptView.order.subtotal).toFixed(2)}</span>
	                 </div>
	                 {receiptView.order.commercialStatus === 'COMPLIMENTARY' ? (
	                   <div className="flex justify-between text-red-500">
	                     <span>Complimentary Discount</span>
	                     <span className="font-mono">-₹{(receiptView.order.complimentaryDiscount ?? receiptView.order.discountAmount).toFixed(2)}</span>
	                   </div>
	                 ) : receiptView.order.discountAmount > 0 && (
	                   <div className="flex justify-between text-red-500">
                      <span>Discount ({receiptView.order.discountPercent.toFixed(2)}%)</span>
                      <span className="font-mono">-₹{receiptView.order.discountAmount.toFixed(2)}</span>
                   </div>
                 )}
                 <div className="flex justify-between text-neutral-500">
                    <span>{receiptView.order.gstTreatmentSnapshot?.mode === 'NO_GST' ? 'Amount after discount' : 'Taxable Amount'}</span>
                    <span className="font-mono text-neutral-800">₹{receiptView.order.taxableAmount.toFixed(2)}</span>
                 </div>
                 {receiptGst && (
                   <>
                     <div className="flex justify-between text-neutral-500">
                        <span>CGST</span>
                        <span className="font-mono text-neutral-800">₹{receiptGst.cgst.toFixed(2)}</span>
                     </div>
                     <div className="flex justify-between text-neutral-500">
                        <span>SGST</span>
                        <span className="font-mono text-neutral-800">₹{receiptGst.sgst.toFixed(2)}</span>
                     </div>
                     <div className="flex justify-between text-neutral-500 pb-2 border-b border-neutral-100">
                        <span>Total GST</span>
                        <span className="font-mono text-neutral-800">₹{receiptView.order.gstTotal.toFixed(2)}</span>
                     </div>
                   </>
                 )}
	                 <div className="flex justify-between font-black text-lg pt-1">
	                    <span>{receiptView.order.commercialStatus === 'COMPLIMENTARY' ? 'Amount Payable' : 'Bill total'}</span>
	                    <span className="font-mono">₹{receiptView.order.grandTotal.toFixed(2)}</span>
	                 </div>
	               </div>

	               <div className="text-xs font-bold text-neutral-500 mb-6">
	                 {receiptView.order.commercialStatus === 'COMPLIMENTARY' ? (
	                   <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-center text-amber-900">
	                     <p className="font-black">COMPLIMENTARY — NO PAYMENT REQUIRED</p>
	                     <p>Payment Status: NOT REQUIRED</p>
	                   </div>
	                 ) : receiptView.order.isSplitPayment ? (
                   <div className="rounded-lg border border-neutral-100 p-3 space-y-1">
                     <p className="text-center uppercase tracking-widest text-neutral-400 mb-2">Split Payment</p>
                     {receiptView.payments.map((payment, index) => (
                       <div key={`${payment.method}-${index}`} className="flex justify-between">
                         <span>{payment.method}</span>
                         <span className="font-mono">₹{payment.amount.toFixed(2)}</span>
                       </div>
                     ))}
                   </div>
                 ) : (
                   <p className="text-center">Payment Method: {receiptView.order.paymentMethod}</p>
                 )}
	                 {receiptView.order.commercialStatus !== 'COMPLIMENTARY' && (
	                   <p className="text-center mt-2">{receiptView.order.paymentStatus || 'PAID'}</p>
	                 )}
               </div>

               <div className="text-center font-bold text-neutral-400 pt-4 border-t border-dashed border-neutral-300">
                 Thank you! Keep Brewing.
               </div>
            </div>

            {!unpaidPreview&&<WhatsAppReceiptShare prepare={prepareWhatsAppReceipt}/>}
            <div className="p-4 bg-neutral-50 border-t border-neutral-200 grid grid-cols-2 gap-2 shrink-0">
               <button
                 onClick={printReceiptElement}
                 className="flex items-center justify-center gap-2 bg-white border border-neutral-200 hover:bg-neutral-100 text-neutral-700 font-bold py-3 rounded-xl transition-colors"
               >
                 <Printer size={18} /> Print
               </button>
               <button
                 onClick={onClose}
                 className="bg-[#5c4033] hover:bg-[#4a332a] text-white font-bold py-3 rounded-xl transition-colors"
               >
                 {closeLabel}
               </button>
            </div>
          </div>
        </div>
  );
}
