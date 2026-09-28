import { useTranslation } from '@nocobase/i18n/client';
import { BotIcon, ChevronRightIcon, CogIcon, UserIcon } from 'lucide-react';
import type { ReactElement } from 'react';

import { NpTag } from '@/components/np-tag';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

import { statusLabelKey } from '../constants.js';
import type { WorkflowStatusDefinition } from '../types.js';
import type { WorkflowDefinitionV3 } from '../types-iter3.js';
import {
  CATEGORY_NODE_CLASS,
  type TransitionActorKind,
  transitionMatrix,
  workflowFlow,
  workflowRules,
} from './workflow-model.js';

const ACTOR_ICON = { user: UserIcon, agent: BotIcon, system: CogIcon } as const;

function useStatusName(
  definition: WorkflowDefinitionV3,
): (key: string) => string {
  const { t } = useTranslation();
  return (key) => {
    if (key === '*') return t('np.workflows.any');
    const status = definition.statuses.find((entry) => entry.key === key);
    return t(statusLabelKey(key), { defaultValue: status?.name ?? key });
  };
}

/** The actors of a transition as icons, each with its name for screen readers and on hover. */
export function ActorIcons({
  actors,
}: {
  readonly actors: readonly TransitionActorKind[];
}): ReactElement {
  const { t } = useTranslation();
  return (
    <span className='inline-flex items-center gap-1'>
      {actors.map((actor) => {
        const Icon = ACTOR_ICON[actor];
        const label = t(`np.workflows.actors.${actor}`);
        return (
          <span key={actor} title={label} data-actor={actor}>
            <Icon className='size-3.5' aria-hidden='true' />
            <span className='sr-only'>{label}</span>
          </span>
        );
      })}
    </span>
  );
}

function StatusNode({
  status,
  name,
}: {
  readonly status: WorkflowStatusDefinition;
  readonly name: string;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <span
      data-category={status.category}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium',
        CATEGORY_NODE_CLASS[status.category],
      )}
    >
      {name}
      <span className='sr-only'>
        {`(${t(`np.workflows.categories.${status.category}`)})`}
      </span>
    </span>
  );
}

/**
 * The status line, colored by category (unstarted, started, done), with the side branches (blocked, cancelled)
 * beneath it. CSS only: nodes joined by chevrons, wrapping on narrow screens.
 */
export function WorkflowFlow({
  definition,
  compact = false,
}: {
  readonly definition: WorkflowDefinitionV3;
  readonly compact?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const name = useStatusName(definition);
  const { main, side } = workflowFlow(definition);
  return (
    <div className='space-y-3'>
      <ol
        aria-label={t('np.workflows.mainLine')}
        className='flex flex-wrap items-center gap-y-2'
      >
        {main.map((status, index) => (
          <li key={status.key} className='flex items-center'>
            {index > 0 ? (
              <ChevronRightIcon
                className='mx-1 size-4 shrink-0 text-muted-foreground'
                aria-hidden='true'
              />
            ) : null}
            <StatusNode status={status} name={name(status.key)} />
          </li>
        ))}
      </ol>
      {side.length > 0 && !compact ? (
        <div className='flex flex-wrap items-center gap-2 border-l-2 border-dashed pl-3'>
          <span className='text-xs text-muted-foreground'>
            {t('np.workflows.sideBranches')}
          </span>
          <ul
            aria-label={t('np.workflows.sideBranches')}
            className='flex flex-wrap gap-2'
          >
            {side.map((status) => (
              <li key={status.key}>
                <StatusNode status={status} name={name(status.key)} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {!compact ? (
        <ul className='flex flex-wrap gap-3 text-xs text-muted-foreground'>
          {(['unstarted', 'started', 'done', 'closed'] as const).map(
            (category) => (
              <li key={category} className='inline-flex items-center gap-1.5'>
                <span
                  aria-hidden='true'
                  className={cn(
                    'size-3 rounded border',
                    CATEGORY_NODE_CLASS[category],
                  )}
                />
                {t(`np.workflows.categories.${category}`)}
              </li>
            ),
          )}
        </ul>
      ) : null}
    </div>
  );
}

/** The transition matrix: rows are "from", columns "to"; a cell lists who may move and marks an approval. */
export function WorkflowMatrix({
  definition,
}: {
  readonly definition: WorkflowDefinitionV3;
}): ReactElement {
  const { t } = useTranslation();
  const name = useStatusName(definition);
  const matrix = transitionMatrix(definition);
  return (
    <div className='overflow-x-auto rounded-lg border'>
      <Table aria-label={t('np.workflows.matrix')}>
        <TableHeader>
          <TableRow>
            <TableHead className='text-xs text-muted-foreground'>
              {t('np.workflows.fromTo')}
            </TableHead>
            {matrix.keys.map((key) => (
              <TableHead key={key} scope='col' className='text-center'>
                {name(key)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {matrix.rows.map((row) => (
            <TableRow key={row.from}>
              <TableHead scope='row' className='font-medium'>
                {name(row.from)}
              </TableHead>
              {row.cells.map((cell) => (
                <TableCell
                  key={cell.to}
                  data-from={row.from}
                  data-to={cell.to}
                  className={cn(
                    'text-center',
                    row.from === cell.to && 'bg-muted/50',
                  )}
                >
                  {cell.actors.length > 0 ? (
                    <span className='inline-flex flex-col items-center gap-1'>
                      <ActorIcons actors={cell.actors} />
                      {cell.approval ? (
                        <NpTag tone='amber' className='px-2 py-0'>
                          {t('np.workflows.approval')}
                        </NpTag>
                      ) : null}
                    </span>
                  ) : row.from === cell.to ? null : (
                    <span className='text-muted-foreground' aria-hidden='true'>
                      ·
                    </span>
                  )}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** The template's rules as sentences: every transition (approvals first) and the sub-issue wake-up rule. */
export function WorkflowRules({
  definition,
}: {
  readonly definition: WorkflowDefinitionV3;
}): ReactElement {
  const { t } = useTranslation();
  const name = useStatusName(definition);
  const rules = workflowRules(definition);
  return (
    <ul className='divide-y rounded-lg border'>
      {rules.map((rule) =>
        rule.kind === 'transition' ? (
          <li
            key={`${rule.from}>${rule.to}:${rule.actors.join(',')}`}
            className='flex flex-wrap items-center gap-2 px-3 py-2 text-sm'
          >
            <ActorIcons actors={rule.actors} />
            <span>
              {t('np.workflows.rule', {
                actors: rule.actors
                  .map((actor) => t(`np.workflows.actors.${actor}`))
                  .join(t('np.workflows.listSeparator')),
                from: name(rule.from),
                to: name(rule.to),
              })}
            </span>
            {rule.approval ? (
              <NpTag tone='amber'>
                {t('np.workflows.approvalBy', {
                  roles: rule.approval
                    .map((role) => t(`np.workflows.approvers.${role}`))
                    .join(t('np.workflows.listSeparator')),
                })}
              </NpTag>
            ) : null}
          </li>
        ) : (
          <li key='childBatchDone' className='px-3 py-2 text-sm'>
            {rule.enabled
              ? t('np.workflows.childBatchDoneOn')
              : t('np.workflows.childBatchDoneOff')}
          </li>
        ),
      )}
    </ul>
  );
}
