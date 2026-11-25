/** Read-only GST working papers from immutable sale snapshots. Never a filing payload. */
export const COMPLIANCE_TIME_ZONE = 'Asia/Kolkata';
const EPSILON = 0.010000001;
const COMPONENTS = ['cgst', 'sgst', 'igst', 'cess'];
const PLACEHOLDERS = new Set(['CREDIT', 'PAY_AT_COUNTER', 'COMPLIMENTARY']);
const TENDERS = new Set(['CASH', 'UPI', 'CARD', 'SWIGGY', 'ZOMATO', 'RAZORPAY', 'ONLINE']);
const text = value => typeof value === 'string' && value.trim() ? value.trim().slice(0, 240) : null;
const upper = value => text(value)?.toUpperCase() ?? null;
const staffUid = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : null;
const reasonText = value => text(value)?.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email redacted]').replace(/\+?\d[\d\s().-]{8,}\d/g, match => match.replace(/\D/g, '').length >= 10 ? '[phone redacted]' : match).replace(/[\u0000-\u001f]/g, ' ') ?? null;
const finite = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value)) ? Number(value) : null;
const pick = (...values) => values.find(value => value !== null && value !== undefined && value !== '') ?? null;
const number = (...values) => finite(pick(...values));
const amount = value => Math.round((value + Number.EPSILON) * 100) / 100;
const sumKnown = values => values.length && values.every(value => value !== null && Number.isFinite(value)) ? values.reduce((sum, value) => sum + value, 0) : null;
const array = value => Array.isArray(value) ? value : [];
const validGstin = value => typeof value === 'string' && /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(value);

export function dateFromValue(value) {
  if (value === null || value === undefined || value === '') return null;
  try {
    if (typeof value?.toDate === 'function') return dateFromValue(value.toDate());
    const seconds = number(value?.seconds, value?._seconds);
    const date = seconds !== null ? new Date(seconds * 1000 + (number(value.nanoseconds, value._nanoseconds) ?? 0) / 1e6) : value instanceof Date ? new Date(value) : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch { return null; }
}
export function toIST(value) {
  const date = dateFromValue(value);
  return date ? `${new Date(date.getTime() + 330 * 60_000).toISOString().slice(0, -1)}+05:30` : null;
}
const iso = value => dateFromValue(value)?.toISOString() ?? null;
const day = value => toIST(value)?.slice(0, 10) ?? null;
export function fiscalYearForDate(value) {
  const local = day(value);
  if (!local) return null;
  const year = Number(local.slice(0, 4)) - (Number(local.slice(5, 7)) < 4 ? 1 : 0);
  return `${year}-${String(year + 1).slice(-2)}`;
}
export function safeCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? value : '';
  if (typeof value === 'boolean') return value;
  const result = String(value);
  return /^[\s\u0000-\u001f\u007f-\u009f\u200B-\u200F\uFEFF]*[=+\-@]/.test(result) || /^[\t\r\n]/.test(result) ? `'${result}` : result;
}

function taxComponents(source = {}) {
  const nested = source.taxBreakdown || source.gstBreakdown || {};
  return Object.fromEntries(COMPONENTS.map(key => [key, number(source[`${key}Amount`], source[`${key}Total`], source[key], nested[`${key}Amount`], nested[key])]));
}
function sellerDetails(order, stores, storeId) {
  const snapshot = order.receiptLegalDetails || order.legalDetailsSnapshot || order.supplierLegalSnapshot;
  const capturedSourceId = text(pick(order.gstSourceStoreId, order.legalAndGstSourceStoreId, snapshot?.sourceStoreId, snapshot?.legalSourceStoreId));
  let source = snapshot;
  let legalSource = snapshot ? 'CAPTURED_SNAPSHOT' : 'MISSING';
  // Current metadata is shown only for an explicit source mapping and is never promoted to historical evidence.
  if (!source) {
    const currentStore = stores.find(store => store.id === storeId);
    const mappedId = text(currentStore?.legalAndGstSourceStoreId);
    const mapped = mappedId && stores.find(store => store.id === mappedId);
    if (mapped) { source = mapped.gstLegalDetails || mapped; legalSource = 'UNVERIFIED_CURRENT_METADATA'; }
  }
  source ||= {};
  const gstin = upper(source.gstin);
  const registered = typeof source.gstRegistered === 'boolean' ? source.gstRegistered : typeof source.registered === 'boolean' ? source.registered : null;
  const verified = legalSource === 'CAPTURED_SNAPSHOT';
  const entityId = verified && validGstin(gstin) ? `GSTIN:${gstin}` : capturedSourceId ? `LEGAL_SOURCE:${capturedSourceId}` : `UNVERIFIED_STORE:${storeId || 'UNKNOWN'}`;
  return { legalName: text(source.legalName), gstin, registered, legalSource, legalSourceStoreId: capturedSourceId, stateCode: text(source.stateCode), entityId, entitySource: verified && validGstin(gstin) ? 'CAPTURED_GSTIN' : capturedSourceId ? 'CAPTURED_LEGAL_SOURCE' : 'UNVERIFIED_STORE_GROUP' };
}
function buyerDetails(order) {
  const gstin = upper(pick(order.buyerGstin, order.recipientGstin, order.customerGstin, order.companyGstin, order.billingDetails?.gstin, order.buyer?.gstin));
  const explicit = upper(pick(order.buyerRegistrationStatus, order.recipientRegistrationStatus));
  const registered = pick(order.buyerGstRegistered, order.customerGstRegistered, order.recipientGstRegistered);
  const classification = validGstin(gstin) || explicit === 'REGISTERED' || explicit === 'B2B' || registered === true ? 'B2B'
    : explicit === 'UNREGISTERED' || explicit === 'B2C' || registered === false ? 'B2C' : 'UNKNOWN';
  return { buyerGstin: gstin, buyerRegistration: classification };
}
function supplyDetails(source = {}) {
  const classification = upper(pick(source.gstSupplyType, source.supplyClassification, source.supplyType));
  return ['TAXABLE', 'EXEMPT', 'NIL_RATED', 'ZERO_RATED', 'NON_GST'].includes(classification) ? classification : null;
}
function paymentRows(order, documents) {
  const hasDocuments = array(documents).length > 0;
  const source = hasDocuments ? documents : array(order.paymentBreakdown);
  return source.map((row, index) => ({
    paymentId: text(row.id), paymentIndex: number(row.paymentIndex) ?? index,
    method: row.provider === 'RAZORPAY' || order.paymentProvider === 'RAZORPAY' ? 'RAZORPAY' : upper(row.method) || 'UNKNOWN',
    amount: number(row.amount), timestampISO: iso(pick(row.paidAt, row.capturedAt, row.createdAt)),
    timestampIST: toIST(pick(row.paidAt, row.capturedAt, row.createdAt)),
    evidence: hasDocuments ? 'PAYMENT_DOCUMENT' : 'ORDER_BREAKDOWN', status: upper(row.status), actorUid: staffUid(pick(row.settledBy, row.createdByUserId, row.staffUid)),
    referenceCaptured: Boolean(pick(row.reference, row.providerPaymentId, row.razorpayPaymentId)),
    // Freeform tender references can contain a telephone number or UPI address.
    providerPaymentId: /^pay_[A-Za-z0-9]+$/.test(pick(row.providerPaymentId, row.razorpayPaymentId) || '') ? pick(row.providerPaymentId, row.razorpayPaymentId) : null,
  }));
}
function reconciliation(order, bill, lines) {
  const known = [bill.subtotal, bill.discount, bill.taxableAmount, bill.gstTotal, bill.grandTotal].every(value => value !== null);
  const delta = known ? bill.grandTotal - bill.taxableAmount - bill.gstTotal - (bill.roundingAdjustment ?? 0) : null;
  const discountDelta = known ? bill.taxableAmount - (bill.subtotal - bill.discount) : null;
  const parent = lines.filter(row => !row.includedInParent);
  const lineTotals = Object.fromEntries(['subtotal', 'discount', 'taxableAmount', 'gstTotal', 'grandTotal'].map(key => [key, sumKnown(parent.map(row => row[key]))]));
  const deltas = Object.fromEntries(Object.keys(lineTotals).map(key => [key, lineTotals[key] !== null && bill[key] !== null ? lineTotals[key] - bill[key] : null]));
  const hasMismatch = [delta, discountDelta, ...Object.values(deltas)].some(value => value !== null && Math.abs(value) > EPSILON);
  const status = hasMismatch ? 'MISMATCH' : known && parent.length && Object.values(deltas).every(value => value !== null) ? 'RECONCILED' : 'INCOMPLETE';
  return { reconciliationStatus: status, reconciliationDelta: delta, discountReconciliationDelta: discountDelta, lineSubtotalDelta: deltas.subtotal, lineDiscountDelta: deltas.discount, lineTaxableDelta: deltas.taxableAmount, lineTaxDelta: deltas.gstTotal, lineTotalDelta: deltas.grandTotal };
}
function gstSchedule(bill, line, buyer, order, issue) {
  const supply = line.supplyClassification || bill.supplyClassification;
  const placeOfSupply = text(pick(line.placeOfSupplyStateCode, order.placeOfSupplyStateCode, order.servicePlaceStateCode, order.placeOfSupply?.stateCode));
  const explicitRelation = upper(pick(order.supplyJurisdiction, order.gstSupplyJurisdiction));
  // Restaurant service PoS must be captured independently of the buyer GSTIN.
  const jurisdiction = ['INTRA_STATE', 'INTER_STATE'].includes(explicitRelation) ? explicitRelation : bill.stateCode && placeOfSupply ? (bill.stateCode === placeOfSupply ? 'INTRA_STATE' : 'INTER_STATE') : 'UNKNOWN';
  let schedule = 'UNCLASSIFIED';
  let table = null;
  if (bill.provisional) schedule = 'PROVISIONAL_EXCLUDED';
  else if (bill.documentType === 'INTERNAL_VOID') schedule = 'INTERNAL_VOID_REVIEW';
  else if (['VOIDED', 'CANCELLED'].includes(bill.status)) schedule = 'CANCELLED_DOCUMENT_REVIEW';
  else if (bill.documentType === 'CREDIT_NOTE' || bill.documentType === 'DEBIT_NOTE') { schedule = bill.invoiceNumber && bill.invoiceIssuedAtISO ? `${bill.documentType}_WORKING` : 'NOTE_DOCUMENT_REVIEW'; table = bill.invoiceNumber && bill.invoiceIssuedAtISO ? '9B' : null; }
  else if (!bill.eligibleSale) schedule = 'NON_SALE_REVIEW';
  else if (bill.registered !== true || bill.legalSource !== 'CAPTURED_SNAPSHOT') schedule = 'SUPPLIER_REGISTRATION_REVIEW';
  else if (['EXEMPT', 'NIL_RATED', 'NON_GST'].includes(supply)) { schedule = `${supply}_WORKING`; table = '8'; }
  else if (supply === 'ZERO_RATED') schedule = 'ZERO_RATED_REVIEW';
  else if (buyer.buyerRegistration === 'B2B') { schedule = 'B2B_WORKING'; table = '4'; }
  else if (buyer.buyerRegistration === 'B2C' && jurisdiction !== 'UNKNOWN' && bill.grandTotal !== null) {
    // Portal rule effective August 2024. Earlier periods retain their historical threshold.
    const policyDate = bill.invoiceIssuedDate || bill.createdDate;
    const threshold = policyDate && policyDate >= '2024-08-01' ? 100000 : policyDate ? 250000 : null;
    if (jurisdiction === 'INTRA_STATE') { schedule = 'B2CS_WORKING'; table = '7'; }
    else if (threshold !== null) { schedule = bill.grandTotal > threshold ? 'B2CL_WORKING' : 'B2CS_WORKING'; table = bill.grandTotal > threshold ? '5' : '7'; }
  }
  if (bill.eligibleSale && buyer.buyerRegistration === 'UNKNOWN') issue('BUYER_REGISTRATION_UNKNOWN', 'WARNING', 'Buyer registration was not captured; B2C is not assumed.');
  if (bill.eligibleSale && jurisdiction === 'UNKNOWN') issue('PLACE_OF_SUPPLY_UNKNOWN', 'WARNING', 'Actual service place / supply jurisdiction was not captured.');
  return { orderId: bill.orderId, storeId: bill.storeId, entityId: bill.entityId, supplierGstin: bill.gstin, supplierRegistered: bill.registered, legalSource: bill.legalSource, lineId: line.lineId, documentType: bill.documentType, invoiceNumber: bill.invoiceNumber, invoiceIssuedAtISO: bill.invoiceIssuedAtISO, periodDate: bill.periodDate, fy: bill.fy, buyerGstin: buyer.buyerGstin, buyerRegistration: buyer.buyerRegistration, placeOfSupplyStateCode: placeOfSupply, supplyJurisdiction: jurisdiction, supplyClassification: supply || 'UNKNOWN', hsnSac: line.hsnSac, taxRate: line.taxRate, taxableAmount: line.taxableAmount, gstTotal: line.gstTotal, cgst: line.cgst, sgst: line.sgst, igst: line.igst, cess: line.cess, grandTotal: line.grandTotal, schedule, gstr1Table: table, source: 'RECORDED_SNAPSHOT', completeReturn: false, taxReductionEligible: null, inPeriod: bill.inPeriod };
}

export function normalizeBill(record = {}, context = {}) {
  const order = record.order || {};
  const online = record.online;
  const offline = record.offline;
  const childrenLoaded = context.childrenLoaded !== false;
  const orderId = text(pick(record.id, order.id, online?.posOrderId, online?.id, offline?.result?.orderId));
  const storeId = text(pick(order.storeId, online?.storeId, offline?.storeId));
  const exceptions = [];
  const seenIssues = new Set();
  const issue = (code, severity, message, extra = {}) => {
    const key = `${code}:${extra.lineId || ''}:${extra.paymentId || ''}`;
    if (!seenIssues.has(key)) { exceptions.push({ code, severity, orderId, storeId, message, ...extra }); seenIssues.add(key); }
  };
  const stores = array(context.stores);
  const seller = sellerDetails(order, stores, storeId);
  const currentStore = stores.find(store => store.id === storeId);
  const provisional = !record.order || !Object.keys(order).length || order.isProvisional === true || upper(order.status) === 'PROVISIONAL';
  const status = upper(order.status) || (provisional ? 'PROVISIONAL' : 'UNKNOWN');
  const complimentary = order.commercialStatus === 'COMPLIMENTARY' || order.paymentMethod === 'COMPLIMENTARY' || array(order.paymentBreakdown).some(row => row.method === 'COMPLIMENTARY');
  const formalType = upper(pick(order.documentType, order.gstDocumentType));
  const documentType = ['CREDIT_NOTE', 'DEBIT_NOTE'].includes(formalType) ? formalType : ['VOIDED', 'CANCELLED'].includes(status) ? 'INTERNAL_VOID' : ['TAX_INVOICE', 'BILL_OF_SUPPLY'].includes(formalType) ? formalType : text(order.invoiceNumber) ? 'INVOICE_UNVERIFIED' : 'BILL_UNVERIFIED';
  const created = pick(order.createdAt, provisional ? online?.createdAt : null, provisional ? offline?.payload?.createdAt : null, provisional ? offline?.createdAt : null);
  const issued = pick(order.invoiceIssuedAt, order.invoiceDate, order.invoiceIssuedAtISO);
  const periodBasis = context.periodBasis === 'invoiceIssuedAt' ? 'invoiceIssuedAt' : 'createdAt';
  const periodDate = day(periodBasis === 'invoiceIssuedAt' ? issued : created);
  const inPeriod = Boolean(periodDate && (!context.startDate || periodDate >= context.startDate) && (!context.endDate || periodDate <= context.endDate));
  const gstTotal = number(order.gstTotal, order.taxTotal);
  const bill = {
    orderId, storeId, storeCode: text(order.storeCode), storeName: text(pick(order.storeName, currentStore?.name, storeId)), ...seller,
    billNumber: text(pick(order.orderNumber, order.billNumber)), invoiceNumber: text(order.invoiceNumber), documentType,
    status, commercialStatus: complimentary ? 'COMPLIMENTARY' : upper(order.commercialStatus) || 'UNKNOWN', source: upper(pick(order.source, online ? 'CUSTOMER_WEB' : null)) || 'UNKNOWN',
    cashierUid: staffUid(pick(order.createdByUid, order.createdByUserId, typeof order.createdBy === 'string' ? order.createdBy : null, order.userId)),
    cashierName: text(pick(order.createdByName, order.cashierName)),
    voidedByUid: staffUid(pick(order.voidedByUid, order.voidedBy)), settledByUid: staffUid(pick(order.settledByUid, order.settledBy)), voidOperationId: text(order.voidOperationId), voidReason: reasonText(order.voidReason),
    createdAtISO: iso(created), createdAtIST: toIST(created), createdDate: day(created), invoiceIssuedAtISO: iso(issued), invoiceIssuedAtIST: toIST(issued), invoiceIssuedDate: day(issued),
    settledAtISO: iso(order.settledAt), settledAtIST: toIST(order.settledAt), voidedAtISO: iso(order.voidedAt), voidedAtIST: toIST(order.voidedAt),
    paidAtISO: iso(pick(order.paidAt, order.paymentCapturedAt)), paidAtIST: toIST(pick(order.paidAt, order.paymentCapturedAt)),
    offlineCapturedAtISO: iso(pick(order.offlineCapturedAt, order.offlineFinancialSnapshot?.createdAt, offline?.payload?.createdAt)), offlineCapturedAtIST: toIST(pick(order.offlineCapturedAt, order.offlineFinancialSnapshot?.createdAt, offline?.payload?.createdAt)),
    synchronizedAtISO: iso(offline?.synchronizedAt), periodBasis, periodDate, fy: fiscalYearForDate(periodBasis === 'invoiceIssuedAt' ? issued : created), inPeriod,
    subtotal: number(order.subtotal), discount: number(order.discountAmount, order.discountTotal, order.discount), taxableAmount: number(order.taxableAmount), gstTotal,
    menuValue: number(order.menuValue, order.subtotal), complimentaryDiscount: number(order.complimentaryDiscount),
    grandTotal: number(order.grandTotal), roundingAdjustment: number(order.roundingAdjustment, order.roundOff, order.roundOffAmount), ...taxComponents(order),
    gstTreatmentMode: upper(order.gstTreatmentSnapshot?.mode), gstTreatmentRate: number(order.gstTreatmentSnapshot?.rate), gstTreatmentRevision: number(order.gstTreatmentSnapshot?.revision),
    supplyClassification: supplyDetails(order) || (gstTotal !== null && gstTotal > 0 ? 'TAXABLE_RECORDED' : 'UNKNOWN'),
    paymentStatus: upper(order.paymentStatus) || 'UNKNOWN', paymentMethod: upper(order.paymentMethod),
    onlineOrderId: text(pick(order.onlineOrderId, order.sourceOnlineOrderId, online?.id)), onlineOrderReference: text(order.onlineOrderReference),
    offlineId: text(pick(order.offlineId, offline?.id)), offlineStatus: upper(offline?.status),
    setupTest: order.isSetupTest === true || order.setupTestMode === true, complimentary, provisional,
    financialAuthorizationVersion: number(order.financialAuthorizationVersion),
    eligibleSale: !provisional && status === 'COMPLETED' && !complimentary && order.isSetupTest !== true && order.setupTestMode !== true && !['CREDIT_NOTE', 'DEBIT_NOTE'].includes(documentType),
  };
  if (!orderId) issue('MISSING_ORDER_ID', 'ERROR', 'The source does not contain an order identity.');
  if (!storeId) issue('MISSING_STORE_ID', 'ERROR', 'The source does not contain a store identity.');
  if (!bill.createdAtISO) issue('MISSING_CREATED_AT', 'ERROR', 'Order creation timestamp is missing or invalid.');
  if (!bill.invoiceNumber) issue('MISSING_INVOICE_NUMBER', 'WARNING', 'No explicit statutory invoice number was captured; the bill number is retained separately.');
  if (!bill.invoiceIssuedAtISO) issue('MISSING_INVOICE_ISSUED_AT', 'WARNING', 'Invoice issuance timestamp is unknown; creation time is not substituted.');
  if (!periodDate) issue('PERIOD_DATE_UNKNOWN', 'ERROR', `The selected ${periodBasis} basis cannot assign this record to a period.`);
  if (seller.legalSource !== 'CAPTURED_SNAPSHOT') issue('MISSING_LEGAL_SNAPSHOT', 'ERROR', 'Historical supplier legal details are missing; any displayed current mapping is unverified.');
  if (!seller.legalName || seller.registered === null) issue('INCOMPLETE_SUPPLIER_LEGAL_DETAILS', 'WARNING', 'Supplier legal name or explicit registration status is missing.');
  if (seller.registered === true && !validGstin(seller.gstin)) issue('INVALID_SUPPLIER_GSTIN', 'ERROR', 'Registered supplier GSTIN is missing or invalid.');
  if (seller.entitySource === 'UNVERIFIED_STORE_GROUP') issue('UNVERIFIED_ENTITY_GROUP', 'WARNING', 'No captured GSTIN or explicit captured legal source permits entity consolidation.');
  if (!order.gstTreatmentSnapshot) issue('MISSING_GST_TREATMENT_SNAPSHOT', 'WARNING', 'Historical GST treatment snapshot is missing; current settings were not applied.');
  if (bill.gstTreatmentMode === 'NO_GST' || seller.registered === false) issue('TAX_CLASSIFICATION_REVIEW', 'WARNING', 'No-GST / unregistered configuration does not establish exempt, nil-rated, or zero-rated supply.');
  if (bill.gstTotal !== null && bill.gstTotal > 0 && COMPONENTS.some(key => bill[key] === null)) issue('TAX_COMPONENTS_MISSING', 'WARNING', 'Captured total GST has no complete recorded CGST/SGST/IGST/cess breakdown; no split was inferred.');
  bill.taxComponentSum = sumKnown(COMPONENTS.map(key => bill[key]));
  bill.taxComponentDelta = bill.taxComponentSum !== null && bill.gstTotal !== null ? bill.taxComponentSum - bill.gstTotal : null;
  if (bill.taxComponentDelta !== null && Math.abs(bill.taxComponentDelta) > EPSILON) issue('TAX_COMPONENT_RECONCILIATION_MISMATCH', 'ERROR', 'Recorded tax components disagree with the captured total GST.');
  if (bill.gstTotal === null) issue('MISSING_TOTAL_GST', 'ERROR', 'Recorded aggregate GST is missing.');
  if (number(order.gstTotal) !== null && number(order.taxTotal) !== null && Math.abs(order.gstTotal - order.taxTotal) > EPSILON) issue('TAX_ALIAS_MISMATCH', 'ERROR', 'Captured GST aliases disagree.');
  if (bill.provisional) issue('PROVISIONAL_ONLINE_OR_OFFLINE', 'WARNING', 'A source without a committed POS sale is provisional and excluded from final sales.');
  if (bill.offlineId && bill.offlineCapturedAtISO && bill.createdDate !== day(bill.offlineCapturedAtISO)) issue('OFFLINE_CAPTURE_SYNC_DATE_DIFFERENCE', 'WARNING', 'Offline capture and committed creation fall on different IST dates; both dates remain visible.');
  if (offline?.status === 'CONFLICT' || array(offline?.conflicts).length) issue('OFFLINE_RECONCILIATION_REVIEW', 'WARNING', 'Offline journal has recorded conflict / reconciliation flags.');
  if (documentType === 'INTERNAL_VOID') issue('VOID_NOT_STATUTORY_CREDIT_NOTE', 'WARNING', 'Operational cancellation / void is not a statutory credit note; tax adjustment requires review.');
  if (['CREDIT_NOTE', 'DEBIT_NOTE'].includes(documentType) && (!bill.invoiceNumber || !bill.invoiceIssuedAtISO)) issue('FORMAL_NOTE_INCOMPLETE', 'ERROR', 'Recorded note type lacks a formal number or issue date and is not ready for a statutory schedule.');

  const lines = [];
  for (const [index, item] of array(record.items).entries()) {
    const lineId = text(item.id) || `${orderId || 'UNKNOWN'}:LINE:${index + 1}`;
    const addOns = array(item.addOns);
    const rates = [number(item.taxRate), ...addOns.map(addOn => number(addOn.taxRate))];
    const mixed = rates.some(rate => rate === null) || new Set(rates).size > 1;
    const line = {
      orderId, storeId, entityId: seller.entityId, lineId, parentLineId: null, lineType: 'ITEM', includedInParent: false,
      itemId: text(pick(item.menuItemId, item.finishedGoodCode)), itemCode: text(pick(item.itemCode, item.finishedGoodCode, item.menuItemId)), itemName: text(item.itemName), categoryName: text(item.categoryName),
      quantity: number(item.quantity), baseUnitPrice: number(item.baseUnitPrice, item.unitPrice), unitPriceWithAddOns: number(item.unitPriceWithAddOns),
      subtotal: number(item.lineSubtotal), discount: number(item.lineDiscount), taxableAmount: number(item.lineTaxable), gstTotal: number(item.lineTax), grandTotal: number(item.lineTotal),
      taxRate: mixed ? null : number(item.taxRate), capturedBaseTaxRate: number(item.taxRate), mixedRate: mixed, hsnSac: text(pick(item.hsnSac, item.hsnCode, item.sacCode, item.hsn, item.sac)), ...taxComponents(item),
      supplyClassification: supplyDetails(item), status: upper(item.status), inventoryConsumptionStatus: upper(item.inventoryConsumptionStatus), periodDate, inPeriod,
    };
    lines.push(line);
    if (!line.hsnSac) issue('HSN_SAC_MISSING', 'WARNING', 'Historical line has no HSN/SAC classification; current menu data was not applied.', { lineId });
    if (mixed) issue('MIXED_OR_UNKNOWN_LINE_RATE', 'WARNING', 'Combined line contains different or missing base/add-on rates; aggregate tax was not reassigned to a rate.', { lineId });
    if ([line.subtotal, line.discount, line.taxableAmount, line.gstTotal, line.grandTotal].some(value => value === null)) issue('LINE_FINANCIAL_SNAPSHOT_INCOMPLETE', 'WARNING', 'Captured line financial values are incomplete; no current price/rate reconstruction was performed.', { lineId });
    for (const [addOnIndex, addOn] of addOns.entries()) {
      lines.push({ orderId, storeId, entityId: seller.entityId, lineId: `${lineId}:ADDON:${addOnIndex + 1}`, parentLineId: lineId, lineType: 'ADD_ON', includedInParent: true,
        itemId: text(addOn.optionId), itemCode: text(addOn.optionId), itemName: text(addOn.optionName), categoryName: text(addOn.groupName), groupId: text(addOn.groupId),
        quantity: number(addOn.quantity), parentQuantity: line.quantity, baseUnitPrice: number(addOn.unitPrice), unitPriceWithAddOns: null,
        recordedAddOnPricePerParent: number(addOn.totalPrice), subtotal: null, discount: null, taxableAmount: null, gstTotal: null, grandTotal: null,
        taxRate: number(addOn.taxRate), hsnSac: text(pick(addOn.hsnSac, addOn.hsnCode, addOn.sacCode)), ...taxComponents(addOn), periodDate, inPeriod,
        allocationBasis: 'INFORMATIONAL_INCLUDED_IN_PARENT_NO_TAX_ALLOCATION' });
    }
  }
  if (!lines.length && !provisional && childrenLoaded) issue('MISSING_LINE_SNAPSHOTS', 'ERROR', 'Committed sale has no captured item rows.');
  Object.assign(bill, reconciliation(order, bill, lines));
  if (!childrenLoaded) { bill.reconciliationStatus = 'NOT_CHECKED'; bill.lineSubtotalDelta = null; bill.lineDiscountDelta = null; bill.lineTaxableDelta = null; bill.lineTaxDelta = null; bill.lineTotalDelta = null; }
  if (bill.reconciliationStatus === 'MISMATCH') issue('FINANCIAL_RECONCILIATION_MISMATCH', 'ERROR', 'Captured order and line financial values do not reconcile within one paisa.');
  if ([bill.subtotal, bill.discount, bill.taxableAmount, bill.grandTotal].some(value => value === null)) issue('ORDER_FINANCIAL_SNAPSHOT_INCOMPLETE', 'ERROR', 'Captured order financial values are incomplete.');

  const payments = paymentRows(order, record.payments);
  const actual = payments.filter(row => !PLACEHOLDERS.has(row.method) && TENDERS.has(row.method) && row.amount !== null && row.amount >= 0 && !['FAILED', 'CANCELLED', 'PENDING', 'AUTHORIZED'].includes(row.status));
  bill.collectedAmount = complimentary ? 0 : actual.length ? actual.reduce((sum, row) => sum + row.amount, 0) : payments.length ? 0 : null;
  bill.creditPlaceholderAmount = payments.filter(row => row.method === 'CREDIT').reduce((sum, row) => sum + (row.amount ?? 0), 0);
  bill.creditOutstanding = complimentary ? 0 : bill.grandTotal !== null && bill.collectedAmount !== null ? Math.max(0, bill.grandTotal - bill.collectedAmount) : null;
  bill.paymentMethods = [...new Set(actual.map(row => row.method))].join(' + ') || null;
  bill.paymentDocumentIds = payments.map(row => row.paymentId).filter(Boolean).join(' | ') || null;
  bill.paymentTimestampCoverage = actual.length ? actual.filter(row => row.timestampISO).length / actual.length : null;
  const paymentTimes = actual.map(row => row.timestampISO).filter(Boolean).sort();
  bill.firstPaymentAtISO = paymentTimes[0] || null; bill.lastPaymentAtISO = paymentTimes.at(-1) || null;
  if (!payments.length && !complimentary && !provisional && childrenLoaded) issue('MISSING_PAYMENT_EVIDENCE', 'WARNING', 'No payment documents or captured breakdown exist; PAID status alone is not a receipt.');
  for (const payment of actual) if (!payment.timestampISO && childrenLoaded) issue('PAYMENT_TIMESTAMP_MISSING', 'WARNING', 'Tender has no recorded payment timestamp; invoice/order dates were not substituted.', { paymentId: payment.paymentId || `ROW:${payment.paymentIndex}` });
  if (bill.paymentStatus === 'PAID' && bill.creditOutstanding !== null && bill.creditOutstanding > EPSILON) issue('PAID_COLLECTION_MISMATCH', 'ERROR', 'Paid status differs from recorded actual tenders after excluding credit placeholders.');
  if (bill.collectedAmount !== null && bill.grandTotal !== null && bill.collectedAmount - bill.grandTotal > EPSILON) issue('OVER_COLLECTION', 'ERROR', 'Recorded actual collections exceed the captured payable.');
  if (complimentary && actual.some(row => row.amount > 0)) issue('COMPLIMENTARY_PAYMENT_EVIDENCE', 'ERROR', 'Complimentary order has positive tender evidence that requires separate reconciliation.');
  if (bill.paymentStatus === 'UNPAID' && !complimentary && bill.collectedAmount !== null && bill.collectedAmount > EPSILON) issue('UNPAID_COLLECTION_MISMATCH', 'ERROR', 'Unpaid status conflicts with recorded actual tenders.');
  for (const payment of payments) if (payment.amount === null || payment.method === 'UNKNOWN' || !TENDERS.has(payment.method) && !PLACEHOLDERS.has(payment.method)) issue('PAYMENT_EVIDENCE_INVALID', 'WARNING', 'Tender amount or method is missing or unsupported and was excluded from actual collections.', { paymentId: payment.paymentId || `ROW:${payment.paymentIndex}` });
  const reversals = array(order.paymentReversalBreakdown);
  bill.refundedAmount = sumKnown(reversals.filter(row => ['REFUNDED', 'REVERSED'].includes(upper(row.reversalStatus))).map(row => number(row.amount))) ?? (reversals.length ? 0 : ['REFUNDED', 'REVERSED'].includes(upper(order.paymentReversalStatus)) ? number(order.paymentReversalTotal) : 0);
  bill.pendingRefundAmount = sumKnown(reversals.filter(row => ['REFUND_PENDING', 'MANUAL_REFUND_REQUIRED'].includes(upper(row.reversalStatus))).map(row => number(row.amount))) ?? (reversals.length ? 0 : ['REFUND_PENDING', 'MANUAL_REFUND_REQUIRED'].includes(upper(order.paymentReversalStatus)) ? number(order.paymentReversalTotal) : 0);
  bill.netCollectedAmount = bill.collectedAmount === null || bill.refundedAmount === null ? null : bill.collectedAmount - bill.refundedAmount;

  const audit = [];
  const event = (type, timestamp, fields = {}) => audit.push({ orderId, storeId, entityId: seller.entityId, eventType: type, timestampISO: iso(timestamp), timestampIST: toIST(timestamp), ...fields });
  event(provisional ? 'PROVISIONAL_SOURCE_RECORDED' : 'ORDER_CREATED', created, { source: bill.source, amount: bill.grandTotal, actorUid: bill.cashierUid });
  if (issued) event('INVOICE_ISSUED', issued, { documentNumber: bill.invoiceNumber });
  payments.forEach(row => event(PLACEHOLDERS.has(row.method) ? 'PAYMENT_PLACEHOLDER' : 'PAYMENT_RECORDED', row.timestampISO, { paymentId: row.paymentId, method: row.method, amount: row.amount, evidence: row.evidence, referenceCaptured: row.referenceCaptured, providerPaymentId: row.providerPaymentId, actorUid: row.actorUid }));
  if (order.settledAt) event('SETTLEMENT_RECORDED', order.settledAt, { paymentStatus: bill.paymentStatus, actorUid: bill.settledByUid });
  if (order.voidedAt || documentType === 'INTERNAL_VOID') event('INTERNAL_VOID', order.voidedAt, { statutoryCreditNote: false, refundStatus: upper(order.paymentReversalStatus), actorUid: bill.voidedByUid, referenceId: bill.voidOperationId });
  for (const [index, row] of reversals.entries()) event('PAYMENT_REVERSAL', pick(row.refundedAt, row.reversedAt, row.createdAt), { referenceId: `REVERSAL:${index + 1}`, method: upper(row.method), amount: number(row.amount), status: upper(row.reversalStatus) });
  if (bill.offlineId) event('OFFLINE_CAPTURE', bill.offlineCapturedAtISO, { referenceId: bill.offlineId, status: bill.offlineStatus });
  for (const row of array(record.auditEvents)) event('SOURCE_AUDIT_EVENT', pick(row.timestamp, row.createdAt, row.at), { referenceId: text(row.id), actionCode: /^[A-Z_]{1,60}$/.test(row.action || row.eventType || '') ? row.action || row.eventType : null, actorUid: staffUid(pick(row.actorUid, row.staffUid, row.createdByUserId)), actorRole: upper(row.actorRole), amount: number(row.amount) });
  bill.settlementOperationIds = array(record.auditEvents).filter(row => row.action === 'SETTLEMENT').map(row => text(row.id)).filter(Boolean).join(' | ') || null;
  bill.voidOperationIds = [...new Set([bill.voidOperationId, ...array(record.auditEvents).filter(row => row.action === 'VOID').map(row => text(row.id))].filter(Boolean))].join(' | ') || null;
  bill.stockEffectIds = array(record.stockEffects).map(row => text(row.id)).filter(Boolean).join(' | ') || null;
  bill.kotItemIds = array(record.kotItems).map(row => text(row.id)).filter(Boolean).join(' | ') || null;
  if (online) {
    if (online.createdAt) event('ONLINE_SOURCE_CREATED', online.createdAt, { referenceId: text(online.id), status: upper(online.status) });
    if (online.convertedAt || online.acceptedAt) event('ONLINE_SOURCE_ACCEPTED', pick(online.convertedAt, online.acceptedAt), { referenceId: text(online.id), status: upper(online.status) });
  }
  for (const row of array(record.stockEffects)) event('STOCK_EFFECT', pick(row.createdAt, row.timestamp), { referenceId: text(row.id), quantity: number(row.quantity), status: upper(row.status) });
  for (const row of array(record.kotItems)) event('KOT_STATUS', pick(row.updatedAt, row.createdAt), { referenceId: text(row.id), orderItemId: text(pick(row.orderItemId, row.itemId)), quantity: number(row.quantity), status: upper(row.status) });
  const buyer = buyerDetails(order);
  if (buyer.buyerGstin && !validGstin(buyer.buyerGstin)) issue('INVALID_BUYER_GSTIN', 'WARNING', 'Captured business recipient GSTIN is invalid.');
  const classifications = lines.filter(row => !row.includedInParent).map(line => gstSchedule(bill, line, buyer, order, issue));
  for (const adjustment of array(record.adjustments)) {
    const type = upper(pick(adjustment.documentType, adjustment.type));
    const formal = ['CREDIT_NOTE', 'DEBIT_NOTE'].includes(type) && text(pick(adjustment.documentNumber, adjustment.noteNumber)) && iso(pick(adjustment.issuedAt, adjustment.documentDate));
    event(formal ? `${type}_RECORDED` : 'INTERNAL_ADJUSTMENT', pick(adjustment.issuedAt, adjustment.createdAt), { referenceId: text(adjustment.id), documentNumber: text(pick(adjustment.documentNumber, adjustment.noteNumber)), amount: number(adjustment.grandTotal, adjustment.amount), statutoryNote: Boolean(formal) });
    if (formal) {
      classifications.push({ orderId, storeId, entityId: seller.entityId, documentId: text(adjustment.id), supplierGstin: seller.gstin, buyerGstin: buyer.buyerGstin, buyerRegistration: buyer.buyerRegistration,
        documentType: type, documentNumber: text(pick(adjustment.documentNumber, adjustment.noteNumber)), invoiceNumber: null,
        originalInvoiceNumber: text(adjustment.originalInvoiceNumber), invoiceIssuedAtISO: iso(pick(adjustment.issuedAt, adjustment.documentDate)), periodDate: day(pick(adjustment.issuedAt, adjustment.documentDate)),
        taxableAmount: number(adjustment.taxableAmount), gstTotal: number(adjustment.gstTotal, adjustment.taxTotal), grandTotal: number(adjustment.grandTotal, adjustment.amount), ...taxComponents(adjustment),
        schedule: `${type}_WORKING`, gstr1Table: '9B', taxReductionEligible: null, completeReturn: false, source: 'CAPTURED_ADJUSTMENT_DOCUMENT', inPeriod: Boolean(day(pick(adjustment.issuedAt, adjustment.documentDate)) && (!context.startDate || day(pick(adjustment.issuedAt, adjustment.documentDate)) >= context.startDate) && (!context.endDate || day(pick(adjustment.issuedAt, adjustment.documentDate)) <= context.endDate)) });
      issue('STATUTORY_NOTE_ELIGIBILITY_REVIEW', 'WARNING', 'Captured note requires original invoice, statutory deadline and recipient ITC / reduction eligibility review.');
    } else if (['CREDIT_NOTE', 'DEBIT_NOTE'].includes(type)) issue('FORMAL_NOTE_INCOMPLETE', 'WARNING', 'Adjustment lacks a formal note number or issue date; it remains an internal adjustment.');
  }
  if (number(record.coverage?.excludedChildCount) > 0) issue('LINKED_CHILD_SOURCE_MISMATCH', 'ERROR', 'Linked child records with mismatched order / store attribution were excluded; detail coverage is incomplete.');
  const coverageNotes = [...new Set([...array(record.coverage?.notes), ...array(record.coverage?.repositoryPage?.notes), ...(childrenLoaded ? [] : ['DETAIL_NOT_LOADED'])])].filter(note => typeof note === 'string' && /^[A-Z_]{1,100}$/.test(note));
  bill.exceptionCount = exceptions.length;
  bill.readiness = exceptions.some(row => row.severity === 'ERROR') ? 'BLOCKED' : exceptions.length ? 'REVIEW_REQUIRED' : 'WORKING_ONLY';
  return { bill, lines, audit, exceptions, classifications, coverage: { orderId, childrenLoaded, notes: coverageNotes, excludedChildCount: number(record.coverage?.excludedChildCount) ?? 0, repositorySource: text(record.coverage?.repositorySource), lineCount: lines.filter(row => !row.includedInParent).length, addOnCount: lines.filter(row => row.includedInParent).length, paymentDocumentCount: array(record.payments).length, legalSnapshotCaptured: seller.legalSource === 'CAPTURED_SNAPSHOT', invoiceNumberCaptured: Boolean(bill.invoiceNumber), invoiceIssuedAtCaptured: Boolean(bill.invoiceIssuedAtISO), hsnCapturedLines: lines.filter(row => !row.includedInParent && row.hsnSac).length, componentBreakdownCaptured: COMPONENTS.every(key => bill[key] !== null), provisional, completeReturn: false } };
}

/** Incremental reducer: stores group maps, identity/number sets and bounded previews, never source records. */
export function createComplianceAccumulator(context = {}) {
  const financial = ['subtotal', 'discount', 'taxableAmount', 'gstTotal', 'cgst', 'sgst', 'igst', 'cess', 'grandTotal'];
  const taxFields = ['taxableAmount', 'gstTotal', 'cgst', 'sgst', 'igst', 'cess', 'grandTotal'];
  const previewLimit = context.collectDetails === false ? 0 : Math.max(0, Math.min(1000, Number.isInteger(context.previewLimit) ? context.previewLimit : 1000));
  const exceptions = [], audit = [];
  let exceptionCount = 0, errorCount = 0, auditCount = 0, inputCount = 0, committedCount = 0, duplicateCount = 0;
  let selectedCount = 0, unknownPeriodCount = 0;
  const committedOrders = new Set(), committedOnline = new Set(), pending = new Map();
  const pendingOrderKeys = new Map(), pendingOnlineKeys = new Map();
  const entityGroups = new Map(), rateGroups = new Map(), hsnGroups = new Map(), scheduleGroups = new Map(), gstr3bGroups = new Map(), documentGroups = new Map(), numberGroups = new Map();
  const totals = Object.fromEntries(financial.map(field => [field, { sum: 0, missing: 0 }]));
  const collection = Object.fromEntries(['collectedAmount', 'netCollectedAmount', 'creditOutstanding'].map(field => [field, { sum: 0, missing: 0, count: 0 }]));
  const counts = { saleCount: 0, provisionalCount: 0, voidCount: 0, complimentaryCount: 0, complimentaryMenuValue: 0 };
  const coverage = { legalSnapshotCount: 0, invoiceNumberCount: 0, invoiceIssuedAtCount: 0, capturedLineCount: 0, hsnCapturedLineCount: 0, paymentDocumentCount: 0, unknownRateRowCount: 0, detailNotLoadedCount: 0 };
  let finalized;
  const addException = (row, global = false) => {
    exceptionCount += 1; if (row.severity === 'ERROR') errorCount += 1;
    if (exceptions.length < (global ? Math.max(previewLimit, 1000) : previewLimit)) exceptions.push(row);
  };
  const duplicate = bill => {
    duplicateCount += 1;
    addException({ code: 'DUPLICATE_SOURCE_EXCLUDED', severity: 'WARNING', orderId: bill.orderId, storeId: bill.storeId, message: 'Repeated POS identity or explicitly linked online source was excluded from aggregate financial values.' }, true);
  };
  const addValues = (target, row, fields) => {
    for (const field of fields) { if (row[field] === null || row[field] === undefined || !Number.isFinite(row[field])) target[field].missing += 1; else target[field].sum += row[field]; }
  };
  const addGroup = (groups, key, row, dimensions, fields) => {
    if (!groups.has(key)) groups.set(key, { ...Object.fromEntries(dimensions.map(field => [field, row[field] ?? null])), rowCount: 0, orders: new Set(), values: Object.fromEntries(fields.map(field => [field, { sum: 0, missing: 0 }])) });
    const group = groups.get(key); group.rowCount += 1; group.orders.add(row.orderId || `UNKNOWN:${inputCount}`); addValues(group.values, row, fields);
    return group;
  };
  const finishGroups = groups => [...groups.values()].map(({ orders, values, ...row }) => ({ ...row, documentCount: orders.size, ...Object.fromEntries(Object.entries(values).map(([field, value]) => [field, value.missing ? null : amount(value.sum)])), missingValueCount: Object.values(values).reduce((sum, value) => sum + value.missing, 0) }));
  const ingest = record => {
    const bill = record.bill, cov = record.coverage;
    if (!bill.periodDate) unknownPeriodCount += 1;
    for (const row of record.classifications || []) {
      if (!row.inPeriod || ['PROVISIONAL_EXCLUDED', 'NON_SALE_REVIEW', 'INTERNAL_VOID_REVIEW'].includes(row.schedule)) continue;
      addGroup(scheduleGroups, `${row.entityId}|${row.schedule}|${row.gstr1Table ?? ''}|${row.taxRate ?? ''}|${row.placeOfSupplyStateCode ?? ''}`, row, ['entityId', 'schedule', 'gstr1Table', 'taxRate', 'placeOfSupplyStateCode'], taxFields);
      if (row.source === 'CAPTURED_ADJUSTMENT_DOCUMENT') {
        const note = { ...row, orderId: `${row.orderId}:NOTE:${row.documentId || row.documentNumber}` };
        const docGroup = addGroup(documentGroups, `${row.entityId}|${row.documentType}`, note, ['entityId', 'documentType'], []);
        docGroup.cancelledCount ||= 0;
      }
      if (!['CREDIT_NOTE', 'DEBIT_NOTE'].includes(row.documentType)) {
        addGroup(rateGroups, `${row.entityId}|${row.taxRate ?? 'UNKNOWN'}`, row, ['entityId', 'taxRate'], taxFields);
        addGroup(hsnGroups, `${row.entityId}|${row.hsnSac ?? 'UNKNOWN'}|${row.taxRate ?? 'UNKNOWN'}|${row.buyerRegistration}`, row, ['entityId', 'hsnSac', 'taxRate', 'buyerRegistration'], taxFields);
        if (row.taxRate === null) coverage.unknownRateRowCount += 1;
        const tableSection = { TAXABLE: '3.1(a)', ZERO_RATED: '3.1(b)', NIL_RATED: '3.1(c)', EXEMPT: '3.1(c)', NON_GST: '3.1(e)' }[row.supplyClassification] || 'UNALLOCATED';
        const classified = { ...row, tableSection };
        addGroup(gstr3bGroups, `${row.entityId}|${row.supplyClassification}|${row.supplierRegistered}|${row.legalSource}`, classified, ['entityId', 'supplyClassification', 'tableSection', 'supplierRegistered', 'legalSource'], taxFields);
      }
    }
    if (!bill.inPeriod) return;
    selectedCount += 1;
    if (bill.provisional) counts.provisionalCount += 1;
    if (bill.documentType === 'INTERNAL_VOID') counts.voidCount += 1;
    if (bill.complimentary) { counts.complimentaryCount += 1; counts.complimentaryMenuValue += bill.menuValue ?? bill.subtotal ?? 0; }
    for (const field of ['collectedAmount', 'netCollectedAmount', 'creditOutstanding']) {
      if (field === 'creditOutstanding' && bill.documentType === 'INTERNAL_VOID') continue;
      collection[field].count += 1;
      if (bill[field] === null || bill[field] === undefined) collection[field].missing += 1; else collection[field].sum += bill[field];
    }
    coverage.legalSnapshotCount += Number(cov?.legalSnapshotCaptured === true);
    coverage.invoiceNumberCount += Number(cov?.invoiceNumberCaptured === true);
    coverage.invoiceIssuedAtCount += Number(cov?.invoiceIssuedAtCaptured === true);
    coverage.capturedLineCount += cov?.lineCount ?? 0;
    coverage.hsnCapturedLineCount += cov?.hsnCapturedLines ?? 0;
    coverage.paymentDocumentCount += cov?.paymentDocumentCount ?? 0;
    coverage.detailNotLoadedCount += Number(cov?.childrenLoaded === false);
    const documentGroup = addGroup(documentGroups, `${bill.entityId}|${bill.documentType}`, bill, ['entityId', 'documentType'], []);
    documentGroup.cancelledCount = (documentGroup.cancelledCount || 0) + Number(['VOIDED', 'CANCELLED'].includes(bill.status));
    if (bill.eligibleSale) {
      counts.saleCount += 1; addValues(totals, bill, financial);
      addGroup(entityGroups, bill.entityId, bill, ['entityId', 'legalName', 'gstin', 'registered', 'entitySource'], financial);
    }
    const match = bill.invoiceNumber && /^(.*?)(\d+)$/.exec(bill.invoiceNumber);
    if (match && Number.isSafeInteger(Number(match[2]))) {
      const fy = fiscalYearForDate(bill.invoiceIssuedAtISO) || bill.fy;
      const key = `${bill.entityId}|${fy}|${bill.documentType}|${match[1]}`;
      if (!numberGroups.has(key)) numberGroups.set(key, { entityId: bill.entityId, fy, documentType: bill.documentType, prefix: match[1], numbers: new Set(), count: 0 });
      const group = numberGroups.get(key);
      if (group.numbers.has(Number(match[2]))) addException({ code: 'DUPLICATE_DOCUMENT_NUMBER', severity: 'ERROR', orderId: bill.orderId, storeId: bill.storeId, message: 'The same captured invoice number occurs in the observed entity / financial year / document series.' }, true);
      group.numbers.add(Number(match[2])); group.count += 1;
    }
  };
  const removePending = key => {
    const prior = pending.get(key);
    if (!prior) return;
    pending.delete(key);
    if (prior.bill.orderId) pendingOrderKeys.delete(prior.bill.orderId);
    if (prior.bill.onlineOrderId) pendingOnlineKeys.delete(prior.bill.onlineOrderId);
    duplicate(prior.bill);
  };
  return {
    add(input) {
      if (finalized) throw new Error('Compliance accumulator is already finalized.');
      const record = input?.bill ? input : normalizeBill(input, context);
      const bill = record.bill; inputCount += 1;
      for (const row of record.exceptions || []) addException(row);
      for (const row of record.audit || []) { auditCount += 1; if (audit.length < previewLimit) audit.push(row); }
      if (bill.orderId && committedOrders.has(bill.orderId) || bill.onlineOrderId && committedOnline.has(bill.onlineOrderId)) { duplicate(bill); return this; }
      if (bill.provisional) {
        if (bill.orderId && pendingOrderKeys.has(bill.orderId) || bill.onlineOrderId && pendingOnlineKeys.has(bill.onlineOrderId)) { duplicate(bill); return this; }
        const key = `PENDING:${inputCount}`;
        // Provisional financials never enter sale groups. Retain only their flat bill/coverage until link precedence is known.
        pending.set(key, { bill, coverage: record.coverage, classifications: [] });
        if (bill.orderId) pendingOrderKeys.set(bill.orderId, key);
        if (bill.onlineOrderId) pendingOnlineKeys.set(bill.onlineOrderId, key);
        return this;
      }
      if (bill.orderId && pendingOrderKeys.has(bill.orderId)) removePending(pendingOrderKeys.get(bill.orderId));
      if (bill.onlineOrderId && pendingOnlineKeys.has(bill.onlineOrderId)) removePending(pendingOnlineKeys.get(bill.onlineOrderId));
      if (bill.orderId) committedOrders.add(bill.orderId);
      if (bill.onlineOrderId) committedOnline.add(bill.onlineOrderId);
      committedCount += 1; ingest(record); return this;
    },
    finish() {
      if (finalized) return finalized;
      for (const record of pending.values()) ingest(record);
      const turnover = context.precedingFyTurnoverBand || 'UNKNOWN';
      const hsnSummaries = finishGroups(hsnGroups).map(row => {
        const digits = turnover === 'UP_TO_5CR' ? 4 : turnover === 'OVER_5CR' ? 6 : null;
        return { ...row, precedingFyTurnoverBand: turnover, requiredDigitsWorkingRule: digits, classificationStatus: !row.hsnSac ? 'UNKNOWN' : digits === null ? 'TURNOVER_REVIEW' : /^\d+$/.test(row.hsnSac) && row.hsnSac.length >= digits ? 'RECORDED_FORMAT_CHECK_ONLY' : 'FORMAT_REVIEW', b2cSubmissionRequirement: row.buyerRegistration === 'B2C' ? 'REVIEW_CURRENT_PORTAL_PHASE_NO_UNIVERSAL_HARD_BLOCK' : null, completeReturn: false };
      });
      const numberingGaps = [...numberGroups.values()].map(({ numbers, count, ...row }) => {
        const values = [...numbers].sort((a, b) => a - b), gaps = [];
        for (let index = 1; index < values.length; index += 1) if (values[index] > values[index - 1] + 1) gaps.push({ from: values[index - 1] + 1, to: values[index] - 1 });
        return { ...row, firstObserved: values[0], lastObserved: values.at(-1), duplicateCount: count - numbers.size, observedGaps: gaps, scope: 'OBSERVED_RECORDS_ONLY', completeSeriesVerified: false };
      });
      const finalTotals = { ...Object.fromEntries(financial.map(field => [field, totals[field].missing ? null : amount(totals[field].sum)])), billCount: selectedCount, ...counts, complimentaryMenuValue: amount(counts.complimentaryMenuValue), ...Object.fromEntries(Object.entries(collection).map(([field, value]) => [field, value.missing ? null : amount(value.sum)])), exceptionCount, errorCount, completeReturn: false };
      finalized = { totals: finalTotals, entitySummaries: finishGroups(entityGroups), rateSummaries: finishGroups(rateGroups), hsnSummaries,
        gstr3bSummaries: finishGroups(gstr3bGroups).map(row => ({ ...row, gstr3bTable: row.tableSection, supplierRegistration: row.supplierRegistered === true ? 'REGISTERED' : row.supplierRegistered === false ? 'UNREGISTERED' : 'UNKNOWN', evidenceStatus: row.legalSource === 'CAPTURED_SNAPSHOT' && row.tableSection !== 'UNALLOCATED' ? 'CAPTURED_CLASSIFICATION_REQUIRES_REVIEW' : 'UNVERIFIED_OR_UNALLOCATED', taxAdjustmentPolicy: 'STATUTORY_NOTES_SEPARATE_REVIEW_NOT_NETTED', status: 'WORKING_PAPER_REQUIRES_REVIEW', itcIncluded: false, rcmIncluded: false, ecommerceLiabilityIncluded: false, completeReturn: false })),
        gstr1Schedules: finishGroups(scheduleGroups).map(row => ({ ...row, status: 'WORKING_PAPER_REQUIRES_REVIEW', completeReturn: false })),
        documentCounts: finishGroups(documentGroups).map(row => ({ ...row, table13Ready: false })), numberingGaps, exceptions, audit,
        coverage: { ...coverage, inputRecordCount: inputCount, distinctRecordCount: committedCount + pending.size, duplicateSourcesExcluded: duplicateCount, selectedRecordCount: selectedCount, periodDateUnknownCount: unknownPeriodCount,
          periodBasis: context.periodBasis === 'invoiceIssuedAt' ? 'invoiceIssuedAt' : 'createdAt', precedingFyTurnoverBand: turnover,
          exceptionCount, auditCount, exceptionPreviewCount: exceptions.length, auditPreviewCount: audit.length,
          exceptionsOmittedCount: exceptionCount - exceptions.length, auditOmittedCount: auditCount - audit.length, previewTruncated: exceptionCount > exceptions.length || auditCount > audit.length,
          completeness: 'PARTIAL_WORKING_PAPERS', completeReturn: false }, completeReturn: false };
      pending.clear(); pendingOrderKeys.clear(); pendingOnlineKeys.clear();
      return finalized;
    },
  };
}

export function aggregateCompliance(records = [], context = {}) {
  const accumulator = createComplianceAccumulator(context);
  for (const record of array(records)) accumulator.add(record);
  return accumulator.finish();
}
