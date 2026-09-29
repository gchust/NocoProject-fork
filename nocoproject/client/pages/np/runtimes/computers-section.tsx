import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { type ReactElement, useMemo, useState } from 'react';

import { DataTable } from '@/components/data-table';
import { NpActorAvatar } from '@/components/np-actor-avatar';
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
import { toast } from '@/components/ui/toast';

import { fetchComputers, revokeComputer } from '../api-computers.js';
import { npKeys } from '../constants.js';
import { useNpFormatters } from '../format.js';
import type { NpComputer } from '../types-computers.js';

/**
 * The computer credentials (NP-150), under the runtimes: one per added computer, each revocable on its own (the
 * daemon on it stops at its next request and its runtimes go offline). Owners see their own, owner/admin everyone's.
 * Hidden while there are none.
 */
export function ComputersSection(): ReactElement | null {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const format = useNpFormatters();
  const [revoking, setRevoking] = useState<NpComputer | null>(null);
  const computers = useQuery({
    queryKey: npKeys.computers,
    queryFn: () => fetchComputers(api),
  });
  const revoke = useMutation({
    mutationFn: (computer: NpComputer) => revokeComputer(api, computer.id),
    onSuccess: (computer) =>
      toast.add({
        type: 'success',
        title: t('np.computers.revoked', { name: computer.name }),
      }),
    onError: () =>
      toast.add({
        type: 'error',
        priority: 'high',
        title: t('np.common.requestFailed'),
      }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: npKeys.computers });
      void queryClient.invalidateQueries({ queryKey: npKeys.runtimes });
    },
  });

  const columns = useMemo<ColumnDef<NpComputer, unknown>[]>(
    () => [
      {
        accessorKey: 'name',
        header: t('np.computers.columns.name'),
        cell: ({ row }) => (
          <div className='min-w-0 leading-tight'>
            <div className='truncate font-medium'>{row.original.name}</div>
            {row.original.deviceName &&
            row.original.deviceName !== row.original.name ? (
              <div className='truncate text-xs text-muted-foreground'>
                {row.original.deviceName}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        id: 'key',
        header: t('np.computers.columns.key'),
        cell: ({ row }) =>
          row.original.keyStart ? (
            <span className='font-mono text-xs'>{row.original.keyStart}…</span>
          ) : (
            <span className='text-muted-foreground'>—</span>
          ),
      },
      {
        id: 'state',
        header: t('np.computers.columns.state'),
        cell: ({ row }) =>
          row.original.revokedAt ? (
            <NpTag tone='grey'>{t('np.computers.state.revoked')}</NpTag>
          ) : row.original.lastUsedAt ? (
            <NpTag tone='green' dot>
              {t('np.computers.state.active')}
            </NpTag>
          ) : (
            <NpTag tone='blue'>{t('np.computers.state.unused')}</NpTag>
          ),
      },
      {
        accessorKey: 'lastUsedAt',
        header: t('np.computers.columns.lastUsed'),
        cell: ({ row }) =>
          row.original.lastUsedAt ? (
            <span
              className='text-sm whitespace-nowrap text-muted-foreground'
              title={format.dateTime(row.original.lastUsedAt)}
            >
              {format.relative(row.original.lastUsedAt)}
            </span>
          ) : (
            <span className='text-muted-foreground'>—</span>
          ),
      },
      {
        id: 'owner',
        header: t('np.runtimes.columns.owner'),
        cell: ({ row }) =>
          row.original.ownerName ? (
            <NpActorAvatar
              type='user'
              name={row.original.ownerName}
              size='xs'
              showName
              className='text-sm'
            />
          ) : (
            <span className='text-muted-foreground'>—</span>
          ),
      },
      {
        id: 'actions',
        header: () => (
          <span className='sr-only'>{t('np.computers.columns.actions')}</span>
        ),
        cell: ({ row }) =>
          row.original.canRevoke ? (
            <div className='flex justify-end'>
              <Button
                size='sm'
                variant='ghost'
                className='text-destructive'
                disabled={revoke.isPending}
                onClick={() => setRevoking(row.original)}
              >
                {t('np.computers.revoke')}
              </Button>
            </div>
          ) : null,
      },
    ],
    [t, format, revoke.isPending],
  );

  const rows = computers.data;
  if (computers.isError && !rows)
    return (
      <NpLoadError
        title={t('np.computers.loadFailed')}
        error={computers.error}
        onRetry={() => void computers.refetch()}
      />
    );
  if (!rows) return <NpListSkeleton rows={2} />;
  if (rows.length === 0) return null;

  return (
    <section className='space-y-3 pt-6' aria-labelledby='np-computers-heading'>
      <div className='space-y-1'>
        <h2
          id='np-computers-heading'
          className='font-heading text-base font-semibold'
        >
          {t('np.computers.title')}
        </h2>
        <p className='text-sm text-muted-foreground'>
          {t('np.computers.description')}
        </p>
      </div>
      <DataTable
        columns={columns}
        data={rows}
        pageSize={20}
        showSelectedCount={false}
        getRowId={(computer) => computer.id}
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
              {t('np.computers.revokeTitle', { name: revoking?.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('np.computers.revokeDescription')}
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
              {t('np.computers.revoke')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
