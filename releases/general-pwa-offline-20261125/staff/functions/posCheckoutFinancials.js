'use strict';
// Mirrors the existing unrounded POS totals/line/payment definitions. No new ledger.
const METHODS=new Set(['CASH','UPI','CARD','SWIGGY','ZOMATO','CREDIT']);
const id=value=>String(value||'').trim().replace(/[^A-Za-z0-9_-]/g,'_').replace(/_+/g,'_').replace(/^_+|_+$/g,'').slice(0,220);
function financialError(message){const e=new Error(message);e.code='invalid-argument';throw e}
function authorizeFinancials({canonicalItems,orderId,role,discountPercent=0,paymentMethod,splitPayments}){
 const complimentary=paymentMethod==='COMPLIMENTARY';
 const percent=Number(discountPercent),limit=role==='ADMIN'?100:role==='STORE_MANAGER'?20:10;
 if(!Number.isFinite(percent)||percent<0||percent>limit)financialError(`Discount exceeds the ${limit}% limit for this role.`);
 const items=Object.values(canonicalItems),subtotal=items.reduce((s,l)=>s+(l.baseUnitPrice+l.addOnTotal)*l.quantity,0);
 const discount=complimentary?subtotal:subtotal*(percent/100),ratio=subtotal>0?discount/subtotal:0;
 const addOnTax=l=>(l.addOns||[]).reduce((s,a)=>s+Math.max(0,a.totalPrice*l.quantity*(1-ratio))*Math.max(0,a.taxRate)/100,0);
 const taxTotal=complimentary?0:items.reduce((s,l)=>s+Math.max(0,l.baseUnitPrice*l.quantity-(l.baseUnitPrice*l.quantity*ratio))*(l.taxRate/100)+addOnTax(l),0);
 const taxableAmount=Math.max(0,subtotal-discount),grandTotal=taxableAmount+taxTotal;
 const lines=Object.fromEntries(items.map(l=>{const lineSubtotal=(l.baseUnitPrice+l.addOnTotal)*l.quantity,lineDiscount=complimentary?lineSubtotal:lineSubtotal*ratio,lineTaxable=Math.max(0,lineSubtotal-lineDiscount),lineTax=complimentary?0:Math.max(0,l.baseUnitPrice*l.quantity*(1-ratio))*(l.taxRate/100)+addOnTax(l);return [l.orderItemId,{lineSubtotal,lineDiscount,lineTaxable,lineTax,lineTotal:lineTaxable+lineTax}]}));
 const split=paymentMethod==='SPLIT';let rows=[];
 if(!complimentary){
  if(split){
   if(!Array.isArray(splitPayments)||!splitPayments.length||splitPayments.length>30)financialError('Split payment needs 1–30 tender rows.');
   rows=splitPayments.map(p=>({method:p.method,amount:Number(p.amount)})).filter(p=>p.amount>0||grandTotal===0);
   if(!rows.length||rows.some(p=>!METHODS.has(p.method)||!Number.isFinite(p.amount)||p.amount<0)||Math.abs(rows.reduce((s,p)=>s+p.amount,0)-grandTotal)>.01)financialError('Split payment must equal the canonical total.');
  }else{if(!METHODS.has(paymentMethod))financialError('Unsupported counter payment method.');rows=[{method:paymentMethod,amount:paymentMethod==='CREDIT'?0:grandTotal}]}
 }
 const credit=rows.filter(p=>p.method==='CREDIT').reduce((s,p)=>s+p.amount,0);
 const paymentStatus=complimentary?'NOT_REQUIRED':split?(credit<=.01?'PAID':credit>=grandTotal-.01?'UNPAID':'PARTIAL'):(paymentMethod==='CREDIT'&&grandTotal>0?'UNPAID':'PAID');
 const payments=Object.fromEntries(rows.map((p,index)=>[id(`${orderId}_PAY_${String(index+1).padStart(2,'0')}_${p.method}`),{...p,paymentIndex:index}]));
 return {version:2,subtotal,discountPercent:complimentary?100:percent,discountAmount:discount,taxableAmount,taxTotal,grandTotal,lines,payments,paymentIds:Object.keys(payments),paymentStatus,paymentMethod:rows[0]?.method||paymentMethod,isSplitPayment:split};
}
module.exports={authorizeFinancials};
