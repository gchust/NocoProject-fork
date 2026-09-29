import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import {
  NpExecutor,
  NpPriorityLabel,
  NpStatusBadge,
} from '@/components/np-badges';
import { NpExecutorSelect } from '@/components/np-executor-select';
import { NpLabelColorPicker } from '@/components/np-label-color-picker';
import { NpStartDialog } from '@/components/np-start-dialog';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';

import {
  fetchLabels,
  fetchMembers,
  updateLabelColor,
} from '../../api-collab.js';
import { issueProcess } from '../../api-iter4.js';
import { fetchProjects } from '../../api.js';
import {
  ISSUE_PRIORITIES,
  isTerminalStatus,
  statusCategory,
  npKeys,
  statusLabelKey,
} from '../../constants.js';
import { useNpFormatters } from '../../format.js';
import { canActAsIssueOwner, viewerFrom } from '../../permissions.js';
import type {
  AgentListItem,
  IssueDetail,
  IssuePriority,
  Label,
  LabelColor,
  Me,
} from '../../types.js';
import type { ProcessChoice } from '../../types-iter4.js';
import { ProcessSelect } from '../process-fields.js';
import { ExecutionLog } from './execution-log.js';
import { IssueUsage } from './issue-usage.js';
import {
  DateField,
  LabelsField,
  PropertyRow,
  PropertySelect,
} from './property-fields.js';
import { SessionPanel } from './session-panel.js';
import { Subscribers } from './subscribers.js';
import { useConfirmedUpdate } from './use-confirmed-update.js';
import { useIssueUpdate } from './use-issue-update.js';

/** The issue page offers the two processes; Automatic is a create-time choice only. */
const ISSUE_PROCESS_CHOICES: readonly ProcessChoice[] = [
  'direct',
  'design_first',
];

const PANEL_CARD =
  'space-y-3 rounded-lg border bg-card p-4 text-card-foreground';

/**
 * The right-hand panel: editable properties, dates, labels, subscribers, timestamps and the execution log.
 *
 * Controls the §B rules would refuse are disabled rather than hidden, so the value stays readable: the owner picker
 * and the done / cancelled statuses for anyone but the owner, the project lead and owner/admin; agents the viewer
 * cannot invoke in the executor picker. The server enforces the same rules.
 */
export function PropertiesPanel({
  detail,
  agents,
  me,
}: {
  readonly detail: IssueDetail;
  readonly agents: readonly AgentListItem[];
  readonly me: Me | undefined;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const format = useNpFormatters();
  const { issue, statusCatalog } = detail;
  const update = useIssueUpdate(issue);
  const confirmed = useConfirmedUpdate({
    issue,
    catalog: statusCatalog,
    agents,
    mutate: (changes) => update.mutate(changes),
  });

  const members = useQuery({
    queryKey: npKeys.members,
    queryFn: () => fetchMembers(api),
  });
  const projects = useQuery({
    queryKey: npKeys.projects,
    queryFn: () => fetchProjects(api),
  });
  const labels = useQuery({
    queryKey: npKeys.labels,
    queryFn: () => fetchLabels(api),
  });
  const queryClient = useQueryClient();
  const recolor = useMutation({
    mutationFn: ({ label, color }: { label: Label; color: LabelColor }) =>
      updateLabelColor(api, label.id, color),
    onError: () =>
      toast.add({
        type: 'error',
        priority: 'high',
        title: t('np.common.requestFailed'),
      }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: npKeys.labels });
      void queryClient.invalidateQueries({ queryKey: npKeys.issue(issue.id) });
      void queryClient.invalidateQueries({ queryKey: npKeys.issues });
    },
  });
  const sessionMode = issue.executionMode === 'session';

  const projectId = detail.project?.id ?? issue.projectId ?? null;
  const project = projects.data?.find((item) => item.id === projectId);
  const viewer = viewerFrom(me?.userId, members.data);
  const ownerPowers = canActAsIssueOwner(viewer, issue, project?.leadUserId);

  const statusItems = statusCatalog.map((entry) => ({
    value: entry.key,
    label: t(statusLabelKey(entry.key), { defaultValue: entry.key }),
    disabled:
      !ownerPowers &&
      entry.key !== issue.statusKey &&
      isTerminalStatus(entry.key, statusCatalog),
  }));
  const priorityItems = ISSUE_PRIORITIES.map((value) => ({
    value,
    label: t(`np.priority.${value}`),
  }));
  const busy = update.isPending;

  return (
    // The side column is a stack of small cards (nocosolution/frontend/nocosolution-frontend-standard.md §3): properties, the session, runs,
    // participants, details and usage.
    <div className='space-y-3 p-3 md:p-4'>
      <section className={PANEL_CARD} aria-labelledby='np-properties-heading'>
        <h2
          id='np-properties-heading'
          className='flex items-center gap-2 text-sm font-semibold'
        >
          {t('np.properties.title')}
          {busy ? (
            <Spinner
              className='size-3.5 text-muted-foreground'
              aria-label={t('np.common.saving')}
            />
          ) : null}
        </h2>
        <PropertyRow label={t('np.properties.status')} htmlFor='np-prop-status'>
          <Select
            items={statusItems}
            value={issue.statusKey}
            disabled={busy}
            onValueChange={(value) => {
              if (value && value !== issue.statusKey) {
                confirmed.apply({ statusKey: value });
              }
            }}
          >
            <SelectTrigger id='np-prop-status' size='sm' className='w-full'>
              <SelectValue>
                {() => (
                  <NpStatusBadge
                    statusKey={issue.statusKey}
                    catalog={statusCatalog}
                  />
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {statusItems.map((item) => (
                <SelectItem
                  key={item.value}
                  value={item.value}
                  disabled={item.disabled}
                >
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </PropertyRow>
        <PropertyRow
          label={t('np.properties.priority')}
          htmlFor='np-prop-priority'
        >
          <Select
            items={priorityItems}
            value={issue.priority}
            disabled={busy}
            onValueChange={(value: IssuePriority | null) => {
              if (value && value !== issue.priority) {
                update.mutate({ priority: value });
              }
            }}
          >
            <SelectTrigger id='np-prop-priority' size='sm' className='w-full'>
              <SelectValue>
                {() => <NpPriorityLabel priority={issue.priority} />}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {priorityItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </PropertyRow>
        <PropertyRow label={t('np.properties.owner')} htmlFor='np-prop-owner'>
          {members.data ? (
            <PropertySelect
              id='np-prop-owner'
              options={members.data.map((member) => ({
                value: member.userId,
                label:
                  member.userId === me?.userId
                    ? `${member.name} ${t('np.properties.you')}`
                    : member.name,
              }))}
              value={issue.ownerUserId}
              disabled={busy || !ownerPowers}
              onChange={(value) => {
                if (value) update.mutate({ ownerUserId: value });
              }}
            />
          ) : (
            <span className='truncate'>{issue.ownerName ?? '—'}</span>
          )}
        </PropertyRow>
        {me && issue.ownerUserId !== me.userId && ownerPowers ? (
          <PropertyRow label=''>
            <Button
              variant='ghost'
              size='xs'
              disabled={busy}
              onClick={() => update.mutate({ ownerUserId: me.userId })}
            >
              {t('np.properties.assignToMe')}
            </Button>
          </PropertyRow>
        ) : null}
        <PropertyRow
          label={t('np.properties.executor')}
          htmlFor='np-prop-executor'
        >
          <NpExecutorSelect
            id='np-prop-executor'
            className='h-7'
            value={{ type: issue.executorType, id: issue.executorId }}
            agents={agents}
            members={members.data}
            userExecutorName={
              issue.executorType === 'user' ? issue.executorName : null
            }
            disabled={busy}
            onChange={(executor) => confirmed.apply({ executor })}
          />
        </PropertyRow>
        {issue.executorType === 'agent' && (issue.activeRunCount ?? 0) > 0 ? (
          <PropertyRow label=''>
            <NpExecutor
              type='agent'
              name={issue.executorName}
              activeRunCount={issue.activeRunCount}
            />
          </PropertyRow>
        ) : null}
        <PropertyRow label={t('np.properties.labels')} htmlFor='np-prop-labels'>
          <div className='flex items-center gap-1'>
            <div className='min-w-0 flex-1'>
              <LabelsField
                id='np-prop-labels'
                labels={labels.data ?? detail.labels}
                value={detail.labels.map((label) => label.id)}
                disabled={busy}
                onChange={(labelIds) => update.mutate({ labelIds })}
              />
            </div>
            <NpLabelColorPicker
              labels={detail.labels}
              disabled={recolor.isPending}
              onChange={(label, color) => recolor.mutate({ label, color })}
            />
          </div>
        </PropertyRow>
        <PropertyRow
          label={t('np.properties.project')}
          htmlFor='np-prop-project'
        >
          <PropertySelect
            id='np-prop-project'
            options={(projects.data ?? []).map((item) => ({
              value: item.id,
              label: item.name,
            }))}
            value={projectId}
            noneLabel={t('np.issueForm.noProject')}
            noneAsDash
            disabled={busy || !projects.data}
            onChange={(value) => update.mutate({ projectId: value })}
          />
        </PropertyRow>
        <PropertyRow label={t('np.dates.start')} htmlFor='np-prop-start'>
          <DateField
            id='np-prop-start'
            value={issue.startDate}
            disabled={busy}
            clearLabel={t('np.dates.clearStart')}
            onChange={(value) => update.mutate({ startDate: value })}
          />
        </PropertyRow>
        <PropertyRow label={t('np.dates.due')} htmlFor='np-prop-due'>
          <DateField
            id='np-prop-due'
            value={issue.dueDate}
            disabled={busy}
            clearLabel={t('np.dates.clearDue')}
            onChange={(value) => update.mutate({ dueDate: value })}
          />
        </PropertyRow>
        <PropertyRow
          label={t('np.properties.autoExecute')}
          htmlFor='np-prop-auto-execute'
        >
          <Switch
            id='np-prop-auto-execute'
            checked={issue.autoExecuteSubtasks ?? false}
            disabled={busy}
            onCheckedChange={(checked) =>
              update.mutate({ autoExecuteSubtasks: checked })
            }
          />
        </PropertyRow>
        <PropertyRow
          label={t('np.session.modeLabel')}
          htmlFor='np-prop-session-mode'
        >
          <div className='flex items-center gap-2'>
            <Switch
              id='np-prop-session-mode'
              checked={sessionMode}
              disabled={busy}
              onCheckedChange={(checked) =>
                update.mutate({ executionMode: checked ? 'session' : 'task' })
              }
            />
            <span className='text-xs text-muted-foreground'>
              {sessionMode
                ? t('np.session.modeSession')
                : t('np.session.modeTask')}
            </span>
          </div>
        </PropertyRow>
        <PropertyRow label={t('np.process.label')} htmlFor='np-prop-process'>
          <ProcessSelect
            id='np-prop-process'
            size='sm'
            choices={ISSUE_PROCESS_CHOICES}
            value={issueProcess(issue)}
            // Iteration 4 §B: the process changes only before work starts (409 `PROCESS_LOCKED` otherwise).
            disabled={
              busy ||
              statusCategory(issue.statusKey, statusCatalog) !== 'unstarted'
            }
            onChange={(process) => {
              if (process !== 'auto') update.mutate({ process });
            }}
          />
        </PropertyRow>
      </section>

      {sessionMode ? (
        <div className={PANEL_CARD}>
          <SessionPanel detail={detail} agents={agents} />
        </div>
      ) : null}

      <div className={PANEL_CARD}>
        <ExecutionLog runs={detail.runs} agents={agents} issueId={issue.id} />
      </div>

      <section className={PANEL_CARD} aria-labelledby='np-subscribers-heading'>
        <h2 id='np-subscribers-heading' className='text-sm font-semibold'>
          {t('np.subscribers.title')}
        </h2>
        <Subscribers
          issueId={issue.id}
          subscribers={detail.subscribers}
          meUserId={me?.userId}
        />
      </section>

      <section className={PANEL_CARD} aria-labelledby='np-details-heading'>
        <h2 id='np-details-heading' className='text-sm font-semibold'>
          {t('np.properties.details')}
        </h2>
        <PropertyRow label={t('np.properties.created')}>
          <span title={format.dateTime(issue.createdAt)}>
            {format.dateTime(issue.createdAt)}
          </span>
        </PropertyRow>
        <PropertyRow label={t('np.properties.updated')}>
          <span title={format.dateTime(issue.updatedAt)}>
            {format.relative(issue.updatedAt)}
          </span>
        </PropertyRow>
      </section>

      <div className={PANEL_CARD}>
        <IssueUsage issue={issue} usage={detail.usage} />
      </div>

      <NpStartDialog
        request={confirmed.startRequest}
        onDecide={confirmed.decide}
        onCancel={confirmed.cancel}
      />
    </div>
  );
}
