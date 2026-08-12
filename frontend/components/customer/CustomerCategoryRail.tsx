import { useEffect, useRef } from 'react';

type Props = {
  categories: string[];
  /** The currently selected filter. Pure React state — nothing viewport-driven. */
  selected: string;
  /** Applies the category filter. Does not scroll the page. */
  onSelectCategory: (category: string) => void;
  labelFor: (category: string) => string;
};

/**
 * Sticky category filter.
 *
 * This is a FILTER, not an in-page navigator: selecting a category narrows the product
 * grid via the screen's existing category state. There is deliberately no scroll-spy,
 * no IntersectionObserver and no scroll calculation, so the active state can never
 * oscillate or disagree with what is on screen.
 *
 * ONE component, two orientations, decided entirely in CSS (.cb-customer-rail) so the
 * React tree is identical at every width — no viewport state, no matchMedia, nothing
 * that could render a different DOM on the server than on the client:
 *
 *   < 640 px   a horizontal chip row above the grid. A phone cannot spare a permanent
 *              56 px column: at 320 px that left the product cards 106 px wide. The row
 *              is the only horizontally scrollable element in the app and it contains
 *              its own overscroll, so it can never chain to the page or the browser's
 *              back gesture.
 *   >= 640 px  the vertical rail beside the grid, where 64 px is affordable.
 *
 * Labels are stacked upright rather than rotated, because rotated text in a 64 px rail
 * is hard to read. Selection is announced via aria-pressed, never by colour alone.
 */
export default function CustomerCategoryRail({ categories, selected, onSelectCategory, labelFor }: Props) {
  const rowRef = useRef<HTMLElement | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  /*
   * Keeps the selected chip in view.
   *
   * This is the ONE piece of scrolling in this component and it is deliberately
   * narrow. It reads no scroll position, observes nothing and never moves the page:
   * it sets scrollLeft on the chip row itself, which is why it uses the row's own
   * scrollTo rather than scrollIntoView — scrollIntoView is free to scroll ancestors,
   * and the page must never move sideways.
   *
   * Direction matters: selection decides the view, never the reverse. Nothing here can
   * change `selected`, so the active state still cannot oscillate or disagree with what
   * is on screen. It exists because the category can be reset from elsewhere on the
   * screen — "Show full menu", or switching store — and a customer must be able to see
   * which filter is active without hunting for it.
   */
  useEffect(() => {
    const row = rowRef.current;
    const chip = activeRef.current;
    // Vertical rail (>= 640px) has no overflow, so there is nothing to reveal.
    if (!row || !chip || row.scrollWidth <= row.clientWidth) return;

    const gutter = 16;
    const left = chip.offsetLeft - gutter;
    const right = chip.offsetLeft + chip.offsetWidth + gutter;
    const alreadyVisible = left >= row.scrollLeft && right <= row.scrollLeft + row.clientWidth;
    if (alreadyVisible) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    row.scrollTo({ left, behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [selected]);

  return (
    <nav aria-label="Menu categories" className="cb-customer-rail" ref={rowRef}>
      {categories.map((category) => {
        const isActive = category === selected;
        return (
          <button
            key={category}
            ref={isActive ? activeRef : undefined}
            type="button"
            onClick={() => onSelectCategory(category)}
            aria-pressed={isActive}
            /* Sizing and shape live in CSS so one button can be a chip or a rail tab.
               min-h-[44px] is kept here because it is the touch-target floor in both. */
            className={[
              'cb-customer-rail-item min-h-[44px] font-black leading-tight',
              isActive ? 'cb-customer-rail-tab-active' : 'cb-customer-rail-tab',
            ].join(' ')}
          >
            <span className="cb-customer-rail-label">{labelFor(category)}</span>
          </button>
        );
      })}
    </nav>
  );
}
