import { useTranslation } from '@nocobase/i18n/client';
import {
  routeKey,
  type RouteNavigationItem,
} from '../../routing/route-navigation.js';
import { ChevronRight } from 'lucide-react';
import { useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Link } from 'react-router';
import { EMPTY_ARRAY } from '@/lib/constants';
import { cn } from '@/lib/utils';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverTitle,
} from '@/components/ui/popover';
import {
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  useSidebar,
} from '@/components/ui/sidebar';

/*
 * NocoProject (NP-236): entries are shadcn sidebar menu items; groups are `Collapsible`s, and in the desktop icon mode
 * a group is a hover popover and a leaf has a tooltip (the primitive's own, hidden unless collapsed on the desktop).
 * The row keeps the template's size over the primitive's (nocosolution/guidelines/frontend-standard.md §2.1): muted
 * icons, the selected row in `sidebar-primary` with its icon in primary, and `relative` so an entry's trailing count
 * (the inbox badge) sits at the row's right end. In the icon mode the primitive's square button takes over.
 */
const ROW_CLASS =
  'relative h-auto data-active:bg-sidebar-primary data-active:text-sidebar-primary-foreground [&_[data-slot=nav-icon]]:text-muted-foreground data-active:[&_[data-slot=nav-icon]]:text-primary';
const SIDEBAR_ROW_CLASS = 'gap-3 px-3 py-2';
const POPOVER_ROW_CLASS = 'gap-2 px-2 py-1.5';

interface NavigationTreeProps {
  readonly labelOverride?: string;
  /** Rendered in a collapsed group's popover: always labelled, smaller rows. */
  readonly inPopover?: boolean;
  readonly item: RouteNavigationItem;
  /** Runs when an entry is followed, after the mobile sheet closes (a popover closes itself through it). */
  readonly onNavigate?: () => void;
  readonly selectedKey: string | undefined;
}

export function NavigationTree(
  props: NavigationTreeProps,
): ReactElement | null {
  // NP-185: the project manager entry (`/pm`) is the conversation history now, so it keeps its own label instead of
  // taking the conversation entry's configured name.
  return <NavigationTreeItem {...props} />;
}

function NavigationTreeItem({
  labelOverride,
  inPopover = false,
  item,
  onNavigate,
  selectedKey,
}: NavigationTreeProps): ReactElement | null {
  const { isMobile, state, setOpenMobile } = useSidebar();
  // The desktop icon mode; the mobile sheet and a popover always show labels.
  const iconMode = state === 'collapsed' && !isMobile && !inPopover;
  const restoringFocusRef = useRef(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const { t } = useTranslation(item.route.packageName);
  const label =
    labelOverride ??
    t(item.route.navigation!.title, {
      defaultValue: item.route.navigation!.title,
    });
  const isSelected = routeKey(item.route) === selectedKey;
  const children = item.children ?? EMPTY_ARRAY;
  const Icon = item.route.navigation?.icon;
  const icon = Icon ? (
    <NavigationIcon>
      <Icon />
    </NavigationIcon>
  ) : null;
  const link = item.route.componentLoader ? (
    <Link to={item.route.path} />
  ) : undefined;
  const rowClass = cn(
    inPopover ? POPOVER_ROW_CLASS : SIDEBAR_ROW_CLASS,
    ROW_CLASS,
  );

  const selected = containsSelection(item, selectedKey);
  const [disclosure, setDisclosure] = useState({
    key: selectedKey,
    expanded: selected,
  });
  // Reveal the selected route without discarding other groups' disclosure state.
  if (disclosure.key !== selectedKey) {
    setDisclosure({
      key: selectedKey,
      expanded: selected || disclosure.expanded,
    });
  }
  const expanded = disclosure.expanded;
  if (popoverOpen && !iconMode) setPopoverOpen(false);

  const navigate = () => {
    setOpenMobile(false);
    onNavigate?.();
  };

  // Collapsed groups need an interactive surface, not a tooltip containing links.
  if (iconMode && children.length > 0) {
    const close = () => {
      setPopoverOpen(false);
      navigate();
    };
    return (
      <SidebarMenuItem>
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <PopoverTrigger
            onClick={
              link
                ? (event) => {
                    event.preventBaseUIHandler();
                    close();
                  }
                : undefined
            }
            openOnHover
            delay={0}
            closeDelay={0}
            onFocus={(event) => {
              if (restoringFocusRef.current) {
                restoringFocusRef.current = false;
                return;
              }
              if (event.currentTarget.matches(':focus-visible'))
                setPopoverOpen(true);
            }}
            nativeButton={!link}
            role={link ? 'link' : undefined}
            render={
              <SidebarMenuButton
                isActive={selected}
                render={link}
                className={cn(
                  rowClass,
                  'font-medium',
                  !selected &&
                    'data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground',
                )}
              />
            }
            aria-label={label}
            aria-current={isSelected ? 'page' : undefined}
          >
            {icon ?? <span className='truncate'>{label}</span>}
          </PopoverTrigger>
          <PopoverContent
            side='right'
            align='start'
            sideOffset={8}
            initialFocus={false}
            // Returning focus after Escape must not reopen the popup.
            finalFocus={(interaction) => {
              restoringFocusRef.current = interaction === 'keyboard';
              return interaction === 'keyboard';
            }}
            className='max-h-(--available-height) w-max min-w-40 max-w-sm overflow-y-auto p-1.5 gap-0.5 border border-sidebar-border bg-sidebar text-sidebar-foreground shadow-lg'
          >
            <div className='px-2 pt-1 pb-0.5'>
              <PopoverTitle className='text-xs font-medium text-muted-foreground whitespace-nowrap'>
                {label}
              </PopoverTitle>
            </div>
            <SidebarMenu className='gap-0.5 pl-2'>
              {children.map((child) => (
                <NavigationTree
                  key={routeKey(child.route)}
                  item={child}
                  inPopover
                  onNavigate={close}
                  selectedKey={selectedKey}
                />
              ))}
            </SidebarMenu>
          </PopoverContent>
        </Popover>
      </SidebarMenuItem>
    );
  }

  if (children.length > 0) {
    const nested = (
      <CollapsibleContent>
        <SidebarMenuSub
          className={
            inPopover ? 'mx-0 mt-0.5 gap-0.5 border-l-0 px-0 py-0 pl-2' : 'mt-1'
          }
        >
          {children.map((child) => (
            <NavigationTree
              key={routeKey(child.route)}
              item={child}
              inPopover={inPopover}
              onNavigate={onNavigate}
              selectedKey={selectedKey}
            />
          ))}
        </SidebarMenuSub>
      </CollapsibleContent>
    );
    const onOpenChange = (open: boolean) =>
      setDisclosure({ key: selectedKey, expanded: open });

    // A group with a page of its own: the row follows the page, the chevron beside it toggles the group.
    if (link) {
      return (
        <Collapsible
          open={expanded}
          onOpenChange={onOpenChange}
          render={<SidebarMenuItem />}
        >
          <SidebarMenuButton
            render={link}
            isActive={isSelected}
            aria-current={isSelected ? 'page' : undefined}
            onClick={navigate}
            className={rowClass}
          >
            {icon}
            <span className='truncate'>{label}</span>
          </SidebarMenuButton>
          <CollapsibleTrigger
            aria-label={label}
            render={
              <SidebarMenuAction className='top-1/2! -translate-y-1/2 transition-transform data-panel-open:rotate-90' />
            }
          >
            <ChevronRight />
          </CollapsibleTrigger>
          {nested}
        </Collapsible>
      );
    }

    return (
      <Collapsible
        open={expanded}
        onOpenChange={onOpenChange}
        render={<SidebarMenuItem />}
      >
        <CollapsibleTrigger
          render={<SidebarMenuButton className={cn(rowClass, 'font-medium')} />}
        >
          {icon}
          <span className='truncate'>{label}</span>
          <ChevronRight className='ml-auto transition-transform group-data-panel-open/menu-button:rotate-90' />
        </CollapsibleTrigger>
        {nested}
      </Collapsible>
    );
  }

  if (!link) {
    return null;
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        render={link}
        isActive={isSelected}
        aria-current={isSelected ? 'page' : undefined}
        onClick={navigate}
        tooltip={
          inPopover
            ? undefined
            : { children: label, role: 'tooltip', sideOffset: 8 }
        }
        className={rowClass}
      >
        {icon}
        <span className='truncate'>{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function containsSelection(
  item: RouteNavigationItem,
  id: string | undefined,
): boolean {
  return (
    routeKey(item.route) === id ||
    item.children.some((child) => containsSelection(child, id))
  );
}

function NavigationIcon({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  return (
    <span
      data-slot='nav-icon'
      className='flex size-4 shrink-0 items-center justify-center [&_svg]:size-4'
    >
      {children}
    </span>
  );
}
