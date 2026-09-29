import { AGENT_CAPABILITIES } from '../../src/protocol.js';
/**
 * In-process mock of the NocoProject server: daemon API (§4), agent API (§5) and the
 * NocoBase realtime socket at <base>/ws. Records every call for assertions.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AgentAttachmentInfo, DaemonCompatibility, ClaimedKnowledgeDoc, ClaimedProject, CommentForAgent, IssueForAgent, IssuePullRequestView, RunStatus } from '../../src/protocol.js';
import type { ClaimedRunV1 as ClaimedRun } from '../../src/run-context.js';
import { MockKnowledge } from './mock-knowledge.js';
import { MockPm } from './mock-pm.js';
import { MockWorkflow } from './mock-workflow.js';

export const API_KEY = 'test-api-key-0123456789';
/** NP-150: a computer credential the mock accepts on `/np/daemon/*` (header `x-np-computer-key`). */
export const COMPUTER_KEY = 'npc_test-computer-key-0123456789';
export const BASE = '/main';

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: any;
  readonly auth: string | undefined;
}

interface RunState {
  status: RunStatus;
  cancelRequested: boolean;
  claimed: ClaimedRun;
  events: any[];
}

/** Phase 1 bookkeeping for issues created or linked through the agent API. */
export interface IssueMeta {
  parentIssueId: string | null;
  stage: number | null;
  executor: string | null;
  labels: string[];
  priority: string | null;
  createdByRunId: string | null;
}

export interface Dependency {
  readonly dependencyId: string;
  readonly issueId: string;
  readonly dependsOnIssueId: string;
  readonly type: string;
}

/**
 * A mock issue; `approvalRequired` gates agent status changes (all, or only to the listed keys) with 202.
 * Iteration 4: `process` / `designApprovedAt` / `designProposal` go into the claim payload, and a
 * design-first issue without approval refuses `in_progress` with 403 `DESIGN_NOT_APPROVED`.
 */
export type MockIssue = IssueForAgent & {
  approvalRequired?: boolean | readonly string[];
  process?: 'direct' | 'design_first';
  designApprovedAt?: string | null;
  designProposal?: { commentId: string; content: string; createdAt: string } | null;
  projectId?: string | null;
  ownerUserId?: string;
  updatedAt?: string;
  attachments?: readonly AgentAttachmentInfo[];
};

export interface EnqueueOptions {
  provider?: string;
  triggerComment?: string;
  triggerType?: ClaimedRun['triggers'][number]['type'];
  session?: ClaimedRun['session'];
  project?: ClaimedProject | null;
  issueExtras?: Partial<ClaimedRun['issue']>;
  agentExtras?: Partial<ClaimedRun['agent']>;
  /** Iteration 3 claim extra; omitted from the payload when undefined (as an older server would). */
  knowledge?: ClaimedKnowledgeDoc[];
}

export interface MockOptions {
  readonly startDelayMs?: number;
  readonly wsAuth?: boolean;
  readonly protocolMismatch?: boolean;
  /** A server from before NP-150: refuses any protocol but 1 at register (426) and sends no `compatibility`. */
  readonly legacyServer?: boolean;
}

const TRANSITIONS = [
  { from: 'todo', to: 'in_progress' },
  { from: 'blocked', to: 'in_progress' },
  { from: 'in_progress', to: 'in_review' },
  { from: 'in_progress', to: 'blocked' },
  { from: 'todo', to: 'analysis' },
  { from: 'analysis', to: 'proposal_review' },
  { from: 'analysis', to: 'blocked' },
  { from: 'proposal_review', to: 'blocked' },
];

export class MockServer {
  readonly calls: Call[] = [];
  /** NP-150: the verdict sent with register, heartbeat and claim responses (none when undefined). */
  compatibility: DaemonCompatibility | undefined;
  /** NP-150: answers computer-credential requests with 401 of this code (a revoked credential). */
  computerKeyRefusal: string | undefined;
  /** Long-poll wakeups (`/np/daemon/wakeups`) kept for computer-credential daemons. */
  private readonly wakeupLog: unknown[] = [];
  private readonly wakeupWaiters = new Set<() => void>();
  latestVersion = '0.5.0';

  private compat(): { compatibility?: DaemonCompatibility } {
    return this.compatibility ? { compatibility: this.compatibility } : {};
  }
  readonly issues = new Map<string, MockIssue>();
  readonly comments = new Map<string, CommentForAgent[]>();
  readonly runs = new Map<string, RunState>();
  readonly queue: ClaimedRun[] = [];
  readonly tokens = new Map<string, string>();
  /** NP-111: attachment bytes by file id, served on `/np/agent/issues/:id/attachments/:fileId/content`. */
  readonly attachmentBytes = new Map<string, Uint8Array>();
  readonly runtimes = new Map<string, { id: string; provider: string }>();
  readonly meta = new Map<string, IssueMeta>();
  readonly dependencies: Dependency[] = [];
  readonly pullRequests = new Map<string, IssuePullRequestView[]>();
  readonly approvals: { id: string; issueId: string; fromStatus: string; toStatus: string }[] = [];
  readonly knowledge = new MockKnowledge();
  readonly pm = new MockPm(this);
  readonly workflow = new MockWorkflow();
  private readonly sockets = new Set<WebSocket>();
  private server: Server;
  private wss: WebSocketServer;
  private seq = 100;
  url = '';

  constructor(private readonly opts: MockOptions = {}) {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      if (req.url !== `${BASE}/ws` || req.headers['x-api-key'] !== API_KEY) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws));
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}${BASE}`;
  }

  async stop(): Promise<void> {
    for (const ws of this.sockets) ws.terminate();
    this.wss.close();
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  get subscribers(): number {
    return this.sockets.size;
  }

  private onSocket(ws: WebSocket): void {
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as { type: string; id?: string; topic?: string };
      if (msg.type === 'subscribe') {
        if (this.opts.wsAuth === false) {
          ws.send(JSON.stringify({ type: 'error', code: 'AUTHENTICATION_REQUIRED', message: 'Realtime topic "np:daemon" requires authentication.' }));
          return;
        }
        this.sockets.add(ws);
        ws.send(JSON.stringify({ type: 'subscribed', id: msg.id, topic: msg.topic, subscriptionId: 'sub-1' }));
      } else if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', id: msg.id }));
    });
    ws.on('close', () => this.sockets.delete(ws));
  }

  publish(payload: unknown): void {
    const frame = JSON.stringify({ type: 'event', topic: 'np:daemon', payload, publishedAt: new Date().toISOString() });
    for (const ws of this.sockets) ws.send(frame);
    this.wakeupLog.push(payload);
    for (const wake of this.wakeupWaiters) wake();
  }

  private async wakeups(url: URL, send: (s: number, p: unknown) => void): Promise<void> {
    const after = url.searchParams.get('after');
    if (after === null) return send(200, { data: { cursor: this.wakeupLog.length, events: [] } });
    const from = Number(after);
    if (this.wakeupLog.length <= from) {
      const timeoutMs = Math.min(Number(url.searchParams.get('timeout') ?? 25), 2) * 1000;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.wakeupWaiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, timeoutMs);
        this.wakeupWaiters.add(done);
      });
    }
    send(200, { data: { cursor: this.wakeupLog.length, events: this.wakeupLog.slice(from) } });
  }

  addIssue(partial: Partial<MockIssue> & { id: string; identifier: string }): MockIssue {
    const issue: MockIssue = {
      title: 'Test issue',
      description: 'Do the thing.',
      statusKey: 'todo',
      priority: 'medium',
      ownerName: 'Alice',
      executor: { type: 'agent', id: 'agent-1', name: 'Echo Bot' },
      ...partial,
    };
    this.issues.set(issue.id, issue);
    this.comments.set(issue.id, this.comments.get(issue.id) ?? []);
    return issue;
  }

  /** Queues a run for the given issue and publishes `workAvailable`. */
  enqueue(issueId: string, opts: EnqueueOptions = {}): string {
    const issue = this.issues.get(issueId);
    if (!issue) throw new Error(`no issue ${issueId}`);
    const provider = opts.provider ?? 'echo';
    const runtime = [...this.runtimes.values()].find((r) => r.provider === provider);
    const runId = String(++this.seq);
    const triggers: ClaimedRun['triggers'] = opts.triggerComment
      ? [{ type: opts.triggerType ?? 'mention', comment: this.addHumanComment(issueId, opts.triggerComment) }]
      : [{ type: opts.triggerType ?? 'assign' }];
    this.queue.push({
      run: { id: runId, agentId: 'agent-1', runtimeId: runtime?.id ?? 'rt-missing', attempt: 1, priority: 0, createdAt: new Date().toISOString() },
      token: `npr_${randomBytes(20).toString('hex')}`,
      agent: { capabilities: AGENT_CAPABILITIES, configurationRevision: 1, id: 'agent-1', name: 'Echo Bot', instructions: 'Be brief.', provider: provider as any, model: null, ...opts.agentExtras },
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        statusKey: issue.statusKey,
        ownerName: issue.ownerName,
        ...(issue.process ? { process: issue.process, designApprovedAt: issue.designApprovedAt ?? null, designProposal: issue.designProposal ?? null } : {}),
        ...opts.issueExtras,
      },
      ...(opts.project !== undefined ? { project: opts.project } : {}),
      ...(opts.knowledge !== undefined ? { knowledge: opts.knowledge } : {}),
      statusCatalog: [],
      agentTransitions: TRANSITIONS,
      triggers,
      session: opts.session ?? { providerSessionId: null, workDir: null, fresh: true },
      server: { url: this.url, protocolVersion: 1 },
      leaseSeconds: 45,
    });
    if (runtime) this.publish({ kind: 'workAvailable', runtimeId: runtime.id });
    return runId;
  }

  addHumanComment(issueId: string, content: string) {
    const id = `c${++this.seq}`;
    const comment: CommentForAgent = { id, authorType: 'user', authorName: 'Alice', content, parentId: null, rootId: id, createdAt: new Date().toISOString() };
    this.comments.get(issueId)?.push(comment);
    return { id, authorName: 'Alice', content, parentId: null, rootId: id };
  }

  /** Creates a running run for the issue (as if claimed) and returns its token. */
  issueToken(issueId: string, opts: EnqueueOptions = {}): string {
    const runId = this.enqueue(issueId, opts);
    const idx = this.queue.findIndex((q) => q.run.id === runId);
    const [run] = this.queue.splice(idx, 1);
    if (!run) throw new Error('enqueue failed');
    this.runs.set(runId, { status: 'running', cancelRequested: false, claimed: run, events: [] });
    this.tokens.set(run.token, runId);
    return run.token;
  }

  requestCancel(runId: string): void {
    const run = this.runs.get(runId);
    if (run) run.cancelRequested = true;
    this.publish({ kind: 'cancelRequested', runId });
  }

  callsTo(pattern: RegExp): Call[] {
    return this.calls.filter((c) => pattern.test(`${c.method} ${c.path}`));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname.startsWith(`${BASE}/api`) ? url.pathname.slice(`${BASE}/api`.length) : url.pathname;
    const body = raw ? JSON.parse(raw) : undefined;
    const auth = (req.headers['x-api-key'] as string | undefined) ?? (req.headers.authorization as string | undefined);
    this.calls.push({ method: req.method ?? 'GET', path: `${path}${url.search}`, body, auth });
    const send = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    try {
      if (path === '/healthz') return send(200, { ok: true });
      if (path.startsWith('/np/daemon/')) return await this.daemonRoute(req.method ?? 'GET', path, body, req, send);
      if (/^\/np\/agent\/issues\/[^/]+\/attachments\/[^/]+\/content$/.test(path)) return this.attachmentContent(path, req, res, send);
      if (path.startsWith('/np/agent/')) return this.agentRoute(req.method ?? 'GET', path, url, body, req, send);
      if (path === '/np/me') return req.headers['x-api-key'] === API_KEY ? send(200, { data: { userId: '1', name: 'Alice' } }) : send(401, { code: 'UNAUTHORIZED', message: 'no' });
      send(404, { code: 'NOT_FOUND', message: path });
    } catch (error) {
      send(500, { code: 'INTERNAL', message: (error as Error).message });
    }
  }

  private async daemonRoute(method: string, path: string, body: any, req: IncomingMessage, send: (s: number, p: unknown) => void): Promise<void> {
    const computer = req.headers['x-np-computer-key'];
    if (computer !== undefined) {
      if (computer !== COMPUTER_KEY) return send(401, { code: 'COMPUTER_KEY_INVALID', message: 'bad credential' });
      if (this.computerKeyRefusal) return send(401, { code: this.computerKeyRefusal, message: 'refused' });
    } else if (req.headers['x-api-key'] !== API_KEY) return send(401, { code: 'UNAUTHORIZED', message: 'bad key' });
    if (path === '/np/daemon/wakeups') return this.wakeups(new URL(req.url ?? '/', 'http://mock'), send);
    if (path === '/np/daemon/register') {
      if (this.opts.protocolMismatch) return send(426, { code: 'PROTOCOL_MISMATCH', message: 'upgrade' });
      if (this.opts.legacyServer && body.protocolVersion !== 1) return send(426, { code: 'PROTOCOL_MISMATCH', message: `Server speaks protocol 1; daemon sent ${String(body.protocolVersion)}.` });
      const runtimes = (body.runtimes as { provider: string }[]).map((r) => {
        const existing = this.runtimes.get(r.provider) ?? { id: `rt-${r.provider}`, provider: r.provider };
        this.runtimes.set(r.provider, existing);
        return existing;
      });
      const protocolVersion = this.opts.legacyServer ? 1 : Math.min(Number(body.protocolVersion) || 1, 2);
      return send(200, { data: { runtimes, serverTime: new Date().toISOString(), protocolVersion, pollIntervalMs: 15000, heartbeatIntervalMs: 15000, ...this.compat() } });
    }
    if (path === '/np/daemon/heartbeat') return send(200, { data: { ok: true, ...this.compat() } });
    if (path === '/np/daemon/deregister') return send(200, { data: { ok: true } });
    if (path === '/np/daemon/compatibility' && !this.opts.legacyServer)
      return send(200, { data: { protocols: { min: 1, current: 2 }, latestVersion: this.latestVersion, minVersion: '0.4.0', downloadPath: `/assets/cli/nocoproject-cli-${this.latestVersion}.tgz`, downloadUrl: `${this.url}/assets/cli/nocoproject-cli-${this.latestVersion}.tgz` } });
    if (path === '/np/daemon/runs/claim') {
      if (this.compatibility?.status === 'unsupported') return send(200, { data: { runs: [], ...this.compat() } });
      const out: ClaimedRun[] = [];
      for (const slot of body.slots as { runtimeId: string; free: number }[]) {
        for (let i = 0; i < slot.free; i++) {
          const idx = this.queue.findIndex((q) => q.run.runtimeId === slot.runtimeId);
          if (idx < 0) break;
          const [run] = this.queue.splice(idx, 1);
          if (!run) break;
          this.runs.set(run.run.id, { status: 'dispatched', cancelRequested: false, claimed: run, events: [] });
          this.tokens.set(run.token, run.run.id);
          out.push(run);
        }
      }
      return send(200, { data: { runs: out, ...this.compat() } });
    }
    const m = path.match(/^\/np\/daemon\/runs\/([^/]+)\/([a-z-]+)$/);
    const run = m ? this.runs.get(m[1] as string) : undefined;
    if (!m || !run) return send(404, { code: 'RUN_NOT_FOUND', message: path });
    const action = m[2];
    if (action === 'lease') return send(200, { data: { ok: true } });
    if (action === 'start') {
      if (this.opts.startDelayMs) await new Promise((r) => setTimeout(r, this.opts.startDelayMs));
      run.status = 'running';
      return send(200, { data: { ok: true } });
    }
    if (action === 'events') {
      for (const e of body.events) if (!run.events.some((x) => x.seq === e.seq)) run.events.push(e);
      return send(200, { data: { ok: true } });
    }
    if (action === 'status') return send(200, { data: { status: run.status, cancelRequested: run.cancelRequested } });
    if (action === 'complete') run.status = 'completed';
    else if (action === 'fail') run.status = 'failed';
    else if (action === 'cancel-ack') run.status = 'cancelled';
    else return send(404, { code: 'NOT_FOUND', message: path });
    return send(200, { data: { ok: true } });
  }

  private attachmentContent(path: string, req: IncomingMessage, res: ServerResponse, send: (s: number, p: unknown) => void): void {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/, '');
    if (!this.tokens.has(token)) return send(401, { code: 'INVALID_RUN_TOKEN', message: 'bad token' });
    const [, , , , issueRef, , fileId] = path.split('/').map(decodeURIComponent);
    const issue = this.findIssue(issueRef ?? '');
    const file = issue?.attachments?.find((item) => item.id === fileId);
    const bytes = file ? this.attachmentBytes.get(file.id) : undefined;
    if (!file || !bytes) return send(404, { code: 'NOT_FOUND', message: 'Attachment not found.' });
    res.writeHead(200, { 'content-type': file.mimeType });
    res.end(Buffer.from(bytes));
  }

  private agentRoute(method: string, path: string, url: URL, body: any, req: IncomingMessage, send: (s: number, p: unknown) => void): void {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/, '');
    const runId = this.tokens.get(token);
    const run = runId ? this.runs.get(runId) : undefined;
    if (!run || ['completed', 'failed', 'cancelled'].includes(run.status)) return send(401, { code: 'INVALID_RUN_TOKEN', message: 'bad token' });
    if (path === '/np/agent/context') {
      const issue = this.issues.get(run.claimed.issue.id);
      const project = run.claimed.project ?? null;
      return send(200, { data: { run: { id: runId }, agent: { capabilities: AGENT_CAPABILITIES, configurationRevision: 1, id: 'agent-1', name: 'Echo Bot' }, issue, statusCatalog: [], agentTransitions: TRANSITIONS, project } });
    }
    if (path.startsWith('/np/agent/knowledge')) return this.knowledge.route(method, path, url, body, run.claimed, send);
    if (path.startsWith('/np/agent/pm/')) return this.pm.route(method, path, url, run.claimed, send);
    if (path.startsWith('/np/agent/workflows')) return this.workflow.route(method, path, body, run.claimed, send);
    const cl = path.match(/^\/np\/agent\/issues\/([^/]+)\/checklists(?:\/([^/]+)\/items\/([^/]+))?$/);
    if (cl) {
      const target = this.findIssue(decodeURIComponent(cl[1] as string));
      if (!target) return send(404, { code: 'ISSUE_NOT_FOUND', message: path });
      const [statusKey, itemKey] = [cl[2], cl[3]].map((v) => (v ? decodeURIComponent(v) : undefined));
      return this.workflow.checklist(method, target.id, statusKey, itemKey, body, run.claimed, send);
    }
    if (path === '/np/agent/issues' && method === 'POST') return this.createIssue(body, run.claimed, send);
    const m = path.match(/^\/np\/agent\/issues\/([^/]+)(?:\/(comments|status|children|dependencies|pull-requests|design-proposal))?$/);
    const issue = m ? this.findIssue(decodeURIComponent(m[1] as string)) : undefined;
    if (!m || !issue) return send(404, { code: 'ISSUE_NOT_FOUND', message: path });
    if (!m[2]) return send(200, { data: issue });
    if (m[2] === 'children') return send(200, { data: this.children(issue.id) });
    if (m[2] === 'dependencies') return this.dependencyRoute(method, issue.id, url, body, send);
    if (m[2] === 'pull-requests') return this.pullRequestRoute(method, issue.id, body, send);
    if (m[2] === 'design-proposal') return this.pm.designProposal(issue.id, body, run.claimed, send);
    if (m[2] === 'comments' && method === 'GET') return send(200, { data: this.comments.get(issue.id) ?? [] });
    if (m[2] === 'comments') {
      const id = `c${++this.seq}`;
      const parent = body.parentId ? this.comments.get(issue.id)?.find((c) => c.id === body.parentId) : undefined;
      const comment: CommentForAgent = {
        id,
        authorType: 'agent',
        authorName: 'Echo Bot',
        content: body.content,
        parentId: body.parentId ?? null,
        rootId: parent?.rootId ?? id,
        createdAt: new Date().toISOString(),
      };
      this.comments.get(issue.id)?.push(comment);
      return send(200, { data: { comment } });
    }
    const allowed = TRANSITIONS.some((t) => t.from === issue.statusKey && t.to === body.statusKey);
    if (!allowed) return send(403, { code: 'TRANSITION_NOT_ALLOWED', message: `${issue.statusKey} → ${body.statusKey}` });
    if (issue.process === 'design_first' && !issue.designApprovedAt && body.statusKey === 'in_progress') return send(403, { code: 'DESIGN_NOT_APPROVED', message: 'the design is not approved yet' });
    const gate = issue.approvalRequired;
    if (gate === true || (Array.isArray(gate) && gate.includes(body.statusKey))) {
      const pendingApproval = {
        id: `ap${++this.seq}`,
        issueId: issue.id,
        fromStatus: issue.statusKey,
        toStatus: body.statusKey,
        requestedByType: 'agent',
        requestedById: run.claimed.agent.id,
        requestedRunId: runId,
        approverUserIds: ['1'],
        status: 'pending',
        decidedById: null,
        decidedAt: null,
        comment: null,
        createdAt: new Date().toISOString(),
      };
      this.approvals.push(pendingApproval);
      return send(202, { data: { issue: { id: issue.id, identifier: issue.identifier, statusKey: issue.statusKey }, pendingApproval } });
    }
    this.issues.set(issue.id, { ...issue, statusKey: body.statusKey });
    return send(200, { data: { issue: { id: issue.id, statusKey: body.statusKey } } });
  }

  findIssue(ref: string): MockIssue | undefined {
    return this.issues.get(ref) ?? [...this.issues.values()].find((i) => i.identifier.toUpperCase() === ref.toUpperCase());
  }

  private createIssue(body: any, claimed: ClaimedRun, send: (s: number, p: unknown) => void): void {
    if (!body?.title) return send(400, { code: 'VALIDATION_ERROR', message: 'title is required' });
    const n = ++this.seq;
    const parentIssueId = body.parentIssueId ?? claimed.issue.id;
    if (!this.findIssue(parentIssueId)) return send(404, { code: 'ISSUE_NOT_FOUND', message: parentIssueId });
    const executor = body.executor ?? 'none';
    const issue = this.addIssue({
      id: `i${n}`,
      identifier: `NP-${n}`,
      title: body.title,
      description: body.description ?? '',
      executor: executor === 'self' ? { type: 'agent', id: claimed.agent.id, name: claimed.agent.name } : { type: 'none', id: null, name: null },
    });
    this.meta.set(issue.id, { parentIssueId, stage: body.stage ?? null, executor, labels: body.labels ?? [], priority: body.priority ?? null, createdByRunId: claimed.run.id });
    for (const dep of body.blockedBy ?? []) this.dependencies.push({ dependencyId: `d${++this.seq}`, issueId: issue.id, dependsOnIssueId: dep, type: 'blockedBy' });
    return send(201, { data: { ...issue, parentIssueId, stage: body.stage ?? null } });
  }

  private children(parentId: string) {
    return [...this.meta.entries()]
      .filter(([, m]) => m.parentIssueId === parentId)
      .map(([id, m]) => {
        const child = this.issues.get(id) as IssueForAgent;
        const blockedCount = this.dependencies.filter((d) => d.issueId === id && this.issues.get(d.dependsOnIssueId)?.statusKey !== 'done').length;
        return { id, identifier: child.identifier, title: child.title, statusKey: child.statusKey, stage: m.stage, executorType: child.executor.type, executorName: child.executor.name, blockedCount };
      });
  }

  /** POST / GET /np/agent/issues/:id/pull-requests (iteration 2 §C); only GitHub-style URLs parse. */
  private pullRequestRoute(method: string, issueId: string, body: any, send: (s: number, p: unknown) => void): void {
    const list = this.pullRequests.get(issueId) ?? [];
    if (method === 'GET') return send(200, { data: list });
    if (method !== 'POST') return send(405, { code: 'METHOD_NOT_ALLOWED', message: method });
    const match = String(body?.url ?? '').match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/);
    if (!match) return send(400, { code: 'INVALID_PR_URL', message: String(body?.url) });
    const [, repo, num] = match as [string, string, string];
    const existing = list.find((p) => p.repo === repo && p.number === Number(num));
    if (existing) return send(200, { data: existing });
    const view: IssuePullRequestView = {
      id: `pr${++this.seq}`,
      connectionId: null,
      repo,
      number: Number(num),
      url: body.url,
      title: '',
      state: 'open',
      draft: false,
      headRef: '',
      baseRef: '',
      headSha: '',
      authorLogin: '',
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      mergeableState: null,
      ciState: null,
      mergedAt: null,
      closedAt: null,
      snapshotAt: null,
      linkedBy: { type: 'agent', id: 'agent-1', name: 'Echo Bot' },
      autoCompleteDisabled: false,
    };
    this.pullRequests.set(issueId, [...list, view]);
    return send(201, { data: view });
  }

  private dependencyRoute(method: string, issueId: string, url: URL, body: any, send: (s: number, p: unknown) => void): void {
    if (method === 'POST') {
      if (!this.issues.has(body?.dependsOnIssueId)) return send(404, { code: 'ISSUE_NOT_FOUND', message: String(body?.dependsOnIssueId) });
      const dep = { dependencyId: `d${++this.seq}`, issueId, dependsOnIssueId: body.dependsOnIssueId, type: body.type ?? 'blockedBy' };
      this.dependencies.push(dep);
      return send(201, { data: dep });
    }
    if (method === 'DELETE') {
      const other = url.searchParams.get('dependsOnIssueId');
      const idx = this.dependencies.findIndex((d) => d.issueId === issueId && d.dependsOnIssueId === other);
      if (idx < 0) return send(404, { code: 'DEPENDENCY_NOT_FOUND', message: String(other) });
      const [removed] = this.dependencies.splice(idx, 1);
      return send(200, { data: removed });
    }
    return send(405, { code: 'METHOD_NOT_ALLOWED', message: method });
  }
}
