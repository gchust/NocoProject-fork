import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommentAttachment } from '../../client/pages/np/api-attachments.js';
import { ThreadCard } from '../../client/pages/np/issues/detail/comment-thread.js';
import type {
  CommentThread,
  IssueComment,
} from '../../client/pages/np/types.js';
import { renderNp } from './np-harness.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
}));

const NOW = new Date().toISOString();

function file(
  id: string,
  filename: string,
  mimeType: string,
  size: number,
  previewable = false,
): CommentAttachment {
  const ext = filename.includes('.') ? filename.split('.').pop()! : '';
  return {
    id,
    filename,
    ext,
    mimeType,
    size,
    contentUrl: `/main/uploads/np/${id}${ext ? `.${ext}` : ''}`,
    previewable,
  };
}

const SCREENSHOT = file('f1', 'login.png', 'image/png', 52_000, true);
const LOG = file('f2', 'server.log', 'text/plain', 3_400);
const REPORT = file('f3', 'report.pdf', 'application/pdf', 1_300_000);
const DRAWING = file('f4', 'chart.svg', 'image/svg+xml', 900);

function comment(
  id: string,
  attachments: readonly CommentAttachment[] | undefined,
  parentId: string | null = null,
): IssueComment {
  return {
    id,
    authorType: parentId ? 'agent' : 'user',
    authorId: parentId ? 'a1' : 'u1',
    authorName: parentId ? 'Claude Coder' : 'Zhou',
    content: `Comment ${id}`,
    parentId,
    createdAt: NOW,
    attachments,
  };
}

function renderThread(thread: CommentThread) {
  return renderNp(
    <ThreadCard
      thread={thread}
      context={{
        issueId: '101',
        meUserId: 'u1',
        agentName: () => null,
        userName: (userId) => userId,
        replyingToId: null,
        onReply: () => {},
        canReply: true,
      }}
    />,
  );
}

function filesOf(commentId: string) {
  const block = document.querySelector(`[data-comment-id="${commentId}"]`);
  if (!(block instanceof HTMLElement))
    throw new Error(`No comment ${commentId}`);
  return within(block).getByRole('group', { name: 'Attachments' });
}

afterEach(() => {
  api.request.mockReset();
  vi.unstubAllGlobals();
});

describe('comment attachments', () => {
  it('leaves a comment without files as it was', async () => {
    await renderThread({
      root: comment('c1', undefined),
      replies: [comment('c2', [], 'c1')],
    });
    expect(screen.getByText('Comment c1')).toBeInTheDocument();
    expect(screen.getByText('Comment c2')).toBeInTheDocument();
    expect(screen.queryByTestId('np-comment-attachments')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('shows an image as a thumbnail and other files with name, size and download', async () => {
    await renderThread({
      root: comment('c1', [SCREENSHOT, LOG, REPORT]),
      replies: [],
    });
    const group = filesOf('c1');

    const thumbnail = within(group).getByRole('img', { name: 'login.png' });
    expect(thumbnail).toHaveAttribute('src', SCREENSHOT.contentUrl);
    expect(
      within(group).getByRole('button', { name: 'Preview: login.png' }),
    ).toBeInTheDocument();

    expect(
      within(group).getByRole('button', { name: 'server.log' }),
    ).toBeInTheDocument();
    expect(within(group).getByText('3.3 KB')).toBeInTheDocument();
    expect(within(group).getByText('1.2 MB')).toBeInTheDocument();
    const download = within(group).getByRole('link', {
      name: 'Download: report.pdf',
    });
    expect(download).toHaveAttribute('href', REPORT.contentUrl);
    expect(download).toHaveAttribute('download', 'report.pdf');
    // Only the image is drawn inline; the other files keep an icon.
    expect(within(group).getAllByRole('img')).toHaveLength(1);
  });

  it('shows a thread reply’s files under the reply', async () => {
    await renderThread({
      root: comment('c1', undefined),
      replies: [comment('c2', [SCREENSHOT, LOG], 'c1')],
    });
    const group = filesOf('c2');
    expect(
      within(group).getByRole('img', { name: 'login.png' }),
    ).toBeInTheDocument();
    expect(
      within(group).getByRole('link', { name: 'Download: server.log' }),
    ).toBeInTheDocument();
    const root = document.querySelector('[data-comment-id="c1"]');
    expect(
      root?.querySelector('[data-testid="np-comment-attachments"]'),
    ).toBeNull();
  });

  it('previews an image full size and steps to the next file', async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('GET /api 200\nGET /api 500'));
    vi.stubGlobal('fetch', fetchMock);
    await renderThread({ root: comment('c1', [SCREENSHOT, LOG]), replies: [] });

    await user.click(
      screen.getByRole('button', { name: 'Preview: login.png' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByRole('img', { name: 'login.png' }),
    ).toHaveAttribute('src', SCREENSHOT.contentUrl);
    expect(
      within(dialog).getByRole('button', { name: 'Download: login.png' }),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Next file' }));
    expect(
      await within(dialog).findByText(/GET \/api 500/u),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      LOG.contentUrl,
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });

  it('previews a text file from its name', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('boot ok')),
    );
    await renderThread({ root: comment('c1', [LOG]), replies: [] });

    await user.click(screen.getByRole('button', { name: 'server.log' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('boot ok')).toBeInTheDocument();
  });

  it('never renders SVG content: no inline image, the preview offers the download', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    await renderThread({ root: comment('c1', [DRAWING]), replies: [] });
    const group = filesOf('c1');
    expect(within(group).queryByRole('img')).toBeNull();

    await user.click(within(group).getByRole('button', { name: 'chart.svg' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('Preview is unavailable for this file type.'),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: 'Download file' }),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole('img')).toBeNull();
    expect(dialog.querySelector('iframe, object, embed')).toBeNull();
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });
});
