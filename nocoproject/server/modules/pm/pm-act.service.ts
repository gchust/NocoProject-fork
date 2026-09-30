/**
 * Direct writes in the asker's name (NP-183, protocol-pm-assistant.md §3): `POST /np/agent/pm/act { op }`.
 *
 * Only a conversation run may (403 `NOT_CONVERSATION_RUN`), with `member.act`. The write runs as the conversation's
 * owner — their own access, `via: 'pm'`, the run and conversation on every activity — through the browser services,
 * so what the member may not do is refused exactly as in the browser. Anything that needs the member's own click is
 * 409 `PLAN_REQUIRED` with `details.reason`:
 *
 * - static rules first: `planOnly` (decisions, projects), `confirmAll` ("always confirm first"), `agentExecutor`,
 *   `ownerChange`, `terminal`, then `budget` (a third distinct object in this run);
 * - `wouldStartRun`: the write is performed inside a transaction while the trigger rules' run attempts are
 *   recorded (`trigger/preview.ts`); if it would start any run the transaction rolls back.
 *
 * Replies in the conversation itself are ordinary agent comments and never come here.
 */
import type { Actor } from '../shared/activity.js';
import { memberAccessOf } from '../shared/authz.js';
import type { Conn, Tx, TxRunner } from '../shared/db.js';
import { now } from '../shared/db.js';
import { conflict, forbidden, invalid } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import {
  PM_DIRECT_WRITE_LIMIT,
  PM_OPERATION_TYPES,
  type PmActRequest,
  type PmActResult,
  type PmOperation,
  type PmPlanRequiredReason,
} from '../shared/protocol.js';
import { requireCapability } from '../agent/capabilities.js';
import { findIssue } from '../issue/issue.records.js';
import type { KnowledgeService } from '../knowledge/knowledge.service.js';
import type { RoleAssignments } from '../member/member.roles.js';
import { preferencesOf } from '../member/member.service.js';
import type { RunAuth } from '../run/token.js';
import { collectRuns } from '../trigger/preview.js';
import type { WorkflowService } from '../workflow/workflow.service.js';
import { writtenObjects } from './pm-act.budget.js';
import {
  conversationOfRun,
  type ConversationRow,
} from './pm.conversation-records.js';
import { validateOpParams } from './pm.op-params.js';
import { performOperation, type OperationDeps } from './pm.operations.js';

export interface PmActService {
  act(auth: RunAuth, request: PmActRequest): Promise<PmActResult>;
  /** The conversation of a conversation run, else 403 `NOT_CONVERSATION_RUN`; checks `member.act`. */
  conversationRun(auth: RunAuth): Promise<ConversationRow>;
}

export interface PmActDeps extends OperationDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly workflows: WorkflowService;
  readonly roles: () => RoleAssignments;
  readonly knowledge: () => KnowledgeService;
}

function planRequired(
  reason: PmPlanRequiredReason,
  extra: Record<string, unknown> = {},
): never {
  throw conflict(
    'PLAN_REQUIRED',
    `This needs the member's confirmation: propose an operation plan instead (${reason}).`,
    { reason, ...extra },
  );
}

export async function requireConversationRun(
  conn: Conn,
  auth: RunAuth,
): Promise<ConversationRow> {
  const conversation = await conversationOfRun(conn, {
    subjectId: auth.issueId,
    actorUserId: auth.actorUserId,
  });
  if (!conversation)
    throw forbidden(
      'NOT_CONVERSATION_RUN',
      "Only a project manager conversation run may act in the member's name.",
    );
  await requireCapability(conn, auth, 'member.act');
  return conversation;
}

/** The member the run acts for, as the browser would see them, marked as reached through the project manager. */
export async function askerActor(
  conn: Conn,
  roles: RoleAssignments,
  auth: RunAuth,
  conversation: ConversationRow,
): Promise<Actor> {
  return {
    type: 'user',
    id: conversation.ownerUserId,
    access: await memberAccessOf(conn, roles, conversation.ownerUserId),
    via: 'pm',
    runId: auth.runId,
    pm: { conversationId: conversation.issueId, agentId: auth.agentId },
  };
}

function isTerminalMove(
  deps: PmActDeps,
  conn: Conn,
  op: PmOperation,
): Promise<boolean> {
  if (op.type !== 'issue.status') return Promise.resolve(false);
  const target = typeof op.params.issue === 'string' ? op.params.issue : null;
  if (!target) return Promise.resolve(false);
  return findIssue(conn, target).then(async (issue) =>
    issue
      ? (await deps.workflows.forIssue(conn, issue)).isTerminal(
          op.params.statusKey,
        )
      : false,
  );
}

/** The static rules of §3.2. */
async function staticRules(
  deps: PmActDeps,
  conn: Conn,
  owner: string,
  op: PmOperation,
): Promise<void> {
  if (!PM_OPERATION_TYPES.includes(op?.type))
    throw invalid('UNSUPPORTED_OPERATION', 'Unknown operation type.');
  validateOpParams(op);
  if (op.type === 'decision.resolve' || op.type === 'project.create')
    planRequired('planOnly');
  if ((await preferencesOf(conn, owner)).pmConfirmAll)
    planRequired('confirmAll');
  if (op.type === 'issue.create' || op.type === 'issue.update') {
    const params =
      (op.type === 'issue.create' ? op.params : op.params?.set) ?? {};
    if (params.executor?.type === 'agent') planRequired('agentExecutor');
    if (params.ownerUserId !== undefined && params.ownerUserId !== owner)
      planRequired('ownerChange');
    if (op.type === 'issue.update' && params.ownerUserId !== undefined)
      planRequired('ownerChange');
  }
  if (await isTerminalMove(deps, conn, op)) planRequired('terminal');
}

/** The issue a direct write touches for the budget, when it exists already. */
async function knownTarget(
  conn: Conn,
  op: PmOperation,
): Promise<string | null> {
  if (op.type === 'issue.create' || op.type === 'knowledge.propose')
    return null;
  const target = (op.params as { issue?: unknown }).issue;
  if (typeof target !== 'string') return null;
  return (await findIssue(conn, target))?.id ?? null;
}

async function act(
  deps: PmActDeps,
  auth: RunAuth,
  request: PmActRequest,
): Promise<PmActResult> {
  const conn = deps.tx.read();
  const conversation = await requireConversationRun(conn, auth);
  const op = request?.op;
  await staticRules(deps, conn, conversation.ownerUserId, op);
  const written = await writtenObjects(conn, auth.runId);
  const target = await knownTarget(conn, op);
  const again = !!target && written.some((item) => item.objectId === target);
  if (!again && written.length >= PM_DIRECT_WRITE_LIMIT)
    planRequired('budget', {
      budget: { used: written.length, limit: PM_DIRECT_WRITE_LIMIT },
    });
  const actor = await askerActor(conn, deps.roles(), auth, conversation);
  const record = async (
    tx: Tx,
    key: { objectType: string; objectId: string },
  ) =>
    tx.conn.query
      .insertInto('pmActWrites')
      .values({
        id: deps.ids.next(),
        runId: auth.runId,
        opType: op.type,
        ...key,
        createdAt: now(),
      })
      .execute();
  if (op.type === 'knowledge.propose') {
    const proposal = await deps.knowledge().agentPropose(auth, op.params);
    await deps.tx.run((tx) =>
      record(tx, { objectType: 'knowledgeProposal', objectId: proposal.id }),
    );
    return {
      op: op.type,
      object: { type: 'knowledgeProposal', id: proposal.id },
      budget: { used: written.length + 1, limit: PM_DIRECT_WRITE_LIMIT },
    };
  }
  const object = await deps.tx.run(async (tx) => {
    const { value, runs } = await collectRuns(() =>
      performOperation(deps, tx, actor, op),
    );
    if (runs.some((run) => run.started))
      planRequired('wouldStartRun', {
        runs: runs
          .filter((run) => run.started)
          .map((run) => ({
            agentId: run.agentId,
            issueId: run.issueId,
            triggerType: run.triggerType,
          })),
      });
    await record(tx, value.budgetKey);
    return value;
  });
  const used = again ? written.length : written.length + 1;
  const { budgetKey: _key, ...shown } = object;
  return {
    op: op.type,
    object: shown,
    budget: { used, limit: PM_DIRECT_WRITE_LIMIT },
  };
}

export function createPmActService(deps: PmActDeps): PmActService {
  return {
    act: (auth, request) => act(deps, auth, request),
    conversationRun: (auth) => requireConversationRun(deps.tx.read(), auth),
  };
}
