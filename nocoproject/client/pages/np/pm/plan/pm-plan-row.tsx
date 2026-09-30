import { useTranslation } from '@nocobase/i18n/client';
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  PencilIcon,
  RotateCcwIcon,
  Trash2Icon,
  XCircleIcon,
} from 'lucide-react';
import { type ReactElement, type ReactNode, useId } from 'react';
import { Link } from 'react-router';

import { NpMarkdown } from '@/components/np-markdown';
import { NpTag } from '@/components/np-tag';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import type { PmPlanRowFlag } from '../../types-pm.js';
import { PmDecisionRow } from './pm-plan-decision.js';
import { EDITABLE_TYPES, PmRowEditor } from './pm-plan-editor.js';
import {
  isIssueRef,
  issueRefLabel,
  type PmRowView,
  rowErrorKey,
  updateChanges,
} from './pm-plan-model.js';
import { type PlanLookup, usePlanValueText } from './pm-plan-values.js';

const FLAG_TONE: Readonly<Record<PmPlanRowFlag, 'amber' | 'red' | 'violet'>> = {
  startsRun: 'violet',
  terminal: 'red',
  ownerChange: 'amber',
  decision: 'amber',
  createsProject: 'amber',
};

/** Where a finished row's object lives, when the browser has a page for it. */
function resultLink(type: string | undefined, id: string | undefined): string | null {
  if (!id) return null;
  if (type === 'issue') return `/issues/${encodeURIComponent(id)}`;
  if (type === 'project') return `/projects/${encodeURIComponent(id)}`;
  return null;
}

/**
 * One operation of a plan card (§4.3–4.5): what it does in the words of its type, loud tags for what reaches
 * beyond the plan (starts an agent's run, closes an issue, changes an owner), its error, and after execution its
 * result. Editable plans offer "Edit" (the row's fields, stacked) and "Remove" (not for a row others depend on).
 */
export function PmPlanRowItem({
  view,
  views,
  lookup,
  editable,
  editing,
  removable,
  onEdit,
  onChange,
  onRemove,
  onRestore,
}: {
  readonly view: PmRowView;
  readonly views: readonly PmRowView[];
  readonly lookup: PlanLookup;
  readonly editable: boolean;
  readonly editing: boolean;
  readonly removable: boolean;
  readonly onEdit: (editing: boolean) => void;
  readonly onChange: (params: Record<string, unknown>) => void;
  readonly onRemove: () => void;
  readonly onRestore: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const titleId = useId();
  const { row, removed } = view;
  const title = rowTitle(view, views, t);
  const errorKey = rowErrorKey(row.errorCode);
  const done = row.status === 'done';
  const link = resultLink(row.resultType, row.resultId);
  const canEdit = editable && !removed && EDITABLE_TYPES.has(row.type);

  return (
    <li
      role='group'
      aria-labelledby={titleId}
      className={cn(
        'space-y-1.5 rounded-md border bg-background px-2.5 py-2',
        removed && 'opacity-60',
        !row.ok && !removed && 'border-destructive/50',
      )}
      style={{ marginInlineStart: `${view.depth * 1.25}rem` }}
      data-pm-row={row.seq}
    >
      <div className='flex min-w-0 items-start gap-1.5'>
        <RowStateIcon done={done} failed={row.status === 'failed'} />
        <div className='min-w-0 flex-1'>
          <p className='text-xs text-muted-foreground'>
            {t(`np.pmAssistant.plan.types.${row.type}`)}
          </p>
          <p
            id={titleId}
            className={cn(
              'text-sm font-medium wrap-anywhere',
              removed && 'line-through',
            )}
          >
            {title}
          </p>
        </div>
        {canEdit ? (
          <Button
            variant='ghost'
            size='icon-sm'
            aria-label={t('np.pmAssistant.plan.editRow', { title })}
            aria-pressed={editing}
            onClick={() => onEdit(!editing)}
          >
            <PencilIcon />
          </Button>
        ) : null}
        {editable && removed ? (
          <Button
            variant='ghost'
            size='icon-sm'
            aria-label={t('np.pmAssistant.plan.restoreRow', { title })}
            onClick={onRestore}
          >
            <RotateCcwIcon />
          </Button>
        ) : null}
        {editable && !removed ? (
          <Button
            variant='ghost'
            size='icon-sm'
            disabled={!removable}
            aria-label={t('np.pmAssistant.plan.removeRow', { title })}
            title={removable ? undefined : t('np.pmAssistant.plan.referenced')}
            onClick={onRemove}
          >
            <Trash2Icon />
          </Button>
        ) : null}
      </div>
      {row.flags.length > 0 || row.preview.length > 0 ? (
        <ul className='flex flex-wrap gap-1' aria-label={t('np.pmAssistant.plan.flags')}>
          {row.preview.map((preview) => (
            <li key={`${preview.agentId}:${preview.issueId ?? ''}`}>
              <NpTag tone='violet'>
                {t('np.pmAssistant.plan.startsRunOf', {
                  agent: preview.agentName ?? preview.agentId,
                  issue: preview.identifier ?? title,
                })}
              </NpTag>
            </li>
          ))}
          {row.flags
            .filter((flag) => flag !== 'startsRun' || row.preview.length === 0)
            .map((flag) => (
              <li key={flag}>
                <NpTag tone={FLAG_TONE[flag]}>
                  {t(`np.pmAssistant.plan.flag.${flag}`)}
                </NpTag>
              </li>
            ))}
        </ul>
      ) : null}
      {editing && canEdit ? (
        <PmRowEditor view={view} lookup={lookup} onChange={onChange} />
      ) : (
        <RowDetails view={view} views={views} lookup={lookup} />
      )}
      {!row.ok && !removed && (row.errorCode || row.errorMessage) ? (
        <p className='flex items-start gap-1 text-xs text-destructive' role='alert'>
          <AlertTriangleIcon className='mt-0.5 size-3.5 shrink-0' aria-hidden='true' />
          <span className='wrap-anywhere'>
            {errorKey
              ? t(errorKey, { title, defaultValue: row.errorMessage ?? row.errorCode })
              : (row.errorMessage ?? row.errorCode)}
          </span>
        </p>
      ) : null}
      {done ? (
        <p className='flex flex-wrap items-center gap-2 text-xs text-muted-foreground'>
          {link ? (
            <Link to={link} className='text-primary hover:underline'>
              {t('np.pmAssistant.plan.openResult')}
            </Link>
          ) : null}
          {row.warnings.includes('runNotStarted') ? (
            <NpTag tone='amber'>{t('np.pmAssistant.plan.runNotStarted')}</NpTag>
          ) : null}
        </p>
      ) : null}
      {removed ? (
        <p className='text-xs text-muted-foreground'>{t('np.pmAssistant.plan.removed')}</p>
      ) : null}
    </li>
  );
}

function RowStateIcon({
  done,
  failed,
}: {
  readonly done: boolean;
  readonly failed: boolean;
}): ReactElement | null {
  const { t } = useTranslation();
  if (done) {
    return (
      <CheckCircle2Icon
        className='mt-0.5 size-4 shrink-0 text-success'
        aria-label={t('np.pmAssistant.plan.rowDone')}
      />
    );
  }
  if (failed) {
    return (
      <XCircleIcon
        className='mt-0.5 size-4 shrink-0 text-destructive'
        aria-label={t('np.pmAssistant.plan.rowFailed')}
      />
    );
  }
  return null;
}

function rowTitle(
  view: PmRowView,
  views: readonly PmRowView[],
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const { params } = view;
  switch (view.row.type) {
    case 'issue.create':
      return typeof params.title === 'string' && params.title
        ? params.title
        : t('np.intake.untitled');
    case 'project.create':
      return typeof params.name === 'string' ? params.name : '—';
    case 'decision.resolve':
      return t(`np.pmAssistant.plan.decisionActions.${String(params.action)}`, {
        defaultValue: String(params.action),
      });
    case 'dependency.add':
    case 'dependency.remove':
      return t('np.pmAssistant.plan.dependsOn', {
        issue: issueRefLabel(params.issue, views),
        blockedBy: issueRefLabel(params.blockedBy, views),
      });
    default:
      return issueRefLabel(params.issue, views);
  }
}

function Line({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className='flex min-w-0 gap-2 text-xs'>
      <dt className='w-16 shrink-0 text-muted-foreground'>{label}</dt>
      <dd className='min-w-0 flex-1 wrap-anywhere'>{children}</dd>
    </div>
  );
}

const CREATE_FIELDS = [
  'priority',
  'executor',
  'ownerUserId',
  'process',
  'stage',
  'labelIds',
  'projectId',
] as const;

function RowDetails({
  view,
  views,
  lookup,
}: {
  readonly view: PmRowView;
  readonly views: readonly PmRowView[];
  readonly lookup: PlanLookup;
}): ReactElement | null {
  const { t } = useTranslation();
  const text = usePlanValueText(lookup);
  const { params } = view;
  switch (view.row.type) {
    case 'issue.create': {
      const blockedBy = Array.isArray(params.blockedBy) ? params.blockedBy : [];
      return (
        <dl className='space-y-0.5'>
          {CREATE_FIELDS.filter((field) => params[field] !== undefined).map((field) => (
            <Line key={field} label={t(`np.pmAssistant.plan.fields.${field}`)}>
              {text(field, params[field])}
            </Line>
          ))}
          {blockedBy.length > 0 ? (
            <Line label={t('np.pmAssistant.plan.fields.blockedBy')}>
              {blockedBy.filter(isIssueRef).map((ref) => issueRefLabel(ref, views)).join(', ')}
            </Line>
          ) : null}
          {typeof params.description === 'string' && params.description ? (
            <details className='text-xs'>
              <summary className='cursor-pointer text-muted-foreground'>
                {t('np.pmAssistant.plan.fields.description')}
              </summary>
              <div className='mt-1 text-sm'>
                <NpMarkdown content={params.description} />
              </div>
            </details>
          ) : null}
        </dl>
      );
    }
    case 'issue.update':
      return (
        <dl className='space-y-0.5'>
          {updateChanges(view).map((change) => (
            <Line key={change.field} label={t(`np.pmAssistant.plan.fields.${change.field}`, { defaultValue: change.field })}>
              <span className='text-muted-foreground line-through'>
                {text(change.field, change.from)}
              </span>
              <span aria-hidden='true'> → </span>
              <span className='sr-only'>{t('np.pmAssistant.plan.becomes')}</span>
              <span className='font-medium'>{text(change.field, change.to)}</span>
            </Line>
          ))}
        </dl>
      );
    case 'issue.status': {
      const from = view.row.baseline?.statusKey;
      return (
        <p className='text-xs'>
          {from !== undefined ? (
            <>
              <span className='text-muted-foreground'>{text('statusKey', from)}</span>
              <span aria-hidden='true'> → </span>
              <span className='sr-only'>{t('np.pmAssistant.plan.becomes')}</span>
            </>
          ) : null}
          <span className='font-medium'>{text('statusKey', params.statusKey)}</span>
        </p>
      );
    }
    case 'comment.create':
      return (
        <div className='rounded-md bg-muted/60 px-2 py-1.5 text-sm'>
          <NpMarkdown content={typeof params.content === 'string' ? params.content : ''} />
        </div>
      );
    case 'decision.resolve':
      return <PmDecisionRow params={params} />;
    case 'project.create':
      return (
        <dl className='space-y-0.5'>
          <Line label={t('np.pmAssistant.plan.fields.visibility')}>
            {text('visibility', params.visibility ?? 'public')}
          </Line>
          {typeof params.description === 'string' && params.description ? (
            <Line label={t('np.pmAssistant.plan.fields.description')}>
              {params.description}
            </Line>
          ) : null}
        </dl>
      );
    default:
      return null;
  }
}
