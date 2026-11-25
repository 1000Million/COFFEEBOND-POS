import assert from 'node:assert/strict';
import { restoreBundle9 } from './test-pos-ui-bundle9.mjs';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);
const read = p => fs.readFileSync(new URL(p, root), 'utf8');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const seal = JSON.parse(read('scripts/fixtures/bundle8/seal.json'));
const held = read('scripts/fixtures/bundle8/held.jsx.txt');
const receipt = read('scripts/fixtures/bundle8/receipt.jsx.txt');
assert.equal(sha(held), seal.heldSha256); assert.equal(sha(receipt), seal.receiptSha256);
const page = restoreBundle9(read('frontend/pages/pos/POSHome.tsx'));
export const restorePage = source => source.replace("import ReceiptModal from '../../components/pos/ReceiptModal';\n", '').replace("import HeldBillsPanel from '../../components/pos/HeldBillsPanel';\n", '')
 .replace('                        <HeldBillsPanel heldBills={heldBills} recallHeldBill={recallHeldBill} deleteHeldBill={deleteHeldBill} />', held)
 .replace(/        <ReceiptModal\n[\s\S]*?        \/>/, receipt);
assert.equal(sha(restorePage(page)), seal.sourceSha256, 'All other UI, handlers and production write paths must remain byte-identical to sealed POSHome');
// Ensure wrapper wiring cannot change silently while reconstruction still matches.
assert(page.includes('receiptView={receiptView}') && page.includes('receiptViewTitle={receiptViewTitle}') && page.includes('receiptGst={receiptGst}') && page.includes('printReceiptElement={printReceiptElement}') && page.includes('onClose={() => setReceiptView(null)}'));
assert(page.includes('showGstin={Boolean(receiptView.order.receiptLegalDetails?.gstRegistered && receiptView.order.receiptLegalDetails.gstin)}'));
assert(page.includes('showState={Boolean(receiptView.order.receiptLegalDetails?.gstRegistered && receiptView.order.receiptLegalDetails.stateName)}'));
function compile(source) {
 const code = transformSync(source, { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code;
 const module = { exports: {} }; vm.runInNewContext(code, { module, exports: module.exports, require }); return module.exports.default;
}
const Held = compile(read('frontend/components/pos/HeldBillsPanel.tsx'));
const Receipt = compile(read('frontend/components/pos/ReceiptModal.tsx'));
const original = (jsx, names) => compile(`import React from 'react'; import { CheckCircle, Printer } from 'lucide-react'; export default function Original({${names}}) { return (${jsx}); }`);
const HeldBefore = original(held, 'heldBills,recallHeldBill,deleteHeldBill');
const ReceiptBefore = original(receipt, 'receiptView,receiptViewTitle,receiptGst,printReceiptElement,setReceiptView');
const html = (component, props) => renderToStaticMarkup(React.createElement(component, props));
function buttons(element, out = []) {
 if (!React.isValidElement(element)) return out;
 if (element.type === 'button') out.push(element.props);
 React.Children.forEach(element.props.children, child => buttons(child, out)); return out;
}
let cases = 0;
for (const bills of [[], [{ id: 'one', customerName: '', heldAtIso: '2026-09-20T10:00:00Z', itemCount: 2, total: 120 }], [{ id: 'one', customerName: 'Guest', heldAtIso: '2026-09-20T10:00:00Z', itemCount: 2, total: 120 }, { id: 'two', customerName: '', heldAtIso: '2026-09-20T11:00:00Z', itemCount: 1, total: 40 }]]) {
 const events = []; const props = { heldBills: bills, recallHeldBill: bill => events.push(['recall', bill]), deleteHeldBill: bill => events.push(['delete', bill]) };
 assert.equal(html(Held, props), html(HeldBefore, props));
 for (const button of buttons(Held(props))) button.onClick();
 assert.deepEqual(events, bills.flatMap(bill => [['recall', bill], ['delete', bill]])); cases++;
}
for (const legal of [undefined, {}, { gstRegistered: false, gstin: 'GST-TEST', stateName: 'Test State' }, { gstRegistered: true }, { gstRegistered: true, gstin: 'GST-TEST', stateName: 'Test State', stateCode: '09', tradeName: 'Test Cafe', legalAddress: 'Test Address' }]) {
 for (const mode of ['CASH', 'UPI', 'SPLIT', 'COMPLIMENTARY']) for (const gst of [null, { cgst: 2.5, sgst: 2.5 }]) {
 const order = { orderNumber: 'TEST-1', storeName: 'Test Store', createdAtIso: '2026-09-20T10:00:00Z', createdByName: 'Test Staff', customerName: 'Guest', customerPhone: '', orderType: 'DINE_IN', tableNumber: '2', subtotal: 100, discountPercent: 10, discountAmount: 10, taxableAmount: 90, gstTotal: 5, grandTotal: 95, paymentMethod: mode === 'SPLIT' ? 'CASH' : mode, isSplitPayment: mode === 'SPLIT', commercialStatus: mode === 'COMPLIMENTARY' ? 'COMPLIMENTARY' : undefined, receiptLegalDetails: legal };
 const events = [];
 const props = { receiptView: { order, items: [{ itemName: 'Coffee', quantity: 2, unitPrice: 50, lineTotal: 100, addOns: [{ groupId: 'milk', optionId: 'almond', optionName: 'Almond milk', quantity: 2, totalPrice: 10 }] }], payments: [{ method: 'CASH', amount: 45 }, { method: 'UPI', amount: 50 }] }, receiptViewTitle: 'Order Saved', receiptGst: gst, showGstin: Boolean(legal?.gstRegistered && legal.gstin), showState: Boolean(legal?.gstRegistered && legal.stateName), printReceiptElement: () => events.push('print'), onClose: () => events.push('close'), setReceiptView: value => { assert.equal(value, null); events.push('close'); } };
 assert.equal(html(Receipt, props), html(ReceiptBefore, props));
 for (const button of buttons(Receipt(props))) button.onClick(); assert.deepEqual(events, ['print', 'close']); cases++;
 }
}
for (const name of ['HeldBillsPanel', 'ReceiptModal']) {
 const source = read(`frontend/components/pos/${name}.tsx`);
 assert(!/firebase\/|\b(getDoc|getDocs|setDoc|updateDoc|runTransaction|httpsCallable|onSnapshot)\s*\(/.test(source));
 assert(!/\bany\b/.test(source));
}
console.log(`RENDER_CALLBACK_CASES=${cases}`);
console.log('UNCHANGED_MENU_CART_PAYMENT_UI=PASS (sealed-source identity)');
console.log('HELD_BILL_UI_AND_CALLBACKS=PASS');
console.log('RECEIPT_CONTENT_GST_PRINT_CLOSE=PASS');
console.log('WRITE_PATH_COUNTS_UNCHANGED=YES (all original write code byte-identical; new components have no writes)');
console.log('TARGETED_TESTS=PASS');
