import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2Icon } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { useNavigate } from 'react-router';

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

import { deleteAgent } from '../../api.js';
import { npKeys } from '../../constants.js';
import type { AgentListItem } from '../../types.js';

/** Ownership, not edit permission: an administrator cannot delete another member's agent. */
export function AgentDelete({
  agent,
  canDelete,
}: {
  readonly agent: AgentListItem;
  readonly canDelete: boolean;
}): ReactElement | null {
  const { t } = useTranslation();
  const api = useApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => deleteAgent(api, agent.id),
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: t('np.agentDetail.deleted', { name: agent.name }),
      });
      void queryClient.invalidateQueries({ queryKey: npKeys.agents });
      void queryClient.invalidateQueries({ queryKey: npKeys.issues });
      void queryClient.invalidateQueries({ queryKey: npKeys.runtimes });
      void navigate('/agents');
    },
    onError: (error: unknown) =>
      toast.add({
        type: 'error',
        priority: 'high',
        title:
          error instanceof ApiClientError && error.status === 403
            ? t('np.common.forbidden')
            : error instanceof ApiClientError &&
                error.code === 'AGENT_HAS_ACTIVE_RUNS'
              ? t('np.agentDetail.activeRuns')
              : t('np.common.requestFailed'),
      }),
  });
  if (!canDelete) return null;
  return (
    <>
      <Button
        variant='outline'
        disabled={remove.isPending}
        onClick={() => setConfirming(true)}
      >
        <Trash2Icon data-icon='inline-start' />
        {t('np.agentDetail.delete')}
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('np.agentDetail.deleteTitle', { name: agent.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('np.agentDetail.deleteDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant='destructive'
              disabled={remove.isPending}
              onClick={() => {
                setConfirming(false);
                remove.mutate();
              }}
            >
              {t('np.agentDetail.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
