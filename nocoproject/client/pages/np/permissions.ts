import type { Member, MemberRole } from './types.js';

/**
 * The application-level rules of `docs/phase1/iteration-1-contract.md` §B, as the browser applies them: to hide or
 * disable a control the server would refuse. The server enforces every rule itself; these predicates only keep the
 * interface from offering what will fail. `members.role` is the projection of the built-in permission sets
 * `np-owner` / `np-admin` (NP-117); settings tabs use their own settings checks (`config/config-access.ts`).
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

/** 改负责人 and 写 done / cancelled: the issue owner, the project lead, owner/admin. */
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

/** 改项目、项目成员、资源: the project lead, owner/admin. */
export function canEditProject(
  viewer: Viewer | null,
  project: { readonly leadUserId?: string | null },
): boolean {
  if (!viewer) return false;
  return isWorkspaceAdmin(viewer) || project.leadUserId === viewer.userId;
}

/** 删项目: owner/admin. */
export function canDeleteProject(viewer: Viewer | null): boolean {
  return isWorkspaceAdmin(viewer);
}

/** 改 Agent、访问范围、委派名单: the agent's owner, owner/admin. */
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
 * The role choices `viewer` has for `target` (成员角色, §B; NP-117): only an owner grants or revokes owner, and the
 * last owner keeps it; admin and member are ordinary role assignments, changed by whoever may assign roles in user
 * management (`assignRoles`, the `user` `assign-role` check). The target's current role is always listed and enabled
 * so the select can show it.
 */
export function memberRoleOptions(
  viewer: Viewer | null,
  target: Member,
  members: readonly Member[],
  assignRoles: boolean,
): RoleOption[] {
  const viewerIsOwner = viewer?.role === 'owner';
  const owners = members.filter((member) => member.role === 'owner').length;
  const lastOwner = target.role === 'owner' && owners <= 1;

  const allowed = (role: MemberRole): boolean => {
    if (role === target.role) return true;
    if (lastOwner) return false;
    // Granting owner, or changing anything about an owner, is the owners' decision alone.
    if (role === 'owner' || target.role === 'owner') return viewerIsOwner;
    return assignRoles;
  };

  return MEMBER_ROLES.map((value) => ({ value, disabled: !allowed(value) }));
}

/** Whether the role select for `target` offers any change at all. */
export function canChangeMemberRole(
  viewer: Viewer | null,
  target: Member,
  members: readonly Member[],
  assignRoles: boolean,
): boolean {
  return memberRoleOptions(viewer, target, members, assignRoles).some(
    (option) => option.value !== target.role && !option.disabled,
  );
}
