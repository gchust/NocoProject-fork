import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { XIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { Link } from 'react-router';

import { NpStatusBadge } from '@/components/np-badges';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';

import { addDependency, removeDependency } from '../../api-collab.js';
import { npKeys } from '../../constants.js';
import type { IssueDependency, IssueDetail } from '../../types.js';
import { IssuePicker } from '../issue-picker.js';

function DependencyRow({
  dependency,
  catalog,
  onRemove,
  removing,
}: {
  readonly dependency: IssueDependency;
  readonly catalog: IssueDetail['statusCatalog'];
  readonly onRemove?: () => void;
  readonly removing?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <li className='flex items-center gap-3 px-3 py-2 text-sm'>
      <NpStatusBadge statusKey={dependency.statusKey} catalog={catalog} />
      <Link
        to={`../${encodeURIComponent(dependency.issueId)}`}
        relative='path'
        className='flex min-w-0 flex-1 items-center gap-2 hover:underline'
      >
        <span className='shrink-0 font-mono text-xs text-muted-foreground'>
          {dependency.identifier}
        </span>
        <span className='truncate'>{dependency.title}</span>
      </Link>
      {onRemove ? (
        <Button
          variant='ghost'
          size='icon-xs'
          disabled={removing}
          aria-label={t('np.dependencies.remove', {
            identifier: dependency.identifier,
          })}
          onClick={onRemove}
        >
          <XIcon />
        </Button>
      ) : null}
    </li>
  );
}

/**
 * "Blocked by" and "Blocks" (§D). Blockers can be added through an issue search and removed; the server refuses a
 * dependency that would close a cycle, which is reported as such. "Blocks" is the reverse view and read-only here.
 */
export function DependenciesSection({
  detail,
  canEdit = true,
}: {
  readonly detail: IssueDetail;
  /** `issues/edit` (NP-161): without it, adding or removing a blocker does not render. */
  readonly canEdit?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const { issue, blockedBy, blocks, statusCatalog } = detail;

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: npKeys.issue(issue.id) });
    void queryClient.invalidateQueries({ queryKey: npKeys.issues });
  };
  const failed = (error: unknown): void => {
    const code = error instanceof ApiClientError ? error.code : undefined;
    const status = error instanceof ApiClientError ? error.status : undefined;
    toast.add({
      type: 'error',
      priority: 'high',
      title: code?.includes('CYCLE')
        ? t('np.dependencies.cycle')
        : code === 'DEPENDENCY_EXISTS'
          ? t('np.dependencies.exists')
          : code === 'DEPENDENCY_TOO_DEEP'
            ? t('np.dependencies.tooDeep')
            : status === 403
              ? t('np.common.forbidden')
              : t('np.common.requestFailed'),
    });
  };

  const add = useMutation({
    mutationFn: (dependsOnIssueId: string) =>
      addDependency(api, issue.id, { dependsOnIssueId, type: 'blockedBy' }),
    onSuccess: () => {
      toast.add({ type: 'success', title: t('np.feedback.dependencyAdded') });
      refresh();
    },
    onError: failed,
  });
  const remove = useMutation({
    mutationFn: (dependencyId: string) =>
      removeDependency(api, issue.id, dependencyId),
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: t('np.feedback.dependencyRemoved'),
      });
      refresh();
    },
    onError: failed,
  });

  const exclude = new Set([
    issue.id,
    ...blockedBy.map((dependency) => dependency.issueId),
  ]);

  return (
    <section className='space-y-3' aria-labelledby='np-dependencies-heading'>
      <h2
        id='np-dependencies-heading'
        className='font-heading text-sm font-semibold'
      >
        {t('np.dependencies.title')}
      </h2>
      <div className='space-y-2'>
        <h3 className='text-sm font-medium text-muted-foreground'>
          {t('np.dependencies.blockedBy')}
        </h3>
        {blockedBy.length > 0 ? (
          <ul className='divide-y overflow-hidden rounded-lg border'>
            {blockedBy.map((dependency) => (
              <DependencyRow
                key={dependency.dependencyId}
                dependency={dependency}
                catalog={statusCatalog}
                removing={remove.isPending}
                onRemove={
                  canEdit
                    ? () => remove.mutate(dependency.dependencyId)
                    : undefined
                }
              />
            ))}
          </ul>
        ) : null}
        {canEdit ? (
          <IssuePicker
            exclude={exclude}
            disabled={add.isPending}
            aria-label={t('np.dependencies.add')}
            placeholder={t('np.dependencies.addPlaceholder')}
            onPick={(picked) => add.mutate(picked.id)}
          />
        ) : null}
      </div>
      {blocks.length > 0 ? (
        <div className='space-y-2'>
          <h3 className='text-sm font-medium text-muted-foreground'>
            {t('np.dependencies.blocks')}
          </h3>
          <ul className='divide-y overflow-hidden rounded-lg border'>
            {blocks.map((dependency) => (
              <DependencyRow
                key={dependency.dependencyId}
                dependency={dependency}
                catalog={statusCatalog}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
