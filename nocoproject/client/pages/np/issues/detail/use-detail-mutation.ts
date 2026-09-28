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
 * A write that belongs to one issue's detail (a PR link, an approval, a reaction): reloads the detail afterwards and
 * reports failure in a toast. `errorTitle` maps a server error code to a sentence before the generic ones apply.
 */
export function useDetailMutation<Variables, Result = unknown>(
  issueId: string,
  mutationFn: (variables: Variables) => Promise<Result>,
  options: {
    readonly success?:
      string | ((result: Result, variables: Variables) => string | null);
    readonly errorTitle?: (error: ApiClientError) => string | null;
    readonly alsoInvalidate?: readonly (readonly unknown[])[];
  } = {},
): UseMutationResult<Result, unknown, Variables> {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (result, variables) => {
      const title =
        typeof options.success === 'function'
          ? options.success(result, variables)
          : options.success;
      if (title) toast.add({ type: 'success', title });
    },
    onError: (error: unknown) => {
      const specific =
        error instanceof ApiClientError ? options.errorTitle?.(error) : null;
      toast.add({
        type: 'error',
        priority: 'high',
        title:
          specific ??
          (error instanceof ApiClientError && error.status === 403
            ? t('np.common.forbidden')
            : t('np.common.requestFailed')),
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: npKeys.issue(issueId) });
      for (const key of options.alsoInvalidate ?? []) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}
