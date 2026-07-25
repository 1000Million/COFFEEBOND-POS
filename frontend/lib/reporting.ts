import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';

export type ReportRole = 'ADMIN' | 'STORE_MANAGER' | 'CASHIER';
export type ReportAvailability = 'AVAILABLE' | 'CONDITIONAL' | 'DATA_CAPTURE_REQUIRED';

export type ReportDefinition = {
  reportId: string;
  title: string;
  description: string;
  group: string;
  allowedRoles: ReportRole[];
  supportsStoreComparison: boolean;
  supportsExport: boolean;
  supportsPrint: boolean;
  requiredFields: string[];
  availabilityStatus: ReportAvailability;
  unavailableReason: string | null;
  detailReport: boolean;
};

export type ReportColumn = {
  key: string;
  label: string;
  type: 'text' | 'number' | 'money';
};

export type ReportingSummary = {
  grossMenuValue: number;
  discounts: number;
  taxableSales: number;
  gstCollected: number;
  netSales: number;
  totalCollected: number;
  orderCount: number;
  paidTransactionCount: number;
  averageOrderValue: number;
  complimentaryOrderCount: number;
  complimentaryMenuValue: number;
  complimentaryCogs: number;
  voidOrderCount: number;
  voidedOrderValue: number;
  unpaidOrderCount: number;
  unpaidAmount: number;
  grossPaymentsReceived: number;
  voidedPaymentTotal: number;
  refundedOrReversedPayments: number;
  refundPendingPayments: number;
  manualRefundRequiredPayments: number;
  refundsPending: number;
  netCollections: number;
  paymentBreakdown: Record<string, number>;
};

export type ReportingFilterOptions = {
  sources: string[];
  orderTypes: string[];
  paymentMethods: string[];
  staff: string[];
  categories: string[];
  items: Array<{ code: string; name: string }>;
};

export type ReportingRequest = {
  reportId: string;
  storeIds: string[];
  startDate: string;
  endDate: string;
  page?: number;
  pageSize?: number;
  filters?: {
    source?: string;
    orderType?: string;
    paymentMethod?: string;
    staffName?: string;
    category?: string;
    itemCode?: string;
    orderStatus?: string;
    commercialStatus?: string;
  };
};

export type ReportingResponse = {
  report: ReportDefinition;
  summary: ReportingSummary;
  availabilityStatus: ReportAvailability;
  unavailableReason: string | null;
  columns: ReportColumn[];
  rows: Array<Record<string, unknown>>;
  accessibleStores: Array<{ id: string; code: string; name: string }>;
  selectedStoreIds: string[];
  startDate: string;
  endDate: string;
  timeZone: string;
  filters: NonNullable<ReportingRequest['filters']> & { storeIds: string[] };
  filterOptions: ReportingFilterOptions;
  sourceOrderCount: number;
  generatedAt: string;
  pagination: {
    page: number;
    pageSize: number;
    totalRows: number;
    totalPages: number;
    hasNextPage: boolean;
  };
  totalRows?: number;
};

const getReportingRowsCallable = httpsCallable<ReportingRequest, ReportingResponse>(
  functions,
  'getReportingRows',
);

const exportReportingDataCallable = httpsCallable<ReportingRequest, ReportingResponse>(
  functions,
  'exportReportingData',
);

export async function getReportingRows(request: ReportingRequest): Promise<ReportingResponse> {
  const result = await getReportingRowsCallable(request);
  return result.data;
}

export async function getReportingExport(request: ReportingRequest): Promise<ReportingResponse> {
  const result = await exportReportingDataCallable(request);
  return result.data;
}

export function reportingErrorMessage(error: unknown): string {
  const candidate = error as { code?: string; message?: string };
  const message = String(candidate?.message || '').replace(/^FirebaseError:\s*/i, '').trim();
  if (candidate?.code?.includes('resource-exhausted')) {
    return message || 'This result is too large. Narrow the date or store filters.';
  }
  if (candidate?.code?.includes('permission-denied')) {
    return message || 'Your role or store assignment does not permit this report.';
  }
  return message || 'The report could not be generated. Please retry.';
}

export function formatReportValue(value: unknown, type: ReportColumn['type']): string {
  if (value === null || value === undefined || value === '') return '—';
  if (type === 'money') {
    return `₹${Number(value || 0).toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  if (type === 'number') {
    return Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}
