import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import {
  routeKey,
  type RouteNavigationItem,
} from '../../routing/route-navigation.js';
import { NavigationTree } from './navigation-tree.js';

/**
 * The application sidebar as flat sections (nocosolution/frontend/frontend-standard.md §2.1).
 *
 * NocoProject changes the template here on purpose: its product plan (§3.1) wants every entry always visible, so a
 * top-level group without a page of its own (Work, Agent team) is not a collapsible disclosure but a small grey section
 * label with its entries listed under it. Ungrouped entries between two groups form an unlabelled section. Groups
 * that have a page, nested groups and the Settings / Dev layouts keep `NavigationTree`'s disclosure behaviour.
 * In the desktop icon mode a label becomes a hairline so the icons stay grouped.
 */
export function NavigationSections({
  items,
  collapsed,
  onNavigate,
  selectedKey,
}: {
  readonly items: readonly RouteNavigationItem[];
  readonly collapsed: boolean;
  readonly onNavigate: () => void;
  readonly selectedKey: string | undefined;
}): ReactElement {
  const sections: {
    key: string;
    group: RouteNavigationItem | null;
    items: RouteNavigationItem[];
  }[] = [];
  for (const item of items) {
    const isSection = !item.route.componentLoader && item.children.length > 0;
    if (isSection) {
      sections.push({
        key: routeKey(item.route),
        group: item,
        items: item.children.slice(),
      });
      continue;
    }
    const last = sections.at(-1);
    if (last && last.group === null) last.items.push(item);
    else
      sections.push({
        key: `loose:${routeKey(item.route)}`,
        group: null,
        items: [item],
      });
  }
  return (
    <div className='flex flex-col gap-5'>
      {sections.map((section) => (
        <div
          key={section.key}
          className='flex flex-col gap-1'
          role={section.group ? 'group' : undefined}
          aria-labelledby={
            section.group ? sectionLabelId(section.key) : undefined
          }
        >
          {section.group ? (
            <SectionLabel
              id={sectionLabelId(section.key)}
              item={section.group}
              collapsed={collapsed}
            />
          ) : null}
          {section.items.map((item) => (
            <NavigationTree
              collapsed={collapsed}
              item={item}
              key={routeKey(item.route)}
              onNavigate={onNavigate}
              selectedKey={selectedKey}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function sectionLabelId(key: string): string {
  return `np-nav-section-${key.replace(/[^a-zA-Z0-9_-]/gu, '-')}`;
}

function SectionLabel({
  id,
  item,
  collapsed,
}: {
  readonly id: string;
  readonly item: RouteNavigationItem;
  readonly collapsed: boolean;
}): ReactElement {
  const { t } = useTranslation(item.route.packageName);
  const title = item.route.navigation?.title ?? '';
  const label = t(title, { defaultValue: title });
  return (
    <>
      <div
        id={id}
        className={`px-3 pt-1 pb-1.5 text-xs font-medium tracking-wider text-muted-foreground uppercase ${collapsed ? 'md:hidden' : ''}`}
      >
        {label}
      </div>
      {collapsed ? (
        <div
          aria-hidden='true'
          className='mx-2 my-1 hidden h-px bg-sidebar-border md:block'
        />
      ) : null}
    </>
  );
}
