import type { Me } from './types.js';
import type { NpScope, NpScopes } from './types-roles.js';

/**
 * The business rules of `server/modules/shared/authz.ts`, as the browser applies them: to hide or disable a control
 * the server would refuse. Since NP-153 they read the viewer's scope of each business action (`GET /np/me` `scopes`,
 * resolved by the server from the viewer's business roles) instead of the `members.role` projection: `all` passes on
 * every record, `related` only where NocoProject's own relation holds (owner, project lead, agent owner, creator),
 * `none` never. The server enforces every rule itself; records that carry their own `canEdit` flag win over these.
 */

export interface Viewer {
  readonly userId: string;
  /** Scope per `composite/action`; a key missing (an older server) reads as `related`. */
  readonly scopes: NpScopes;
}

/** The business composites (`server/modules/shared/access.ts` `NP_BUSINESS`). */
export const NP_BUSINESS = {
  projects: 'nocoproject.projects',
  issues: 'nocoproject.issues',
  pullRequests: 'nocoproject.pullRequests',
  agents: 'nocoproject.agents',
  knowledge: 'nocoproject.knowledge',
  skills: 'nocoproject.skills',
  intake: 'nocoproject.intake',
  reports: 'nocoproject.reports',
} as const;

export type NpBusinessId = (typeof NP_BUSINESS)[keyof typeof NP_BUSINESS];

export function viewerFrom(me: Me | undefined): Viewer | null {
  if (!me?.userId) return null;
  return { userId: me.userId, scopes: me.scopes ?? {} };
}

export function scopeOf(
  viewer: Viewer | null,
  composite: NpBusinessId,
  action: string,
): NpScope {
  if (!viewer) return 'none';
  return viewer.scopes[`${composite}/${action}`] ?? 'related';
}

/** `all`, or `related` and the viewer is the person the record belongs to. */
function allowsOwn(
  scope: NpScope,
  viewer: Viewer | null,
  personId: string | null | undefined,
): boolean {
  return (
    scope === 'all' ||
    (scope === 'related' && !!personId && personId === viewer?.userId)
  );
}

/** Issue actions whose "related" is the issue owner and the project lead (`managesIssue`). */
function managesIssue(
  viewer: Viewer | null,
  scope: NpScope,
  issue: { readonly ownerUserId: string | null },
  projectLeadUserId?: string | null,
): boolean {
  return (
    allowsOwn(scope, viewer, issue.ownerUserId) ||
    (scope === 'related' && allowsOwn(scope, viewer, projectLeadUserId))
  );
}

/** `issues/close`: write done / cancelled. */
export function canCloseIssue(
  viewer: Viewer | null,
  issue: { readonly ownerUserId: string | null },
  projectLeadUserId?: string | null,
): boolean {
  return managesIssue(
    viewer,
    scopeOf(viewer, NP_BUSINESS.issues, 'close'),
    issue,
    projectLeadUserId,
  );
}

/** `issues/change-owner`. */
export function canChangeIssueOwner(
  viewer: Viewer | null,
  issue: { readonly ownerUserId: string | null },
  projectLeadUserId?: string | null,
): boolean {
  return managesIssue(
    viewer,
    scopeOf(viewer, NP_BUSINESS.issues, 'change-owner'),
    issue,
    projectLeadUserId,
  );
}

/** `projects/manage`: edit the project, its members and resources. */
export function canEditProject(
  viewer: Viewer | null,
  project: { readonly leadUserId?: string | null },
): boolean {
  return allowsOwn(
    scopeOf(viewer, NP_BUSINESS.projects, 'manage'),
    viewer,
    project.leadUserId,
  );
}

/** `projects/delete`: only on every project. */
export function canDeleteProject(viewer: Viewer | null): boolean {
  return scopeOf(viewer, NP_BUSINESS.projects, 'delete') === 'all';
}

/** `agents/manage`: edit the agent, its access scope and delegation list. */
export function canEditAgent(
  viewer: Viewer | null,
  agent: { readonly ownerUserId?: string | null },
): boolean {
  return allowsOwn(
    scopeOf(viewer, NP_BUSINESS.agents, 'manage'),
    viewer,
    agent.ownerUserId,
  );
}

/** `agents/env` on every agent: reveal values and read the audit. */
export function canAuditAgentEnv(viewer: Viewer | null): boolean {
  return scopeOf(viewer, NP_BUSINESS.agents, 'env') === 'all';
}

/** `skills/manage`: the creator's own, or every skill. */
export function canManageSkill(
  viewer: Viewer | null,
  skill: { readonly createdById?: string | null },
): boolean {
  return allowsOwn(
    scopeOf(viewer, NP_BUSINESS.skills, 'manage'),
    viewer,
    skill.createdById,
  );
}

/** `knowledge/decide` on every document, including the workspace-wide ones. */
export function canDecideAllKnowledge(viewer: Viewer | null): boolean {
  return scopeOf(viewer, NP_BUSINESS.knowledge, 'decide') === 'all';
}

/** `knowledge/decide` in the projects the viewer leads. */
export function canDecideLedKnowledge(viewer: Viewer | null): boolean {
  return scopeOf(viewer, NP_BUSINESS.knowledge, 'decide') !== 'none';
}
