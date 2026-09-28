import { useTranslation } from '@nocobase/i18n/client';
import {
  IndentDecreaseIcon,
  IndentIncreaseIcon,
  Trash2Icon,
} from 'lucide-react';
import { type ReactElement, useState } from 'react';

import { NpExecutorSelect } from '@/components/np-executor-select';
import { NpMultiSelect } from '@/components/np-multi-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TableCell, TableRow } from '@/components/ui/table';

import { ISSUE_PRIORITIES } from '../constants.js';
import { PropertySelect } from '../issues/detail/property-fields.js';
import { ProcessSelect } from '../issues/process-fields.js';
import type { ProcessChoice } from '../types-iter4.js';
import type {
  AgentListItem,
  IntakeDraftFields,
  IssuePriority,
  Member,
} from '../types.js';
import {
  type DraftRow,
  type RowProblem,
  canIndent,
  parentChoices,
  parseStage,
} from './intake-model.js';

export interface IntakeRowProps {
  readonly rows: readonly DraftRow[];
  readonly index: number;
  readonly depth: number;
  readonly problems: readonly RowProblem[];
  readonly labelNames: readonly string[];
  readonly agents: readonly AgentListItem[];
  readonly members: readonly Member[];
  readonly readOnly: boolean;
  /** What a draft without a process gets (`settings.defaultProcess`, iteration 4 §D). */
  readonly defaultProcess: ProcessChoice;
  readonly onFields: (changes: Partial<IntakeDraftFields>) => void;
  readonly onParent: (parentPosition: number | null) => void;
  readonly onIndent: () => void;
  readonly onOutdent: () => void;
  readonly onRemove: () => void;
}

/**
 * One draft in the batch table: every field editable in place — the process too (iteration 4 §D; a draft without
 * one shows the workspace default, which the server applies) — its problems in a line underneath.
 */
export function IntakeRow({
  rows,
  index,
  depth,
  problems,
  labelNames,
  agents,
  members,
  readOnly,
  defaultProcess,
  onFields,
  onParent,
  onIndent,
  onOutdent,
  onRemove,
}: IntakeRowProps): ReactElement {
  const { t } = useTranslation();
  const row = rows[index];
  const [stageText, setStageText] = useState(
    row.fields.stage === null || row.fields.stage === undefined
      ? ''
      : String(row.fields.stage),
  );
  const invalid = problems.length > 0 || row.serverErrors.length > 0;
  const label = t('np.intake.rowLabel', { position: row.position });
  const cellId = (name: string): string => `np-intake-${row.key}-${name}`;

  return (
    <>
      <TableRow data-invalid={invalid ? true : undefined}>
        <TableCell className='min-w-72 align-top'>
          <div
            className='flex items-center gap-1'
            style={{ paddingInlineStart: `${depth * 1.25}rem` }}
          >
            <span className='w-6 shrink-0 text-right text-xs text-muted-foreground tabular-nums'>
              {row.position}
            </span>
            {readOnly ? null : (
              <>
                <Button
                  variant='ghost'
                  size='icon-xs'
                  disabled={row.parentPosition === null}
                  aria-label={t('np.intake.outdent', {
                    position: row.position,
                  })}
                  onClick={onOutdent}
                >
                  <IndentDecreaseIcon />
                </Button>
                <Button
                  variant='ghost'
                  size='icon-xs'
                  disabled={!canIndent(rows, index)}
                  aria-label={t('np.intake.indent', { position: row.position })}
                  onClick={onIndent}
                >
                  <IndentIncreaseIcon />
                </Button>
              </>
            )}
            <Input
              id={cellId('title')}
              value={row.fields.title}
              readOnly={readOnly}
              aria-label={`${label} ${t('np.intake.columns.title')}`}
              aria-invalid={
                problems.includes('titleRequired') ||
                problems.includes('titleTooLong')
                  ? true
                  : undefined
              }
              className='h-8'
              onChange={(event) => onFields({ title: event.target.value })}
            />
          </div>
        </TableCell>
        <TableCell className='min-w-32 align-top'>
          <PropertySelect
            id={cellId('priority')}
            options={ISSUE_PRIORITIES.map((value) => ({
              value,
              label: t(`np.priority.${value}`),
            }))}
            value={row.fields.priority ?? 'none'}
            disabled={readOnly}
            onChange={(value) =>
              onFields({ priority: (value ?? 'none') as IssuePriority })
            }
          />
        </TableCell>
        <TableCell className='min-w-44 align-top'>
          <NpMultiSelect
            id={cellId('labels')}
            aria-label={`${label} ${t('np.intake.columns.labels')}`}
            options={[
              ...new Set([...labelNames, ...(row.fields.labels ?? [])]),
            ].map((name) => ({ value: name, label: name }))}
            value={[...(row.fields.labels ?? [])]}
            disabled={readOnly}
            placeholder={t('np.labels.placeholder')}
            emptyText={t('np.labels.empty')}
            onCreate={(name) => Promise.resolve(name.trim() || undefined)}
            onChange={(labels) => onFields({ labels })}
          />
        </TableCell>
        <TableCell className='w-20 align-top'>
          <Input
            id={cellId('stage')}
            value={stageText}
            inputMode='numeric'
            readOnly={readOnly}
            aria-label={`${label} ${t('np.intake.columns.stage')}`}
            aria-invalid={
              problems.includes('stageInvalid') ||
              problems.includes('stageWithoutParent')
                ? true
                : undefined
            }
            className='h-8'
            onChange={(event) => {
              setStageText(event.target.value);
              const parsed = parseStage(event.target.value);
              onFields({ stage: parsed === 'invalid' ? Number.NaN : parsed });
            }}
          />
        </TableCell>
        <TableCell className='min-w-40 align-top'>
          <PropertySelect
            id={cellId('parent')}
            options={parentChoices(rows, index).map((choice) => ({
              value: String(choice.position),
              label: `${choice.position}. ${choice.fields.title || t('np.intake.untitled')}`,
            }))}
            value={
              row.parentPosition === null ? null : String(row.parentPosition)
            }
            noneLabel={t('np.intake.noParent')}
            disabled={readOnly}
            onChange={(value) =>
              onParent(value === null ? null : Number(value))
            }
          />
        </TableCell>
        <TableCell className='min-w-40 align-top'>
          <NpExecutorSelect
            id={cellId('executor')}
            className='h-8'
            aria-label={`${label} ${t('np.intake.columns.executor')}`}
            value={row.fields.executor ?? { type: 'none', id: null }}
            agents={agents}
            members={members}
            disabled={readOnly}
            onChange={(executor) =>
              onFields({ executor: executor.type === 'none' ? null : executor })
            }
          />
        </TableCell>
        <TableCell className='min-w-36 align-top'>
          <PropertySelect
            id={cellId('owner')}
            options={members.map((member) => ({
              value: member.userId,
              label: member.name,
            }))}
            value={row.fields.ownerUserId ?? null}
            noneLabel={t('np.intake.defaultOwner')}
            disabled={readOnly}
            onChange={(value) => onFields({ ownerUserId: value })}
          />
        </TableCell>
        <TableCell className='min-w-36 align-top'>
          <ProcessSelect
            id={cellId('process')}
            size='sm'
            aria-label={`${label} ${t('np.intake.columns.process')}`}
            value={row.fields.process ?? defaultProcess}
            disabled={readOnly}
            onChange={(process) => onFields({ process })}
          />
        </TableCell>
        <TableCell className='w-10 align-top'>
          {readOnly ? null : (
            <Button
              variant='ghost'
              size='icon-sm'
              aria-label={t('np.intake.removeRow', { position: row.position })}
              onClick={onRemove}
            >
              <Trash2Icon />
            </Button>
          )}
        </TableCell>
      </TableRow>
      {invalid ? (
        <TableRow className='border-0 hover:bg-transparent'>
          <TableCell colSpan={9} className='pt-0 pb-2'>
            <ul
              className='space-y-0.5 text-xs text-destructive'
              aria-label={t('np.intake.rowProblems', {
                position: row.position,
              })}
            >
              {problems.map((problem) => (
                <li key={problem}>{t(`np.intake.problems.${problem}`)}</li>
              ))}
              {row.serverErrors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
