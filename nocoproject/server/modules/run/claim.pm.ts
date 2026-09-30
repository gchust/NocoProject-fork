/**
 * The claim's project manager extras (NP-183, protocol-pm-assistant.md §9.1, §10), all optional so an older daemon
 * ignores them:
 *
 * - `issue.conversation` on a conversation run: the asker summary, "always confirm first" and the direct-write budget;
 * - `triggers[].comment.context`: the page context stored with the message;
 * - `triggers[].plan` on `planExecuted`: the plan's result (the `plan_result` comment rides along as `comment`, so a
 *   daemon that does not know the type still reads the result).
 *
 * Version gate: a daemon older than `PM_ASSISTANT_MIN_CLI` claims every run except conversation runs, which wait for
 * an upgrade; its owner gets a `runtime_upgrade_required` item (reason `pmAssistant`) while such a run waits.
 */
import type { Conn, Tx } from '../shared/db.js';
import { fromJson, num, str } from '../shared/db.js';
import { isConversation } from '../shared/conversation.js';
import {
  LATEST_CLI_VERSION,
  PM_DIRECT_WRITE_LIMIT,
  type ClaimedConversation,
  type PmAskerSummary,
  type PmPlanExecutedPayload,
  type PmResolvedContext,
} from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import { isMemberRole } from '../shared/authz.js';
import { preferencesOf } from '../member/member.service.js';
import { conversationOfRun } from '../pm/pm.conversation-records.js';
import { directWriteCount } from '../pm/pm-act.budget.js';

const ASKER_PROJECTS_MAX = 20;
const DONE_STATUSES = ['done', 'cancelled'];

async function askerSummary(
  conn: Conn,
  users: UserDirectory,
  userId: string,
): Promise<PmAskerSummary> {
  const name = (await users.names(conn, [userId])).get(userId) ?? userId;
  const member = await conn.query
    .selectFrom('members')
    .select('role')
    .where('userId', '=', userId)
    .executeTakeFirst();
  const projects = await conn.query
    .selectFrom('projectMembers')
    .innerJoin('projects', 'projects.id', 'projectMembers.projectId')
    .select(['projects.id as id', 'projects.name as name'])
    .where('projectMembers.userId', '=', userId)
    .orderBy('projects.name', 'asc')
    .limit(ASKER_PROJECTS_MAX)
    .execute();
  const owned = await conn.query
    .selectFrom('issues')
    .select(['statusKey', 'originType'])
    .where('ownerUserId', '=', userId)
    .where('deletedAt', 'is', null)
    .where('statusKey', 'not in', DONE_STATUSES)
    .execute();
  const work = owned.filter(
    (row) => !isConversation({ originType: str(row.originType) }),
  );
  const decisions = await conn.query
    .selectFrom('inboxItems')
    .select((eb) => [eb.fn.countAll().as('count')])
    .where('userId', '=', userId)
    .where('kind', '=', 'decision')
    .where('resolvedAt', 'is', null)
    .where('archivedAt', 'is', null)
    .executeTakeFirst();
  return {
    userId,
    name,
    role: isMemberRole(member?.role) ? member.role : 'member',
    projects: projects.map((row) => ({
      id: str(row.id) ?? '',
      name: str(row.name) ?? '',
    })),
    ownedOpen: work.length,
    ownedInProgress: work.filter((row) => row.statusKey === 'in_progress')
      .length,
    pendingDecisions: num(decisions?.count),
    locale: null,
  };
}

/** `issue.conversation` for a conversation run, else nothing. */
export async function claimedConversation(
  conn: Conn,
  users: UserDirectory,
  run: {
    readonly id: string;
    readonly subjectId: string;
    readonly actorUserId: string | null;
  },
): Promise<{ conversation?: ClaimedConversation }> {
  const conversation = await conversationOfRun(conn, run);
  if (!conversation) return {};
  const prefs = await preferencesOf(conn, conversation.ownerUserId).catch(
    () => null,
  );
  const confirmAll = prefs?.pmConfirmAll ?? false;
  return {
    conversation: {
      id: conversation.issueId,
      agentSource: conversation.agentSource,
      confirmAll,
      budget: {
        used: await directWriteCount(conn, run.id),
        limit: confirmAll ? 0 : PM_DIRECT_WRITE_LIMIT,
      },
      asker: await askerSummary(conn, users, conversation.ownerUserId),
    },
  };
}

/** The stored page context of a trigger comment. */
export function commentContextOf(row: { readonly context?: unknown }): {
  context?: PmResolvedContext;
} {
  const context = fromJson<PmResolvedContext>(row.context);
  return context ? { context } : {};
}

/** `plan` of a `planExecuted` trigger, from its payload. */
export function planOf(
  type: unknown,
  payload: unknown,
): { plan?: PmPlanExecutedPayload } {
  if (type !== 'planExecuted') return {};
  const value = fromJson<PmPlanExecutedPayload>(payload);
  return value ? { plan: value } : {};
}

function pmNoticeKey(ownerUserId: string, daemonId: string): string {
  return `user:${ownerUserId}:runtime_upgrade_required:${daemonId}:pmAssistant`;
}

/**
 * Tells the owner of a daemon too old for conversation runs that one is waiting (once, until resolved), and resolves
 * that item once the daemon can take them.
 */
export async function noticePmUpgrade(
  tx: Tx,
  input: {
    readonly ownerUserId: string;
    readonly daemonId: string;
    readonly deviceName: string | null;
    readonly daemonVersion: string | null;
    readonly runtimeIds: readonly string[];
    readonly supported: boolean;
  },
): Promise<void> {
  const open = await tx.conn.query
    .selectFrom('inboxItems')
    .select('id')
    .where('dedupeKey', '=', pmNoticeKey(input.ownerUserId, input.daemonId))
    .where('resolvedAt', 'is', null)
    .executeTakeFirst();
  if (input.supported) {
    if (open) emitPmNotice(tx, input, false);
    return;
  }
  if (open || input.runtimeIds.length === 0) return;
  const waiting = await tx.conn.query
    .selectFrom('runs')
    .innerJoin('agents', 'agents.id', 'runs.agentId')
    .innerJoin('pmConversations', 'pmConversations.issueId', 'runs.subjectId')
    .select('runs.id')
    .where('runs.status', '=', 'queued')
    .where('agents.runtimeId', 'in', [...input.runtimeIds])
    .executeTakeFirst();
  if (waiting) emitPmNotice(tx, input, true);
}

function emitPmNotice(
  tx: Tx,
  input: {
    readonly ownerUserId: string;
    readonly daemonId: string;
    readonly deviceName: string | null;
    readonly daemonVersion: string | null;
  },
  upgradeRequired: boolean,
): void {
  tx.emit({
    type: 'runtime.compatibilityChanged',
    ownerUserId: input.ownerUserId,
    daemonId: input.daemonId,
    deviceName: input.deviceName,
    upgradeRequired,
    daemonVersion: input.daemonVersion,
    latestVersion: LATEST_CLI_VERSION,
    reason: 'pmAssistant',
    feature: 'pmAssistant',
  });
}
