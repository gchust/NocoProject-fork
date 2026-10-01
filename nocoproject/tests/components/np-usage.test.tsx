import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import UsagePage from '../../client/pages/np/reports/usage.js';
import { type RequestOptions, renderNp } from './np-harness.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
}));

const row = (key: string, name: string, cost: number | null, runs = 1) => ({
  key,
  name,
  runs,
  inputTokens: 12_000,
  outputTokens: 800,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedCost: cost,
});

afterEach(() => api.request.mockReset());

describe('usage page', () => {
  it('groups by agent over the given range, with "—" for unpriced rows and a totals row', async () => {
    const user = userEvent.setup();
    const queries: Record<string, unknown>[] = [];
    api.request.mockImplementation((options: RequestOptions) => {
      queries.push(options.query ?? {});
      const groupBy = options.query?.groupBy;
      return Promise.resolve({
        data:
          groupBy === 'model'
            ? {
                rows: [row('claude-sonnet', 'claude-sonnet', 0.5)],
                totals: row('total', 'Total', 0.5),
              }
            : {
                rows: [
                  row('a1', 'Echo', null),
                  row('a2', 'Claude Coder', 1.25, 2),
                ],
                totals: { ...row('total', 'Total', 1.25, 3), pricedRuns: 2 },
              },
      });
    });
    await renderNp(<UsagePage />, {
      url: '/usage?from=2026-09-01&to=2026-09-27',
    });

    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row');
    // Header, the priced row first, the unpriced row, totals.
    expect(rows).toHaveLength(4);
    expect(rows[1]).toHaveTextContent('Claude Coder');
    expect(rows[1]).toHaveTextContent('$1.25');
    expect(rows[2]).toHaveTextContent('Echo');
    expect(rows[2]).toHaveTextContent('—');
    expect(rows[3]).toHaveTextContent('Total');
    expect(
      within(rows[1]).getByRole('link', { name: 'Claude Coder' }),
    ).toHaveAttribute('href', '/agents/a2');
    expect(screen.getByText(/covers 2 of 3 runs/)).toBeInTheDocument();
    expect(queries[0]).toMatchObject({
      from: '2026-09-01',
      to: '2026-09-27',
      groupBy: 'agent',
    });

    await user.click(screen.getByRole('tab', { name: 'Model' }));
    await waitFor(() =>
      expect(queries.at(-1)).toMatchObject({
        groupBy: 'model',
        from: '2026-09-01',
      }),
    );
    expect(await screen.findByText('claude-sonnet')).toBeInTheDocument();
  });

  it('groups by agent type and filters by type (NP-219 §8)', async () => {
    const user = userEvent.setup();
    const queries: Record<string, unknown>[] = [];
    api.request.mockImplementation((options: RequestOptions) => {
      queries.push(options.query ?? {});
      return Promise.resolve({
        data: {
          rows: [
            row('builtin', 'builtin', 0.2),
            row('computer', 'computer', 1),
          ],
          totals: row('total', 'Total', 1.2, 2),
        },
      });
    });
    await renderNp(<UsagePage />, {
      url: '/usage?from=2026-09-01&to=2026-09-27&groupBy=runtimeType',
    });
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Computer agent')).toBeInTheDocument();
    expect(within(table).getByText('Built-in agent')).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Type' }));
    await user.click(
      await screen.findByRole('option', { name: 'Built-in agent' }),
    );
    await waitFor(() =>
      expect(queries.at(-1)).toEqual(
        expect.objectContaining({
          groupBy: 'runtimeType',
          runtimeType: 'builtin',
        }),
      ),
    );
  });
});
