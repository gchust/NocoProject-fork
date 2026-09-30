/**
 * The CLI user mode's client (NP-86): the browser API `/api/np/*` called with the signed-in person's API key
 * (`x-api-key`), so every request runs with exactly that person's permissions. Requests name the client in
 * `x-np-client: nocoproject-cli/<version>`; the server records `details.via = 'cli'` on the activities they write.
 */
import type {
  AgentListItem,
  Comment,
  CommentPage,
  CreateIssueRequestV1,
  InboxItem,
  Issue,
  IssueListItemV1,
  IssuePhase4Input,
  Label,
  MeResponse,
  ProjectListItem,
  StatusChangePendingResponse,
} from '../protocol.js';
import { CLI_VERSION } from '../version.js';
import { HttpClient } from './client.js';

export const NP_CLIENT_HEADER = 'x-np-client';
export const NP_CLIENT = `nocoproject-cli/${CLI_VERSION}`;

const enc = encodeURIComponent;

export interface Page<T> {
  readonly data: readonly T[];
  readonly nextCursor: string | null;
}

/** `GET /np/issues` filters; only given values are sent. */
export interface IssueListQuery {
  readonly ownerUserId?: string;
  readonly projectId?: string;
  readonly statusKey?: string;
  readonly labelId?: string;
  readonly executorId?: string;
  readonly q?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** The part of `GET /np/issues/:id` the CLI reads; the rest is passed through with `--json`. */
export interface IssueDetailView {
  readonly issue: IssueListItemV1 & { readonly description?: string | null; readonly revision: number };
  readonly comments: readonly Comment[];
  readonly commentsNextCursor?: string | null;
  readonly [key: string]: unknown;
}

export interface InboxQuery {
  readonly kind?: string;
  readonly resolved?: boolean;
  readonly cursor?: string;
}

export type UserStatusResult =
  | { readonly kind: 'applied'; readonly data: unknown }
  | { readonly kind: 'pending'; readonly data: StatusChangePendingResponse };

type Envelope<T> = { data?: T; nextCursor?: string | null };

export class UserApi {
  readonly http: HttpClient;
  constructor(serverUrl: string, apiKey: string, timeoutMs?: number) {
    this.http = new HttpClient(serverUrl, { kind: 'apiKey', apiKey }, timeoutMs, { [NP_CLIENT_HEADER]: NP_CLIENT });
  }

  me(): Promise<MeResponse> {
    return this.http.data('GET', '/np/me');
  }
  async issues(q: IssueListQuery = {}): Promise<Page<IssueListItemV1>> {
    return page(await this.http.raw<Envelope<IssueListItemV1[]>>('GET', '/np/issues', { query: { ...q } }));
  }
  issue(idOrIdentifier: string): Promise<IssueDetailView> {
    return this.http.data('GET', `/np/issues/${enc(idOrIdentifier)}`);
  }
  /** Older comments than the detail carries (`commentsNextCursor`). */
  async comments(id: string, cursor: string): Promise<Page<Comment>> {
    return page(await this.http.raw<Envelope<Comment[]> | CommentPage>('GET', `/np/issues/${enc(id)}/comments`, { query: { cursor, limit: 100 } }));
  }
  /** 201 `{ data: issue }` — the issue row, without the list's names (`ownerName`, `projectName`, …). */
  createIssue(body: CreateIssueRequestV1 & IssuePhase4Input): Promise<Issue> {
    return this.http.data('POST', '/np/issues', { body });
  }
  addComment(id: string, content: string, parentId?: string): Promise<unknown> {
    return this.http.data('POST', `/np/issues/${enc(id)}/comments`, { body: { content, ...(parentId ? { parentId } : {}) } });
  }
  /** `PATCH /np/issues/:id { statusKey, revision }`: 200 applies, 202 waits for approval. */
  async setStatus(id: string, statusKey: string, revision: number): Promise<UserStatusResult> {
    const { status, json } = await this.http.request<Envelope<unknown>>('PATCH', `/np/issues/${enc(id)}`, { body: { statusKey, revision } });
    const data = json?.data;
    if (status === 202) return { kind: 'pending', data: data as StatusChangePendingResponse };
    return { kind: 'applied', data };
  }
  async inbox(q: InboxQuery = {}): Promise<Page<InboxItem>> {
    const query = { kind: q.kind, cursor: q.cursor, resolved: q.resolved === undefined ? undefined : String(q.resolved) };
    return page(await this.http.raw<Envelope<InboxItem[]>>('GET', '/np/inbox', { query }));
  }
  async projects(): Promise<ProjectListItem[]> {
    return (await this.http.data<ProjectListItem[]>('GET', '/np/projects')) ?? [];
  }
  async labels(): Promise<Label[]> {
    return (await this.http.data<Label[]>('GET', '/np/labels')) ?? [];
  }
  async agents(): Promise<AgentListItem[]> {
    return (await this.http.data<AgentListItem[]>('GET', '/np/agents')) ?? [];
  }
}

function page<T>(body: { data?: readonly T[] | null; nextCursor?: string | null } | undefined): Page<T> {
  return { data: body?.data ?? [], nextCursor: body?.nextCursor ?? null };
}
