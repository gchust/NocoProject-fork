/**
 * Application-level authorization rules (docs/phase1/iteration-1-contract.md §B). Every browser route reaches these
 * through its service; the client only hides what they would refuse.
 *
 * | Action                                              | Allowed                                                  |
 * | --------------------------------------------------- | -------------------------------------------------------- |
 * | See an issue                                        | `issues/view`: all, or no project / a project the viewer may see; a project manager conversation only its owner |
 * | Create, comment, edit fields, non-terminal status   | `issues/edit` (any scope) on an issue the viewer can see |
 * | Change the owner                                    | `issues/change-owner`: all, or the current owner / project lead |
 * | Write a terminal status (done / cancelled)          | `issues/close`: all, or the issue owner / project lead   |
 * | Merge a linked pull request (NP-85)                 | `pullRequests/merge`: as close; never a run token        |
 * | Assign, mention, accept a proposal for an agent     | whoever may invoke the agent (see `canInvokeAgent`)      |
 * | Create an agent                                     | on an own runtime or a public runtime                    |
 * | Edit an agent, its access and delegation lists      | `agents/manage`: all, or the agent owner                 |
 * | Create a project                                    | `projects/create`                                        |
 * | See a project                                       | `projects/view`: all, or public / joined                 |
 * | Edit a project, its members and resources           | `projects/manage`: all, or the project lead              |
 * | Delete a project                                    | `projects/delete` at all                                 |
 * | Change a runtime's visibility                       | runtime owner                                            |
 * | Member roles                                        | see member.service.ts                                    |
 * | Workspace settings, members, workflows, labels, GitHub | the settings items of `access.ts` (`canUseSetting`)   |
 *
 * The business actions and their three scopes are `access.ts` `NP_BUSINESS` (NP-153): "all" comes from the built-in
 * authorization (`allRecords`), "related" is implemented here by NocoProject's own SQL, "none" refuses. A caller
 * without `Actor.access` (internal actors) is always "related".
 * Refusals are `403 FORBIDDEN`; an issue the caller cannot see is `404 NOT_FOUND`, so its existence does not leak.
 * Agents acting through a run token are not members: their scope is enforced by the agent API (own run's issue).
 */
import {
  NP_BUSINESS,
  NP_SETTINGS,
  RELATED_SCOPES,
  type NpScope,
  type NpScopes,
  type NpSettingsAction,
  type NpSettingsId,
} from './access.js';
import {
  ADMIN_APPROVER_CHECK,
  allowsOwn,
  deciderUserIds,
  requireAction,
  scopeIn,
  type AccessHolders,
} from './authz.scopes.js';
import type { Actor } from './activity.js';
import type { Conn } from './db.js';
import { isoOrNull, str, unique } from './db.js';
import { forbidden, notFound } from './errors.js';
import type { ApproverRole, Issue, IssueV4, MemberRole } from './protocol.js';
import { findIssue } from '../issue/issue.records.js';

export {
  ADMIN_APPROVER_CHECK,
  allowsOwn,
  deciderUserIds,
  requireAction,
  scopeIn,
  scopeOf,
  type AccessHolders,
} from './authz.scopes.js';

export interface Viewer {
  readonly userId: string;
  /** Only for the owner rules of `member.service.ts`; business rules read `scopes`. */
  readonly role: MemberRole;
  readonly scopes: NpScopes;
}

export function forbid(message: string): never {
  throw forbidden('FORBIDDEN', message);
}

export function isMemberRole(value: unknown): value is MemberRole {
  return value === 'owner' || value === 'admin' || value === 'member';
}

/**
 * The caller as a member. With `actor.access` (every browser request, NP-117) the role and the business scopes come
 * from the built-in authorization; otherwise (internal actors, such as the project manager's asking member) the role
 * is the `members.role` projection and every business scope is "related". A user without a members row counts as a
 * plain member.
 */
export async function viewerOf(conn: Conn, actor: Actor): Promise<Viewer> {
  if (actor.type !== 'user' || !actor.id)
    forbid('Only signed-in members may do this.');
  if (actor.access)
    return {
      userId: actor.id,
      role: await actor.access.role(conn),
      scopes: await actor.access.scopes(),
    };
  const row = await conn.query
    .selectFrom('members')
    .select('role')
    .where('userId', '=', actor.id)
    .executeTakeFirst();
  return {
    userId: actor.id,
    role: isMemberRole(row?.role) ? row.role : 'member',
    scopes: RELATED_SCOPES,
  };
}

/**
 * Whether the signed-in `actor` holds `action` on a NocoProject settings item (`shared/access.ts`). A request with the
 * built-in authorization asks it; without one (internal actors) only the member defaults apply: every tab but GitHub
 * is readable, nothing changes. Call it with a read connection before opening the write's transaction
 * (`ActorAccess.can`).
 */
export async function canUseSetting(
  conn: Conn,
  actor: Actor,
  setting: NpSettingsId,
  action: NpSettingsAction,
): Promise<boolean> {
  if (actor.type !== 'user' || !actor.id) return false;
  if (actor.access)
    return actor.access.can({
      resource: { type: 'settings', id: setting },
      action,
    });
  await viewerOf(conn, actor);
  return action === 'read' && setting !== NP_SETTINGS.github;
}

/** 403 `FORBIDDEN` unless `canUseSetting`. */
export async function requireSetting(
  conn: Conn,
  actor: Actor,
  setting: NpSettingsId,
  action: NpSettingsAction,
  message: string,
): Promise<void> {
  if (!(await canUseSetting(conn, actor, setting, action))) forbid(message);
}

export interface ProjectAccess {
  readonly exists: boolean;
  readonly visible: boolean;
  /** leadUserId, or a projectMembers row with role lead */
  readonly lead: boolean;
  readonly member: boolean;
}

/**
 * The viewer's relation to a project. `visible` follows `scope` (default: the viewer's `projects/view`): `all` sees
 * every project, `none` none, `related` the public ones and those the viewer joined.
 */
export async function projectAccess(
  conn: Conn,
  viewer: Viewer,
  projectId: string,
  scope: NpScope = scopeIn(viewer, NP_BUSINESS.projects, 'view'),
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
    visible:
      scope === 'all' ||
      (scope === 'related' && (project.visibility !== 'members' || member)),
  };
}

/**
 * Ids of the projects the viewer may not see under `scope` (default: their `projects/view`): none for `all`, every
 * project for `none`, the private projects they did not join for `related`.
 */
export async function hiddenProjectIds(
  conn: Conn,
  viewer: Viewer,
  scope: NpScope = scopeIn(viewer, NP_BUSINESS.projects, 'view'),
): Promise<string[]> {
  if (scope === 'all') return [];
  if (scope === 'none') {
    const every = await conn.query
      .selectFrom('projects')
      .select('id')
      .execute();
    return every.map((row) => str(row.id) ?? '');
  }
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

/** Whether the viewer sees the project under `scope` (default: their `projects/view`); no project is always visible. */
/**
 * `reports/view` (usage and metrics): 403 at `none`; otherwise the projects whose figures are left out (none at
 * `all`, the private projects the viewer did not join at `related`).
 */
export async function reportHiddenProjectIds(
  conn: Conn,
  viewer: Viewer,
): Promise<string[]> {
  const scope = scopeIn(viewer, NP_BUSINESS.reports, 'view');
  if (scope === 'none') forbid('You may not read reports.');
  return hiddenProjectIds(conn, viewer, scope);
}

export async function canSeeProject(
  conn: Conn,
  viewer: Viewer,
  projectId: string | null,
  scope: NpScope = scopeIn(viewer, NP_BUSINESS.projects, 'view'),
): Promise<boolean> {
  if (!projectId) return true;
  return (await projectAccess(conn, viewer, projectId, scope)).visible;
}

/**
 * `issues/view`: `none` sees no issue, `all` every issue, `related` those without a project or in a project the viewer
 * may see. Iteration 4: a project manager conversation (`originType = 'pm'`) is private to its owner whatever the
 * scope — the manager answers with what that member may see, so nobody else may read the answers.
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
  const scope = scopeIn(viewer, NP_BUSINESS.issues, 'view');
  if (scope !== 'related') return scope === 'all';
  return canSeeProject(conn, viewer, issue.projectId, scope);
}

/** 403 unless the viewer holds `issues/edit` (create, fields, comments, attachments, dependencies). */
export function requireEditIssues(viewer: Viewer): void {
  requireAction(
    viewer,
    NP_BUSINESS.issues,
    'edit',
    'You may not change issues.',
  );
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

/** `all`, or `related` and the viewer owns the issue or leads its project. */
async function managesIssue(
  conn: Conn,
  viewer: Viewer,
  issue: Pick<Issue, 'ownerUserId' | 'projectId'>,
  scope: NpScope,
): Promise<boolean> {
  if (scope !== 'related') return scope === 'all';
  if (issue.ownerUserId === viewer.userId) return true;
  return isProjectLead(conn, viewer, issue.projectId);
}

/** `issues/change-owner`: every issue, or the current owner and the project lead. */
export async function canChangeOwner(
  conn: Conn,
  viewer: Viewer,
  issue: Pick<Issue, 'ownerUserId' | 'projectId'>,
): Promise<boolean> {
  return managesIssue(
    conn,
    viewer,
    issue,
    scopeIn(viewer, NP_BUSINESS.issues, 'change-owner'),
  );
}

/** `issues/close` (a terminal status): every issue, or the issue owner and the project lead. */
export async function canWriteTerminal(
  conn: Conn,
  viewer: Viewer,
  issue: Pick<Issue, 'ownerUserId' | 'projectId'>,
): Promise<boolean> {
  return managesIssue(
    conn,
    viewer,
    issue,
    scopeIn(viewer, NP_BUSINESS.issues, 'close'),
  );
}

/** `pullRequests/merge`: merging completes the issue, so "related" is the terminal-status rule. */
export async function canMergePullRequest(
  conn: Conn,
  viewer: Viewer,
  issue: Pick<Issue, 'ownerUserId' | 'projectId'>,
): Promise<boolean> {
  return managesIssue(
    conn,
    viewer,
    issue,
    scopeIn(viewer, NP_BUSINESS.pullRequests, 'merge'),
  );
}

/** `projects/manage`: every project, or the project lead. A project the viewer cannot see is 404. */
export async function requireProjectManager(
  conn: Conn,
  viewer: Viewer,
  projectId: string,
): Promise<void> {
  const access = await projectAccess(conn, viewer, projectId);
  if (!access.exists || !access.visible) throw notFound('Project');
  if (!canManageProject(viewer, access))
    forbid('Only the project lead or an owner/admin may change this project.');
}

/** `projects/manage` on a project whose `projectAccess` is known. */
export function canManageProject(
  viewer: Viewer,
  access: Pick<ProjectAccess, 'lead'>,
): boolean {
  const scope = scopeIn(viewer, NP_BUSINESS.projects, 'manage');
  return scope === 'all' || (scope === 'related' && access.lead);
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

/** `agents/manage`: every agent, or the viewer's own. */
export function canEditAgent(
  viewer: Viewer,
  agent: { readonly ownerUserId: string },
): boolean {
  return allowsOwn(
    scopeIn(viewer, NP_BUSINESS.agents, 'manage'),
    agent.ownerUserId,
    viewer.userId,
  );
}

/**
 * Approver user ids for an issue (iteration 2 §D): `owner` → the issue owner; `projectLead` → the project lead
 * (skipped without a project or lead); `admin` → every member who may close every issue (`ADMIN_APPROVER_CHECK`).
 */
export async function resolveApproverIds(
  conn: Conn,
  directory: AccessHolders,
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
  if (roles.includes('admin'))
    result.push(
      ...(await deciderUserIds(conn, directory, ADMIN_APPROVER_CHECK)),
    );
  return unique(result);
}
