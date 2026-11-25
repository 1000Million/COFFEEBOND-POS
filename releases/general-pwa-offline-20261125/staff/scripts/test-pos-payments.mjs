import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import * as esbuild from 'esbuild';
const root = new URL('../', import.meta.url).pathname;
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/pos-payments.baseline.json', import.meta.url)));
function load(file) {
  const code = esbuild.buildSync({ entryPoints: [root + file], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
  const context = { module: { exports: {} }, exports: {} };
  vm.runInNewContext(code, context);
  return context.module.exports;
}
const beforeMode = process.argv.includes('--before');
if (beforeMode) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(root + 'frontend/pages/pos/POSHome.tsx')).digest('hex'), fixture.sourceSha256);
const source = 'const PAYMENT_TOLERANCE = 0.01;\n' + Object.values(fixture.declarations).join('\n')
  + '\nfunction checkout(splitPayments, trueGrandTotal, isSplitPayment, selectedPaymentMethod, isComplimentaryCheckout) {\n'
  + fixture.normalizedClosure + '\n' + fixture.checkout + '\nreturn {paymentRows, allocatedPaymentAmount};\n}'
  + '\nmodule.exports = {' + Object.keys(fixture.declarations).join(',') + ', checkout};';
const context = { ...load('frontend/lib/pos/posTax.ts'), module: { exports: {} }, exports: {} };
vm.runInNewContext(esbuild.transformSync(source, {loader:'ts', format:'cjs'}).code, context);
const before = context.module.exports;
const helpers = beforeMode ? before : load('frontend/lib/pos/posPayments.ts');
let checkout = before.checkout;
if (!beforeMode) {
  const current = fs.readFileSync(root + 'frontend/pages/pos/POSHome.tsx', 'utf8');
  const body = current.slice(current.indexOf('      const paymentRows: ReceiptPaymentSnapshot[] = isComplimentaryCheckout'), current.indexOf('      const requestPayloadHash = checkoutPayloadHash'));
  const checkoutContext = { ...helpers, module: { exports: {} } };
  vm.runInNewContext(esbuild.transformSync('function checkout(splitPayments, trueGrandTotal, isSplitPayment, selectedPaymentMethod, isComplimentaryCheckout) {\n' + body + '\nreturn {paymentRows, allocatedPaymentAmount};\n}\nmodule.exports = checkout;', {loader:'ts', format:'cjs'}).code, checkoutContext);
  checkout = checkoutContext.module.exports;
}
const clone = value => JSON.parse(JSON.stringify(value));
const outcome = fn => { try { return clone(fn()); } catch (e) { return {error:e.message}; } };
let cases = 0;
function parity(name, args, expected) {
  const actual = outcome(() => name === 'checkout' ? checkout(...args) : helpers[name](...args));
  assert.deepEqual(actual, outcome(() => before[name](...args)), name + ' baseline parity');
  if (expected !== undefined) assert.deepEqual(actual, expected, name + ' expected');
  cases++;
  return actual;
}
const row = (amountStr, method='CASH') => ({id:method, method, amountStr});
for (const method of ['CASH','UPI','CARD','CREDIT','COMPLIMENTARY']) {
  parity('checkout', [[],63,false,method,false], {paymentRows:[{method,amount:method==='CREDIT'?0:63}],allocatedPaymentAmount:63});
  parity('buildPaymentLabel', [[{method,amount:63}]], method);
}
parity('checkout', [[],0,false,'COMPLIMENTARY',true], {paymentRows:[],allocatedPaymentAmount:0});
parity('checkout', [[row('20'),row('43','UPI')],63,true,'CASH',false], {paymentRows:[{method:'CASH',amount:20},{method:'UPI',amount:43}],allocatedPaymentAmount:63});
for (const amount of ['62','64']) assert.match(parity('checkout', [[row(amount)],63,true,'CASH',false]).error, /Split payment must equal the total due/);
for (const value of ['', 'bad', '0', '-1', 'Infinity']) {
  parity('normalizePaymentAmount',[value],0);
  assert.match(parity('checkout',[[row(value)],63,true,'CASH',false]).error,/at least one payment row/);
}
parity('checkout',[[row('0')],0,true,'CASH',false],{paymentRows:[{method:'CASH',amount:0}],allocatedPaymentAmount:0});
parity('checkout',[[row('bad'),row('63','UPI')],63,true,'CASH',false]);
parity('normalizePaymentAmount',['1,234.005'],1234.005);
parity('buildPaymentLabel',[[]],'UNKNOWN');
parity('buildPaymentLabel',[[{method:'CASH',amount:20},{method:'UPI',amount:43}]],'CASH ₹20.00 + UPI ₹43.00');
for (const [credit, expected] of [[0,'PAID'],[20,'PARTIAL'],[63,'UNPAID']]) parity('splitPaymentStatus',[[{method:'CREDIT',amount:credit}],63],expected);
for (const due of [0,0.01,0.10500000000000001,1.005,63,231.48]) {
  for (const delta of [-1,-0.010001,-0.01,-0.009,0,0.009,0.01,0.010001,1]) {
    parity('paymentRowsAreBalanced',[due,due+delta]);
    parity('checkout',[[row(String(due+delta))],due,true,'CASH',false]);
  }
}
for (let i=1;i<=100;i++) {
  const rows=[row(String(i/17)),row(String(i/31),'UPI')];
  const total=parity('paymentRowsAllocated',[rows]);
  parity('checkout',[rows,total,true,'CASH',false]);
  if (!beforeMode) assert.equal(helpers.paymentBalance(231.48,total),231.48-total);
}
console.log(`POS payments ${beforeMode?'BEFORE':'AFTER'}: PASS; ${cases} baseline parity cases.`);
