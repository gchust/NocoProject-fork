import type { ApiClient } from '@nocobase/app-client';

import {
  normalizeIssueDetail,
  type RawIssueDetail,
} from './detail-normalize.js';
import type {
  AgentListItem,
  ApprovalRequest,
  CreateAgentInput,
  CreateCommentResult,
  CreateIssueInput,
  Issue,
  BoardGroup,
  IssueDetail,
  IssueFilters,
  IssueListItem,
  Me,
  MemberPreferences,
  ProjectListItem,
  RunEventsResponse,
  RunSummary,
  Runtime,
  UpdateAgentInput,
  UpdateIssueInput,
} from './types.js';

/**
 * Plain request functions for the browser API in protocol §3. Paths are relative to the application API base, which
 * already carries `/api` and the deployment base path.
 */

const id = (value: string): string => encodeURIComponent(value);

export async function fetchMe(api: ApiClient): Promise<Me> {
  const { data } = await api.request<{ data: Me }>({ path: 'np/me' });
  return data;
}

/** `GET /np/me/preferences` (NP-108). */
export async function fetchMyPreferences(
  api: ApiClient,
  signal?: AbortSignal,
): Promise<MemberPreferences> {
  const { data } = await api.request<{ data: MemberPreferences }>({
    path: 'np/me/preferences',
    signal,
  });
  return data;
}

/** `PATCH /np/me/preferences` (NP-108): changes only the fields given. */
export async function updateMyPreferences(
  api: ApiClient,
  input: Partial<MemberPreferences>,
): Promise<MemberPreferences> {
  const { data } = await api.request<{ data: MemberPreferences }>({
    path: 'np/me/preferences',
    method: 'PATCH',
    json: input,
  });
  return data;
}

export async function fetchProjects(
  api: ApiClient,
): Promise<ProjectListItem[]> {
  const { data } = await api.request<{ data: ProjectListItem[] }>({
    path: 'np/projects',
  });
  return data;
}

function issueQuery(filters: IssueFilters): Record<string, string | undefined> {
  return {
    q: filters.q || undefined,
    statusKey: filters.statusKey || undefined,
    projectId: filters.projectId || undefined,
    labelId: filters.labelId || undefined,
    ownerUserId: filters.ownerUserId || undefined,
    executorId: filters.executorId || undefined,
    parentIssueId: filters.parentIssueId || undefined,
  };
}

export async function fetchIssues(
  api: ApiClient,
  filters: IssueFilters,
  signal?: AbortSignal,
): Promise<IssueListItem[]> {
  const { data } = await api.request<{ data: IssueListItem[] }>({
    path: 'np/issues',
    query: issueQuery(filters),
    signal,
  });
  return data;
}

/**
 * `GET /np/issues?view=board` (§F). The contract gives the grouped body as `{ groups }` without saying whether it
 * sits under `data`; a flat list (an older server ignoring `view`) is accepted too and grouped by status here.
 */
export async function fetchBoard(
  api: ApiClient,
  filters: IssueFilters,
  signal?: AbortSignal,
): Promise<BoardGroup[]> {
  const body = await api.request<unknown>({
    path: 'np/issues',
    query: { ...issueQuery(filters), view: 'board' },
    signal,
  });
  return normalizeBoardBody(body);
}

export function normalizeBoardBody(body: unknown): BoardGroup[] {
  const record = (body ?? {}) as { data?: unknown; groups?: unknown };
  const nested =
    record.data && !Array.isArray(record.data)
      ? (record.data as { groups?: unknown }).groups
      : undefined;
  const groups = record.groups ?? nested;
  if (Array.isArray(groups)) return [...(groups as BoardGroup[])];
  const flat = Array.isArray(record.data)
    ? (record.data as readonly IssueListItem[])
    : [];
  const byStatus = new Map<string, IssueListItem[]>();
  for (const issue of flat) {
    byStatus.set(issue.statusKey, [
      ...(byStatus.get(issue.statusKey) ?? []),
      issue,
    ]);
  }
  return [...byStatus].map(([statusKey, issues]) => ({ statusKey, issues }));
}

export async function createIssue(
  api: ApiClient,
  input: CreateIssueInput,
): Promise<Issue> {
  const { data } = await api.request<{ data: Issue }, CreateIssueInput>({
    path: 'np/issues',
    method: 'POST',
    json: input,
  });
  return data;
}

export async function fetchIssueDetail(
  api: ApiClient,
  issueId: string,
  signal?: AbortSignal,
): Promise<IssueDetail> {
  const { data } = await api.request<{ data: RawIssueDetail }>({
    path: `np/issues/${id(issueId)}`,
    signal,
  });
  return normalizeIssueDetail(data);
}

export interface IssueUpdateResult {
  readonly issue: Issue;
  /** Set when a status change hit an approval gate (iteration 2 §D): the server answered 202 and kept the status. */
  readonly pendingApproval: ApprovalRequest | null;
}

/**
 * The PATCH body: `{ data: Issue }` normally, `{ data: { issue, pendingApproval } }` when the change waits for an
 * approval (202). Both are read here so callers do not need the status code.
 */
export function normalizeIssueUpdate(body: unknown): IssueUpdateResult {
  const data = ((body as { data?: unknown } | null)?.data ?? body) as
    | (Issue & { issue?: undefined })
    | { issue: Issue; pendingApproval?: ApprovalRequest | null };
  if (data && typeof data === 'object' && 'issue' in data && data.issue) {
    return {
      issue: data.issue,
      pendingApproval:
        'pendingApproval' in data ? (data.pendingApproval ?? null) : null,
    };
  }
  return { issue: data, pendingApproval: null };
}

/** PATCH with optimistic concurrency: a stale `revision` answers 409 `REVISION_CONFLICT`. */
export async function updateIssue(
  api: ApiClient,
  issueId: string,
  changes: UpdateIssueInput,
  revision: number,
): Promise<IssueUpdateResult> {
  const body = await api.request<
    unknown,
    UpdateIssueInput & { revision: number }
  >({
    path: `np/issues/${id(issueId)}`,
    method: 'PATCH',
    json: { ...changes, revision },
  });
  return normalizeIssueUpdate(body);
}

export async function createComment(
  api: ApiClient,
  issueId: string,
  input: { readonly content: string; readonly parentId?: string },
): Promise<CreateCommentResult> {
  const { data } = await api.request<
    { data: CreateCommentResult },
    { content: string; parentId?: string }
  >({
    path: `np/issues/${id(issueId)}/comments`,
    method: 'POST',
    json: input,
  });
  return data;
}

export async function fetchAgents(api: ApiClient): Promise<AgentListItem[]> {
  const { data } = await api.request<{ data: AgentListItem[] }>({
    path: 'np/agents',
  });
  return data;
}

export async function createAgent(
  api: ApiClient,
  input: CreateAgentInput,
): Promise<AgentListItem> {
  const { data } = await api.request<{ data: AgentListItem }, CreateAgentInput>(
    { path: 'np/agents', method: 'POST', json: input },
  );
  return data;
}

export async function updateAgent(
  api: ApiClient,
  agentId: string,
  changes: UpdateAgentInput,
): Promise<AgentListItem> {
  const { data } = await api.request<{ data: AgentListItem }, UpdateAgentInput>(
    { path: `np/agents/${id(agentId)}`, method: 'PATCH', json: changes },
  );
  return data;
}

export async function deleteAgent(
  api: ApiClient,
  agentId: string,
): Promise<void> {
  await api.request({ path: 'np/agents/' + id(agentId), method: 'DELETE' });
}

export async function fetchRuntimes(api: ApiClient): Promise<Runtime[]> {
  const { data } = await api.request<{ data: Runtime[] }>({
    path: 'np/runtimes',
  });
  return data;
}

export async function fetchRun(
  api: ApiClient,
  runId: string,
): Promise<RunSummary> {
  const { data } = await api.request<{ data: RunSummary }>({
    path: `np/runs/${id(runId)}`,
  });
  return data;
}

/** Events after `since`; the first request omits it and receives the run's events from the start. */
export async function fetchRunEvents(
  api: ApiClient,
  runId: string,
  since: number | undefined,
): Promise<RunEventsResponse> {
  return api.request<RunEventsResponse>({
    path: `np/runs/${id(runId)}/events`,
    query: { since },
  });
}

export async function cancelRun(api: ApiClient, runId: string): Promise<void> {
  await api.request<unknown>({
    path: `np/runs/${id(runId)}/cancel`,
    method: 'POST',
  });
}

export async function retryRun(
  api: ApiClient,
  runId: string,
): Promise<RunSummary> {
  const { data } = await api.request<{ data: RunSummary }>({
    path: `np/runs/${id(runId)}/retry`,
    method: 'POST',
  });
  return data;
}
