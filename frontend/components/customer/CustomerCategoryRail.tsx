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
 * ONE horizontal component at every width, decided entirely in CSS
 * (.cb-customer-rail), so the React tree is identical across breakpoints — no viewport
 * state, no matchMedia, nothing that could render a different DOM on first paint. The
 * row contains its own overscroll, so it cannot chain to the page or the browser's back
 * gesture.
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
    // A rail whose contents already fit needs no reveal movement.
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
            /* Weight lives in CSS, not here: with the pill borders gone, ten labels at
               font-black read as a second toolbar. Only the selected one is heavy. */
            className={[
              'cb-customer-rail-item min-h-[44px] leading-tight',
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
