import userEvent from '@testing-library/user-event';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LayoutHeader } from '../../client/layouts/components/layout-header.js';
import {
  LayoutSidebar,
  LayoutSidebarProvider,
  LayoutSidebarTrigger,
} from '../../client/layouts/components/layout-sidebar.js';

vi.mock('@nocobase/i18n/client', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));

/** shadcn's `useIsMobile` reads `innerWidth` and re-reads it on a `matchMedia` change. */
function viewport(width: number) {
  const listeners = new Set<() => void>();
  const resize = (value: number) =>
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value,
    });
  resize(width);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: (_: string, listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) =>
      listeners.delete(listener),
  }));
  return (value: number) => {
    resize(value);
    listeners.forEach((listener) => listener());
  };
}
beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 1024,
  });
});

function Shell() {
  return (
    <MemoryRouter>
      <LayoutSidebarProvider>
        <LayoutSidebar aria-label='Tools'>
          <input aria-label='Draft' defaultValue='' />
        </LayoutSidebar>
        <main>
          <LayoutSidebarTrigger />
        </main>
      </LayoutSidebarProvider>
    </MemoryRouter>
  );
}

it('renders arbitrary header content and native attributes without providers', () => {
  render(
    <LayoutHeader aria-label='Tools' className='justify-end'>
      <input aria-label='Search' />
    </LayoutHeader>,
  );
  expect(screen.getByRole('banner', { name: 'Tools' })).toHaveClass(
    'justify-end',
  );
  expect(screen.getByRole('textbox', { name: 'Search' })).toBeVisible();
});

it('collapses to icons on the desktop, keeps its content and shares the preference', () => {
  viewport(1024);
  render(<Shell />);
  const sidebar = screen.getByRole('complementary', { name: 'Tools' });
  const frame = sidebar.closest('[data-slot=sidebar]')!;
  expect(frame).toHaveAttribute('data-state', 'expanded');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'kept' } });

  fireEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }));
  expect(frame).toHaveAttribute('data-state', 'collapsed');
  expect(frame).toHaveAttribute('data-collapsible', 'icon');
  expect(
    screen.getByRole('button', { name: 'Expand navigation' }),
  ).toHaveAttribute('aria-pressed', 'true');
  expect(localStorage.getItem('nocobase:sidebar:collapsed')).toBe('true');
  expect(screen.getByRole('textbox')).toHaveValue('kept');

  fireEvent.click(screen.getByRole('button', { name: 'Expand navigation' }));
  expect(frame).toHaveAttribute('data-state', 'expanded');
  expect(localStorage.getItem('nocobase:sidebar:collapsed')).toBe('false');
});

it('opens from the saved preference collapsed', () => {
  viewport(1024);
  localStorage.setItem('nocobase:sidebar:collapsed', 'true');
  render(<Shell />);
  expect(
    screen
      .getByRole('complementary', { name: 'Tools' })
      .closest('[data-slot=sidebar]'),
  ).toHaveAttribute('data-state', 'collapsed');
});

it('leaves Cmd+B to the page', () => {
  viewport(1024);
  render(<Shell />);
  fireEvent.keyDown(window, { key: 'b', metaKey: true });
  fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
  expect(
    screen
      .getByRole('complementary', { name: 'Tools' })
      .closest('[data-slot=sidebar]'),
  ).toHaveAttribute('data-state', 'expanded');
});

it('opens a named sheet on mobile and closes it by Escape, its button and widening the window', async () => {
  const resize = viewport(500);
  const user = userEvent.setup();
  render(<Shell />);
  const open = await screen.findByRole('button', { name: 'Open navigation' });
  expect(open).not.toHaveAttribute('aria-pressed');

  await user.click(open);
  expect(await screen.findByRole('dialog', { name: 'Tools' })).toBeVisible();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

  await user.click(open);
  await user.click(
    await screen.findByRole('button', { name: 'Close navigation' }),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(open).toHaveFocus());

  await user.click(open);
  expect(await screen.findByRole('dialog', { name: 'Tools' })).toBeVisible();
  act(() => resize(1024));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  act(() => resize(500));
  expect(screen.queryByRole('dialog')).toBeNull();
});
