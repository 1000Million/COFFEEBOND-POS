import { useRef, useState } from 'react';
import type { ReportingSummary } from '../../lib/reporting';
import { formatReportValue } from '../../lib/reporting';
import type { Activity, Comparison, PerformanceDashboardData, Returning, Trend, Window } from '../../lib/reportingDashboard';
import { ALL_ACTIVITY_HOURS, activityHourRanges, hiddenActivityExists, nextActivityCell, readActivityHours, saveActivityHours } from '../../lib/activityHours';
import './PerformanceDashboard.css';

const money = (value: number | null | undefined) => value == null ? 'Unavailable' : formatReportValue(value, 'money');
const number = (value: number | null | undefined) => value == null ? 'Unknown' : value.toLocaleString('en-IN');
const dates = (window?: Partial<Window> | null) => window?.startDate ? `${window.startDate} to ${window.endDate} · IST` : 'Window unavailable';
const time = (value?: string | null) => value ? new Date(value).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST' : 'complete day';
const hour = (value: number) => `${String(value).padStart(2, '0')}:00–${String(value + 1).padStart(2, '0')}:00`;
const missingService = 'Dashboard aggregates are unavailable. The local getReportingSummary dashboard extension must be released before these sections can load.';
const Unknown = ({ reason }: { reason?: string | null }) => <p className="performance-unavailable">{reason || 'Coverage unavailable. Retry this report.'}</p>;

function ComparisonCard({ title, data, daily = false }: { title: string; data?: Comparison; daily?: boolean }) {
  return <section className="performance-card" aria-label={title}><h3>{title}</h3>{!data || data.status !== 'AVAILABLE' ? <Unknown reason={data?.reason || missingService}/> : <>
    <p className="performance-number">{money(daily ? data.current?.average : data.current?.total)}{daily && <span className="performance-unit"> / day</span>}</p>
    <p className="performance-caption">vs {money(daily ? data.previous?.average : data.previous?.total)}{daily ? " / day" : ""} · {data.partial ? "same elapsed IST time" : `${data.days || 1} equal complete day${data.days === 1 ? "" : "s"}`}</p><details><summary>Dates and calculation</summary><p className="performance-caption">{dates(data.current)} · {data.partial ? `through ${time(data.current?.endBefore)}` : `${data.days || 1} complete day${data.days === 1 ? '' : 's'}`}</p>
    {daily && <p className="performance-caption">{money(data.current?.total)} ÷ {data.days} days. Today excluded{data.omittedCompletedDays ? `; ${data.omittedCompletedDays} unmatched completed day(s) excluded` : ''}.</p>}
    <p className="performance-comparable">Compared with {money(daily ? data.previous?.average : data.previous?.total)}{daily ? ' / day' : ''}</p>
    <p className="performance-caption">{dates(data.previous)} · {data.partial ? `through ${time(data.previous?.endBefore)}` : `${data.days || 1} complete day${data.days === 1 ? '' : 's'}`}</p>
    {daily && <p className="performance-caption">{money(data.previous?.total)} ÷ {data.days} days.</p>}
    </details><p className="performance-delta">{data.difference?.direction === 'Increase' ? '↑ ' : data.difference?.direction === 'Decrease' ? '↓ ' : '→ '}{data.difference?.direction}: {money(Math.abs(data.difference?.amount || 0))}{daily ? ' / day' : ''} · {data.difference?.percent == null ? 'Percentage unavailable (previous value is zero)' : `${Math.abs(data.difference.percent)}%`}</p>
  </>}</section>;
}

function ReturningCard({ data, window }: { data?: Returning; window?: Partial<Window> }) {
  const historyLimited = data?.status === 'INSUFFICIENT_HISTORY';
  const available = data?.status === 'AVAILABLE' && data.percentage != null;
  const coverage = available || historyLimited ? data : undefined;
  const limitedCoverage = coverage?.eligibleBills != null && coverage.eligibleBills > 0 && coverage.identifiedBills != null && coverage.identifiedBills < coverage.eligibleBills;
  const guidance = {
    QUERY_UNAVAILABLE: 'Customer history lookup is unavailable. Ask an administrator to check the reporting query configuration.',
    ACCESS_DENIED: 'Customer history could not be accessed with the current permissions. Ask an administrator to check access; restricted data remains unavailable.',
    TIMEOUT: 'Customer history lookup timed out. You can refresh the report later.',
    READ_LIMIT: 'Customer history lookup reached a read or service limit. Ask an administrator to check reporting capacity.',
    SERVICE_ERROR: 'Customer history is temporarily unavailable because the lookup failed. You can refresh the report later; contact an administrator if it continues.',
  };
  const reason = historyLimited ? data.reason : data?.errorCode && Object.hasOwn(guidance, data.errorCode) ? guidance[data.errorCode] : data?.status === 'UNAVAILABLE' && !data.errorCode ? data.reason : undefined;
  return <section className="performance-card" aria-label="Returning customers · identified customers only"><h3>Returning customers · identified customers only</h3>
    <p className="performance-number">{limitedCoverage ? 'Limited customer coverage' : available ? `${data.percentage}%` : historyLimited ? 'Insufficient history' : 'Unavailable'}</p>
    <p><strong>{number(coverage?.returningCustomers ?? coverage?.confirmedReturning)}{historyLimited && coverage?.confirmedReturning != null ? ' confirmed' : ''} returning / {number(coverage?.distinctIdentified)} distinct identified purchasing customers{available && !limitedCoverage ? ` · ${data.percentage}% of identified customers only` : ''}.</strong></p>
    <p><strong>Identification coverage: {number(coverage?.identifiedBills)} identified eligible bills / {number(data?.eligibleBills)} eligible bills{coverage?.identificationPercent == null ? ' · Percentage unavailable' : ` · ${coverage.identificationPercent}%`}.</strong></p>
    {limitedCoverage && <p className="performance-caption">Unidentified customers remain unknown. No store-wide returning percentage is shown.</p>}
    {!available && <Unknown reason={reason || (data ? 'Customer history is unavailable for this report. Ask an administrator to check reporting access and service availability.' : missingService)}/>}
    {historyLimited && data.confirmedReturning != null && <p className="performance-caption">At least {number(data.confirmedReturning)} confirmed returning; history established for {number(data.historyEstablished)} / {number(data.distinctIdentified)} identified customers. Percentage withheld.</p>}
    <details><summary>Definition and history coverage</summary><p className="performance-caption">{dates(window)}. {available && limitedCoverage ? `Identified-only calculation: ${data.percentage}%; not a store-wide estimate.` : ""}</p><p className="performance-caption">Returning means an earlier distinct completed paid purchase at this store, before at least one purchase in the selected period; an earlier purchase in that period counts. Verified customer mappings take priority. Valid saved Indian phones on bills, linked accepted ordering records or linked customer records provide a fallback identity; formatting variants are normalized on the server. Conflicting verified identities are never merged by phone. Names, masked or placeholder phones, device IDs, account age and loyalty visits are not identities. Unsupported international phones remain unknown. Unknown identity: {number(coverage?.unknownBills)} bills. History has no date lookback and uses qualifying purchases at this store regardless of the current report filters. An unmatched phone is not proof of a first visit; incomplete history withholds the percentage.</p></details>
  </section>;
}

function SalesTrend({ data }: { data?: Trend }) {
  const [active, setActive] = useState<number | null>(null);
  const points = data?.points || [];
  const max = Math.max(1, ...points.flatMap(p => [p.netSales, p.comparableSales || 0]));
  const x = (i: number) => 72 + (points.length === 1 ? 350 : i * 690 / (points.length - 1));
  const y = (value: number) => 222 - value / max * 174;
  const line = (previous = false) => points.filter(p => !previous || p.comparableSales != null).map(p => { const i = points.indexOf(p); return `${x(i)},${y(previous ? p.comparableSales! : p.netSales)}`; }).join(' ');
  const selected = active == null ? null : points[active];
  return <section className="performance-card" aria-label="Daily sales trend"><h3>Daily sales trend</h3>{data?.status !== 'AVAILABLE' ? <Unknown reason={data?.reason || missingService}/> : <>
    <p className="performance-caption"><strong>● Solid: selected</strong> {dates(data.current)} · <strong>□ Dashed: preceding equal-day period</strong> {dates(data.previous)}.</p>
    {data.partial && <p className="performance-caption">Selected last day and comparison last day stop at the same elapsed IST time ({time(data.current?.endBefore)}). Earlier dates are complete days.</p>}
    {!data.previous && <Unknown reason={data.reason || 'Comparable period unavailable.'}/>}
    <div className="performance-chart-readout" role={selected ? 'tooltip' : undefined} id="performance-chart-tip">{selected ? `${selected.date}: ${money(selected.netSales)}, ${selected.eligibleBills} eligible bills. Comparable ${selected.comparableDate}: ${money(selected.comparableSales)}.` : 'Hover or keyboard-focus a daily point for values. All daily values are also available below.'}</div>
    <svg className="performance-chart" viewBox="0 0 800 265" aria-label="Net sales in rupees by day; selected solid circles and comparable dashed squares" role="group">
      {[0, 0.5, 1].map(f => <g key={f}><line x1="72" x2="762" y1={y(f * max)} y2={y(f * max)} className="performance-axis"/><text x="64" y={y(f * max) + 4} textAnchor="end">₹{new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(f * max)}</text></g>)}
      <polyline points={line()} className="performance-series-current"/>{data.previous && <polyline points={line(true)} className="performance-series-comparable"/>}
      {points.map((p, i) => <g key={p.date}>{p.comparableSales != null && <rect x={x(i) - 3} y={y(p.comparableSales) - 3} width="6" height="6" className="performance-comparison-point"/>}<circle cx={x(i)} cy={y(p.netSales)} r="4" tabIndex={0} role="button" aria-describedby="performance-chart-tip" aria-label={`${p.date}: ${money(p.netSales)}; comparable ${p.comparableDate}: ${money(p.comparableSales)}`} onFocus={() => setActive(i)} onBlur={() => setActive(null)} onMouseEnter={() => setActive(i)} onMouseLeave={() => setActive(null)} className="performance-current-point"><title>{`${p.date}: ${money(p.netSales)} / comparable ${money(p.comparableSales)}`}</title></circle>{(points.length < 8 || i === 0 || i === points.length - 1 || i === Math.floor(points.length / 2)) && <text x={x(i)} y="250" textAnchor="middle">{p.date.slice(5)}</text>}</g>)}
    </svg>
    <details><summary>Daily sales values and comparable dates</summary><div className="performance-table-scroll"><table><thead><tr><th>Selected date (IST)</th><th>Net sales</th><th>Eligible bills</th><th>Comparable date (IST)</th><th>Comparable net sales</th></tr></thead><tbody>{points.map(p => <tr key={p.date}><th>{p.date}</th><td>{money(p.netSales)}</td><td>{p.eligibleBills}</td><td>{data.previous ? p.comparableDate : 'Unavailable'}</td><td>{money(p.comparableSales)}</td></tr>)}</tbody></table></div></details>
  </>}</section>;
}

export function ActivityGrid({ data, storeId = 'ALL' }: { data?: Activity; storeId?: string }) {
  return <StoreActivityGrid key={storeId} data={data} storeId={storeId}/>;
}

function StoreActivityGrid({ data, storeId }: { data?: Activity; storeId: string }) {
  const [focused, setFocused] = useState(0), [tip, setTip] = useState<string | null>(null);
  const [visibleHours, setVisibleHours] = useState(() => readActivityHours(storeId));
  const [choosingHours, setChoosingHours] = useState(false);
  const chooserButton = useRef<HTMLButtonElement>(null);
  const chooseHours = (hours: number[]) => {
    setVisibleHours(hours); saveActivityHours(storeId, hours); setTip(null);
    if (!hours.includes(focused % 24)) setFocused(Math.floor(focused / 24) * 24 + (hours[0] || 0));
  };
  const focusedCell = visibleHours.includes(focused % 24) ? focused : visibleHours[0];
  const table = useRef<HTMLTableElement>(null), split = data?.split;
  const usable = split?.status === 'AVAILABLE' || split?.status === 'PARTIAL';
  const max = Math.max(1, ...(usable ? split.cells || [] : []).flatMap(row => row.flatMap(c => [c.food, c.drinks])));
  const level = (n: number) => n === 0 ? 0 : Math.ceil(n / max * 3);
  return <section className="performance-card" aria-label="When the store is busy">
    <div className="performance-hour-controls" role="group" aria-label="Activity visible hours">
      <button type="button" aria-pressed={visibleHours.length === 17 && visibleHours.every((h, i) => h === i + 7)} onClick={() => chooseHours(ALL_ACTIVITY_HOURS.slice(7))}>Hide overnight hours · 00–06</button>
      <button ref={chooserButton} type="button" aria-expanded={choosingHours} aria-controls="performance-hour-chooser" onClick={() => setChoosingHours(!choosingHours)}>Choose hours</button>
      <button type="button" aria-pressed={visibleHours.length === 24} onClick={() => chooseHours([...ALL_ACTIVITY_HOURS])}>Show all hours</button>
    </div>
    {choosingHours && <fieldset id="performance-hour-chooser" className="performance-hour-chooser" onKeyDown={event => { if (event.key === 'Escape') { setChoosingHours(false); chooserButton.current?.focus(); } }}>
      <legend>Visible hour columns · IST</legend>
      <p className="performance-caption">Select each hour to show. For a schedule across midnight, select the late and early hours.</p>
      <div>{ALL_ACTIVITY_HOURS.map(h => <label key={h}><input type="checkbox" checked={visibleHours.includes(h)} onChange={event => chooseHours(event.target.checked ? [...visibleHours, h].sort((a, b) => a - b) : visibleHours.filter(value => value !== h))}/><span>{hour(h)}</span></label>)}</div>
    </fieldset>}
    <p className="performance-caption" aria-live="polite">Visible hours: {activityHourRanges(visibleHours)}{visibleHours.length ? ' IST' : ''} · {visibleHours.length}/24 shown. Display only; totals and weekday peaks include all hours.</p>
    <h3>When the store is busy</h3>{data?.status !== 'AVAILABLE' ? <Unknown reason={data?.reason || missingService}/> : <>
    {hiddenActivityExists(data, visibleHours) && <p className="performance-hidden-activity" role="status">Activity exists in hidden hours · <button type="button" onClick={() => chooseHours([...ALL_ACTIVITY_HOURS])}>Show all</button></p>}
    <p className="performance-caption"><strong>Last eight complete weeks:</strong> {dates(data)} · {number(data.eligibleBills)} eligible bills · query coverage {data.coveredDays}/{data.expectedDays} days.</p>
    <div className="performance-split-legend"><span className="performance-legend-cell" aria-hidden="true"><span>D</span><span>F</span></span><p><strong>Upper-right: Drinks · Lower-left: Food</strong><br/>Known parent-item quantities; both halves use the same light-to-strong quantity scale. Weekday peaks below use bill counts.</p></div>
    {!usable && <Unknown reason={split?.reason || 'Food/Drink quantities unavailable. Bill counts remain in cell details and weekday summaries.'}/>}
    {usable && split.status === 'PARTIAL' && <Unknown reason={`Partial item coverage: ${number(split.classifiedUnits)} / ${number(split.totalUnits)} captured units classified; ${number(split.capturedBills)} / ${number(data.eligibleBills)} bills have items. “?” marks incomplete cells; quantities are lower bounds, not zero activity.`}/>}
    <details><summary>Activity definitions and coverage</summary><p className="performance-caption">Saved item category codes or exact approved category labels determine Food/Drinks. Retail, mixed, conflicting and unmapped categories remain unknown. Parent quantities exclude add-ons and are not bill counts or footfall; Food + Drinks need not equal bills. Missing capture is not zero. Bounded server reads: 1,500 bills, 100 items per bill, 8,000 item documents; successful snapshots cached for five minutes. Query coverage is not proof of historical ingestion or opening hours. Filters apply to eligible bills as in existing reporting, rather than removing other item lines on a qualifying bill.</p></details>
    <p className="performance-chart-readout" role={tip ? 'tooltip' : undefined} id="performance-grid-tip">{tip || 'Use arrow keys within the grid. Scroll horizontally on a narrow screen. Focus a cell for quantities, unknown coverage and bill count.'}</p>
    {!visibleHours.length && <p className="performance-caption">No hour columns selected. Choose hours or show all hours to view the grid.</p>}
    <div className="performance-table-scroll" tabIndex={0} aria-label="Scrollable weekday and hour activity"><table ref={table} className="performance-activity"><thead><tr><th>Weekday / IST</th>{visibleHours.map(h => <th key={h}>{String(h).padStart(2, '0')}</th>)}</tr></thead><tbody>{data.rows?.map((row, r) => <tr key={row.weekday}><th>{row.weekday}</th>{visibleHours.map(h => {
      const count = row.counts[h];
      const index = r * 24 + h, cell = usable ? split.cells?.[r]?.[h] : undefined, incomplete = !!cell && (cell.unknown > 0 || cell.missingBills > 0);
      const label = `${row.weekday} ${hour(h)} IST: ${count} eligible bills across ${row.occurrences} complete weeks. ${cell ? `Food ${incomplete ? 'at least ' : ''}${cell.food}, Drinks ${incomplete ? 'at least ' : ''}${cell.drinks}; ${cell.unknown} unclassified units, ${cell.missingBills} bills missing items.` : 'Food/Drink quantities unavailable.'}`;
      return <td key={h}><button type="button" className="performance-split-cell" data-cell={index} tabIndex={focusedCell === index ? 0 : -1} aria-label={label} aria-describedby="performance-grid-tip" onClick={() => { setFocused(index); setTip(label); }} onMouseEnter={() => setTip(label)} onMouseLeave={() => setTip(null)} onFocus={() => { setFocused(index); setTip(label); }} onBlur={() => setTip(null)} onKeyDown={e => { if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) { e.preventDefault(); const next = nextActivityCell(index, e.key, visibleHours, data.rows?.length || 0); setFocused(next); table.current?.querySelector<HTMLButtonElement>(`[data-cell="${next}"]`)?.focus(); } }}>
        <span className="split-drinks" data-level={cell ? level(cell.drinks) : undefined} aria-hidden="true">{cell ? cell.drinks : '—'}</span><span className="split-food" data-level={cell ? level(cell.food) : undefined} aria-hidden="true">{cell ? cell.food : '—'}</span>{incomplete && <span className="split-unknown" aria-hidden="true">?</span>}
      </button></td>;
    })}</tr>)}</tbody></table></div>
    <ul className="performance-peaks">{data.rows?.map((row,r) => {const cells=usable ? split.cells?.[r] : undefined; const food=cells?.reduce((n,c)=>n+c.food,0), drinks=cells?.reduce((n,c)=>n+c.drinks,0);return <li key={row.weekday}><strong>{row.weekday}</strong><p>{row.peakCount ? `Busiest ${row.peakHours.map(h => `${hour(h)}${visibleHours.includes(h) ? '' : ' (outside visible hours)'}`).join(', ')} IST · ${row.peakCount} bills${row.peakHours.length > 1 ? ' each · tied' : ''}` : 'No eligible bills; no busiest hour.'}</p><p className="performance-caption">Total {row.counts.reduce((n,c)=>n+c,0)} bills · Food {food == null ? 'unavailable' : number(Math.round(food*100)/100)} · Drinks {drinks == null ? 'unavailable' : number(Math.round(drinks*100)/100)}{cells?.some(c=>c.unknown>0||c.missingBills>0) ? ' · partial quantities' : ''}</p></li>;})}</ul>
  </>}</section>;
}

export default function PerformanceDashboard({ data, summary, storeId, storeLabel, startDate, endDate, detailsPending=false }: { detailsPending?: boolean; data?: PerformanceDashboardData; summary: ReportingSummary; storeId: string; storeLabel: string; startDate: string; endDate: string }) {
  const values = data ? data.selected.status === 'AVAILABLE' ? data.selected.summary : undefined : summary;
  const window = { startDate, endDate, endBefore: data?.selected.endBefore };
  return <section className="performance-dashboard" aria-label="Store performance dashboard">
    <div><h2>Store performance · {storeLabel}</h2><p className="performance-caption">{dates(window)}{window.endBefore ? ` · through ${time(window.endBefore)}` : " · complete dates"} · Completed paid commercial bills · Net sales include GST after discounts.</p><details><summary>How these figures are calculated</summary><p className="performance-caption">Complimentary, voided, cancelled and unpaid bills are excluded from sales. All report filters apply to selected/comparable figures and the activity grid. Net collections retain the existing receipts/reversals scope, including eligible unlinked online receipts. Server totals are independent of table pagination. Exact comparison windows appear in each card’s details.</p></details></div>
    <section aria-label="Report totals" className="performance-metrics">{[
      ['Net sales', money(values?.netSales), 'Canonical net sales'],
      ['Completed paid bills', number(values?.orderCount), 'Eligible commercial bills, not tender legs'],
      ['Average order value', values?.orderCount ? money(values.netSales / values.orderCount) : 'Unavailable', `${money(values?.netSales)} ÷ ${number(values?.orderCount)} eligible bills${values?.orderCount === 0 ? ' · zero denominator' : ''}`],
      ['Net collections', money(values ? summary.netCollections : undefined), 'Existing receipts/reversals scope; includes eligible unlinked online receipts'],
    ].map(([label, value, help]) => <div className="performance-card" key={label}><p className="performance-caption">{label}</p><p className="performance-number">{value}</p><details><summary>Details</summary><p className="performance-caption">{help}</p></details></div>)}</section>
    {detailsPending ? <p className="performance-caption">Summary ready. Comparisons, activity, payment mix and product details load separately.</p> : <>
    {data?.selected.status === 'UNAVAILABLE' && <Unknown reason={data.selected.reason}/>}
    <div className="performance-comparisons"><ComparisonCard title="Average daily sales · this month vs last month" data={data?.monthly} daily/><ComparisonCard title="Sales · selected end date vs same date last month" data={data?.sameDate}/><ReturningCard data={data?.returning} window={window}/></div>
    <SalesTrend data={data?.trend}/><ActivityGrid data={data?.activity} storeId={storeId}/>
    <div className="performance-comparisons performance-summaries"><section className="performance-card"><h3>Payment mix · selected period</h3><p className="performance-caption">{dates(window)} · Canonical paid-bill tender amounts; a split bill contributes once to bill count and its amounts to each tender. Excludes standalone online receipts.</p>{data?.selected.paymentMix ? <ul className="performance-summary-list">{data.selected.paymentMix.map(row => <li key={row.method}><span>{row.method}</span><strong>{money(row.amount)}</strong></li>)}{data.selected.paymentMix.length === 0 && <li>No eligible paid-bill tender amounts.</li>}</ul> : <Unknown reason={missingService}/>}</section>
      <section className="performance-card"><h3>Top products · selected period</h3><p className="performance-caption">{dates(window)} · Top five by canonical allocated item sales including GST, after discounts; item capture is required.</p>{data?.selected.topProducts ? <ul className="performance-summary-list">{data.selected.topProducts.map((row, i) => <li key={i}><span>{row.itemName} · {row.quantitySold} sold</span><strong>{money(row.netSales)}</strong></li>)}{data.selected.topProducts.length === 0 && <li>No captured eligible product lines.</li>}</ul> : <Unknown reason={data ? 'Product summaries are unavailable for this role or selected coverage.' : missingService}/>}</section></div>
    <p className="performance-caption">As of {data ? new Date(data.generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST' : 'existing summary retrieval'} · Server aggregates, independent of bill-table pagination. Calendar-day coverage is a complete bounded query, not proof of historical data ingestion.</p>
    </>}
  </section>;
}
