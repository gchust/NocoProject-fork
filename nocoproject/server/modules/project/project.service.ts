/**
 * Projects (docs/phase1/iteration-1-contract.md §F): visibility, lead, members, repository resources, issue counts.
 *
 * A project's lead is `leadUserId`; a `projectMembers` row with role `lead` also counts as lead. The creator becomes
 * a member and, unless another lead is named, the lead. Deleting a project unlinks its issues (they keep existing).
 */
import { NP_BUSINESS } from '../shared/access.js';
import type { Actor, ActivityRecorder } from '../shared/activity.js';
import {
  forbid,
  hiddenProjectIds,
  projectAccess,
  requireAction,
  scopeIn,
  requireProjectManager,
  viewerOf,
  type Viewer,
} from '../shared/authz.js';
import type { Conn, Tx, TxRunner } from '../shared/db.js';
import { now, num, str, toJson } from '../shared/db.js';
import { conflict, invalid, notFound } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import type {
  AddProjectMemberRequest,
  CreateProjectRequest,
  CreateProjectResourceRequest,
  ProjectDetail,
  ProjectListItem,
  ProjectMember,
  ProjectResource,
  ProjectV1,
  UpdateProjectRequest,
  UpdateProjectResourceRequest,
} from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import {
  optionalText,
  requiredName,
  validateDate,
} from '../shared/validate.js';
import { isIssuePriority } from '../issue/issue.records.js';
import type { WorkflowService } from '../workflow/workflow.service.js';
import {
  PROJECT_STATUSES,
  findProjectRow,
  mapProject,
  mapResource,
  memberCounts,
  projectMembers,
  projectResources,
} from './project.records.js';

/** Phase 0 name kept for the route module. */
export type CreateProjectInput = CreateProjectRequest;

export interface ProjectService {
  list(actor: Actor): Promise<ProjectListItem[]>;
  get(actor: Actor, id: string): Promise<ProjectDetail>;
  /** NP-183: `outer` joins the caller's transaction (a plan card). */
  create(
    actor: Actor,
    input: CreateProjectRequest,
    outer?: Tx,
  ): Promise<ProjectDetail>;
  update(
    actor: Actor,
    id: string,
    patch: UpdateProjectRequest,
  ): Promise<ProjectDetail>;
  remove(actor: Actor, id: string): Promise<void>;
  addMember(
    actor: Actor,
    id: string,
    input: AddProjectMemberRequest,
  ): Promise<ProjectMember[]>;
  removeMember(
    actor: Actor,
    id: string,
    userId: string,
  ): Promise<ProjectMember[]>;
  addResource(
    actor: Actor,
    id: string,
    input: CreateProjectResourceRequest,
  ): Promise<ProjectResource>;
  updateResource(
    actor: Actor,
    id: string,
    resourceId: string,
    patch: UpdateProjectResourceRequest,
  ): Promise<ProjectResource>;
  removeResource(actor: Actor, id: string, resourceId: string): Promise<void>;
}

export interface ProjectDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly users: UserDirectory;
  readonly activity: ActivityRecorder;
  readonly workflows: WorkflowService;
}

const REPO_URL_PATTERN = /^(https?:\/\/|ssh:\/\/|git@|file:\/\/)\S+$/u;

function validateRepoUrl(value: unknown): string {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url || url.length > 2000 || !REPO_URL_PATTERN.test(url))
    throw invalid(
      'INVALID_URL',
      'url must be a git remote (https://, ssh://, git@ or file://).',
    );
  return url;
}

async function projectValues(
  conn: Conn,
  users: UserDirectory,
  input: UpdateProjectRequest,
): Promise<Record<string, unknown>> {
  const values: Record<string, unknown> = {};
  if (input.name !== undefined) values.name = requiredName(input.name);
  if (input.description !== undefined)
    values.description = optionalText(input.description, 'description');
  if (input.visibility !== undefined) {
    if (input.visibility !== 'everyone' && input.visibility !== 'members')
      throw invalid(
        'INVALID_VISIBILITY',
        'visibility must be everyone or members.',
      );
    values.visibility = input.visibility;
  }
  if (input.status !== undefined) {
    if (!PROJECT_STATUSES.includes(input.status))
      throw invalid('INVALID_STATUS', 'status is not a project status.');
    values.status = input.status;
  }
  if (input.priority !== undefined) {
    if (!isIssuePriority(input.priority))
      throw invalid('INVALID_PRIORITY', 'priority is not valid.');
    values.priority = input.priority;
  }
  if (input.startDate !== undefined)
    values.startDate = validateDate(input.startDate, 'startDate');
  if (input.dueDate !== undefined)
    values.dueDate = validateDate(input.dueDate, 'dueDate');
  if (input.leadUserId !== undefined) {
    if (
      input.leadUserId !== null &&
      (typeof input.leadUserId !== 'string' ||
        !(await users.exists(conn, input.leadUserId)))
    )
      throw invalid('INVALID_LEAD', 'leadUserId does not exist.');
    values.leadUserId = input.leadUserId;
  }
  if (input.workflowId !== undefined) {
    if (
      input.workflowId !== null &&
      !(await conn.query
        .selectFrom('workflowTemplates')
        .select('id')
        .where('id', '=', String(input.workflowId))
        .exists())
    )
      throw invalid('INVALID_WORKFLOW', 'workflowId does not exist.');
    values.workflowId = input.workflowId;
  }
  return values;
}

async function upsertProjectMember(
  tx: Tx,
  ids: IdSource,
  projectId: string,
  userId: string,
  role: 'lead' | 'member',
): Promise<void> {
  const timestamp = now();
  const existing = await tx.conn.query
    .selectFrom('projectMembers')
    .select('id')
    .where('projectId', '=', projectId)
    .where('userId', '=', userId)
    .executeTakeFirst();
  if (existing) {
    await tx.conn.query
      .updateTable('projectMembers')
      .set({ role, updatedAt: timestamp })
      .where('id', '=', existing.id)
      .execute();
    return;
  }
  await tx.conn.query
    .insertInto('projectMembers')
    .values({
      id: ids.next(),
      projectId,
      userId,
      role,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .execute();
}

async function decorate(
  deps: ProjectDeps,
  conn: Conn,
  projects: readonly ProjectV1[],
): Promise<ProjectListItem[]> {
  const ids = projects.map((project) => project.id);
  const leads = await deps.users.names(
    conn,
    projects.map((project) => project.leadUserId),
  );
  const members = await memberCounts(conn, ids);
  const counts = new Map<string, Record<string, number>>();
  if (ids.length > 0) {
    const rows = await conn.query
      .selectFrom('issues')
      .select((eb) => ['projectId', 'statusKey', eb.fn.countAll().as('count')])
      .where('projectId', 'in', ids)
      .where('deletedAt', 'is', null)
      .groupBy(['projectId', 'statusKey'])
      .execute();
    for (const row of rows) {
      const projectId = str(row.projectId) ?? '';
      const byStatus = counts.get(projectId) ?? {};
      byStatus[str(row.statusKey) ?? ''] = num(row.count);
      counts.set(projectId, byStatus);
    }
  }
  const result: ProjectListItem[] = [];
  for (const project of projects) {
    const view = await deps.workflows.forProject(conn, project.id);
    const byStatus = counts.get(project.id) ?? {};
    const entries = Object.entries(byStatus);
    result.push({
      ...project,
      leadName: project.leadUserId
        ? (leads.get(project.leadUserId) ?? null)
        : null,
      memberCount: members.get(project.id) ?? 0,
      issueCounts: {
        total: entries.reduce((sum, [, count]) => sum + count, 0),
        done: entries
          .filter(([key]) => view.isDone(key))
          .reduce((sum, [, count]) => sum + count, 0),
        byStatus,
      },
    });
  }
  return result;
}

async function detail(
  deps: ProjectDeps,
  conn: Conn,
  id: string,
): Promise<ProjectDetail> {
  const project = await findProjectRow(conn, id);
  if (!project) throw notFound('Project');
  const [item] = await decorate(deps, conn, [project]);
  return {
    ...item,
    members: await projectMembers(conn, deps.users, id),
    resources: await projectResources(conn, id),
    workflow: (await deps.workflows.forProject(conn, id)).workflow,
  };
}

async function requireVisible(
  _deps: ProjectDeps,
  conn: Conn,
  viewer: Viewer,
  id: string,
): Promise<void> {
  const access = await projectAccess(conn, viewer, id);
  if (!access.exists || !access.visible) throw notFound('Project');
}

async function managed<T>(
  deps: ProjectDeps,
  actor: Actor,
  id: string,
  fn: (tx: Tx, viewer: Viewer) => Promise<T>,
): Promise<T> {
  return deps.tx.run(async (tx) => {
    const viewer = await viewerOf(tx.conn, actor);
    await requireProjectManager(tx.conn, viewer, id);
    return fn(tx, viewer);
  });
}

async function projectList(
  deps: ProjectDeps,
  ...[actor]: Parameters<ProjectService['list']>
) {
  const conn = deps.tx.read();
  const viewer = await viewerOf(conn, actor);
  const hidden = new Set(await hiddenProjectIds(conn, viewer));
  const rows = await conn.query
    .selectFrom('projects')
    .selectAll()
    .orderBy('name', 'asc')
    .execute();
  return decorate(
    deps,
    conn,
    rows.map(mapProject).filter((project) => !hidden.has(project.id)),
  );
}

async function projectGet(
  deps: ProjectDeps,
  ...[actor, id]: Parameters<ProjectService['get']>
) {
  const conn = deps.tx.read();
  await requireVisible(deps, conn, await viewerOf(conn, actor), id);
  return detail(deps, conn, id);
}

async function projectCreate(
  deps: ProjectDeps,
  ...[actor, input, outer]: Parameters<ProjectService['create']>
) {
  requiredName(input?.name);
  const id = deps.ids.next();
  await deps.tx.run(async (tx) => {
    const viewer = await viewerOf(tx.conn, actor);
    requireAction(
      viewer,
      NP_BUSINESS.projects,
      'create',
      'You may not create projects.',
    );
    const values = await projectValues(tx.conn, deps.users, {
      ...input,
      workflowId: undefined,
    });
    const leadUserId =
      input.leadUserId === undefined
        ? viewer.userId
        : (values.leadUserId as string | null);
    const timestamp = now();
    await tx.conn.query
      .insertInto('projects')
      .values({
        visibility: 'everyone',
        status: 'planned',
        priority: 'none',
        description: null,
        ...values,
        id,
        leadUserId,
        workflowId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .execute();
    await upsertProjectMember(
      tx,
      deps.ids,
      id,
      viewer.userId,
      leadUserId === viewer.userId ? 'lead' : 'member',
    );
    if (leadUserId && leadUserId !== viewer.userId)
      await upsertProjectMember(tx, deps.ids, id, leadUserId, 'lead');
  }, outer);
  return detail(deps, outer?.conn ?? deps.tx.read(), id);
}

async function projectUpdate(
  deps: ProjectDeps,
  ...[actor, id, patch]: Parameters<ProjectService['update']>
) {
  await managed(deps, actor, id, async (tx) => {
    const values = await projectValues(tx.conn, deps.users, patch ?? {});
    if (Object.keys(values).length === 0) return;
    if (values.workflowId !== undefined)
      await deps.workflows.assertProjectCompatible(
        tx.conn,
        id,
        values.workflowId as string | null,
      );
    await tx.conn.query
      .updateTable('projects')
      .set({ ...values, updatedAt: now() })
      .where('id', '=', id)
      .execute();
    if (typeof values.leadUserId === 'string')
      await upsertProjectMember(tx, deps.ids, id, values.leadUserId, 'lead');
    if (values.workflowId !== undefined) deps.workflows.invalidateProject(id);
  });
  return detail(deps, deps.tx.read(), id);
}

async function projectRemove(
  deps: ProjectDeps,
  ...[actor, id]: Parameters<ProjectService['remove']>
) {
  await deps.tx.run(async (tx) => {
    const viewer = await viewerOf(tx.conn, actor);
    if (!(await findProjectRow(tx.conn, id))) throw notFound('Project');
    if (scopeIn(viewer, NP_BUSINESS.projects, 'delete') !== 'all')
      forbid('Only an owner or admin may delete a project.');
    const issues = await tx.conn.query
      .selectFrom('issues')
      .select(['id', 'revision'])
      .where('projectId', '=', id)
      .execute();
    const timestamp = now();
    for (const issue of issues) {
      const issueId = str(issue.id) ?? '';
      await tx.conn.query
        .updateTable('issues')
        .set({
          projectId: null,
          revision: num(issue.revision, 1) + 1,
          updatedAt: timestamp,
        })
        .where('id', '=', issueId)
        .execute();
      await deps.activity.record(tx.conn, {
        issueId,
        actor,
        action: 'project_changed',
        details: { from: id, to: null, reason: 'projectDeleted' },
      });
      tx.emit({ type: 'issue.changed', issueId });
    }
    await tx.conn.query
      .deleteFrom('projectMembers')
      .where('projectId', '=', id)
      .execute();
    await tx.conn.query
      .deleteFrom('projectResources')
      .where('projectId', '=', id)
      .execute();
    await tx.conn.query.deleteFrom('projects').where('id', '=', id).execute();
    deps.workflows.invalidateProject(id);
  });
}

async function projectAddMember(
  deps: ProjectDeps,
  ...[actor, id, input]: Parameters<ProjectService['addMember']>
) {
  const role = input?.role ?? 'member';
  if (role !== 'lead' && role !== 'member')
    throw invalid('INVALID_ROLE', 'role must be lead or member.');
  await managed(deps, actor, id, async (tx) => {
    if (
      typeof input.userId !== 'string' ||
      !(await deps.users.exists(tx.conn, input.userId))
    )
      throw invalid('INVALID_USER', 'userId does not exist.');
    await upsertProjectMember(tx, deps.ids, id, input.userId, role);
  });
  return projectMembers(deps.tx.read(), deps.users, id);
}

async function projectRemoveMember(
  deps: ProjectDeps,
  ...[actor, id, userId]: Parameters<ProjectService['removeMember']>
) {
  await managed(deps, actor, id, async (tx) => {
    const project = await findProjectRow(tx.conn, id);
    if (project?.leadUserId === userId)
      throw conflict(
        'LEAD_MEMBER',
        'Choose another project lead before removing this member.',
      );
    await tx.conn.query
      .deleteFrom('projectMembers')
      .where('projectId', '=', id)
      .where('userId', '=', userId)
      .execute();
  });
  return projectMembers(deps.tx.read(), deps.users, id);
}

async function projectAddResource(
  deps: ProjectDeps,
  ...[actor, id, input]: Parameters<ProjectService['addResource']>
) {
  if (input?.type !== 'gitRepo')
    throw invalid('INVALID_RESOURCE', 'type must be gitRepo.');
  const url = validateRepoUrl(input.url);
  const resourceId = deps.ids.next();
  await managed(deps, actor, id, async (tx) => {
    const last = await tx.conn.query
      .selectFrom('projectResources')
      .select((eb) => [eb.fn.max('position').as('position')])
      .where('projectId', '=', id)
      .executeTakeFirst();
    const timestamp = now();
    await tx.conn.query
      .insertInto('projectResources')
      .values({
        id: resourceId,
        projectId: id,
        type: 'gitRepo',
        ref: toJson({
          url,
          defaultRef: optionalText(input.defaultRef, 'defaultRef', 255),
        }),
        label: optionalText(input.label, 'label', 255),
        position:
          last?.position === null || last?.position === undefined
            ? 0
            : num(last.position) + 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .execute();
  });
  const created = (await projectResources(deps.tx.read(), id)).find(
    (resource) => resource.id === resourceId,
  );
  if (!created) throw notFound('Resource');
  return created;
}

async function projectUpdateResource(
  deps: ProjectDeps,
  ...[actor, id, resourceId, patch]: Parameters<
    ProjectService['updateResource']
  >
) {
  return managed(deps, actor, id, async (tx) => {
    const row = await tx.conn.query
      .selectFrom('projectResources')
      .selectAll()
      .where('id', '=', resourceId)
      .where('projectId', '=', id)
      .executeTakeFirst();
    if (!row) throw notFound('Resource');
    const current = mapResource(row);
    const values: Record<string, unknown> = { updatedAt: now() };
    if (patch?.url !== undefined || patch?.defaultRef !== undefined) {
      values.ref = toJson({
        url: patch.url === undefined ? current.url : validateRepoUrl(patch.url),
        defaultRef:
          patch.defaultRef === undefined
            ? current.defaultRef
            : optionalText(patch.defaultRef, 'defaultRef', 255),
      });
    }
    if (patch?.label !== undefined)
      values.label = optionalText(patch.label, 'label', 255);
    if (patch?.position !== undefined) {
      if (!Number.isInteger(patch.position))
        throw invalid('INVALID_POSITION', 'position must be an integer.');
      values.position = patch.position;
    }
    await tx.conn.query
      .updateTable('projectResources')
      .set(values)
      .where('id', '=', resourceId)
      .execute();
    const updated = await tx.conn.query
      .selectFrom('projectResources')
      .selectAll()
      .where('id', '=', resourceId)
      .executeTakeFirst();
    return mapResource(updated ?? row);
  });
}

async function projectRemoveResource(
  deps: ProjectDeps,
  ...[actor, id, resourceId]: Parameters<ProjectService['removeResource']>
) {
  await managed(deps, actor, id, async (tx) => {
    const result = await tx.conn.query
      .deleteFrom('projectResources')
      .where('id', '=', resourceId)
      .where('projectId', '=', id)
      .execute();
    if ((result.deletedCount ?? 0) === 0) throw notFound('Resource');
  });
}

export function createProjectService(deps: ProjectDeps): ProjectService {
  return {
    list: (...args) => projectList(deps, ...args),
    get: (...args) => projectGet(deps, ...args),
    create: (...args) => projectCreate(deps, ...args),
    update: (...args) => projectUpdate(deps, ...args),
    remove: (...args) => projectRemove(deps, ...args),
    addMember: (...args) => projectAddMember(deps, ...args),
    removeMember: (...args) => projectRemoveMember(deps, ...args),
    addResource: (...args) => projectAddResource(deps, ...args),
    updateResource: (...args) => projectUpdateResource(deps, ...args),
    removeResource: (...args) => projectRemoveResource(deps, ...args),
  };
}
