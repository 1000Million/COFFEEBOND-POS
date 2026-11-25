import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

type Props = {
  children: ReactNode;
  ariaLabel: string;
  className?: string;
  contentClassName?: string;
  itemGapClassName?: string;
  role?: 'navigation' | 'region';
};

export default function HorizontalScroller({
  children,
  ariaLabel,
  className = '',
  contentClassName = '',
  itemGapClassName = 'gap-3',
  role = 'region',
}: Props) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const element = scrollerRef.current;
    if (!element) return;
    setCanScrollLeft(element.scrollLeft > 2);
    setCanScrollRight(element.scrollLeft + element.clientWidth < element.scrollWidth - 2);
  }, []);

  useEffect(() => {
    const element = scrollerRef.current;
    if (!element) return undefined;
    updateScrollState();
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(element);
    element.addEventListener('scroll', updateScrollState, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener('scroll', updateScrollState);
    };
  }, [children, updateScrollState]);

  const scroll = (direction: -1 | 1) => {
    const element = scrollerRef.current;
    if (!element) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.scrollBy({
      left: direction * Math.max(220, element.clientWidth * 0.75),
      behavior: reducedMotion ? 'auto' : 'smooth',
    });
  };

  return (
    <div className={`relative min-w-0 ${className}`} role={role} aria-label={ariaLabel}>
      {canScrollLeft && (
        <button
          type="button"
          onClick={() => scroll(-1)}
          className="absolute left-1 top-1/2 z-20 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white text-[#4a3026] shadow-lg ring-1 ring-[#e7ddd3] md:flex"
          aria-label={`Scroll ${ariaLabel} left`}
        >
          <ChevronLeft size={20} />
        </button>
      )}
      <div
        ref={scrollerRef}
        onScroll={updateScrollState}
        className={`flex snap-x snap-mandatory overflow-x-auto scroll-smooth [scrollbar-width:none] motion-reduce:scroll-auto [&>*]:snap-start [&::-webkit-scrollbar]:hidden ${itemGapClassName} ${contentClassName}`}
      >
        {children}
      </div>
      {canScrollRight && (
        <>
          <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-12 bg-gradient-to-l from-[#fbf7f1] to-transparent" aria-hidden="true" />
          <button
            type="button"
            onClick={() => scroll(1)}
            className="absolute right-1 top-1/2 z-20 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white text-[#4a3026] shadow-lg ring-1 ring-[#e7ddd3] md:flex"
            aria-label={`Scroll ${ariaLabel} right`}
          >
            <ChevronRight size={20} />
          </button>
        </>
      )}
    </div>
  );
}
