export type Role = "ADMIN" | "STORE_MANAGER" | "CASHIER" | "BARISTA" | "KITCHEN" | "TRAINEE";

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
  createdAt: any; // Firestore Timestamp
  updatedAt: any; // Firestore Timestamp
}

export interface Store {
  id: string;
  name: string;
  code: string;
  address: string;
  isActive: boolean;
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

export type PaymentMethod = "CASH" | "UPI" | "CARD" | "SWIGGY" | "ZOMATO" | "CREDIT" | "COMPLIMENTARY";

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
  status: "COMPLETED" | "CANCELLED";
  paymentStatus: "PAID" | "UNPAID" | "PARTIAL";
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
  paymentMethod: PaymentMethod;
  paymentMethodLabel?: string;
  isSplitPayment?: boolean;
  paymentBreakdown?: { method: PaymentMethod; amount: number }[];
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
  prepStation: PrepStation;
  status: "PENDING" | "PREPARING" | "READY" | "SERVED" | "CANCELLED";
  createdAt: any;
  sourceSystem?: "FINISHED_GOODS" | "LEGACY_MENU_ITEMS";
  finishedGoodCode?: string;
  itemType?: "NO_STOCK" | "MADE_TO_ORDER" | "DIRECT_STOCK" | string;
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
}

export interface OrderPayment {
  id?: string;
  method: PaymentMethod;
  amount: number;
  reference: string | null;
  paymentIndex?: number;
  createdAt: any;
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
  description: string;
  price: number;
  taxRate: number;
  prepStation: PrepStation;
  isActive: boolean;
  availableStoreIds: string[];
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
  storeName: string;
  inventoryItemId: string;
  inventoryItemName: string;
  movementType: "PURCHASE" | "SALE_DEDUCTION" | "WASTAGE" | "ADJUSTMENT" | "TRANSFER_IN" | "TRANSFER_OUT" | "OPENING_STOCK" | "PRODUCTION_CONSUMPTION" | "PRODUCTION_OUTPUT";
  quantity: number;
  unit: string;
  referenceType: "ORDER" | "MANUAL" | "TRANSFER" | "PREP_PRODUCTION";
  referenceId: string | null;
  notes: string | null;
  createdByUserId: string;
  createdByName: string;
  createdAt: any;
  stockSystem?: string;
  stockItemType?: string;
  stockItemCode?: string;
}
