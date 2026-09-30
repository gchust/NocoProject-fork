/**
 * `pmConversations` rows and the pieces the conversation pages and the claim read (NP-183, protocol-pm-assistant.md
 * §5): the owner's summaries, the bound agent, and rebinding a conversation to another agent (the issue's executor
 * follows, with an `executor_changed` activity, a system comment in the conversation and the queued work moved).
 */
import type { ActivityRecorder } from '../shared/activity.js';
import type { Conn, Tx } from '../shared/db.js';
import { iso, isoOrNull, now, str } from '../shared/db.js';
import type { IdSource } from '../shared/ids.js';
import type {
  IssueV4,
  PmAgentSource,
  PmConversationDetail,
  PmConversationSummary,
  PmTitleSource,
} from '../shared/protocol.js';
import { findIssue } from '../issue/issue.records.js';
import type { SettingsService } from '../system/settings.service.js';
import type { TriggerService } from '../trigger/trigger.service.js';
import { conversationAgentView } from './pm-agent.eligibility.js';

export interface ConversationRow {
  readonly issueId: string;
  readonly ownerUserId: string;
  readonly agentId: string | null;
  readonly agentSource: PmAgentSource;
  readonly personalAgentId: string | null;
  readonly titleSource: PmTitleSource;
  readonly lastMessageAt: string;
  readonly archivedAt: string | null;
  readonly createdAt: string;
}

function sourceOf(value: unknown): PmAgentSource {
  return value === 'personal' || value === 'fallback' ? value : 'system';
}

function titleSourceOf(value: unknown): PmTitleSource {
  return value === 'agent' || value === 'user' ? value : 'auto';
}

export function mapConversation(row: Record<string, unknown>): ConversationRow {
  return {
    issueId: str(row.issueId) ?? '',
    ownerUserId: str(row.ownerUserId) ?? '',
    agentId: str(row.agentId),
    agentSource: sourceOf(row.agentSource),
    personalAgentId: str(row.personalAgentId),
    titleSource: titleSourceOf(row.titleSource),
    lastMessageAt: iso(row.lastMessageAt),
    archivedAt: isoOrNull(row.archivedAt),
    createdAt: iso(row.createdAt),
  };
}

export async function findConversation(
  conn: Conn,
  issueId: string,
): Promise<ConversationRow | null> {
  const row = await conn.query
    .selectFrom('pmConversations')
    .selectAll()
    .where('issueId', '=', issueId)
    .executeTakeFirst();
  return row ? mapConversation(row) : null;
}

/** Whether a run is a conversation run: its subject is a conversation and it acts for the conversation's owner. */
export async function conversationOfRun(
  conn: Conn,
  run: { readonly subjectId: string; readonly actorUserId: string | null },
): Promise<ConversationRow | null> {
  const conversation = await findConversation(conn, run.subjectId);
  return conversation && conversation.ownerUserId === run.actorUserId
    ? conversation
    : null;
}

async function runningOn(conn: Conn, issueId: string): Promise<boolean> {
  const row = await conn.query
    .selectFrom('runs')
    .select('id')
    .where('subjectType', '=', 'issue')
    .where('subjectId', '=', issueId)
    .where('status', 'in', ['queued', 'deferred', 'dispatched', 'running'])
    .executeTakeFirst();
  return !!row;
}

async function pendingPlans(conn: Conn, issueId: string): Promise<number> {
  const rows = await conn.query
    .selectFrom('pmPlans')
    .select(['expiresAt'])
    .where('conversationIssueId', '=', issueId)
    .where('status', '=', 'pending')
    .execute();
  const at = Date.now();
  return rows.filter((row) => new Date(iso(row.expiresAt)).getTime() > at)
    .length;
}

export async function conversationSummary(
  conn: Conn,
  settings: SettingsService,
  row: ConversationRow,
  issue: Pick<IssueV4, 'title'>,
): Promise<PmConversationSummary> {
  return {
    id: row.issueId,
    title: issue.title,
    lastMessageAt: row.lastMessageAt,
    archivedAt: row.archivedAt,
    agent: await conversationAgentView(conn, settings, row),
    running: await runningOn(conn, row.issueId),
    pendingPlanCount: await pendingPlans(conn, row.issueId),
  };
}

export async function conversationDetail(
  conn: Conn,
  settings: SettingsService,
  row: ConversationRow,
  issue: IssueV4,
): Promise<PmConversationDetail> {
  return {
    ...(await conversationSummary(conn, settings, row, issue)),
    issueId: issue.id,
    identifier: issue.identifier || null,
    titleSource: row.titleSource,
  };
}

export interface RebindDeps {
  readonly ids: IdSource;
  readonly activity: ActivityRecorder;
  readonly triggers: () => TriggerService;
}

export interface Rebinding {
  readonly agentId: string;
  readonly agentSource: PmAgentSource;
  readonly personalAgentId: string | null;
  /** `executor_changed` reason: `pmAgentUnavailable`, `pmFallback` or `pmRestore`. */
  readonly reason: string;
  /** The system comment written into the conversation. */
  readonly note: string;
}

/**
 * Binds the conversation to another agent inside `tx`: the row, the issue's executor (revision + 1), the activity, a
 * system comment, and the queued work of the previous agent moved to the new one (`trigger/pm.ts`). A new agent has
 * its own session (`runSessions` are per agent), so the next run starts fresh.
 */
export async function rebindConversation(
  deps: RebindDeps,
  tx: Tx,
  row: ConversationRow,
  to: Rebinding,
): Promise<IssueV4> {
  const before = await findIssue(tx.conn, row.issueId);
  if (!before) throw new Error(`Conversation issue ${row.issueId} is missing.`);
  const timestamp = now();
  await tx.conn.query
    .updateTable('pmConversations')
    .set({
      agentId: to.agentId,
      agentSource: to.agentSource,
      personalAgentId: to.personalAgentId,
    })
    .where('issueId', '=', row.issueId)
    .execute();
  await tx.conn.query
    .updateTable('issues')
    .set({
      executorType: 'agent',
      executorId: to.agentId,
      revision: before.revision + 1,
      updatedAt: timestamp,
      lastActivityAt: timestamp,
    })
    .where('id', '=', row.issueId)
    .execute();
  await deps.activity.record(tx.conn, {
    issueId: row.issueId,
    actor: { type: 'system', id: null },
    action: 'executor_changed',
    details: {
      from: { type: before.executorType, id: before.executorId },
      to: { type: 'agent', id: to.agentId },
      reason: to.reason,
    },
  });
  const commentId = deps.ids.next();
  await tx.conn.query
    .insertInto('comments')
    .values({
      id: commentId,
      issueId: row.issueId,
      authorType: 'system',
      authorId: null,
      content: to.note,
      kind: 'system',
      parentId: null,
      rootId: commentId,
      sourceRunId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .execute();
  const after = (await findIssue(tx.conn, row.issueId)) as IssueV4;
  await deps.triggers().onConversationRebound(tx, {
    issue: after,
    fromAgentId: row.agentId,
  });
  tx.emit({ type: 'issue.changed', issueId: row.issueId });
  return after;
}

/** A message was written: the conversation moves to the top of its owner's list. */
export async function touchConversation(
  conn: Conn,
  issueId: string,
  at: Date = now(),
): Promise<void> {
  await conn.query
    .updateTable('pmConversations')
    .set({ lastMessageAt: at })
    .where('issueId', '=', issueId)
    .execute();
}

/** The first `chars` characters of a message without Markdown punctuation: the automatic title. */
export function autoTitle(content: string, chars: number): string {
  const plain = content
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/[#>*_`~|-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return [...plain].slice(0, chars).join('');
}
