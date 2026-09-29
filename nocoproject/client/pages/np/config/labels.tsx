import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon, TagIcon } from 'lucide-react';
import { type FormEvent, type ReactElement, useState } from 'react';

import { NpLabelDot } from '@/components/np-labels';
import { NpEmpty, NpListSkeleton, NpLoadError } from '@/components/np-states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/toast';

import { createLabel, fetchLabels } from '../api-collab.js';
import { deleteLabel, updateLabel } from '../api-iter3.js';
import { npKeys } from '../constants.js';
import type { Label, LabelColor } from '../types.js';
import { ConfigSectionHeading } from './config-section.js';
import { ColorSwatches, LabelRow } from './label-row.js';
import { settingsCheck } from './config-access.js';

/**
 * Tab `/config/labels` (§G): every label with its color. Whoever may change the settings item `nocoproject.labels`
 * (NP-117; owner/admin by default) creates, renames, recolors and deletes (delete asks first and unlinks the label
 * from its issues); everyone else sees the list read-only. A duplicate name answers 409.
 */
export default function LabelsConfigTab(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const edit = useCan(settingsCheck('labels', 'update'));
  const labels = useQuery({
    queryKey: npKeys.labels,
    queryFn: () => fetchLabels(api),
  });
  const canEdit = edit.can;

  function failed(error: unknown): void {
    toast.add({
      type: 'error',
      priority: 'high',
      title:
        error instanceof ApiClientError && error.status === 409
          ? t('np.config.labels.duplicate')
          : error instanceof ApiClientError && error.status === 403
            ? t('np.common.forbidden')
            : t('np.common.requestFailed'),
    });
  }
  function settled(): void {
    void queryClient.invalidateQueries({ queryKey: npKeys.labels });
    void queryClient.invalidateQueries({ queryKey: npKeys.issues });
    void queryClient.invalidateQueries({ queryKey: ['np', 'issue'] });
  }

  const create = useMutation({
    mutationFn: (input: { name: string; color: LabelColor }) =>
      createLabel(api, input),
    onSuccess: (label) =>
      toast.add({
        type: 'success',
        title: t('np.config.labels.created', { name: label.name }),
      }),
    onError: failed,
    onSettled: settled,
  });
  const update = useMutation({
    mutationFn: ({
      label,
      changes,
    }: {
      label: Label;
      changes: { name?: string; color?: LabelColor };
    }) => updateLabel(api, label.id, changes),
    onSuccess: (_, { label, changes }) =>
      toast.add({
        type: 'success',
        title: changes.name
          ? t('np.config.labels.renamed', { name: changes.name })
          : t('np.config.labels.recolored', { name: label.name }),
      }),
    onError: failed,
    onSettled: settled,
  });
  const remove = useMutation({
    mutationFn: (label: Label) => deleteLabel(api, label.id),
    onSuccess: (_, label) =>
      toast.add({
        type: 'success',
        title: t('np.config.labels.deleted', { name: label.name }),
      }),
    onError: failed,
    onSettled: settled,
  });
  const busy = create.isPending || update.isPending || remove.isPending;

  let content: ReactElement;
  if (labels.isError && !labels.data) {
    content = (
      <NpLoadError
        title={t('np.config.labels.loadFailed')}
        error={labels.error}
        onRetry={() => void labels.refetch()}
      />
    );
  } else if (!labels.data || edit.isPending) {
    content = <NpListSkeleton rows={4} />;
  } else if (labels.data.length === 0) {
    content = (
      <NpEmpty
        icon={<TagIcon />}
        title={t('np.config.labels.emptyTitle')}
        description={t('np.config.labels.emptyDescription')}
      />
    );
  } else {
    content = (
      <div className='overflow-hidden rounded-lg border'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('np.config.labels.columns.name')}</TableHead>
              <TableHead>{t('np.config.labels.columns.color')}</TableHead>
              {canEdit ? (
                <TableHead className='w-24'>
                  <span className='sr-only'>
                    {t('np.config.labels.columns.actions')}
                  </span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {labels.data.map((label) => (
              <LabelRow
                key={label.id}
                label={label}
                canEdit={canEdit}
                busy={busy}
                onRename={(name) => update.mutate({ label, changes: { name } })}
                onRecolor={(color) =>
                  update.mutate({ label, changes: { color } })
                }
                onDelete={() => remove.mutate(label)}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <section className='space-y-4' aria-labelledby='np-config-labels-heading'>
      <ConfigSectionHeading
        id='np-config-labels-heading'
        title={t('np.config.labels.title')}
        description={
          canEdit
            ? t('np.config.labels.description')
            : t('np.config.labels.readOnly')
        }
      />
      {canEdit ? (
        <CreateLabelForm
          pending={create.isPending}
          onCreate={(input) => create.mutate(input)}
        />
      ) : null}
      {content}
    </section>
  );
}

function CreateLabelForm({
  pending,
  onCreate,
}: {
  readonly pending: boolean;
  readonly onCreate: (input: { name: string; color: LabelColor }) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [color, setColor] = useState<LabelColor>('gray');

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate({ name: trimmed, color });
    setName('');
  }

  return (
    <form
      onSubmit={submit}
      className='flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3'
    >
      <NpLabelDot color={color} className='size-3' />
      <Input
        value={name}
        maxLength={50}
        placeholder={t('np.config.labels.namePlaceholder')}
        aria-label={t('np.config.labels.newName')}
        className='w-56'
        onChange={(event) => setName(event.target.value)}
      />
      <ColorSwatches
        value={color}
        label={t('np.config.labels.newColor')}
        onChange={setColor}
      />
      <Button type='submit' disabled={pending || !name.trim()}>
        {pending ? (
          <Spinner data-icon='inline-start' />
        ) : (
          <PlusIcon data-icon='inline-start' />
        )}
        {t('np.config.labels.create')}
      </Button>
    </form>
  );
}
