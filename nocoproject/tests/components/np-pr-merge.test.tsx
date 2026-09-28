import { ApiClientError } from '@nocobase/app-client';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DecisionActionsBar } from '../../client/pages/np/inbox/decision-actions-bar.js';
import { readInboxActions } from '../../client/pages/np/inbox/decision-actions.js';
import { mergeBlockerOf } from '../../client/pages/np/issues/detail/pr-model.js';
import { PullRequestsSection } from '../../client/pages/np/issues/detail/pull-requests-section.js';
import type { IssuePullRequestView } from '../../client/pages/np/types.js';
import { answer, renderNp, type RequestOptions } from './np-harness.js';

/**
 * Merging from NocoProject (NP-85): the PR card's "Merge" button (only for whoever may merge, greyed out with the
 * reason), the confirm dialog (fresh check, squash, what happens to the issue, stale and permission errors), the CI
 * links, and the inbox's `pr_review` merge action.
 */

const api = vi.hoisted(() => ({ request: vi.fn() }));
const toast = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock('@/components/ui/toast', () => ({ toast }));
vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
}));

const PR: IssuePullRequestView = {
  id: 'pr1',
  repo: 'acme/app',
  number: 7,
  url: 'https://github.com/acme/app/pull/7',
  title: 'Add login',
  state: 'open',
  draft: false,
  headRef: 'agent/claude/np-1',
  baseRef: 'main',
  ciState: 'success',
  mergeableState: 'clean',
  autoCompleteDisabled: false,
  viewerCanMerge: true,
  ciRunUrl: 'https://github.com/acme/app/actions/runs/5',
  screenshotsUrl: 'https://github.com/acme/app/actions/runs/5/artifacts/9',
};

const PREFLIGHT = {
  blocker: null,
  method: 'squash',
  headSha: 'head1',
  baseRef: 'main',
  commitTitle: 'Add login (#7)',
  statusAfter: { statusKey: 'done', statusName: 'Done', keepReason: null },
};

const ME = {
  'GET np/me': { data: { userId: 'u1' } },
  'GET np/members': { data: [{ userId: 'u1', role: 'owner', name: 'Zhou' }] },
};

const PATH = 'np/issues/101/pull-requests/pr1/merge';

function apiError(code: string, status: number, details?: unknown) {
  return new ApiClientError(code, {
    status,
    code,
    payload: { code, message: code, ...(details ? { details } : {}) },
    method: 'POST',
    url: PATH,
  });
}

afterEach(() => {
  api.request.mockReset();
  toast.add.mockReset();
});

describe('merge button on the PR card', () => {
  it('is only there for whoever may merge an open PR', async () => {
    await renderNp(
      <PullRequestsSection
        issueId='101'
        pullRequests={[
          { ...PR, viewerCanMerge: false },
          { ...PR, id: 'pr2', number: 8, state: 'merged' },
          { ...PR, id: 'pr3', number: 9, viewerCanMerge: undefined },
        ]}
      />,
    );
    expect(screen.queryByRole('button', { name: /^Merge/ })).toBeNull();
  });

  it.each([
    [{ ciState: 'pending' as const }, 'CI is running'],
    [{ ciState: 'failure' as const }, 'CI failed'],
    [{ ciState: null }, 'No CI result'],
    [{ mergeableState: 'dirty' }, 'Has conflicts; update the branch'],
    [{ draft: true }, 'Draft'],
  ])('is greyed out with the reason for %o', async (change, reason) => {
    await renderNp(
      <PullRequestsSection
        issueId='101'
        pullRequests={[{ ...PR, ...change }]}
      />,
    );
    const card = within(screen.getByTestId('np-pr-card'));
    expect(
      card.getByRole('button', { name: 'Merge acme/app#7' }),
    ).toBeDisabled();
    expect(card.getByTestId('np-pr-merge-reason')).toHaveTextContent(reason);
  });

  it('links the screenshots artifact, else the CI run', async () => {
    await renderNp(
      <PullRequestsSection
        issueId='101'
        pullRequests={[
          PR,
          { ...PR, id: 'pr2', number: 8, screenshotsUrl: null },
          { ...PR, id: 'pr3', number: 9, screenshotsUrl: null, ciRunUrl: null },
        ]}
      />,
    );
    const [first, second, third] = screen.getAllByTestId('np-pr-card');
    expect(
      within(first!).getByRole('link', { name: /Screenshots/ }),
    ).toHaveAttribute('href', PR.screenshotsUrl);
    expect(
      within(second!).getByRole('link', { name: /CI run/ }),
    ).toHaveAttribute('href', PR.ciRunUrl);
    expect(
      within(third!).queryByRole('link', { name: /CI run|Screenshots/ }),
    ).toBeNull();
  });
});

describe('merge dialog', () => {
  async function openDialog(routes: Record<string, unknown>) {
    const user = userEvent.setup();
    api.request.mockImplementation(answer({ ...ME, ...routes }));
    await renderNp(<PullRequestsSection issueId='101' pullRequests={[PR]} />);
    await user.click(screen.getByRole('button', { name: 'Merge acme/app#7' }));
    return { user, dialog: await screen.findByRole('dialog') };
  }

  it('checks GitHub, shows the squash and the issue outcome, and merges the head it showed', async () => {
    const { user, dialog } = await openDialog({
      [`GET ${PATH}`]: { data: PREFLIGHT },
      [`POST ${PATH}`]: { data: { merged: true, sha: 'squashed' } },
    });
    const view = within(dialog);
    expect(view.getByText('Merge acme/app#7?')).toBeInTheDocument();
    expect(
      await view.findByText('Squash and merge into main.'),
    ).toBeInTheDocument();
    expect(view.getByText('Add login (#7)')).toBeInTheDocument();
    expect(view.getByTestId('np-merge-after')).toHaveTextContent(
      'The issue moves to',
    );
    await user.click(view.getByRole('button', { name: 'Squash and merge' }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          path: PATH,
          json: { expectedHeadSha: 'head1' },
        }),
      ),
    );
    await waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'success',
          title:
            'Merge requested. The issue updates when GitHub reports the merge.',
        }),
      ),
    );
  });

  it('says why it cannot merge and keeps the button off', async () => {
    const { dialog } = await openDialog({
      [`GET ${PATH}`]: {
        data: {
          ...PREFLIGHT,
          blocker: 'computing',
          statusAfter: {
            statusKey: null,
            statusName: null,
            keepReason: 'otherPrs',
          },
        },
      },
    });
    const view = within(dialog);
    expect(await view.findByTestId('np-merge-blocker')).toHaveTextContent(
      'GitHub is still checking for conflicts',
    );
    expect(view.getByTestId('np-merge-after')).toHaveTextContent(
      'other linked PRs are not merged yet',
    );
    expect(
      view.getByRole('button', { name: 'Squash and merge' }),
    ).toBeDisabled();
  });

  it('checks again when the PR changed after it was shown', async () => {
    let checks = 0;
    const { user, dialog } = await openDialog({
      [`GET ${PATH}`]: () => {
        checks += 1;
        return {
          data: { ...PREFLIGHT, headSha: checks === 1 ? 'head1' : 'head2' },
        };
      },
      [`POST ${PATH}`]: () => Promise.reject(apiError('PR_CHANGED', 409)),
    });
    const view = within(dialog);
    await view.findByText('Add login (#7)');
    await user.click(view.getByRole('button', { name: 'Squash and merge' }));
    await waitFor(() => expect(checks).toBe(2));
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        title:
          'The pull request has new commits. Check it again before merging.',
      }),
    );
  });

  it('names the missing token permissions and links admins to the settings', async () => {
    const { user, dialog } = await openDialog({
      [`GET ${PATH}`]: { data: PREFLIGHT },
      [`POST ${PATH}`]: () =>
        Promise.reject(apiError('GITHUB_MERGE_FORBIDDEN', 409)),
    });
    const view = within(dialog);
    await view.findByText('Add login (#7)');
    await user.click(view.getByRole('button', { name: 'Squash and merge' }));
    expect(
      await view.findAllByText(
        /needs write access to Contents and Pull requests/,
      ),
    ).not.toHaveLength(0);
    expect(
      view.getByRole('link', { name: 'Open GitHub settings' }),
    ).toHaveAttribute('href', '/config/github');
  });

  it('shows the blocker GitHub gave on a refused merge', async () => {
    const { user, dialog } = await openDialog({
      [`GET ${PATH}`]: { data: PREFLIGHT },
      [`POST ${PATH}`]: () =>
        Promise.reject(
          apiError('PR_NOT_MERGEABLE', 409, { blocker: 'protected' }),
        ),
    });
    const view = within(dialog);
    await view.findByText('Add login (#7)');
    await user.click(view.getByRole('button', { name: 'Squash and merge' }));
    await waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          description:
            'Branch protection does not allow the merge (review or update the branch)',
        }),
      ),
    );
  });
});

describe('pr_review merge action in the inbox', () => {
  const actions = readInboxActions({
    kind: 'decision',
    type: 'pr_review',
    issueId: '101',
    payload: {
      actions: [
        {
          key: 'merge',
          label: 'np.inboxActions.merge',
          kind: 'primary',
          method: 'POST',
          path: '/np/issues/101/pull-requests/pr1/merge',
          confirm: 'prMerge',
          pullRequestId: 'pr1',
        },
        {
          key: 'openPr',
          label: 'np.inboxActions.openPr',
          kind: 'secondary',
          method: 'GET',
          path: 'https://github.com/acme/app/pull/7',
          external: true,
        },
      ],
    },
  } as never);

  it('opens the merge dialog instead of posting', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    api.request.mockImplementation(
      answer({ ...ME, [`GET ${PATH}`]: { data: PREFLIGHT } }),
    );
    await renderNp(
      <DecisionActionsBar
        actions={actions}
        itemTitle='PR ready'
        itemType='pr_review'
        pendingKey={null}
        disabled={false}
        onRun={onRun}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Merge' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Merge the pull request?')).toBeVisible();
    await within(dialog).findByText('Add login (#7)');
    expect(onRun).not.toHaveBeenCalled();
    expect(
      api.request.mock.calls.some(
        ([options]: [RequestOptions]) => options.method === 'POST',
      ),
    ).toBe(false);
  });

  it('is greyed out with the reason the card gives', async () => {
    const [merge, ...rest] = actions;
    await renderNp(
      <DecisionActionsBar
        actions={[{ ...merge!, disabledReason: 'ciFailed' }, ...rest]}
        itemTitle='PR ready'
        pendingKey={null}
        disabled={false}
        onRun={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Merge' })).toBeDisabled();
    expect(screen.getByTestId('np-action-disabled-reason')).toHaveTextContent(
      'CI failed',
    );
    expect(screen.getByRole('button', { name: /Open PR/ })).toBeEnabled();
  });
});

describe('merge blockers from the snapshot (pure)', () => {
  it('reads merged, closed, draft, conflicts and CI in order', () => {
    const pr = {
      state: 'open' as const,
      draft: false,
      mergedAt: null,
      mergeableState: 'clean',
      ciState: 'success' as const,
    };
    expect(mergeBlockerOf(pr)).toBeNull();
    expect(mergeBlockerOf({ ...pr, state: 'merged' })).toBe('merged');
    expect(mergeBlockerOf({ ...pr, state: 'closed' })).toBe('closed');
    expect(mergeBlockerOf({ ...pr, draft: true, ciState: 'failure' })).toBe(
      'draft',
    );
    expect(mergeBlockerOf({ ...pr, mergeableState: 'dirty' })).toBe(
      'conflicts',
    );
    expect(mergeBlockerOf({ ...pr, mergeableState: null })).toBeNull();
    expect(mergeBlockerOf({ ...pr, ciState: null })).toBe('ciMissing');
  });
});
