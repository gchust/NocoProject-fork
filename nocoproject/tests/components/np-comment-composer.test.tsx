import './np-editor-dom.js';

import { I18nRuntime } from '@nocobase/i18n';
import { I18nProvider } from '@nocobase/i18n/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NpRichTextHandle } from '../../client/components/np-rich-text-editor.js';
import locales from '../../client/locales/index.js';
import { CommentComposer } from '../../client/pages/np/issues/detail/comment-composer.js';
import { npKeys } from '../../client/pages/np/constants.js';
import { normalizeIssueDetail } from '../../client/pages/np/detail-normalize.js';
import type {
  AgentListItem,
  ExecutorRef,
  IssueComment,
  IssueDetail,
} from '../../client/pages/np/types.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
}));

const AGENTS: AgentListItem[] = [
  {
    id: '9001',
    name: 'Claude Coder',
    runtimeId: 'r1',
    runtimeStatus: 'online',
    provider: 'claude',
  },
  {
    id: '9002',
    name: 'Open Reviewer',
    runtimeId: 'r2',
    runtimeStatus: 'offline',
    provider: 'opencode',
  },
];

const MEMBERS = [
  { userId: '42', name: 'Zhou', email: null, role: 'owner' as const },
];

const agentName = (id: string | null | undefined): string | null =>
  AGENTS.find((agent) => agent.id === id)?.name ?? null;

function routeRequests(
  onComment: (json: unknown) => unknown = () => ({
    data: { comment: { id: 'c9' }, triggered: [] },
  }),
): void {
  api.request.mockImplementation(
    (request: { path: string; json?: unknown }) => {
      if (request.path === 'np/members') {
        return Promise.resolve({ data: MEMBERS });
      }
      return Promise.resolve(onComment(request.json));
    },
  );
}

async function renderComposer({
  executor = { type: 'none', id: null },
  replyTo = null,
  queryClient = new QueryClient(),
  onSent,
}: {
  readonly executor?: ExecutorRef;
  readonly replyTo?: IssueComment | null;
  readonly queryClient?: QueryClient;
  readonly onSent?: (comment: IssueComment) => void;
} = {}) {
  const runtime = new I18nRuntime({
    defaultLocale: 'en-US',
    locales: ['en-US', 'zh-CN'],
    applicationNamespace: 'test-app',
  });
  runtime.registerApplicationNamespace('test-app', locales);
  await runtime.init('en-US');
  const editorRef = createRef<NpRichTextHandle>();
  render(
    <I18nProvider runtime={runtime}>
      <QueryClientProvider client={queryClient}>
        <CommentComposer
          issueId='101'
          executor={executor}
          agents={AGENTS}
          agentName={agentName}
          replyTo={replyTo}
          replyToName={replyTo ? 'Claude Coder' : null}
          onCancelReply={() => {}}
          editorRef={editorRef}
          onSent={onSent}
        />
      </QueryClientProvider>
    </I18nProvider>,
  );
  const textbox = await screen.findByRole('textbox', { name: 'Comment' });
  return { textbox, editorRef };
}

afterEach(() => {
  api.request.mockReset();
});

describe('comment composer (rich text)', () => {
  it('inserts a mention chip that is stored as the mention link', async () => {
    routeRequests();
    const user = userEvent.setup();
    const { textbox, editorRef } = await renderComposer();

    await user.click(textbox);
    await user.keyboard('Please @Cla');
    const listbox = await screen.findByRole('listbox', {
      name: 'People and agents',
    });
    expect(listbox).toBeVisible();
    expect(screen.queryByRole('option', { name: /Open Reviewer/ })).toBeNull();

    await user.click(screen.getByRole('option', { name: /Claude Coder/ }));

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(editorRef.current?.getMarkdown()).toBe(
      'Please [@Claude Coder](mention://agent/9001) ',
    );
    expect(textbox.querySelector('[data-np-mention]')).toHaveTextContent(
      '@Claude Coder',
    );
    expect(screen.getByTestId('np-trigger-preview')).toHaveTextContent(
      'Will trigger Claude Coder.',
    );
  });

  it('offers members too, and picks the highlighted entry with the keyboard', async () => {
    routeRequests();
    const user = userEvent.setup();
    const { textbox, editorRef } = await renderComposer();
    await screen.findByRole('textbox', { name: 'Comment' });
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'np/members' }),
      ),
    );

    await user.click(textbox);
    await user.keyboard('@');
    expect(
      await screen.findByRole('option', { name: /Zhou/ }),
    ).toBeInTheDocument();
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');

    expect(editorRef.current?.getMarkdown()).toBe(
      '[@Zhou](mention://user/42) ',
    );
    // A person's mention triggers no agent.
    expect(screen.getByTestId('np-trigger-preview')).toHaveTextContent(
      'Will not trigger any agent.',
    );
  });

  it('closes the list on Escape without inserting anything', async () => {
    routeRequests();
    const user = userEvent.setup();
    const { textbox, editorRef } = await renderComposer();

    await user.click(textbox);
    await user.keyboard('@Cl');
    expect(await screen.findByRole('listbox')).toBeVisible();
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(editorRef.current?.getMarkdown()).toBe('@Cl');
  });

  it('previews the executor for a top-level comment and nothing for /note', async () => {
    routeRequests();
    const user = userEvent.setup();
    const { textbox, editorRef } = await renderComposer({
      executor: { type: 'agent', id: '9002' },
    });
    const preview = screen.getByTestId('np-trigger-preview');

    await user.click(textbox);
    await user.keyboard('Go ahead');
    expect(preview).toHaveTextContent(
      'Will trigger Open Reviewer (the executor).',
    );

    act(() => editorRef.current?.clear());
    await user.click(textbox);
    await user.keyboard('/note just for the record');
    await waitFor(() =>
      expect(preview).toHaveTextContent(
        'Note — this comment will not trigger any agent.',
      ),
    );
  });

  it('posts Markdown with the parent id and clears the editor', async () => {
    const posted: unknown[] = [];
    routeRequests((json) => {
      posted.push(json);
      return { data: { comment: { id: 'c9' }, triggered: [] } };
    });
    const user = userEvent.setup();
    const { textbox, editorRef } = await renderComposer({
      executor: { type: 'agent', id: '9002' },
      replyTo: {
        id: 'c1',
        authorType: 'agent',
        authorId: '9001',
        content: 'Done',
        parentId: null,
        createdAt: '2026-01-01T00:00:00Z',
      },
    });

    await user.click(textbox);
    await user.keyboard('Thanks');
    expect(screen.getByTestId('np-trigger-preview')).toHaveTextContent(
      'Will trigger Claude Coder (reply to its comment).',
    );

    await user.click(screen.getByRole('button', { name: /Reply/ }));
    await waitFor(() =>
      expect(posted).toEqual([{ content: 'Thanks', parentId: 'c1' }]),
    );
    await waitFor(() => expect(editorRef.current?.getMarkdown()).toBe(''));
  });

  it('shows the posted comment in the cached detail before the refetch returns, then reports it sent', async () => {
    const posted = {
      id: 'c9',
      authorType: 'user' as const,
      authorId: '42',
      content: 'Hello',
      parentId: null,
      createdAt: '2026-01-02T00:00:00Z',
    };
    routeRequests(() => ({ data: { comment: posted, triggered: [] } }));
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      npKeys.issue('101'),
      normalizeIssueDetail({
        issue: { id: '101' } as never,
        comments: [
          {
            id: 'c1',
            authorType: 'user',
            authorId: '42',
            content: 'First',
            parentId: null,
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
      }),
    );
    // NP-132: by the time the page is told, the comment is in the cache it renders from.
    const sentWithCache: string[][] = [];
    const onSent = vi.fn(() => {
      sentWithCache.push(
        queryClient
          .getQueryData<IssueDetail>(npKeys.issue('101'))
          ?.threads.map((thread) => thread.root.id) ?? [],
      );
    });
    const user = userEvent.setup();
    const { textbox } = await renderComposer({ queryClient, onSent });

    await user.click(textbox);
    await user.keyboard('Hello');
    await user.click(screen.getByRole('button', { name: /Comment/ }));

    await waitFor(() =>
      expect(
        queryClient
          .getQueryData<IssueDetail>(npKeys.issue('101'))
          ?.threads.map((thread) => thread.root.id),
      ).toEqual(['c1', 'c9']),
    );
    expect(onSent).toHaveBeenCalledExactlyOnceWith(posted);
    expect(sentWithCache).toEqual([['c1', 'c9']]);
    expect(queryClient.getQueryState(npKeys.issue('101'))?.isInvalidated).toBe(
      true,
    );
  });

  it.each([
    ['Ctrl', '{Control>}{Enter}{/Control}'],
    ['⌘', '{Meta>}{Enter}{/Meta}'],
  ])('sends with %s + Enter', async (_name, keys) => {
    const posted: unknown[] = [];
    routeRequests((json) => {
      posted.push(json);
      return { data: { comment: { id: 'c9' }, triggered: [] } };
    });
    const user = userEvent.setup();
    const { textbox, editorRef } = await renderComposer();

    await user.click(textbox);
    await user.keyboard('Hello');
    await user.keyboard(keys);
    await waitFor(() => expect(posted).toEqual([{ content: 'Hello' }]));
    await waitFor(() => expect(editorRef.current?.getMarkdown()).toBe(''));
  });

  it('sends nothing on the shortcut while the box is empty or a mention is being picked', async () => {
    routeRequests();
    const user = userEvent.setup();
    const { textbox, editorRef } = await renderComposer();

    await user.click(textbox);
    await user.keyboard('{Control>}{Enter}{/Control}');
    await user.keyboard('@Cla');
    expect(await screen.findByRole('listbox')).toBeVisible();
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(editorRef.current?.getMarkdown()).toBe(
      '[@Claude Coder](mention://agent/9001) ',
    );
    expect(api.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
