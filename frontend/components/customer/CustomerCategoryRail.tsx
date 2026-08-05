type Props = {
  categories: string[];
  /** The currently selected filter. Pure React state — nothing viewport-driven. */
  selected: string;
  /** Applies the category filter. Does not scroll the page. */
  onSelectCategory: (category: string) => void;
  labelFor: (category: string) => string;
};

/**
 * Sticky vertical category rail.
 *
 * This is a FILTER, not an in-page navigator: selecting a category narrows the product
 * grid via the screen's existing category state. There is deliberately no scroll-spy,
 * no IntersectionObserver and no scroll calculation, so the active state can never
 * oscillate or disagree with what is on screen.
 *
 * It has no scroll container of its own — the customer menu is a single vertical flow,
 * and a nested scroller would risk reintroducing horizontal movement. Labels are
 * stacked upright rather than rotated, because rotated text in a 56 px rail is hard to
 * read at 360 px, which is a supported minimum.
 *
 * Selection is announced via aria-pressed, never by colour alone.
 */
export default function CustomerCategoryRail({ categories, selected, onSelectCategory, labelFor }: Props) {
  return (
    <nav
      aria-label="Menu categories"
      className="cb-customer-rail z-10 flex w-[56px] shrink-0 flex-col gap-1 self-start sm:w-[64px]"
    >
      {categories.map((category) => {
        const isActive = category === selected;
        return (
          <button
            key={category}
            type="button"
            onClick={() => onSelectCategory(category)}
            aria-pressed={isActive}
            className={[
              /* 10px with tight tracking keeps the longest authoritative label
                 ("Desserts", "Baked by Bond") inside a 56 px rail at 360 px. */
              'flex min-h-[44px] w-full items-center justify-center px-0.5 py-2 text-center text-[10px] font-black leading-tight tracking-tight',
              isActive ? 'cb-customer-rail-tab-active' : 'cb-customer-rail-tab',
            ].join(' ')}
          >
            <span className="cb-clamp-2">{labelFor(category)}</span>
          </button>
        );
      })}
    </nav>
  );
}
