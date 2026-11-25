import { restoreBundle10 } from './bundle10-test-support.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { transformSync, buildSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as icons from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
const require=createRequire(import.meta.url),root=new URL('../',import.meta.url);
const read=p=>fs.readFileSync(new URL(p,root),'utf8');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const fixture=JSON.parse(read('scripts/fixtures/bundle9/extraction.json'));
export function restoreBundle9(source) {
 // This suite compares unchanged extracted UI, not recovery orchestration.
 // Candidate source still has to match the exact reviewed recovery-edit pin.
 source = restoreBundle10(source, { includeRecoveryHandlers: false });
 for(const e of [...fixture.edits].reverse()) {
  assert(source.includes(e.replacement),`${e.name} parent integration changed`);
  source=source.replace(e.import,'').replace(e.replacement,e.original);
 }
 return source;
}
assert.equal(hash(restoreBundle9(read('frontend/pages/pos/POSHome.tsx'))),fixture.sourceSha256,'All untouched UI and authoritative logic must match sealed source');
const components={};
for(const name of ['PaymentPanel','MenuGrid','CartPanel']) {
 const source=read(`frontend/components/pos/${name}.tsx`);
 assert(!/firebase\/|\bany\b|\b(getDoc|getDocs|setDoc|updateDoc|runTransaction|httpsCallable|onSnapshot)\s*\(/.test(source));
 const module={exports:{}};vm.runInNewContext(transformSync(source,{loader:'tsx',format:'cjs',jsx:'transform'}).code,{module,exports:module.exports,require});components[name]=module.exports.default;
}
function load(file){const module={exports:{}};const code=buildSync({entryPoints:[new URL(file,root).pathname],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text;vm.runInNewContext(code,{module,exports:module.exports,require});return module.exports;}
const {unitPriceWithAddOns}=load('frontend/lib/addOns.ts');
const {menuTileTone}=load('frontend/lib/pos/posCategoryFilters.ts');
const expression=jsx=>new Function('context','with(context){return ('+transformSync('(<>'+jsx+'</>)',{loader:'tsx',jsx:'transform'}).code.trim().replace(/;$/,'')+');}');
const compiled=Object.fromEntries(fixture.edits.map(e=>[e.name,{before:expression(e.original),after:expression(e.replacement)}]));
function handlers(node,result=[]){if(!React.isValidElement(node))return result;if(Object.values(components).includes(node.type))return handlers(node.type(node.props),result);for(const event of ['onClick','onChange','onBlur','onKeyDown'])if(node.props[event]&&!node.props.disabled)result.push({event,callback:node.props[event]});React.Children.forEach(node.props.children,c=>handlers(c,result));return result;}
const actions=['dismissMobileKeyboard','addToCart','updateQuantity','editCartItemAddOns','blurInputOnEnter','setTableNumber','setTableNumberError','setOrderType','setCustomerName','setCustomerPhone','handleComplimentaryPhoneChange','resetComplimentaryOtp','setSplitPaymentMode','setPaymentMethod','setCheckoutError','setComplimentaryReason','setComplimentaryOtpCode','handleVerifyComplimentaryOtp','handleSendComplimentaryOtp','updateSplitPayment','removeSplitPaymentRow','addSplitPaymentRow','handleCheckout'];
const item={id:'coffee',name:'Coffee',price:100,baseUnitPrice:100,quantity:2,prepStation:'BARISTA',isActive:true,isAvailable:true,addOns:[{groupId:'milk',optionId:'almond',optionName:'Almond',quantity:2,totalPrice:30}]};
const classification={category:{code:'ESPRESSO_BAR',name:'Espresso Bar'},subcategory:{name:'Black'}};
function context(options,events){const c={React,...icons,motion,AnimatePresence,...components,unitPriceWithAddOns,menuTileTone,menuItems:[item],filteredMenuItems:[item],menuSections:[{id:'coffee',label:'Coffee',items:[item]}],classificationByItemId:new Map([['coffee',classification]]),classifyPosMenuItemWithCategories:()=>classification,posMenuCategories:[],cartQuantityByItemId:new Map([['coffee',2]]),searchQuery:'',selectedCategoryId:'ALL',prepStationLabel:()=> 'Barista',cart:[item],orderType:'DINE_IN',tableNumber:'2',tableNumberError:null,customerName:'Test Guest',customerPhone:'',QUICK_TABLE_CHIPS:['1','2','3','4'],isComplimentarySelected:false,isSplitPayment:false,isSetupTestSale:false,razorpayPaymentLocked:false,setupPaymentMethods:['CASH','UPI','CARD','RAZORPAY','SWIGGY','ZOMATO','CREDIT','COMPLIMENTARY'],SPLIT_PAYMENT_METHODS:['CASH','UPI','CARD','SWIGGY','ZOMATO','CREDIT'],paymentMethod:'CASH',splitPayments:[{id:'one',method:'CASH',amountStr:'200'}],splitAllocatedAmount:200,splitBalanceAmount:0,splitPaymentBalanced:true,displayedCartTotals:{subtotal:200,discountAmount:0,taxableAmount:200,taxTotal:10,grandTotal:210},complimentaryUiStatus:{className:'status',label:'Status'},complimentaryOtpStatus:'IDLE',complimentaryVerification:null,complimentaryMaskedPhone:'1234',complimentaryReason:'Test',complimentaryOtpCode:'',complimentaryResendSeconds:0,complimentaryOtpMessage:'',COMPLIMENTARY_RECAPTCHA_CONTAINER_ID:'test-recaptcha',isSaving:false,canSubmitComplimentary:true,...options};for(const name of actions)c[name]=(...args)=>events.push([name,...args.map(a=>a?.target?{value:a.target.value}:a)]);return c;}
let cases=0;const counts={};
function parity(name,options={}){const b=[],a=[];const before=compiled[name].before(context(options,b)),after=compiled[name].after(context(options,a));assert.equal(renderToStaticMarkup(after),renderToStaticMarkup(before),`${name} rendered HTML`);const bh=handlers(before),ah=handlers(after);assert.deepEqual(ah.map(x=>x.event),bh.map(x=>x.event));for(const h of bh)h.callback({target:{value:'12'},key:'Enter',preventDefault(){}});for(const h of ah)h.callback({target:{value:'12'},key:'Enter',preventDefault(){}});assert.deepEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)),`${name} all enabled callbacks`);cases++;counts[name]=(counts[name]||0)+1;}
for(const category of ['ALL','QUICK_PICKS','ESPRESSO_BAR'])for(const query of ['','coffee','  '])for(const quantity of [0,1,2])parity('MenuGrid',{selectedCategoryId:category,searchQuery:query,cartQuantityByItemId:new Map([['coffee',quantity]])});
parity('MenuGrid',{classificationByItemId:new Map()});parity('MenuGrid',{menuItems:[],filteredMenuItems:[],menuSections:[]});parity('MenuGrid',{filteredMenuItems:[],menuSections:[]});
// Manual unavailable items remain excluded by the authoritative filtered inputs, not component policy.
parity('MenuGrid',{menuItems:[{...item,isAvailable:false}],filteredMenuItems:[],menuSections:[]});
parity('MenuGrid',{menuSections:[{id:'none',items:[{...item,prepStation:'NONE'}]}]});
for(const orderType of ['DINE_IN','TAKEAWAY','DELIVERY'])for(const quantity of [1,2])for(const addOns of [[],item.addOns])for(const comp of [false,true])parity('CartPanel',{orderType,isComplimentarySelected:comp,cart:[{...item,quantity,addOns}]});
parity('CartPanel',{cart:[]});parity('CartPanel',{tableNumber:'',tableNumberError:'Table number is required for dine in orders.'});
for(const method of ['CASH','UPI','CARD','RAZORPAY','SWIGGY','ZOMATO','CREDIT'])for(const locked of [false,true])parity('PaymentPanel',{paymentMethod:method,razorpayPaymentLocked:locked});
for(const count of [1,2])for(const balance of [-10,0,10])parity('PaymentPanel',{isSplitPayment:true,splitPayments:Array.from({length:count},(_,i)=>({id:String(i),method:i?'UPI':'CASH',amountStr:'100'})),splitBalanceAmount:balance,splitPaymentBalanced:balance===0});
for(const status of ['IDLE','SENDING','CODE_SENT','VERIFYING','VERIFIED','ERROR','EXPIRED'])parity('PaymentPanel',{paymentMethod:'COMPLIMENTARY',isComplimentarySelected:true,complimentaryOtpStatus:status,complimentaryVerification:status==='VERIFIED'?{}:null,complimentaryOtpCode:'123456',complimentaryOtpMessage:'Test status'});
for(const options of [{cart:[]},{isSaving:true},{canSubmitComplimentary:false,isComplimentarySelected:true},{isSetupTestSale:true,setupPaymentMethods:['CASH']}])parity('PaymentPanel',options);
console.log(JSON.stringify({renderAndCallbackCases:cases,counts}));
console.log('PAYMENT_UI_PARITY=PASS\nSPLIT_PAYMENT_UI_PARITY=PASS\nPAYABLE_DISPLAY_PARITY=PASS\nMENU_GRID_PARITY=PASS\nSEARCH_FILTER_PARITY=PASS\nADD_TO_CART_PARITY=PASS\nMANUAL_UNAVAILABLE_DISPLAY_PARITY=PASS\nCART_QUANTITY_PARITY=PASS\nCART_REMOVE_PARITY=PASS\nADD_ON_DISPLAY_PARITY=PASS\nCUSTOMER_DETAILS_PARITY=PASS\nORDER_TYPE_PARITY=PASS\nTOTAL_DISPLAY_PARITY=PASS');
