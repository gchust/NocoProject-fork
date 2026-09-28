/**
 * Row mapping and read helpers for projects, their members and their resources.
 */
import type { Conn } from '../shared/db.js';
import { fromJson, iso, num, str, unique } from '../shared/db.js';
import type {
  ClaimedProject,
  ProjectMember,
  ProjectResource,
  ProjectStatus,
  ProjectV1,
} from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import { isIssuePriority } from '../issue/issue.records.js';

export const PROJECT_STATUSES: readonly ProjectStatus[] = [
  'planned',
  'in_progress',
  'paused',
  'completed',
  'cancelled',
];

export function mapProject(row: Record<string, unknown>): ProjectV1 {
  const status = str(row.status);
  return {
    id: str(row.id) ?? '',
    name: str(row.name) ?? '',
    description: str(row.description),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    visibility: row.visibility === 'members' ? 'members' : 'everyone',
    leadUserId: str(row.leadUserId),
    status: (PROJECT_STATUSES as readonly (string | null)[]).includes(status)
      ? (status as ProjectStatus)
      : 'planned',
    priority: isIssuePriority(row.priority) ? row.priority : 'none',
    startDate: str(row.startDate),
    dueDate: str(row.dueDate),
    workflowId: str(row.workflowId),
  };
}

interface ResourceRef {
  readonly url?: unknown;
  readonly defaultRef?: unknown;
}

export function mapResource(row: Record<string, unknown>): ProjectResource {
  const ref = fromJson<ResourceRef>(row.ref) ?? {};
  return {
    id: str(row.id) ?? '',
    projectId: str(row.projectId) ?? '',
    type: 'gitRepo',
    url: typeof ref.url === 'string' ? ref.url : '',
    defaultRef: typeof ref.defaultRef === 'string' ? ref.defaultRef : null,
    label: str(row.label),
    position: num(row.position),
  };
}

export async function findProjectRow(
  conn: Conn,
  projectId: string,
): Promise<ProjectV1 | null> {
  const row = await conn.query
    .selectFrom('projects')
    .selectAll()
    .where('id', '=', projectId)
    .executeTakeFirst();
  return row ? mapProject(row) : null;
}

export async function projectResources(
  conn: Conn,
  projectId: string,
): Promise<ProjectResource[]> {
  const rows = await conn.query
    .selectFrom('projectResources')
    .selectAll()
    .where('projectId', '=', projectId)
    .orderBy('position', 'asc')
    .orderBy('createdAt', 'asc')
    .execute();
  return rows.map(mapResource);
}

export async function projectMembers(
  conn: Conn,
  users: UserDirectory,
  projectId: string,
): Promise<ProjectMember[]> {
  const rows = await conn.query
    .selectFrom('projectMembers')
    .select(['userId', 'role'])
    .where('projectId', '=', projectId)
    .orderBy('createdAt', 'asc')
    .execute();
  const names = await users.names(
    conn,
    rows.map((row) => str(row.userId)),
  );
  return rows.map((row) => {
    const userId = str(row.userId) ?? '';
    return {
      userId,
      name: names.get(userId) ?? userId,
      role: row.role === 'lead' ? 'lead' : 'member',
    };
  });
}

/** Member counts per project. */
export async function memberCounts(
  conn: Conn,
  projectIds: readonly string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const wanted = unique(projectIds);
  if (wanted.length === 0) return result;
  const rows = await conn.query
    .selectFrom('projectMembers')
    .select((eb) => ['projectId', eb.fn.countAll().as('count')])
    .where('projectId', 'in', wanted)
    .groupBy('projectId')
    .execute();
  for (const row of rows) result.set(str(row.projectId) ?? '', num(row.count));
  return result;
}

/** The project block of a claim payload and of the agent context (contract §I). */
export async function claimedProject(
  conn: Conn,
  projectId: string | null,
): Promise<ClaimedProject | null> {
  if (!projectId) return null;
  const project = await findProjectRow(conn, projectId);
  if (!project) return null;
  const resources = await projectResources(conn, projectId);
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    resources: resources.map((resource) => ({
      type: resource.type,
      url: resource.url,
      defaultRef: resource.defaultRef,
    })),
  };
}
