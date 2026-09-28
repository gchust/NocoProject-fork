/**
 * Iteration 4 parts of the mock server: `POST /np/agent/issues/:id/design-proposal` (§B) and the
 * project-manager reads `GET /np/agent/pm/*` (§C). With `managerOnly` (the default) the pm endpoints
 * answer 403 `MANAGER_ONLY` unless the run's agent has `kind: 'manager'` (set via `agentExtras`).
 */
import type { CommentForAgent } from '../../src/protocol.js';
import type { ClaimedRunV1 as ClaimedRun } from '../../src/run-context.js';
import type { MockServer } from './mock-server.js';

type Send = (status: number, payload: unknown) => void;

/** The asker (`actorUserId`) that `--owner me` resolves to. */
export const PM_ACTOR_USER_ID = '1';

export class MockPm {
  managerOnly = true;
  readonly projects: Record<string, unknown>[] = [];
  readonly inbox: Record<string, unknown>[] = [];
  private seq = 0;

  constructor(private readonly server: MockServer) {}

  /** `POST /np/agent/issues/:id/design-proposal { content }` → `{ data: comment }` (kind 'proposal'). */
  designProposal(issueId: string, body: any, claimed: ClaimedRun, send: Send): void {
    const content = typeof body?.content === 'string' ? body.content : '';
    if (!content.trim()) return send(400, { code: 'VALIDATION_ERROR', message: 'content is required' });
    const issue = this.server.issues.get(issueId);
    if (!issue) return send(404, { code: 'ISSUE_NOT_FOUND', message: issueId });
    const id = `cp${++this.seq}`;
    const createdAt = new Date().toISOString();
    const comment = { id, issueId, authorType: 'agent', authorName: claimed.agent.name, content, kind: 'proposal', parentId: null, rootId: id, createdAt } as CommentForAgent & { kind: string; issueId: string };
    this.server.comments.get(issueId)?.push(comment);
    this.server.issues.set(issueId, { ...issue, designProposal: { commentId: id, content, createdAt } });
    return send(201, { data: comment });
  }

  route(method: string, path: string, url: URL, claimed: ClaimedRun, send: Send): void {
    if (this.managerOnly && claimed.agent.kind !== 'manager') return send(403, { code: 'MANAGER_ONLY', message: 'only manager agents may use /np/agent/pm' });
    if (method !== 'GET') return send(405, { code: 'METHOD_NOT_ALLOWED', message: method });
    const q = url.searchParams;
    if (path === '/np/agent/pm/projects') return send(200, { data: this.projects });
    if (path === '/np/agent/pm/issues') return send(200, this.issuePage(q));
    if (path === '/np/agent/pm/inbox') return send(200, { data: this.inbox.filter((i) => !q.get('kind') || i.kind === q.get('kind')) });
    if (path === '/np/agent/pm/knowledge') {
      const projectId = q.get('projectId');
      const docs = this.server.knowledge.docs.filter((d) => !projectId || d.projectId === projectId || d.projectId === null);
      return send(200, { data: docs.map(({ content: _c, ...rest }) => rest) });
    }
    if (path === '/np/agent/pm/metrics') return send(200, { data: this.metrics(q) });
    const m = path.match(/^\/np\/agent\/pm\/issues\/([^/]+)$/);
    const issue = m ? this.server.findIssue(decodeURIComponent(m[1] as string)) : undefined;
    if (!issue) return send(404, { code: 'ISSUE_NOT_FOUND', message: path });
    return send(200, {
      data: {
        issue: this.row(issue),
        comments: (this.server.comments.get(issue.id) ?? []).slice(-50),
        activities: [],
        runs: [],
        pullRequests: this.server.pullRequests.get(issue.id) ?? [],
        subtasks: [],
      },
    });
  }

  private row(issue: any) {
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      statusKey: issue.statusKey,
      priority: issue.priority,
      projectId: issue.projectId ?? null,
      ownerName: issue.ownerName,
      executorName: issue.executor?.name ?? null,
      process: issue.process ?? 'direct',
      updatedAt: issue.updatedAt ?? new Date().toISOString(),
    };
  }

  private issuePage(q: URLSearchParams) {
    const owner = q.get('ownerUserId');
    const since = q.get('updatedSince');
    const text = q.get('q')?.toLowerCase();
    const rows = [...this.server.issues.values()]
      .filter((i: any) => !q.get('projectId') || i.projectId === q.get('projectId'))
      .filter((i) => !q.get('statusKey') || i.statusKey === q.get('statusKey'))
      .filter((i: any) => !owner || (i.ownerUserId ?? PM_ACTOR_USER_ID) === (owner === 'me' ? PM_ACTOR_USER_ID : owner))
      .filter((i) => !q.get('executorId') || i.executor.id === q.get('executorId'))
      .filter((i) => !text || `${i.title}\n${i.description}`.toLowerCase().includes(text))
      .filter((i: any) => !since || (i.updatedAt ?? new Date().toISOString()) >= since)
      .map((i) => this.row(i));
    const offset = Number(q.get('cursor') ?? 0);
    const limit = Number(q.get('limit') ?? 50);
    const data = rows.slice(offset, offset + limit);
    return { data, nextCursor: offset + limit < rows.length ? String(offset + limit) : null };
  }

  private metrics(q: URLSearchParams) {
    return {
      from: q.get('from') ?? '2026-09-01',
      to: q.get('to') ?? '2026-09-30',
      projectId: q.get('projectId'),
      generatedAt: new Date().toISOString(),
      aiShare: { deliveredByAgent: 3, deliveredTotal: 4, share: 0.75 },
      reliability: { runs: 10, failedRuns: 1 },
      humanLoad: { openDecisions: 2 },
    };
  }
}
