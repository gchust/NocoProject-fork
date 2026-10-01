import { requireCapability } from '../agent/capabilities.js';
import { executorRuntimeTypeError } from '../agent/agent.runtime-type.js';
/**
 * What an agent may do to the issue tree through its run token (docs/phase1/iteration-1-contract.md §D, §I):
 * create sub-issues, list children, add and remove dependencies. Writes are limited to the run's issue and its
 * descendants.
 *
 * Sub-issue rules: owner = parent owner; project and `autoExecuteSubtasks` inherited; `issues.createdById` stays null
 * (the activity names the agent). `executor`:
 * - `'none'` (default): no executor;
 * - `'self'`: the parent's `autoExecuteSubtasks` on → the agent executes it (assign rule, blocking applies);
 *   off → a pending proposal for itself and `suggestedExecutorAgentId`;
 * - another agent id: on the creating agent's delegation list → `autoAccepted` and assigned; otherwise pending.
 */
import { requireWorkItem } from '../shared/conversation.js';
import type { Actor, ActivityRecorder } from '../shared/activity.js';
import type { Tx, TxRunner } from '../shared/db.js';
import { str } from '../shared/db.js';
import { forbidden, invalid, notFound } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import type {
  AgentCreateIssueRequest,
  AgentCreateIssueResponseV5 as AgentCreateIssueResponse,
  AgentDependencyRequest,
  ExecutorProposalV5 as ExecutorProposal,
  IssueDependency,
  IssueV1,
  SubtaskSummary,
  TriggeredRun,
} from '../shared/protocol.js';
import { stringList, validateStage } from '../shared/validate.js';
import { validateTitle } from '../issue/issue.fields.js';
import { findIssue, isIssuePriority } from '../issue/issue.records.js';
import type { IssueQueries } from '../issue/issue.queries.js';
import type { IssueService } from '../issue/issue.service.js';
import { DEFAULT_STATUS } from '../issue/status.js';
import { ensureLabelsByName } from '../label/label.service.js';
import type { RunAuth } from '../run/token.js';
import type { TriggerService } from '../trigger/trigger.service.js';
import type { WorkflowService } from '../workflow/workflow.service.js';
import { blockersOf } from './blocking.js';
import {
  deleteDependency,
  insertDependency,
  isDependencyType,
} from './dependency.service.js';
import { insertProposal } from './proposal.service.js';

const MAX_TREE_DEPTH = 20;

export interface AgentIssueService {
  create(
    auth: RunAuth,
    input: AgentCreateIssueRequest,
  ): Promise<AgentCreateIssueResponse>;
  children(idOrKey: string): Promise<SubtaskSummary[]>;
  addDependency(
    auth: RunAuth,
    idOrKey: string,
    input: AgentDependencyRequest,
  ): Promise<IssueDependency>;
  /** `target`: a dependency id or the id / identifier of the issue depended on (with `type`, default blockedBy). */
  removeDependency(
    auth: RunAuth,
    idOrKey: string,
    target: string,
    type?: string | null,
  ): Promise<void>;
}

export interface AgentIssueDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly activity: ActivityRecorder;
  readonly workflows: WorkflowService;
  readonly issues: () => IssueService;
  readonly queries: () => IssueQueries;
  readonly triggers: () => TriggerService;
}

function agentActor(auth: RunAuth): Actor {
  return { type: 'agent', id: auth.agentId, runId: auth.runId };
}

/** The issue, which must be the run's issue or one of its descendants. */
async function requireInRunTree(
  tx: Tx,
  auth: RunAuth,
  idOrKey: string,
): Promise<IssueV1> {
  const issue = await findIssue(tx.conn, idOrKey);
  if (!issue) throw notFound('Issue');
  let cursor: IssueV1 | null = issue;
  for (let depth = 0; cursor && depth < MAX_TREE_DEPTH; depth += 1) {
    if (cursor.id === auth.issueId) return issue;
    cursor = cursor.parentIssueId
      ? await findIssue(tx.conn, cursor.parentIssueId)
      : null;
  }
  throw forbidden(
    'ISSUE_NOT_IN_RUN',
    "A run token may only change its own issue and that issue's sub-issues.",
  );
}

async function delegates(
  tx: Tx,
  agentId: string,
  targetAgentId: string,
): Promise<boolean> {
  return tx.conn.query
    .selectFrom('agentDelegationGrants')
    .select('id')
    .where('agentId', '=', agentId)
    .where('targetAgentId', '=', targetAgentId)
    .exists();
}

interface ExecutorPlan {
  readonly assignTo: string | null;
  readonly proposal: 'pending' | 'autoAccepted' | null;
  readonly proposedAgentId: string | null;
}

async function planExecutor(
  tx: Tx,
  auth: RunAuth,
  parent: IssueV1,
  executor: string,
): Promise<ExecutorPlan> {
  if (executor === 'none')
    return { assignTo: null, proposal: null, proposedAgentId: null };
  const target = executor === 'self' ? auth.agentId : executor;
  const agent = await tx.conn.query
    .selectFrom('agents')
    .select(['id', 'archivedAt', 'runtimeType'])
    .where('id', '=', target)
    .executeTakeFirst();
  if (!agent || agent.archivedAt)
    throw invalid('INVALID_EXECUTOR', 'executor agent does not exist.');
  // NP-219: neither a suggestion nor a delegation may target a built-in agent.
  if (agent.runtimeType === 'builtin') throw executorRuntimeTypeError(target);
  if (executor === 'self')
    return parent.autoExecuteSubtasks
      ? { assignTo: target, proposal: null, proposedAgentId: null }
      : { assignTo: null, proposal: 'pending', proposedAgentId: target };
  return (await delegates(tx, auth.agentId, target))
    ? { assignTo: target, proposal: 'autoAccepted', proposedAgentId: target }
    : { assignTo: null, proposal: 'pending', proposedAgentId: target };
}

function validateInput(input: AgentCreateIssueRequest): void {
  validateTitle(input?.title);
  if (input.description !== undefined && typeof input.description !== 'string')
    throw invalid('INVALID_DESCRIPTION', 'description must be a string.');
  if (input.priority !== undefined && !isIssuePriority(input.priority))
    throw invalid('INVALID_PRIORITY', 'priority is not valid.');
  if (input.stage !== undefined) validateStage(input.stage);
  if (input.blockedBy !== undefined) stringList(input.blockedBy, 'blockedBy');
  if (input.labels !== undefined) stringList(input.labels, 'labels');
  if (
    input.executor !== undefined &&
    (typeof input.executor !== 'string' || !input.executor)
  )
    throw invalid(
      'INVALID_EXECUTOR',
      "executor must be 'self', 'none' or an agent id.",
    );
}

async function create(
  deps: AgentIssueDeps,
  auth: RunAuth,
  input: AgentCreateIssueRequest,
): Promise<AgentCreateIssueResponse> {
  validateInput(input);
  const actor = agentActor(auth);
  const { issue, proposal, triggered } = await deps.tx.run(async (tx) => {
    await requireCapability(tx.conn, auth, 'subtask.create');
    const parent = await requireInRunTree(
      tx,
      auth,
      input.parentIssueId ?? auth.issueId,
    );
    // NP-183: a project manager conversation has no sub-issues.
    requireWorkItem(parent);
    const plan = await planExecutor(tx, auth, parent, input.executor ?? 'none');
    const created = await deps.issues().insertIssue(tx, actor, {
      title: validateTitle(input.title),
      description: input.description ?? '',
      statusKey: DEFAULT_STATUS,
      priority: input.priority ?? 'none',
      ownerUserId: parent.ownerUserId,
      executor: { executorType: 'none', executorId: null },
      parentIssueId: parent.id,
      projectId: parent.projectId,
      stage: input.stage === undefined ? null : validateStage(input.stage),
      startDate: null,
      dueDate: null,
      autoExecuteSubtasks: parent.autoExecuteSubtasks,
      suggestedExecutorAgentId:
        plan.proposal === 'pending' ? plan.proposedAgentId : null,
      labelIds: input.labels
        ? await ensureLabelsByName(tx, deps.ids, input.labels)
        : [],
      createdById: null,
      originType: 'agent',
      originId: auth.runId,
    });
    for (const target of input.blockedBy ?? []) {
      const dependsOn = await findIssue(tx.conn, target);
      if (!dependsOn)
        throw invalid(
          'INVALID_DEPENDENCY',
          `blockedBy ${target} does not exist.`,
        );
      await insertDependency(tx, deps, {
        issue: created,
        dependsOn,
        type: 'blockedBy',
        actor,
      });
    }
    let proposalResult: ExecutorProposal | null = null;
    if (plan.proposal && plan.proposedAgentId)
      proposalResult = await insertProposal(tx, deps, {
        issue: created,
        proposedAgentId: plan.proposedAgentId,
        proposedByAgentId: auth.agentId,
        sourceRunId: auth.runId,
        status: plan.proposal,
        actor,
      });
    let triggeredRuns: TriggeredRun[] = [];
    let current = created;
    if (plan.assignTo) {
      const assigned = await deps
        .issues()
        .assignAgentInTx(tx, created, plan.assignTo, actor, 'assign');
      current = assigned.issue;
      triggeredRuns = assigned.triggered;
    }
    return {
      issue: current,
      proposal: proposalResult,
      triggered: triggeredRuns,
    };
  });
  const blocked =
    (await blockersOf(deps.tx.read(), deps.workflows, issue)).length > 0;
  // The issue is the full row merged with the agent view, so a CLI reading `Issue` fields finds them.
  const view = await deps.queries().forAgent(issue.id);
  return {
    issue: { ...issue, ...view },
    proposal,
    triggered,
    blocked,
  };
}

async function agentIssueAddDependency(
  deps: AgentIssueDeps,
  ...[auth, idOrKey, input]: Parameters<AgentIssueService['addDependency']>
) {
  const type = input?.type ?? 'blockedBy';
  if (!isDependencyType(type))
    throw invalid('INVALID_DEPENDENCY', 'type must be blockedBy or relatedTo.');
  const targetKey = input.blockedBy ?? input.dependsOnIssueId;
  if (typeof targetKey !== 'string' || !targetKey)
    throw invalid(
      'INVALID_DEPENDENCY',
      'blockedBy (or dependsOnIssueId) is required.',
    );
  return deps.tx.run(async (tx) => {
    await requireCapability(tx.conn, auth, 'dependency.write');
    const issue = await requireInRunTree(tx, auth, idOrKey);
    const dependsOn = await findIssue(tx.conn, targetKey);
    if (!dependsOn)
      throw invalid('INVALID_DEPENDENCY', `${targetKey} does not exist.`);
    const dependency = await insertDependency(tx, deps, {
      issue,
      dependsOn,
      type,
      actor: agentActor(auth),
    });
    if (type === 'blockedBy') await deps.triggers().onBlockingAdded(tx, issue);
    return dependency;
  });
}

async function agentIssueRemoveDependency(
  deps: AgentIssueDeps,
  ...[auth, idOrKey, target, type]: Parameters<
    AgentIssueService['removeDependency']
  >
) {
  const dependencyType = type ?? 'blockedBy';
  if (!isDependencyType(dependencyType))
    throw invalid('INVALID_DEPENDENCY', 'type must be blockedBy or relatedTo.');
  if (!target)
    throw invalid('INVALID_DEPENDENCY', 'dependsOnIssueId is required.');
  await deps.tx.run(async (tx) => {
    await requireCapability(tx.conn, auth, 'dependency.write');
    const issue = await requireInRunTree(tx, auth, idOrKey);
    const removed = await deleteDependency(
      tx,
      deps,
      issue,
      target,
      agentActor(auth),
      dependencyType,
    );
    if (!removed) throw notFound('Dependency');
    if (removed.type === 'blockedBy') {
      const fresh = (await findIssue(tx.conn, issue.id)) ?? issue;
      await deps
        .triggers()
        .onUnblockCandidate(tx, fresh, str(removed.dependsOnIssueId) ?? '');
    }
  });
}

export function createAgentIssueService(
  deps: AgentIssueDeps,
): AgentIssueService {
  return {
    create: (...args: Parameters<AgentIssueService['create']>) =>
      create(deps, ...args),
    children: (idOrKey) => deps.queries().children(idOrKey),
    addDependency: (...args) => agentIssueAddDependency(deps, ...args),
    removeDependency: (...args) => agentIssueRemoveDependency(deps, ...args),
  };
}
