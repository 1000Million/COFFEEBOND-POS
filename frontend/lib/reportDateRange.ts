export const REPORTING_TIME_ZONE = 'Asia/Kolkata';

export type ReportDatePreset = 'TODAY' | 'YESTERDAY' | 'THIS_WEEK' | 'THIS_MONTH' | 'CUSTOM';

export type ReportDateRangeDraft = {
  preset: ReportDatePreset;
  customStart: string;
  customEnd: string;
};

export type ReportDateRange = ReportDateRangeDraft & {
  startKey: string;
  endKey: string;
  startInclusive: Date;
  endExclusive: Date;
  label: string;
};

export type ReportDateRangeResult =
  | { ok: true; range: ReportDateRange }
  | { ok: false; error: string };

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const REPORT_DATE_PRESET_OPTIONS: Array<{ value: ReportDatePreset; label: string }> = [
  { value: 'TODAY', label: 'Today' },
  { value: 'YESTERDAY', label: 'Yesterday' },
  { value: 'THIS_WEEK', label: 'This week' },
  { value: 'THIS_MONTH', label: 'This month' },
  { value: 'CUSTOM', label: 'Custom range' },
];

export function isValidDateKey(value: string): boolean {
  if (!DATE_KEY_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function reportDateKey(date: Date, timeZone = REPORTING_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function shiftReportDateKey(value: string, days: number): string {
  if (!isValidDateKey(value)) throw new Error('Report date must use a valid YYYY-MM-DD value.');
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  ) - date.getTime();
}

export function reportZonedMidnight(value: string, timeZone = REPORTING_TIME_ZONE): Date {
  if (!isValidDateKey(value)) throw new Error('Report date must use a valid YYYY-MM-DD value.');
  const [year, month, day] = value.split('-').map(Number);
  const utcGuess = Date.UTC(year, month - 1, day);
  let result = new Date(utcGuess - timeZoneOffsetMs(new Date(utcGuess), timeZone));
  result = new Date(utcGuess - timeZoneOffsetMs(result, timeZone));
  return result;
}

function presetKeys(preset: Exclude<ReportDatePreset, 'CUSTOM'>, now: Date, timeZone: string) {
  const todayKey = reportDateKey(now, timeZone);
  if (preset === 'TODAY') return { startKey: todayKey, endKey: todayKey };
  if (preset === 'YESTERDAY') {
    const yesterday = shiftReportDateKey(todayKey, -1);
    return { startKey: yesterday, endKey: yesterday };
  }
  if (preset === 'THIS_MONTH') {
    return { startKey: `${todayKey.slice(0, 8)}01`, endKey: todayKey };
  }

  // Business reporting weeks run Monday through the current calendar day.
  const utcDay = new Date(`${todayKey}T12:00:00.000Z`).getUTCDay();
  const daysSinceMonday = (utcDay + 6) % 7;
  return { startKey: shiftReportDateKey(todayKey, -daysSinceMonday), endKey: todayKey };
}

export function resolveReportDateRange(
  draft: ReportDateRangeDraft,
  options: { now?: Date; timeZone?: string } = {},
): ReportDateRangeResult {
  const now = options.now || new Date();
  const timeZone = options.timeZone || REPORTING_TIME_ZONE;
  let startKey: string;
  let endKey: string;

  if (draft.preset === 'CUSTOM') {
    if (!draft.customStart || !draft.customEnd) {
      return { ok: false, error: 'Choose both a start date and an end date.' };
    }
    if (!isValidDateKey(draft.customStart) || !isValidDateKey(draft.customEnd)) {
      return { ok: false, error: 'Enter valid start and end dates.' };
    }
    startKey = draft.customStart;
    endKey = draft.customEnd;
    if (endKey < startKey) {
      return { ok: false, error: 'End date cannot be before start date.' };
    }
  } else {
    ({ startKey, endKey } = presetKeys(draft.preset, now, timeZone));
  }

  try {
    const startInclusive = reportZonedMidnight(startKey, timeZone);
    const endExclusive = reportZonedMidnight(shiftReportDateKey(endKey, 1), timeZone);
    return {
      ok: true,
      range: {
        ...draft,
        startKey,
        endKey,
        startInclusive,
        endExclusive,
        label: startKey === endKey ? startKey : `${startKey} to ${endKey}`,
      },
    };
  } catch {
    return { ok: false, error: 'The business reporting timezone is not available.' };
  }
}

export function createReportDateRange(
  preset: Exclude<ReportDatePreset, 'CUSTOM'> = 'TODAY',
  options: { now?: Date; timeZone?: string } = {},
): ReportDateRange {
  const todayKey = reportDateKey(options.now || new Date(), options.timeZone || REPORTING_TIME_ZONE);
  const result = resolveReportDateRange({ preset, customStart: todayKey, customEnd: todayKey }, options);
  if (result.ok === false) throw new Error(result.error);
  return result.range;
}

export function reportRangeFileSuffix(range: Pick<ReportDateRange, 'startKey' | 'endKey'>): string {
  return `${range.startKey}_to_${range.endKey}`;
}

export function reportFileName(reportName: string, range: Pick<ReportDateRange, 'startKey' | 'endKey'>): string {
  const safeName = reportName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `coffee-bond-${safeName}-${reportRangeFileSuffix(range)}.csv`;
}

export function dateIsInReportRange(value: Date, range: Pick<ReportDateRange, 'startInclusive' | 'endExclusive'>): boolean {
  return value >= range.startInclusive && value < range.endExclusive;
}
