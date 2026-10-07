import { useTranslation } from '@nocobase/i18n/client';
import { X } from 'lucide-react';
import {
  useEffect,
  type ComponentProps,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';

import { Button } from '@/components/ui/button';
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { useSidebarPreference } from '../use-sidebar-preference.js';
import { AppBrand } from './app-brand.js';

/*
 * NocoProject (NP-236): the App, Settings and Dev layouts' sidebar is the shadcn `Sidebar` instead of the template's own
 * dialog-based container. The provider wraps a layout's whole row, so the sidebar, the header toggle and the navigation
 * read one state: the desktop icon mode (`collapsible='icon'`) follows the origin-wide `useSidebarPreference`, and below
 * `md` the sidebar is the primitive's sheet, local to the layout.
 *
 * Width: the owner asked in NP-236 to keep the sidebar as wide as before, so the expanded width is the template's `w-64`
 * (`--spacing` × 64: 12.8rem under the compact preset, 16rem under the default one) instead of the primitive's fixed
 * 16rem — a deliberate exception to frontend standard §4.3. The icon rail keeps the primitive's 3rem.
 */
const SIDEBAR_STYLE = {
  '--sidebar-width': 'calc(var(--spacing) * 64)',
} as CSSProperties;

/** The sidebar context of a layout; renders the row (`flex`, full viewport height) its sidebar and content sit in. */
export function LayoutSidebarProvider({
  className,
  style,
  children,
  ...props
}: ComponentProps<'div'>): ReactElement {
  const [collapsed, setCollapsed] = useSidebarPreference();
  return (
    <SidebarProvider
      open={!collapsed}
      onOpenChange={(open) => setCollapsed(!open)}
      // Global shortcuts are registered once by `NpShortcuts` (frontend standard §13), and ⌘B is Bold in the editor.
      keyboardShortcut={false}
      // The primitive's width and position transitions honour reduced motion (frontend standard §12).
      className={cn(
        'h-svh min-h-0 bg-background motion-reduce:[&_[data-slot^=sidebar]]:transition-none',
        className,
      )}
      style={{ ...SIDEBAR_STYLE, ...style }}
      {...props}
    >
      {children}
    </SidebarProvider>
  );
}

export interface LayoutSidebarProps {
  readonly 'aria-label': string;
  /** The layout's navigation, scrolled between the brand and the footer. */
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}

/** The sidebar: the brand (and the sheet's close button) above the layout's navigation and footer. */
export function LayoutSidebar({
  'aria-label': label,
  children,
  footer,
}: LayoutSidebarProps): ReactElement {
  const { t } = useTranslation();
  const { isMobile, state, openMobile, setOpenMobile } = useSidebar();
  // Widening the window past `md` closes the sheet, so it does not reappear when the window narrows again.
  useEffect(() => {
    if (!isMobile && openMobile) setOpenMobile(false);
  }, [isMobile, openMobile, setOpenMobile]);
  return (
    // The icon mode's labels show at once; page tooltips keep their own delay.
    <TooltipProvider>
      <Sidebar
        collapsible='icon'
        role='complementary'
        aria-label={label}
        mobileTitle={label}
      >
        <SidebarHeader className='h-16 shrink-0 flex-row items-center justify-between gap-2 overflow-hidden border-b border-sidebar-border/70 px-5 py-0 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0'>
          <AppBrand compact={!isMobile && state === 'collapsed'} />
          {isMobile ? (
            <Button
              aria-label={t('navigation.close', {
                defaultValue: 'Close navigation',
              })}
              className='hover:bg-sidebar-accent dark:hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:border-sidebar-ring focus-visible:ring-sidebar-ring'
              onClick={() => setOpenMobile(false)}
              size='icon'
              variant='ghost'
            >
              <X />
            </Button>
          ) : null}
        </SidebarHeader>
        <SidebarContent>{children}</SidebarContent>
        {footer}
      </Sidebar>
    </TooltipProvider>
  );
}

/** The header button: opens the sheet below `md`, and collapses the sidebar to icons or expands it above. */
export function LayoutSidebarTrigger(): ReactElement {
  const { t } = useTranslation();
  const { isMobile, state } = useSidebar();
  const collapsed = state === 'collapsed';
  const label = isMobile
    ? t('navigation.open', { defaultValue: 'Open navigation' })
    : collapsed
      ? t('navigation.expand', { defaultValue: 'Expand navigation' })
      : t('navigation.collapse', { defaultValue: 'Collapse navigation' });
  return (
    <SidebarTrigger
      aria-label={label}
      aria-pressed={isMobile ? undefined : collapsed}
      className='size-9 rounded-xl text-muted-foreground hover:text-foreground'
      size='icon'
    />
  );
}
