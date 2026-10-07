import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarSeparator,
} from '@/components/ui/sidebar';
import {
  routeKey,
  type RouteNavigationItem,
} from '../../routing/route-navigation.js';
import { NavigationTree } from './navigation-tree.js';

/**
 * The application sidebar as flat sections (nocosolution/guidelines/frontend-standard.md §2.1).
 *
 * NocoProject changes the template here on purpose: its product plan (§3.1) wants every entry always visible, so a
 * top-level group without a page of its own (Work, Agent team) is not a collapsible disclosure but a small grey section
 * label with its entries listed under it. Ungrouped entries between two groups form an unlabelled section. Groups
 * that have a page, nested groups and the Settings / Dev layouts keep `NavigationTree`'s disclosure behaviour.
 * In the desktop icon mode a label becomes a hairline so the icons stay grouped. A section is a shadcn `SidebarGroup`
 * (NP-236) whose label keeps the standard's typography.
 */
export function NavigationSections({
  items,
  selectedKey,
}: {
  readonly items: readonly RouteNavigationItem[];
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
        <SidebarGroup
          key={section.key}
          className='gap-1 p-0'
          role={section.group ? 'group' : undefined}
          aria-labelledby={
            section.group ? sectionLabelId(section.key) : undefined
          }
        >
          {section.group ? (
            <SectionLabel
              id={sectionLabelId(section.key)}
              item={section.group}
            />
          ) : null}
          <SidebarMenu className='gap-1'>
            {section.items.map((item) => (
              <NavigationTree
                item={item}
                key={routeKey(item.route)}
                selectedKey={selectedKey}
              />
            ))}
          </SidebarMenu>
        </SidebarGroup>
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
}: {
  readonly id: string;
  readonly item: RouteNavigationItem;
}): ReactElement {
  const { t } = useTranslation(item.route.packageName);
  const title = item.route.navigation?.title ?? '';
  const label = t(title, { defaultValue: title });
  return (
    <>
      <SidebarGroupLabel
        id={id}
        className='h-auto px-3 pt-1 pb-1.5 tracking-wider text-muted-foreground uppercase group-data-[collapsible=icon]:hidden'
      >
        {label}
      </SidebarGroupLabel>
      <SidebarSeparator
        aria-hidden='true'
        className='my-1 hidden group-data-[collapsible=icon]:block'
      />
    </>
  );
}
