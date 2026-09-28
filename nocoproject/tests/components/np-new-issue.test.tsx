import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NewIssueButton } from '../../client/pages/np/issues/new-issue-button.js';
import NewIssuePage from '../../client/pages/np/issues/new.js';
import {
  answer,
  type RequestOptions,
  renderNp,
  renderNpRoutes,
} from './np-harness.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));
// NP-78: the file repository manager the attachment field resolves.
const fileRepository = vi.hoisted(() => ({ uploadOne: vi.fn() }));

vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
  useService: () => ({ repository: () => fileRepository }),
}));

const AGENTS = [
  {
    id: 'a1',
    name: 'Claude Coder',
    provider: 'claude',
    runtimeId: 'r1',
    runtimeOnline: true,
    kind: 'coder',
  },
  {
    id: 'pm1',
    name: 'Project Manager',
    provider: 'opencode',
    runtimeId: 'r1',
    runtimeOnline: true,
    kind: 'manager',
  },
];

function common(
  settings: Record<string, unknown> = { defaultProcess: 'auto' },
): Record<string, unknown> {
  return {
    'GET np/projects': { data: [{ id: 'p1', name: 'Website' }] },
    'GET np/agents': { data: AGENTS },
    'GET np/members': {
      data: [{ userId: 'u1', name: 'Zhou', email: null, role: 'owner' }],
    },
    'GET np/labels': { data: [] },
    'GET np/me': { data: { userId: 'u1', name: 'Zhou' } },
    'GET np/intake/batches': { data: [] },
    'GET np/settings': { data: settings },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  api.request.mockReset();
  fileRepository.uploadOne.mockReset();
  vi.unstubAllGlobals();
});

describe('new issue dialog tabs (iteration 4 §D)', () => {
  it('remembers the last tab, and ?tab= overrides it', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(answer(common()));
    const first = await renderNp(<NewIssuePage />, {
      url: '/issues/new',
      path: '/issues/new',
    });
    expect(
      await screen.findByRole('tab', { name: 'AI draft' }),
    ).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('tab', { name: 'Manual' }));
    expect(await screen.findByRole('textbox', { name: 'Title' })).toBeVisible();
    expect(window.localStorage.getItem('nocoproject:new-issue-tab')).toBe(
      'manual',
    );
    first.unmount();

    const second = await renderNp(<NewIssuePage />, {
      url: '/issues/new',
      path: '/issues/new',
    });
    expect(await screen.findByRole('tab', { name: 'Manual' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    second.unmount();

    await renderNp(<NewIssuePage />, {
      url: '/issues/new?tab=ai',
      path: '/issues/new',
    });
    expect(
      await screen.findByRole('textbox', { name: 'Requirements' }),
    ).toBeVisible();
  });

  it('works when storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    api.request.mockImplementation(answer(common()));
    await renderNp(<NewIssuePage />, {
      url: '/issues/new',
      path: '/issues/new',
    });
    expect(
      await screen.findByRole('tab', { name: 'AI draft' }),
    ).toHaveAttribute('aria-selected', 'true');
    vi.restoreAllMocks();
  });
});

describe('new issue dialog: manual tab (iteration 4 §B, §D)', () => {
  it('starts the process at the workspace default and sends it', async () => {
    const user = userEvent.setup();
    const posted: unknown[] = [];
    api.request.mockImplementation(
      answer({
        ...common({ defaultProcess: 'design_first' }),
        'POST np/issues': (options: RequestOptions) => {
          posted.push(options.json);
          return { data: { id: '9', identifier: 'NP-9', title: 'Redesign' } };
        },
      }),
    );
    await renderNp(<NewIssuePage />, {
      url: '/issues/new?tab=manual',
      path: '/issues/new',
    });
    await user.type(
      await screen.findByRole('textbox', { name: 'Title' }),
      'Redesign',
    );
    await waitFor(() =>
      expect(
        screen.getByRole('combobox', { name: 'Process' }),
      ).toHaveTextContent('Design first'),
    );
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(posted).toEqual([
        expect.objectContaining({
          title: 'Redesign',
          process: 'design_first',
        }),
      ]),
    );
  });

  it('sends 自动 explicitly so the server classifies the issue', async () => {
    const user = userEvent.setup();
    const posted: Record<string, unknown>[] = [];
    api.request.mockImplementation(
      answer({
        ...common(),
        'POST np/issues': (options: RequestOptions) => {
          posted.push(options.json as Record<string, unknown>);
          return { data: { id: '9', identifier: 'NP-9', title: 'Fix' } };
        },
      }),
    );
    await renderNp(<NewIssuePage />, {
      url: '/issues/new?tab=manual',
      path: '/issues/new',
    });
    await user.type(
      await screen.findByRole('textbox', { name: 'Title' }),
      'Fix typo',
    );
    expect(screen.getByRole('combobox', { name: 'Process' })).toHaveTextContent(
      'Automatic',
    );
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].process).toBe('auto');
  });

  it('uploads attachments as they are chosen and sends their ids (NP-78)', async () => {
    const user = userEvent.setup();
    const posted: Record<string, unknown>[] = [];
    fileRepository.uploadOne.mockResolvedValue({
      record: {
        id: 'f1',
        disk: 'local',
        key: 'objects/f1.txt',
        filename: 'notes.txt',
        ext: 'txt',
        mimeType: 'text/plain',
        size: 5,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        contentUrl: '/uploads/np/f1.txt',
      },
      createdTargets: [],
    });
    api.request.mockImplementation(
      answer({
        ...common(),
        'POST np/issues': (options: RequestOptions) => {
          posted.push(options.json as Record<string, unknown>);
          return { data: { id: '9', identifier: 'NP-9', title: 'Fix' } };
        },
      }),
    );
    const { container } = await renderNp(<NewIssuePage />, {
      url: '/issues/new?tab=manual',
      path: '/issues/new',
    });
    await user.type(
      await screen.findByRole('textbox', { name: 'Title' }),
      'Fix typo',
    );
    const input =
      container.ownerDocument.querySelector<HTMLInputElement>(
        'input[type=file]',
      );
    expect(input).not.toBeNull();
    await user.upload(input!, new File(['hello'], 'notes.txt'));
    expect(await screen.findByText('notes.txt')).toBeVisible();
    // Pasting a file into the description uploads it as well.
    const pasted = new File(['png'], 'shot.png', { type: 'image/png' });
    fileRepository.uploadOne.mockResolvedValueOnce({
      record: {
        id: 'f2',
        disk: 'local',
        key: 'objects/f2.png',
        filename: 'shot.png',
        ext: 'png',
        mimeType: 'image/png',
        size: 3,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        contentUrl: '/uploads/np/f2.png',
      },
      createdTargets: [],
    });
    fireEvent.paste(screen.getByRole('textbox', { name: 'Description' }), {
      clipboardData: { files: [pasted], types: ['Files'] },
    });
    await waitFor(() =>
      expect(fileRepository.uploadOne).toHaveBeenCalledTimes(2),
    );
    await waitFor(() => expect(screen.getAllByText('Done')).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].attachmentIds).toEqual(['f1', 'f2']);
  });

  it('does not offer a project manager as executor', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(answer(common()));
    await renderNp(<NewIssuePage />, {
      url: '/issues/new?tab=manual',
      path: '/issues/new',
    });
    await user.click(await screen.findByRole('combobox', { name: 'Executor' }));
    expect(
      await screen.findByRole('option', { name: /Claude Coder/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: /Project Manager/ }),
    ).toBeNull();
  });
});

describe('new issue button (iteration 4 §D)', () => {
  it('is one button that opens the dialog with the list query', async () => {
    await renderNpRoutes(
      <Route path='/issues' element={<NewIssueButton />} />,
      { url: '/issues?project=p1' },
    );
    const button = screen.getByRole('button', { name: /New issue/ });
    expect(button).toHaveAttribute('href', '/issues/new?project=p1');
    expect(
      screen.queryByRole('button', { name: 'More ways to create issues' }),
    ).toBeNull();
  });
});
