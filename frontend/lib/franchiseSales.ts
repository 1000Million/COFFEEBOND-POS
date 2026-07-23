export type FranchisePermissions = {
  viewDailySales: boolean;
  exportSales: boolean;
};

export type FranchiseStoreSummary = {
  id: string;
  code: string;
  name: string;
};

export type FranchiseDailyMetrics = {
  grossMenuValue: number;
  discounts: number;
  netSales: number;
  taxableSales: number;
  gstCollected: number;
  totalCollected: number;
  paymentBreakdown: Record<string, number>;
  splitOrderCount: number;
  paidTransactionCount: number;
  averageOrderValue: number;
  complimentaryOrderCount: number;
  complimentaryMenuValue: number;
  complimentaryCogs: number;
  voidOrderCount: number;
  voidedOrderValue: number;
  onlineSales: number;
  posSales: number;
  grossPaymentsReceived: number;
  voidedPaymentTotal: number;
  netCollections: number;
};

export type FranchiseOrderSummary = {
  orderNumber: string;
  storeId: string;
  storeName: string;
  createdAt: string | null;
  orderType: string;
  source: 'POS' | 'CUSTOMER_WEB';
  status: 'COMPLETED' | 'VOIDED' | 'CANCELLED';
  paymentStatus: string;
  paymentMethods: string[];
  customerPhoneMasked: string | null;
  grossMenuValue: number;
  discount: number;
  taxableAmount: number;
  gst: number;
  total: number;
  complimentary: boolean;
  items: Array<{
    name: string;
    quantity: number;
    categoryName: string;
  }>;
};

export type FranchiseDailySalesResponse = {
  date: string;
  timeZone: string;
  generatedAt: string;
  stores: FranchiseStoreSummary[];
  permissions: FranchisePermissions;
  metrics: FranchiseDailyMetrics;
  hourlySales: Array<{ hour: number; orderCount: number; netSales: number }>;
  categorySales: Array<{ categoryName: string; quantity: number; netSales: number; gst: number }>;
  orders: FranchiseOrderSummary[];
};

const csvCell = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;

export function buildFranchiseSalesCsv(report: FranchiseDailySalesResponse): string {
  const headers = [
    'Business Date',
    'Store',
    'Order Number',
    'Time',
    'Order Type',
    'Source',
    'Status',
    'Payment Method',
    'Payment Outcome',
    'Customer Mobile',
    'Menu Value',
    'Discount',
    'Taxable Amount',
    'GST',
    'Total',
  ];
  const rows = report.orders.map((order) => [
    report.date,
    order.storeName,
    order.orderNumber,
    order.createdAt || '',
    order.orderType,
    order.source,
    order.status,
    order.paymentMethods.join(' + '),
    order.paymentStatus,
    order.customerPhoneMasked || '',
    order.grossMenuValue.toFixed(2),
    order.discount.toFixed(2),
    order.taxableAmount.toFixed(2),
    order.gst.toFixed(2),
    order.total.toFixed(2),
  ]);
  return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}

export function downloadFranchiseSalesCsv(report: FranchiseDailySalesResponse): void {
  const csv = buildFranchiseSalesCsv(report);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `coffee-bond-franchise-sales-${report.date}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
