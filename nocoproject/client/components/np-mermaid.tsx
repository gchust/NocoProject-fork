import { useTranslation } from '@nocobase/i18n/client';
import type { Mermaid, MermaidConfig } from 'mermaid';
import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';

export interface NpMermaidProps {
  /** The diagram source, the text of a ```` ```mermaid ```` block. */
  readonly code: string;
  /** The code block as `NpMarkdown` renders it otherwise: shown while mermaid loads and under a syntax error. */
  readonly fallback: ReactNode;
}

// mermaid is a large bundle, so it is only imported once a diagram mounts: pages without a mermaid block never
// request it. One promise per page; a failed load is forgotten so the next diagram tries again.
let mermaidLoad: Promise<Mermaid> | undefined;

function loadMermaid(): Promise<Mermaid> {
  mermaidLoad ??= import('mermaid').then(
    (module) => module.default,
    (error: unknown) => {
      mermaidLoad = undefined;
      throw error;
    },
  );
  return mermaidLoad;
}

// `mermaid.initialize` sets one global configuration, so renders run one at a time, each initializing with the
// theme it was asked for; concurrent diagrams would otherwise pick up each other's colours.
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

// The document's theme: `light|dark` from next-themes on `<html>` and the preset in `data-theme`.
function readTheme(): string {
  const root = document.documentElement;
  const mode = root.classList.contains('dark') ? 'dark' : 'light';
  return `${mode}:${root.dataset.theme ?? ''}`;
}

function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-theme'],
  });
  return () => observer.disconnect();
}

function useDocumentTheme(): string {
  return useSyncExternalStore(subscribeTheme, readTheme, () => 'light:');
}

/**
 * The theme's colour tokens as `#rrggbb`. mermaid's colour library cannot parse `oklch()` (every token is one) nor
 * `var()`, so each token is painted onto a 1×1 canvas over the card colour — the diagram's background, which also
 * flattens the translucent dark-mode borders — and read back. Tokens the browser cannot paint are left out and
 * mermaid derives them.
 */
function resolveTokens(names: readonly string[]): Map<string, string> {
  const resolved = new Map<string, string>();
  const context = document
    .createElement('canvas')
    .getContext('2d', { willReadFrequently: true });
  if (!context) return resolved;
  const style = getComputedStyle(document.documentElement);
  const card = style.getPropertyValue('--card').trim() || '#fff';
  for (const name of names) {
    const value = style.getPropertyValue(`--${name}`).trim();
    if (!value) continue;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = card;
    context.fillRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
    resolved.set(
      name,
      `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`,
    );
  }
  return resolved;
}

// Which design token paints which part of a diagram: neutral nodes on the card, muted lines, notes in the blue tint.
// Only tokens, no colours of our own (README §7).
const THEME_TOKENS: Readonly<Record<string, string>> = {
  background: 'card',
  primaryColor: 'secondary',
  mainBkg: 'secondary',
  nodeBkg: 'secondary',
  primaryBorderColor: 'input',
  nodeBorder: 'input',
  primaryTextColor: 'foreground',
  nodeTextColor: 'foreground',
  textColor: 'foreground',
  titleColor: 'foreground',
  secondaryColor: 'np-tint-blue',
  secondaryBorderColor: 'np-ink-blue',
  secondaryTextColor: 'foreground',
  tertiaryColor: 'muted',
  tertiaryBorderColor: 'border',
  tertiaryTextColor: 'foreground',
  lineColor: 'muted-foreground',
  defaultLinkColor: 'muted-foreground',
  arrowheadColor: 'muted-foreground',
  edgeLabelBackground: 'card',
  labelBackgroundColor: 'card',
  clusterBkg: 'muted',
  clusterBorder: 'border',
  // Sequence diagrams.
  actorBkg: 'secondary',
  actorBorder: 'input',
  actorTextColor: 'foreground',
  actorLineColor: 'muted-foreground',
  signalColor: 'muted-foreground',
  signalTextColor: 'foreground',
  labelBoxBkgColor: 'secondary',
  labelBoxBorderColor: 'input',
  labelTextColor: 'foreground',
  loopTextColor: 'foreground',
  noteBkgColor: 'np-tint-blue',
  noteBorderColor: 'np-ink-blue',
  noteTextColor: 'foreground',
  activationBkgColor: 'muted',
  activationBorderColor: 'input',
  sequenceNumberColor: 'card',
  // State diagrams.
  stateBkg: 'secondary',
  stateLabelColor: 'foreground',
  transitionColor: 'muted-foreground',
  transitionLabelColor: 'muted-foreground',
  specialStateColor: 'foreground',
  innerEndBackground: 'card',
  compositeBackground: 'muted',
  compositeTitleBackground: 'secondary',
  compositeBorder: 'border',
  altBackground: 'muted',
  errorBkgColor: 'destructive',
  errorTextColor: 'destructive',
};

function mermaidConfig(dark: boolean): MermaidConfig {
  const tokens = resolveTokens([...new Set(Object.values(THEME_TOKENS))]);
  // Flat like the rest of the interface: mermaid's base theme draws a grey drop shadow that glows in dark mode.
  const themeVariables: Record<string, string | boolean> = {
    darkMode: dark,
    dropShadow: 'none',
    useGradient: false,
  };
  for (const [variable, token] of Object.entries(THEME_TOKENS)) {
    const color = tokens.get(token);
    if (color) themeVariables[variable] = color;
  }
  const style = getComputedStyle(document.documentElement);
  const fontFamily = style.getPropertyValue('--font-sans').trim();
  if (fontFamily) themeVariables.fontFamily = fontFamily;
  // `text-sm`: 0.875 of the root size.
  themeVariables.fontSize = `${(parseFloat(style.fontSize) || 16) * 0.875}px`;
  return {
    startOnLoad: false,
    // Sanitized SVG, no `click` callbacks, no HTML inside labels.
    securityLevel: 'strict',
    htmlLabels: false,
    // A diagram's own `%%{init}%%` or front matter cannot turn HTML labels back on or replace the palette.
    secure: [
      'secure',
      'securityLevel',
      'startOnLoad',
      'maxTextSize',
      'suppressErrorRendering',
      'maxEdges',
      'htmlLabels',
      'theme',
      'themeVariables',
      'themeCSS',
      'darkMode',
    ],
    theme: 'base',
    darkMode: dark,
    themeVariables,
    // Natural size; the frame scrolls sideways instead of shrinking wide diagrams until they are unreadable.
    flowchart: { useMaxWidth: false },
    sequence: { useMaxWidth: false },
    state: { useMaxWidth: false },
  };
}

let renderCount = 0;

async function renderDiagram(code: string, dark: boolean): Promise<string> {
  const mermaid = await loadMermaid();
  return enqueue(async () => {
    mermaid.initialize(mermaidConfig(dark));
    await mermaid.parse(code);
    const id = `np-mermaid-${++renderCount}`;
    try {
      const { svg } = await mermaid.render(id, code);
      return svg;
    } finally {
      // mermaid measures in a scratch element under `<body>` and can leave it behind when rendering fails.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  });
}

function errorLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean)
      ?.replace(/:$/u, '') ?? ''
  );
}

/** The diagram type, the first word of the source (`flowchart`, `sequenceDiagram`…), for the accessible name. */
function diagramType(code: string): string {
  const line = code
    .split('\n')
    .map((text) => text.trim())
    .find((text) => text && !text.startsWith('%%') && text !== '---');
  return line?.split(/\s/u)[0] ?? 'mermaid';
}

type RenderResult =
  | { readonly svg: string; readonly error?: undefined }
  | { readonly svg?: undefined; readonly error: string };

/**
 * A ```` ```mermaid ```` block drawn as SVG, in the theme's colours and redrawn when the theme changes. Until the
 * first drawing (mermaid loading) the block shows as code; a syntax error keeps the code and adds one line naming
 * the error.
 */
export function NpMermaid({ code, fallback }: NpMermaidProps): ReactElement {
  const { t } = useTranslation();
  const theme = useDocumentTheme();
  const [result, setResult] = useState<RenderResult>();

  useEffect(() => {
    let current = true;
    renderDiagram(code, theme.startsWith('dark:')).then(
      (svg) => {
        if (current) setResult({ svg });
      },
      (error: unknown) => {
        if (current) setResult({ error: errorLine(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [code, theme]);

  if (result?.error !== undefined) {
    return (
      <div data-mermaid='error'>
        {fallback}
        <p className='-mt-1 mb-2 text-xs text-destructive'>
          {t('np.markdown.mermaidError', { message: result.error })}
        </p>
      </div>
    );
  }
  if (result?.svg === undefined) return <>{fallback}</>;
  return (
    <div
      role='img'
      aria-label={t('np.markdown.mermaidLabel', { type: diagramType(code) })}
      data-mermaid='diagram'
      className='my-2 overflow-x-auto rounded-lg border bg-card p-3 [&_svg]:max-w-none'
      // eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml -- mermaid's own SVG, DOMPurify-sanitized under `securityLevel: 'strict'` with HTML labels off
      dangerouslySetInnerHTML={{ __html: result.svg }}
    />
  );
}
