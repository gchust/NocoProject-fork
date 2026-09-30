/**
 * Per-run context files under `<workDir>/.nocoproject/` (contract §I):
 *
 * - `context.json` — written by the daemon (mode 0600) before the tool starts, from the Phase 1
 *   claim extras: project and its repositories, parent issue, stage, delegation targets and the
 *   previous session's branch. The agent CLI reads it offline (`repo checkout`, `project get`).
 *   Iteration 2 adds `issue.executionMode` and `issue.pullRequests`. It never contains the run
 *   token or the agent's environment variables (`agent.env`). Iteration 3 adds `knowledge` (the index
 *   of the knowledge documents the run can read, without content). Iteration 4 adds `issue.process`,
 *   `issue.designApprovedAt` and `agent.kind`.
 * - `checkout.json` — written by `nocoproject repo checkout`; the daemon reads it back and reports
 *   `branchName` / `repoUrl` on complete / fail.
 */
import type { ClaimedConversation, PmResolvedContext, PmPlanExecutedPayload, RunTriggerTypeV7 } from './protocol.phase2-pm-assistant.js';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type {
  CheckoutRecord,
  ClaimedKnowledgeDoc,
  ClaimedProject,
  ClaimedPullRequest,
  ClaimedRun,
  ClaimedRunAttachmentExtras,
  ClaimedRunPhase1Extras,
  ClaimedRunPhase2Extras,
  ClaimedRunPhase4Extras,
  ClaimedRunWorkflowExtras,
  ClaimedTriggerComment,
  AgentKind,
  ExecutionMode,
  IssueProcess,
  IssueChecklist,
  ReasoningEffort,
  SignalPayload,
  StageEnteredPayload,
} from './protocol.js';
import { REASONING_EFFORTS, RUN_ENV_PHASE1 } from './protocol.js';

/**
 * A claimed run as the Phase 1 server sends it: the Phase 0 payload plus the iteration-1,
 * iteration-2, iteration-3 (`knowledge`) and iteration-4 (agent kind / reasoning effort, issue process)
 * extras, the Phase 2 workflow ones (`issue.checklist`, `triggers[].stage`) and signals (`triggers[].signal`). Every extra is optional
 * so an older server (or mock) still type-checks and works.
 */
export type ClaimedRunV1 = Omit<ClaimedRun, 'issue' | 'agent' | 'session' | 'triggers'> & {
  readonly project?: ClaimedProject | null;
  readonly knowledge?: readonly ClaimedKnowledgeDoc[] | null;
  readonly issue: Omit<ClaimedRun['issue'], 'identifier'> & {
    readonly identifier: string | null;
    readonly conversation?: ClaimedConversation;
  } &
    Partial<ClaimedRunPhase1Extras['issue']> &
    Partial<ClaimedRunPhase2Extras['issue']> &
    Partial<ClaimedRunPhase4Extras['issue']> &
    Partial<ClaimedRunWorkflowExtras['issue']> &
    Partial<ClaimedRunAttachmentExtras['issue']>;
  readonly agent: ClaimedRun['agent'] &
    Partial<ClaimedRunPhase1Extras['agent']> &
    Partial<ClaimedRunPhase2Extras['agent']> &
    Partial<ClaimedRunPhase4Extras['agent']>;
  readonly session: ClaimedRun['session'] & Partial<ClaimedRunPhase1Extras['session']>;
  readonly triggers: readonly {
    readonly type: RunTriggerTypeV7;
    readonly comment?: ClaimedTriggerComment & { readonly context?: PmResolvedContext };
    readonly plan?: PmPlanExecutedPayload;
    readonly stage?: StageEnteredPayload;
    readonly signal?: SignalPayload;
  }[];
};

export interface RunContextFile {
  readonly version: 1;
  readonly runId: string;
  readonly agent: {
    readonly capabilities?: readonly import('./protocol.js').AgentCapability[];
    readonly id: string;
    readonly name: string;
    readonly delegationTargets: readonly { readonly id: string; readonly name: string }[];
    /** Iteration 4 (`coder` when missing). */
    readonly kind: AgentKind;
  };
  readonly issue: {
    readonly id: string;
    readonly identifier: string;
    readonly title: string;
    readonly parent: { readonly id: string; readonly identifier: string; readonly title: string } | null;
    readonly stage: number | null;
    readonly autoExecuteSubtasks: boolean;
    readonly projectId: string | null;
    readonly executionMode: ExecutionMode;
    readonly pullRequests: readonly ClaimedPullRequest[];
    /** Iteration 4 (`direct` when missing). */
    readonly process: IssueProcess;
    readonly designApprovedAt: string | null;
  };
  readonly project: ClaimedProject | null;
  /** Iteration 3: knowledge index (`[]` when the server sends none). */
  readonly knowledge: readonly ClaimedKnowledgeDoc[];
  readonly session: { readonly branchName: string | null; readonly repoUrl: string | null };
}

export const CONTEXT_DIR = '.nocoproject';
export const CONTEXT_FILE = 'context.json';
export const CHECKOUT_FILE = 'checkout.json';

/** `issue.executionMode`, defaulting to `task` for servers that do not send it. */
export function executionModeOf(claimed: Pick<ClaimedRunV1, 'issue'>): ExecutionMode {
  return claimed.issue.executionMode === 'session' ? 'session' : 'task';
}

/** `agent.kind`, defaulting to `coder`. */
export function agentKindOf(claimed: Pick<ClaimedRunV1, 'agent'>): AgentKind {
  return claimed.agent.kind === 'manager' ? 'manager' : 'coder';
}

/** `issue.process`, defaulting to `direct`. */
export function issueProcessOf(claimed: Pick<ClaimedRunV1, 'issue'>): IssueProcess {
  return claimed.issue.process === 'design_first' ? 'design_first' : 'direct';
}

/** `agent.reasoningEffort` when it is one of the known levels; otherwise undefined (no flag is passed). */
export function reasoningEffortOf(claimed: Pick<ClaimedRunV1, 'agent'>): ReasoningEffort | undefined {
  const effort = claimed.agent.reasoningEffort;
  return effort && REASONING_EFFORTS.includes(effort) ? effort : undefined;
}

/** True while a design-first issue waits for its design to be approved (§B). */
export function designPendingOf(claimed: Pick<ClaimedRunV1, 'issue'>): boolean {
  return issueProcessOf(claimed) === 'design_first' && !claimed.issue.designApprovedAt;
}

/** Phase 2: the current status's checklist, or null (older servers, no checklist, malformed). */
export function checklistOf(claimed: Pick<ClaimedRunV1, 'issue'>): IssueChecklist | null {
  const list = claimed.issue.checklist;
  return list && Array.isArray(list.items) ? list : null;
}

/** The claim's knowledge index, field by field, skipping malformed entries. */
export function knowledgeOf(claimed: Pick<ClaimedRunV1, 'knowledge'>): ClaimedKnowledgeDoc[] {
  const list = Array.isArray(claimed.knowledge) ? claimed.knowledge : [];
  return list
    .filter((d) => d && typeof d.slug === 'string' && d.slug && typeof d.title === 'string')
    .map((d) => ({
      id: String(d.id),
      slug: d.slug,
      title: d.title,
      summary: typeof d.summary === 'string' ? d.summary : '',
      projectId: d.projectId ?? null,
      childCount: typeof d.childCount === 'number' ? d.childCount : 0,
    }));
}

/** Built field by field (never spread from the claim) so `agent.env` and the token cannot leak in. */
export function buildRunContext(claimed: ClaimedRunV1): RunContextFile {
  return {
    version: 1,
    runId: claimed.run.id,
    agent: { capabilities: claimed.agent.capabilities ?? [], id: claimed.agent.id, name: claimed.agent.name, delegationTargets: claimed.agent.delegationTargets ?? [], kind: agentKindOf(claimed) },
    issue: {
      id: claimed.issue.id,
      identifier: claimed.issue.identifier || claimed.issue.id,
      title: claimed.issue.title,
      parent: claimed.issue.parent ?? null,
      stage: claimed.issue.stage ?? null,
      autoExecuteSubtasks: claimed.issue.autoExecuteSubtasks ?? false,
      projectId: claimed.issue.projectId ?? claimed.project?.id ?? null,
      executionMode: executionModeOf(claimed),
      pullRequests: (claimed.issue.pullRequests ?? []).map((pr) => ({ number: pr.number, url: pr.url, state: pr.state })),
      process: issueProcessOf(claimed),
      designApprovedAt: claimed.issue.designApprovedAt ?? null,
    },
    project: claimed.project ?? null,
    knowledge: knowledgeOf(claimed),
    session: { branchName: claimed.session.branchName ?? null, repoUrl: claimed.session.repoUrl ?? null },
  };
}

function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Writes `<workDir>/.nocoproject/context.json` (0600). Returns the path. */
export function writeRunContext(workDir: string, claimed: ClaimedRunV1): string {
  const path = join(workDir, CONTEXT_DIR, CONTEXT_FILE);
  writePrivateJson(path, buildRunContext(claimed));
  return path;
}

export function readRunContext(workDir: string): RunContextFile | null {
  const ctx = readJson<RunContextFile>(join(workDir, CONTEXT_DIR, CONTEXT_FILE));
  return ctx && typeof ctx === 'object' && ctx.issue && ctx.agent ? ctx : null;
}

export function writeCheckoutRecord(workDir: string, record: CheckoutRecord): string {
  const path = join(workDir, CONTEXT_DIR, CHECKOUT_FILE);
  writePrivateJson(path, record);
  return path;
}

/** Reads `checkout.json`; returns null when missing or malformed. */
export function readCheckoutRecord(workDir: string): CheckoutRecord | null {
  const rec = readJson<CheckoutRecord>(join(workDir, CONTEXT_DIR, CHECKOUT_FILE));
  if (!rec || typeof rec.url !== 'string' || typeof rec.branchName !== 'string' || !rec.url || !rec.branchName) return null;
  return rec;
}

/**
 * The run's workDir as seen by the agent CLI: `$NOCOPROJECT_WORKDIR`, otherwise the nearest
 * ancestor of `cwd` that contains `.nocoproject/context.json`.
 */
export function findWorkDir(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | null {
  const fromEnv = env[RUN_ENV_PHASE1.workDir];
  if (fromEnv) return resolve(fromEnv);
  let dir = resolve(cwd);
  for (let i = 0; i < 32; i++) {
    if (existsSync(join(dir, CONTEXT_DIR, CONTEXT_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
