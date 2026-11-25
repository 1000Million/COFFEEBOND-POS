import { calculateTotals } from '../pos/posTotals';
import { customerMobile } from '../pos/customerMobile';
export { customerMobile };
export function tableTotals(lines: any[], discountPercent = 0) {
  const items = lines.filter(l => !l.cancelled).map(l => ({ price:l.baseUnitPrice, quantity:l.quantity, taxRate:l.taxRate, addOns:l.addOns }));
  const totals = calculateTotals(items, discountPercent, 0);
  const money=(n:number)=>Math.round((n+Number.EPSILON)*100)/100;
  return {...Object.fromEntries(Object.entries(totals).map(([k,v])=>[k,money(v)])),gstTotal:money(totals.taxTotal)};
}
export function tableLineTotals(line:any, discountPercent:number) {
  const totals=calculateTotals([{price:line.baseUnitPrice,quantity:line.cancelled?0:line.quantity,taxRate:line.taxRate,addOns:line.addOns}],discountPercent,0);
  return {lineSubtotal:totals.subtotal,lineDiscount:totals.discountAmount,lineTaxable:totals.taxableAmount,lineTax:totals.taxTotal,lineTotal:totals.grandTotal};
}
