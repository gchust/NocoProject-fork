import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApprovalsCard } from '../../client/pages/np/issues/detail/approvals-card.js';
import type { ApprovalRequest } from '../../client/pages/np/types.js';
import { answer, renderNp } from './np-harness.js';

const api = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('@nocobase/app-client', async (original) => ({
  ...(await original<typeof import('@nocobase/app-client')>()),
  useApiClient: () => api,
}));

const PENDING: ApprovalRequest = {
  id: 'ap1',
  issueId: '101',
  fromStatus: 'in_review',
  toStatus: 'done',
  requestedByType: 'agent',
  requestedById: 'a1',
  requestedByName: 'Claude Coder',
  approverUserIds: ['u1', 'u2'],
  status: 'pending',
  createdAt: new Date().toISOString(),
};

const MEMBERS = [
  { userId: 'u1', name: 'Zhou', email: null, role: 'owner' },
  { userId: 'u2', name: 'Li', email: null, role: 'member' },
  { userId: 'u3', name: 'Wang', email: null, role: 'member' },
];

afterEach(() => api.request.mockReset());

describe('approval card', () => {
  it('shows the change, the requester and the approvers', async () => {
    api.request.mockImplementation(
      answer({ 'GET np/members': { data: MEMBERS } }),
    );
    await renderNp(
      <ApprovalsCard
        issueId='101'
        approvals={[PENDING, { ...PENDING, id: 'old', status: 'approved' }]}
        catalog={[]}
        meUserId='u3'
      />,
    );
    const card = await screen.findByTestId('np-approval-card');
    expect(screen.getAllByTestId('np-approval-card')).toHaveLength(1);
    expect(card).toHaveTextContent('Waiting for approval');
    expect(card).toHaveTextContent('In review');
    expect(card).toHaveTextContent('Done');
    expect(card).toHaveTextContent('Claude Coder · Agent');
    await waitFor(() => expect(card).toHaveTextContent('Zhou, Li'));
  });

  it('hides approve and reject from anyone who is not an approver', async () => {
    api.request.mockImplementation(
      answer({ 'GET np/members': { data: MEMBERS } }),
    );
    await renderNp(
      <ApprovalsCard
        issueId='101'
        approvals={[PENDING]}
        catalog={[]}
        meUserId='u3'
      />,
    );
    await screen.findByTestId('np-approval-card');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(
      screen.getByText('Only the listed approvers can decide.'),
    ).toBeInTheDocument();
  });

  it('lets an approver approve with a comment', async () => {
    const user = userEvent.setup();
    api.request.mockImplementation(
      answer({
        'GET np/members': { data: MEMBERS },
        'POST np/approvals/ap1/approve': {
          data: { ...PENDING, status: 'approved' },
        },
      }),
    );
    await renderNp(
      <ApprovalsCard
        issueId='101'
        approvals={[PENDING]}
        catalog={[]}
        meUserId='u2'
      />,
    );
    await user.type(
      await screen.findByRole('textbox', { name: 'Comment' }),
      'Looks good',
    );
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          path: 'np/approvals/ap1/approve',
          json: { comment: 'Looks good' },
        }),
      ),
    );
  });

  it('renders nothing without a pending request', async () => {
    const { container } = await renderNp(
      <ApprovalsCard
        issueId='101'
        approvals={[{ ...PENDING, status: 'rejected' }]}
        catalog={[]}
        meUserId='u1'
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
