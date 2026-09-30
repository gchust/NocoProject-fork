import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { NpDetailLayout } from '../../client/components/np-detail-layout.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderLayout() {
  render(
    <div style={{ overflowY: 'auto' }}>
      <NpDetailLayout
        main={<p>Main</p>}
        aside={<p>Properties card</p>}
        asideLabel='Properties'
      />
    </div>,
  );
  return screen
    .getByRole('complementary', { name: 'Properties' })
    .querySelector('[data-np-aside-content]');
}

it('keeps the side column sticky below the page header on desktop widths', () => {
  const content = renderLayout();
  expect(content).toHaveClass('@3xl:sticky', '@3xl:top-0');
  expect(content).toHaveTextContent('Properties card');
  // The background stays on the stretched column, so it runs through the whole page height.
  expect(
    screen.getByRole('complementary', { name: 'Properties' }),
  ).not.toHaveClass('@3xl:sticky');
});

it('lets a side column taller than the viewport scroll with the page', () => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  // jsdom has no ResizeObserver; this one reports on observe, as browsers do.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      readonly #callback: () => void;
      constructor(callback: () => void) {
        this.#callback = callback;
      }
      observe(): void {
        this.#callback();
      }
      disconnect(): void {}
    },
  );
  const content = renderLayout();
  expect(content).not.toHaveClass('@3xl:sticky');
});
