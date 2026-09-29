import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  EyeIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';

import {
  deleteAgentEnv,
  fetchAgentEnv,
  fetchAgentEnvAudits,
  revealAgentEnv,
} from '../../api-agent-extras.js';
import { npKeys } from '../../constants.js';
import { useNpFormatters } from '../../format.js';
import type { AgentEnvVarValue } from '../../types.js';
import { EnvVarDialog, RevealedDialog } from './env-dialogs.js';

/**
 * The agent's environment variables (iteration 2 §G). Values are write-only: the list shows names and who changed
 * them; setting a value replaces it without showing the old one. Owner/admin may reveal the values, which is recorded
 * in the audit list below; the daemon injects them into the agent's tool processes and masks them in transcripts.
 */
export function AgentEnvSection({
  agentId,
  canEdit,
  canAudit,
}: {
  readonly agentId: string;
  readonly canEdit: boolean;
  readonly canAudit: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const format = useNpFormatters();
  const [editing, setEditing] = useState<{
    readonly name: string | null;
  } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmReveal, setConfirmReveal] = useState(false);
  const [revealed, setRevealed] = useState<readonly AgentEnvVarValue[] | null>(
    null,
  );

  const vars = useQuery({
    queryKey: npKeys.agentEnv(agentId),
    queryFn: () => fetchAgentEnv(api, agentId),
  });
  const audits = useQuery({
    queryKey: npKeys.agentEnvAudits(agentId),
    queryFn: () => fetchAgentEnvAudits(api, agentId),
    enabled: canAudit,
  });
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: npKeys.agentEnv(agentId) });
  };
  const failure = (error: unknown): void => {
    toast.add({
      type: 'error',
      priority: 'high',
      title:
        error instanceof ApiClientError && error.status === 403
          ? t('np.common.forbidden')
          : t('np.common.requestFailed'),
    });
  };

  const remove = useMutation({
    mutationFn: (name: string) => deleteAgentEnv(api, agentId, name),
    onSuccess: (_, name) =>
      toast.add({ type: 'success', title: t('np.envVars.deleted', { name }) }),
    onError: failure,
    onSettled: refresh,
  });
  const reveal = useMutation({
    mutationFn: () => revealAgentEnv(api, agentId),
    onSuccess: (values) => setRevealed(values),
    onError: failure,
    onSettled: refresh,
  });

  return (
    <section
      className='max-w-2xl space-y-3'
      aria-labelledby='np-agent-env-heading'
    >
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='space-y-1'>
          <h2
            id='np-agent-env-heading'
            className='font-heading text-sm font-semibold'
          >
            {t('np.envVars.title')}
          </h2>
          <p className='text-sm text-muted-foreground'>
            {t('np.envVars.description')}
          </p>
        </div>
        <div className='flex gap-2'>
          {canAudit ? (
            <Button
              variant='outline'
              size='sm'
              disabled={reveal.isPending || (vars.data ?? []).length === 0}
              onClick={() => setConfirmReveal(true)}
            >
              <EyeIcon data-icon='inline-start' />
              {t('np.envVars.reveal')}
            </Button>
          ) : null}
          {canEdit ? (
            <Button
              variant='outline'
              size='sm'
              onClick={() => setEditing({ name: null })}
            >
              <PlusIcon data-icon='inline-start' />
              {t('np.envVars.add')}
            </Button>
          ) : null}
        </div>
      </div>
      {!vars.data ? (
        <p className='text-sm text-muted-foreground'>
          {vars.isError ? t('np.common.requestFailed') : t('status.loading')}
        </p>
      ) : vars.data.length === 0 ? (
        <p className='text-sm text-muted-foreground'>{t('np.envVars.empty')}</p>
      ) : (
        <ul
          className='divide-y rounded-lg border'
          aria-label={t('np.envVars.title')}
        >
          {vars.data.map((item) => (
            <li
              key={item.name}
              className='flex items-center gap-3 px-3 py-2 text-sm'
            >
              <KeyRoundIcon
                className='size-4 shrink-0 text-muted-foreground'
                aria-hidden='true'
              />
              <span className='min-w-0 flex-1 truncate font-mono'>
                {item.name}
              </span>
              <span className='hidden text-xs text-muted-foreground sm:inline'>
                {item.updatedByName
                  ? t('np.envVars.updatedBy', {
                      name: item.updatedByName,
                      time: format.relative(item.updatedAt),
                    })
                  : format.relative(item.updatedAt)}
              </span>
              {canEdit ? (
                <>
                  <Button
                    variant='ghost'
                    size='icon-xs'
                    aria-label={t('np.envVars.edit', { name: item.name })}
                    onClick={() => setEditing({ name: item.name })}
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    variant='ghost'
                    size='icon-xs'
                    disabled={remove.isPending}
                    aria-label={t('np.envVars.delete', { name: item.name })}
                    onClick={() => setDeleting(item.name)}
                  >
                    <Trash2Icon />
                  </Button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canAudit ? (
        <div className='space-y-2'>
          <h3 className='text-sm font-semibold'>
            {t('np.envVars.auditsTitle')}
          </h3>
          {(audits.data ?? []).length === 0 ? (
            <p className='text-sm text-muted-foreground'>
              {t('np.envVars.auditsEmpty')}
            </p>
          ) : (
            <ol className='space-y-1 text-xs text-muted-foreground'>
              {(audits.data ?? []).map((audit) => (
                <li key={audit.id} className='flex flex-wrap gap-x-2'>
                  <time dateTime={audit.createdAt}>
                    {format.dateTime(audit.createdAt)}
                  </time>
                  <span className='text-foreground'>
                    {audit.userName ?? audit.userId}
                  </span>
                  <span>{t(`np.envVars.auditAction.${audit.action}`)}</span>
                  <span className='font-mono'>{audit.names.join(', ')}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}

      <EnvVarDialog
        agentId={agentId}
        target={editing}
        existingNames={(vars.data ?? []).map((item) => item.name)}
        onClose={() => setEditing(null)}
        onSaved={() => {
          refresh();
          void queryClient.invalidateQueries({
            queryKey: npKeys.agentEnvAudits(agentId),
          });
        }}
      />
      <RevealedDialog values={revealed} onClose={() => setRevealed(null)} />
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('np.envVars.deleteTitle', { name: deleting ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('np.envVars.deleteDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant='destructive'
              onClick={() => {
                const name = deleting;
                setDeleting(null);
                if (name) remove.mutate(name);
              }}
            >
              {t('np.envVars.deleteConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmReveal} onOpenChange={setConfirmReveal}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('np.envVars.revealTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('np.envVars.revealAudit')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmReveal(false);
                reveal.mutate();
                void queryClient.invalidateQueries({
                  queryKey: npKeys.agentEnvAudits(agentId),
                });
              }}
            >
              {t('np.envVars.reveal')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
