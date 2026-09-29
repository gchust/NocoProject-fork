/**
 * Who may read, write and decide knowledge (docs/phase1/iteration-3-contract.md §B):
 *
 * | Action                                   | Allowed                                                    |
 * | ---------------------------------------- | ---------------------------------------------------------- |
 * | Read a project document                  | members who can see the project                            |
 * | Read a system-level document             | every member                                               |
 * | Create / edit / archive a project doc    | `knowledge/decide`: all, or the project lead (leadUserId or a lead membership) |
 * | Create / edit / archive a system doc     | `knowledge/decide` at all                                  |
 * | Decide a proposal                        | same as editing the document's scope                       |
 * | Proposal cards go to                     | the project lead(s); whoever holds `knowledge/decide` at all when there is none or the doc is system-level |
 */
import type { Actor } from '../shared/activity.js';
import { NP_BUSINESS } from '../shared/access.js';
import {
  deciderUserIds,
  hiddenProjectIds,
  scopeIn,
  viewerOf,
  type AccessHolders,
  type Viewer,
} from '../shared/authz.js';
import type { Conn } from '../shared/db.js';
import { str, unique } from '../shared/db.js';
import { findIssue } from '../issue/issue.records.js';
import type { RunAuth } from '../run/token.js';
import {
  findDocRow,
  findDocRowBySlug,
  SYSTEM_PROJECT_KEY,
} from './knowledge.records.js';

export interface KnowledgeScope {
  readonly viewer: Viewer;
  /** `knowledge/decide` at all: every document, system-level ones included. */
  readonly decideAll: boolean;
  /** `knowledge/decide` at related (or all): the documents of the projects in `leadOf`. */
  readonly decideLed: boolean;
  /** Projects the viewer leads. */
  readonly leadOf: ReadonlySet<string>;
  /** Private projects the viewer may not see. */
  readonly hidden: ReadonlySet<string>;
}

export async function scopeOf(
  conn: Conn,
  actor: Actor,
): Promise<KnowledgeScope> {
  const viewer = await viewerOf(conn, actor);
  const led = await conn.query
    .selectFrom('projects')
    .select('id')
    .where('leadUserId', '=', viewer.userId)
    .execute();
  const leadMemberships = await conn.query
    .selectFrom('projectMembers')
    .select('projectId')
    .where('userId', '=', viewer.userId)
    .where('role', '=', 'lead')
    .execute();
  const decide = scopeIn(viewer, NP_BUSINESS.knowledge, 'decide');
  return {
    viewer,
    decideAll: decide === 'all',
    decideLed: decide !== 'none',
    leadOf: new Set(
      unique([
        ...led.map((row) => str(row.id)),
        ...leadMemberships.map((row) => str(row.projectId)),
      ]),
    ),
    hidden: new Set(await hiddenProjectIds(conn, viewer)),
  };
}

export function canRead(
  scope: KnowledgeScope,
  projectId: string | null,
): boolean {
  return projectId === null || !scope.hidden.has(projectId);
}

export function canEdit(
  scope: KnowledgeScope,
  projectId: string | null,
): boolean {
  return (
    scope.decideAll ||
    (scope.decideLed && projectId !== null && scope.leadOf.has(projectId))
  );
}

/** The users a proposal card goes to: the project's leads, else every member holding `knowledge/decide` at all. */
export async function knowledgeDeciders(
  conn: Conn,
  directory: AccessHolders,
  projectId: string | null,
): Promise<string[]> {
  if (projectId) {
    const project = await conn.query
      .selectFrom('projects')
      .select('leadUserId')
      .where('id', '=', projectId)
      .executeTakeFirst();
    const leads = await conn.query
      .selectFrom('projectMembers')
      .select('userId')
      .where('projectId', '=', projectId)
      .where('role', '=', 'lead')
      .execute();
    const ids = unique([
      project ? str(project.leadUserId) : null,
      ...leads.map((row) => str(row.userId)),
    ]);
    if (ids.length > 0) return ids;
  }
  return deciderUserIds(conn, directory, {
    resource: { type: 'composite', id: NP_BUSINESS.knowledge },
    action: 'decide',
  });
}

/** The run's project (the project of its issue), or null. Agents reach that project's and system-level documents. */
export async function runProject(
  conn: Conn,
  auth: RunAuth,
): Promise<string | null> {
  return (await findIssue(conn, auth.issueId))?.projectId ?? null;
}

/** A document the run may address by id or slug (its project first, then system-level), or undefined. */
export async function agentDocRow(
  conn: Conn,
  idOrSlug: string,
  projectId: string | null,
): Promise<Record<string, unknown> | undefined> {
  const row =
    (await findDocRow(conn, idOrSlug)) ??
    (projectId
      ? await findDocRowBySlug(conn, projectId, idOrSlug)
      : undefined) ??
    (await findDocRowBySlug(conn, SYSTEM_PROJECT_KEY, idOrSlug));
  if (!row) return undefined;
  const key = str(row.projectId);
  return key === SYSTEM_PROJECT_KEY || key === projectId ? row : undefined;
}
