import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { type ReactElement, useMemo, useState } from 'react';

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
import { toast } from '@/components/ui/toast';

import {
  fetchInvitations,
  resendInvitation,
  revokeInvitation,
} from '../api-invitations.js';
import { npKeys } from '../constants.js';
import { useNpFormatters } from '../format.js';
import type { Invitation, InvitationResult } from '../types-invitations.js';
import { ConfigSectionHeading } from './config-section.js';
import { InviteResults } from './invite-dialog.js';

/**
 * The invitations not accepted yet (NP-88), under the member table: owner/admin see all, a project lead their own.
 * Each row can be sent again (a fresh link, a new seven days) or revoked. Hidden while there are none.
 */
export function InvitationsSection(): ReactElement | null {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const format = useNpFormatters();
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const [resent, setResent] = useState<InvitationResult | null>(null);
  const invitations = useQuery({
    queryKey: npKeys.invitations,
    queryFn: () => fetchInvitations(api),
  });
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: npKeys.invitations });
  const failed = () =>
    toast.add({
      type: 'error',
      priority: 'high',
      title: t('np.common.requestFailed'),
    });

  const resend = useMutation({
    mutationFn: (invitation: Invitation) =>
      resendInvitation(api, invitation.id),
    onSuccess: (result) => {
      toast.add({
        type: result.emailSent ? 'success' : 'warning',
        title: result.emailSent
          ? t('np.invitations.resent', { email: result.email })
          : t('np.invitations.outcome.notSent'),
      });
      if (!result.emailSent) setResent(result);
    },
    onError: failed,
    onSettled: refresh,
  });
  const revoke = useMutation({
    mutationFn: (invitation: Invitation) =>
      revokeInvitation(api, invitation.id),
    onSuccess: (_, invitation) =>
      toast.add({
        type: 'success',
        title: t('np.invitations.revoked', { email: invitation.email }),
      }),
    onError: failed,
    onSettled: refresh,
  });

  const columns = useMemo<ColumnDef<Invitation, unknown>[]>(
    () => [
      {
        accessorKey: 'email',
        header: t('np.members.columns.email'),
        cell: ({ row }) => (
          <span className='font-medium'>{row.original.email}</span>
        ),
      },
      {
        id: 'projects',
        header: t('np.invitations.projects'),
        cell: ({ row }) =>
          row.original.projects.length ? (
            <span className='text-sm'>
              {row.original.projects.map((project) => project.name).join('、')}
            </span>
          ) : (
            <span className='text-muted-foreground'>—</span>
          ),
      },
      {
        id: 'status',
        header: t('np.invitations.status'),
        cell: ({ row }) =>
          row.original.status === 'expired' ? (
            <NpTag tone='grey'>{t('np.invitations.expired')}</NpTag>
          ) : row.original.sentAt ? (
            <NpTag tone='blue'>{t('np.invitations.pending')}</NpTag>
          ) : (
            <NpTag tone='amber'>{t('np.invitations.notSent')}</NpTag>
          ),
      },
      {
        id: 'invitedBy',
        header: t('np.invitations.invitedBy'),
        cell: ({ row }) => (
          <span className='text-sm text-muted-foreground'>
            {row.original.invitedBy.name}
          </span>
        ),
      },
      {
        accessorKey: 'expiresAt',
        header: t('np.invitations.expiresAt'),
        cell: ({ row }) => (
          <span className='text-sm text-muted-foreground'>
            {format.dateTime(row.original.expiresAt)}
          </span>
        ),
      },
      {
        id: 'actions',
        header: () => (
          <span className='sr-only'>{t('np.invitations.actions')}</span>
        ),
        cell: ({ row }) => (
          <div className='flex justify-end gap-2'>
            <Button
              size='sm'
              variant='outline'
              disabled={resend.isPending}
              onClick={() => resend.mutate(row.original)}
            >
              {t('np.invitations.resend')}
            </Button>
            <Button
              size='sm'
              variant='ghost'
              className='text-destructive'
              onClick={() => setRevoking(row.original)}
            >
              {t('np.invitations.revoke')}
            </Button>
          </div>
        ),
      },
    ],
    [t, format, resend],
  );

  const rows = invitations.data;
  if (invitations.isError && !rows)
    return (
      <NpLoadError
        title={t('np.invitations.loadFailed')}
        error={invitations.error}
        onRetry={() => void invitations.refetch()}
      />
    );
  if (!rows) return <NpListSkeleton rows={2} />;
  if (rows.length === 0) return null;

  return (
    <section
      className='space-y-4 pt-4'
      aria-labelledby='np-config-invitations-heading'
    >
      <ConfigSectionHeading
        id='np-config-invitations-heading'
        title={t('np.invitations.title')}
      />
      <DataTable
        columns={columns}
        data={rows}
        pageSize={20}
        showSelectedCount={false}
        getRowId={(invitation) => invitation.id}
      />
      <AlertDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('np.invitations.revokeTitle', { email: revoking?.email })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('np.invitations.revokeDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant='destructive'
              onClick={() => {
                if (revoking) revoke.mutate(revoking);
                setRevoking(null);
              }}
            >
              {t('np.invitations.revoke')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog
        open={resent !== null}
        onOpenChange={(open) => {
          if (!open) setResent(null);
        }}
      >
        <DialogContent className='sm:max-w-lg'>
          <DialogHeader>
            <DialogTitle>{t('np.invitations.linkTitle')}</DialogTitle>
          </DialogHeader>
          {resent ? <InviteResults results={[resent]} /> : null}
          <DialogFooter>
            <Button type='button' onClick={() => setResent(null)}>
              {t('np.invitations.done')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
