import { ApiClientError } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import {
  type UseMutationResult,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';

import { toast } from '@/components/ui/toast';

import { npKeys } from '../../constants.js';

/**
 * A write against one project that reloads the project and the list afterwards and reports failure in a toast. The
 * project endpoints answer 403 for anyone but the lead and owner/admin (§B); the page disables those controls, so a
 * 403 here means the viewer's role changed underneath.
 */
export function useProjectMutation<Variables>(
  mutationFn: (variables: Variables) => Promise<unknown>,
  successTitle?: string,
): UseMutationResult<unknown, unknown, Variables> {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      if (successTitle) toast.add({ type: 'success', title: successTitle });
    },
    onError: (error: unknown) =>
      toast.add({
        type: 'error',
        priority: 'high',
        title:
          error instanceof ApiClientError && error.status === 403
            ? t('np.common.forbidden')
            : error instanceof ApiClientError && error.code === 'LEAD_MEMBER'
              ? t('np.projectMembers.leadMember')
              : error instanceof ApiClientError &&
                  error.code === 'WORKFLOW_STATUS_CONFLICT'
                ? t('np.projectMore.workflowConflict')
                : t('np.common.requestFailed'),
      }),
    onSettled: () => {
      // The list key prefixes the project key, so this reloads the list and this project together.
      void queryClient.invalidateQueries({ queryKey: npKeys.projects });
    },
  });
}
