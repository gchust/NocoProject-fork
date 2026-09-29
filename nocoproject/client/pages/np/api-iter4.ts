import type { ApiClient } from '@nocobase/app-client';

import { unwrap } from './api-iter2.js';
import { runTriggerType } from './detail-normalize.js';
import type {
  AgentListItem,
  IssueComment,
  IssueDetail,
  IssueListItem,
  RunSummary,
} from './types.js';
import type {
  AgentKind,
  DefaultProcess,
  IssueProcess,
  MergeBlocker,
  MergePreflight,
  PmConversation,
  ReasoningEffort,
} from './types-iter4.js';
import {
  MERGE_BLOCKERS,
  PROCESS_CHOICES,
  REASONING_EFFORTS,
} from './types-iter4.js';

/**
 * Iteration 4 endpoints and the readers that keep the pages working while the server's protocol document settles
 * (`docs/phase1/iteration-4-contract.md`): every field is read tolerantly, and a missing one means "as before".
 */

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

// ---------- §B process ----------

/** An issue's process; anything but `design_first` (including a server without the field) is `direct`. */
export function issueProcess(
  issue: Pick<IssueListItem, 'process'> | null | undefined,
): IssueProcess {
  return issue?.process === 'design_first' ? 'design_first' : 'direct';
}

export function readDefaultProcess(value: unknown): DefaultProcess {
  return PROCESS_CHOICES.find((choice) => choice === value) ?? 'auto';
}

/** The latest design proposal on the issue: a top-level `kind: 'proposal'` comment, or `issue.designProposal`. */
export function latestProposalComment(
  detail: Pick<IssueDetail, 'threads' | 'issue'> | undefined,
  commentId?: string | null,
): IssueComment | null {
  if (!detail) return null;
  const comments = detail.threads.flatMap((thread) => [
    thread.root,
    ...thread.replies,
  ]);
  if (commentId) {
    const named = comments.find((comment) => comment.id === commentId);
    if (named) return named;
  }
  const proposal = comments
    .filter((comment) => comment.kind === 'proposal')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (proposal) return proposal;
  const embedded = detail.issue.designProposal;
  if (embedded?.content) {
    return {
      id: embedded.commentId,
      authorType: 'agent',
      authorId:
        detail.issue.executorType === 'agent' ? detail.issue.executorId : null,
      authorName: detail.issue.executorName ?? null,
      content: embedded.content,
      kind: 'proposal',
      parentId: null,
      createdAt: embedded.createdAt,
    };
  }
  return null;
}

// ---------- §C agents ----------

/** An agent's kind; a server without the field has only coding agents. */
export function agentKind(
  agent: Pick<AgentListItem, 'kind'> | null | undefined,
): AgentKind {
  return agent?.kind === 'manager' ? 'manager' : 'coder';
}

export function isManagerAgent(
  agent: Pick<AgentListItem, 'kind'> | null | undefined,
): boolean {
  return agentKind(agent) === 'manager';
}

export function readReasoningEffort(value: unknown): ReasoningEffort | null {
  return REASONING_EFFORTS.find((effort) => effort === value) ?? null;
}

/**
 * The agents an executor picker offers (§C): project managers never execute ordinary issues
 * (`MANAGER_NOT_EXECUTOR`), except the one already set, which keeps its name in the trigger.
 */
export function executorCandidates(
  agents: readonly AgentListItem[],
  selectedAgentId?: string | null,
): AgentListItem[] {
  return agents.filter(
    (agent) =>
      agent.capabilities?.includes('issue.execute') ||
      agent.id === selectedAgentId,
  );
}

/**
 * Whether a comment is a retrospective note (§C): written by a run whose trigger is `retrospective`, or marked so by
 * the server (`kind: 'retrospective'` or `retrospective: true`).
 */
export function isRetrospectiveComment(
  comment: IssueComment,
  runs: readonly RunSummary[],
): boolean {
  const loose = comment as unknown as {
    readonly kind?: unknown;
    readonly retrospective?: unknown;
    readonly runTriggerType?: unknown;
  };
  if (loose.kind === 'retrospective' || loose.retrospective === true) {
    return true;
  }
  if (loose.runTriggerType === 'retrospective') return true;
  const runId = comment.sourceRunId;
  if (!runId) return false;
  const run = runs.find((candidate) => candidate.id === runId);
  return run ? runTriggerType(run) === 'retrospective' : false;
}

/** The tag a timeline comment carries: the design proposal, a retrospective note, or none. */
export type CommentTag = 'proposal' | 'retrospective' | null;

export function commentTag(
  comment: IssueComment,
  runs: readonly RunSummary[],
): CommentTag {
  if (comment.kind === 'proposal') return 'proposal';
  return isRetrospectiveComment(comment, runs) ? 'retrospective' : null;
}

// ---------- §C project manager conversation ----------

/** `{ issueId }`, `{ issue: { id } }` or `{ id }`, with or without the `data` envelope. */
export function normalizePmConversation(body: unknown): PmConversation {
  const inner = unwrap<unknown>(body);
  if (!inner || typeof inner !== 'object') return { issueId: null };
  const raw = inner as Record<string, unknown>;
  const issue =
    raw.issue && typeof raw.issue === 'object'
      ? (raw.issue as Record<string, unknown>)
      : null;
  return {
    issueId: text(raw.issueId) ?? text(issue?.id) ?? text(raw.id) ?? null,
  };
}

export async function fetchPmConversation(
  api: ApiClient,
  signal?: AbortSignal,
): Promise<PmConversation> {
  return normalizePmConversation(
    await api.request<unknown>({ path: 'np/pm/conversation', signal }),
  );
}

export async function openPmConversation(
  api: ApiClient,
): Promise<PmConversation> {
  return normalizePmConversation(
    await api.request<unknown>({
      path: 'np/pm/conversation',
      method: 'POST',
    }),
  );
}

/**
 * The viewer's conversation with the project manager: `GET` finds it, and when there is none yet `POST` creates it
 * (both are find-or-create on the server, the contract says; the `GET` first keeps a read from writing).
 */
export async function ensurePmConversation(
  api: ApiClient,
  signal?: AbortSignal,
): Promise<PmConversation> {
  try {
    const found = await fetchPmConversation(api, signal);
    if (found.issueId) return found;
  } catch (error: unknown) {
    const status = (error as { status?: number } | null)?.status;
    if (status !== 404) throw error;
  }
  return openPmConversation(api);
}

// ---------- NP-85: merging a pull request ----------

const idPart = (value: string) => encodeURIComponent(value);

/** What merging would do, read fresh from GitHub (`blocker` null = mergeable). */
export async function fetchMergePreflight(
  api: ApiClient,
  issueId: string,
  pullRequestId: string,
): Promise<MergePreflight> {
  return unwrap(
    await api.request<unknown>({
      path: `np/issues/${idPart(issueId)}/pull-requests/${idPart(pullRequestId)}/merge`,
    }),
  );
}

/** Squash-merges the head the member confirmed; the issue moves when GitHub's webhook arrives. */
export async function mergePullRequest(
  api: ApiClient,
  issueId: string,
  pullRequestId: string,
  expectedHeadSha: string,
): Promise<{ merged: true; sha: string }> {
  return unwrap(
    await api.request<unknown, { expectedHeadSha: string }>({
      path: `np/issues/${idPart(issueId)}/pull-requests/${idPart(pullRequestId)}/merge`,
      method: 'POST',
      json: { expectedHeadSha },
    }),
  );
}

/** The `blocker` of a `PR_NOT_MERGEABLE` error body (`details.blocker`), if any. */
export function mergeBlockerOfError(payload: unknown): MergeBlocker | null {
  const details = (payload as { details?: { blocker?: unknown } } | null)
    ?.details;
  const blocker = details?.blocker;
  return MERGE_BLOCKERS.find((item) => item === blocker) ?? null;
}
