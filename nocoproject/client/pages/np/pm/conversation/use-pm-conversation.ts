import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { toast } from '@/components/ui/toast';

import { fetchIssueDetail } from '../../api.js';
import {
  createPmConversation,
  fetchPmAgentChoice,
  fetchPmConversation,
  switchPmConversationAgent,
  updatePmConversation,
} from '../../api-pm.js';
import { npKeys } from '../../constants.js';
import { detailRefetchInterval } from '../../detail-normalize.js';
import type { IssuesTopicPayload } from '../../types.js';
import type { PmConversationDetail } from '../../types-pm.js';
import { useRealtimeTopic } from '../../use-realtime.js';

/**
 * Data for one project manager conversation (`protocol-pm-assistant.md` §5.4, §6.5): its record (title, agent), the
 * issue that carries it (messages, runs — the same detail the issue page reads), and the writes on it. Every write
 * toasts; the conversation list refetches after each one.
 */

function notRetriedOnClientErrors(count: number, error: unknown): boolean {
  return !(error instanceof ApiClientError && error.status < 500) && count < 2;
}

/**
 * The application's query client keeps the previous key's data as placeholder for every query, and a disabled query
 * (no conversation yet) shows it too: after "New conversation" the drawer kept showing the conversation it had just
 * left (NP-201). A conversation's data must never stand in for another one, or for none.
 */
function noPlaceholder(): undefined {
  return undefined;
}

export function usePmConversationDetail(conversationId: string | null) {
  const api = useApiClient();
  return useQuery({
    queryKey: npKeys.pmConversation(conversationId ?? ''),
    queryFn: ({ signal }) =>
      fetchPmConversation(api, conversationId ?? '', signal),
    enabled: conversationId !== null,
    placeholderData: noPlaceholder,
    retry: notRetriedOnClientErrors,
  });
}

/** The conversation's issue: messages and runs, refreshed by `np:issues` and polled while a turn is running. */
export function usePmConversationIssue(
  issueId: string | undefined,
  conversationId: string | null,
) {
  const api = useApiClient();
  const queryClient = useQueryClient();
  useRealtimeTopic<IssuesTopicPayload>(
    issueId ? 'np:issues' : null,
    (payload) => {
      if (!issueId || (payload && payload.issueId !== issueId)) return;
      void queryClient.invalidateQueries({ queryKey: npKeys.issue(issueId) });
      if (conversationId) {
        void queryClient.invalidateQueries({
          queryKey: npKeys.pmConversation(conversationId),
        });
      }
    },
  );
  return useQuery({
    queryKey: npKeys.issue(issueId ?? ''),
    queryFn: ({ signal }) => fetchIssueDetail(api, issueId ?? '', signal),
    enabled: Boolean(issueId),
    placeholderData: noPlaceholder,
    refetchInterval: (query) => detailRefetchInterval(query.state.data),
    retry: notRetriedOnClientErrors,
  });
}

/** The member's choice (§6.2); absent until the server offers it, which hides "switch and start a new one". */
export function usePmAgentChoice(enabled = true) {
  const api = useApiClient();
  return useQuery({
    queryKey: npKeys.pmAgentChoice,
    queryFn: ({ signal }) => fetchPmAgentChoice(api, signal),
    enabled,
    retry: false,
    staleTime: 60_000,
  });
}

function errorTitle(
  t: (key: string) => string,
  error: unknown,
  fallback: string,
): string {
  if (error instanceof ApiClientError) {
    if (error.status === 403) return t('np.common.forbidden');
    if (error.code === 'PM_NOT_CONFIGURED')
      return t('np.pmAssistant.notConfigured');
    if (error.code === 'PERSONAL_UNAVAILABLE')
      return t('np.pmAssistant.agent.personalUnavailable');
  }
  return t(fallback);
}

export function usePmConversationActions() {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();

  function remember(detail: PmConversationDetail): void {
    queryClient.setQueryData(npKeys.pmConversation(detail.id), detail);
    void queryClient.invalidateQueries({
      queryKey: [...npKeys.pm, 'conversations'],
    });
  }
  function failed(fallback: string) {
    return (error: unknown) =>
      toast.add({
        type: 'error',
        priority: 'high',
        title: errorTitle(t, error, fallback),
      });
  }

  const create = useMutation({
    mutationFn: (input: { switchTo?: 'system' | 'personal' } = {}) =>
      createPmConversation(api, input),
    onSuccess: (detail) => {
      remember(detail);
      void queryClient.invalidateQueries({ queryKey: npKeys.pmAgentChoice });
    },
    onError: failed('np.pmAssistant.createFailed'),
  });

  const rename = useMutation({
    mutationFn: (input: { id: string; title: string }) =>
      updatePmConversation(api, input.id, { title: input.title }),
    onSuccess: (detail) => {
      remember(detail);
      toast.add({ type: 'success', title: t('np.pmAssistant.renamed') });
    },
    onError: failed('np.common.requestFailed'),
  });

  const archive = useMutation({
    mutationFn: (input: { id: string; archived: boolean }) =>
      updatePmConversation(api, input.id, { archived: input.archived }),
    onSuccess: (detail, input) => {
      remember(detail);
      if (!input.archived) {
        toast.add({ type: 'success', title: t('np.pmAssistant.unarchived') });
        return;
      }
      const toastId = toast.add({
        type: 'success',
        title: t('np.pmAssistant.archived', {
          title: detail.title || t('np.pm.untitled'),
        }),
        actionProps: {
          children: t('np.pmAssistant.undo'),
          onClick: () => {
            toast.close(toastId);
            archive.mutate({ id: input.id, archived: false });
          },
        },
      });
    },
    onError: failed('np.common.requestFailed'),
  });

  const switchAgent = useMutation({
    mutationFn: (input: { id: string; to: 'fallback' | 'restore' }) =>
      switchPmConversationAgent(api, input.id, input.to),
    onSuccess: (detail, input) => {
      remember(detail);
      void queryClient.invalidateQueries({
        queryKey: npKeys.issue(detail.issueId),
      });
      toast.add({
        type: 'success',
        title:
          input.to === 'fallback'
            ? t('np.pmAssistant.agent.fallbackDone')
            : t('np.pmAssistant.agent.restoreDone'),
        description: t('np.pmAssistant.agent.newSession'),
      });
    },
    onError: failed('np.common.requestFailed'),
  });

  return { create, rename, archive, switchAgent };
}

/** A conversation's title as shown: a new one's title is empty until its first message (NP-183). */
export function usePmTitle(): (title: string | null | undefined) => string {
  const { t } = useTranslation();
  return (title) => (title?.trim() ? title : t('np.pm.untitled'));
}
