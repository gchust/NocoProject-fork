import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { type FormEvent, type ReactElement, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { DataTable } from '@/components/data-table';
import { NpListSkeleton, NpLoadError } from '@/components/np-states';
import { NpTag } from '@/components/np-tag';
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
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';

import { fetchMembers } from '../api-collab.js';
import {
  createBusinessRole,
  deleteBusinessRole,
  fetchBusinessRoles,
  holderIdsOfError,
} from '../api-roles.js';
import { npKeys } from '../constants.js';
import type { BusinessRole } from '../types-roles.js';
import { settingsCheck } from './config-access.js';
import { ConfigSectionHeading } from './config-section.js';
import { roleErrorKey, rolePath, roleTitle } from './roles-model.js';

function NewRoleDialog({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const create = useMutation({
    mutationFn: () => createBusinessRole(api, { title, grants: [] }),
    onSuccess: (role) => {
      toast.add({
        type: 'success',
        title: t('np.roles.created', { name: title.trim() }),
      });
      void queryClient.invalidateQueries({ queryKey: npKeys.accessRoles });
      setTitle('');
      onClose();
      void navigate(`${rolePath(role.key)}?tab=roles`);
    },
    onError: (error: unknown) =>
      toast.add({
        type: 'error',
        priority: 'high',
        title: t(
          error instanceof ApiClientError
            ? roleErrorKey(error.code, error.status)
            : 'np.common.requestFailed',
        ),
      }),
  });
  function submit(event: FormEvent): void {
    event.preventDefault();
    if (title.trim()) create.mutate();
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className='sm:max-w-md'>
        <form onSubmit={submit} className='space-y-4'>
          <DialogHeader>
            <DialogTitle>{t('np.roles.newTitle')}</DialogTitle>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor='np-new-role-title'>
              {t('np.roles.name')}
            </FieldLabel>
            <Input
              id='np-new-role-title'
              value={title}
              maxLength={100}
              autoFocus
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose}>
              {t('actions.cancel')}
            </Button>
            <Button type='submit' disabled={!title.trim() || create.isPending}>
              {t('np.common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The Roles tab of `/config/members` (NP-153): every `np-` permission set with its kind (built-in / custom), how many
 * people hold it, and whether it also holds platform grants. Whoever holds `nocoproject.members` `define-roles`
 * creates roles here and deletes custom ones nobody holds; a role opens as a covering page
 * (`/config/members/roles/:key`).
 */
export function RolesPanel(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const roles = useQuery({
    queryKey: npKeys.accessRoles,
    queryFn: ({ signal }) => fetchBusinessRoles(api, signal),
  });
  const members = useQuery({
    queryKey: npKeys.members,
    queryFn: () => fetchMembers(api),
  });
  const canDefine = useCan(settingsCheck('members', 'define-roles')).can;
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<BusinessRole | null>(null);
  const [inUse, setInUse] = useState<readonly string[]>([]);

  const remove = useMutation({
    mutationFn: (role: BusinessRole) => deleteBusinessRole(api, role.key),
    onSuccess: (_, role) => {
      toast.add({
        type: 'success',
        title: t('np.roles.deleted', { name: roleTitle(t, role) }),
      });
      setDeleting(null);
    },
    onError: (error: unknown) => {
      if (error instanceof ApiClientError && error.code === 'ROLE_IN_USE')
        setInUse(holderIdsOfError(error.payload));
      toast.add({
        type: 'error',
        priority: 'high',
        title: t(
          error instanceof ApiClientError
            ? roleErrorKey(error.code, error.status)
            : 'np.common.requestFailed',
        ),
      });
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: npKeys.accessRoles }),
  });

  const columns = useMemo<ColumnDef<BusinessRole, unknown>[]>(
    () => [
      {
        id: 'name',
        header: t('np.roles.columns.name'),
        meta: { className: 'w-full max-w-0' },
        cell: ({ row }) => (
          <div className='flex min-w-0 items-center gap-2'>
            <Link
              to={`${rolePath(row.original.key)}?tab=roles`}
              className='max-w-[30rem] truncate font-medium hover:underline focus-visible:underline'
              title={roleTitle(t, row.original)}
            >
              {roleTitle(t, row.original)}
            </Link>
            {row.original.hasForeignGrants ? (
              <NpTag tone='orange' title={t('np.roles.platformHint')}>
                {t('np.roles.platformGrants')}
              </NpTag>
            ) : null}
          </div>
        ),
      },
      {
        id: 'kind',
        header: t('np.roles.columns.kind'),
        meta: { className: 'w-28' },
        cell: ({ row }) =>
          row.original.builtIn ? (
            <NpTag tone='blue'>{t('np.roles.builtIn')}</NpTag>
          ) : (
            <NpTag tone='grey'>{t('np.roles.custom')}</NpTag>
          ),
      },
      {
        id: 'holders',
        header: t('np.roles.columns.holders'),
        meta: { className: 'w-28' },
        cell: ({ row }) => (
          <span className='tabular-nums'>{row.original.holderCount}</span>
        ),
      },
      {
        id: 'actions',
        header: () => <span className='sr-only'>{t('np.roles.actions')}</span>,
        meta: { className: 'w-12' },
        cell: ({ row }) =>
          canDefine && !row.original.builtIn ? (
            <Button
              variant='ghost'
              size='icon-sm'
              aria-label={t('np.roles.deleteNamed', {
                name: roleTitle(t, row.original),
              })}
              onClick={() => {
                setInUse(row.original.holderIds);
                setDeleting(row.original);
              }}
            >
              <Trash2Icon />
            </Button>
          ) : null,
      },
    ],
    [t, canDefine],
  );

  const nameOf = (userId: string): string =>
    members.data?.find((member) => member.userId === userId)?.name ?? userId;

  let content: ReactElement;
  if (roles.isError && !roles.data) {
    content = (
      <NpLoadError
        title={t('np.roles.loadFailed')}
        error={roles.error}
        onRetry={() => void roles.refetch()}
      />
    );
  } else if (!roles.data) {
    content = <NpListSkeleton rows={3} />;
  } else {
    content = (
      <DataTable
        columns={columns}
        data={roles.data}
        pageSize={50}
        showSelectedCount={false}
        getRowId={(role) => role.key}
      />
    );
  }

  return (
    <section className='space-y-4' aria-labelledby='np-config-roles-heading'>
      <ConfigSectionHeading
        id='np-config-roles-heading'
        title={t('np.roles.title')}
        description={t('np.roles.description')}
        actions={
          canDefine ? (
            <Button size='sm' onClick={() => setCreating(true)}>
              <PlusIcon />
              {t('np.roles.new')}
            </Button>
          ) : null
        }
      />
      {content}
      <NewRoleDialog open={creating} onClose={() => setCreating(false)} />
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('np.roles.deleteTitle', {
                name: deleting ? roleTitle(t, deleting) : '',
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {inUse.length > 0
                ? t('np.roles.deleteInUse', { count: inUse.length })
                : t('np.roles.deleteDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {inUse.length > 0 ? (
            <ul className='flex flex-wrap gap-1'>
              {inUse.map((userId) => (
                <li key={userId}>
                  <NpTag tone='grey'>{nameOf(userId)}</NpTag>
                </li>
              ))}
            </ul>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant='destructive'
              disabled={inUse.length > 0 || remove.isPending}
              onClick={() => {
                if (deleting) remove.mutate(deleting);
              }}
            >
              {t('np.roles.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
