/**
 * Writing workflow template definitions (NP-77 方案 §4): the shared steps behind accepting a proposal and the admin
 * `PUT /np/workflows/:id`, plus the revision history.
 *
 * - `checkDefinition` runs the §5 validation (`workflow.validate.ts`, with the current definition as `base` for an
 *   edit and existing unarchived agents) and, for an edit, the compatibility check: removing a status some issue of
 *   a project on this template is in is 409 `WORKFLOW_STATUS_CONFLICT` with the count per status and project.
 * - `applyDefinition` replaces a template's definition under an optimistic lock on `revision` (false when the
 *   template moved on), writes the revision snapshot, and on the first edit a baseline snapshot of the definition
 *   it replaces, so the history always holds every definition that was in effect.
 * - `insertTemplate` creates a copy (revision 1, never system or default) with its snapshot.
 *
 * The caller invalidates the workflow cache after its transaction commits.
 */
import type { Actor } from '../shared/activity.js';
import type { Conn } from '../shared/db.js';
import { fromJson, iso, now, num, str, toJson } from '../shared/db.js';
import { NpError } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import type {
  ActorType,
  WorkflowDefinitionV5,
  WorkflowRevision,
  WorkflowStatusConflictDetails,
} from '../shared/protocol.js';
import { ERROR_WORKFLOW_STATUS_CONFLICT } from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import { agentNames } from '../run/run.queries.js';
import { mapWorkflow } from './workflow.service.js';
import { assertValidWorkflow } from './workflow.validate.js';

export type TemplateRow = Record<string, unknown>;

export async function findTemplateRow(
  conn: Conn,
  id: string,
): Promise<TemplateRow | undefined> {
  return conn.query
    .selectFrom('workflowTemplates')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
}

async function existingAgents(
  conn: Conn,
  ids: readonly string[],
): Promise<ReadonlySet<string>> {
  if (ids.length === 0) return new Set();
  const rows = await conn.query
    .selectFrom('agents')
    .select('id')
    .where('id', 'in', [...ids])
    .where('archivedAt', 'is', null)
    .execute();
  return new Set(rows.map((row) => str(row.id) ?? ''));
}

/** Projects on a template: those naming it, plus those without a template when it is the default. */
async function projectsOf(
  conn: Conn,
  template: TemplateRow,
): Promise<Map<string, string>> {
  let select = conn.query.selectFrom('projects').select(['id', 'name']);
  select = template.isDefault
    ? select.where((eb) =>
        eb.or([
          eb('workflowId', '=', str(template.id)),
          eb('workflowId', 'is', null),
        ]),
      )
    : select.where('workflowId', '=', str(template.id));
  const rows = await select.execute();
  return new Map(rows.map((row) => [str(row.id) ?? '', str(row.name) ?? '']));
}

export async function projectCountOf(
  conn: Conn,
  template: TemplateRow,
): Promise<number> {
  return (await projectsOf(conn, template)).size;
}

/** 409 `WORKFLOW_STATUS_CONFLICT` when issues of the template's projects are in a status the edit removes. */
async function assertNoRemovedStatusInUse(
  conn: Conn,
  template: TemplateRow,
  removed: readonly string[],
): Promise<void> {
  if (removed.length === 0) return;
  const projects = await projectsOf(conn, template);
  if (projects.size === 0) return;
  const rows = await conn.query
    .selectFrom('issues')
    .select((eb) => ['statusKey', 'projectId', eb.fn.countAll().as('count')])
    .where('projectId', 'in', Array.from(projects.keys()))
    .where('statusKey', 'in', [...removed])
    .where('deletedAt', 'is', null)
    .groupBy(['statusKey', 'projectId'])
    .execute();
  if (rows.length === 0) return;
  const details: WorkflowStatusConflictDetails = {
    statuses: removed
      .map((statusKey) => {
        const matching = rows.filter((row) => str(row.statusKey) === statusKey);
        const list = matching.map((row) => ({
          projectId: str(row.projectId) ?? '',
          projectName: projects.get(str(row.projectId) ?? '') ?? '',
          count: num(row.count),
        }));
        return {
          statusKey,
          total: list.reduce((sum, item) => sum + item.count, 0),
          projects: list,
        };
      })
      .filter((entry) => entry.total > 0),
  };
  throw new NpError(
    'conflict',
    ERROR_WORKFLOW_STATUS_CONFLICT,
    `Issues are still in statuses this change removes: ${details.statuses.map((entry) => `${entry.statusKey} (${entry.total})`).join(', ')}. Move them first, or copy the template.`,
    details as unknown as Record<string, unknown>,
  );
}

/**
 * Validates `input` as the next definition of `template` (an edit) or of a new copy (`template` null): 400
 * `INVALID_WORKFLOW`, or 409 `WORKFLOW_STATUS_CONFLICT` for an edit removing a status in use.
 */
export async function checkDefinition(
  conn: Conn,
  input: unknown,
  template: TemplateRow | null,
): Promise<WorkflowDefinitionV5> {
  const base = template ? mapWorkflow(template).definition : null;
  const definition = await assertValidWorkflow(input, {
    base,
    agentExists: (ids) => existingAgents(conn, ids),
  });
  if (template && base) {
    const keys = new Set(definition.statuses.map((status) => status.key));
    await assertNoRemovedStatusInUse(
      conn,
      template,
      base.statuses.map((status) => status.key).filter((key) => !keys.has(key)),
    );
  }
  return definition;
}

interface SnapshotInput {
  readonly templateId: string;
  readonly revision: number;
  readonly name: string;
  readonly definition: WorkflowDefinitionV5;
  readonly proposalId: string | null;
  readonly note: string | null;
  readonly actor: Actor;
}

async function insertSnapshot(
  conn: Conn,
  ids: IdSource,
  input: SnapshotInput,
): Promise<void> {
  await conn.query
    .insertInto('workflowTemplateRevisions')
    .values({
      id: ids.next(),
      templateId: input.templateId,
      revision: input.revision,
      name: input.name,
      definition: toJson(input.definition),
      proposalId: input.proposalId,
      note: input.note,
      createdByType: input.actor.type,
      createdById: input.actor.id,
      createdAt: now(),
    })
    .execute();
}

export interface ApplyInput {
  readonly template: TemplateRow;
  readonly baseRevision: number;
  readonly definition: WorkflowDefinitionV5;
  /** null keeps the name. */
  readonly name: string | null;
  readonly proposalId: string | null;
  readonly note: string | null;
  /** Who the snapshot is credited to (the proposing agent, or the admin). */
  readonly author: Actor;
}

/** The new revision, or null when the template is no longer at `baseRevision`. */
export async function applyDefinition(
  conn: Conn,
  ids: IdSource,
  input: ApplyInput,
): Promise<number | null> {
  const current = mapWorkflow(input.template);
  if (current.revision !== input.baseRevision) return null;
  const revision = input.baseRevision + 1;
  const name = input.name ?? current.name;
  const result = await conn.query
    .updateTable('workflowTemplates')
    .set({
      definition: toJson(input.definition),
      name,
      revision,
      updatedAt: now(),
    })
    .where('id', '=', current.id)
    .where('revision', '=', input.baseRevision)
    .execute();
  if (num(result.updatedCount) === 0) return null;
  const baseline = await conn.query
    .selectFrom('workflowTemplateRevisions')
    .select('id')
    .where('templateId', '=', current.id)
    .where('revision', '=', input.baseRevision)
    .exists();
  if (!baseline)
    await insertSnapshot(conn, ids, {
      templateId: current.id,
      revision: input.baseRevision,
      name: current.name,
      definition: current.definition,
      proposalId: null,
      note: null,
      actor: { type: 'system', id: null },
    });
  await insertSnapshot(conn, ids, {
    templateId: current.id,
    revision,
    name,
    definition: input.definition,
    proposalId: input.proposalId,
    note: input.note,
    actor: input.author,
  });
  return revision;
}

/** A new (copied) template at revision 1: never system, never the default. Returns its id. */
export async function insertTemplate(
  conn: Conn,
  ids: IdSource,
  input: Omit<ApplyInput, 'template' | 'baseRevision' | 'name'> & {
    readonly name: string;
  },
): Promise<string> {
  const id = ids.next();
  const timestamp = now();
  await conn.query
    .insertInto('workflowTemplates')
    .values({
      id,
      name: input.name,
      isDefault: false,
      isSystem: false,
      revision: 1,
      definition: toJson(input.definition),
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .execute();
  await insertSnapshot(conn, ids, {
    templateId: id,
    revision: 1,
    name: input.name,
    definition: input.definition,
    proposalId: input.proposalId,
    note: input.note,
    actor: input.author,
  });
  return id;
}

/** `GET /np/workflows/:id/revisions`: newest first. */
export async function listRevisions(
  conn: Conn,
  users: UserDirectory,
  templateId: string,
): Promise<WorkflowRevision[]> {
  const rows = await conn.query
    .selectFrom('workflowTemplateRevisions')
    .selectAll()
    .where('templateId', '=', templateId)
    .orderBy('revision', 'desc')
    .execute();
  const userIds = rows
    .filter((row) => row.createdByType === 'user')
    .map((row) => str(row.createdById));
  const agentIds = rows
    .filter((row) => row.createdByType === 'agent')
    .map((row) => str(row.createdById));
  const userNames = await users.names(conn, userIds);
  const agents = await agentNames(conn, agentIds);
  return rows.map((row) => {
    const type = (str(row.createdByType) ?? 'system') as ActorType;
    const by = str(row.createdById);
    return {
      revision: num(row.revision, 1),
      name: str(row.name) ?? '',
      definition: fromJson<WorkflowDefinitionV5>(
        row.definition,
      ) as WorkflowDefinitionV5,
      proposalId: str(row.proposalId),
      note: str(row.note),
      createdByType: type,
      createdById: by,
      createdByName: by
        ? ((type === 'agent' ? agents.get(by) : userNames.get(by)) ?? null)
        : null,
      createdAt: iso(row.createdAt),
    };
  });
}
