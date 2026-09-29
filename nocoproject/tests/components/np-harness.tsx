import { I18nRuntime } from '@nocobase/i18n';
import { I18nProvider } from '@nocobase/i18n/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';

import locales from '../../client/locales/index.js';

/**
 * Renders a NocoProject component with the application locale (English), a fresh query client without retries and
 * a memory router. `path` is the route pattern the element is mounted at, `url` the location opened.
 */
export async function renderNp(
  element: ReactElement,
  {
    url = '/',
    path = '*',
  }: { readonly url?: string; readonly path?: string } = {},
): Promise<RenderResult & { readonly queryClient: QueryClient }> {
  const runtime = new I18nRuntime({
    defaultLocale: 'en-US',
    locales: ['en-US', 'zh-CN'],
    applicationNamespace: 'test-app',
  });
  runtime.registerApplicationNamespace('test-app', locales);
  await runtime.init('en-US');
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = render(
    <I18nProvider runtime={runtime}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path={path} element={element} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
  return { ...result, queryClient };
}

/**
 * Like `renderNp`, but with a route tree of its own (`<Route>` elements, nested for child routes and tabs), for
 * pages whose behavior depends on their children or on redirects.
 */
export async function renderNpRoutes(
  routes: ReactElement,
  { url = '/' }: { readonly url?: string } = {},
): Promise<RenderResult & { readonly queryClient: QueryClient }> {
  const runtime = new I18nRuntime({
    defaultLocale: 'en-US',
    locales: ['en-US', 'zh-CN'],
    applicationNamespace: 'test-app',
  });
  runtime.registerApplicationNamespace('test-app', locales);
  await runtime.init('en-US');
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = render(
    <I18nProvider runtime={runtime}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[url]}>
          <Routes>{routes}</Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
  return { ...result, queryClient };
}

export interface RequestOptions {
  readonly path: string;
  readonly method?: string;
  readonly json?: unknown;
  readonly query?: Record<string, unknown>;
}

/** An `api.request` implementation answering by `METHOD path`; unknown requests reject so a test notices them. */
export function answer(
  routes: Record<string, unknown | ((options: RequestOptions) => unknown)>,
): (options: RequestOptions) => Promise<unknown> {
  return (options) => {
    const key = `${options.method ?? 'GET'} ${options.path}`;
    if (!(key in routes)) return Promise.reject(new Error(`unexpected ${key}`));
    const value = routes[key];
    return Promise.resolve(
      typeof value === 'function'
        ? (value as (options: RequestOptions) => unknown)(options)
        : value,
    );
  };
}

/** NP-133: each GitHub error code and the sentence the PR card, the link dialog and the merge dialog show for it; the last row is any other error. */
export const GITHUB_ERRORS: readonly (readonly [string, number, string])[] = [
  [
    'GITHUB_NOT_CONFIGURED',
    409,
    'GitHub is not connected. Ask an admin to add a token in Settings → GitHub.',
  ],
  [
    'GITHUB_AUTH_FAILED',
    409,
    'GitHub rejected the token: it may have expired or been revoked, or it lacks read access to Pull requests, Checks or Commit statuses. Ask an admin to check it in Settings → GitHub.',
  ],
  [
    'GITHUB_NOT_FOUND',
    404,
    'GitHub cannot find this pull request, or the token has no access to its repository. Ask an admin to check which repositories the token can access in Settings → GitHub.',
  ],
  [
    'GITHUB_REQUEST_FAILED',
    502,
    'Could not reach GitHub. Try again later; if it keeps failing, ask an admin to check the connection in Settings → GitHub.',
  ],
  ['SOMETHING_ELSE', 500, 'The request failed. Please try again.'],
];
