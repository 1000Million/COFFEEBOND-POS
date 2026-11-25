import assert from 'node:assert/strict';
import {calculateTotals} from '../frontend/lib/pos/posTotals';
import {authorizeFinancials} from '../functions/posCheckoutFinancials.js';
for(let seed=0;seed<500;seed++){
 const percent=(seed%3===0?0:seed%3===1?10:20),items=Array.from({length:1+seed%30},(_,i)=>({orderItemId:'line-'+i,parentProductId:'product-'+i,parentProductCode:'CODE'+i,quantity:1+(seed+i)%20,baseUnitPrice:((seed*17+i*23)%10000)/100,taxRate:[0,5,12,18][(seed+i)%4],addOns:[{groupId:'g',optionId:'o',quantity:1,totalPrice:((seed+i)%30)/10,taxRate:[5,12,18][i%3]}],addOnTotal:((seed+i)%30)/10}));
 const f=authorizeFinancials({canonicalItems:Object.fromEntries(items.map(l=>[l.orderItemId,l])),orderId:'order',role:'STORE_MANAGER',discountPercent:percent,paymentMethod:'CASH',splitPayments:undefined});
 const current=calculateTotals(items.map(l=>({price:l.baseUnitPrice,quantity:l.quantity,taxRate:l.taxRate,addOns:l.addOns as any})),percent,0);
 for(const key of ['subtotal','discountPercent','discountAmount','taxableAmount','taxTotal','grandTotal'] as const)assert(Math.abs(f[key]-current[key])<1e-9,`${seed} ${key}: ${f[key]} != ${current[key]}`);
}
console.log('PASS: 500 deterministic mixed-tax/add-on/quantity baskets match unchanged POS financial definitions; unrounded values retained');
