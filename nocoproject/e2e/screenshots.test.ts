/**
 * Screenshots of the NocoProject pages under every theme preset × colour scheme, against the preview server
 * (`scripts/preview-server.ts`, started by playwright.config.ts). Output: `output/screenshots/<page>.<preset>-<mode>.png`.
 *
 *   pnpm build && pnpm screenshots
 *
 * Environment: NP_PREVIEW_URL (http://127.0.0.1:13100/main), NP_SCREENSHOT_DIR (output/screenshots),
 * NP_SCREENSHOT_PAGES ("name=/path,name=/path"; `{issue}` and `{project}` expand to the first seeded ids),
 * NP_SCREENSHOT_THEMES ("compact-dark,compact-light,default-dark,default-light").
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { test, type BrowserContext, type Page } from '@playwright/test';

const base = (
  process.env.NP_PREVIEW_URL ?? 'http://127.0.0.1:13100/main'
).replace(/\/$/, '');
const outDir = path.resolve(
  process.env.NP_SCREENSHOT_DIR ?? 'output/screenshots',
);
const scope =
  encodeURIComponent(new URL(base).pathname.replace(/^\/+|\/+$/g, '')) || '%2F';
const ADMIN = { username: 'nocobase', password: 'admin123' };

const DEFAULT_PAGES =
  'inbox=/inbox,issues-board=/issues?view=board,issues-list=/issues?view=list,issue-detail=/issues/{issue},' +
  'project-detail=/projects/{project},my-issues=/my-issues,knowledge=/knowledge,reports=/reports,' +
  'agents=/agents,runtimes=/runtimes,pm=/pm,config-general=/config/general,' +
  // NP-185: the project manager drawer, docked beside an issue and expanded (`?pm=` opens it).
  'pm-drawer=/issues/{issue}?pm=new,pm-drawer-expanded=/issues/{issue}?pm=new&pmMode=expanded';
const pages = (process.env.NP_SCREENSHOT_PAGES ?? DEFAULT_PAGES)
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const index = entry.indexOf('=');
    return index > 0
      ? { name: entry.slice(0, index), path: entry.slice(index + 1) }
      : {
          name:
            entry.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'page',
          path: entry,
        };
  });
const themes = (
  process.env.NP_SCREENSHOT_THEMES ??
  'compact-dark,compact-light,default-dark,default-light'
)
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [preset, mode] = entry.split('-');
    return { preset, mode };
  });

test.use({ viewport: { width: 1360, height: 900 } });

async function signIn(context: BrowserContext): Promise<void> {
  const response = await context.request.post(
    `${base}/api/auth/sign-in/username`,
    {
      data: ADMIN,
      headers: { origin: new URL(base).origin },
    },
  );
  if (!response.ok())
    throw new Error(
      `sign-in failed: ${response.status()} ${await response.text()}`,
    );
}

async function firstIds(
  context: BrowserContext,
): Promise<{ issue: string; project: string }> {
  const list = async (url: string): Promise<string> => {
    const response = await context.request.get(`${base}/api${url}`);
    if (!response.ok()) return '';
    const body = (await response.json()) as { data?: unknown };
    const data = body.data;
    const items = Array.isArray(data)
      ? data
      : ((data as { items?: unknown[]; issues?: unknown[] })?.items ??
        (data as { issues?: unknown[] })?.issues ??
        []);
    const first = items[0] as { id?: string } | undefined;
    return first?.id ?? '';
  };
  return {
    issue: await list('/np/issues?limit=1'),
    project: await list('/np/projects'),
  };
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  // Tooling tsconfig has no DOM lib; the callback runs in the browser.
  await page.evaluate('document.fonts.ready.then(() => true)');
  await page.waitForTimeout(400);
}

for (const theme of themes) {
  test(`${theme.preset} · ${theme.mode}`, async ({ browser }) => {
    const context = await browser.newContext({
      colorScheme: theme.mode === 'dark' ? 'dark' : 'light',
    });
    await context.addInitScript(
      ({ scope, preset, mode }) => {
        localStorage.setItem(`nocobase:${scope}:theme:preset`, preset);
        localStorage.setItem(`nocobase:${scope}:theme:color-scheme`, mode);
      },
      { scope, preset: theme.preset, mode: theme.mode },
    );
    await signIn(context);
    const ids = await firstIds(context);
    mkdirSync(outDir, { recursive: true });
    const page = await context.newPage();
    for (const target of pages) {
      const url = target.path
        .replace('{issue}', ids.issue)
        .replace('{project}', ids.project);
      if (url.includes('{')) continue;
      await page.goto(`${base}${url}`);
      await settle(page);
      const file = path.join(
        outDir,
        `${target.name}.${theme.preset}-${theme.mode}.png`,
      );
      await page.screenshot({ path: file });
      console.log(`screenshot ${path.relative(process.cwd(), file)}`);
    }
    await context.close();
  });
}
