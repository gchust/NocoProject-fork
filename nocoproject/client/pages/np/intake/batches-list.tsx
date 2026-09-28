import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderOpenIcon, Undo2Icon } from 'lucide-react';
import { type ReactElement, useState } from 'react';

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
import { NpTag } from '@/components/np-tag';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';

import { fetchMyIntakeBatches, revertIntakeBatch } from '../api-intake.js';
import { fetchProjects } from '../api.js';
import { npKeys } from '../constants.js';
import { useNpFormatters } from '../format.js';
import type { IntakeBatch } from '../types.js';

/**
 * The viewer's recent batches (iteration 2 §E): open a draft to keep editing it, or revert a confirmed one — the
 * issues it created are removed unless an agent already ran on them, which are kept and counted.
 */
export function BatchesList({
  onOpen,
}: {
  readonly onOpen: (batchId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const format = useNpFormatters();
  const [reverting, setReverting] = useState<IntakeBatch | null>(null);
  const batches = useQuery({
    queryKey: npKeys.intakeBatches,
    queryFn: ({ signal }) => fetchMyIntakeBatches(api, signal),
  });
  const projects = useQuery({
    queryKey: npKeys.projects,
    queryFn: () => fetchProjects(api),
  });
  const projectName = (batch: IntakeBatch): string | undefined =>
    batch.projectName ??
    projects.data?.find((project) => project.id === batch.projectId)?.name;
  const revert = useMutation({
    mutationFn: (batch: IntakeBatch) => revertIntakeBatch(api, batch.id),
    onSuccess: (result) =>
      toast.add({
        type: 'success',
        title: t('np.intake.reverted', { count: result.reverted.length }),
        description:
          result.kept.length > 0
            ? t('np.intake.revertKept', { count: result.kept.length })
            : undefined,
      }),
    onError: () =>
      toast.add({
        type: 'error',
        priority: 'high',
        title: t('np.common.requestFailed'),
      }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: npKeys.intakeBatches });
      void queryClient.invalidateQueries({ queryKey: npKeys.issues });
    },
  });

  return (
    <section className='space-y-3' aria-labelledby='np-intake-batches-heading'>
      <h2
        id='np-intake-batches-heading'
        className='font-heading text-sm font-semibold'
      >
        {t('np.intake.recentTitle')}
      </h2>
      {!batches.data ? (
        batches.isError ? (
          <p className='text-sm text-destructive'>
            {t('np.common.requestFailed')}
          </p>
        ) : (
          <Skeleton className='h-16 w-full' />
        )
      ) : batches.data.length === 0 ? (
        <p className='text-sm text-muted-foreground'>
          {t('np.intake.recentEmpty')}
        </p>
      ) : (
        <ul className='divide-y rounded-lg border'>
          {batches.data.map((batch) => (
            <li
              key={batch.id}
              className='flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm'
            >
              <NpTag tone='blue' dot>
                {t(`np.intake.status.${batch.status}`)}
              </NpTag>
              <span>
                {t(`np.intake.source.${batch.source}`)}
                {projectName(batch) ? ` · ${projectName(batch)}` : ''}
              </span>
              {typeof batch.draftCount === 'number' ? (
                <span className='text-muted-foreground tabular-nums'>
                  {t('np.intake.draftCount', { count: batch.draftCount })}
                </span>
              ) : null}
              <time
                dateTime={batch.createdAt}
                className='text-xs text-muted-foreground'
                title={format.dateTime(batch.createdAt)}
              >
                {format.relative(batch.createdAt)}
              </time>
              <div className='ml-auto flex gap-1'>
                <Button
                  variant='ghost'
                  size='xs'
                  onClick={() => onOpen(batch.id)}
                >
                  <FolderOpenIcon data-icon='inline-start' />
                  {t('np.intake.open')}
                </Button>
                {batch.status === 'confirmed' ? (
                  <Button
                    variant='ghost'
                    size='xs'
                    disabled={revert.isPending}
                    onClick={() => setReverting(batch)}
                  >
                    <Undo2Icon data-icon='inline-start' />
                    {t('np.intake.revert')}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <AlertDialog
        open={reverting !== null}
        onOpenChange={(open) => {
          if (!open) setReverting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('np.intake.revertTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('np.intake.revertDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant='destructive'
              onClick={() => {
                const target = reverting;
                setReverting(null);
                if (target) revert.mutate(target);
              }}
            >
              {t('np.intake.revert')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
