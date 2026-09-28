import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
  type ReactNode,
} from 'react';

import { cn } from '@/lib/utils';

export interface NpDetailLayoutProps {
  /** The record's own column: heading, content, activity. It scrolls with the page. */
  readonly main: ReactNode;
  /**
   * The properties column, a fixed 20rem from `lg` up (in rem, so the compact preset does not narrow it). It stays in
   * view while the main column scrolls, unless it is taller than the viewport.
   */
  readonly aside: ReactNode;
  readonly asideLabel: string;
  readonly className?: string;
}

/**
 * The three-column detail page of §H 3 (navigation, main, properties): the main column is `flex-1 min-w-0`, the right
 * column a fixed 20rem, both scrolling with the page, and narrow screens fold both into one column. Used by the issue
 * and knowledge details so every record page shares one frame.
 */
export function NpDetailLayout({
  main,
  aside,
  asideLabel,
  className,
}: NpDetailLayoutProps): ReactElement {
  const contentRef = useRef<HTMLDivElement>(null);
  const fits = useFitsScrollViewport(contentRef);
  return (
    // One scroll container (nocosolution/frontend/nocobase3-frontend-best-practices.md §3.2): the covering page scrolls as a whole; neither column
    // scrolls on its own, and the side column stretches to the main column's height so its background runs through.
    <div className={cn('flex min-h-full flex-col lg:flex-row', className)}>
      <div className='flex min-w-0 flex-1 flex-col'>{main}</div>
      <aside
        aria-label={asideLabel}
        className='border-t bg-muted/30 lg:w-[20rem] lg:shrink-0 lg:border-t-0 lg:border-l'
      >
        {/* The cards follow the page from the top of the scroll container, which sits right below the page header.
            A sticky block taller than the viewport would hide its bottom until the page ends, and giving it its own
            scrollbar would add a second scroll container, so a column that does not fit simply scrolls with the page. */}
        <div
          className={cn(fits && 'lg:sticky lg:top-0')}
          data-np-aside-content=''
          ref={contentRef}
        >
          {aside}
        </div>
      </aside>
    </div>
  );
}

/** Whether the element is no taller than the visible height of the nearest scrolling ancestor. */
function useFitsScrollViewport(ref: RefObject<HTMLElement | null>): boolean {
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const viewport = scrollParent(element);
    const measure = (): void => {
      const available = viewport
        ? viewport.clientHeight
        : document.documentElement.clientHeight;
      setFits(element.offsetHeight <= available);
    };
    // A ResizeObserver reports each observed element once on `observe`, which is the first measurement.
    window.addEventListener('resize', measure);
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(element);
    if (viewport) observer?.observe(viewport);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [ref]);
  return fits;
}

function scrollParent(element: HTMLElement): HTMLElement | undefined {
  for (
    let parent = element.parentElement;
    parent;
    parent = parent.parentElement
  ) {
    const { overflowY } = getComputedStyle(parent);
    if (overflowY === 'auto' || overflowY === 'scroll') return parent;
  }
  return undefined;
}
