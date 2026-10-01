import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ActivityIcon,
  EyeIcon,
  EyeOffIcon,
  MoreHorizontalIcon,
  PencilIcon,
  Trash2Icon,
} from 'lucide-react';
import { type FormEvent, type ReactElement, useState } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { UnsavedChangesBoundary } from '@/components/unsaved-changes';
import {
  useGuardedClose,
  useUnsavedChanges,
  useUnsavedChangesGuard,
} from '@/components/use-unsaved-changes';

import {
  checkRuntime,
  deleteRuntime,
  errorDetailList,
  errorDetailMessage,
  runtimeTypeErrorOf,
  updateRuntime,
} from '../api-runtime-types.js';
import { npKeys } from '../constants.js';
import type { AgentListItem, Runtime } from '../types.js';

/** Runtime names are at most this long, like the agent name field. */
const NAME_MAX = 100;

type Translate = ReturnType<typeof useTranslation>['t'];

function failureTitle(t: Translate, error: unknown): string {
  if (error instanceof ApiClientError && error.status === 403)
    return t('np.common.forbidden');
  const code = runtimeTypeErrorOf(error);
  if (
    code === 'INVALID_LLM_SERVICE' ||
    code === 'RUNTIME_EXISTS' ||
    code === 'BUILTIN_RUNTIME_UNAVAILABLE'
  )
    return t(`np.builtinRuntimes.errors.${code}`);
  return t('np.common.requestFailed');
}

/**
 * The actions of one built-in runtime (NP-219 §4.1, §4.3): test the connection, rename, make it public or private,
 * delete it. Only for those who hold the general settings' `update`; the server checks the same item.
 */
export function BuiltinRuntimeActions({
  runtime,
  agents,
}: {
  readonly runtime: Runtime;
  readonly agents: readonly AgentListItem[];
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: npKeys.runtimes });
  };
  const fail = (error: unknown): void => {
    toast.add({
      type: 'error',
      priority: 'high',
      title: failureTitle(t, error),
    });
  };

  const check = useMutation({
    mutationFn: () => checkRuntime(api, runtime.id),
    onSuccess: (checked) => {
      if (checked.status === 'online') {
        toast.add({
          type: 'success',
          title: t('np.builtinRuntimes.checkOk', { name: runtime.name }),
        });
        return;
      }
      toast.add({
        type: 'error',
        priority: 'high',
        title: t('np.builtinRuntimes.checkFailed', { name: runtime.name }),
        description: checked.statusReason
          ? t(`np.builtinRuntimes.reasons.${checked.statusReason}`)
          : undefined,
      });
    },
    onError: (error: unknown) => {
      if (error instanceof ApiClientError && error.status === 403) {
        fail(error);
        return;
      }
      toast.add({
        type: 'error',
        priority: 'high',
        title: t('np.builtinRuntimes.checkFailed', { name: runtime.name }),
        description: errorDetailMessage(error) ?? undefined,
      });
    },
    onSettled: refresh,
  });

  const visibility = useMutation({
    mutationFn: (next: 'public' | 'private') =>
      updateRuntime(api, runtime.id, { visibility: next }),
    onSuccess: (updated) =>
      toast.add({
        type: 'success',
        title: t(
          updated.visibility === 'public'
            ? 'np.builtinRuntimes.madePublic'
            : 'np.builtinRuntimes.madePrivate',
          { name: updated.name },
        ),
      }),
    onError: fail,
    onSettled: refresh,
  });

  const remove = useMutation({
    mutationFn: () => deleteRuntime(api, runtime.id),
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: t('np.builtinRuntimes.deleted', { name: runtime.name }),
      });
      void queryClient.invalidateQueries({ queryKey: npKeys.agents });
    },
    onError: (error: unknown) => {
      if (runtimeTypeErrorOf(error) !== 'RUNTIME_IN_USE') {
        fail(error);
        return;
      }
      const ids = errorDetailList(error, 'agentIds');
      const names = ids.map(
        (agentId) =>
          agents.find((agent) => agent.id === agentId)?.name ?? agentId,
      );
      toast.add({
        type: 'error',
        priority: 'high',
        title: t('np.builtinRuntimes.errors.RUNTIME_IN_USE', {
          names: names.join(', ') || '—',
        }),
      });
    },
    onSettled: refresh,
  });

  // Agents set to this runtime; the server's 409 stays the authority (archived agents count there too).
  const users = agents.filter((agent) => agent.runtimeId === runtime.id);
  const pending = check.isPending || visibility.isPending || remove.isPending;
  const isPublic = runtime.visibility === 'public';

  return (
    <div className='flex justify-end'>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant='ghost'
              size='icon-sm'
              disabled={pending}
              aria-label={t('np.builtinRuntimes.actions.menu', {
                name: runtime.name,
              })}
            />
          }
        >
          {check.isPending ? <Spinner /> : <MoreHorizontalIcon />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end'>
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => check.mutate()}>
              <ActivityIcon />
              {t('np.builtinRuntimes.actions.check')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setRenaming(true)}>
              <PencilIcon />
              {t('np.builtinRuntimes.actions.rename')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => visibility.mutate(isPublic ? 'private' : 'public')}
            >
              {isPublic ? <EyeOffIcon /> : <EyeIcon />}
              {isPublic
                ? t('np.builtinRuntimes.actions.makePrivate')
                : t('np.builtinRuntimes.actions.makePublic')}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem
              variant='destructive'
              onClick={() => setDeleting(true)}
            >
              <Trash2Icon />
              {t('np.builtinRuntimes.actions.delete')}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameRuntimeDialog
        runtime={renaming ? runtime : null}
        onClose={() => setRenaming(false)}
      />
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('np.builtinRuntimes.deleteTitle', { name: runtime.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {users.length > 0
                ? t('np.builtinRuntimes.inUse', {
                    names: users.map((agent) => agent.name).join(', '),
                  })
                : t('np.builtinRuntimes.deleteDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant='destructive'
              onClick={() => {
                remove.mutate();
                setDeleting(false);
              }}
            >
              {t('np.builtinRuntimes.actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Renames a built-in runtime (`PATCH /np/runtimes/:id { name }`); a computer runtime's name comes from its daemon. */
function RenameRuntimeDialog({
  runtime,
  onClose,
}: {
  readonly runtime: Runtime | null;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const unsaved = useUnsavedChangesGuard();
  const requestClose = useGuardedClose(unsaved, onClose);
  return (
    <Dialog
      open={runtime !== null}
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
    >
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>
            {t('np.builtinRuntimes.renameTitle', { name: runtime?.name })}
          </DialogTitle>
        </DialogHeader>
        <UnsavedChangesBoundary guard={unsaved}>
          {runtime ? (
            <RenameForm
              key={runtime.id}
              runtime={runtime}
              onClose={onClose}
              onCancel={requestClose}
            />
          ) : null}
        </UnsavedChangesBoundary>
      </DialogContent>
    </Dialog>
  );
}

function RenameForm({
  runtime,
  onClose,
  onCancel,
}: {
  readonly runtime: Runtime;
  readonly onClose: () => void;
  readonly onCancel: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [name, setName] = useState(runtime.name);
  const [error, setError] = useState<string>();
  const markSaved = useUnsavedChanges(name.trim() !== runtime.name);
  const save = useMutation({
    mutationFn: (next: string) =>
      updateRuntime(api, runtime.id, { name: next }),
    onSuccess: (updated) => {
      toast.add({
        type: 'success',
        title: t('np.builtinRuntimes.renamed', { name: updated.name }),
      });
      void queryClient.invalidateQueries({ queryKey: npKeys.runtimes });
      void queryClient.invalidateQueries({ queryKey: npKeys.agents });
      markSaved();
      onClose();
    },
    onError: (failure: unknown) =>
      toast.add({
        type: 'error',
        priority: 'high',
        title: failureTitle(t, failure),
      }),
  });

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const next = name.trim();
    if (!next) {
      setError(t('np.builtinRuntimes.nameRequired'));
      return;
    }
    setError(undefined);
    if (next === runtime.name) {
      onClose();
      return;
    }
    save.mutate(next);
  }

  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor='np-builtin-runtime-name'>
            {t('np.builtinRuntimes.renameLabel')}
          </FieldLabel>
          <Input
            id='np-builtin-runtime-name'
            value={name}
            autoFocus
            maxLength={NAME_MAX}
            aria-invalid={error ? true : undefined}
            onChange={(event) => setName(event.target.value)}
          />
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>
        <DialogFooter>
          <Button
            type='button'
            variant='outline'
            disabled={save.isPending}
            onClick={onCancel}
          >
            {t('actions.cancel')}
          </Button>
          <Button type='submit' disabled={save.isPending}>
            {save.isPending ? <Spinner data-icon='inline-start' /> : null}
            {t('actions.save')}
          </Button>
        </DialogFooter>
      </FieldGroup>
    </form>
  );
}
