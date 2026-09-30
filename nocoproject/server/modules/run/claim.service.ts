import { createHash } from 'node:crypto';
import { AGENT_COMMANDS } from '../shared/protocol.capabilities.js';
import { effectiveCapabilities } from '../agent/capabilities.js';
import { createSettingsService } from '../system/settings.service.js';
/**
 * Batch claim for a daemon (protocol.md §4 `runs/claim`). Iteration 2 adds `agent.env` (decrypted — this payload only
 * travels on the daemon route), `agent.skills`, `issue.executionMode` and `issue.pullRequests`; iteration 3 the
 * `knowledge` index (the run's project documents, then system-level ones; no content) from the knowledge service;
 * iteration 4 `agent.kind`, `agent.reasoningEffort`, `issue.process`, `issue.designApprovedAt`,
 * `issue.designProposal` (the latest proposal, for the brief) and `issue.originType`; Phase 2 (NP-77) the current
 * status's `issue.checklist` and, on `stageEntered` triggers, `stage` (from, to and the rendered stage instruction).
 *
 * Each claimed run is its own short transaction: runtime advisory lock → claim SQL → run token insert. The payload
 * for the daemon is assembled after commit; if that fails the run stays `dispatched` and the lease rule re-queues it.
 */
import type { SecretBox } from '../shared/crypto.js';
import type { Conn, Tx, TxRunner } from '../shared/db.js';
import {
  isArrayValue,
  isPostgres,
  knexOf,
  rawRows,
  str,
  unique,
} from '../shared/db.js';
import { forbidden, invalid, runtimeNotFound } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import {
  CLAIM_LEASE_SECONDS,
  PROTOCOL_VERSION,
  type AgentProvider,
  type ClaimedRun,
  type ClaimedRunAttachmentExtras,
  type ClaimedRunPhase1Extras,
  type ClaimedRunPhase2Extras,
  type ClaimedRunPhase3Extras,
  type ClaimedRunPhase4Extras,
  type ClaimedRunWorkflowExtras,
  type ClaimedTriggerPhase2Extras,
  type ClaimedTriggerSignalExtras,
  type DaemonClaimRequest,
  type DaemonClaimResponse,
  type DaemonCompatibilityResponse,
  type RunTriggerType,
} from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import { claimEnv } from '../agent/env.service.js';
import { agentAttachments } from '../attachment/attachment.records.js';
import type { KnowledgeService } from '../knowledge/knowledge.service.js';
import { claimedPullRequests } from '../git/git.records.js';
import { agentKindOf, reasoningEffortOf } from '../agent/agent.fields.js';
import { findIssue, issueRef } from '../issue/issue.records.js';
import { latestProposal } from '../issue/process.js';
import { claimSkills } from '../skill/skill.service.js';
import { claimedProject } from '../project/project.records.js';
import type { WorkflowService } from '../workflow/workflow.service.js';
import {
  CLAIM_RUN_SQL,
  CLAIM_RUNTIME_LOCK_SQL,
  claimLockKey,
  type ClaimedRow,
} from './claim.sql.js';
import { currentChecklist } from '../workflow/checklist.js';
import {
  deviceNameOf,
  evaluateDaemon,
  markDaemonSeen,
  storedIdentity,
  supportsPmAssistant,
} from '../runtime/daemon-compat.js';
import {
  delegationTargets,
  signalOf,
  stageOf,
  triggerComments,
} from './claim.parts.js';
import { claimedConversation, noticePmUpgrade, planOf } from './claim.pm.js';
import { findRun } from './run.records.js';
import { emitRunStatus } from './run.service.js';
import { findSession } from './sessions.js';
import { issueRunToken } from './token.js';

/** Upper bound on runs claimed per slot per request, whatever `free` says. */
const MAX_CLAIMS_PER_SLOT = 32;

export interface ClaimService {
  claim(
    ownerUserId: string,
    request: DaemonClaimRequest,
    serverUrl: string,
  ): Promise<DaemonClaimResponse & DaemonCompatibilityResponse>;
  /** One claim attempt for one runtime; exposed for the concurrency tests. `conversations: false` skips conversation runs. */
  claimOne(
    runtimeId: string,
    conversations?: boolean,
  ): Promise<{ runId: string; token: string } | null>;
}

export interface ClaimDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly users: UserDirectory;
  readonly workflows: WorkflowService;
  readonly secrets: SecretBox;
  /** Iteration 3: the knowledge index of the claim payload. */
  readonly knowledge: () => KnowledgeService;
}

/** A claim payload with the iteration-1 extras merged in (contract §I). */
export type ClaimedRunV1 = ClaimedRun & ClaimedRunPhase1Extras;
/** ...and the iteration-2 extras (iteration-2 contract §L). */
export type ClaimedRunV2 = ClaimedRunV1 & ClaimedRunPhase2Extras;
/** ...and the iteration-3 `knowledge` index (iteration-3 contract §B). */
export type ClaimedRunV3 = ClaimedRunV2 & ClaimedRunPhase3Extras;
/** ...and the iteration-4 agent kind, reasoning effort and design state (iteration-4 contract §B, §C). */
export type ClaimedRunV4 = ClaimedRunV3 & ClaimedRunPhase4Extras;
/** ...and the Phase 2 checklist and stage instruction (NP-77 §6), the issue's attachments (NP-111) and signals. */
export type ClaimedRunV5 = ClaimedRunV4 &
  ClaimedRunWorkflowExtras &
  ClaimedRunAttachmentExtras & {
    readonly triggers: readonly (ClaimedRun['triggers'][number] &
      ClaimedTriggerPhase2Extras &
      ClaimedTriggerSignalExtras)[];
  };

interface VerifiedSlots {
  readonly runtimeIds: string[];
  readonly rows: readonly Record<string, unknown>[];
}

async function verifySlots(
  conn: Conn,
  ownerUserId: string,
  request: DaemonClaimRequest,
): Promise<VerifiedSlots> {
  if (
    !request ||
    typeof request.daemonId !== 'string' ||
    !isArrayValue(request.slots)
  ) {
    throw invalid('INVALID_CLAIM', 'daemonId and slots are required.');
  }
  const runtimeIds = unique(request.slots.map((slot) => slot?.runtimeId));
  if (runtimeIds.length === 0) return { runtimeIds: [], rows: [] };
  const rows = await conn.query
    .selectFrom('runtimes')
    .select(['id', 'ownerUserId', 'daemonId', 'status', 'deviceInfo'])
    .where('id', 'in', runtimeIds)
    .execute();
  for (const runtimeId of runtimeIds) {
    const row = rows.find((candidate) => candidate.id === runtimeId);
    // Unknown here (deleted, or registered under another daemon id) tells the daemon to register again.
    if (!row || row.daemonId !== request.daemonId)
      throw runtimeNotFound(runtimeId);
    if (row.ownerUserId !== ownerUserId) {
      throw forbidden(
        'RUNTIME_NOT_OWNED',
        `Runtime ${runtimeId} does not belong to this daemon.`,
      );
    }
  }
  return { runtimeIds, rows };
}

async function claimOneInTx(
  tx: Tx,
  ids: IdSource,
  runtimeId: string,
  conversations: boolean,
): Promise<{ runId: string; token: string } | null> {
  const knex = await knexOf(tx.conn);
  await knex.raw(CLAIM_RUNTIME_LOCK_SQL, [claimLockKey(runtimeId)]);
  const row = rawRows<ClaimedRow>(
    await knex.raw(CLAIM_RUN_SQL, [runtimeId, runtimeId, conversations]),
  )[0];
  if (!row) return null;
  const token = await issueRunToken(tx.conn, ids, {
    id: row.id,
    agentId: row.agent_id,
    actorUserId: row.actor_user_id,
  });
  emitRunStatus(tx, { id: row.id, subjectId: row.subject_id }, 'dispatched');
  return { runId: row.id, token };
}

async function buildClaimedRun(
  deps: ClaimDeps,
  runId: string,
  token: string,
  server: { readonly url: string; readonly protocolVersion: number },
): Promise<ClaimedRunV5 | null> {
  const conn = deps.tx.read();
  const run = await findRun(conn, runId);
  if (!run || !run.runtimeId) return null;
  const agent = await conn.query
    .selectFrom('agents')
    .selectAll()
    .where('id', '=', run.agentId)
    .executeTakeFirst();
  const issue = await findIssue(conn, run.subjectId);
  if (!agent || !issue) return null;
  const ownerNames = await deps.users.names(conn, [issue.ownerUserId]);
  const triggerRows = await conn.query
    .selectFrom('runTriggers')
    .select(['type', 'commentId', 'payload'])
    .where('runId', '=', runId)
    .orderBy('createdAt', 'asc')
    .execute();
  const comments = await triggerComments(
    conn,
    deps.users,
    unique(triggerRows.map((row) => str(row.commentId))),
  );
  const session = await findSession(conn, {
    agentId: run.agentId,
    runtimeId: run.runtimeId,
    subjectType: run.subjectType,
    subjectId: run.subjectId,
  });
  const entries = (await createSettingsService().read(conn)).agentEntries;
  const taskInstructions = triggerRows.some(
    (row) => row.type === 'retrospective',
  )
    ? entries.completion.instructions
    : issue.originType === 'pm'
      ? entries.conversation.instructions
      : '';
  const skills = await claimSkills(conn, run.agentId);
  const configurationFingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        instructions: agent.instructions,
        capabilities: agent.capabilities,
        skills,
        taskInstructions,
      }),
    )
    .digest('hex');
  const snapshot = {
    configurationFingerprint,
    configurationRevision: Number(agent.configurationRevision),
    // NP-183: a project manager type agent always holds exactly PM_CAPABILITIES (ADR-0009).
    capabilities: effectiveCapabilities(agent),
    instructions: str(agent.instructions) ?? '',
    taskInstructions,
    skillIds: skills.map((skill) => skill.id),
    entryRevision: entries.revision,
  };
  const environment = await claimEnv(conn, deps.secrets, run.agentId);
  const scrub = (text: string) =>
    Object.values(environment)
      .filter((secret) => secret.length >= 6)
      .reduce((text, secret) => text.split(secret).join('[REDACTED]'), text);
  const storedSnapshot = JSON.stringify({
    ...snapshot,
    instructions: scrub(snapshot.instructions),
    taskInstructions: scrub(taskInstructions),
  });
  await conn.query
    .updateTable('runs')
    .set({ configurationSnapshot: storedSnapshot })
    .where('id', '=', run.id)
    .execute();
  const fresh =
    !session ||
    session.poisoned ||
    !session.providerSessionId ||
    session.configurationRevision !== snapshot.configurationRevision ||
    session.entryRevision !== entries.revision ||
    session.configurationFingerprint !== configurationFingerprint;
  const view = await deps.workflows.forIssue(conn, issue);
  const parent = issue.parentIssueId
    ? await findIssue(conn, issue.parentIssueId)
    : null;
  return {
    run: {
      id: run.id,
      agentId: run.agentId,
      runtimeId: run.runtimeId,
      attempt: run.attempt,
      priority: run.priority,
      createdAt: run.createdAt,
    },
    token,
    agent: {
      id: run.agentId,
      name: str(agent.name) ?? '',
      instructions: snapshot.instructions,
      capabilities: snapshot.capabilities,
      configurationRevision: snapshot.configurationRevision,
      taskInstructions,
      commandDescriptions: snapshot.capabilities.flatMap(
        (key) => AGENT_COMMANDS[key],
      ),
      provider: (str(agent.provider) ?? 'echo') as AgentProvider,
      model: str(agent.model),
      delegationTargets: await delegationTargets(conn, run.agentId),
      env: await claimEnv(conn, deps.secrets, run.agentId),
      skills,
      kind: agentKindOf(agent.kind),
      reasoningEffort: reasoningEffortOf(agent.reasoningEffort),
    },
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      statusKey: issue.statusKey,
      ownerName: (issue.ownerUserId && ownerNames.get(issue.ownerUserId)) || '',
      parent: parent ? issueRef(parent) : null,
      stage: issue.stage,
      autoExecuteSubtasks: issue.autoExecuteSubtasks,
      projectId: issue.projectId,
      executionMode: issue.executionMode,
      pullRequests: await claimedPullRequests(conn, issue.id),
      process: issue.process,
      designApprovedAt: issue.designApprovedAt,
      designProposal: await latestProposal(conn, issue.id),
      originType: issue.originType,
      checklist: await currentChecklist(conn, deps.users, issue),
      attachments: await agentAttachments(conn, issue.id),
      ...(await claimedConversation(conn, deps.users, run)),
    },
    project: await claimedProject(conn, issue.projectId),
    statusCatalog: view.catalog,
    agentTransitions: view.agentTransitions,
    triggers: triggerRows.map((row) => {
      const comment = row.commentId
        ? comments.get(str(row.commentId) ?? '')
        : undefined;
      const stage = {
        ...stageOf(row.type, row.payload),
        ...signalOf(row.type, row.payload),
        ...planOf(row.type, row.payload),
      };
      return comment
        ? { type: str(row.type) as RunTriggerType, comment, ...stage }
        : { type: str(row.type) as RunTriggerType, ...stage };
    }),
    session: {
      providerSessionId: fresh ? null : (session?.providerSessionId ?? null),
      workDir: session?.workDir ?? null,
      fresh,
      branchName: session?.branchName ?? null,
      repoUrl: session?.repoUrl ?? null,
    },
    server,
    leaseSeconds: CLAIM_LEASE_SECONDS,
    knowledge: await deps.knowledge().claimIndex(conn, issue.projectId),
  };
}

export function createClaimService(deps: ClaimDeps): ClaimService {
  const claimOne = (runtimeId: string, conversations = true) =>
    deps.tx.run((tx) => claimOneInTx(tx, deps.ids, runtimeId, conversations));

  return {
    claimOne,
    async claim(ownerUserId, request, serverUrl) {
      const conn = deps.tx.read();
      if (!isPostgres(conn)) {
        throw invalid(
          'UNSUPPORTED_DIALECT',
          'Claiming runs requires PostgreSQL.',
        );
      }
      const { runtimeIds, rows } = await verifySlots(
        conn,
        ownerUserId,
        request,
      );
      if (runtimeIds.length === 0) return { runs: [] };
      // The daemon as register recorded it, and what this claim carries (NP-125's configuration protocol).
      const compatibility = evaluateDaemon({
        ...storedIdentity(rows[0]?.deviceInfo),
        claim: { configurationProtocol: request.configurationProtocol },
      });
      // A claim is proof of life for the runtimes it names.
      await deps.tx.run((tx) =>
        markDaemonSeen(tx, {
          ownerUserId,
          daemonId: request.daemonId,
          deviceName: deviceNameOf(rows[0]?.deviceInfo),
          rows: rows.map((row) => ({
            id: str(row.id) ?? '',
            status: str(row.status) ?? null,
          })),
          compatibility,
        }),
      );
      // An unsupported daemon gets no work, but a normal answer: it keeps heartbeating and shows why (NP-150).
      if (compatibility.status === 'unsupported')
        return { runs: [], compatibility };
      const conversations = supportsPmAssistant(storedIdentity(rows[0]?.deviceInfo));
      await deps.tx.run((tx) =>
        noticePmUpgrade(tx, {
          ownerUserId,
          daemonId: request.daemonId,
          deviceName: deviceNameOf(rows[0]?.deviceInfo),
          daemonVersion: compatibility.daemonVersion,
          runtimeIds,
          supported: conversations,
        }),
      );
      const claimed: { runId: string; token: string }[] = [];
      for (const slot of request.slots) {
        const free = Math.min(
          Math.max(0, Math.trunc(Number(slot.free) || 0)),
          MAX_CLAIMS_PER_SLOT,
        );
        for (let index = 0; index < free; index += 1) {
          const result = await claimOne(slot.runtimeId, conversations);
          if (!result) break;
          claimed.push(result);
        }
      }
      const runs: ClaimedRunV5[] = [];
      for (const { runId, token } of claimed) {
        const payload = await buildClaimedRun(deps, runId, token, {
          url: serverUrl,
          protocolVersion: compatibility.negotiatedProtocol ?? PROTOCOL_VERSION,
        });
        if (payload) runs.push(payload);
      }
      return { runs, compatibility };
    },
  };
}
