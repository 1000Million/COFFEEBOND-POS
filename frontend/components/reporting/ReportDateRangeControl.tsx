import { useEffect, useState } from 'react';
import { CalendarDays, RotateCcw } from 'lucide-react';
import {
  createReportDateRange,
  REPORT_DATE_PRESET_OPTIONS,
  ReportDatePreset,
  ReportDateRange,
  ReportDateRangeDraft,
  resolveReportDateRange,
} from '../../lib/reportDateRange';

type Props = {
  value: ReportDateRange;
  onApply: (range: ReportDateRange) => void;
  disabled?: boolean;
  className?: string;
};

export default function ReportDateRangeControl({ value, onApply, disabled = false, className = '' }: Props) {
  const [draft, setDraft] = useState<ReportDateRangeDraft>({
    preset: value.preset,
    customStart: value.customStart,
    customEnd: value.customEnd,
  });
  const [error, setError] = useState('');

  useEffect(() => {
    setDraft({ preset: value.preset, customStart: value.customStart, customEnd: value.customEnd });
    setError('');
  }, [value]);

  const updatePreset = (preset: ReportDatePreset) => {
    setDraft((current) => ({ ...current, preset }));
    setError('');
  };

  const apply = () => {
    const result = resolveReportDateRange(draft);
    if (result.ok === false) {
      setError(result.error);
      return;
    }
    setError('');
    onApply(result.range);
  };

  const reset = () => {
    const next = createReportDateRange('TODAY');
    setDraft({ preset: next.preset, customStart: next.customStart, customEnd: next.customEnd });
    setError('');
    onApply(next);
  };

  return (
    <div className={`min-w-0 rounded-2xl border border-neutral-200 bg-white p-3 ${className}`}>
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(140px,0.8fr)_minmax(0,1fr)_auto] lg:items-end">
        <label className="grid min-w-0 gap-1 text-xs font-black uppercase tracking-[0.14em] text-neutral-500">
          Date range
          <div className="relative">
            <CalendarDays className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={16} />
            <select
              aria-label="Report date range preset"
              value={draft.preset}
              onChange={(event) => updatePreset(event.target.value as ReportDatePreset)}
              disabled={disabled}
              className="w-full appearance-none rounded-xl border border-neutral-200 bg-neutral-50 py-2.5 pl-9 pr-3 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {REPORT_DATE_PRESET_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
        </label>

        {draft.preset === 'CUSTOM' ? (
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:col-span-2 sm:grid-cols-2 lg:col-span-1">
            <label className="grid min-w-0 gap-1 text-xs font-black uppercase tracking-[0.14em] text-neutral-500">
              Start date
              <input
                aria-label="Report start date"
                type="date"
                value={draft.customStart}
                onChange={(event) => setDraft((current) => ({ ...current, customStart: event.target.value }))}
                disabled={disabled}
                className="min-w-0 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033] disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>
            <label className="grid min-w-0 gap-1 text-xs font-black uppercase tracking-[0.14em] text-neutral-500">
              End date
              <input
                aria-label="Report end date"
                type="date"
                value={draft.customEnd}
                onChange={(event) => setDraft((current) => ({ ...current, customEnd: event.target.value }))}
                disabled={disabled}
                className="min-w-0 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-sm font-bold text-[#3e2723] outline-none focus:border-[#5c4033] disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>
          </div>
        ) : (
          <div className="min-w-0 rounded-xl bg-neutral-50 px-3 py-2.5 text-sm font-bold text-neutral-600">
            Effective range: {value.label}
          </div>
        )}

        <div className="flex min-w-0 flex-wrap gap-2 sm:col-span-2 lg:col-span-1 lg:flex-nowrap">
          <button
            type="button"
            onClick={apply}
            disabled={disabled}
            className="min-h-10 flex-1 rounded-xl bg-[#3e2723] px-4 py-2 text-sm font-black text-white hover:bg-[#2d1c19] disabled:cursor-not-allowed disabled:opacity-60 lg:flex-none"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={reset}
            disabled={disabled}
            aria-label="Reset report date range to today"
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm font-bold text-neutral-600 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RotateCcw size={15} /> Reset
          </button>
        </div>
      </div>

      <div className="mt-2 text-xs font-bold text-neutral-500" aria-live="polite">
        {error ? (
          <span className="text-red-700">{error}</span>
        ) : (
          <span>Selected: {value.label} · Asia/Kolkata · inclusive calendar dates</span>
        )}
      </div>
    </div>
  );
}
