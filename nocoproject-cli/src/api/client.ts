/**
 * Typed HTTP client for the NocoProject daemon API (§4, `x-api-key`) and the agent
 * write-back API (§5, `Authorization: Bearer npr_...`). Credentials never appear in errors.
 */
import type {
  AgentContextResponse,
  AgentCreateIssueRequest,
  ClaimedProject,
  CommentForAgent,
  DaemonClaimRequest,
  DaemonClaimResponse,
  DaemonCompleteRequest,
  DaemonEventsRequest,
  DaemonFailRequest,
  DaemonHeartbeatRequest,
  DaemonRegisterRequest,
  DaemonRegisterResponse,
  DaemonRunStatusResponse,
  DaemonStartRequest,
  DependencyType,
  InboxItemV3,
  AgentWorkflowListItem,
  AgentWorkflowProposalRequest,
  IssueChecklist,
  IssueForAgent,
  IssuePullRequestView,
  KnowledgeDoc,
  KnowledgeDocSummary,
  KnowledgeProposal,
  MetricsReport,
  PmIssueDetail,
  PmIssueListPage,
  PmIssueListQuery,
  PmProjectList,
  StatusChangePendingResponse,
  SubtaskSummary,
  WorkflowProposal,
} from '../protocol.js';
import { redactText } from '../util/redact.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly method: string,
    readonly path: string,
    /** Structured error detail (Phase 2: `INVALID_WORKFLOW` field issues, `WORKFLOW_STATUS_CONFLICT` counts). */
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(`${method} ${path} → ${status} ${code}: ${message}`);
    this.name = 'HttpError';
  }
}

export class NetworkError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly path: string,
  ) {
    super(`${method} ${path} failed: ${message}`);
    this.name = 'NetworkError';
  }
}

/** Retry-worthy: network failures, 408, 429 and 5xx. */
export function isTransient(error: unknown): boolean {
  if (error instanceof NetworkError) return true;
  if (error instanceof HttpError) return error.status === 408 || error.status === 429 || error.status >= 500;
  return false;
}

export type Credentials = { readonly kind: 'apiKey'; readonly apiKey: string } | { readonly kind: 'runToken'; readonly token: string };

export interface RequestOptions {
  readonly body?: unknown;
  readonly query?: Record<string, string | number | boolean | undefined>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export class HttpClient {
  private readonly apiBase: string;

  constructor(
    serverUrl: string,
    private readonly credentials: Credentials,
    private readonly defaultTimeoutMs = 30_000,
    /** Sent with every request (the CLI user mode names itself in `x-np-client`). Never credentials. */
    private readonly extraHeaders: Readonly<Record<string, string>> = {},
  ) {
    this.apiBase = `${serverUrl.replace(/\/+$/, '')}/api`;
  }

  /** Performs a request and returns the parsed JSON envelope. */
  async raw<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    return (await this.request<T>(method, path, opts)).json;
  }

  /** Like `raw`, but also returns the HTTP status (for 2xx codes that mean different things, e.g. 202). */
  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<{ status: number; json: T }> {
    const url = new URL(`${this.apiBase}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { ...this.extraHeaders, accept: 'application/json' };
    if (this.credentials.kind === 'apiKey') headers['x-api-key'] = this.credentials.apiKey;
    else headers.authorization = `Bearer ${this.credentials.token}`;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? this.defaultTimeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal,
      });
    } catch (error) {
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      const detail = cause?.code ?? cause?.message ?? (error as Error).message;
      throw new NetworkError(redactText(String(detail)), method, path);
    }
    const text = await response.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!response.ok) {
      const body = (json ?? {}) as { code?: unknown; message?: unknown; error?: unknown; details?: unknown };
      const code = typeof body.code === 'string' ? body.code : `HTTP_${response.status}`;
      const message =
        typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : text.slice(0, 300);
      const details = body.details && typeof body.details === 'object' ? (body.details as Record<string, unknown>) : undefined;
      throw new HttpError(response.status, code, redactText(message || response.statusText), method, path, details);
    }
    return { status: response.status, json: json as T };
  }

  async data<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    return unwrap<T>(await this.raw(method, path, opts));
  }
}

const enc = encodeURIComponent;

const unwrap = <T>(envelope: unknown): T =>
  (envelope && typeof envelope === 'object' && 'data' in envelope ? (envelope as { data: T }).data : envelope) as T;

/**
 * Result of `POST /np/agent/issues/:id/status`: 200 applies the change; 202 means an approval
 * gate stopped it and created a pending request (iteration 2 §D) — not an error.
 */
export type StatusChangeResult =
  | { readonly kind: 'applied'; readonly data: unknown }
  | { readonly kind: 'pending'; readonly data: StatusChangePendingResponse };

export class DaemonApi {
  readonly http: HttpClient;
  constructor(serverUrl: string, apiKey: string, timeoutMs?: number) {
    this.http = new HttpClient(serverUrl, { kind: 'apiKey', apiKey }, timeoutMs);
  }
  register(body: DaemonRegisterRequest): Promise<DaemonRegisterResponse> {
    return this.http.data('POST', '/np/daemon/register', { body });
  }
  heartbeat(body: DaemonHeartbeatRequest): Promise<{ ok: boolean }> {
    return this.http.data('POST', '/np/daemon/heartbeat', { body });
  }
  deregister(daemonId: string): Promise<unknown> {
    return this.http.data('POST', '/np/daemon/deregister', { body: { daemonId }, timeoutMs: 5000 });
  }
  claim(body: DaemonClaimRequest): Promise<DaemonClaimResponse> {
    return this.http.data('POST', '/np/daemon/runs/claim', { body });
  }
  lease(runId: string): Promise<unknown> {
    return this.http.data('POST', `/np/daemon/runs/${enc(runId)}/lease`, { body: {} });
  }
  start(runId: string, body: DaemonStartRequest): Promise<unknown> {
    return this.http.data('POST', `/np/daemon/runs/${enc(runId)}/start`, { body });
  }
  events(runId: string, body: DaemonEventsRequest): Promise<unknown> {
    return this.http.data('POST', `/np/daemon/runs/${enc(runId)}/events`, { body });
  }
  status(runId: string): Promise<DaemonRunStatusResponse> {
    return this.http.data('GET', `/np/daemon/runs/${enc(runId)}/status`);
  }
  complete(runId: string, body: DaemonCompleteRequest): Promise<unknown> {
    return this.http.data('POST', `/np/daemon/runs/${enc(runId)}/complete`, { body });
  }
  fail(runId: string, body: DaemonFailRequest): Promise<unknown> {
    return this.http.data('POST', `/np/daemon/runs/${enc(runId)}/fail`, { body });
  }
  cancelAck(runId: string): Promise<unknown> {
    return this.http.data('POST', `/np/daemon/runs/${enc(runId)}/cancel-ack`, { body: {} });
  }
}

/**
 * `POST /np/agent/knowledge/proposals` (iteration 3 §B): `docId` updates an existing document,
 * `title` (+ optional `slug`) proposes a new one; `projectId` defaults to the run's project.
 */
export interface KnowledgeProposalBody {
  readonly docId?: string;
  readonly title?: string;
  readonly slug?: string;
  readonly projectId?: string;
  readonly summary?: string;
  readonly content: string;
  readonly reason: string;
}

export interface CommentListQuery {
  readonly since?: string;
  readonly rootsOnly?: boolean;
  readonly thread?: string;
  readonly tail?: number;
}

export class AgentApi {
  readonly http: HttpClient;
  constructor(serverUrl: string, token: string, timeoutMs?: number) {
    this.http = new HttpClient(serverUrl, { kind: 'runToken', token }, timeoutMs);
  }
  /** Phase 1 servers add `project` (contract §I); older servers omit it. */
  context(): Promise<AgentContextResponse & { readonly project?: ClaimedProject | null }> {
    return this.http.data('GET', '/np/agent/context');
  }
  issue(id: string): Promise<IssueForAgent> {
    return this.http.data('GET', `/np/agent/issues/${enc(id)}`);
  }
  comments(id: string, q: CommentListQuery = {}): Promise<CommentForAgent[]> {
    return this.http.data('GET', `/np/agent/issues/${enc(id)}/comments`, {
      query: { since: q.since, rootsOnly: q.rootsOnly ? 'true' : undefined, thread: q.thread, tail: q.tail },
    });
  }
  addComment(id: string, content: string, parentId?: string): Promise<unknown> {
    return this.http.data('POST', `/np/agent/issues/${enc(id)}/comments`, { body: { content, parentId } });
  }
  async setStatus(id: string, statusKey: string): Promise<StatusChangeResult> {
    const { status, json } = await this.http.request('POST', `/np/agent/issues/${enc(id)}/status`, { body: { statusKey } });
    const data = unwrap<unknown>(json);
    if (status === 202) return { kind: 'pending', data: data as StatusChangePendingResponse };
    return { kind: 'applied', data };
  }
  /** POST /np/agent/issues/:id/pull-requests { url } (iteration 2 §C). */
  linkPullRequest(id: string, url: string): Promise<IssuePullRequestView> {
    return this.http.data('POST', `/np/agent/issues/${enc(id)}/pull-requests`, { body: { url } });
  }
  /** GET /np/agent/issues/:id/pull-requests (iteration 2 §C). */
  pullRequests(id: string): Promise<IssuePullRequestView[]> {
    return this.http.data('GET', `/np/agent/issues/${enc(id)}/pull-requests`);
  }
  /** GET /np/agent/knowledge → the run's project documents plus system-level ones (iteration 3 §B). */
  knowledgeList(): Promise<KnowledgeDocSummary[]> {
    return this.http.data('GET', '/np/agent/knowledge');
  }
  /** GET /np/agent/knowledge/:idOrSlug → `{ doc }` with its Markdown content. */
  async knowledgeDoc(idOrSlug: string): Promise<KnowledgeDoc> {
    const data = await this.http.data<{ doc?: KnowledgeDoc } | KnowledgeDoc>('GET', `/np/agent/knowledge/${enc(idOrSlug)}`);
    return (data && typeof data === 'object' && 'doc' in data && data.doc ? data.doc : data) as KnowledgeDoc;
  }
  /** POST /np/agent/knowledge/proposals → 201 KnowledgeProposal; 409 KNOWLEDGE_PROPOSAL_PENDING. */
  proposeKnowledge(body: KnowledgeProposalBody): Promise<KnowledgeProposal> {
    return this.http.data('POST', '/np/agent/knowledge/proposals', { body });
  }
  /** GET /np/agent/workflows → every template; `usedByRunProject` marks the run project's (NP-77 stage 2). */
  workflows(): Promise<AgentWorkflowListItem[]> {
    return this.http.data('GET', '/np/agent/workflows');
  }
  /** GET /np/agent/workflows/:id → the whole template with its definition and revision. */
  workflow(id: string): Promise<AgentWorkflowListItem> {
    return this.http.data('GET', `/np/agent/workflows/${enc(id)}`);
  }
  /** POST /np/agent/workflows/proposals → 201 WorkflowProposal; 400 INVALID_WORKFLOW (details.issues), 409 WORKFLOW_*. */
  proposeWorkflow(body: AgentWorkflowProposalRequest): Promise<WorkflowProposal> {
    return this.http.data('POST', '/np/agent/workflows/proposals', { body });
  }
  /** GET /np/agent/issues/:id/checklists → the issue's checklists, the current status first (NP-77 §6). */
  checklists(id: string): Promise<IssueChecklist[]> {
    return this.http.data('GET', `/np/agent/issues/${enc(id)}/checklists`);
  }
  /** PATCH /np/agent/issues/:id/checklists/:statusKey/items/:itemKey { checked } → that status's checklist. */
  setChecklistItem(id: string, statusKey: string, itemKey: string, checked: boolean): Promise<IssueChecklist> {
    return this.http.data('PATCH', `/np/agent/issues/${enc(id)}/checklists/${enc(statusKey)}/items/${enc(itemKey)}`, { body: { checked } });
  }
  /** POST /np/agent/issues/:id/design-proposal { content } → the `kind='proposal'` comment (iteration 4 §B). */
  async designProposal(id: string, content: string): Promise<unknown> {
    const data = await this.http.data<{ comment?: unknown } | unknown>('POST', `/np/agent/issues/${enc(id)}/design-proposal`, { body: { content } });
    return data && typeof data === 'object' && 'comment' in data && (data as { comment?: unknown }).comment ? (data as { comment: unknown }).comment : data;
  }
  /** GET /np/agent/pm/projects (iteration 4 §C, manager agents only). */
  pmProjects(): Promise<PmProjectList> {
    return this.http.data('GET', '/np/agent/pm/projects');
  }
  /** GET /np/agent/pm/issues → the whole `{ data, nextCursor }` body. */
  async pmIssues(q: PmIssueListQuery = {}): Promise<PmIssueListPage> {
    const body = await this.http.raw<Partial<PmIssueListPage> | undefined>('GET', '/np/agent/pm/issues', { query: { ...q } });
    return { data: body?.data ?? [], nextCursor: body?.nextCursor ?? null };
  }
  /** GET /np/agent/pm/issues/:idOrIdentifier → `{ issue, comments, activities, runs, pullRequests, subtasks }`. */
  pmIssue(idOrIdentifier: string): Promise<PmIssueDetail> {
    return this.http.data('GET', `/np/agent/pm/issues/${enc(idOrIdentifier)}`);
  }
  /** GET /np/agent/pm/inbox?kind= → the asker's pending items. */
  pmInbox(kind = 'decision'): Promise<InboxItemV3[]> {
    return this.http.data('GET', '/np/agent/pm/inbox', { query: { kind } });
  }
  /** GET /np/agent/pm/metrics?from&to&projectId → MetricsReport. */
  pmMetrics(q: { from?: string; to?: string; projectId?: string } = {}): Promise<MetricsReport> {
    return this.http.data('GET', '/np/agent/pm/metrics', { query: { ...q } });
  }
  /** GET /np/agent/pm/knowledge?projectId&q → KnowledgeDocSummary[] (every visible project + system). */
  pmKnowledge(q: { projectId?: string; q?: string } = {}): Promise<KnowledgeDocSummary[]> {
    return this.http.data('GET', '/np/agent/pm/knowledge', { query: { ...q } });
  }
  /** POST /np/agent/issues (contract §D). The response is passed through as-is. */
  createIssue(body: AgentCreateIssueRequest): Promise<unknown> {
    return this.http.data('POST', '/np/agent/issues', { body });
  }
  children(id: string): Promise<SubtaskSummary[]> {
    return this.http.data('GET', `/np/agent/issues/${enc(id)}/children`);
  }
  addDependency(id: string, dependsOnIssueId: string, type: DependencyType = 'blockedBy'): Promise<unknown> {
    return this.http.data('POST', `/np/agent/issues/${enc(id)}/dependencies`, { body: { dependsOnIssueId, type } });
  }
  /**
   * DELETE /np/agent/issues/:id/dependencies?dependsOnIssueId=&type= — the agent knows the other
   * issue, not the dependency row id (contract §I leaves the shape open; see README).
   */
  removeDependency(id: string, dependsOnIssueId: string, type: DependencyType = 'blockedBy'): Promise<unknown> {
    return this.http.data('DELETE', `/np/agent/issues/${enc(id)}/dependencies`, { query: { dependsOnIssueId, type } });
  }
}
