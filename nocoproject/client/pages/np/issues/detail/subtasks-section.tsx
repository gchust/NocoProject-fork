import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation } from '@tanstack/react-query';
import { HourglassIcon, PlusIcon, SparklesIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { Link, useNavigate } from 'react-router';

import { NpExecutor, NpStatusBadge } from '@/components/np-badges';
import { NpTag } from '@/components/np-tag';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';

import { createIntakeBatch } from '../../api-intake.js';

import type { StatusCatalogEntry, SubtaskSummary } from '../../types.js';
import { groupSubtasksByStage } from './subtask-model.js';
import { AskPmButton } from '../../pm/assistant/pm-launchers.js';

function SubtaskRow({
  subtask,
  catalog,
}: {
  readonly subtask: SubtaskSummary;
  readonly catalog: readonly StatusCatalogEntry[];
}): ReactElement {
  const { t } = useTranslation();
  return (
    <li className='flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm'>
      <NpStatusBadge statusKey={subtask.statusKey} catalog={catalog} />
      <Link
        to={`../${encodeURIComponent(subtask.id)}`}
        relative='path'
        className='flex min-w-0 flex-1 items-center gap-2 hover:underline'
      >
        <span className='shrink-0 font-mono text-xs text-muted-foreground'>
          {subtask.identifier}
        </span>
        <span className='truncate'>{subtask.title}</span>
      </Link>
      {subtask.blockedCount > 0 ? (
        <NpTag tone='amber' icon={<HourglassIcon aria-hidden='true' />}>
          {t('np.subtasks.waiting', { count: subtask.blockedCount })}
        </NpTag>
      ) : null}
      <NpExecutor
        type={subtask.executorType ?? (subtask.executorName ? 'agent' : 'none')}
        name={subtask.executorName}
      />
    </li>
  );
}

/**
 * Sub-issues grouped by stage (§J 2). A stage runs after every lower stage is terminal; "waiting for N" counts a
 * sub-issue's open blockers. New sub-issues open the `new-subtask` route dialog; "AI breakdown" turns the description
 * into sub-issue drafts (iteration 2 §E, `source: 'issue'`) and opens them on the batch entry page for review.
 */
export function SubtasksSection({
  issueId,
  issueLabel,
  subtasks,
  catalog,
  canEdit = true,
}: {
  readonly issueId: string;
  /** How the issue reads as project manager context ("NP-12 Title"). */
  readonly issueLabel?: string;
  readonly subtasks: readonly SubtaskSummary[];
  readonly catalog: readonly StatusCatalogEntry[];
  /** `issues/edit` (NP-161): without it, "AI breakdown" and "New sub-issue" do not render. */
  readonly canEdit?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const navigate = useNavigate();
  const breakdown = useMutation({
    mutationFn: () => createIntakeBatch(api, { source: 'issue', issueId }),
    onSuccess: (detail) =>
      void navigate(
        `/issues/new?tab=ai&batch=${encodeURIComponent(detail.batch.id)}`,
      ),
    onError: () =>
      toast.add({
        type: 'error',
        priority: 'high',
        title: t('np.intake.parseFailed'),
      }),
  });
  const groups = groupSubtasksByStage(subtasks, catalog);
  const done = groups.reduce((total, group) => total + group.done, 0);
  const staged = groups.some((group) => group.stage !== null);

  const empty = subtasks.length === 0;
  // Empty, the section is one compact row (nocosolution/guidelines/frontend-standard.md §3.4): a muted heading, "none" and the actions.
  return (
    <section
      className={
        empty
          ? 'flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed px-4 py-2'
          : 'space-y-3'
      }
      aria-labelledby='np-subtasks-heading'
    >
      <div
        className={
          empty ? 'contents' : 'flex items-center justify-between gap-2'
        }
      >
        <h2
          id='np-subtasks-heading'
          className={
            empty
              ? 'font-heading text-sm font-medium text-muted-foreground'
              : 'font-heading text-sm font-semibold'
          }
        >
          {t('np.subtasks.title')}
          {empty ? (
            <span className='ml-2 font-normal'>· {t('np.issueAdd.none')}</span>
          ) : null}
          {subtasks.length > 0 ? (
            <span className='ml-2 text-xs font-normal text-muted-foreground tabular-nums'>
              {done}/{subtasks.length}
            </span>
          ) : null}
        </h2>
        {canEdit ? (
          <div className='flex gap-1'>
            {/* NP-185: the project manager's breakdown; "AI breakdown" below goes with intake in NP-186. */}
            <AskPmButton
              object={{
                type: 'issue',
                id: issueId,
                label: issueLabel ?? issueId,
              }}
              draft={t('np.pmAssistant.breakdownDraft')}
              label={t('np.pmAssistant.breakdown')}
              variant='ghost'
            />
            <Button
              variant='ghost'
              size='sm'
              disabled={breakdown.isPending}
              onClick={() => breakdown.mutate()}
            >
              {breakdown.isPending ? (
                <Spinner data-icon='inline-start' />
              ) : (
                <SparklesIcon data-icon='inline-start' />
              )}
              {t('np.intake.aiBreakdown')}
            </Button>
            <Button
              variant='ghost'
              size='sm'
              nativeButton={false}
              render={<Link to='new-subtask' />}
            >
              <PlusIcon data-icon='inline-start' />
              {t('np.subtasks.new')}
            </Button>
          </div>
        ) : null}
      </div>
      {empty ? null : (
        <div className='space-y-3'>
          {groups.map((group) => (
            <div
              key={group.stage ?? 'none'}
              className='overflow-hidden rounded-lg border'
            >
              {staged ? (
                <div className='flex items-center justify-between border-b bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground'>
                  <span>
                    {group.stage === null
                      ? t('np.subtasks.noStage')
                      : t('np.subtasks.stage', { stage: group.stage })}
                  </span>
                  <span className='tabular-nums'>
                    {group.done}/{group.subtasks.length}
                  </span>
                </div>
              ) : null}
              <ul className='divide-y'>
                {group.subtasks.map((subtask) => (
                  <SubtaskRow
                    key={subtask.id}
                    subtask={subtask}
                    catalog={catalog}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
