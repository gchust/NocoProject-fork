import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ThreadCard } from '../../client/pages/np/issues/detail/comment-thread.js';
import type {
  CommentThread,
  IssueComment,
} from '../../client/pages/np/types.js';
import { answer, renderNp } from './np-harness.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
}));

const NOW = new Date().toISOString();

const ROOT: IssueComment = {
  id: 'c1',
  authorType: 'user',
  authorId: 'u1',
  authorName: 'Zhou',
  content: 'Can we **ship** this?',
  parentId: null,
  createdAt: NOW,
  reactions: [
    { emoji: '👍', count: 2, userIds: ['u1', 'u2'] },
    { emoji: '🎉', count: 1, userIds: ['u2'] },
  ],
};

const REPLY: IssueComment = {
  id: 'c2',
  authorType: 'agent',
  authorId: 'a1',
  authorName: 'Claude Coder',
  content: 'Yes, merged.',
  parentId: 'c1',
  createdAt: NOW,
};

const names: Record<string, string> = { u1: 'Zhou', u2: 'Li' };

function renderThread(thread: CommentThread) {
  return renderNp(
    <ThreadCard
      thread={thread}
      context={{
        issueId: '101',
        meUserId: 'u1',
        agentName: () => null,
        userName: (userId) => names[userId] ?? userId,
        replyingToId: null,
        onReply: () => {},
      }}
    />,
  );
}

afterEach(() => api.request.mockReset());

describe('reactions', () => {
  it('shows counts, marks the viewer’s own reaction and names who reacted', async () => {
    await renderThread({ root: ROOT, replies: [] });
    const mine = screen.getByRole('button', { name: '👍 2: Zhou, Li' });
    expect(mine).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '🎉 1: Li' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('removes the viewer’s reaction and adds another from the picker', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      answer({
        [`DELETE np/comments/c1/reactions/${encodeURIComponent('👍')}`]: {
          data: {},
        },
        'POST np/comments/c1/reactions': { data: {} },
      }),
    );
    await renderThread({ root: ROOT, replies: [] });

    await user.click(screen.getByRole('button', { name: '👍 2: Zhou, Li' }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'DELETE',
          path: `np/comments/c1/reactions/${encodeURIComponent('👍')}`,
        }),
      ),
    );

    await user.click(
      screen.getAllByRole('button', { name: 'Add reaction' })[0],
    );
    await user.click(await screen.findByRole('button', { name: '🚀' }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          path: 'np/comments/c1/reactions',
          json: { emoji: '🚀' },
        }),
      ),
    );
  });
});

describe('thread resolution', () => {
  it('resolves an open thread from its root comment', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      answer({ 'POST np/comments/c1/resolve': { data: {} } }),
    );
    await renderThread({ root: ROOT, replies: [REPLY] });
    // Only the root offers "resolve".
    expect(screen.getAllByRole('button', { name: 'Resolve' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Resolve' }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          path: 'np/comments/c1/resolve',
        }),
      ),
    );
  });

  it('collapses a resolved thread behind a "Resolved" chip and can reopen it', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      answer({ 'POST np/comments/c1/unresolve': { data: {} } }),
    );
    await renderThread({
      root: { ...ROOT, resolvedAt: NOW, resolvedByName: 'Li' },
      replies: [REPLY],
    });
    const collapsed = screen.getByTestId('np-thread-resolved');
    expect(collapsed).toHaveTextContent('Resolved');
    expect(collapsed).toHaveTextContent('Can we ship this?');
    expect(collapsed).toHaveTextContent('1 replies');
    expect(screen.queryByText('Yes, merged.')).toBeNull();

    await user.click(
      screen.getByRole('button', { name: /Show the resolved thread/ }),
    );
    expect(screen.getByText('Yes, merged.')).toBeInTheDocument();
    expect(screen.getByText('Resolved by Li')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reopen' }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          path: 'np/comments/c1/unresolve',
        }),
      ),
    );
  });
});
