/**
 * Application-level authorization rules (docs/phase1/iteration-1-contract.md §B). Every browser route reaches these
 * through its service; the client only hides what they would refuse.
 *
 * | Action                                              | Allowed                                                  |
 * | --------------------------------------------------- | -------------------------------------------------------- |
 * | See an issue                                        | no project, project visibility everyone, project member, owner/admin; a project manager conversation only its owner |
 * | Create, comment, edit fields, non-terminal status   | members who can see the issue                            |
 * | Change the owner                                    | current owner, project lead, owner/admin                 |
 * | Write a terminal status (done / cancelled)          | issue owner, project lead, owner/admin                   |
 * | Merge a linked pull request (NP-85)                 | issue owner, project lead, owner/admin; never a run token |
 * | Assign, mention, accept a proposal for an agent     | whoever may invoke the agent (see `canInvokeAgent`)      |
 * | Create an agent                                     | on an own runtime or a public runtime                    |
 * | Edit an agent, its access and delegation lists      | agent owner, owner/admin                                 |
 * | Create a project                                    | any member                                               |
 * | Edit a project, its members and resources           | project lead, owner/admin                                |
 * | Delete a project                                    | owner/admin                                              |
 * | Change a runtime's visibility                       | runtime owner                                            |
 * | Member roles                                        | see member.service.ts                                    |
 *
 * Refusals are `403 FORBIDDEN`; an issue the caller cannot see is `404 NOT_FOUND`, so its existence does not leak.
 * Agents acting through a run token are not members: their scope is enforced by the agent API (own run's issue).
 */
import type { Actor } from './activity.js';
import type { Conn } from './db.js';
import { isoOrNull, str, unique } from './db.js';
import { forbidden, notFound } from './errors.js';
import type { ApproverRole, Issue, IssueV4, MemberRole } from './protocol.js';
import { findIssue } from '../issue/issue.records.js';

export interface Viewer {
  readonly userId: string;
  readonly role: MemberRole;
}

export function forbid(message: string): never {
  throw forbidden('FORBIDDEN', message);
}

export function isMemberRole(value: unknown): value is MemberRole {
  return value === 'owner' || value === 'admin' || value === 'member';
}

/** The caller as a member. A user without a members row (not bootstrapped yet) counts as a plain member. */
export async function viewerOf(conn: Conn, actor: Actor): Promise<Viewer> {
  if (actor.type !== 'user' || !actor.id)
    forbid('Only signed-in members may do this.');
  const row = await conn.query
    .selectFrom('members')
    .select('role')
    .where('userId', '=', actor.id)
    .executeTakeFirst();
  return {
    userId: actor.id,
    role: isMemberRole(row?.role) ? row.role : 'member',
  };
}

export function isAdmin(viewer: Viewer): boolean {
  return viewer.role === 'owner' || viewer.role === 'admin';
}

export interface ProjectAccess {
  readonly exists: boolean;
  readonly visible: boolean;
  /** leadUserId, or a projectMembers row with role lead */
  readonly lead: boolean;
  readonly member: boolean;
}

export async function projectAccess(
  conn: Conn,
  viewer: Viewer,
  projectId: string,
): Promise<ProjectAccess> {
  const project = await conn.query
    .selectFrom('projects')
    .select(['visibility', 'leadUserId'])
    .where('id', '=', projectId)
    .executeTakeFirst();
  if (!project)
    return { exists: false, visible: false, lead: false, member: false };
  const membership = await conn.query
    .selectFrom('projectMembers')
    .select('role')
    .where('projectId', '=', projectId)
    .where('userId', '=', viewer.userId)
    .executeTakeFirst();
  const lead =
    str(project.leadUserId) === viewer.userId || membership?.role === 'lead';
  const member = lead || !!membership;
  return {
    exists: true,
    lead,
    member,
    visible: project.visibility !== 'members' || member || isAdmin(viewer),
  };
}

/** Ids of the private projects the viewer may not see (empty for owner/admin). */
export async function hiddenProjectIds(
  conn: Conn,
  viewer: Viewer,
): Promise<string[]> {
  if (isAdmin(viewer)) return [];
  const privateProjects = await conn.query
    .selectFrom('projects')
    .select(['id', 'leadUserId'])
    .where('visibility', '=', 'members')
    .execute();
  if (privateProjects.length === 0) return [];
  const memberships = await conn.query
    .selectFrom('projectMembers')
    .select('projectId')
    .where('userId', '=', viewer.userId)
    .execute();
  const mine = new Set(memberships.map((row) => str(row.projectId)));
  return privateProjects
    .filter(
      (row) => !mine.has(str(row.id)) && str(row.leadUserId) !== viewer.userId,
    )
    .map((row) => str(row.id) ?? '');
}

export async function canSeeProject(
  conn: Conn,
  viewer: Viewer,
  projectId: string | null,
): Promise<boolean> {
  if (!projectId) return true;
  return (await projectAccess(conn, viewer, projectId)).visible;
}

/**
 * Iteration 4: a project manager conversation (`originType = 'pm'`) is private to its owner — the manager answers
 * with what that member may see, so nobody else may read the answers.
 */
export async function canSeeIssue(
  conn: Conn,
  viewer: Viewer,
  issue: Pick<Issue, 'projectId'> & {
    readonly originType?: string;
    readonly ownerUserId?: string | null;
  },
): Promise<boolean> {
  if (issue.originType === 'pm' && issue.ownerUserId !== viewer.userId)
    return false;
  return canSeeProject(conn, viewer, issue.projectId);
}

/** The issue, or 404 when it does not exist or the viewer cannot see it. */
export async function requireVisibleIssue(
  conn: Conn,
  viewer: Viewer,
  idOrKey: string,
): Promise<IssueV4> {
  const issue = await findIssue(conn, idOrKey);
  if (!issue || !(await canSeeIssue(conn, viewer, issue)))
    throw notFound('Issue');
  return issue;
}

async function isProjectLead(
  conn: Conn,
  viewer: Viewer,
  projectId: string | null,
): Promise<boolean> {
  if (!projectId) return false;
  return (await projectAccess(conn, viewer, projectId)).lead;
}

/** Current owner, project lead, owner/admin. */
export async function canChangeOwner(
  conn: Conn,
  viewer: Viewer,
  issue: Pick<Issue, 'ownerUserId' | 'projectId'>,
): Promise<boolean> {
  if (isAdmin(viewer) || issue.ownerUserId === viewer.userId) return true;
  return isProjectLead(conn, viewer, issue.projectId);
}

/** Issue owner, project lead, owner/admin may write a terminal status. */
export async function canWriteTerminal(
  conn: Conn,
  viewer: Viewer,
  issue: Pick<Issue, 'ownerUserId' | 'projectId'>,
): Promise<boolean> {
  return canChangeOwner(conn, viewer, issue);
}

/** Merging a PR completes the issue, so it follows the terminal-status rule: issue owner, project lead, owner/admin. */
export async function canMergePullRequest(
  conn: Conn,
  viewer: Viewer,
  issue: Pick<Issue, 'ownerUserId' | 'projectId'>,
): Promise<boolean> {
  return canWriteTerminal(conn, viewer, issue);
}

/** Project lead or owner/admin. */
export async function requireProjectManager(
  conn: Conn,
  viewer: Viewer,
  projectId: string,
): Promise<void> {
  const access = await projectAccess(conn, viewer, projectId);
  if (!access.exists || !access.visible) throw notFound('Project');
  if (!access.lead && !isAdmin(viewer))
    forbid('Only the project lead or an owner/admin may change this project.');
}

export interface AgentAccessRow {
  readonly id: string;
  readonly ownerUserId: string;
  readonly access: string;
  readonly archivedAt: string | null;
}

/**
 * ownerOnly → the agent owner; specificUsers → the owner or a user on its access list; everyone → every member.
 * Archived agents cannot be invoked.
 */
export async function canInvokeAgent(
  conn: Conn,
  userId: string,
  agent: AgentAccessRow,
): Promise<boolean> {
  if (agent.archivedAt) return false;
  if (agent.ownerUserId === userId || agent.access === 'everyone') return true;
  if (agent.access !== 'specificUsers') return false;
  return conn.query
    .selectFrom('agentAccessGrants')
    .select('id')
    .where('agentId', '=', agent.id)
    .where('userId', '=', userId)
    .exists();
}

/** Ids among `agentIds` the user may invoke (one query per kind, for lists). */
export async function invokableAgentIds(
  conn: Conn,
  userId: string,
  agents: readonly AgentAccessRow[],
): Promise<Set<string>> {
  const result = new Set<string>();
  const specific = agents.filter(
    (agent) =>
      !agent.archivedAt &&
      agent.ownerUserId !== userId &&
      agent.access === 'specificUsers',
  );
  const granted = specific.length
    ? await conn.query
        .selectFrom('agentAccessGrants')
        .select('agentId')
        .where('userId', '=', userId)
        .where('agentId', 'in', unique(specific.map((agent) => agent.id)))
        .execute()
    : [];
  const grantedIds = new Set(granted.map((row) => str(row.agentId)));
  for (const agent of agents) {
    if (agent.archivedAt) continue;
    if (
      agent.ownerUserId === userId ||
      agent.access === 'everyone' ||
      grantedIds.has(agent.id)
    )
      result.add(agent.id);
  }
  return result;
}

export async function loadAgentAccess(
  conn: Conn,
  agentId: string,
): Promise<AgentAccessRow | null> {
  const row = await conn.query
    .selectFrom('agents')
    .select(['id', 'ownerUserId', 'access', 'archivedAt'])
    .where('id', '=', agentId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: str(row.id) ?? '',
    ownerUserId: str(row.ownerUserId) ?? '',
    access: str(row.access) ?? 'ownerOnly',
    archivedAt: isoOrNull(row.archivedAt),
  };
}

/** 403 unless the user may invoke the agent. A missing agent is left to the caller's own validation. */
export async function requireInvokeAgent(
  conn: Conn,
  userId: string,
  agentId: string,
): Promise<void> {
  const agent = await loadAgentAccess(conn, agentId);
  if (!agent) return;
  if (!(await canInvokeAgent(conn, userId, agent)))
    forbid('You do not have access to this agent.');
}

export function canEditAgent(
  viewer: Viewer,
  agent: { readonly ownerUserId: string },
): boolean {
  return isAdmin(viewer) || agent.ownerUserId === viewer.userId;
}

/** Owner and admin members (for approvals whose approvers include `admin`). */
export async function adminUserIds(conn: Conn): Promise<string[]> {
  const rows = await conn.query
    .selectFrom('members')
    .select('userId')
    .where('role', 'in', ['owner', 'admin'])
    .execute();
  return unique(rows.map((row) => str(row.userId)));
}

/**
 * Approver user ids for an issue (iteration 2 §D): `owner` → the issue owner; `projectLead` → the project lead
 * (skipped without a project or lead); `admin` → every owner/admin member.
 */
export async function resolveApproverIds(
  conn: Conn,
  issue: Pick<Issue, 'ownerUserId' | 'projectId'>,
  roles: readonly ApproverRole[],
): Promise<string[]> {
  const result: (string | null)[] = [];
  if (roles.includes('owner')) result.push(issue.ownerUserId);
  if (roles.includes('projectLead') && issue.projectId) {
    const project = await conn.query
      .selectFrom('projects')
      .select('leadUserId')
      .where('id', '=', issue.projectId)
      .executeTakeFirst();
    result.push(project ? str(project.leadUserId) : null);
  }
  if (roles.includes('admin')) result.push(...(await adminUserIds(conn)));
  return unique(result);
}
