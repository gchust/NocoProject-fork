import { useTranslation } from '@nocobase/i18n/client';
import { type ReactElement, type ReactNode, useId, useState } from 'react';

import { NpExecutorSelect } from '@/components/np-executor-select';
import { NpMultiSelect } from '@/components/np-multi-select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

import { ISSUE_PRIORITIES } from '../../constants.js';
import { PropertySelect } from '../../issues/detail/property-fields.js';
import { ProcessSelect } from '../../issues/process-fields.js';
import type { PmOperationType } from '../../types-pm.js';
import {
  fromExecutorRef,
  type PmRowView,
  toExecutorRef,
} from './pm-plan-model.js';
import type { PlanLookup } from './pm-plan-values.js';

/** Row types with fields a member may change on the card; dependencies and status moves are kept or removed whole. */
export const EDITABLE_TYPES: ReadonlySet<PmOperationType> = new Set([
  'issue.create',
  'issue.update',
  'comment.create',
  'decision.resolve',
  'project.create',
]);

const TITLE_MAX = 200;

/**
 * The fields of one plan row, stacked so they fit the drawer (NP-185). The same controls as the issue form and the
 * old batch table (priority, labels, executor, owner, process); the tree's shape — parents and dependencies — is not
 * edited here: a different shape is a new plan from the project manager.
 */
export function PmRowEditor({
  view,
  lookup,
  onChange,
}: {
  readonly view: PmRowView;
  readonly lookup: PlanLookup;
  readonly onChange: (params: Record<string, unknown>) => void;
}): ReactElement | null {
  const { params } = view;
  const set = (patch: Record<string, unknown>): void =>
    onChange({ ...params, ...patch });
  switch (view.row.type) {
    case 'issue.create':
      return (
        <IssueFields
          seq={view.row.seq}
          values={params}
          lookup={lookup}
          fields={[
            'title',
            'priority',
            'labelIds',
            'stage',
            'executor',
            'ownerUserId',
            'process',
            'description',
          ]}
          onChange={set}
        />
      );
    case 'issue.update': {
      const values =
        params.set && typeof params.set === 'object'
          ? (params.set as Record<string, unknown>)
          : {};
      return (
        <IssueFields
          seq={view.row.seq}
          values={values}
          lookup={lookup}
          fields={Object.keys(values)}
          onChange={(patch) => set({ set: { ...values, ...patch } })}
        />
      );
    }
    case 'comment.create':
      return (
        <Stack>
          <TextField
            id={`np-pm-plan-${view.row.seq}-content`}
            fieldKey='content'
            multiline
            value={params.content}
            onChange={(content) => set({ content })}
          />
        </Stack>
      );
    case 'decision.resolve':
      return (
        <Stack>
          <TextField
            id={`np-pm-plan-${view.row.seq}-comment`}
            fieldKey='comment'
            multiline
            value={params.comment}
            onChange={(comment) => set({ comment })}
          />
        </Stack>
      );
    case 'project.create':
      return (
        <Stack>
          <TextField
            id={`np-pm-plan-${view.row.seq}-name`}
            fieldKey='name'
            value={params.name}
            onChange={(name) => set({ name })}
          />
          <TextField
            id={`np-pm-plan-${view.row.seq}-description`}
            fieldKey='description'
            multiline
            value={params.description}
            onChange={(description) => set({ description })}
          />
          <VisibilityField
            id={`np-pm-plan-${view.row.seq}-visibility`}
            value={params.visibility}
            onChange={(visibility) => set({ visibility })}
          />
        </Stack>
      );
    default:
      return null;
  }
}

function Stack({ children }: { readonly children: ReactNode }): ReactElement {
  return <div className='space-y-2 rounded-md bg-muted/40 p-2'>{children}</div>;
}

function FieldRow({
  id,
  fieldKey,
  children,
}: {
  readonly id: string;
  readonly fieldKey: string;
  readonly children: ReactNode;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div className='space-y-1'>
      <Label htmlFor={id} className='text-xs text-muted-foreground'>
        {t(`np.pmAssistant.plan.fields.${fieldKey}`)}
      </Label>
      {children}
    </div>
  );
}

function TextField({
  id,
  fieldKey,
  value,
  multiline = false,
  onChange,
}: {
  readonly id: string;
  readonly fieldKey: string;
  readonly value: unknown;
  readonly multiline?: boolean;
  readonly onChange: (value: string) => void;
}): ReactElement {
  const text = typeof value === 'string' ? value : '';
  return (
    <FieldRow id={id} fieldKey={fieldKey}>
      {multiline ? (
        <Textarea
          id={id}
          rows={3}
          value={text}
          className='min-h-16'
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          id={id}
          value={text}
          maxLength={TITLE_MAX}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </FieldRow>
  );
}

function VisibilityField({
  id,
  value,
  onChange,
}: {
  readonly id: string;
  readonly value: unknown;
  readonly onChange: (value: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <FieldRow id={id} fieldKey='visibility'>
      <PropertySelect
        id={id}
        size='default'
        options={['public', 'private'].map((option) => ({
          value: option,
          label: t(`np.pmAssistant.plan.visibility.${option}`),
        }))}
        value={typeof value === 'string' ? value : 'public'}
        onChange={(next) => onChange(next ?? 'public')}
      />
    </FieldRow>
  );
}

function StageField({
  id,
  value,
  onChange,
}: {
  readonly id: string;
  readonly value: unknown;
  readonly onChange: (value: number | undefined) => void;
}): ReactElement {
  const [text, setText] = useState(
    typeof value === 'number' ? String(value) : '',
  );
  return (
    <FieldRow id={id} fieldKey='stage'>
      <Input
        id={id}
        value={text}
        inputMode='numeric'
        className='w-24'
        onChange={(event) => {
          setText(event.target.value);
          const trimmed = event.target.value.trim();
          const parsed = Number(trimmed);
          onChange(
            trimmed === '' || !Number.isInteger(parsed) || parsed < 1
              ? undefined
              : parsed,
          );
        }}
      />
    </FieldRow>
  );
}

function IssueFields({
  seq,
  values,
  lookup,
  fields,
  onChange,
}: {
  readonly seq: number;
  readonly values: Record<string, unknown>;
  readonly lookup: PlanLookup;
  readonly fields: readonly string[];
  readonly onChange: (patch: Record<string, unknown>) => void;
}): ReactElement {
  const { t } = useTranslation();
  const prefix = useId();
  const id = (field: string): string => `${prefix}-${seq}-${field}`;
  return (
    <Stack>
      {fields.map((field) => {
        switch (field) {
          case 'title':
          case 'description':
            return (
              <TextField
                key={field}
                id={id(field)}
                fieldKey={field}
                multiline={field === 'description'}
                value={values[field]}
                onChange={(next) => onChange({ [field]: next })}
              />
            );
          case 'priority':
            return (
              <FieldRow key={field} id={id(field)} fieldKey={field}>
                <PropertySelect
                  id={id(field)}
                  size='default'
                  options={ISSUE_PRIORITIES.map((value) => ({
                    value,
                    label: t(`np.priority.${value}`),
                  }))}
                  value={typeof values.priority === 'string' ? values.priority : 'none'}
                  onChange={(next) => onChange({ priority: next ?? 'none' })}
                />
              </FieldRow>
            );
          case 'labelIds':
            return (
              <FieldRow key={field} id={id(field)} fieldKey={field}>
                <NpMultiSelect
                  id={id(field)}
                  aria-label={t('np.pmAssistant.plan.fields.labelIds')}
                  options={lookup.labels.map((label) => ({
                    value: label.id,
                    label: label.name,
                  }))}
                  value={Array.isArray(values.labelIds) ? values.labelIds.map(String) : []}
                  placeholder={t('np.labels.placeholder')}
                  emptyText={t('np.labels.empty')}
                  onChange={(labelIds) => onChange({ labelIds })}
                />
              </FieldRow>
            );
          case 'stage':
            return (
              <StageField
                key={field}
                id={id(field)}
                value={values.stage}
                onChange={(stage) => onChange({ stage })}
              />
            );
          case 'executor':
            return (
              <FieldRow key={field} id={id(field)} fieldKey={field}>
                <NpExecutorSelect
                  id={id(field)}
                  aria-label={t('np.pmAssistant.plan.fields.executor')}
                  value={toExecutorRef(values.executor)}
                  agents={lookup.agents}
                  members={lookup.members}
                  onChange={(next) => onChange({ executor: fromExecutorRef(next) })}
                />
              </FieldRow>
            );
          case 'ownerUserId':
            return (
              <FieldRow key={field} id={id(field)} fieldKey={field}>
                <PropertySelect
                  id={id(field)}
                  size='default'
                  options={lookup.members.map((member) => ({
                    value: member.userId,
                    label: member.name,
                  }))}
                  value={typeof values.ownerUserId === 'string' ? values.ownerUserId : null}
                  noneLabel={t('np.intake.defaultOwner')}
                  onChange={(next) => onChange({ ownerUserId: next ?? undefined })}
                />
              </FieldRow>
            );
          case 'process':
            return (
              <FieldRow key={field} id={id(field)} fieldKey={field}>
                <ProcessSelect
                  id={id(field)}
                  aria-label={t('np.pmAssistant.plan.fields.process')}
                  choices={['direct', 'design_first']}
                  value={values.process === 'design_first' ? 'design_first' : 'direct'}
                  onChange={(process) => onChange({ process })}
                />
              </FieldRow>
            );
          case 'projectId':
            return (
              <FieldRow key={field} id={id(field)} fieldKey={field}>
                <PropertySelect
                  id={id(field)}
                  size='default'
                  options={lookup.projects.map((project) => ({
                    value: project.id,
                    label: project.name,
                  }))}
                  value={typeof values.projectId === 'string' ? values.projectId : null}
                  noneLabel={t('np.issueForm.noProject')}
                  onChange={(projectId) => onChange({ projectId })}
                />
              </FieldRow>
            );
          default:
            return null;
        }
      })}
    </Stack>
  );
}
