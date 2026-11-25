import type { ReportingSummary } from './reporting';

export type Window = { startDate: string; endDate: string; endBefore?: string | null };
export type Delta = { amount: number; percent: number | null; direction: string };
type Section = { status: string; reason?: string | null };
export type Comparison = Section & { days?: number; omittedCompletedDays?: number; partial?: boolean; current?: Window & { total: number; average?: number }; previous?: Window & { total: number; average?: number }; difference?: Delta };
export type Returning = Section & { errorCode?: 'QUERY_UNAVAILABLE' | 'ACCESS_DENIED' | 'TIMEOUT' | 'READ_LIMIT' | 'SERVICE_ERROR'; eligibleBills?: number | null; identifiedBills?: number | null; distinctIdentified?: number | null; returningCustomers?: number | null; confirmedReturning?: number | null; historyEstablished?: number | null; percentage?: number | null; identificationPercent?: number | null; unknownBills?: number | null; identifiedDirectly?: number; identifiedThroughLinks?: number; anonymousBills?: number; invalidPhoneBills?: number; conflictingIdentityBills?: number; unresolvedLinkBills?: number; identificationCoverage?: 'COMPLETE' | 'LIMITED'; historyIncompleteCustomers?: number };
export type Trend = Section & { current?: Window; previous?: Window | null; partial?: boolean; points?: Array<{ date: string; comparableDate: string; netSales: number; comparableSales: number | null; eligibleBills: number }> };
export type SplitCell = { food: number; drinks: number; unknown: number; missingBills: number };
export type BusySplit = Section & { metric?: string; capturedBills?: number; missingBills?: number; totalUnits?: number; classifiedUnits?: number; cells?: SplitCell[][] };
export type Activity = Section & Partial<Window> & { split?: BusySplit; coveredDays?: number; expectedDays?: number; eligibleBills?: number; rows?: Array<{ weekday: string; counts: number[]; occurrences: number; peakHours: number[]; peakCount: number }> };
export type PerformanceDashboardData = {
  version: number; generatedAt: string; timeZone: string; storeIds: string[];
  selected: Section & Partial<Window> & { summary?: ReportingSummary; paymentMix?: Array<{ method: string; amount: number }>; topProducts?: Array<{ itemName: string; quantitySold: number; netSales: number }> | null };
  monthly: Comparison; sameDate: Comparison; trend: Trend; activity: Activity; returning: Returning;
};
