export const REPORT_TIME_ZONE = 'Asia/Kolkata';
export const SUMMARY_MAX_DAYS = 366;
export const DETAIL_MAX_DAYS = 31;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
export const MAX_EXPORT_ROWS = 5000;

const INTERNAL_REPORT_ROLES = ['ADMIN', 'STORE_MANAGER', 'CASHIER'];
const MANAGER_REPORT_ROLES = ['ADMIN', 'STORE_MANAGER'];
const PAYMENT_METHODS = ['CASH', 'UPI', 'CARD', 'SWIGGY', 'ZOMATO', 'CREDIT', 'PAY_AT_COUNTER', 'RAZORPAY'];

const report = (
  reportId,
  title,
  description,
  group,
  options = {},
) => ({
  reportId,
  title,
  description,
  group,
  allowedRoles: options.allowedRoles || MANAGER_REPORT_ROLES,
  supportsStoreComparison: options.supportsStoreComparison === true,
  supportsExport: options.supportsExport !== false,
  supportsPrint: options.supportsPrint !== false,
  requiredFields: options.requiredFields || [],
  availabilityStatus: options.availabilityStatus || 'AVAILABLE',
  unavailableReason: options.unavailableReason || null,
  detailReport: options.detailReport === true,
});

export const REPORT_REGISTRY = [
  report('all-restaurant-sales', 'All Restaurant Sales Report', 'Commercial sales, collections, complimentary activity, voids, and store comparison.', 'Sales', {
    allowedRoles: INTERNAL_REPORT_ROLES,
    supportsStoreComparison: true,
  }),
  report('all-restaurant-day-wise', 'All Restaurant Report: Day Wise', 'One reconciled sales row per business date and store.', 'Sales', {
    supportsStoreComparison: true,
  }),
  report('outlet-comparison', 'Outlet Comparison Report', 'Compare sales, order values, discounts, exceptions, channels, and payments by store.', 'Sales', {
    supportsStoreComparison: true,
  }),
  report('all-restaurant-hourly', 'All Restaurants Sales: Hourly', 'Hourly sales and order counts in the configured India business timezone.', 'Sales', {
    supportsStoreComparison: true,
  }),
  report('item-wise-all-restaurants', 'Item Wise Report: All Restaurants', 'Item quantities and allocated sales values across accessible stores.', 'Items & Categories'),
  report('outlet-item-wise', 'Outlet-Item Wise Report', 'Item performance split by outlet.', 'Items & Categories'),
  report('item-wise-matrix', 'Item Wise Matrix Report', 'Items in rows with outlet quantity and net-sales columns.', 'Items & Categories', {
    supportsStoreComparison: true,
  }),
  report('category-wise', 'Category Wise Report', 'Category quantity, sales, GST, and contribution by outlet.', 'Items & Categories'),
  report('tag-wise', 'Tag Wise Report', 'Quantity and sales by existing product tags.', 'Items & Categories', {
    requiredFields: ['order items.tags'],
    availabilityStatus: 'CONDITIONAL',
  }),
  report('addon-sales', 'Add-on Sales Report', 'Add-on group, option, parent item, quantity, taxes, and sales.', 'Items & Categories'),
  report('orders-master', 'Orders Master Report', 'Sanitized bill-level operational and financial audit.', 'Orders & Invoices', {
    detailReport: true,
  }),
  report('invoice-all-restaurants', 'Invoice Report: All Restaurants', 'Completed invoice totals with configured legal GST details.', 'Orders & Invoices', {
    detailReport: true,
  }),
  report('order-item-wise', 'Order Report: Item Wise', 'Detailed order-item, add-on, tax, KOT, and void status rows.', 'Orders & Invoices', {
    detailReport: true,
  }),
  report('item-invoice-details', 'Item Report: Invoice Details', 'Invoice item and add-on lines that reconcile to the parent invoice.', 'Orders & Invoices', {
    detailReport: true,
  }),
  report('order-sub-order-wise', 'Order Report: Sub-Order Wise', 'Sales grouped by dine-in, takeaway, delivery, web, and aggregator channels.', 'Orders & Invoices'),
  report('payment-collection', 'Payment Collection Report', 'Gross tender receipts, reversals, pending refunds, and net collections.', 'Payments', {
    allowedRoles: INTERNAL_REPORT_ROLES,
  }),
  report('day-sales-biller-wise', 'Day Sales Report: Biller Wise', 'Bills, sales, payments, discounts, complimentary, and void activity by staff display name.', 'Payments', {
    allowedRoles: INTERNAL_REPORT_ROLES,
  }),
  report('split-payment-detail', 'Split Payment Detail Report', 'Tender-by-tender reconciliation for split payments.', 'Payments', {
    detailReport: true,
  }),
  report('discount-report', 'Discount Report', 'Discount allocations, reasons where captured, and responsible staff role.', 'Discounts & Exceptions', {
    detailReport: true,
  }),
  report('discounted-orders-with-reason', 'Discounted Orders: With Reason', 'Discounted bills with missing reasons highlighted.', 'Discounts & Exceptions', {
    detailReport: true,
  }),
  report('complimentary-orders', 'Complimentary Orders Report', 'OTP-authorized complimentary menu value and COGS without OTP secrets.', 'Discounts & Exceptions', {
    detailReport: true,
  }),
  report('cancel-void-orders', 'Cancel/Void Order Report', 'Voided order value, payment outcome, inventory reversal, reason, and staff.', 'Discounts & Exceptions', {
    detailReport: true,
  }),
  report('cancel-void-item-wise', 'Cancel/Void Order Report: Item Wise', 'Voided item quantities, add-ons, reversal references, and reason.', 'Discounts & Exceptions', {
    detailReport: true,
  }),
  report('refund-reversal', 'Refund and Reversal Report', 'Original tenders, reversal status, pending refunds, and net amount.', 'Discounts & Exceptions', {
    detailReport: true,
  }),
  report('online-order', 'Online Order Report', 'Accepted, rejected, and converted customer-web activity.', 'Online & Customers', {
    detailReport: true,
  }),
  report('customer-order', 'Customer Order Report', 'Sanitized customer-web orders with masked phone and no tracking secrets.', 'Online & Customers', {
    detailReport: true,
  }),
  report('locality-wise', 'Locality Wise Report', 'Customer-order sales by a captured structured locality field.', 'Online & Customers', {
    requiredFields: ['locality'],
    availabilityStatus: 'CONDITIONAL',
  }),
  report('corporate-customer-gst', 'Corporate Customer GST Report', 'Corporate invoices when company name and customer GSTIN are captured.', 'Online & Customers', {
    requiredFields: ['companyName', 'customerGstin'],
    availabilityStatus: 'CONDITIONAL',
    detailReport: true,
  }),
  report('advance-order-summary', 'Advance Order Summary', 'Future scheduled orders when a genuine scheduling field is captured.', 'Online & Customers', {
    requiredFields: ['scheduledAt'],
    availabilityStatus: 'CONDITIONAL',
    detailReport: true,
  }),
];

export function money(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function precise(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function dateFromValue(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function dateKey(value, timeZone = REPORT_TIME_ZONE) {
  const date = dateFromValue(value);
  if (!date) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function hourKey(value, timeZone = REPORT_TIME_ZONE) {
  const date = dateFromValue(value);
  if (!date) return null;
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(date));
}

export function assignedStoreIds(profile) {
  const source = Array.isArray(profile?.assignedStoreIds) && profile.assignedStoreIds.length > 0
    ? profile.assignedStoreIds
    : Array.isArray(profile?.storeIds)
      ? profile.storeIds
      : [];
  return [...new Set(source.filter((value) => typeof value === 'string' && value.trim()))];
}

export function maskIndianMobile(value) {
  const digits = String(value || '').replace(/\D/g, '');
  const national = digits.length >= 10 ? digits.slice(-10) : digits;
  return national.length === 10 ? `${national.slice(0, 2)}******${national.slice(-2)}` : null;
}

export function isComplimentaryOrder(order) {
  if (order?.commercialStatus === 'COMPLIMENTARY') return true;
  if (order?.paymentMethod === 'COMPLIMENTARY') return true;
  return Array.isArray(order?.paymentBreakdown)
    && order.paymentBreakdown.some((payment) => payment?.method === 'COMPLIMENTARY');
}

export function effectiveOrderStatus(order) {
  if (order?.status === 'VOIDED') return 'VOIDED';
  if (order?.status === 'CANCELLED') return 'CANCELLED';
  return 'COMPLETED';
}

export function orderDiscount(order) {
  if (Number.isFinite(Number(order?.discountAmount))) {
    return money(Math.max(0, Number(order.discountAmount)));
  }
  if (Number.isFinite(Number(order?.discountTotal))) {
    return money(Math.max(0, Number(order.discountTotal)));
  }
  return money(Math.max(0, Number(order?.discount) || 0));
}

export function orderTax(order) {
  const gst = money(order?.gstTotal);
  return gst > 0 ? gst : money(order?.taxTotal);
}

export function orderTaxable(order) {
  if (isComplimentaryOrder(order)) return 0;
  if (Number.isFinite(Number(order?.taxableAmount))) return money(order.taxableAmount);
  return money(money(order?.subtotal) - orderDiscount(order));
}

function orderMenuValue(order) {
  if (isComplimentaryOrder(order)) return money(order?.menuValue || order?.subtotal);
  return money(order?.subtotal);
}

function sourceLabel(order) {
  if (order?.source === 'CUSTOMER_WEB' || order?.onlineOrderId || order?.onlineOrderReference) return 'CUSTOMER_WEB';
  return String(order?.source || 'POS').toUpperCase();
}

function orderTypeLabel(order) {
  if (sourceLabel(order) === 'CUSTOMER_WEB' && order?.paymentMethod === 'PAY_AT_COUNTER') return 'PAY_AT_COUNTER';
  return String(order?.orderType || 'TAKEAWAY').toUpperCase();
}

function reversalRows(order) {
  if (isComplimentaryOrder(order)) return [];
  const reversalMethod = (method) => (
    order?.paymentProvider === 'RAZORPAY' || String(method || '').toUpperCase() === 'RAZORPAY'
      ? 'RAZORPAY'
      : String(method || 'UNKNOWN').toUpperCase()
  );
  if (Array.isArray(order?.paymentReversalBreakdown) && order.paymentReversalBreakdown.length > 0) {
    return order.paymentReversalBreakdown.map((row) => ({
      method: reversalMethod(row?.method),
      originalAmount: money(row?.originalAmount),
      reversalAmount: money(row?.amount),
      status: String(row?.reversalStatus || order?.paymentReversalStatus || 'REFUND_PENDING'),
      reason: String(row?.reason || ''),
    }));
  }
  if (effectiveOrderStatus(order) !== 'VOIDED') return [];
  const amount = money(order?.paymentReversalTotal);
  return amount > 0 ? [{
    method: reversalMethod(order?.paymentMethod),
    originalAmount: money(order?.grandTotal),
    reversalAmount: amount,
    status: String(order?.paymentReversalStatus || 'REFUND_PENDING'),
    reason: String(order?.voidReason || ''),
  }] : [];
}

export function normalizedPaymentRows(order, paymentDocuments = []) {
  if (isComplimentaryOrder(order) || order?.paymentStatus !== 'PAID') return [];
  const source = Array.isArray(paymentDocuments) && paymentDocuments.length > 0
    ? paymentDocuments
    : Array.isArray(order?.paymentBreakdown) && order.paymentBreakdown.length > 0
      ? order.paymentBreakdown
      : [{ method: order?.paymentMethod, amount: order?.grandTotal }];
  return source
    .map((payment) => ({
      method: payment?.provider === 'RAZORPAY' || order?.paymentProvider === 'RAZORPAY'
        ? 'RAZORPAY'
        : String(payment?.method || 'UNKNOWN').toUpperCase(),
      amount: money(payment?.amount),
      reference: payment?.reference ? String(payment.reference).slice(0, 80) : null,
      provider: payment?.provider === 'RAZORPAY' || order?.paymentProvider === 'RAZORPAY' ? 'RAZORPAY' : null,
      providerMethod: payment?.provider === 'RAZORPAY' || order?.paymentProvider === 'RAZORPAY'
        ? String(payment?.providerMethod || order?.providerMethod || 'OTHER').toUpperCase()
        : null,
    }))
    .filter((payment) => (
      payment.amount > 0
      && payment.method !== 'COMPLIMENTARY'
      && payment.method !== 'PAY_AT_COUNTER'
    ));
}

function paymentOutcome(order) {
  if (isComplimentaryOrder(order)) {
    return effectiveOrderStatus(order) === 'VOIDED' ? 'VOIDED / NO PAYMENT' : 'NOT_REQUIRED';
  }
  if (effectiveOrderStatus(order) !== 'VOIDED') return String(order?.paymentStatus || 'UNPAID');
  const status = String(order?.paymentReversalStatus || '');
  if (status === 'REFUNDED') return 'VOIDED / CASH REFUNDED';
  if (status === 'REVERSED') return 'VOIDED / PAYMENT REVERSED';
  if (status === 'REFUND_PENDING') return 'VOIDED / REFUND PENDING';
  if (status === 'MANUAL_REFUND_REQUIRED') return 'VOIDED / MANUAL REFUND REQUIRED';
  return 'VOIDED / PAYMENT REVIEW';
}

function itemGross(item) {
  const explicit = money(item?.lineSubtotal);
  if (explicit > 0) return explicit;
  const unit = precise(item?.unitPriceWithAddOns || item?.unitPrice);
  return money(unit * Math.max(0, precise(item?.quantity)));
}

function normalizeAddOns(item) {
  return (Array.isArray(item?.addOns) ? item.addOns : []).map((addOn) => ({
    groupId: String(addOn?.groupId || ''),
    groupName: String(addOn?.groupName || 'Add-ons'),
    optionId: String(addOn?.optionId || ''),
    optionName: String(addOn?.optionName || 'Add-on'),
    quantity: Math.max(0, precise(addOn?.quantity)),
    unitPrice: money(addOn?.unitPrice),
    totalPrice: money(addOn?.totalPrice),
    taxRate: Math.max(0, precise(addOn?.taxRate)),
    inventoryTrackingStatus: String(addOn?.inventoryTrackingStatus || 'NOT_CONFIGURED'),
  })).filter((addOn) => addOn.quantity > 0);
}

function normalizedItem(item, order, grossOrderItems) {
  const quantity = Math.max(0, precise(item?.quantity));
  const gross = itemGross(item);
  const discount = Number.isFinite(Number(item?.lineDiscount))
    ? money(item.lineDiscount)
    : grossOrderItems > 0
      ? money(orderDiscount(order) * gross / grossOrderItems)
      : 0;
  const taxable = isComplimentaryOrder(order)
    ? 0
    : Number.isFinite(Number(item?.lineTaxable))
      ? money(item.lineTaxable)
      : money(Math.max(0, gross - discount));
  const tax = isComplimentaryOrder(order) ? 0 : money(item?.lineTax);
  const total = isComplimentaryOrder(order)
    ? 0
    : Number.isFinite(Number(item?.lineTotal))
      ? money(item.lineTotal)
      : money(taxable + tax);
  return {
    itemId: String(item?.id || ''),
    itemCode: String(item?.itemCode || item?.finishedGoodCode || item?.menuItemId || 'UNKNOWN'),
    itemName: String(item?.itemName || 'Item'),
    categoryId: String(item?.categoryId || ''),
    categoryName: String(item?.categoryName || 'Other'),
    quantity,
    baseUnitPrice: money(item?.baseUnitPrice ?? item?.unitPrice),
    unitPrice: money(item?.unitPriceWithAddOns ?? item?.unitPrice),
    gross,
    discount,
    taxable,
    tax,
    total,
    taxRate: Math.max(0, precise(item?.taxRate)),
    cogs: money(item?.cogsAmount),
    prepStation: String(item?.prepStation || 'NONE'),
    status: effectiveOrderStatus(order) === 'VOIDED' ? 'VOIDED / CANCELLED' : String(item?.status || 'PENDING'),
    addOns: normalizeAddOns(item),
    tags: Array.isArray(item?.tags) ? item.tags.filter((tag) => typeof tag === 'string' && tag.trim()) : [],
  };
}

export function normalizeOrderRecord(record) {
  const order = record?.order || {};
  const rawItems = Array.isArray(record?.items) ? record.items : [];
  const grossOrderItems = rawItems.reduce((sum, item) => sum + itemGross(item), 0);
  const items = rawItems.map((item) => normalizedItem(item, order, grossOrderItems));
  const payments = normalizedPaymentRows(order, record?.payments);
  const reversals = reversalRows(order);
  const status = effectiveOrderStatus(order);
  const complimentary = isComplimentaryOrder(order);
  const commercial = status === 'VOIDED'
    ? 'VOIDED'
    : complimentary
      ? 'COMPLIMENTARY'
      : order?.paymentStatus === 'PAID'
        ? 'PAID'
        : 'UNPAID';
  return {
    orderId: String(order?.id || ''),
    orderNumber: String(order?.orderNumber || 'Unknown order'),
    storeId: String(order?.storeId || ''),
    storeCode: String(order?.storeCode || order?.storeId || ''),
    storeName: String(order?.storeName || order?.storeId || ''),
    createdAt: dateFromValue(order?.createdAt)?.toISOString() || null,
    source: sourceLabel(order),
    orderType: orderTypeLabel(order),
    tableNumber: order?.tableNumber ? String(order.tableNumber).slice(0, 30) : null,
    staffName: String(order?.createdByName || order?.staffName || 'Unknown staff').slice(0, 100),
    staffRole: String(order?.createdByRole || order?.staffRole || ''),
    customerName: order?.customerName ? String(order.customerName).slice(0, 100) : null,
    customerPhoneMasked: maskIndianMobile(order?.customerPhone),
    customerNotes: order?.customerNotes || order?.notes ? String(order.customerNotes || order.notes).slice(0, 300) : null,
    locality: order?.locality ? String(order.locality).slice(0, 120) : null,
    companyName: order?.companyName ? String(order.companyName).slice(0, 120) : null,
    customerGstin: order?.customerGstin ? String(order.customerGstin).slice(0, 30) : null,
    scheduledAt: dateFromValue(order?.scheduledAt)?.toISOString() || null,
    status,
    commercial,
    paymentStatus: paymentOutcome(order),
      paymentMethods: [...new Set(payments.map((payment) => payment.method))],
    payments,
    reversals,
    menuValue: orderMenuValue(order),
    discount: complimentary ? orderMenuValue(order) : orderDiscount(order),
    taxable: orderTaxable(order),
    gst: complimentary ? 0 : orderTax(order),
    netSales: status === 'COMPLETED' && !complimentary ? money(order?.grandTotal) : 0,
    total: complimentary ? 0 : money(order?.grandTotal),
    cogs: money(order?.cogsTotal),
    complimentaryReason: complimentary ? String(order?.complimentaryReason || '').slice(0, 240) : null,
    complimentaryOtpProvider: complimentary ? String(order?.complimentaryOtpProvider || '') : null,
    complimentaryVerified: complimentary ? order?.complimentaryOtpVerified === true : false,
    complimentaryAuthorisedByName: complimentary ? String(order?.complimentaryAuthorisedByName || '').slice(0, 100) : null,
    complimentaryAuthorisedAt: complimentary
      ? dateFromValue(order?.complimentaryAuthorisedAt)?.toISOString() || null
      : null,
    discountReason: order?.discountReason ? String(order.discountReason).slice(0, 240) : null,
    voidReason: status === 'VOIDED' ? String(order?.voidReason || '').slice(0, 240) : null,
    voidedByName: status === 'VOIDED' ? String(order?.voidedByName || '').slice(0, 100) : null,
    voidedAt: status === 'VOIDED' ? dateFromValue(order?.voidedAt)?.toISOString() || null : null,
    inventoryReversalStatus: status === 'VOIDED'
      ? String(order?.inventoryReversalStatus || (Number(order?.stockMovementCount) > 0 ? 'RECORDED' : 'NOT_RECORDED'))
      : null,
    receiptLegalDetails: order?.receiptLegalDetails && typeof order.receiptLegalDetails === 'object'
      ? {
        legalName: String(order.receiptLegalDetails.legalName || '').slice(0, 160),
        tradeName: String(order.receiptLegalDetails.tradeName || '').slice(0, 160),
        legalAddress: String(order.receiptLegalDetails.legalAddress || '').slice(0, 300),
        gstin: String(order.receiptLegalDetails.gstin || '').slice(0, 30),
        gstRegistered: order.receiptLegalDetails.gstRegistered === true,
      }
      : null,
    items,
  };
}

export function normalizeRecords(records) {
  return (Array.isArray(records) ? records : []).map(normalizeOrderRecord);
}

function includesFilter(value, expected) {
  if (!expected || expected === 'ALL') return true;
  const selected = Array.isArray(expected) ? expected : [expected];
  return selected.map(String).includes(String(value));
}

export function filterNormalizedRecords(records, filters = {}) {
  return records.filter((record) => {
    if (Array.isArray(filters.storeIds) && filters.storeIds.length > 0 && !filters.storeIds.includes(record.storeId)) return false;
    if (!includesFilter(record.source, filters.source)) return false;
    if (!includesFilter(record.orderType, filters.orderType)) return false;
    if (!includesFilter(record.status, filters.orderStatus)) return false;
    if (!includesFilter(record.commercial, filters.commercialStatus)) return false;
    if (filters.paymentMethod && filters.paymentMethod !== 'ALL' && !record.paymentMethods.includes(filters.paymentMethod)) return false;
    if (filters.staffName && filters.staffName !== 'ALL' && record.staffName !== filters.staffName) return false;
    if (filters.category && filters.category !== 'ALL' && !record.items.some((item) => item.categoryName === filters.category)) return false;
    if (filters.itemCode && filters.itemCode !== 'ALL' && !record.items.some((item) => item.itemCode === filters.itemCode)) return false;
    return true;
  });
}

function collectionMetrics(records) {
  let grossPaymentsReceived = 0;
  let voidedPaymentTotal = 0;
  let refundedOrReversedPayments = 0;
  let refundPendingPayments = 0;
  let manualRefundRequiredPayments = 0;
  for (const record of records) {
    const gross = record.payments.reduce((sum, row) => sum + row.amount, 0);
    grossPaymentsReceived += gross;
    if (record.status !== 'VOIDED') continue;
    for (const reversal of record.reversals) {
      voidedPaymentTotal += reversal.reversalAmount;
      if (['REFUNDED', 'REVERSED'].includes(reversal.status)) refundedOrReversedPayments += reversal.reversalAmount;
      if (reversal.status === 'REFUND_PENDING') refundPendingPayments += reversal.reversalAmount;
      if (reversal.status === 'MANUAL_REFUND_REQUIRED') manualRefundRequiredPayments += reversal.reversalAmount;
    }
  }
  return {
    grossPaymentsReceived: money(grossPaymentsReceived),
    voidedPaymentTotal: money(voidedPaymentTotal),
    refundedOrReversedPayments: money(refundedOrReversedPayments),
    refundPendingPayments: money(refundPendingPayments),
    manualRefundRequiredPayments: money(manualRefundRequiredPayments),
    refundsPending: money(refundPendingPayments + manualRefundRequiredPayments),
    netCollections: money(grossPaymentsReceived - voidedPaymentTotal),
  };
}

export function summarizeNormalizedRecords(records) {
  const commercial = records.filter((record) => record.status === 'COMPLETED' && record.commercial === 'PAID');
  const complimentary = records.filter((record) => record.status === 'COMPLETED' && record.commercial === 'COMPLIMENTARY');
  const voided = records.filter((record) => record.status === 'VOIDED');
  const unpaid = records.filter((record) => record.status === 'COMPLETED' && record.commercial === 'UNPAID');
  const paymentMetrics = collectionMetrics(records);
  const netSales = money(commercial.reduce((sum, record) => sum + record.netSales, 0));
  const paymentBreakdown = {};
  commercial.forEach((record) => record.payments.forEach((payment) => {
    paymentBreakdown[payment.method] = money((paymentBreakdown[payment.method] || 0) + payment.amount);
  }));
  return {
    grossMenuValue: money(commercial.reduce((sum, record) => sum + record.menuValue, 0)),
    discounts: money(commercial.reduce((sum, record) => sum + record.discount, 0)),
    taxableSales: money(commercial.reduce((sum, record) => sum + record.taxable, 0)),
    gstCollected: money(commercial.reduce((sum, record) => sum + record.gst, 0)),
    netSales,
    totalCollected: money(commercial.reduce((sum, record) => (
      sum + record.payments.reduce((paymentSum, payment) => paymentSum + payment.amount, 0)
    ), 0)),
    orderCount: commercial.length,
    paidTransactionCount: commercial.filter((record) => record.paymentStatus === 'PAID').length,
    averageOrderValue: commercial.length > 0 ? money(netSales / commercial.length) : 0,
    complimentaryOrderCount: complimentary.length,
    complimentaryMenuValue: money(complimentary.reduce((sum, record) => sum + record.menuValue, 0)),
    complimentaryCogs: money(complimentary.reduce((sum, record) => sum + record.cogs, 0)),
    voidOrderCount: voided.length,
    voidedOrderValue: money(voided.reduce((sum, record) => sum + record.total, 0)),
    unpaidOrderCount: unpaid.length,
    unpaidAmount: money(unpaid.reduce((sum, record) => sum + record.total, 0)),
    paymentBreakdown,
    ...paymentMetrics,
  };
}

export function summarizeReportingRecords(records, filters = {}) {
  return summarizeNormalizedRecords(filterNormalizedRecords(normalizeRecords(records), filters));
}

export function buildFranchiseDailyDataset(rawRecords, timeZone = REPORT_TIME_ZONE) {
  const records = normalizeRecords(rawRecords);
  const summary = summarizeNormalizedRecords(records);
  const completedCommercial = records.filter((record) => record.status === 'COMPLETED' && record.commercial === 'PAID');
  const hourlySales = aggregate(
    completedCommercial,
    (record) => hourKey(record.createdAt, timeZone),
    (record) => ({ hour: hourKey(record.createdAt, timeZone), orderCount: 0, netSales: 0 }),
    (row, record) => {
      row.orderCount += 1;
      row.netSales += record.netSales;
    },
  ).map((row) => ({ ...row, netSales: money(row.netSales) }))
    .sort((left, right) => left.hour - right.hour);
  const categorySales = aggregate(
    completedCommercial.flatMap((record) => record.items),
    (item) => item.categoryName,
    (item) => ({ categoryName: item.categoryName, quantity: 0, netSales: 0, gst: 0 }),
    (row, item) => {
      row.quantity += item.quantity;
      row.netSales += item.total;
      row.gst += item.tax;
    },
  ).map((row) => ({
    ...row,
    quantity: money(row.quantity),
    netSales: money(row.netSales),
    gst: money(row.gst),
  })).sort((left, right) => right.netSales - left.netSales);
  return {
    metrics: {
      grossMenuValue: summary.grossMenuValue,
      discounts: summary.discounts,
      netSales: summary.netSales,
      taxableSales: summary.taxableSales,
      gstCollected: summary.gstCollected,
      totalCollected: summary.totalCollected,
      paymentBreakdown: summary.paymentBreakdown,
      splitOrderCount: completedCommercial.filter((record) => record.payments.length > 1).length,
      paidTransactionCount: summary.paidTransactionCount,
      averageOrderValue: summary.averageOrderValue,
      complimentaryOrderCount: summary.complimentaryOrderCount,
      complimentaryMenuValue: summary.complimentaryMenuValue,
      complimentaryCogs: summary.complimentaryCogs,
      voidOrderCount: summary.voidOrderCount,
      voidedOrderValue: summary.voidedOrderValue,
      onlineSales: money(completedCommercial.filter((record) => record.source === 'CUSTOMER_WEB')
        .reduce((sum, record) => sum + record.netSales, 0)),
      posSales: money(completedCommercial.filter((record) => record.source !== 'CUSTOMER_WEB')
        .reduce((sum, record) => sum + record.netSales, 0)),
      grossPaymentsReceived: summary.grossPaymentsReceived,
      voidedPaymentTotal: summary.voidedPaymentTotal,
      netCollections: summary.netCollections,
    },
    hourlySales,
    categorySales,
    orders: records.map((record) => ({
      orderNumber: record.orderNumber,
      storeId: record.storeId,
      storeName: record.storeName,
      createdAt: record.createdAt,
      orderType: record.orderType,
      source: record.source === 'CUSTOMER_WEB' ? 'CUSTOMER_WEB' : 'POS',
      status: record.status,
      paymentStatus: record.paymentStatus,
      paymentMethods: record.paymentMethods,
      customerPhoneMasked: record.customerPhoneMasked,
      grossMenuValue: record.menuValue,
      discount: record.discount,
      taxableAmount: record.taxable,
      gst: record.gst,
      total: record.commercial === 'COMPLIMENTARY' ? 0 : record.total,
      complimentary: record.commercial === 'COMPLIMENTARY',
      items: record.items.map((item) => ({
        name: item.itemName,
        quantity: item.quantity,
        categoryName: item.categoryName,
      })),
    })).sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || ''))),
  };
}

function aggregate(rows, keyFor, seedFor, add) {
  const map = new Map();
  rows.forEach((row) => {
    const key = keyFor(row);
    const current = map.get(key) || seedFor(row);
    add(current, row);
    map.set(key, current);
  });
  return [...map.values()];
}

function metricsRow(label, metrics, extra = {}) {
  return {
    ...extra,
    label,
    grossMenuValue: metrics.grossMenuValue,
    discounts: metrics.discounts,
    taxableSales: metrics.taxableSales,
    gst: metrics.gstCollected,
    netSales: metrics.netSales,
    collections: metrics.netCollections,
    orderCount: metrics.orderCount,
    averageOrderValue: metrics.averageOrderValue,
    complimentaryCount: metrics.complimentaryOrderCount,
    complimentaryValue: metrics.complimentaryMenuValue,
    voidedCount: metrics.voidOrderCount,
    voidedValue: metrics.voidedOrderValue,
  };
}

function salesByStore(records) {
  return aggregate(
    records,
    (record) => record.storeId,
    (record) => ({ storeId: record.storeId, storeName: record.storeName, records: [] }),
    (row, record) => row.records.push(record),
  ).map((row) => metricsRow(row.storeName, summarizeNormalizedRecords(row.records), {
    storeId: row.storeId,
    storeName: row.storeName,
  }));
}

function dayWise(records, timeZone) {
  return aggregate(
    records,
    (record) => `${dateKey(record.createdAt, timeZone)}|${record.storeId}`,
    (record) => ({
      businessDate: dateKey(record.createdAt, timeZone),
      storeId: record.storeId,
      storeName: record.storeName,
      records: [],
    }),
    (row, record) => row.records.push(record),
  ).map((row) => metricsRow(`${row.businessDate} ${row.storeName}`, summarizeNormalizedRecords(row.records), {
    businessDate: row.businessDate,
    storeId: row.storeId,
    storeName: row.storeName,
  })).sort((left, right) => (
    String(left.businessDate).localeCompare(String(right.businessDate))
    || left.storeName.localeCompare(right.storeName)
  ));
}

function itemRows(records, byStore = false) {
  const flat = records.flatMap((record) => record.items.map((item) => ({ record, item })));
  return aggregate(
    flat,
    ({ record, item }) => `${item.itemCode}|${byStore ? record.storeId : 'ALL'}`,
    ({ record, item }) => ({
      itemCode: item.itemCode,
      itemName: item.itemName,
      category: item.categoryName,
      storeId: byStore ? record.storeId : 'ALL',
      storeName: byStore ? record.storeName : 'All accessible stores',
      quantitySold: 0,
      grossItemValue: 0,
      allocatedDiscount: 0,
      taxableValue: 0,
      gst: 0,
      netSales: 0,
      complimentaryQuantity: 0,
      complimentaryValue: 0,
      voidedQuantity: 0,
      voidedValue: 0,
    }),
    (row, { record, item }) => {
      if (record.status === 'VOIDED') {
        row.voidedQuantity += item.quantity;
        row.voidedValue += item.gross;
      } else if (record.commercial === 'COMPLIMENTARY') {
        row.complimentaryQuantity += item.quantity;
        row.complimentaryValue += item.gross;
      } else if (record.commercial === 'PAID') {
        row.quantitySold += item.quantity;
        row.grossItemValue += item.gross;
        row.allocatedDiscount += item.discount;
        row.taxableValue += item.taxable;
        row.gst += item.tax;
        row.netSales += item.total;
      }
    },
  ).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    typeof value === 'number' ? money(value) : value,
  ])));
}

function categoryRows(records) {
  const flat = itemRows(records, true);
  const rows = aggregate(
    flat,
    (row) => `${row.category}|${row.storeId}`,
    (row) => ({
      category: row.category,
      storeId: row.storeId,
      storeName: row.storeName,
      quantity: 0,
      gross: 0,
      discount: 0,
      taxable: 0,
      gst: 0,
      netSales: 0,
    }),
    (summary, row) => {
      summary.quantity += row.quantitySold;
      summary.gross += row.grossItemValue;
      summary.discount += row.allocatedDiscount;
      summary.taxable += row.taxableValue;
      summary.gst += row.gst;
      summary.netSales += row.netSales;
    },
  );
  const total = rows.reduce((sum, row) => sum + row.netSales, 0);
  return rows.map((row) => ({
    ...row,
    quantity: money(row.quantity),
    gross: money(row.gross),
    discount: money(row.discount),
    taxable: money(row.taxable),
    gst: money(row.gst),
    netSales: money(row.netSales),
    contributionPercent: total > 0 ? money(row.netSales * 100 / total) : 0,
  }));
}

function addonRows(records) {
  const flat = records.filter((record) => record.status !== 'VOIDED').flatMap((record) => record.items.flatMap((item) => (
    item.addOns.map((addOn) => ({ record, item, addOn }))
  )));
  return aggregate(
    flat,
    ({ record, item, addOn }) => `${record.storeId}|${item.itemCode}|${addOn.groupId}|${addOn.optionId}`,
    ({ record, item, addOn }) => ({
      store: record.storeName,
      addOnGroup: addOn.groupName,
      option: addOn.optionName,
      parentItem: item.itemName,
      quantity: 0,
      grossValue: 0,
      allocatedDiscount: 0,
      taxable: 0,
      gst: 0,
      netSales: 0,
      complimentaryQuantity: 0,
      complimentaryValue: 0,
      inventoryTrackingStatus: addOn.inventoryTrackingStatus,
    }),
    (row, { record, item, addOn }) => {
      const quantity = addOn.quantity * item.quantity;
      const gross = addOn.totalPrice * item.quantity;
      const discountRatio = item.gross > 0 ? item.discount / item.gross : 0;
      const discount = gross * discountRatio;
      const taxable = Math.max(0, gross - discount);
      const gst = taxable * addOn.taxRate / 100;
      if (record.commercial === 'COMPLIMENTARY') {
        row.complimentaryQuantity += quantity;
        row.complimentaryValue += gross;
        return;
      }
      if (record.commercial !== 'PAID') return;
      row.quantity += quantity;
      row.grossValue += gross;
      row.allocatedDiscount += discount;
      row.taxable += taxable;
      row.gst += gst;
      row.netSales += taxable + gst;
    },
  ).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    typeof value === 'number' ? money(value) : value,
  ])));
}

function orderRows(records) {
  return records.map((record) => ({
    orderNumber: record.orderNumber,
    dateTime: record.createdAt,
    store: record.storeName,
    source: record.source,
    orderType: record.orderType,
    table: record.tableNumber,
    biller: record.staffName,
    customerPhone: record.customerPhoneMasked,
    subtotal: record.menuValue,
    discount: record.discount,
    taxable: record.taxable,
    gst: record.gst,
    total: record.total,
    paymentStatus: record.paymentStatus,
    paymentMethods: record.paymentMethods.join(' + ') || 'None',
    commercialStatus: record.commercial,
    orderStatus: record.status,
    voidReason: record.voidReason,
    voidedBy: record.voidedByName,
    voidedAt: record.voidedAt,
  }));
}

function invoiceRows(records, storeLegalDetails = {}) {
  return records
    .filter((record) => record.status === 'COMPLETED' && record.commercial === 'PAID')
    .map((record) => {
      const legal = record.receiptLegalDetails || storeLegalDetails[record.storeId] || null;
      return {
        store: record.storeName,
        legalName: legal?.legalName || legal?.tradeName || '',
        gstin: legal?.gstRegistered ? legal.gstin : '',
        invoiceNumber: record.orderNumber,
        dateTime: record.createdAt,
        taxable: record.taxable,
        gst: record.gst,
        total: record.total,
        paymentBreakdown: record.payments.map((row) => (
          `${row.method}${row.providerMethod ? ` / ${row.providerMethod}` : ''} ${row.amount.toFixed(2)}`
        )).join(' + '),
      };
    });
}

function orderItemRows(records) {
  return records.flatMap((record) => record.items.map((item) => ({
    orderNumber: record.orderNumber,
    dateTime: record.createdAt,
    store: record.storeName,
    itemCode: item.itemCode,
    item: item.itemName,
    quantity: item.quantity,
    basePrice: item.baseUnitPrice,
    addOns: item.addOns.map((addOn) => `${addOn.optionName} × ${addOn.quantity}`).join(', '),
    addOnTotal: money(item.addOns.reduce((sum, addOn) => sum + addOn.totalPrice * item.quantity, 0)),
    discount: item.discount,
    taxable: item.taxable,
    gst: item.tax,
    lineTotal: item.total,
    kotDepartment: item.prepStation,
    kotStatus: item.status,
    voidStatus: record.status === 'VOIDED' ? 'VOIDED' : '',
  })));
}

function invoiceDetailRows(records) {
  return records.flatMap((record) => record.items.flatMap((item) => {
    const addOnLines = item.addOns.map((addOn) => {
      const gross = money(addOn.totalPrice * item.quantity);
      const discountRatio = item.gross > 0 ? item.discount / item.gross : 0;
      const discount = money(gross * discountRatio);
      const taxable = money(Math.max(0, gross - discount));
      const gst = money(taxable * addOn.taxRate / 100);
      return {
        orderNumber: record.orderNumber,
        store: record.storeName,
        lineType: 'ADD_ON',
        parentItem: item.itemName,
        code: addOn.optionId,
        description: addOn.optionName,
        quantity: addOn.quantity * item.quantity,
        unitPrice: addOn.unitPrice,
        gross,
        discount,
        taxable,
        gst,
        total: money(taxable + gst),
      };
    });
    const addOnGross = money(addOnLines.reduce((sum, line) => sum + line.gross, 0));
    const addOnDiscount = money(addOnLines.reduce((sum, line) => sum + line.discount, 0));
    const addOnTaxable = money(addOnLines.reduce((sum, line) => sum + line.taxable, 0));
    const addOnGst = money(addOnLines.reduce((sum, line) => sum + line.gst, 0));
    const addOnTotal = money(addOnLines.reduce((sum, line) => sum + line.total, 0));
    const itemRow = {
      orderNumber: record.orderNumber,
      store: record.storeName,
      lineType: 'ITEM',
      parentItem: '',
      code: item.itemCode,
      description: item.itemName,
      quantity: item.quantity,
      unitPrice: item.baseUnitPrice,
      gross: money(Math.max(0, item.gross - addOnGross)),
      discount: money(Math.max(0, item.discount - addOnDiscount)),
      taxable: money(Math.max(0, item.taxable - addOnTaxable)),
      gst: money(Math.max(0, item.tax - addOnGst)),
      total: money(Math.max(0, item.total - addOnTotal)),
    };
    return addOnLines.length === 0 ? [itemRow] : [itemRow, ...addOnLines];
  }));
}

function subOrderRows(records) {
  return aggregate(
    records,
    (record) => `${record.storeId}|${record.source}|${record.orderType}`,
    (record) => ({
      store: record.storeName,
      source: record.source,
      orderType: record.orderType,
      records: [],
    }),
    (row, record) => row.records.push(record),
  ).map((row) => ({
    ...metricsRow(`${row.source} ${row.orderType}`, summarizeNormalizedRecords(row.records)),
    store: row.store,
    source: row.source,
    orderType: row.orderType,
  }));
}

function paymentRows(records) {
  const flat = records.flatMap((record) => {
    const reversalsByMethod = new Map(record.reversals.map((row) => [row.method, row]));
    return record.payments.map((payment) => ({
      record,
      payment,
      reversal: reversalsByMethod.get(payment.method),
    }));
  });
  return aggregate(
    flat,
    ({ record, payment }) => `${record.storeId}|${dateKey(record.createdAt)}|${payment.method}|${payment.providerMethod || ''}`,
    ({ record, payment }) => ({
      businessDate: dateKey(record.createdAt),
      store: record.storeName,
      method: payment.method,
      providerMethod: payment.providerMethod,
      grossPayments: 0,
      reversals: 0,
      refundsPending: 0,
      netCollections: 0,
      orderCount: 0,
    }),
    (row, { record, payment, reversal }) => {
      row.grossPayments += payment.amount;
      row.orderCount += 1;
      if (record.status === 'VOIDED' && reversal) {
        row.reversals += reversal.reversalAmount;
        if (['REFUND_PENDING', 'MANUAL_REFUND_REQUIRED'].includes(reversal.status)) {
          row.refundsPending += reversal.reversalAmount;
        }
      }
      row.netCollections = row.grossPayments - row.reversals;
    },
  ).map((row) => ({
    ...row,
    grossPayments: money(row.grossPayments),
    reversals: money(row.reversals),
    refundsPending: money(row.refundsPending),
    netCollections: money(row.netCollections),
  }));
}

function billerRows(records) {
  return aggregate(
    records,
    (record) => `${record.storeId}|${record.staffName}`,
    (record) => ({
      staff: record.staffName,
      store: record.storeName,
      records: [],
    }),
    (row, record) => row.records.push(record),
  ).map((row) => {
    const metrics = summarizeNormalizedRecords(row.records);
    return {
      staff: row.staff,
      store: row.store,
      billsCreated: row.records.length,
      netSales: metrics.netSales,
      averageBill: metrics.averageOrderValue,
      cash: metrics.paymentBreakdown.CASH || 0,
      upi: metrics.paymentBreakdown.UPI || 0,
      card: metrics.paymentBreakdown.CARD || 0,
      splitOrders: row.records.filter((record) => record.payments.length > 1).length,
      discountValue: metrics.discounts,
      complimentaryCount: metrics.complimentaryOrderCount,
      complimentaryValue: metrics.complimentaryMenuValue,
      voidedCount: metrics.voidOrderCount,
      voidedValue: metrics.voidedOrderValue,
    };
  });
}

function splitPaymentRows(records) {
  return records.filter((record) => record.payments.length > 1).flatMap((record) => (
    record.payments.map((payment) => {
      const reversal = record.reversals.find((row) => row.method === payment.method);
      return {
        orderNumber: record.orderNumber,
        dateTime: record.createdAt,
        store: record.storeName,
        tender: payment.method,
        amount: payment.amount,
        reversalAmount: reversal?.reversalAmount || 0,
        netAmount: money(payment.amount - (reversal?.reversalAmount || 0)),
        reconciliationStatus: reversal?.status || (record.status === 'VOIDED' ? 'REVIEW' : 'RECONCILED'),
      };
    })
  ));
}

function discountRows(records, orderOnly = false) {
  const discounted = records.filter((record) => record.commercial === 'PAID' && record.discount > 0);
  if (orderOnly) {
    return discounted.map((record) => ({
      orderNumber: record.orderNumber,
      dateTime: record.createdAt,
      store: record.storeName,
      source: record.source,
      discountPercent: record.menuValue > 0 ? money(record.discount * 100 / record.menuValue) : 0,
      discountAmount: record.discount,
      reason: record.discountReason || '',
      reasonStatus: record.discountReason ? 'RECORDED' : 'MISSING',
      staff: record.staffName,
      status: record.status,
    }));
  }
  return discounted.flatMap((record) => record.items
    .filter((item) => item.discount > 0)
    .map((item) => ({
      orderNumber: record.orderNumber,
      dateTime: record.createdAt,
      store: record.storeName,
      source: record.source,
      item: item.itemName,
      discountPercent: item.gross > 0 ? money(item.discount * 100 / item.gross) : 0,
      discountAmount: item.discount,
      reason: record.discountReason || '',
      staff: record.staffName,
      role: record.staffRole || 'Not recorded',
    })));
}

function complimentaryRows(records) {
  return records.filter((record) => record.commercial === 'COMPLIMENTARY').map((record) => ({
    orderNumber: record.orderNumber,
    dateTime: record.createdAt,
    store: record.storeName,
    recipient: record.customerName,
    mobile: record.customerPhoneMasked,
    reason: record.complimentaryReason,
    menuValue: record.menuValue,
    addOnValue: money(record.items.reduce((sum, item) => (
      sum + item.addOns.reduce((addOnSum, addOn) => addOnSum + addOn.totalPrice * item.quantity, 0)
    ), 0)),
    cogs: record.cogs,
    authorisedBy: record.complimentaryAuthorisedByName,
    otpProvider: record.complimentaryOtpProvider,
    verificationStatus: record.complimentaryVerified ? 'VERIFIED / USED' : 'LEGACY / NOT RECORDED',
    voidStatus: record.status === 'VOIDED' ? 'VOIDED' : 'ACTIVE',
  }));
}

function voidRows(records, itemWise = false) {
  const voided = records.filter((record) => record.status === 'VOIDED');
  if (itemWise) {
    return voided.flatMap((record) => record.items.map((item) => ({
      orderNumber: record.orderNumber,
      dateTime: record.voidedAt || record.createdAt,
      store: record.storeName,
      item: item.itemName,
      quantity: item.quantity,
      value: item.gross,
      addOns: item.addOns.map((addOn) => addOn.optionName).join(', '),
      stockReversal: record.inventoryReversalStatus,
      reason: record.voidReason,
      staff: record.voidedByName,
    })));
  }
  return voided.map((record) => ({
    orderNumber: record.orderNumber,
    dateTime: record.voidedAt || record.createdAt,
    store: record.storeName,
    originalTotal: record.total,
    paymentReversal: money(record.reversals.reduce((sum, row) => sum + row.reversalAmount, 0)),
    paymentOutcome: record.paymentStatus,
    voidReason: record.voidReason,
    voidedBy: record.voidedByName,
    inventoryReversal: record.inventoryReversalStatus,
  }));
}

function refundRows(records) {
  return records.flatMap((record) => record.reversals.map((reversal) => ({
    orderNumber: record.orderNumber,
    store: record.storeName,
    dateTime: record.voidedAt || record.createdAt,
    method: reversal.method,
    originalPayment: reversal.originalAmount,
    reversalAmount: reversal.reversalAmount,
    status: reversal.status,
    pendingRefund: ['REFUND_PENDING', 'MANUAL_REFUND_REQUIRED'].includes(reversal.status)
      ? reversal.reversalAmount
      : 0,
    reference: record.orderNumber,
  })));
}

function tagRows(records) {
  const flat = records.flatMap((record) => record.items.flatMap((item) => (
    item.tags.map((tag) => ({ record, item, tag }))
  )));
  return aggregate(
    flat,
    ({ record, tag }) => `${record.storeId}|${tag}`,
    ({ record, tag }) => ({ tag, store: record.storeName, quantity: 0, netSales: 0 }),
    (row, { record, item }) => {
      if (record.commercial === 'PAID' && record.status === 'COMPLETED') {
        row.quantity += item.quantity;
        row.netSales += item.total;
      }
    },
  ).map((row) => ({ ...row, quantity: money(row.quantity), netSales: money(row.netSales) }));
}

function hourlyRows(records, timeZone) {
  return aggregate(
    records.filter((record) => record.commercial === 'PAID' && record.status === 'COMPLETED'),
    (record) => `${record.storeId}|${hourKey(record.createdAt, timeZone)}`,
    (record) => ({
      store: record.storeName,
      hour: hourKey(record.createdAt, timeZone),
      orderCount: 0,
      netSales: 0,
    }),
    (row, record) => {
      row.orderCount += 1;
      row.netSales += record.netSales;
    },
  ).map((row) => ({
    ...row,
    hourLabel: `${String(row.hour).padStart(2, '0')}:00`,
    netSales: money(row.netSales),
    averageOrderValue: row.orderCount > 0 ? money(row.netSales / row.orderCount) : 0,
  })).sort((left, right) => left.hour - right.hour || left.store.localeCompare(right.store));
}

function outletComparisonRows(records) {
  return salesByStore(records).map((row) => {
    const storeRecords = records.filter((record) => record.storeId === row.storeId);
    const paid = storeRecords.filter((record) => record.commercial === 'PAID' && record.status === 'COMPLETED');
    const sourceTotals = {};
    const paymentTotals = {};
    paid.forEach((record) => {
      sourceTotals[record.source] = money((sourceTotals[record.source] || 0) + record.netSales);
      record.payments.forEach((payment) => {
        paymentTotals[payment.method] = money((paymentTotals[payment.method] || 0) + payment.amount);
      });
    });
    return {
      store: row.storeName,
      netSales: row.netSales,
      orderCount: row.orderCount,
      averageOrderValue: row.averageOrderValue,
      discountRate: row.grossMenuValue > 0 ? money(row.discounts * 100 / row.grossMenuValue) : 0,
      complimentaryRate: storeRecords.length > 0 ? money(row.complimentaryCount * 100 / storeRecords.length) : 0,
      voidRate: storeRecords.length > 0 ? money(row.voidedCount * 100 / storeRecords.length) : 0,
      channelMix: Object.entries(sourceTotals).map(([key, value]) => `${key} ${value}`).join(' | '),
      paymentMix: Object.entries(paymentTotals).map(([key, value]) => `${key} ${value}`).join(' | '),
    };
  });
}

function itemMatrix(records) {
  const stores = [...new Map(records.map((record) => [record.storeId, record.storeName])).entries()];
  const rows = itemRows(records, true);
  const byItem = aggregate(
    rows,
    (row) => row.itemCode,
    (row) => ({ itemCode: row.itemCode, itemName: row.itemName, category: row.category, totalQuantity: 0, totalNetSales: 0 }),
    (summary, row) => {
      const storeKey = row.storeId.replace(/[^A-Za-z0-9_]/g, '_');
      summary[`${storeKey}_quantity`] = row.quantitySold;
      summary[`${storeKey}_netSales`] = row.netSales;
      summary.totalQuantity += row.quantitySold;
      summary.totalNetSales += row.netSales;
    },
  ).map((row) => ({
    ...row,
    totalQuantity: money(row.totalQuantity),
    totalNetSales: money(row.totalNetSales),
  }));
  const dynamicColumns = stores.flatMap(([storeId, storeName]) => {
    const key = storeId.replace(/[^A-Za-z0-9_]/g, '_');
    return [
      { key: `${key}_quantity`, label: `${storeName} Qty`, type: 'number' },
      { key: `${key}_netSales`, label: `${storeName} Sales`, type: 'money' },
    ];
  });
  return { rows: byItem, dynamicColumns };
}

function onlineOrderRows(onlineOrders) {
  return onlineOrders.map((order) => {
    const submittedAt = dateFromValue(order?.createdAt);
    const convertedAt = dateFromValue(order?.convertedAt || order?.acceptedAt);
    return {
      reference: String(order?.publicOrderReference || order?.linkedOrderNumber || 'Customer order'),
      dateTime: submittedAt?.toISOString() || null,
      store: String(order?.storeName || order?.storeId || ''),
      source: String(order?.source || 'CUSTOMER_WEB'),
      status: String(order?.status || 'PENDING'),
      accepted: ['ACCEPTED', 'CONVERTED'].includes(String(order?.status)),
      rejected: String(order?.status) === 'REJECTED',
      rejectionReason: order?.rejectReason ? String(order.rejectReason).slice(0, 240) : '',
      conversionMinutes: submittedAt && convertedAt
        ? Math.max(0, Math.round((convertedAt.getTime() - submittedAt.getTime()) / 60000))
        : null,
      paymentStatus: String(order?.paymentStatus || 'PAY_AT_COUNTER'),
      sales: money(order?.grandTotal),
      orderType: String(order?.orderType || 'PICKUP'),
      customerPhone: maskIndianMobile(order?.customerPhone),
      notes: order?.notes ? String(order.notes).slice(0, 300) : '',
    };
  });
}

function conditionalRows(reportId, records) {
  if (reportId === 'locality-wise') {
    return aggregate(
      records.filter((record) => record.locality),
      (record) => `${record.storeId}|${record.locality}`,
      (record) => ({ locality: record.locality, store: record.storeName, orderCount: 0, netSales: 0 }),
      (row, record) => {
        if (record.commercial === 'PAID' && record.status === 'COMPLETED') {
          row.orderCount += 1;
          row.netSales += record.netSales;
        }
      },
    ).map((row) => ({ ...row, netSales: money(row.netSales) }));
  }
  if (reportId === 'corporate-customer-gst') {
    return records.filter((record) => record.companyName && record.customerGstin).map((record) => ({
      company: record.companyName,
      gstin: record.customerGstin,
      invoiceNumber: record.orderNumber,
      store: record.storeName,
      taxable: record.taxable,
      gst: record.gst,
      total: record.total,
    }));
  }
  if (reportId === 'advance-order-summary') {
    return records.filter((record) => record.scheduledAt).map((record) => ({
      orderNumber: record.orderNumber,
      store: record.storeName,
      scheduledAt: record.scheduledAt,
      orderType: record.orderType,
      status: record.status,
      value: record.total,
    }));
  }
  return [];
}

function columnsForRows(rows, overrides = []) {
  if (overrides.length > 0) return overrides;
  const first = rows[0] || {};
  return Object.keys(first).filter((key) => !['records', 'storeId'].includes(key)).map((key) => {
    const value = first[key];
    const lower = key.toLowerCase();
    const type = typeof value === 'number' && (
      lower.includes('sales')
      || lower.includes('value')
      || lower.includes('amount')
      || lower.includes('total')
      || lower.includes('gross')
      || lower.includes('discount')
      || lower.includes('taxable')
      || lower === 'gst'
      || lower.includes('collection')
      || lower.includes('cash')
      || lower.includes('upi')
      || lower.includes('card')
      || lower.includes('price')
      || lower.includes('cogs')
    ) ? 'money' : typeof value === 'number' ? 'number' : 'text';
    return {
      key,
      label: key.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase()),
      type,
    };
  });
}

function reportUnavailable(reportId, records) {
  if (reportId === 'tag-wise' && !records.some((record) => record.items.some((item) => item.tags.length > 0))) {
    return 'Data capture required — product tags are not stored on current order items.';
  }
  if (reportId === 'locality-wise' && !records.some((record) => record.locality)) {
    return 'Not available — a structured locality field is not currently captured.';
  }
  if (reportId === 'corporate-customer-gst' && !records.some((record) => record.companyName && record.customerGstin)) {
    return 'Not available — company name and customer GSTIN are not currently captured together.';
  }
  if (reportId === 'advance-order-summary' && !records.some((record) => record.scheduledAt)) {
    return 'Not available — advance-order data is not currently captured.';
  }
  return null;
}

export function buildReportDataset(reportId, rawRecords, context = {}) {
  const definition = REPORT_REGISTRY.find((entry) => entry.reportId === reportId);
  if (!definition) throw new Error('Unknown report.');
  const records = filterNormalizedRecords(normalizeRecords(rawRecords), context.filters || {});
  const unavailableReason = reportUnavailable(reportId, records);
  if (unavailableReason) {
    return {
      definition: { ...definition, availabilityStatus: 'DATA_CAPTURE_REQUIRED', unavailableReason },
      summary: summarizeNormalizedRecords(records),
      columns: [],
      rows: [],
      availabilityStatus: 'DATA_CAPTURE_REQUIRED',
      unavailableReason,
    };
  }

  let rows = [];
  let dynamicColumns = [];
  switch (reportId) {
    case 'all-restaurant-sales':
      rows = salesByStore(records);
      break;
    case 'all-restaurant-day-wise':
      rows = dayWise(records, context.timeZone || REPORT_TIME_ZONE);
      break;
    case 'outlet-comparison':
      rows = outletComparisonRows(records);
      break;
    case 'all-restaurant-hourly':
      rows = hourlyRows(records, context.timeZone || REPORT_TIME_ZONE);
      break;
    case 'item-wise-all-restaurants':
      rows = itemRows(records, false);
      break;
    case 'outlet-item-wise':
      rows = itemRows(records, true);
      break;
    case 'item-wise-matrix': {
      const matrix = itemMatrix(records);
      rows = matrix.rows;
      dynamicColumns = matrix.dynamicColumns;
      break;
    }
    case 'category-wise':
      rows = categoryRows(records);
      break;
    case 'tag-wise':
      rows = tagRows(records);
      break;
    case 'addon-sales':
      rows = addonRows(records);
      break;
    case 'orders-master':
      rows = orderRows(records);
      break;
    case 'invoice-all-restaurants':
      rows = invoiceRows(records, context.storeLegalDetails || {});
      break;
    case 'order-item-wise':
      rows = orderItemRows(records);
      break;
    case 'item-invoice-details':
      rows = invoiceDetailRows(records);
      break;
    case 'order-sub-order-wise':
      rows = subOrderRows(records);
      break;
    case 'payment-collection':
      rows = paymentRows(records);
      break;
    case 'day-sales-biller-wise':
      rows = billerRows(records);
      break;
    case 'split-payment-detail':
      rows = splitPaymentRows(records);
      break;
    case 'discount-report':
      rows = discountRows(records, false);
      break;
    case 'discounted-orders-with-reason':
      rows = discountRows(records, true);
      break;
    case 'complimentary-orders':
      rows = complimentaryRows(records);
      break;
    case 'cancel-void-orders':
      rows = voidRows(records, false);
      break;
    case 'cancel-void-item-wise':
      rows = voidRows(records, true);
      break;
    case 'refund-reversal':
      rows = refundRows(records);
      break;
    case 'online-order':
    case 'customer-order':
      rows = onlineOrderRows(context.onlineOrders || []);
      break;
    case 'locality-wise':
    case 'corporate-customer-gst':
    case 'advance-order-summary':
      rows = conditionalRows(reportId, records);
      break;
    default:
      rows = [];
  }

  return {
    definition,
    summary: summarizeNormalizedRecords(records),
    columns: columnsForRows(rows, dynamicColumns.length > 0 ? [
      { key: 'itemCode', label: 'Item Code', type: 'text' },
      { key: 'itemName', label: 'Item Name', type: 'text' },
      { key: 'category', label: 'Category', type: 'text' },
      ...dynamicColumns,
      { key: 'totalQuantity', label: 'Total Qty', type: 'number' },
      { key: 'totalNetSales', label: 'Total Sales', type: 'money' },
    ] : []),
    rows,
    availabilityStatus: 'AVAILABLE',
    unavailableReason: null,
  };
}

export function reportDefinition(reportId) {
  return REPORT_REGISTRY.find((entry) => entry.reportId === reportId) || null;
}

export function roleCanAccessReport(role, reportId) {
  const definition = reportDefinition(reportId);
  return Boolean(definition && definition.allowedRoles.includes(role));
}
