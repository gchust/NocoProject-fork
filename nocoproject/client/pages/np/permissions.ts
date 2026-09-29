import type { Member, MemberRole } from './types.js';

/**
 * The application-level rules of `docs/phase1/iteration-1-contract.md` §B, as the browser applies them: to hide or
 * disable a control the server would refuse. The server enforces every rule itself; these predicates only keep the
 * interface from offering what will fail.
 */

export interface Viewer {
  readonly userId: string;
  /** The viewer's `members.role`, or null while the member list is loading or the viewer has no row yet. */
  readonly role: MemberRole | null;
}

export function viewerFrom(
  userId: string | undefined,
  members: readonly Member[] | undefined,
): Viewer | null {
  if (!userId) return null;
  return {
    userId,
    role: members?.find((member) => member.userId === userId)?.role ?? null,
  };
}

export function isWorkspaceAdmin(viewer: Viewer | null): boolean {
  return viewer?.role === 'owner' || viewer?.role === 'admin';
}

/** Change owner and write done / cancelled: the issue owner, the project lead, owner/admin. */
export function canActAsIssueOwner(
  viewer: Viewer | null,
  issue: { readonly ownerUserId: string | null },
  projectLeadUserId?: string | null,
): boolean {
  if (!viewer) return false;
  return (
    isWorkspaceAdmin(viewer) ||
    issue.ownerUserId === viewer.userId ||
    (!!projectLeadUserId && projectLeadUserId === viewer.userId)
  );
}

/** Edit the project, project members, resources: the project lead, owner/admin. */
export function canEditProject(
  viewer: Viewer | null,
  project: { readonly leadUserId?: string | null },
): boolean {
  if (!viewer) return false;
  return isWorkspaceAdmin(viewer) || project.leadUserId === viewer.userId;
}

/** Delete project: owner/admin. */
export function canDeleteProject(viewer: Viewer | null): boolean {
  return isWorkspaceAdmin(viewer);
}

/** Edit the agent, access scope, delegation list: the agent's owner, owner/admin. */
export function canEditAgent(
  viewer: Viewer | null,
  agent: { readonly ownerUserId?: string | null },
): boolean {
  if (!viewer) return false;
  return isWorkspaceAdmin(viewer) || agent.ownerUserId === viewer.userId;
}

export const MEMBER_ROLES: readonly MemberRole[] = ['owner', 'admin', 'member'];

export interface RoleOption {
  readonly value: MemberRole;
  readonly disabled: boolean;
}

/**
 * The role choices `viewer` has for `target` (member roles, §B): owner/admin change admin and member; only an owner grants
 * or revokes owner; the last owner cannot be demoted. The target's current role is always listed and enabled so the
 * select can show it.
 */
export function memberRoleOptions(
  viewer: Viewer | null,
  target: Member,
  members: readonly Member[],
): RoleOption[] {
  const viewerIsOwner = viewer?.role === 'owner';
  const admin = isWorkspaceAdmin(viewer);
  const owners = members.filter((member) => member.role === 'owner').length;
  const lastOwner = target.role === 'owner' && owners <= 1;

  const allowed = (role: MemberRole): boolean => {
    if (role === target.role) return true;
    if (!admin) return false;
    if (lastOwner) return false;
    // Granting owner, or changing anything about an owner, is the owners' decision alone.
    if (role === 'owner' || target.role === 'owner') return viewerIsOwner;
    return true;
  };

  return MEMBER_ROLES.map((value) => ({ value, disabled: !allowed(value) }));
}

/** Whether the role select for `target` offers any change at all. */
export function canChangeMemberRole(
  viewer: Viewer | null,
  target: Member,
  members: readonly Member[],
): boolean {
  return memberRoleOptions(viewer, target, members).some(
    (option) => option.value !== target.role && !option.disabled,
  );
}
