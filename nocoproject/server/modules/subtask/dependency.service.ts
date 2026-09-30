/**
 * Issue dependencies (docs/phase1/iteration-1-contract.md §D). `blockedBy` gates the trigger rules; `relatedTo` is
 * informational. Self-references, direct mutual references and cycles along `blockedBy` (DFS, depth 100) are
 * rejected. Removing the last blocker starts the issue through the trigger module.
 */
import type { Actor, ActivityRecorder } from '../shared/activity.js';
import {
  requireEditIssues,
  requireVisibleIssue,
  viewerOf,
} from '../shared/authz.js';
import { requireWorkItemId } from '../shared/conversation.js';
import type { Conn, Tx, TxRunner } from '../shared/db.js';
import { isUniqueViolation, now, str } from '../shared/db.js';
import { conflict, invalid, notFound } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import type {
  AddDependencyRequest,
  DependencyType,
  IssueDependency,
  IssueV1,
} from '../shared/protocol.js';
import { findIssue, issuesByIds } from '../issue/issue.records.js';
import type { TriggerService } from '../trigger/trigger.service.js';

const MAX_DEPTH = 100;

export interface DependencyService {
  /** NP-183: `outer` joins the caller's transaction (the project manager's writes). */
  add(
    actor: Actor,
    issueIdOrKey: string,
    input: AddDependencyRequest,
    outer?: Tx,
  ): Promise<IssueDependency>;
  /** `target` is a dependency id, or the id / identifier of the issue depended on (type blockedBy). */
  remove(
    actor: Actor,
    issueIdOrKey: string,
    target: string,
    outer?: Tx,
  ): Promise<void>;
}

export interface DependencyDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly activity: ActivityRecorder;
  readonly triggers: () => TriggerService;
}

export function isDependencyType(value: unknown): value is DependencyType {
  return value === 'blockedBy' || value === 'relatedTo';
}

/** True when `from` is (transitively) blocked by `target` along blockedBy edges. */
async function reaches(
  conn: Conn,
  from: string,
  target: string,
): Promise<boolean> {
  const seen = new Set<string>([from]);
  let frontier = [from];
  for (let depth = 0; frontier.length > 0; depth += 1) {
    if (depth >= MAX_DEPTH)
      throw invalid('DEPENDENCY_TOO_DEEP', 'The dependency chain is too deep.');
    const rows = await conn.query
      .selectFrom('issueDependencies')
      .select('dependsOnIssueId')
      .where('issueId', 'in', frontier)
      .where('type', '=', 'blockedBy')
      .execute();
    const next: string[] = [];
    for (const row of rows) {
      const id = str(row.dependsOnIssueId) ?? '';
      if (id === target) return true;
      if (!seen.has(id)) {
        seen.add(id);
        next.push(id);
      }
    }
    frontier = next;
  }
  return false;
}

/** Inserts `issue` → `dependsOn` after the structural checks. Joins the caller's transaction. */
export async function insertDependency(
  tx: Tx,
  deps: Pick<DependencyDeps, 'ids' | 'activity'>,
  input: {
    issue: IssueV1;
    dependsOn: IssueV1;
    type: DependencyType;
    actor: Actor;
  },
): Promise<IssueDependency> {
  const { issue, dependsOn, type, actor } = input;
  // NP-183: a project manager conversation is never either end of a dependency.
  await requireWorkItemId(tx.conn, issue.id);
  await requireWorkItemId(tx.conn, dependsOn.id);
  if (issue.id === dependsOn.id)
    throw invalid('INVALID_DEPENDENCY', 'An issue cannot depend on itself.');
  const mutual = await tx.conn.query
    .selectFrom('issueDependencies')
    .select('id')
    .where('issueId', '=', dependsOn.id)
    .where('dependsOnIssueId', '=', issue.id)
    .where('type', '=', type)
    .exists();
  if (mutual)
    throw invalid(
      'DEPENDENCY_CYCLE',
      'The two issues already depend on each other.',
    );
  if (type === 'blockedBy' && (await reaches(tx.conn, dependsOn.id, issue.id)))
    throw invalid('DEPENDENCY_CYCLE', 'This dependency would create a cycle.');
  const id = deps.ids.next();
  try {
    await tx.conn.transaction(async (inner) => {
      await inner.query
        .insertInto('issueDependencies')
        .values({
          id,
          issueId: issue.id,
          dependsOnIssueId: dependsOn.id,
          type,
          createdByType: actor.type,
          createdById: actor.id,
          createdAt: now(),
        })
        .execute();
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw conflict('DEPENDENCY_EXISTS', 'This dependency already exists.');
    throw error;
  }
  await deps.activity.record(tx.conn, {
    issueId: issue.id,
    actor,
    action: 'dependency_added',
    details: {
      dependencyId: id,
      dependsOnIssueId: dependsOn.id,
      identifier: dependsOn.identifier,
      type,
    },
  });
  tx.emit({ type: 'issue.changed', issueId: issue.id });
  tx.emit({ type: 'issue.changed', issueId: dependsOn.id });
  return {
    dependencyId: id,
    issueId: dependsOn.id,
    identifier: dependsOn.identifier,
    title: dependsOn.title,
    statusKey: dependsOn.statusKey,
    type,
  };
}

/** Both directions of an issue's dependencies for the detail view. */
export async function dependenciesOf(
  conn: Conn,
  issueId: string,
): Promise<{ blockedBy: IssueDependency[]; blocks: IssueDependency[] }> {
  const outgoing = await conn.query
    .selectFrom('issueDependencies')
    .selectAll()
    .where('issueId', '=', issueId)
    .orderBy('createdAt', 'asc')
    .execute();
  const incoming = await conn.query
    .selectFrom('issueDependencies')
    .selectAll()
    .where('dependsOnIssueId', '=', issueId)
    .orderBy('createdAt', 'asc')
    .execute();
  const issues = await issuesByIds(conn, [
    ...outgoing.map((row) => str(row.dependsOnIssueId)),
    ...incoming.map((row) => str(row.issueId)),
  ]);
  const map = (row: Record<string, unknown>, otherId: string | null) => {
    const other = issues.get(otherId ?? '');
    if (!other) return null;
    return {
      dependencyId: str(row.id) ?? '',
      issueId: other.id,
      identifier: other.identifier,
      title: other.title,
      statusKey: other.statusKey,
      type: isDependencyType(row.type) ? row.type : 'blockedBy',
    };
  };
  const present = (item: IssueDependency | null): item is IssueDependency =>
    item !== null;
  return {
    blockedBy: outgoing
      .map((row) => map(row, str(row.dependsOnIssueId)))
      .filter(present),
    blocks: incoming.map((row) => map(row, str(row.issueId))).filter(present),
  };
}

/**
 * Removes a dependency of `issue`: `target` is a dependency id, or the id / identifier of the issue depended on
 * (matched with `type`, default blockedBy). Returns what it pointed at, or null when there was none.
 */
export async function deleteDependency(
  tx: Tx,
  deps: Pick<DependencyDeps, 'activity'>,
  issue: IssueV1,
  target: string,
  actor: Actor,
  type: DependencyType = 'blockedBy',
): Promise<{ dependsOnIssueId: string; type: DependencyType } | null> {
  let row = await tx.conn.query
    .selectFrom('issueDependencies')
    .selectAll()
    .where('id', '=', target)
    .where('issueId', '=', issue.id)
    .executeTakeFirst();
  if (!row) {
    const other = await findIssue(tx.conn, target);
    if (other) {
      row = await tx.conn.query
        .selectFrom('issueDependencies')
        .selectAll()
        .where('issueId', '=', issue.id)
        .where('dependsOnIssueId', '=', other.id)
        .where('type', '=', type)
        .executeTakeFirst();
    }
  }
  if (!row) return null;
  await tx.conn.query
    .deleteFrom('issueDependencies')
    .where('id', '=', row.id)
    .execute();
  const dependsOnIssueId = str(row.dependsOnIssueId) ?? '';
  const removedType = isDependencyType(row.type) ? row.type : 'blockedBy';
  await deps.activity.record(tx.conn, {
    issueId: issue.id,
    actor,
    action: 'dependency_removed',
    details: {
      dependencyId: str(row.id),
      dependsOnIssueId,
      type: removedType,
    },
  });
  tx.emit({ type: 'issue.changed', issueId: issue.id });
  tx.emit({ type: 'issue.changed', issueId: dependsOnIssueId });
  return { dependsOnIssueId, type: removedType };
}

export function createDependencyService(
  deps: DependencyDeps,
): DependencyService {
  return {
    async add(actor, issueIdOrKey, input, outer) {
      const type = input?.type ?? 'blockedBy';
      if (!isDependencyType(type))
        throw invalid(
          'INVALID_DEPENDENCY',
          'type must be blockedBy or relatedTo.',
        );
      if (typeof input.dependsOnIssueId !== 'string' || !input.dependsOnIssueId)
        throw invalid('INVALID_DEPENDENCY', 'dependsOnIssueId is required.');
      return deps.tx.run(async (tx) => {
        const viewer = await viewerOf(tx.conn, actor);
        const issue = await requireVisibleIssue(tx.conn, viewer, issueIdOrKey);
        requireEditIssues(viewer);
        let dependsOn: IssueV1;
        try {
          dependsOn = await requireVisibleIssue(
            tx.conn,
            viewer,
            input.dependsOnIssueId,
          );
        } catch {
          throw invalid(
            'INVALID_DEPENDENCY',
            'dependsOnIssueId does not exist.',
          );
        }
        const dependency = await insertDependency(tx, deps, {
          issue,
          dependsOn,
          type,
          actor,
        });
        // A new blocker withdraws queued runs (iteration 2 §K); dispatched and running runs are left alone.
        if (type === 'blockedBy')
          await deps.triggers().onBlockingAdded(tx, issue);
        return dependency;
      }, outer);
    },

    async remove(actor, issueIdOrKey, target, outer) {
      await deps.tx.run(async (tx) => {
        const viewer = await viewerOf(tx.conn, actor);
        const issue = await requireVisibleIssue(tx.conn, viewer, issueIdOrKey);
        requireEditIssues(viewer);
        const removed = await deleteDependency(tx, deps, issue, target, actor);
        if (!removed) throw notFound('Dependency');
        if (removed.type === 'blockedBy') {
          const fresh = (await findIssue(tx.conn, issue.id)) ?? issue;
          await deps
            .triggers()
            .onUnblockCandidate(tx, fresh, removed.dependsOnIssueId);
        }
      }, outer);
    },
  };
}
