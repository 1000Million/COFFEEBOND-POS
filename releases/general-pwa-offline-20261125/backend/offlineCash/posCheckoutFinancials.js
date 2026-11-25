'use strict';

// Counter checkout's existing unrounded arithmetic. Prices and tax rates come
// exclusively from server-canonical FINISHED_GOODS and add-on snapshots.
const FINANCIAL_VERSION = 3;
const METHODS = new Set(['CASH', 'UPI', 'CARD', 'SWIGGY', 'ZOMATO', 'CREDIT']);
const ROLE_LIMITS = { CASHIER: 10, STORE_MANAGER: 20, ADMIN: 100 };
const { createHash } = require('node:crypto');

function financialError(message) {
  throw Object.assign(new Error(message), { code: 'invalid-argument' });
}
function finite(value, label, minimum = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) financialError(`Invalid ${label}.`);
  return value;
}
function documentId(value, label = 'document reference') {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.includes('/') || value.length > 480 || value === '.' || value === '..') financialError(`Invalid ${label}.`);
  return value;
}
function sanitizeId(value, maximum = 220) {
  return (String(value || '').trim().replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'ID').slice(0, maximum);
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
function contentDigest(value) { return createHash('sha256').update(stableJson(value)).digest('hex'); }
function shortHash(value) {
  const text = stableJson(value); let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(36).toUpperCase().padStart(7, '0');
}
function paymentId(orderId, method, index) { return sanitizeId(`${orderId}_PAY_${String(index + 1).padStart(2, '0')}_${method}`); }

function authorizeFinancials({ canonicalItems, itemIds, orderId, role, discountPercent = 0, paymentMethod, splitPayments }) {
  documentId(orderId, 'order reference');
  if (!Object.hasOwn(ROLE_LIMITS, role)) financialError('Unsupported checkout role.');
  const complimentary = paymentMethod === 'COMPLIMENTARY';
  const percent = finite(discountPercent, 'discount percentage');
  if (percent > (complimentary ? 100 : ROLE_LIMITS[role])) financialError(`Discount exceeds the ${ROLE_LIMITS[role]}% limit for this role.`);
  if (!canonicalItems || typeof canonicalItems !== 'object' || Array.isArray(canonicalItems)) financialError('Canonical cart is required.');
  const keys = itemIds === undefined ? Object.keys(canonicalItems) : itemIds;
  if (!Array.isArray(keys) || new Set(keys).size !== keys.length || keys.length !== Object.keys(canonicalItems).length || keys.some(key => !Object.hasOwn(canonicalItems, key))) financialError('Canonical item membership mismatch.');
  const entries = keys.map(key => [key, canonicalItems[key]]);
  if (!entries.length || entries.length > 30) financialError('Please submit between 1 and 30 cart items.');
  for (const [lineId, line] of entries) {
    documentId(lineId, 'order item reference');
    if (!line || line.orderItemId !== lineId) financialError('Canonical item identity mismatch.');
    finite(line.baseUnitPrice, 'canonical base price'); finite(line.addOnTotal, 'canonical add-on total'); finite(line.taxRate, 'canonical tax rate');
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 20) financialError('Invalid canonical quantity.');
    if (!Array.isArray(line.addOns) || line.addOns.length > 40) financialError('Invalid canonical add-ons.');
    line.addOns.forEach(addOn => { finite(addOn.totalPrice, 'canonical add-on price'); finite(addOn.taxRate, 'canonical add-on tax'); });
    if (line.addOns.reduce((sum, addOn) => sum + addOn.totalPrice, 0) !== line.addOnTotal) financialError('Canonical add-on sum mismatch.');
  }
  const items = entries.map(([, line]) => line);
  const rawSubtotal = items.reduce((sum, line) => sum + (line.baseUnitPrice + line.addOnTotal) * line.quantity, 0);
  // buildComplimentaryTotals historically rounds the order menu value only.
  // Its per-line complimentary values remain the raw line values below.
  const subtotal = complimentary ? Math.max(0, Math.round(rawSubtotal * 100) / 100) : rawSubtotal;
  const discountAmount = complimentary ? subtotal : subtotal * (percent / 100);
  const ratio = subtotal > 0 ? discountAmount / subtotal : 0;
  const addOnTax = line => line.addOns.reduce((sum, addOn) => sum + Math.max(0, addOn.totalPrice * line.quantity * (1 - ratio)) * Math.max(0, addOn.taxRate) / 100, 0);
  const taxTotal = complimentary ? 0 : items.reduce((sum, line) => {
    const baseSubtotal = line.baseUnitPrice * line.quantity;
    return sum + Math.max(0, baseSubtotal - baseSubtotal * ratio) * (line.taxRate / 100) + addOnTax(line);
  }, 0);
  const taxableAmount = Math.max(0, subtotal - discountAmount);
  const grandTotal = taxableAmount + taxTotal;
  const lines = Object.fromEntries(entries.map(([lineId, line]) => {
    const lineSubtotal = (line.baseUnitPrice + line.addOnTotal) * line.quantity;
    const lineDiscount = complimentary ? lineSubtotal : lineSubtotal * ratio;
    const lineTaxable = Math.max(0, lineSubtotal - lineDiscount);
    // Preserve the caller's per-line multiplication order as well as the
    // aggregate calculation above; do not introduce a new rounding policy.
    const lineTax = complimentary ? 0 : Math.max(0, line.baseUnitPrice * line.quantity * (1 - ratio)) * (line.taxRate / 100) + addOnTax(line);
    return [lineId, { lineSubtotal, lineDiscount, lineTaxable, lineTax, lineTotal: lineTaxable + lineTax }];
  }));
  [subtotal, discountAmount, taxableAmount, taxTotal, grandTotal, ...Object.values(lines).flatMap(Object.values)].forEach(value => finite(value, 'calculated amount'));
  const split = paymentMethod === 'SPLIT';
  let rows = [];
  if (!complimentary) {
    if (split) {
      if (!Array.isArray(splitPayments) || !splitPayments.length || splitPayments.length > 30) financialError('Split payment needs 1–30 tender rows.');
      const submitted = splitPayments.map(row => {
        if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['method', 'amount'].includes(key)) || !METHODS.has(row.method)) financialError('Unsupported counter payment row.');
        return { method: row.method, amount: finite(row.amount, 'split payment amount') };
      });
      rows = submitted.filter(row => row.amount > 0 || grandTotal === 0);
      if (!rows.length || Math.abs(rows.reduce((sum, row) => sum + row.amount, 0) - grandTotal) > 0.01) financialError('Split payment must equal the canonical total.');
    } else {
      if (!METHODS.has(paymentMethod)) financialError('Unsupported counter payment method.');
      if (splitPayments !== undefined && (!Array.isArray(splitPayments) || splitPayments.length)) financialError('Unexpected split payment rows.');
      rows = [{ method: paymentMethod, amount: paymentMethod === 'CREDIT' ? 0 : grandTotal }];
    }
  } else if (splitPayments !== undefined && (!Array.isArray(splitPayments) || splitPayments.length)) financialError('Complimentary checkout cannot include payments.');
  const credit = rows.filter(row => row.method === 'CREDIT').reduce((sum, row) => sum + row.amount, 0);
  const paymentStatus = complimentary ? 'NOT_REQUIRED' : split ? (credit <= 0.01 ? 'PAID' : credit >= grandTotal - 0.01 ? 'UNPAID' : 'PARTIAL') : paymentMethod === 'CREDIT' && grandTotal > 0 ? 'UNPAID' : 'PAID';
  const paymentEntries = rows.map((row, index) => [paymentId(orderId, row.method, index), { ...row, paymentIndex: index }]);
  if (new Set(paymentEntries.map(([id]) => id)).size !== paymentEntries.length) financialError('Derived payment identity collision.');
  const payments = Object.fromEntries(paymentEntries);
  return { version: FINANCIAL_VERSION, subtotal, discountPercent: complimentary ? (subtotal > 0 ? 100 : 0) : percent, discountAmount, taxableAmount, taxTotal, gstTotal: taxTotal, grandTotal, itemIds: entries.map(([lineId]) => lineId), lines, payments, paymentIds: Object.keys(payments), paymentStatus, paymentMethod: rows[0]?.method || paymentMethod, isSplitPayment: split, commercialStatus: complimentary ? 'COMPLIMENTARY' : 'SALE' };
}

module.exports = { FINANCIAL_VERSION, METHODS, ROLE_LIMITS, authorizeFinancials, contentDigest, documentId, financialError, paymentId, sanitizeId, shortHash, stableJson };
