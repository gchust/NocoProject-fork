import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NpMarkdown } from '../../client/components/np-markdown.js';
import { renderNp } from './np-harness.js';

// jsdom cannot lay out SVG, so mermaid itself is replaced: `parse` rejects sources containing "!!", `render` returns
// an SVG naming the source. The factory runs on the first `import('mermaid')`, which counts the loads.
const mermaid = vi.hoisted(() => ({
  loads: 0,
  initialize: vi.fn(),
  parse: vi.fn(async (code: string) => {
    if (code.includes('!!')) {
      throw new Error('Parse error on line 2:\n...A --> !!\n---^');
    }
    return { diagramType: 'flowchart' };
  }),
  render: vi.fn(async (id: string, code: string) => ({
    svg: `<svg id="${id}" data-testid="diagram"><text>${code.split('\n')[0]}</text></svg>`,
  })),
}));
vi.mock('mermaid', () => {
  mermaid.loads += 1;
  return { default: mermaid };
});

// A canvas that "paints" by remembering the last fill: each token value below reads back as a fixed colour.
const PAINT: Record<string, [number, number, number]> = {
  'oklch(0.955 0.005 264)': [0xf0, 0xf1, 0xf3],
  'oklch(0.25 0.008 264)': [0x22, 0x24, 0x28],
};
beforeEach(() => {
  let fill = '';
  const context = {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    set fillStyle(value: string) {
      fill = value;
    },
    get fillStyle() {
      return fill;
    },
    getImageData: () => ({ data: [...(PAINT[fill] ?? [0, 0, 0]), 255] }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  document.documentElement.style.setProperty(
    '--secondary',
    'oklch(0.955 0.005 264)',
  );
});

afterEach(() => {
  // Unmount before resetting the theme, so no diagram redraws against the real (canvas-less) jsdom.
  cleanup();
  vi.restoreAllMocks();
  mermaid.initialize.mockClear();
  mermaid.parse.mockClear();
  mermaid.render.mockClear();
  document.documentElement.classList.remove('dark');
  document.documentElement.style.removeProperty('--secondary');
});

const FLOW = '```mermaid\nflowchart TD\n  A --> B\n```';

describe('NpMarkdown mermaid blocks', () => {
  // First, while mermaid has never been imported in this file.
  it('leaves other code blocks and inline code alone and never loads mermaid for them', async () => {
    const { container } = await renderNp(
      <NpMarkdown
        content={
          'Run `pnpm test`.\n\n```ts\nconst a = 1;\n```\n\n```\nplain\n```'
        }
      />,
    );
    const blocks = container.querySelectorAll('pre > code');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toHaveClass('language-ts');
    expect(blocks[0]).toHaveTextContent('const a = 1;');
    expect(screen.getByText('pnpm test').tagName).toBe('CODE');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mermaid.loads).toBe(0);
    expect(container.querySelector('[data-mermaid]')).toBeNull();
  });

  it('draws a mermaid block as SVG with the strict configuration and the theme tokens', async () => {
    const { container } = await renderNp(
      <NpMarkdown content={`Before\n\n${FLOW}\n\nAfter`} />,
    );
    // The code shows until the diagram is drawn.
    expect(
      container.querySelector('pre > code.language-mermaid'),
    ).not.toBeNull();

    const figure = await screen.findByRole('img', {
      name: 'flowchart diagram',
    });
    expect(figure.querySelector('svg')).toHaveTextContent('flowchart TD');
    expect(container.querySelector('pre')).toBeNull();
    expect(screen.getByText('Before')).toBeInTheDocument();
    expect(screen.getByText('After')).toBeInTheDocument();
    expect(mermaid.loads).toBe(1);
    expect(mermaid.render).toHaveBeenCalledWith(
      expect.any(String),
      'flowchart TD\n  A --> B',
    );
    const config = mermaid.initialize.mock.calls.at(-1)?.[0];
    expect(config).toMatchObject({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      theme: 'base',
      darkMode: false,
      themeVariables: { primaryColor: '#f0f1f3', darkMode: false },
    });
    expect(config.secure).toEqual(
      expect.arrayContaining(['securityLevel', 'htmlLabels', 'themeCSS']),
    );
  });

  it('keeps the code and names the error when the diagram does not parse', async () => {
    const { container } = await renderNp(
      <NpMarkdown
        content={'```mermaid\nflowchart TD\n  A --> !!\n```\n\nStill here'}
      />,
    );
    expect(
      await screen.findByText('Diagram syntax error: Parse error on line 2'),
    ).toBeInTheDocument();
    expect(
      container.querySelector('pre > code.language-mermaid'),
    ).toHaveTextContent('A --> !!');
    expect(screen.queryByRole('img')).toBeNull();
    expect(mermaid.render).not.toHaveBeenCalled();
    expect(screen.getByText('Still here')).toBeInTheDocument();
  });

  it('redraws in the dark palette when the theme switches', async () => {
    await renderNp(<NpMarkdown content={FLOW} />);
    await screen.findByRole('img');
    expect(mermaid.render).toHaveBeenCalledTimes(1);

    document.documentElement.style.setProperty(
      '--secondary',
      'oklch(0.25 0.008 264)',
    );
    document.documentElement.classList.add('dark');

    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2));
    expect(mermaid.initialize.mock.calls.at(-1)?.[0]).toMatchObject({
      darkMode: true,
      themeVariables: { primaryColor: '#222428', darkMode: true },
    });
    expect(screen.getByRole('img')).toBeInTheDocument();
  });
});
