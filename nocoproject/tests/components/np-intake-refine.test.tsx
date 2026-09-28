/**
 * NP-120: revising AI 整理 drafts by an instruction. The block shows only when the batch says AI can revise it; a
 * revision sends the current table (unsaved edits included), replaces the table and lists the instruction; undo puts
 * the previous table back; a failure keeps the table and the instruction.
 */
import { ApiClientError } from '@nocobase/app-client';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import NewIssuePage from '../../client/pages/np/issues/new.js';
import { answer, type RequestOptions, renderNp } from './np-harness.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));
const toast = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock('@/components/ui/toast', () => ({ toast }));
vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
  useService: () => ({ repository: () => ({ uploadOne: vi.fn() }) }),
}));

const BATCH = {
  id: 'b1',
  projectId: null,
  source: 'paste',
  parser: 'ai',
  status: 'draft',
  createdAt: new Date().toISOString(),
};

const DRAFTS = [
  { position: 1, parentPosition: null, fields: { title: 'Login form' } },
  { position: 2, parentPosition: null, fields: { title: 'Login API' } },
];

const COMMON = {
  'GET np/projects': { data: [] },
  'GET np/agents': { data: [] },
  'GET np/members': {
    data: [{ userId: 'u1', name: 'Zhou', email: null, role: 'owner' }],
  },
  'GET np/labels': { data: [] },
  'GET np/me': { data: { userId: 'u1', name: 'Zhou' } },
  'GET np/settings': { data: {} },
};

function apiError(code: string, status: number) {
  return new ApiClientError(code, {
    status,
    code,
    payload: { code, message: code },
    method: 'POST',
    url: 'np/intake/batches/b1/refine',
  });
}

async function open(
  aiRefine: boolean,
  refine?: (options: RequestOptions) => unknown,
) {
  api.request.mockImplementation(
    answer({
      ...COMMON,
      'GET np/intake/batches/b1': {
        data: { batch: BATCH, drafts: DRAFTS, attachments: [], aiRefine },
      },
      ...(refine ? { 'POST np/intake/batches/b1/refine': refine } : {}),
    }),
  );
  await renderNp(<NewIssuePage />, {
    url: '/issues/new?batch=b1',
    path: '/issues/new',
  });
  await screen.findByRole('textbox', { name: 'Row 1 Title' });
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
  toast.add.mockReset();
  vi.unstubAllGlobals();
});

describe('AI 整理: ask AI to revise the drafts (NP-120)', () => {
  it('is absent when AI cannot revise the batch', async () => {
    await open(false);
    expect(
      screen.queryByRole('region', { name: 'Ask AI to revise' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('textbox', { name: 'What to change' }),
    ).not.toBeInTheDocument();
  });

  it('sends the current table with unsaved edits, shows the revision and undoes it', async () => {
    const user = userEvent.setup();
    const sent: unknown[] = [];
    await open(true, (options) => {
      sent.push(options.json);
      return {
        data: {
          drafts: [
            {
              position: 1,
              parentPosition: null,
              fields: { title: 'Login' },
              validation: { errors: [] },
            },
          ],
        },
      };
    });
    const title = screen.getByRole('textbox', { name: 'Row 2 Title' });
    await user.clear(title);
    await user.type(title, 'Login backend');
    const revise = screen.getByRole('button', { name: 'Revise' });
    expect(revise).toBeDisabled();
    await user.type(
      screen.getByRole('textbox', { name: 'What to change' }),
      'Merge the two into one',
    );
    await user.click(revise);

    await waitFor(() =>
      expect(sent).toEqual([
        {
          instruction: 'Merge the two into one',
          drafts: [
            {
              position: 1,
              parentPosition: null,
              fields: { title: 'Login form' },
            },
            {
              position: 2,
              parentPosition: null,
              fields: { title: 'Login backend' },
            },
          ],
        },
      ]),
    );
    expect(await screen.findByText('Drafts (1)')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Row 1 Title' })).toHaveValue(
      'Login',
    );
    const history = screen.getByRole('list', { name: 'Revisions' });
    expect(
      within(history).getByText('Merge the two into one'),
    ).toBeInTheDocument();
    expect(within(history).getByText('Revised')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'What to change' })).toHaveValue(
      '',
    );
    expect(toast.add).toHaveBeenCalledWith({
      type: 'success',
      title: 'Drafts revised',
    });

    await user.click(within(history).getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Drafts (2)')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Row 2 Title' })).toHaveValue(
      'Login backend',
    );
    expect(within(history).getByText('Undone')).toBeInTheDocument();
    expect(
      within(history).queryByRole('button', { name: 'Undo' }),
    ).not.toBeInTheDocument();
  });

  it('keeps the table and the instruction when AI fails or times out', async () => {
    const user = userEvent.setup();
    let failure = apiError('AI_TIMEOUT', 504);
    await open(true, () => Promise.reject(failure));
    const box = screen.getByRole('textbox', { name: 'What to change' });
    await user.type(box, 'Split finer');
    await user.click(screen.getByRole('button', { name: 'Revise' }));
    await waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith({
        type: 'error',
        priority: 'high',
        title:
          'AI did not answer in time. With many drafts, ask for smaller changes.',
      }),
    );
    expect(box).toHaveValue('Split finer');
    expect(screen.getByText('Drafts (2)')).toBeInTheDocument();
    expect(
      screen.queryByRole('list', { name: 'Revisions' }),
    ).not.toBeInTheDocument();

    failure = apiError('AI_REFINE_FAILED', 502);
    await user.click(screen.getByRole('button', { name: 'Revise' }));
    await waitFor(() =>
      expect(toast.add).toHaveBeenLastCalledWith({
        type: 'error',
        priority: 'high',
        title: 'Could not revise the drafts. Try again.',
      }),
    );
    expect(box).toHaveValue('Split finer');
  });
});
