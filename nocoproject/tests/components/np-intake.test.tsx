import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import NewIssuePage from '../../client/pages/np/issues/new.js';
import { answer, type RequestOptions, renderNp } from './np-harness.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));
// NP-78: the file repository manager the attachment field resolves.
const fileRepository = vi.hoisted(() => ({ uploadOne: vi.fn() }));

vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
  useService: () => ({ repository: () => fileRepository }),
}));

const NOW = new Date().toISOString();
const BATCH = {
  id: 'b1',
  projectId: 'p1',
  projectName: 'Website',
  source: 'paste',
  parser: 'heuristic',
  status: 'draft',
  createdAt: NOW,
};

const COMMON = {
  'GET np/projects': { data: [{ id: 'p1', name: 'Website' }] },
  'GET np/agents': { data: [] },
  'GET np/members': {
    data: [{ userId: 'u1', name: 'Zhou', email: null, role: 'owner' }],
  },
  'GET np/labels': { data: [] },
  'GET np/me': { data: { userId: 'u1', name: 'Zhou' } },
  'GET np/intake/batches': { data: [] },
};

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

describe('new issue dialog: AI draft tab (iteration 4 §D)', () => {
  it('opens on the AI tab with the project preselected, drafts the text and opens the drafts', async () => {
    const user = userEvent.setup();
    const posted: unknown[] = [];
    api.request.mockImplementation(
      answer({
        ...COMMON,
        'POST np/intake/batches': (options: RequestOptions) => {
          posted.push(options.json);
          return {
            data: {
              batch: BATCH,
              parser: 'heuristic',
              drafts: [
                {
                  position: 1,
                  parentPosition: null,
                  fields: { title: 'Design the form' },
                },
              ],
            },
          };
        },
      }),
    );
    await renderNp(<NewIssuePage />, {
      url: '/issues/new?project=p1',
      path: '/issues/new',
    });
    expect(
      await screen.findByRole('dialog', { name: 'New issue' }),
    ).toBeVisible();
    expect(screen.getByRole('tab', { name: 'AI draft' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Requirements' }),
      '- Design the form',
    );
    await user.click(screen.getByRole('button', { name: 'Draft issues' }));
    await waitFor(() =>
      expect(posted).toEqual([
        { source: 'paste', rawContent: '- Design the form', projectId: 'p1' },
      ]),
    );
    expect(await screen.findByText('Drafts (1)')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Row 1 Title' })).toHaveValue(
      'Design the form',
    );
    expect(
      screen.getByRole('columnheader', { name: 'Process' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Row 1 Process' }),
    ).toHaveTextContent('Automatic');
    // A draft without a process shows the workspace default (here unset, so automatic).
  });

  it('saves the process chosen for a draft', async () => {
    const user = userEvent.setup();
    const saved: unknown[] = [];
    api.request.mockImplementation(
      answer({
        ...COMMON,
        'GET np/intake/batches/b1': {
          data: {
            batch: BATCH,
            drafts: [
              { position: 1, parentPosition: null, fields: { title: 'Login' } },
            ],
          },
        },
        'PUT np/intake/batches/b1/drafts': (options: RequestOptions) => {
          const body = options.json as { drafts: unknown[] };
          saved.push(body.drafts);
          return { data: { drafts: body.drafts } };
        },
      }),
    );
    await renderNp(<NewIssuePage />, {
      url: '/issues/new?batch=b1',
      path: '/issues/new',
    });
    await user.click(
      await screen.findByRole('combobox', { name: 'Row 1 Process' }),
    );
    await user.click(
      await screen.findByRole('option', { name: 'Design first' }),
    );
    await user.click(screen.getByRole('button', { name: 'Save drafts' }));
    await waitFor(() =>
      expect(saved).toEqual([
        [
          {
            position: 1,
            parentPosition: null,
            fields: { title: 'Login', process: 'design_first' },
          },
        ],
      ]),
    );
  });

  it('validates rows, indents to set the parent, then saves and creates the issues', async () => {
    const user = userEvent.setup();
    const saved: unknown[] = [];
    api.request.mockImplementation(
      answer({
        ...COMMON,
        'GET np/intake/batches/b1': {
          data: {
            batch: BATCH,
            drafts: [
              { position: 1, parentPosition: null, fields: { title: 'Login' } },
              { position: 2, parentPosition: null, fields: { title: '' } },
            ],
          },
        },
        'PUT np/intake/batches/b1/drafts': (options: RequestOptions) => {
          const body = options.json as { drafts: unknown[] };
          saved.push(body.drafts);
          return { data: { drafts: body.drafts } };
        },
        'POST np/intake/batches/b1/confirm': {
          data: {
            issues: [{ id: '201', identifier: 'NP-201', title: 'Login' }],
          },
        },
      }),
    );
    await renderNp(<NewIssuePage />, {
      url: '/issues/new?batch=b1',
      path: '/issues/new',
    });

    const problems = await screen.findByRole('list', {
      name: 'Problems in row 2',
    });
    expect(within(problems).getByText('Enter a title.')).toBeInTheDocument();
    const create = screen.getByRole('button', { name: 'Create 2 issues' });
    expect(create).toBeDisabled();

    await user.type(
      screen.getByRole('textbox', { name: 'Row 2 Title' }),
      'Validate email',
    );
    await user.click(
      screen.getByRole('button', {
        name: 'Make row 2 a sub-issue of the row above',
      }),
    );
    expect(
      screen.queryByRole('list', { name: 'Problems in row 2' }),
    ).toBeNull();
    expect(create).toBeEnabled();

    await user.click(create);
    await waitFor(() =>
      expect(saved).toEqual([
        [
          { position: 1, parentPosition: null, fields: { title: 'Login' } },
          {
            position: 2,
            parentPosition: 1,
            fields: { title: 'Validate email' },
          },
        ],
      ]),
    );
    expect(await screen.findByRole('link', { name: /NP-201/ })).toHaveAttribute(
      'href',
      '/issues/201',
    );
  });

  it('does not create when the server reports a problem on save', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      answer({
        ...COMMON,
        'GET np/intake/batches/b1': {
          data: {
            batch: BATCH,
            drafts: [
              { position: 1, parentPosition: null, fields: { title: 'Login' } },
            ],
          },
        },
        'PUT np/intake/batches/b1/drafts': {
          data: {
            drafts: [
              {
                position: 1,
                parentPosition: null,
                fields: { title: 'Login' },
                validation: { errors: ['You cannot invoke that agent.'] },
              },
            ],
          },
        },
      }),
    );
    await renderNp(<NewIssuePage />, {
      url: '/issues/new?batch=b1',
      path: '/issues/new',
    });
    await user.click(
      await screen.findByRole('button', { name: 'Create 1 issues' }),
    );
    expect(
      await screen.findByText('You cannot invoke that agent.'),
    ).toBeInTheDocument();
    expect(api.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: 'np/intake/batches/b1/confirm' }),
    );
  });
});

describe('AI draft tab attachments (NP-78)', () => {
  const record = (id: string, filename: string) => ({
    id,
    disk: 'local',
    key: `objects/${id}.png`,
    filename,
    ext: 'png',
    mimeType: 'image/png',
    size: 3,
    createdAt: NOW,
    updatedAt: NOW,
    contentUrl: `/uploads/np/${id}.png`,
  });

  it('uploads a file pasted into the requirements and sends it with the text', async () => {
    const user = userEvent.setup();
    const posted: Record<string, unknown>[] = [];
    fileRepository.uploadOne.mockResolvedValue({
      record: record('f1', 'shot.png'),
      createdTargets: [],
    });
    api.request.mockImplementation(
      answer({
        ...COMMON,
        'POST np/intake/batches': (options: RequestOptions) => {
          posted.push(options.json as Record<string, unknown>);
          return {
            data: {
              batch: BATCH,
              parser: 'heuristic',
              drafts: [
                {
                  position: 1,
                  parentPosition: null,
                  fields: { title: 'Fix it', attachmentIds: ['f1'] },
                },
              ],
              attachments: [{ ...record('f1', 'shot.png'), issueId: null }],
            },
          };
        },
      }),
    );
    await renderNp(<NewIssuePage />, {
      url: '/issues/new',
      path: '/issues/new',
    });
    const textbox = await screen.findByRole('textbox', {
      name: 'Requirements',
    });
    await user.type(textbox, 'Fix it');
    const pasted = new File(['png'], 'shot.png', { type: 'image/png' });
    fireEvent.paste(textbox, {
      clipboardData: { files: [pasted], types: ['Files'] },
    });
    await waitFor(() =>
      expect(fileRepository.uploadOne).toHaveBeenCalledTimes(1),
    );
    expect(fileRepository.uploadOne).toHaveBeenCalledWith(
      { file: pasted },
      expect.anything(),
    );
    // Dropping a file onto the requirements uploads it too.
    const dropped = new File(['png'], 'drop.png', { type: 'image/png' });
    fileRepository.uploadOne.mockResolvedValueOnce({
      record: record('f2', 'drop.png'),
      createdTargets: [],
    });
    fireEvent.drop(textbox, {
      dataTransfer: { files: [dropped], types: ['Files'] },
    });
    await waitFor(() =>
      expect(fileRepository.uploadOne).toHaveBeenCalledTimes(2),
    );
    // Drafting waits for the uploads.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Draft issues' }),
      ).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Draft issues' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].attachmentIds).toEqual(['f1', 'f2']);
    // The drafts show the files and the draft each one goes to.
    const files = await screen.findByRole('region', { name: /Attachments/ });
    expect(within(files).getByText('shot.png')).toBeVisible();
  });

  it('moves a batch file to another draft and saves it with the drafts', async () => {
    const user = userEvent.setup();
    const saved: unknown[] = [];
    api.request.mockImplementation(
      answer({
        ...COMMON,
        'GET np/intake/batches/b1': {
          data: {
            batch: BATCH,
            drafts: [
              {
                position: 1,
                parentPosition: null,
                fields: { title: 'Login', attachmentIds: ['f1'] },
              },
              { position: 2, parentPosition: null, fields: { title: 'Docs' } },
            ],
            attachments: [
              {
                ...record('f1', 'shot.png'),
                issueId: null,
                readStatus: { state: 'unsupported', chars: 0 },
              },
            ],
          },
        },
        'PUT np/intake/batches/b1/drafts': (options: RequestOptions) => {
          const body = options.json as { drafts: unknown[] };
          saved.push(body.drafts);
          return { data: { drafts: body.drafts } };
        },
      }),
    );
    await renderNp(<NewIssuePage />, {
      url: '/issues/new?batch=b1',
      path: '/issues/new',
    });
    // What AI 整理 read of the file is shown beside it.
    expect(
      await screen.findByText(/Not read: format not supported/u),
    ).toBeVisible();
    const target = await screen.findByRole('combobox', { name: 'Attach to' });
    expect(target).toHaveTextContent('1. Login');
    await user.click(target);
    await user.click(await screen.findByRole('option', { name: '2. Docs' }));
    await user.click(screen.getByRole('button', { name: 'Save drafts' }));
    await waitFor(() =>
      expect(saved).toEqual([
        [
          {
            position: 1,
            parentPosition: null,
            fields: { title: 'Login', attachmentIds: [] },
          },
          {
            position: 2,
            parentPosition: null,
            fields: { title: 'Docs', attachmentIds: ['f1'] },
          },
        ],
      ]),
    );
  });

  it('drafts from attached files alone, with an empty description', async () => {
    const user = userEvent.setup();
    const posted: Record<string, unknown>[] = [];
    fileRepository.uploadOne.mockResolvedValue({
      record: record('f1', 'spec.png'),
      createdTargets: [],
    });
    api.request.mockImplementation(
      answer({
        ...COMMON,
        'POST np/intake/batches': (options: RequestOptions) => {
          posted.push(options.json as Record<string, unknown>);
          return {
            data: {
              batch: BATCH,
              parser: 'ai',
              drafts: [
                { position: 1, parentPosition: null, fields: { title: 'X' } },
              ],
              attachments: [],
            },
          };
        },
      }),
    );
    await renderNp(<NewIssuePage />, {
      url: '/issues/new',
      path: '/issues/new',
    });
    const draft = await screen.findByRole('button', { name: 'Draft issues' });
    expect(draft).toBeDisabled();
    fireEvent.paste(screen.getByRole('textbox', { name: 'Requirements' }), {
      clipboardData: {
        files: [new File(['x'], 'spec.png', { type: 'image/png' })],
        types: ['Files'],
      },
    });
    await waitFor(() => expect(draft).toBeEnabled());
    await user.click(draft);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ rawContent: '', attachmentIds: ['f1'] });
  });
});
