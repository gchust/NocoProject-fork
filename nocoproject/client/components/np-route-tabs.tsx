import type { KeyboardEvent, ReactElement } from 'react';
import { NavLink, useLocation } from 'react-router';

import { cn } from '@/lib/utils';

export interface NpRouteTab {
  /** The child route path relative to the page, such as `metrics`. */
  readonly path: string;
  readonly label: string;
}

/**
 * Page tabs that are child routes (`child-routes.md` §4): links styled as a line tab list, `aria-current='page'` on
 * the selected one, the query string kept. The page redirects its own bare URL to the default tab with
 * `useDefaultTabRedirect`.
 */
export function NpRouteTabs({
  tabs,
  label,
  keepSearch = true,
}: {
  readonly tabs: readonly NpRouteTab[];
  readonly label: string;
  readonly keepSearch?: boolean;
}): ReactElement {
  const location = useLocation();
  return (
    <nav aria-label={label} className='flex flex-wrap gap-1 border-b'>
      {tabs.map((tab) => (
        <NavLink
          key={tab.path}
          to={{
            pathname: tab.path,
            search: keepSearch ? location.search : undefined,
          }}
          className={cn(
            '-mb-px inline-flex h-9 items-center border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            'aria-[current=page]:border-primary aria-[current=page]:text-foreground',
          )}
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}

export interface NpTab<Value extends string> {
  readonly value: Value;
  readonly label: string;
  /** A count after the label, muted. */
  readonly count?: number;
}

/**
 * Tabs inside a record page (nocosolution/guidelines/frontend-standard.md §3.3), for a covering detail whose child routes are its
 * dialogs: the same underline look as `NpRouteTabs`, driven by a value (the page keeps it in `?tab=`). Arrow keys
 * move between tabs.
 */
export function NpTabBar<Value extends string>({
  tabs,
  value,
  label,
  onChange,
  idPrefix,
}: {
  readonly tabs: readonly NpTab<Value>[];
  readonly value: Value;
  readonly label: string;
  readonly onChange: (value: Value) => void;
  /** Tab ids are `${idPrefix}-tab-${value}`, panels `${idPrefix}-panel-${value}`. */
  readonly idPrefix: string;
}): ReactElement {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const index = tabs.findIndex((tab) => tab.value === value);
    const next =
      tabs[
        (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) %
          tabs.length
      ];
    event.preventDefault();
    onChange(next.value);
    document.getElementById(`${idPrefix}-tab-${next.value}`)?.focus();
  }
  return (
    <div
      role='tablist'
      aria-label={label}
      className='flex flex-wrap gap-1 border-b'
      onKeyDown={onKeyDown}
    >
      {tabs.map((tab) => {
        const selected = tab.value === value;
        return (
          <button
            key={tab.value}
            id={`${idPrefix}-tab-${tab.value}`}
            type='button'
            role='tab'
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${tab.value}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.value)}
            className={cn(
              '-mb-px inline-flex h-9 items-center gap-1.5 border-b-2 px-3 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              selected
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
            {tab.count !== undefined ? (
              <span className='text-xs font-normal text-muted-foreground tabular-nums'>
                {tab.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
