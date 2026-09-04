import type { CanonicalCompositeComponent } from './types/menu-management';

export type Role = "ADMIN" | "STORE_MANAGER" | "CASHIER" | "BARISTA" | "KITCHEN" | "TRAINEE" | "FRANCHISE_VIEWER";

export type AuthStatus = 
  | "checking-auth"
  | "signed-out"
  | "checking-profile"
  | "missing-profile"
  | "inactive"
  | "ready"
  | "permission-error";

export interface StaffProfile {
  uid: string;
  name: string;
  displayName: string;
  email: string;
  role: Role;
  isActive: boolean;
  storeIds: string[];
  assignedStoreIds: string[];
  username?: string;
  usernameNormalized?: string;
  userCategory?: string;
  permissions?: {
    viewDailySales?: boolean;
    exportSales?: boolean;
  };
  mustChangePassword?: boolean;
  createdAt: any; // Firestore Timestamp
  updatedAt: any; // Firestore Timestamp
}

export interface CustomerStorePresentation {
  conceptName?: string;
  locationLabel?: string;
  tagline?: string;
  orderContextLabel?: string;
  orderActionLabel?: string;
  searchPlaceholder?: string;
  searchPromptTitle?: string;
  searchPromptDescription?: string;
  featuredLabel?: string;
  fullMenuLabel?: string;
  selectorEyebrow?: string;
  selectorDescription?: string;
}

export interface Store {
  id: string;
  name: string;
  displayName?: string;
  code: string;
  storeCode?: string;
  address: string;
  city?: string;
  state?: string;
  pinCode?: string;
  phone?: string;
  email?: string;
  status?: "DRAFT" | "ACTIVE" | "INACTIVE" | "ARCHIVED";
  onboardingMode?: "PROVISIONED" | "LEGACY_MIGRATED";
  isActive: boolean;
  posEnabled?: boolean;
  internalPosTestEnabled?: boolean;
  setupTestMode?: boolean;
  posTestCompleted?: boolean;
  openingStockConfirmed?: boolean;
  posLaunchException?: {
    enabled?: boolean;
    scope?: "STAFF_POS_ONLY" | string;
    reason?: string;
    approvedBy?: string;
    approvedByName?: string;
    approvedAt?: any;
    expiresAt?: any;
    maxHours?: number;
    openingStockRequired?: boolean;
    customerOrderingDisabled?: boolean;
    auditId?: string;
    message?: string;
    disabledAt?: any;
    disabledBy?: string;
    disabledReason?: string;
  };
  inventoryMode?: "FINISHED_GOODS";
  inventoryStoreId?: string;
  latitude?: number;
  longitude?: number;
  lat?: number;
  lng?: number;
  inventoryPolicy?: "STRICT" | "ALLOW_NEGATIVE" | "ALLOW_NEGATIVE_DEFER_BOM";
  onlineOrderingEnabled?: boolean;
  customerOrderingEnabled?: boolean;
  publicOrderingEnabled?: boolean;
  acceptingOrders?: boolean;
  isAcceptingOrders?: boolean;
  onlineOrderingPaused?: boolean;
  excludeFromNearestSelection?: boolean;
  customerPresentation?: CustomerStorePresentation;
  estimatedPrepMinutes?: number;
  onlineOrderingMessage?: string;
  legalEntityName?: string;
  legalName?: string;
  tradeName?: string;
  legalAddress?: string;
  gstin?: string;
  stateName?: string;
  stateCode?: string;
  gstRegistered?: boolean;
  gstRate?: number;
  receiptName?: string;
  receiptFooter?: string;
  timezone?: string;
  provisioningJobId?: string;
  sourceTemplateStoreId?: string | null;
  readiness?: Record<string, boolean>;
  createdAt: any;
  updatedAt: any;
}

export interface Category {
  id: string;
  name: string;
  code: string;
  sortOrder: number;
  isActive: boolean;
  defaultPrepStation?: PrepStation; // added this
  createdAt: any;
  updatedAt: any;
}

export type PrepStation = "BARISTA" | "KITCHEN" | "BOTH" | "NONE";

export type OrderType = "DINE_IN" | "TAKEAWAY" | "DELIVERY";

export type PaymentMethod = "CASH" | "UPI" | "CARD" | "SWIGGY" | "ZOMATO" | "CREDIT" | "COMPLIMENTARY" | "PAY_AT_COUNTER" | "ONLINE" | "RAZORPAY";
export type PaymentProvider = "PAY_AT_COUNTER" | "RAZORPAY";
export type PaymentStatus =
  | "PAID"
  | "UNPAID"
  | "PARTIAL"
  | "NOT_REQUIRED"
  | "NOT_STARTED"
  | "AWAITING_PAYMENT"
  | "PAYMENT_PROCESSING"
  | "FAILED"
  | "REFUND_PENDING"
  | "REFUNDED"
  | "REFUND_FAILED"
  | "PAYMENT_REVIEW_REQUIRED";
export type CommercialStatus = "SALE" | "COMPLIMENTARY";

export interface ReceiptLegalDetails {
  legalName: string | null;
  tradeName: string | null;
  legalAddress: string | null;
  gstin: string | null;
  stateName: string | null;
  stateCode: string | null;
  gstRegistered: boolean;
}

export type AddOnInventoryItemType = "RAW_INGREDIENT" | "PREP_ITEM" | "PACKAGING";
export type AddOnInventoryTrackingStatus = "CONFIGURED" | "NOT_CONFIGURED";

export interface AddOnSelection {
  groupId: string;
  groupName: string;
  optionId: string;
  optionName: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  taxRate: number;
  inventoryTrackingStatus: AddOnInventoryTrackingStatus;
  inventoryItemType?: AddOnInventoryItemType;
  inventoryItemCode?: string;
  consumptionQuantity?: number;
  consumptionUnit?: string;
}

export interface CartItem {
  id: string; // generate unique ID for cart row, or use menu item ID if grouping
  menuItemId: string;
  menuItemCode: string;
  name: string;
  price: number;
  taxRate: number;
  prepStation: PrepStation;
  quantity: number;
  sourceSystem?: "FINISHED_GOODS" | "LEGACY_MENU_ITEMS";
  itemType?: "NO_STOCK" | "MADE_TO_ORDER" | "DIRECT_STOCK" | string;
  finishedGoodCode?: string;
  bom?: any[];
  addOns?: AddOnSelection[];
  baseUnitPrice?: number;
  addOnTotal?: number;
  unitPriceWithAddOns?: number;
}

export interface Customer {
  id?: string;
  name: string;
  phone: string;
  email?: string;
  visitCount: number;
  totalSpend: number;
  lastVisitAt: any;
  createdAt: any;
  updatedAt: any;
}

export interface Order {
  id?: string;
  orderNumber: string;
  storeId: string;
  storeCode: string;
  storeName: string;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  createdByUserId: string;
  createdByName: string;
  orderType: OrderType;
  status: "COMPLETED" | "CANCELLED" | "VOIDED";
  paymentStatus: PaymentStatus;
  paymentProvider?: PaymentProvider;
  providerMethod?: "UPI" | "CARD" | "NETBANKING" | "WALLET" | "OTHER";
  commercialStatus?: CommercialStatus;
  isSetupTest?: boolean;
  setupTestMode?: boolean;
  setupTestLabel?: string | null;
  setupTestStoreStatus?: string | null;
  menuValue?: number;
  complimentaryDiscount?: number;
  complimentaryReason?: string;
  complimentaryAuthorizationId?: string;
  addOnAuthorizationId?: string;
  addOnTotal?: number;
  complimentaryOtpVerified?: boolean;
  complimentaryVerifiedPhone?: string;
  complimentaryOtpProvider?: string;
  complimentaryVerifiedAt?: any;
  complimentaryAuthorisedByUid?: string;
  complimentaryAuthorisedByName?: string;
  complimentaryAuthorisedAt?: any;
  receiptLegalDetails?: ReceiptLegalDetails;
  tableNumber: string | null;
  subtotal: number;
  taxTotal: number;
  gstTotal?: number;
  taxableAmount?: number;
  discountPercent?: number;
  discountAmount?: number;
  discountTotal: number;
  discount?: number;
  grandTotal: number;
  cogsTotal?: number;
  inventoryWarningCount?: number;
  inventoryWarnings?: string[];
  inventoryConsumptionStatus?: "APPLIED" | "PENDING_BOM" | "PARTIAL_PENDING_BOM" | "NOT_REQUIRED";
  stockMovementCount?: number;
  clientCheckoutIdempotencyKey?: string;
  checkoutPayloadHash?: string;
  checkoutIdempotencyVersion?: number;
  paymentMethod: PaymentMethod;
  paymentMethodLabel?: string;
  isSplitPayment?: boolean;
  paymentBreakdown?: {
    method: PaymentMethod;
    amount: number;
    provider?: "RAZORPAY";
    providerMethod?: "UPI" | "CARD" | "NETBANKING" | "WALLET" | "OTHER";
  }[];
  paymentReversalStatus?: "NOT_REQUIRED" | "REFUNDED" | "REVERSED" | "REFUND_PENDING" | "MANUAL_REFUND_REQUIRED";
  paymentReversalBreakdown?: {
    method: PaymentMethod | string;
    originalAmount: number;
    amount: number;
    reversalStatus: "NOT_REQUIRED" | "REFUNDED" | "REVERSED" | "REFUND_PENDING" | "MANUAL_REFUND_REQUIRED";
    reason: string;
  }[];
  paymentReversalTotal?: number;
  refundedAmount?: number;
  reversedAmount?: number;
  refundPendingAmount?: number;
  manualRefundRequiredAmount?: number;
  netCollectionAmount?: number;
  voidReason?: string | null;
  voidedBy?: string | null;
  voidedByName?: string | null;
  voidedByEmail?: string | null;
  voidedAt?: any;
  razorpaySessionId?: string;
  providerPaymentId?: string;
  providerOrderId?: string;
  refundStatus?: "REFUND_PENDING" | "REFUNDED" | "REFUND_FAILED";
  refundRequestId?: string;
  providerRefundId?: string;
  createdAt: any;
  updatedAt: any;
}

export interface OrderItem {
  id?: string;
  menuItemId: string;
  itemName: string;
  itemCode: string;
  categoryId: string;
  categoryName: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  lineSubtotal: number;
  lineDiscount?: number;
  lineTaxable?: number;
  lineTax: number;
  lineTotal: number;
  cogsAmount?: number;
  inventoryConsumptionStatus?: "APPLIED" | "PENDING_BOM" | "NOT_REQUIRED";
  prepStation: PrepStation;
  status: "PENDING" | "PREPARING" | "READY" | "SERVED" | "CANCELLED";
  createdAt: any;
  sourceSystem?: "FINISHED_GOODS" | "LEGACY_MENU_ITEMS";
  finishedGoodCode?: string;
  itemType?: "NO_STOCK" | "MADE_TO_ORDER" | "DIRECT_STOCK" | string;
  addOns?: AddOnSelection[];
  addOnAuthorizationId?: string;
  baseUnitPrice?: number;
  addOnTotal?: number;
  unitPriceWithAddOns?: number;
  components?: CanonicalCompositeComponent[];
}

export type KotStatus = "PENDING" | "PREPARING" | "READY" | "SERVED" | "RETURNED" | "WASTAGE_RECORDED" | "REMAKE_REQUESTED" | "CANCELLED";

export interface KotItem {
  id?: string;
  orderId: string;
  orderNumber: string;
  orderItemId: string;
  storeId: string;
  storeCode: string; // might be duplicated slightly depending on implementation, keep it going
  storeName: string;
  station: "BARISTA" | "KITCHEN";
  itemName: string;
  itemCode: string;
  quantity: number;
  orderType: OrderType;
  tableNumber: string | null;
  customerName: string | null;
  onlineOrderId?: string | null;
  onlineOrderTrackingToken?: string | null;
  onlineOrderReference?: string | null;
  status: KotStatus;
  readyAt?: any;
  servedAt?: any;
  returnedAt?: any;
  wastageAt?: any;
  remakeRequestedAt?: any;
  returnReason?: string | null;
  wastageReason?: string | null;
  remakeReason?: string | null;
  originalKotItemId?: string | null;
  remakeOfKotItemId?: string | null;
  remakeCount?: number;
  handledByUserId?: string | null;
  handledByName?: string | null;
  createdAt: any;
  updatedAt: any;
  createdByUserId: string;
  createdByName: string;
  addOns?: AddOnSelection[];
  component?: CanonicalCompositeComponent;
}

export interface OrderPayment {
  id?: string;
  method: PaymentMethod;
  amount: number;
  reference: string | null;
  paymentIndex?: number;
  provider?: "RAZORPAY";
  providerMethod?: "UPI" | "CARD" | "NETBANKING" | "WALLET" | "OTHER";
  providerPaymentId?: string;
  providerOrderId?: string;
  status?: "PAID" | "CAPTURED" | "REFUND_PENDING" | "REFUNDED" | "REFUND_FAILED";
  razorpayPaymentId?: string;
  razorpayOrderId?: string;
  paymentLinkId?: string | null;
  qrCodeId?: string | null;
  currency?: "INR";
  capturedAt?: any;
  verifiedServerSide?: boolean;
  storeId?: string;
  orderId?: string;
  checkoutIdempotencyKey?: string;
  refundStatus?: "REFUND_PENDING" | "REFUNDED" | "REFUND_FAILED";
  refundRequestId?: string;
  providerRefundId?: string;
  settledAt?: any;
  settledBy?: string;
  settledByName?: string;
  createdAt: any;
}

export type OnlineOrderType = "PICKUP" | "DINE_IN";
export type OnlineOrderStatus =
  | "PENDING"
  | "ACCEPTED"
  | "ACCEPTED_AWAITING_PAYMENT"
  | "PAYMENT_PROCESSING"
  | "PAID_PENDING_ACCEPTANCE"
  | "CONVERTED"
  | "REJECTED"
  | "NEEDS_ATTENTION"
  | "REFUND_PENDING"
  | "REFUNDED"
  | "REFUND_FAILED"
  | "CANCELLED_REFUNDED"
  | "PAYMENT_REVIEW_REQUIRED";
export type PublicOrderStatus = OnlineOrderStatus | "PREPARING" | "READY" | "SERVED" | "CANCELLED";

export interface OnlineOrderItem {
  finishedGoodCode: string;
  itemName: string;
  categoryId: string;
  categoryName: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  lineSubtotal: number;
  lineTaxable: number;
  lineTax: number;
  lineTotal: number;
  prepStation: PrepStation;
  itemType?: string;
  addOns?: AddOnSelection[];
  baseUnitPrice?: number;
  addOnTotal?: number;
  unitPriceWithAddOns?: number;
  components?: CanonicalCompositeComponent[];
}

export interface OnlineOrder {
  id?: string;
  storeId: string;
  storeName: string;
  customerName: string;
  customerPhone: string;
  orderType: OnlineOrderType;
  tableNumber?: string | null;
  notes: string;
  items: OnlineOrderItem[];
  subtotal: number;
  taxableAmount: number;
  gstTotal: number;
  grandTotal: number;
  status: OnlineOrderStatus;
  source: "CUSTOMER_WEB";
  paymentProvider?: PaymentProvider;
  paymentMethod?: PaymentMethod;
  paymentStatus?: PaymentStatus;
  paymentIntentId?: string | null;
  paymentExpiresAt?: any;
  plannedOrderId?: string | null;
  addOnAuthorizationId?: string | null;
  acceptedBy?: string | null;
  acceptedByName?: string | null;
  acceptedAt?: any;
  providerPaymentId?: string | null;
  providerOrderId?: string | null;
  providerMethod?: "UPI" | "CARD" | "NETBANKING" | "WALLET" | "OTHER";
  customerUid?: string;
  verifiedPhone?: string;
  checkoutSessionId?: string;
  paymentCapturedAt?: any;
  refundStatus?: "REFUND_PENDING" | "REFUNDED" | "REFUND_FAILED";
  refundReason?: string;
  paymentReviewCode?: string | null;
  trackingToken?: string | null;
  publicOrderReference?: string | null;
  linkedOrderId?: string | null;
  linkedOrderNumber?: string | null;
  customerStatusMessage?: string | null;
  convertedBy?: string | null;
  convertedByName?: string | null;
  convertedAt?: any;
  rejectedBy?: string | null;
  rejectedByName?: string | null;
  rejectedAt?: any;
  rejectReason?: string | null;
  attentionReason?: string | null;
  createdAt: any;
  updatedAt: any;
}

export interface PublicOrderTrackingItem {
  itemName: string;
  quantity: number;
  lineTotal: number;
  addOns?: Array<{
    groupName: string;
    optionName: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
  }>;
}

export interface PublicOrderTracking {
  id?: string;
  trackingToken: string;
  publicOrderReference: string;
  storeName: string;
  orderType: OnlineOrderType;
  tableNumber?: string | null;
  items: PublicOrderTrackingItem[];
  subtotal: number;
  gstTotal: number;
  total: number;
  publicStatus: PublicOrderStatus;
  paymentProvider?: PaymentProvider;
  paymentStatus?: PaymentStatus;
  paymentAvailableUntil?: any;
  submittedAt: any;
  acceptedAt?: any;
  readyAt?: any;
  servedAt?: any;
  publicOrderNumber?: string | null;
  customerStatusMessage: string;
}

export type DayClosingStatus = "CLOSED";

export interface DayClosing {
  id?: string;
  storeId: string;
  storeName: string;
  businessDate: string;
  completedBillCount: number;
  voidedBillCount: number;
  grossSales: number;
  voidedSales: number;
  netSales: number;
  gstTotal: number;
  discountTotal: number;
  paymentBreakdown: Record<PaymentMethod, number>;
  expectedCash: number;
  grossPaymentsReceived?: number;
  voidedPaymentTotal?: number;
  refundedOrReversedPayments?: number;
  refundPendingPayments?: number;
  manualRefundRequiredPayments?: number;
  netCollections?: number;
  actualCash: number;
  cashVariance: number;
  notes: string;
  closedBy: string;
  closedByName: string;
  closedByEmail?: string | null;
  closedAt: any;
  status: DayClosingStatus;
}

export interface Counter {
  storeCode: string;
  dateKey: string;
  lastSequence: number;
  updatedAt: any;
}

export interface MenuItem {
  id: string;
  name: string;
  code: string;
  categoryId: string;
  categoryCode: string;
  categoryName: string;
  category?: string | { code?: string; id?: string; name?: string } | null;
  categorySortOrder?: number | null;
  posCategoryCode?: string | null;
  posCategoryName?: string | null;
  subcategoryId?: string | null;
  subcategoryCode?: string | null;
  subcategory?: string | { code?: string; id?: string; name?: string } | null;
  subcategoryName?: string | null;
  subcategorySortOrder?: number | null;
  posSubcategoryCode?: string | null;
  posSubcategoryName?: string | null;
  sortOrder?: number | null;
  aliases?: string[];
  searchAliases?: string[];
  sku?: string;
  description: string;
  price: number;
  taxRate: number;
  prepStation: PrepStation;
  isActive: boolean;
  availableStoreIds: string[];
  addOnGroupIds?: string[];
  addOnOptionIdsByGroup?: Record<string, string[]>;
  addonGroupIds?: string[];
  createdAt: any;
  updatedAt: any;
}

export interface InventoryItem {
  id?: string;
  name: string;
  code: string;
  unit: "g" | "kg" | "ml" | "l" | "pcs" | "pack";
  category: "COFFEE" | "MILK" | "BAKERY" | "PACKAGING" | "RETAIL" | "OTHER";
  costPerUnit: number;
  isActive: boolean;
  createdAt: any;
  updatedAt: any;
}

export interface StoreInventory {
  id?: string;
  storeId: string;
  storeName: string;
  inventoryItemId: string;
  inventoryItemName: string;
  unit: string;
  openingStock: number;
  currentStock: number;
  minimumStock: number;
  updatedAt: any;
}

export interface RecipeIngredient {
  inventoryItemCode?: string;
  inventoryItemId: string;
  inventoryItemName: string;
  quantity: number;
  unit: string;
}

export interface Recipe {
  id?: string;
  menuItemId: string;
  menuItemName: string;
  recipeItems: RecipeIngredient[];
  isActive: boolean;
  updatedAt: any;
}

export interface StockMovement {
  id?: string;
  storeId: string;
  storeCode?: string;
  storeName: string;
  inventoryStoreId?: string;
  logicalSalesStoreId?: string;
  logicalSalesStoreCode?: string;
  logicalSalesStoreName?: string;
  inventoryItemId: string;
  inventoryItemName: string;
  movementType: "PURCHASE" | "PURCHASE_INWARD" | "SALE_DEDUCTION" | "ORDER_BOM_BACKFILL" | "WASTAGE" | "ADJUSTMENT" | "TRANSFER_IN" | "TRANSFER_OUT" | "OPENING_STOCK" | "STOCK_CORRECTION" | "PRODUCTION_CONSUMPTION" | "PRODUCTION_OUTPUT" | "ORDER_VOID_REVERSAL";
  quantity: number;
  quantityDelta?: number;
  unit: string;
  referenceType: "ORDER" | "MANUAL" | "TRANSFER" | "PREP_PRODUCTION" | "PURCHASE_ENTRY";
  referenceId: string | null;
  orderId?: string;
  orderNumber?: string;
  businessDate?: string;
  notes: string | null;
  createdByUserId: string;
  createdByName: string;
  createdAt: any;
  stockSystem?: string;
  stockItemType?: string;
  stockItemCode?: string;
  previousQty?: number;
  newQty?: number;
  wentNegative?: boolean;
  cogsAmount?: number;
  finishedGoodCode?: string;
  finishedGoodName?: string;
  source?: string;
  orderLineKey?: string;
  purchaseEntryId?: string;
  supplierName?: string;
  invoiceNumber?: string;
  purchaseCostTotal?: number;
  costPerUnitSnapshot?: number;
}
