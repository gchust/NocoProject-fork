import type { AppClientRegisteredRoute } from '@nocobase/app-client/plugins';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SidebarMenu,
  SidebarProvider,
} from '../../client/components/ui/sidebar.js';
import { TooltipProvider } from '../../client/components/ui/tooltip.js';
import {
  routeKey,
  type RouteNavigationItem,
} from '../../client/routing/route-navigation.js';
import { NavigationTree } from '../../client/layouts/components/navigation-tree.js';

vi.mock('@nocobase/i18n/client', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function page(name: string): AppClientRegisteredRoute {
  return {
    name,
    id: name,
    path: `/${name}`,
    auth: 'required',
    packageName: 'test',
    source: 'application',
    navigation: { title: name },
    componentLoader: async () => ({ default: () => null }),
  };
}

const child = page('child');
const sibling = page('sibling');

/** The tree inside the shadcn sidebar context, as `LayoutSidebar` renders it (expanded unless `collapsed`). */
function inSidebar(tree: ReactElement, collapsed = false): ReactElement {
  return (
    <MemoryRouter>
      <SidebarProvider open={!collapsed} keyboardShortcut={false}>
        <TooltipProvider>
          <SidebarMenu>{tree}</SidebarMenu>
        </TooltipProvider>
      </SidebarProvider>
    </MemoryRouter>
  );
}

/** shadcn's `useIsMobile` reads `innerWidth` (below 768px is the mobile sheet) and listens through `matchMedia`. */
function viewport(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
  });
}

beforeEach(() => {
  viewport(1024);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  viewport(1024);
});

describe.each([
  { title: 'navigation group', clickable: false },
  { title: 'clickable parent', clickable: true },
])('$title', ({ clickable }) => {
  const item: RouteNavigationItem = {
    route: {
      ...page('Group'),
      componentLoader: clickable ? page('Group').componentLoader : undefined,
    },
    children: [
      { route: child, children: [] },
      { route: sibling, children: [] },
    ],
  };
  function tree(selectedKey: string | undefined) {
    return inSidebar(<NavigationTree item={item} selectedKey={selectedKey} />);
  }
  function toggle() {
    return screen.getByRole('button', { name: 'Group' });
  }
  function expectExpanded(expanded: boolean) {
    expect(toggle()).toHaveAttribute('aria-expanded', String(expanded));
    if (expanded)
      expect(screen.getByRole('link', { name: 'child' })).toBeVisible();
    else
      expect(
        screen.queryByRole('link', { name: 'child' }),
      ).not.toBeInTheDocument();
  }

  it('renders the group as a shadcn menu item with its parent page link', () => {
    render(tree(routeKey(child)));
    expect(toggle().closest('li[data-sidebar=menu-item]')).not.toBeNull();
    expect(screen.getByRole('link', { name: 'child' })).toHaveAttribute(
      'data-active',
    );
    if (clickable)
      expect(screen.getByRole('link', { name: 'Group' })).toHaveAttribute(
        'href',
        '/Group',
      );
    else
      expect(
        screen.queryByRole('link', { name: 'Group' }),
      ).not.toBeInTheDocument();
  });

  it('keeps an active group open when navigating to another group', () => {
    const { rerender } = render(tree(routeKey(child)));
    expectExpanded(true);
    rerender(tree('elsewhere'));
    expectExpanded(true);
  });

  it('preserves a manually expanded group across navigation', async () => {
    const user = userEvent.setup();
    const { rerender } = render(tree('elsewhere'));
    await user.click(toggle());
    expectExpanded(true);
    rerender(tree('another-page'));
    expectExpanded(true);
    rerender(tree(routeKey(child)));
    rerender(tree('elsewhere'));
    expectExpanded(true);
  });

  it('preserves manual collapse until navigating into the group', async () => {
    const user = userEvent.setup();
    const { rerender } = render(tree(routeKey(child)));
    await user.click(toggle());
    expectExpanded(false);
    rerender(tree(routeKey(child)));
    expectExpanded(false);
    rerender(tree('elsewhere'));
    expectExpanded(false);
    rerender(tree(routeKey(sibling)));
    expectExpanded(true);
  });
});

describe('collapsed navigation', () => {
  function show(item: RouteNavigationItem, collapsed = true) {
    render(
      inSidebar(
        <NavigationTree item={item} selectedKey={routeKey(child)} />,
        collapsed,
      ),
    );
  }

  it('marks the selected leaf as the current page in the shadcn menu button', () => {
    show({ route: child, children: [] }, false);
    const link = screen.getByRole('link', { name: 'child' });
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(link).toHaveAttribute('data-slot', 'sidebar-menu-button');
    expect(link).toHaveAttribute('data-active');
    expect(link).toHaveClass(
      'data-active:bg-sidebar-primary',
      'data-active:text-sidebar-primary-foreground',
      'px-3',
      'py-2',
    );
  });

  it('shows a leaf label immediately on hover and dismisses it on leave', async () => {
    const user = userEvent.setup();
    show({ route: page('Home'), children: [] });
    const link = screen.getByRole('link', { name: 'Home' });
    await user.hover(link);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Home');
    expect(link).not.toHaveAttribute('title');
    await user.unhover(link);
    await waitFor(() =>
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument(),
    );
  });

  it.each([false, true])(
    'opens a group list immediately on hover (clickable parent: %s)',
    async (clickable) => {
      const user = userEvent.setup();
      show({
        route: {
          ...page('Group'),
          componentLoader: clickable
            ? page('Group').componentLoader
            : undefined,
        },
        children: [{ route: child, children: [] }],
      });
      const trigger = screen.getByRole(clickable ? 'link' : 'button', {
        name: 'Group',
      });
      fireEvent.mouseEnter(trigger);
      const popup = screen.getByRole('dialog', { name: 'Group' });
      const link = within(popup).getByRole('link', { name: 'child' });
      expect(link).toHaveAttribute('aria-current', 'page');
      expect(link).toHaveAttribute('href', '/child');
      // user-event omits mouseleave.relatedTarget; with zero close delay and
      // JSDOM's empty rectangles, safePolygon would close before pointer entry.
      fireEvent.mouseLeave(trigger, { relatedTarget: popup });
      await user.hover(popup);
      await user.click(link);
      await waitFor(() =>
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
      );
    },
  );

  it('opens on keyboard focus and closes with Escape', async () => {
    const user = userEvent.setup();
    show({
      route: { ...page('Group'), componentLoader: undefined },
      children: [{ route: child, children: [] }],
    });
    await user.tab();
    expect(await screen.findByRole('dialog', { name: 'Group' })).toBeVisible();
    await user.tab();
    expect(screen.getByRole('link', { name: 'child' })).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
  });

  it('keeps a parent link navigable and expands nested groups inside the popup', async () => {
    const user = userEvent.setup();
    show({
      route: page('Parent'),
      children: [
        {
          route: { ...page('Nested'), componentLoader: undefined },
          children: [{ route: sibling, children: [] }],
        },
      ],
    });
    const parent = screen.getByRole('link', { name: 'Parent' });
    expect(parent).toHaveAttribute('href', '/Parent');
    fireEvent.mouseEnter(parent);
    const popup = screen.getByRole('dialog', { name: 'Parent' });
    fireEvent.mouseLeave(parent, { relatedTarget: popup });
    await user.hover(popup);
    await user.click(within(popup).getByText('Nested'));
    expect(within(popup).getByRole('link', { name: 'sibling' })).toBeVisible();
    await user.click(parent);
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
  });

  it('does not reopen an old popup after expanding and collapsing the sidebar', async () => {
    const user = userEvent.setup();
    const item = {
      route: { ...page('Group'), componentLoader: undefined },
      children: [{ route: child, children: [] }],
    };
    const tree = (collapsed: boolean) =>
      inSidebar(
        <NavigationTree item={item} selectedKey={undefined} />,
        collapsed,
      );
    const { rerender } = render(tree(true));
    await user.hover(screen.getByRole('button', { name: 'Group' }));
    expect(await screen.findByRole('dialog')).toBeVisible();
    rerender(tree(false));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    rerender(tree(true));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each(['expanded', 'mobile'])(
    'does not add hover overlays when %s',
    async (mode) => {
      if (mode === 'mobile') viewport(500);
      const user = userEvent.setup();
      show({ route: page('Home'), children: [] }, mode !== 'expanded');
      await user.hover(screen.getByRole('link', { name: 'Home' }));
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    },
  );
});
