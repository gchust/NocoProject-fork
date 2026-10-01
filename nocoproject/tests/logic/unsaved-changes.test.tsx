import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { RouteDialog } from '../../client/components/route-dialog';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '../../client/components/ui/dialog';
import { UnsavedChangesBoundary } from '../../client/components/unsaved-changes';
import {
  useGuardedClose,
  useUnsavedChanges,
  useUnsavedChangesGuard,
} from '../../client/components/use-unsaved-changes';
import { useRouteOverlay } from '../../client/components/use-route-overlay';

vi.mock('@nocobase/i18n/client', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function Form() {
  const { close } = useRouteOverlay();
  const [name, setName] = useState('');
  const markSaved = useUnsavedChanges(name.trim() !== '');
  return (
    <>
      <input
        aria-label='Name'
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <button
        onClick={() => {
          markSaved();
          void close();
        }}
      >
        Save
      </button>
    </>
  );
}

function Cancel() {
  const { close } = useRouteOverlay();
  return <button onClick={() => void close()}>Cancel</button>;
}

function NewOrder({ check }: { readonly check?: () => boolean }) {
  const unsaved = useUnsavedChangesGuard();
  return (
    <RouteDialog
      title='New order'
      beforeClose={() => (check ? check() : true) && unsaved.confirmDiscard()}
      footer={<Cancel />}
    >
      <UnsavedChangesBoundary guard={unsaved}>
        <Form />
      </UnsavedChangesBoundary>
    </RouteDialog>
  );
}

function setup(check?: () => boolean) {
  const router = createMemoryRouter(
    [
      {
        path: '/orders',
        element: <Outlet />,
        children: [
          {
            path: 'new',
            element: <NewOrder check={check} />,
          },
        ],
      },
    ],
    { initialEntries: ['/orders/new'] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

async function typeName(value: string) {
  const user = userEvent.setup();
  await user.type(await screen.findByRole('textbox', { name: 'Name' }), value);
  return user;
}

describe('unsaved changes in a route dialog', () => {
  it('closes an untouched form without asking', async () => {
    const user = userEvent.setup();
    const router = setup();
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/orders'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('asks before discarding typed input and keeps editing on request', async () => {
    const router = setup();
    const user = await typeName('Draft');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    const confirm = await screen.findByRole('alertdialog', {
      name: 'unsavedChanges.title',
    });
    expect(confirm).toHaveTextContent('unsavedChanges.description');
    await user.click(
      screen.getByRole('button', { name: 'unsavedChanges.keepEditing' }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
    );
    expect(router.state.location.pathname).toBe('/orders/new');
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Draft');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('closes after the member chooses to discard', async () => {
    const router = setup();
    const user = await typeName('Draft');
    await user.click(
      screen.getByRole('button', { name: 'routeOverlay.close' }),
    );
    await user.click(
      await screen.findByRole('button', { name: 'unsavedChanges.discard' }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/orders'));
  });

  it('asks on Escape, and a second Escape dismisses only the confirmation', async () => {
    const router = setup();
    const user = await typeName('Draft');
    await user.keyboard('{Escape}');
    await screen.findByRole('alertdialog');
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
    );
    expect(router.state.location.pathname).toBe('/orders/new');
    expect(screen.getByRole('dialog', { name: 'New order' })).toBeVisible();
  });

  it('closes without asking once the input is saved or cleared', async () => {
    const router = setup();
    const user = await typeName('Draft');
    await user.clear(screen.getByRole('textbox', { name: 'Name' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), '  ');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/orders'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    await router.navigate('/orders/new');
    await typeName('Draft');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/orders'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('does not ask while beforeClose keeps the dialog open', async () => {
    const guard = vi.fn(() => false);
    const router = setup(guard);
    const user = await typeName('Draft');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(guard).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/orders/new');
  });
});

function StateDialog({ onClose }: { readonly onClose: () => void }) {
  const [note, setNote] = useState('');
  const unsaved = useUnsavedChangesGuard(note !== '');
  const requestClose = useGuardedClose(unsaved, onClose);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
    >
      <DialogContent>
        <DialogTitle>Note</DialogTitle>
        <UnsavedChangesBoundary guard={unsaved} />
        <input
          aria-label='Note'
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <button onClick={requestClose}>Cancel</button>
      </DialogContent>
    </Dialog>
  );
}

describe('unsaved changes in a dialog held in component state', () => {
  it('closes an untouched dialog and asks once something is typed', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<StateDialog onClose={onClose} />);
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    await user.type(screen.getByRole('textbox', { name: 'Note' }), 'x');
    await user.keyboard('{Escape}');
    await screen.findByRole('alertdialog');
    await user.click(
      screen.getByRole('button', { name: 'unsavedChanges.keepEditing' }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(
      await screen.findByRole('button', { name: 'unsavedChanges.discard' }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  });
});

// A save the test finishes by hand, to close while the confirmation is up.
let finishSave: () => void = () => {};

function SlowForm({ onSaved }: { readonly onSaved: () => void }) {
  const [name, setName] = useState('');
  const markSaved = useUnsavedChanges(name !== '');
  return (
    <>
      <input
        aria-label='Name'
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <button
        onClick={() => {
          finishSave = () => {
            markSaved();
            onSaved();
          };
        }}
      >
        Save
      </button>
    </>
  );
}

function SlowRouteForm() {
  const { close } = useRouteOverlay();
  return <SlowForm onSaved={() => void close()} />;
}

function SlowRouteDialog() {
  const unsaved = useUnsavedChangesGuard();
  return (
    <RouteDialog title='New order' beforeClose={() => unsaved.confirmDiscard()}>
      <UnsavedChangesBoundary guard={unsaved}>
        <SlowRouteForm />
      </UnsavedChangesBoundary>
    </RouteDialog>
  );
}

function SlowStateDialog() {
  const [open, setOpen] = useState(false);
  const unsaved = useUnsavedChangesGuard();
  const close = () => setOpen(false);
  const requestClose = useGuardedClose(unsaved, close);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) requestClose();
        }}
      >
        <DialogContent>
          <DialogTitle>Note</DialogTitle>
          <UnsavedChangesBoundary guard={unsaved}>
            {open ? <SlowForm onSaved={close} /> : null}
          </UnsavedChangesBoundary>
        </DialogContent>
      </Dialog>
    </>
  );
}

describe('a save that finishes while the confirmation is up', () => {
  it('closes the route dialog instead of leaving the question open', async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [
        {
          path: '/orders',
          element: <Outlet />,
          children: [{ path: 'new', element: <SlowRouteDialog /> }],
        },
      ],
      { initialEntries: ['/orders/new'] },
    );
    render(<RouterProvider router={router} />);
    await typeName('Draft');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.keyboard('{Escape}');
    await screen.findByRole('alertdialog');
    await act(async () => finishSave());
    await waitFor(() => expect(router.state.location.pathname).toBe('/orders'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('does not bring the question back when a component-state dialog reopens', async () => {
    const user = userEvent.setup();
    render(<SlowStateDialog />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await typeName('Draft');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.keyboard('{Escape}');
    await screen.findByRole('alertdialog');
    await act(async () => finishSave());
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(
      await screen.findByRole('textbox', { name: 'Name' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
