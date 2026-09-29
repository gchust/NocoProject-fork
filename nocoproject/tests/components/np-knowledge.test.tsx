import './np-editor-dom.js';

import { ApiClientError } from '@nocobase/app-client';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import KnowledgePage from '../../client/pages/np/knowledge/index.js';
import KnowledgeDetailPage from '../../client/pages/np/knowledge/detail/index.js';
import { answer, type RequestOptions, renderNp } from './np-harness.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));
const toast = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
  useService: () => ({
    subscribe: () => () => {},
    onOpen: () => () => {},
  }),
}));
vi.mock('@/components/ui/toast', () => ({ toast }));

const NOW = new Date().toISOString();
const DOC = {
  id: 'k1',
  projectId: 'p1',
  projectName: 'Website',
  title: 'Testing conventions',
  slug: 'testing',
  summary: 'How we test',
  content: '# Testing\n\nRun `pnpm test` before pushing.',
  version: 3,
  updatedByType: 'user',
  updatedByName: 'Zhou',
  updatedAt: NOW,
  canEdit: true,
};
const PROPOSAL = {
  id: 'kp1',
  docId: 'k1',
  docTitle: 'Testing conventions',
  projectId: 'p1',
  title: '',
  content: '# Testing\n\nAlso run lint.',
  reason: 'The CI failed on lint twice.',
  proposedByAgentId: 'a1',
  proposedByAgentName: 'Claude Coder',
  sourceIssueId: '101',
  sourceIssueIdentifier: 'NP-1',
  status: 'pending',
  createdAt: NOW,
};
const COMMON = {
  'GET np/projects': {
    data: [{ id: 'p1', name: 'Website', leadUserId: 'u1' }],
  },
  'GET np/me': { data: { userId: 'u1', name: 'Zhou' } },
  'GET np/members': {
    data: [{ userId: 'u1', name: 'Zhou', email: null, role: 'member' }],
  },
  'GET np/agents': { data: [] },
};

afterEach(() => {
  api.request.mockReset();
  toast.add.mockReset();
});

describe('knowledge base (§B)', () => {
  it('lists documents with pending proposals on top and filters workspace documents', async () => {
    const user = userEvent.setup();
    const decided: string[] = [];
    api.request.mockImplementation(
      answer({
        ...COMMON,
        'GET np/knowledge': { data: [DOC] },
        'GET np/knowledge/proposals': { data: [PROPOSAL] },
        'POST np/knowledge/proposals/kp1/accept': (options: RequestOptions) => {
          decided.push(JSON.stringify(options.json));
          return { data: { ...PROPOSAL, status: 'accepted' } };
        },
      }),
    );
    await renderNp(<KnowledgePage />, { url: '/knowledge?project=workspace' });

    await user.click(
      await screen.findByRole('button', {
        name: '1 proposals await a decision',
      }),
    );
    const card = await screen.findByRole('article', {
      name: 'Proposal: Testing conventions',
    });
    expect(
      within(card).getByText('The CI failed on lint twice.'),
    ).toBeVisible();
    expect(within(card).getByRole('link', { name: 'NP-1' })).toHaveAttribute(
      'href',
      '/issues/101',
    );
    await user.click(within(card).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(decided).toEqual(['{}']));
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success' }),
    );
    // "Workspace documents" asks the server for workspace documents only.
    expect(api.request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'np/knowledge',
        query: expect.objectContaining({ projectId: 'none' }),
      }),
    );
  });

  it('shows a match excerpt when a search hit only comes from the content (NP-142)', async () => {
    api.request.mockImplementation(
      answer({
        ...COMMON,
        'GET np/knowledge': {
          data: [
            {
              ...DOC,
              matchExcerpt: '…before pushing, run the release script…',
            },
          ],
        },
        'GET np/knowledge/proposals': { data: [] },
      }),
    );
    await renderNp(<KnowledgePage />, { url: '/knowledge?q=release' });

    expect(
      await screen.findByText(/before pushing, run the release script/),
    ).toBeVisible();
  });

  it('warns and confirms before accepting a proposal that fell behind (NP-139)', async () => {
    const user = userEvent.setup();
    const staleProposal = { ...PROPOSAL, baseVersion: 2, currentVersion: 3 };
    const acceptCalls: unknown[] = [];
    api.request.mockImplementation(
      answer({
        ...COMMON,
        'GET np/knowledge': { data: [DOC] },
        'GET np/knowledge/proposals': { data: [staleProposal] },
        'POST np/knowledge/proposals/kp1/accept': (options: RequestOptions) => {
          acceptCalls.push(options.json);
          if (!(options.json as { confirmStale?: boolean })?.confirmStale) {
            throw new ApiClientError('conflict', {
              status: 409,
              code: 'KNOWLEDGE_PROPOSAL_STALE',
              method: 'POST',
              url: '/api/np/knowledge/proposals/kp1/accept',
              payload: { details: { currentVersion: 3 } },
            });
          }
          return { data: { ...staleProposal, status: 'accepted' } };
        },
      }),
    );
    await renderNp(<KnowledgePage />, { url: '/knowledge?project=workspace' });

    await user.click(
      await screen.findByRole('button', {
        name: '1 proposals await a decision',
      }),
    );
    const card = await screen.findByRole('article', {
      name: 'Proposal: Testing conventions',
    });
    expect(within(card).getByText('Based on v2 · currently v3')).toBeVisible();
    expect(within(card).getByText('Outdated')).toBeVisible();

    await user.click(within(card).getByRole('button', { name: 'Accept' }));
    expect(
      await screen.findByText('This proposal is based on an older version'),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Accept anyway' }));

    await waitFor(() =>
      expect(acceptCalls).toEqual([{}, { confirmStale: true }]),
    );
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success' }),
    );
  });

  it('shows a line diff against the current version by default, full text on demand', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      answer({
        ...COMMON,
        'GET np/knowledge': { data: [DOC] },
        'GET np/knowledge/proposals': { data: [PROPOSAL] },
        'GET np/knowledge/k1': {
          data: { doc: DOC, versions: [], proposals: [] },
        },
      }),
    );
    await renderNp(<KnowledgePage />, { url: '/knowledge?project=workspace' });

    await user.click(
      await screen.findByRole('button', {
        name: '1 proposals await a decision',
      }),
    );
    const card = await screen.findByRole('article', {
      name: 'Proposal: Testing conventions',
    });
    await user.click(
      within(card).getByRole('button', { name: 'Show proposed text' }),
    );
    expect(
      await within(card).findByText('Compared with the current version (v3)'),
    ).toBeVisible();
    expect(
      within(card).getByText('Run `pnpm test` before pushing.'),
    ).toBeVisible();
    expect(within(card).getByText('Also run lint.')).toBeVisible();

    await user.click(
      within(card).getByRole('button', { name: 'Show full text' }),
    );
    expect(
      within(card).queryByText('Run `pnpm test` before pushing.'),
    ).toBeNull();
    expect(within(card).getByText('Also run lint.')).toBeVisible();
  });

  it('compares a past version with the one before it, and any two versions by the picker (NP-142)', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      answer({
        ...COMMON,
        'GET np/knowledge/k1': {
          data: {
            doc: DOC,
            versions: [
              {
                version: 3,
                title: 'Testing conventions',
                authorType: 'user',
                authorName: 'Zhou',
                createdAt: NOW,
              },
              {
                version: 2,
                title: 'Testing conventions',
                authorType: 'agent',
                authorName: 'Claude Coder',
                proposalId: 'kp0',
                createdAt: NOW,
              },
              {
                version: 1,
                title: 'Testing conventions',
                authorType: 'user',
                authorName: 'Zhou',
                createdAt: NOW,
              },
            ],
            proposals: [],
          },
        },
        'GET np/knowledge/k1/versions/2': {
          data: {
            docId: 'k1',
            version: 2,
            title: 'x',
            authorType: 'agent',
            createdAt: NOW,
            content: 'Old text',
          },
        },
        'GET np/knowledge/k1/versions/1': {
          data: {
            docId: 'k1',
            version: 1,
            title: 'x',
            authorType: 'user',
            createdAt: NOW,
            content: 'Original text',
          },
        },
      }),
    );
    await renderNp(<KnowledgeDetailPage />, {
      url: '/knowledge/k1',
      path: '/knowledge/:docId',
    });

    expect(
      await screen.findByRole('heading', {
        name: 'Testing conventions',
        level: 1,
      }),
    ).toBeVisible();
    expect(screen.getByText(/Run/)).toBeVisible();
    const history = screen.getByRole('complementary', {
      name: 'Document details',
    });
    expect(within(history).getByText('From proposal')).toBeVisible();

    // Clicking a past version compares it with the one right before it.
    await user.click(within(history).getByRole('button', { name: /v2/ }));
    expect(await screen.findByText('Comparing v1 with v2.')).toBeVisible();
    expect(screen.getByText('Original text')).toBeVisible();
    expect(screen.getByText('Old text')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Back to current' }));
    expect(await screen.findByText(/Run/)).toBeVisible();

    // The picker compares any two versions directly.
    await user.selectOptions(
      within(history).getByRole('combobox', { name: 'Compare from version' }),
      '1',
    );
    await user.selectOptions(
      within(history).getByRole('combobox', { name: 'Compare to version' }),
      '3',
    );
    await user.click(within(history).getByRole('button', { name: 'Compare' }));
    expect(await screen.findByText('Comparing v1 with v3.')).toBeVisible();
    expect(screen.getByText('Original text')).toBeVisible();
    expect(screen.getByText(/Run `pnpm test` before pushing\./)).toBeVisible();
  });

  it('keeps the draft and says so when someone saved a newer version (409)', async () => {
    const user = userEvent.setup();
    const patches: unknown[] = [];
    api.request.mockImplementation(
      answer({
        ...COMMON,
        'GET np/knowledge/k1': {
          data: { doc: DOC, versions: [], proposals: [] },
        },
        'PATCH np/knowledge/k1': (options: RequestOptions) => {
          patches.push(options.json);
          throw new ApiClientError('conflict', {
            status: 409,
            code: 'KNOWLEDGE_VERSION_CONFLICT',
            method: 'PATCH',
            url: '/api/np/knowledge/k1',
          });
        },
      }),
    );
    await renderNp(<KnowledgeDetailPage />, {
      url: '/knowledge/k1',
      path: '/knowledge/:docId',
    });
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const title = screen.getByRole('textbox', { name: 'Title' });
    await user.clear(title);
    await user.type(title, 'Testing and linting');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(patches).toEqual([
        expect.objectContaining({
          title: 'Testing and linting',
          expectedVersion: 3,
        }),
      ]),
    );
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        title: 'Someone else saved this document',
      }),
    );
    expect(
      await screen.findByRole('button', { name: 'Load latest version' }),
    ).toBeVisible();
    // The draft is still there, and saving again is blocked until the latest version is loaded.
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue(
      'Testing and linting',
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('hides editing from someone who is neither the project lead nor an admin', async () => {
    api.request.mockImplementation(
      answer({
        ...COMMON,
        'GET np/knowledge/k1': {
          data: {
            doc: { ...DOC, canEdit: false },
            versions: [],
            proposals: [],
          },
        },
      }),
    );
    await renderNp(<KnowledgeDetailPage />, {
      url: '/knowledge/k1',
      path: '/knowledge/:docId',
    });
    await screen.findByRole('heading', {
      name: 'Testing conventions',
      level: 1,
    });
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
  });

  it('shows a table of contents once the body has 3+ headings, and scrolls to a section (NP-142)', async () => {
    Element.prototype.scrollIntoView ??= () => {};
    const user = userEvent.setup();
    const withHeadings = {
      ...DOC,
      content:
        '## Setup\n\nDo this first.\n\n## Testing\n\nRun it.\n\n## Deploy\n\nShip it.',
    };
    api.request.mockImplementation(
      answer({
        ...COMMON,
        'GET np/knowledge/k1': {
          data: { doc: withHeadings, versions: [], proposals: [] },
        },
      }),
    );
    await renderNp(<KnowledgeDetailPage />, {
      url: '/knowledge/k1',
      path: '/knowledge/:docId',
    });
    await screen.findByRole('heading', {
      name: 'Testing conventions',
      level: 1,
    });
    const tocs = screen.getAllByRole('navigation', { name: 'Contents' });
    expect(tocs.length).toBeGreaterThan(0);
    const deployLink = within(tocs[0]!).getByRole('button', {
      name: 'Deploy',
    });
    await user.click(deployLink);
    expect(document.getElementById('deploy')).not.toBeNull();
  });
});
