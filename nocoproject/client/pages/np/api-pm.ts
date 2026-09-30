import type { ApiClient } from '@nocobase/app-client';

import type { CreateCommentResult } from './types.js';
import type {
  PmAgentChoice,
  PmConversationAgent,
  PmConversationDetail,
  PmConversationPage,
  PmPageContext,
  PmPlan,
  PmPlanEdit,
} from './types-pm.js';

/**
 * Project manager 2.0 browser endpoints (`protocol-pm-assistant.md` §4.4, §5.4, §6.2, §6.5, §8.1). Paths are under
 * `/api/np`; every response is `{ data }`.
 */

function id(value: string): string {
  return encodeURIComponent(value);
}

export async function fetchPmConversations(
  api: ApiClient,
  filters: { readonly q?: string; readonly archived: boolean },
  cursor?: string | null,
  signal?: AbortSignal,
): Promise<PmConversationPage> {
  const body = await api.request<{
    data: PmConversationPage['data'];
    nextCursor?: string | null;
  }>({
    path: 'np/pm/conversations',
    query: {
      q: filters.q || undefined,
      archived: filters.archived ? 'true' : undefined,
      cursor: cursor ?? undefined,
    },
    signal,
  });
  return {
    // Only a list is a page of conversations (an older server answers this path with something else).
    data: Array.isArray(body.data)
      ? (body.data as readonly unknown[]).filter(
          (item): item is PmConversationPage['data'][number] =>
            typeof (item as { id?: unknown } | null)?.id === 'string',
        )
      : [],
    nextCursor:
      typeof body.nextCursor === 'string' && body.nextCursor
        ? body.nextCursor
        : null,
  };
}

export async function fetchPmConversation(
  api: ApiClient,
  conversationId: string,
  signal?: AbortSignal,
): Promise<PmConversationDetail> {
  const { data } = await api.request<{ data: PmConversationDetail }>({
    path: `np/pm/conversations/${id(conversationId)}`,
    signal,
  });
  return data;
}

/** Creates a conversation without starting a run; `switchTo` saves the member's choice first ("switch and start a new one"). */
export async function createPmConversation(
  api: ApiClient,
  input: {
    readonly title?: string;
    readonly switchTo?: 'system' | 'personal';
  } = {},
): Promise<PmConversationDetail> {
  const { data } = await api.request<
    { data: PmConversationDetail },
    typeof input
  >({ path: 'np/pm/conversations', method: 'POST', json: input });
  return data;
}

export async function updatePmConversation(
  api: ApiClient,
  conversationId: string,
  input: { readonly title?: string; readonly archived?: boolean },
): Promise<PmConversationDetail> {
  const { data } = await api.request<
    { data: PmConversationDetail },
    typeof input
  >({
    path: `np/pm/conversations/${id(conversationId)}`,
    method: 'PATCH',
    json: input,
  });
  return data;
}

/** §6.5: this conversation uses the system default until restored (`fallback`), or returns to the personal agent. */
export async function switchPmConversationAgent(
  api: ApiClient,
  conversationId: string,
  to: 'fallback' | 'restore',
): Promise<PmConversationDetail> {
  const { data } = await api.request<{ data: PmConversationDetail }>({
    path: `np/pm/conversations/${id(conversationId)}/${to}`,
    method: 'POST',
  });
  return data;
}

/** A message in a conversation: the issue comment endpoint with the page context (§8.1). */
export async function sendPmMessage(
  api: ApiClient,
  issueId: string,
  input: { readonly content: string; readonly context?: PmPageContext },
): Promise<
  CreateCommentResult & {
    readonly conversation?: { readonly agent: PmConversationAgent };
  }
> {
  const { data } = await api.request<
    {
      data: CreateCommentResult & {
        conversation?: { agent: PmConversationAgent };
      };
    },
    typeof input
  >({
    path: `np/issues/${id(issueId)}/comments`,
    method: 'POST',
    json: input,
  });
  return data;
}

export async function fetchPmAgentChoice(
  api: ApiClient,
  signal?: AbortSignal,
): Promise<PmAgentChoice> {
  const { data } = await api.request<{ data: PmAgentChoice }>({
    path: 'np/me/pm-agent',
    signal,
  });
  return data;
}

export async function fetchPmPlan(
  api: ApiClient,
  planId: string,
  signal?: AbortSignal,
): Promise<PmPlan> {
  const { data } = await api.request<{ data: PmPlan }>({
    path: `np/pm/plans/${id(planId)}`,
    signal,
  });
  return data;
}

export async function editPmPlan(
  api: ApiClient,
  planId: string,
  edit: PmPlanEdit,
): Promise<PmPlan> {
  const { data } = await api.request<{ data: PmPlan }, PmPlanEdit>({
    path: `np/pm/plans/${id(planId)}`,
    method: 'PATCH',
    json: edit,
  });
  return data;
}

export async function executePmPlan(
  api: ApiClient,
  planId: string,
  revision: number,
): Promise<PmPlan> {
  const { data } = await api.request<{ data: PmPlan }, { revision: number }>({
    path: `np/pm/plans/${id(planId)}/execute`,
    method: 'POST',
    json: { revision },
  });
  return data;
}

export async function discardPmPlan(
  api: ApiClient,
  planId: string,
): Promise<PmPlan> {
  const { data } = await api.request<{ data: PmPlan }>({
    path: `np/pm/plans/${id(planId)}/discard`,
    method: 'POST',
  });
  return data;
}
