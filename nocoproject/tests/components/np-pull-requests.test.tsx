import { ApiClientError } from '@nocobase/app-client';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PullRequestsSection } from '../../client/pages/np/issues/detail/pull-requests-section.js';
import type { IssuePullRequestView } from '../../client/pages/np/types.js';
import { GITHUB_ERRORS, answer, renderNp } from './np-harness.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));
const toast = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock('@/components/ui/toast', () => ({ toast }));
vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
}));

const base = {
  repo: 'acme/app',
  url: 'https://github.com/acme/app/pull/1',
  headRef: 'agent/claude/np-1',
  baseRef: 'main',
  authorLogin: 'octocat',
  additions: 12,
  deletions: 3,
  changedFiles: 2,
  autoCompleteDisabled: false,
};

const PRS: IssuePullRequestView[] = [
  {
    ...base,
    id: 'pr1',
    number: 1,
    title: 'Add the claim endpoint',
    state: 'open',
    draft: false,
    ciState: 'failure',
    mergeableState: 'dirty',
  },
  {
    ...base,
    id: 'pr2',
    number: 2,
    title: 'Try another approach',
    state: 'open',
    draft: true,
    ciState: 'pending',
    mergeableState: null,
  },
  {
    ...base,
    id: 'pr3',
    number: 3,
    title: 'Docs',
    state: 'merged',
    draft: false,
    ciState: 'success',
    mergeableState: 'clean',
    autoCompleteDisabled: true,
  },
];

afterEach(() => {
  api.request.mockReset();
  toast.add.mockReset();
});

function apiError(code: string, status: number) {
  return new ApiClientError(code, {
    status,
    code,
    payload: { code, message: code },
    method: 'POST',
    url: 'np/issues/101/pull-requests',
  });
}

describe('pull request cards', () => {
  it('shows state, size, CI, mergeability, author and branch for each PR', async () => {
    await renderNp(<PullRequestsSection issueId='101' pullRequests={PRS} />);
    const cards = screen.getAllByTestId('np-pr-card');
    expect(cards).toHaveLength(3);

    const open = within(cards[0]);
    expect(open.getByText('Open')).toBeInTheDocument();
    expect(
      open.getByRole('link', { name: /acme\/app#1 Add the claim endpoint/ }),
    ).toHaveAttribute('href', 'https://github.com/acme/app/pull/1');
    expect(open.getByText('+12')).toBeInTheDocument();
    expect(open.getByText('Failing')).toBeInTheDocument();
    expect(open.getByText('Conflicts')).toBeInTheDocument();
    expect(open.getByText('octocat')).toBeInTheDocument();
    expect(open.getByText('agent/claude/np-1 → main')).toBeInTheDocument();

    expect(within(cards[1]).getByText('Draft')).toBeInTheDocument();
    expect(within(cards[1]).getByText('Running')).toBeInTheDocument();
    expect(within(cards[2]).getByText('Merged')).toBeInTheDocument();
    expect(within(cards[2]).getByText('Passing')).toBeInTheDocument();
    expect(
      within(cards[2]).getByRole('switch', { name: /pull request #3/ }),
    ).not.toBeChecked();
  });

  it('turns auto-complete off for one link, refreshes and unlinks', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      answer({
        'PATCH np/issues/101/pull-requests/pr1': { data: {} },
        'POST np/issues/101/pull-requests/pr1/refresh': { data: {} },
        'DELETE np/issues/101/pull-requests/pr1': { data: { ok: true } },
      }),
    );
    await renderNp(<PullRequestsSection issueId='101' pullRequests={PRS} />);
    const card = within(screen.getAllByTestId('np-pr-card')[0]);

    await user.click(card.getByRole('switch', { name: /pull request #1/ }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'PATCH',
          path: 'np/issues/101/pull-requests/pr1',
          json: { autoCompleteDisabled: true },
        }),
      ),
    );
    await user.click(card.getByRole('button', { name: 'Refresh' }));
    await user.click(card.getByRole('button', { name: 'Unlink' }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'DELETE',
          path: 'np/issues/101/pull-requests/pr1',
        }),
      ),
    );
  });

  it('links a PR by URL after checking it looks like one', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      answer({ 'POST np/issues/101/pull-requests': { data: {} } }),
    );
    await renderNp(<PullRequestsSection issueId='101' pullRequests={[]} />);
    expect(screen.getByText(/No pull requests yet/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Link PR by URL' }));
    const input = await screen.findByRole('textbox', {
      name: 'Pull request URL',
    });
    await user.type(input, 'https://github.com/acme/app/issues/4');
    await user.click(screen.getByRole('button', { name: 'Link' }));
    expect(
      await screen.findByText(/Enter a pull request URL/),
    ).toBeInTheDocument();
    expect(api.request).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, 'https://github.com/acme/app/pull/4');
    await user.click(screen.getByRole('button', { name: 'Link' }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          path: 'np/issues/101/pull-requests',
          json: { url: 'https://github.com/acme/app/pull/4' },
        }),
      ),
    );
  });
});

describe('GitHub failures on refresh and link (NP-133)', () => {
  it.each(GITHUB_ERRORS)(
    'refresh failing with %s says why',
    async (code, status, message) => {
      const user = userEvent.setup();
      api.request.mockImplementation(
        answer({
          'POST np/issues/101/pull-requests/pr1/refresh': () =>
            Promise.reject(apiError(code, status)),
        }),
      );
      await renderNp(<PullRequestsSection issueId='101' pullRequests={PRS} />);
      const card = within(screen.getAllByTestId('np-pr-card')[0]!);
      await user.click(card.getByRole('button', { name: 'Refresh' }));
      await waitFor(() =>
        expect(toast.add).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'error', title: message }),
        ),
      );
    },
  );

  it.each(GITHUB_ERRORS)(
    'link failing with %s says why',
    async (code, status, message) => {
      const user = userEvent.setup();
      api.request.mockImplementation(
        answer({
          'POST np/issues/101/pull-requests': () =>
            Promise.reject(apiError(code, status)),
        }),
      );
      await renderNp(
        <PullRequestsSection issueId='101' pullRequests={[]} initialLinking />,
      );
      await user.type(
        await screen.findByRole('textbox', { name: 'Pull request URL' }),
        'https://github.com/acme/private/pull/1',
      );
      await user.click(screen.getByRole('button', { name: 'Link' }));
      await waitFor(() =>
        expect(toast.add).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'error', title: message }),
        ),
      );
    },
  );
});
