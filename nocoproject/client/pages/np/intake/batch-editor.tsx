import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckIcon,
  CircleAlertIcon,
  PlusIcon,
  SaveIcon,
  XIcon,
} from 'lucide-react';
import { type ReactElement, useState } from 'react';

import { NpExecutorSelect } from '@/components/np-executor-select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { NpTag } from '@/components/np-tag';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { useRouteOverlay } from '@/components/use-route-overlay';

import { fetchLabels, fetchMembers } from '../api-collab.js';
import {
  cancelIntakeBatch,
  confirmIntakeBatch,
  saveIntakeDrafts,
} from '../api-intake.js';
import { fetchWorkspaceSettings } from '../api-iter2.js';
import { readDefaultProcess } from '../api-iter4.js';
import { fetchAgents, fetchMe, fetchProjects } from '../api.js';
import { npKeys } from '../constants.js';
import { PropertySelect } from '../issues/detail/property-fields.js';
import type { ExecutorRef, IntakeBatchDetail } from '../types.js';
import { IntakeAttachments } from './intake-attachments.js';
import {
  type DraftRow,
  addRow,
  depthOf,
  draftInputs,
  hasProblems,
  indentRow,
  moveAttachment,
  outdentRow,
  removeRow,
  rowProblems,
  rowsFromDrafts,
  setParent,
  updateFields,
} from './intake-model.js';
import { IntakeRow } from './intake-row.js';

const COLUMNS = [
  'title',
  'priority',
  'labels',
  'stage',
  'parent',
  'executor',
  'owner',
  'process',
] as const;

/**
 * The drafts of one batch as an editable table (iteration 2 §E). Edits stay local until "Save" or "Create issues";
 * both replace the drafts on the server, which validates them again. Creating runs only when neither the browser
 * nor the server reports a problem, then closes the new-issue dialog like the manual tab does (NP-124). NP-78: the batch's files are listed above the table
 * with the draft each one goes to (`fields.attachmentIds`).
 */
export function BatchEditor({
  detail,
  onClose,
}: {
  readonly detail: IntakeBatchDetail;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const { close } = useRouteOverlay();
  const { batch } = detail;
  const readOnly = batch.status !== 'draft';
  const [rows, setRows] = useState<DraftRow[]>(() =>
    rowsFromDrafts(detail.drafts),
  );
  const [ownerUserId, setOwnerUserId] = useState<string | null>(null);
  const [defaultExecutor, setDefaultExecutor] = useState<ExecutorRef>({
    type: 'none',
    id: null,
  });

  const agents = useQuery({
    queryKey: npKeys.agents,
    queryFn: () => fetchAgents(api),
  });
  const members = useQuery({
    queryKey: npKeys.members,
    queryFn: () => fetchMembers(api),
  });
  const labels = useQuery({
    queryKey: npKeys.labels,
    queryFn: () => fetchLabels(api),
  });
  const me = useQuery({ queryKey: npKeys.me, queryFn: () => fetchMe(api) });
  const projects = useQuery({
    queryKey: npKeys.projects,
    queryFn: () => fetchProjects(api),
  });
  const settings = useQuery({
    queryKey: npKeys.settings,
    queryFn: () => fetchWorkspaceSettings(api),
    retry: false,
  });
  const defaultProcess = readDefaultProcess(settings.data?.defaultProcess);
  const projectName =
    batch.projectName ??
    projects.data?.find((project) => project.id === batch.projectId)?.name;
  const context = { source: batch.source, agents: agents.data };
  const blocked = rows.length === 0 || hasProblems(rows, context);

  const errorTitle = (error: unknown): string =>
    error instanceof ApiClientError && error.status === 403
      ? t('np.common.forbidden')
      : error instanceof ApiClientError && error.status === 409
        ? t('np.intake.stateChanged')
        : t('np.common.requestFailed');

  const save = useMutation({
    mutationFn: () => saveIntakeDrafts(api, batch.id, draftInputs(rows)),
    onSuccess: (drafts) => {
      setRows(rowsFromDrafts(drafts));
      void queryClient.invalidateQueries({ queryKey: npKeys.intakeBatches });
    },
    onError: (error) =>
      toast.add({ type: 'error', priority: 'high', title: errorTitle(error) }),
  });

  const confirm = useMutation({
    mutationFn: async () => {
      const drafts = await saveIntakeDrafts(api, batch.id, draftInputs(rows));
      const next = rowsFromDrafts(drafts);
      setRows(next);
      if (next.some((row) => row.serverErrors.length > 0)) return null;
      return confirmIntakeBatch(api, batch.id, {
        ownerUserId: ownerUserId ?? undefined,
        defaultExecutor:
          defaultExecutor.type === 'none' ? undefined : defaultExecutor,
      });
    },
    onSuccess: (issues) => {
      if (!issues) {
        toast.add({
          type: 'error',
          priority: 'high',
          title: t('np.intake.fixProblems'),
        });
        return;
      }
      toast.add({
        type: 'success',
        title: t('np.intake.created', { count: issues.length }),
      });
      void queryClient.invalidateQueries({ queryKey: npKeys.issues });
      void queryClient.invalidateQueries({ queryKey: npKeys.intakeBatches });
      const sourceIssueId = batch.sourceIssueId ?? batch.issueId;
      if (sourceIssueId) {
        void queryClient.invalidateQueries({
          queryKey: npKeys.issue(sourceIssueId),
        });
      }
      void close();
    },
    onError: (error) =>
      toast.add({ type: 'error', priority: 'high', title: errorTitle(error) }),
  });

  const cancel = useMutation({
    mutationFn: () => cancelIntakeBatch(api, batch.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: npKeys.intakeBatches });
      onClose();
    },
    onError: (error) =>
      toast.add({ type: 'error', priority: 'high', title: errorTitle(error) }),
  });
  const busy = save.isPending || confirm.isPending || cancel.isPending;

  return (
    <section className='space-y-4' aria-labelledby='np-intake-batch-heading'>
      <div className='flex flex-wrap items-center gap-2'>
        <h2
          id='np-intake-batch-heading'
          className='font-heading text-sm font-semibold'
        >
          {t('np.intake.draftsTitle', { count: rows.length })}
        </h2>
        <NpTag tone='grey'>{t(`np.intake.parser.${batch.parser}`)}</NpTag>
        <NpTag tone='blue' dot>
          {t(`np.intake.status.${batch.status}`)}
        </NpTag>
        {projectName ? (
          <span className='text-sm text-muted-foreground'>{projectName}</span>
        ) : null}
      </div>
      {batch.parseError ? (
        <Alert>
          <CircleAlertIcon />
          <AlertDescription>{t('np.intake.parseFallback')}</AlertDescription>
        </Alert>
      ) : null}
      {batch.source === 'issue' ? (
        <p className='text-sm text-muted-foreground'>
          {t('np.intake.issueSourceHint')}
        </p>
      ) : null}
      {detail.attachments && detail.attachments.length > 0 ? (
        <IntakeAttachments
          attachments={detail.attachments}
          rows={rows}
          readOnly={readOnly || busy}
          onMove={(fileId, index) =>
            setRows((current) => moveAttachment(current, fileId, index))
          }
        />
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            {COLUMNS.map((column) => (
              <TableHead key={column}>
                {t(`np.intake.columns.${column}`)}
              </TableHead>
            ))}
            <TableHead>
              <span className='sr-only'>{t('np.intake.columns.actions')}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <IntakeRow
              key={row.key}
              rows={rows}
              index={index}
              depth={depthOf(rows, index)}
              problems={rowProblems(rows, index, context)}
              labelNames={(labels.data ?? []).map((label) => label.name)}
              agents={agents.data ?? []}
              members={members.data ?? []}
              readOnly={readOnly || busy}
              defaultProcess={defaultProcess}
              onFields={(changes) =>
                setRows((current) => updateFields(current, index, changes))
              }
              onParent={(parent) =>
                setRows((current) => setParent(current, index, parent))
              }
              onIndent={() => setRows((current) => indentRow(current, index))}
              onOutdent={() => setRows((current) => outdentRow(current, index))}
              onRemove={() => setRows((current) => removeRow(current, index))}
            />
          ))}
        </TableBody>
      </Table>
      {readOnly ? null : (
        <>
          <Button
            variant='outline'
            size='sm'
            disabled={busy}
            onClick={() => setRows((current) => addRow(current))}
          >
            <PlusIcon data-icon='inline-start' />
            {t('np.intake.addRow')}
          </Button>
          <div className='grid gap-4 sm:grid-cols-2'>
            <Field>
              <FieldLabel htmlFor='np-intake-owner'>
                {t('np.intake.batchOwner')}
              </FieldLabel>
              <PropertySelect
                id='np-intake-owner'
                size='default'
                options={(members.data ?? []).map((member) => ({
                  value: member.userId,
                  label: member.name,
                }))}
                value={ownerUserId ?? me.data?.userId ?? null}
                disabled={busy}
                onChange={setOwnerUserId}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor='np-intake-executor'>
                {t('np.intake.defaultExecutor')}
              </FieldLabel>
              <NpExecutorSelect
                id='np-intake-executor'
                value={defaultExecutor}
                agents={agents.data ?? []}
                members={members.data}
                disabled={busy}
                onChange={setDefaultExecutor}
              />
            </Field>
          </div>
          <div className='flex flex-wrap justify-end gap-2'>
            <Button
              variant='ghost'
              disabled={busy}
              onClick={() => cancel.mutate()}
            >
              <XIcon data-icon='inline-start' />
              {t('np.intake.discard')}
            </Button>
            <Button
              variant='outline'
              disabled={busy}
              onClick={() => save.mutate()}
            >
              {save.isPending ? (
                <Spinner data-icon='inline-start' />
              ) : (
                <SaveIcon data-icon='inline-start' />
              )}
              {t('np.intake.save')}
            </Button>
            <Button disabled={busy || blocked} onClick={() => confirm.mutate()}>
              {confirm.isPending ? (
                <Spinner data-icon='inline-start' />
              ) : (
                <CheckIcon data-icon='inline-start' />
              )}
              {t('np.intake.confirm', { count: rows.length })}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
