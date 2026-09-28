import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import ProfilePage from '../../client/pages/profile/index.js';
import { renderNp } from './np-harness.js';

const auth = vi.hoisted(() => ({
  getSession: vi.fn(),
  updateUser: vi.fn(),
  changePassword: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
}));
const user = {
  id: 'member',
  name: 'Member',
  username: 'member',
  email: 'member@example.com',
};
vi.mock('@nocobase/app-plugin-authentication/client', () => ({
  useAuthentication: () => ({
    client: auth,
    refresh: auth.refresh,
    session: { user: { id: 'member' } },
  }),
}));
vi.mock('@/components/ui/toast', () => ({ toast: { add: auth.toast } }));
beforeEach(() => {
  vi.resetAllMocks();
  auth.getSession.mockResolvedValue({ data: { user } });
  auth.updateUser.mockResolvedValue({ data: { status: true } });
  auth.changePassword.mockResolvedValue({ data: {} });
  auth.refresh.mockResolvedValue(undefined);
});
async function open() {
  await renderNp(<ProfilePage />);
  await screen.findByDisplayValue('member@example.com');
}
async function passwords() {
  fireEvent.change(screen.getByLabelText('Current password *'), {
    target: { value: 'old-password' },
  });
  fireEvent.change(screen.getByLabelText('New password *'), {
    target: { value: 'new-password' },
  });
  fireEvent.change(screen.getByLabelText('Confirm new password *'), {
    target: { value: 'new-password' },
  });
}
it('loads latest profile, validates and saves a normalized username without changing email', async () => {
  await open();
  expect(auth.getSession).toHaveBeenCalledWith({
    query: { disableCookieCache: true },
  });
  expect(screen.getByLabelText('Email')).toHaveAttribute('readonly');
  const keyboard = userEvent.setup();
  const name = screen.getByLabelText('Display name *');
  await keyboard.clear(name);
  await keyboard.click(
    screen.getByRole('button', { name: 'Save', exact: true }),
  );
  expect(await screen.findByText('Enter a display name.')).toBeVisible();
  expect(name).toHaveFocus();
  expect(auth.updateUser).not.toHaveBeenCalled();
  await keyboard.type(name, 'New Name');
  fireEvent.change(screen.getByLabelText('Username *'), {
    target: { value: 'New.User' },
  });
  await keyboard.click(
    screen.getByRole('button', { name: 'Save', exact: true }),
  );
  await waitFor(() =>
    expect(auth.updateUser).toHaveBeenCalledWith({
      name: 'New Name',
      username: 'new.user',
    }),
  );
  await waitFor(() => expect(auth.refresh).toHaveBeenCalled());
  expect(screen.getByLabelText('Username *')).toHaveValue('new.user');
});
it('keeps drafts and focuses taken usernames; refresh failures do not masquerade as save failures', async () => {
  await open();
  auth.updateUser.mockResolvedValueOnce({
    error: { code: 'USERNAME_IS_ALREADY_TAKEN' },
  });
  fireEvent.change(screen.getByLabelText('Username *'), {
    target: { value: 'taken' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  expect(
    await screen.findByText('This username is taken. Choose another.'),
  ).toBeVisible();
  await waitFor(() =>
    expect(screen.getByLabelText('Username *')).toHaveFocus(),
  );
  expect(screen.getByLabelText('Username *')).toHaveValue('taken');
  auth.refresh.mockRejectedValueOnce(new Error('offline'));
  fireEvent.change(screen.getByLabelText('Username *'), {
    target: { value: 'available' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() =>
    expect(auth.toast).toHaveBeenCalledWith({
      type: 'success',
      title: 'Profile saved',
    }),
  );
  await waitFor(() =>
    expect(auth.toast).toHaveBeenCalledWith({
      type: 'error',
      title: 'Saved, but account data could not refresh. Reload the page.',
    }),
  );
});
it('rejects mismatch, preserves failed passwords, and clears them only after success', async () => {
  await open();
  await passwords();
  fireEvent.change(screen.getByLabelText('Confirm new password *'), {
    target: { value: 'mismatch' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
  expect(await screen.findByText("Passwords don't match.")).toBeVisible();
  expect(auth.changePassword).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Confirm new password *'), {
    target: { value: 'new-password' },
  });
  auth.changePassword.mockResolvedValueOnce({
    error: { code: 'INVALID_PASSWORD' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
  expect(
    await screen.findByText('The current password is incorrect. Try again.'),
  ).toBeVisible();
  await waitFor(() =>
    expect(screen.getByLabelText('Current password *')).toHaveFocus(),
  );
  expect(screen.getByLabelText('New password *')).toHaveValue('new-password');
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
  await waitFor(() =>
    expect(auth.toast).toHaveBeenCalledWith({
      type: 'success',
      title: 'Password changed',
    }),
  );
  expect(auth.changePassword).toHaveBeenLastCalledWith({
    currentPassword: 'old-password',
    newPassword: 'new-password',
    revokeOtherSessions: true,
  });
  expect(screen.getByLabelText('Current password *')).toHaveValue('');
  expect(screen.getByLabelText('New password *')).toHaveValue('');
  expect(screen.getByLabelText('Confirm new password *')).toHaveValue('');
});
it('locks the submitting form, prevents another click, and retains input on network failure', async () => {
  await open();
  await passwords();
  let reject!: (error: Error) => void;
  auth.changePassword.mockReturnValueOnce(
    new Promise((_resolve, rejectPromise) => {
      reject = rejectPromise;
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
  const pending = await screen.findByRole('button', { name: 'Saving…' });
  expect(pending).toBeDisabled();
  expect(screen.getByLabelText('Current password *')).toBeDisabled();
  fireEvent.click(pending);
  expect(auth.changePassword).toHaveBeenCalledTimes(1);
  reject(new Error('offline'));
  expect(
    await screen.findByText('Unable to save. Please try again.'),
  ).toBeVisible();
  expect(screen.getByLabelText('New password *')).toHaveValue('new-password');
});
it('offers retry after load failure and handles an expired session', async () => {
  auth.getSession.mockRejectedValueOnce(new Error('offline'));
  await renderNp(<ProfilePage />);
  expect(
    await screen.findByText('Unable to load your profile. Please retry.'),
  ).toBeVisible();
  auth.getSession.mockResolvedValueOnce({ data: null });
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(
    await screen.findByText('Your session has expired. Sign in again.'),
  ).toBeVisible();
  expect(screen.getByRole('button', { name: 'Sign in' })).toHaveAttribute(
    'href',
    '/login',
  );
});

it('preserves profile and password drafts when a background reload fails', async () => {
  const { queryClient } = await renderNp(<ProfilePage />);
  await screen.findByDisplayValue('member@example.com');
  await passwords();
  auth.getSession.mockRejectedValueOnce(new Error('offline'));
  fireEvent.change(screen.getByLabelText('Display name *'), {
    target: { value: 'Saved Name' },
  });
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ['account-profile'] });
  });
  expect(
    await screen.findByText(
      'Unable to refresh account data. Your edits are kept. Please retry.',
    ),
  ).toBeVisible();
  expect(screen.getByLabelText('Display name *')).toHaveValue('Saved Name');
  expect(screen.getByLabelText('Current password *')).toHaveValue(
    'old-password',
  );
  expect(screen.getByLabelText('New password *')).toHaveValue('new-password');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() =>
    expect(
      screen.queryByText(
        'Unable to refresh account data. Your edits are kept. Please retry.',
      ),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByLabelText('Display name *')).toHaveValue('Saved Name');
  expect(screen.getByLabelText('New password *')).toHaveValue('new-password');
});
