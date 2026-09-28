import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import {
  type UseMutationResult,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';

import { type IssueUpdateResult, updateIssue } from '../../api.js';
import { npKeys } from '../../constants.js';
import type { Issue, IssueDetail, UpdateIssueInput } from '../../types.js';
import { toast } from '@/components/ui/toast';

/**
 * PATCH an issue with optimistic concurrency (protocol §3). The request carries the newest `revision` the cache
 * holds; a 409 `REVISION_CONFLICT` means someone else changed the issue first, so the change is dropped, the user is
 * told, and the detail is reloaded rather than silently overwriting their edit. A status change that waits for an
 * approval (202) is reported with a "waiting for approval" toast and the detail reloaded to show the approval card.
 */
export function useIssueUpdate(
  issue: Issue,
): UseMutationResult<IssueUpdateResult, unknown, UpdateIssueInput> {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const detailKey = npKeys.issue(issue.id);

  return useMutation({
    mutationFn: (changes: UpdateIssueInput) => {
      const cached = queryClient.getQueryData<IssueDetail>(detailKey);
      return updateIssue(
        api,
        issue.id,
        changes,
        cached?.issue.revision ?? issue.revision,
      );
    },
    onSuccess: ({ issue: updated, pendingApproval }) => {
      // A gated status change (iteration 2 §D) answers 202 with the issue unchanged and a pending approval.
      if (pendingApproval) {
        toast.add({
          type: 'info',
          title: t('np.approvals.pendingToast'),
          description: t('np.approvals.pendingToastDescription'),
        });
      }
      queryClient.setQueryData<IssueDetail>(detailKey, (previous) =>
        previous
          ? { ...previous, issue: { ...previous.issue, ...updated } }
          : previous,
      );
      void queryClient.invalidateQueries({ queryKey: detailKey });
      void queryClient.invalidateQueries({ queryKey: npKeys.issues });
    },
    onError: (error: unknown) => {
      // Iteration 4: the process is fixed once work starts; a project manager never executes an issue.
      if (error instanceof ApiClientError && error.code === 'PROCESS_LOCKED') {
        toast.add({ type: 'error', title: t('np.process.locked') });
        void queryClient.invalidateQueries({ queryKey: detailKey });
        return;
      }
      if (
        error instanceof ApiClientError &&
        error.code === 'MANAGER_NOT_EXECUTOR'
      ) {
        toast.add({
          type: 'error',
          title: t('np.agentForm.managerNotExecutor'),
        });
        return;
      }
      if (error instanceof ApiClientError && error.status === 409) {
        toast.add({ type: 'info', title: t('np.issue.conflict') });
        void queryClient.invalidateQueries({ queryKey: detailKey });
        return;
      }
      toast.add({
        type: 'error',
        priority: 'high',
        title:
          error instanceof ApiClientError && error.status === 403
            ? t('np.common.forbidden')
            : t('np.common.requestFailed'),
      });
    },
  });
}
