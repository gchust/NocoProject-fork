/**
 * Performing one project manager operation (NP-183, protocol-pm-assistant.md §3.2, §4.2) inside the caller's
 * transaction, as the member (`actor` carries their own access and the `via` marker), through the same services the
 * browser uses: permissions, workflow rules and trigger rules are exactly the browser's. Direct writes
 * (`pm-act.service.ts`) and plan cards (`pm.plans.ts`) both come here.
 *
 * `refs` maps the `ref` of earlier plan rows to what they created; an `issue` field takes an id or an identifier.
 * A status change that waits for approval is 409 `APPROVAL_REQUIRED` (v1 does not raise approval requests in a
 * member's name); the caller's transaction then rolls back, the approval request with it.
 */
import type { Actor } from '../shared/activity.js';
import type { Tx } from '../shared/db.js';
import { conflict, invalid, notFound } from '../shared/errors.js';
import { requireWorkItem } from '../shared/conversation.js';
import type {
  ExecutorInput,
  IssueV4,
  PmExecutorInput,
  PmIssueTarget,
  PmObjectType,
  PmOperation,
} from '../shared/protocol.js';
import { findIssue } from '../issue/issue.records.js';
import type { IssueService } from '../issue/issue.service.js';
import type { CommentService } from '../collaboration/comment.service.js';
import type { DependencyService } from '../subtask/dependency.service.js';

export interface OperationDeps {
  readonly issues: () => IssueService;
  readonly comments: () => CommentService;
  readonly dependencies: () => DependencyService;
}

export interface PerformedObject {
  readonly type: PmObjectType;
  readonly id: string;
  readonly identifier?: string | null;
  readonly title?: string | null;
  /** The issue the write belongs to, for the direct-write budget (a comment or dependency counts on its issue). */
  readonly budgetKey: {
    readonly objectType: string;
    readonly objectId: string;
  };
}

export type PlanRefs = Map<
  string,
  { readonly type: PmObjectType; readonly id: string }
>;

/** An `issue` target as an issue id (resolving plan refs); 400 `INVALID_REF` for an unknown ref. */
export function targetId(target: PmIssueTarget, refs: PlanRefs): string {
  if (typeof target === 'string') return target;
  if (!target || typeof target !== 'object')
    throw invalid(
      'INVALID_OPERATION',
      'issue must be an id, an identifier or a ref.',
    );
  if ('ref' in target) {
    const found = refs.get(target.ref);
    if (!found || found.type !== 'issue')
      throw invalid('INVALID_REF', `ref ${target.ref} names no earlier issue.`);
    return found.id;
  }
  if (typeof target?.issue !== 'string')
    throw invalid(
      'INVALID_OPERATION',
      'issue must be an id, an identifier or a ref.',
    );
  return target.issue;
}

export function executorOf(
  input: PmExecutorInput | undefined,
): ExecutorInput | undefined {
  if (!input) return undefined;
  if (input.type === 'none') return { type: 'none', id: null };
  return { type: input.type, id: input.id };
}

async function workItem(tx: Tx, idOrKey: string): Promise<IssueV4> {
  const issue = await findIssue(tx.conn, idOrKey);
  if (!issue) throw notFound('Issue');
  requireWorkItem(issue);
  return issue;
}

function issueObject(issue: IssueV4): PerformedObject {
  return {
    type: 'issue',
    id: issue.id,
    identifier: issue.identifier || null,
    title: issue.title,
    budgetKey: { objectType: 'issue', objectId: issue.id },
  };
}

async function patchIssue(
  deps: OperationDeps,
  tx: Tx,
  actor: Actor,
  issue: IssueV4,
  patch: Record<string, unknown>,
): Promise<IssueV4> {
  const result = await deps
    .issues()
    .patch(actor, issue.id, { ...patch, revision: issue.revision }, tx);
  if (result.pendingApproval)
    throw conflict(
      'APPROVAL_REQUIRED',
      'This status change needs an approval; ask for it on the issue page.',
      { issueId: issue.id },
    );
  return result.issue;
}

async function createIssue(
  deps: OperationDeps,
  tx: Tx,
  actor: Actor,
  op: Extract<PmOperation, { type: 'issue.create' }>,
  refs: PlanRefs,
): Promise<PerformedObject> {
  const params = op.params ?? ({} as never);
  const parent = params.parent ? targetId(params.parent, refs) : null;
  const created = await deps.issues().create(
    actor,
    {
      title: params.title,
      description: params.description,
      projectId: params.projectId,
      parentIssueId: parent ? (await workItem(tx, parent)).id : null,
      stage: params.stage ?? null,
      blockedBy: (params.blockedBy ?? []).map((item) => targetId(item, refs)),
      ownerUserId: params.ownerUserId,
      executor: executorOf(params.executor),
      priority: params.priority,
      labelIds: params.labelIds ? [...params.labelIds] : undefined,
      process: params.process,
      startDate: params.startDate ?? null,
      dueDate: params.dueDate ?? null,
    },
    { outer: tx },
  );
  if (op.ref) refs.set(op.ref, { type: 'issue', id: created.id });
  return issueObject(created);
}

/** Performs `op`; throws the service's own error (403, 404, 400 …) when the member may not. */
export async function performOperation(
  deps: OperationDeps,
  tx: Tx,
  actor: Actor,
  op: PmOperation,
  refs: PlanRefs = new Map(),
): Promise<PerformedObject> {
  switch (op.type) {
    case 'issue.create':
      return createIssue(deps, tx, actor, op, refs);
    case 'issue.update': {
      const issue = await workItem(tx, targetId(op.params.issue, refs));
      const { executor, ...set } = op.params.set ?? {};
      return issueObject(
        await patchIssue(deps, tx, actor, issue, {
          ...set,
          ...(executor ? { executor: executorOf(executor) } : {}),
        }),
      );
    }
    case 'issue.status': {
      const issue = await workItem(tx, targetId(op.params.issue, refs));
      return issueObject(
        await patchIssue(deps, tx, actor, issue, {
          statusKey: op.params.statusKey,
        }),
      );
    }
    case 'dependency.add':
    case 'dependency.remove': {
      const issue = await workItem(tx, targetId(op.params.issue, refs));
      const blockedBy = await workItem(tx, targetId(op.params.blockedBy, refs));
      if (op.type === 'dependency.add') {
        const added = await deps
          .dependencies()
          .add(
            actor,
            issue.id,
            { dependsOnIssueId: blockedBy.id, type: 'blockedBy' },
            tx,
          );
        return {
          type: 'dependency',
          id: added.dependencyId,
          budgetKey: { objectType: 'issue', objectId: issue.id },
        };
      }
      await deps.dependencies().remove(actor, issue.id, blockedBy.id, tx);
      return {
        type: 'dependency',
        id: `${issue.id}:${blockedBy.id}`,
        budgetKey: { objectType: 'issue', objectId: issue.id },
      };
    }
    case 'comment.create': {
      const issue = await workItem(tx, targetId(op.params.issue, refs));
      const content =
        op.params.internal && !op.params.content.startsWith('/note')
          ? `/note\n${op.params.content}`
          : op.params.content;
      const { comment } = await deps
        .comments()
        .create(
          actor,
          issue.id,
          { content, parentId: op.params.parentId ?? null },
          { outer: tx, trigger: actor.via !== 'pm' },
        );
      return {
        type: 'comment',
        id: comment.id,
        budgetKey: { objectType: 'issue', objectId: issue.id },
      };
    }
    default:
      throw invalid(
        'UNSUPPORTED_OPERATION',
        `${(op as { type?: string }).type ?? 'This operation'} is not supported here.`,
      );
  }
}
