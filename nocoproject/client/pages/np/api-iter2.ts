import type { ApiClient } from '@nocobase/app-client';

import type {
  ApprovalRequest,
  GitConnectionInput,
  GitConnectionTestResult,
  GitConnectionView,
  IssuePullRequestView,
  UsageQuery,
  UsageResponse,
  UsageRow,
  WorkspaceSettings,
  WorkspaceSettingsInput,
} from './types-iter2.js';

/**
 * Request functions for iteration 2 (`docs/phase1/iteration-2-contract.md`): GitHub connection and pull requests
 * (§C), approvals (§D), reactions and thread resolution (§F), usage and workspace settings (§I). Intake lives in
 * `api-intake.ts`, agent environment variables and skills in `api-agent-extras.ts`.
 *
 * Every response goes through `unwrap`, which accepts the documented `{ data }` envelope and a bare body, so a server
 * that settles on either shape keeps working (the server's protocol doc is written in parallel).
 */

const id = (value: string): string => encodeURIComponent(value);

/** `{ data: X }` → X; a body without `data` is returned as is. */
export function unwrap<T>(body: unknown): T {
  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: T }).data;
  }
  return body as T;
}

/** A list from `{ data: [] }`, `[]`, `{ data: { items } }` or `{ items }`; anything else is empty. */
export function unwrapList<T>(body: unknown, key = 'items'): T[] {
  const inner = unwrap<unknown>(body);
  if (Array.isArray(inner)) return inner as T[];
  if (inner && typeof inner === 'object') {
    const nested = (inner as Record<string, unknown>)[key];
    if (Array.isArray(nested)) return nested as T[];
  }
  return [];
}

// ---------- §C GitHub connection ----------

export async function fetchGitConnection(
  api: ApiClient,
): Promise<GitConnectionView> {
  return unwrap(await api.request<unknown>({ path: 'np/integrations/github' }));
}

export async function saveGitConnection(
  api: ApiClient,
  input: GitConnectionInput,
): Promise<GitConnectionView> {
  return unwrap(
    await api.request<unknown, GitConnectionInput>({
      path: 'np/integrations/github',
      method: 'PUT',
      json: input,
    }),
  );
}

export async function testGitConnection(
  api: ApiClient,
): Promise<GitConnectionTestResult> {
  return unwrap(
    await api.request<unknown>({
      path: 'np/integrations/github/test',
      method: 'POST',
    }),
  );
}

// ---------- §C pull requests on an issue ----------

export async function fetchIssuePullRequests(
  api: ApiClient,
  issueId: string,
): Promise<IssuePullRequestView[]> {
  return unwrapList(
    await api.request<unknown>({
      path: `np/issues/${id(issueId)}/pull-requests`,
    }),
  );
}

export async function linkPullRequest(
  api: ApiClient,
  issueId: string,
  url: string,
): Promise<void> {
  await api.request<unknown, { url: string }>({
    path: `np/issues/${id(issueId)}/pull-requests`,
    method: 'POST',
    json: { url },
  });
}

export async function unlinkPullRequest(
  api: ApiClient,
  issueId: string,
  prId: string,
): Promise<void> {
  await api.request<unknown>({
    path: `np/issues/${id(issueId)}/pull-requests/${id(prId)}`,
    method: 'DELETE',
  });
}

export async function setPullRequestAutoComplete(
  api: ApiClient,
  issueId: string,
  prId: string,
  autoCompleteDisabled: boolean,
): Promise<void> {
  await api.request<unknown, { autoCompleteDisabled: boolean }>({
    path: `np/issues/${id(issueId)}/pull-requests/${id(prId)}`,
    method: 'PATCH',
    json: { autoCompleteDisabled },
  });
}

export async function refreshPullRequest(
  api: ApiClient,
  issueId: string,
  prId: string,
): Promise<void> {
  await api.request<unknown>({
    path: `np/issues/${id(issueId)}/pull-requests/${id(prId)}/refresh`,
    method: 'POST',
  });
}

// ---------- §D approvals ----------

export async function fetchPendingApprovals(
  api: ApiClient,
  signal?: AbortSignal,
): Promise<ApprovalRequest[]> {
  return unwrapList(
    await api.request<unknown>({
      path: 'np/approvals',
      query: { status: 'pending' },
      signal,
    }),
  );
}

export type ApprovalDecision = 'approve' | 'reject';

export async function decideApproval(
  api: ApiClient,
  requestId: string,
  decision: ApprovalDecision,
  comment?: string,
): Promise<ApprovalRequest> {
  return unwrap(
    await api.request<unknown, { comment?: string }>({
      path: `np/approvals/${id(requestId)}/${decision}`,
      method: 'POST',
      json: comment ? { comment } : {},
    }),
  );
}

// ---------- §F reactions and threads ----------

export async function addReaction(
  api: ApiClient,
  commentId: string,
  emoji: string,
): Promise<void> {
  await api.request<unknown, { emoji: string }>({
    path: `np/comments/${id(commentId)}/reactions`,
    method: 'POST',
    json: { emoji },
  });
}

export async function removeReaction(
  api: ApiClient,
  commentId: string,
  emoji: string,
): Promise<void> {
  await api.request<unknown>({
    path: `np/comments/${id(commentId)}/reactions/${id(emoji)}`,
    method: 'DELETE',
  });
}

export async function setThreadResolved(
  api: ApiClient,
  commentId: string,
  resolved: boolean,
): Promise<void> {
  await api.request<unknown>({
    path: `np/comments/${id(commentId)}/${resolved ? 'resolve' : 'unresolve'}`,
    method: 'POST',
  });
}

// ---------- §I usage and settings ----------

const EMPTY_USAGE: UsageRow = {
  key: 'total',
  name: null,
  runs: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedCost: null,
};

/** `{ data: { rows, totals } }`, `{ rows, totals }`, or rows alone (totals then summed here). */
export function normalizeUsage(body: unknown): UsageResponse {
  const inner = unwrap<unknown>(body);
  const rows: UsageRow[] = Array.isArray(inner)
    ? (inner as UsageRow[])
    : ((inner as { rows?: UsageRow[] } | null)?.rows ?? []);
  const totals =
    (inner as { totals?: UsageRow } | null)?.totals ?? sumUsage(rows);
  return { rows, totals };
}

/** Adds rows up; the cost sums priced rows only and stays null when none is priced (§I). */
export function sumUsage(rows: readonly UsageRow[]): UsageRow {
  const priced = rows.filter((row) => row.estimatedCost !== null);
  return rows.reduce<UsageRow>(
    (total, row) => ({
      ...total,
      runs: total.runs + row.runs,
      inputTokens: total.inputTokens + row.inputTokens,
      outputTokens: total.outputTokens + row.outputTokens,
      cacheReadTokens: total.cacheReadTokens + row.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + row.cacheWriteTokens,
    }),
    {
      ...EMPTY_USAGE,
      estimatedCost:
        priced.length > 0
          ? priced.reduce((sum, row) => sum + (row.estimatedCost ?? 0), 0)
          : null,
      pricedRuns: priced.reduce((sum, row) => sum + row.runs, 0),
    },
  );
}

export async function fetchUsage(
  api: ApiClient,
  query: UsageQuery,
  signal?: AbortSignal,
): Promise<UsageResponse> {
  return normalizeUsage(
    await api.request<unknown>({
      path: 'np/usage',
      query: {
        from: query.from,
        to: query.to,
        groupBy: query.groupBy,
        projectId: query.projectId || undefined,
        agentId: query.agentId || undefined,
        issueId: query.issueId || undefined,
        runtimeType: query.runtimeType || undefined,
      },
      signal,
    }),
  );
}

export async function fetchWorkspaceSettings(
  api: ApiClient,
): Promise<WorkspaceSettings> {
  return unwrap(await api.request<unknown>({ path: 'np/settings' }));
}

export async function updateWorkspaceSettings(
  api: ApiClient,
  changes: WorkspaceSettingsInput,
): Promise<WorkspaceSettings> {
  return unwrap(
    await api.request<unknown, WorkspaceSettingsInput>({
      path: 'np/settings',
      method: 'PATCH',
      json: changes,
    }),
  );
}
