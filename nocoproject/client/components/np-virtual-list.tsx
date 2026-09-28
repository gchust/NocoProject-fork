import { type ReactElement, type ReactNode, useState } from 'react';
import { type ItemProps, type ListProps, Virtuoso } from 'react-virtuoso';

import { cn } from '@/lib/utils';

import { NP_VIRTUALIZE_AFTER, findScrollParent } from './np-scroll-parent.js';

function VirtualItem({
  children,
  style,
  item: _item,
  ...data
}: ItemProps<unknown>): ReactElement {
  return (
    <li
      style={style}
      data-index={data['data-index']}
      data-known-size={data['data-known-size']}
      className='pb-3'
    >
      {children}
    </li>
  );
}

// One list component per tag, created once so Virtuoso keeps its rows mounted.
function listComponent(tag: 'ol' | 'ul', className: string | undefined) {
  return function VirtualList({ ref, style, children }: ListProps) {
    const Tag = tag;
    return (
      <Tag
        ref={ref as unknown as React.Ref<HTMLOListElement & HTMLUListElement>}
        style={style}
        className={className}
      >
        {children}
      </Tag>
    );
  };
}

export interface NpVirtualListProps<T> {
  readonly items: readonly T[];
  readonly itemKey: (item: T) => string;
  readonly renderItem: (item: T) => ReactNode;
  /** Lists up to this length render every item; longer ones only what is on screen. */
  readonly threshold?: number;
  readonly as?: 'ol' | 'ul';
  readonly className?: string;
  /** Spacing of the plain list; the virtualized one pads each item instead. */
  readonly gapClassName?: string;
  readonly label?: string;
}

/**
 * A list that turns into a `react-virtuoso` window past `threshold` items (§H 8): short lists stay plain lists (and
 * keep working in find-in-page and tests), long ones measure against the nearest scrolling ancestor so they fit the
 * covering page, drawer or board column they sit in. Items are always `li` children of the chosen list tag.
 */
export function NpVirtualList<T>({
  items,
  itemKey,
  renderItem,
  threshold = NP_VIRTUALIZE_AFTER,
  as = 'ol',
  className,
  gapClassName = 'space-y-3',
  label,
}: NpVirtualListProps<T>): ReactElement {
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const [List] = useState(() => listComponent(as, className));
  if (items.length <= threshold) {
    const Tag = as;
    return (
      <Tag className={cn(gapClassName, className)} aria-label={label}>
        {items.map((item) => (
          <li key={itemKey(item)}>{renderItem(item)}</li>
        ))}
      </Tag>
    );
  }
  const scrollParent = anchor ? findScrollParent(anchor) : null;
  return (
    <div ref={setAnchor} role='group' aria-label={label} data-virtualized=''>
      {anchor ? (
        <Virtuoso
          data={items}
          customScrollParent={scrollParent ?? undefined}
          useWindowScroll={!scrollParent}
          increaseViewportBy={400}
          computeItemKey={(_, item) => itemKey(item)}
          itemContent={(_, item) => renderItem(item)}
          components={{ List, Item: VirtualItem }}
        />
      ) : null}
    </div>
  );
}
