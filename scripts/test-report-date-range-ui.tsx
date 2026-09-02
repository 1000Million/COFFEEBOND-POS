import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/reports' });
Object.defineProperties(globalThis, {
  window: { value: dom.window, configurable: true },
  document: { value: dom.window.document, configurable: true },
  navigator: { value: dom.window.navigator, configurable: true },
  HTMLElement: { value: dom.window.HTMLElement, configurable: true },
  Node: { value: dom.window.Node, configurable: true },
  getComputedStyle: { value: dom.window.getComputedStyle.bind(dom.window), configurable: true },
  IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true, writable: true },
});

const React = await import('react');
const { cleanup, render, screen } = await import('@testing-library/react');
const userEvent = (await import('@testing-library/user-event')).default;
const { default: ReportDateRangeControl } = await import('../frontend/components/reporting/ReportDateRangeControl');
const { createReportDateRange } = await import('../frontend/lib/reportDateRange');

function ReportHarness() {
  const [range, setRange] = React.useState(() => createReportDateRange('TODAY', {
    now: new Date('2026-09-02T06:30:00.000Z'),
  }));

  return (
    <>
      <ReportDateRangeControl value={range} onApply={setRange} />
      <output data-testid="query-range">
        {range.startKey}|{range.endKey}|{range.startInclusive.toISOString()}|{range.endExclusive.toISOString()}
      </output>
    </>
  );
}

const user = userEvent.setup({ document: dom.window.document });
render(<ReportHarness />);

await user.selectOptions(screen.getByLabelText('Report date range preset'), 'CUSTOM');
const startInput = screen.getByLabelText('Report start date') as HTMLInputElement;
const endInput = screen.getByLabelText('Report end date') as HTMLInputElement;

await user.clear(startInput);
await user.type(startInput, '2026-05-25');
await user.clear(endInput);
await user.type(endInput, '2026-06-02');

assert.equal(startInput.value, '2026-05-25', 'React should receive the selected start date.');
assert.equal(endInput.value, '2026-06-02', 'React should receive the selected end date.');

await user.click(screen.getByRole('button', { name: 'Apply' }));

assert.match(
  screen.getByTestId('query-range').textContent || '',
  /^2026-05-25\|2026-06-02\|2026-05-24T18:30:00\.000Z\|2026-06-02T18:30:00\.000Z$/,
  'Apply should propagate the inclusive calendar range as half-open IST query boundaries.',
);
assert.equal(
  (screen.getByLabelText('Report start date') as HTMLInputElement).value,
  '2026-05-25',
  'The applied start date should persist after the controlled component rerenders.',
);
assert.equal(
  (screen.getByLabelText('Report end date') as HTMLInputElement).value,
  '2026-06-02',
  'The applied end date should persist after the controlled component rerenders.',
);
assert.match(
  screen.getByText(/Selected:/).textContent || '',
  /Selected: 2026-05-25 to 2026-06-02/,
  'The effective range should be visible after Apply.',
);

cleanup();
dom.window.close();
console.log('Report date-range React interaction test passed.');
