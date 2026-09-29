/**
 * Email invitations (NP-88, docs/phase2/invitations.md).
 *
 * - Who may invite: whoever holds `invite` on the settings item `nocoproject.members` (NP-117; owner/admin by default)
 *   into any projects (or none), and sees and revokes every pending invitation; a project lead only into projects they
 *   lead, and at least one. Everyone else is refused with 403.
 * - One request takes several addresses. An address that already has an account is added to the chosen projects
 *   directly (`added` / `alreadyMember`); an address with a pending invitation gets the projects merged and a fresh
 *   link; any other address gets a new invitation. Invitees join every project as `member`.
 * - Only the hash of the token is stored. The email is submitted after the rows commit; if submitting fails the
 *   inviter gets the link once in the response to forward by hand, and the row keeps the error.
 * - Accepting (public, by token) creates the account through the authentication plugin (`InvitationAccounts`), makes
 *   it a workspace member and adds it to the projects that still exist, all in one transaction.
 */
import type { Actor } from '../shared/activity.js';
import { NP_SETTINGS } from '../shared/access.js';
import {
  canManageProject,
  canUseSetting,
  forbid,
  projectAccess,
  viewerOf,
} from '../shared/authz.js';
import type { Conn, TxRunner } from '../shared/db.js';
import { isPostgres, knexOf, now, num, str, toDate } from '../shared/db.js';
import { conflict, invalid, notFound } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import type {
  AcceptInvitationRequest,
  AcceptInvitationResponse,
  CreateInvitationsRequest,
  CreateInvitationsResponse,
  Invitation,
  InvitationResult,
  PublicInvitation,
} from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import {
  deliver,
  joinProject,
  upsertPending,
  type Outgoing,
} from './invitation.write.js';
import type { InvitationMailer } from './invitation.mail.js';
import { admitMember } from './member.service.js';
import type { RoleAssignments } from './member.roles.js';
import {
  hashInvitationToken,
  mapInvitations,
  projectIdsOf,
  projectNames,
  statusOf,
  usersByEmail,
  validateEmails,
  validateProjectIds,
} from './invitation.records.js';

/** Creates the invitee's account (the authentication plugin in production, a fixture table in tests). */
export interface InvitationAccounts {
  create(
    conn: Conn,
    input: {
      readonly name: string;
      readonly email: string;
      readonly password: string;
    },
  ): Promise<string>;
}

/** Where links point: `${appUrl}/invite/<token>` (origin plus the application's public base path). */
export interface InvitationContext {
  readonly appUrl: string;
}

export interface InvitationService {
  list(actor: Actor): Promise<Invitation[]>;
  create(
    actor: Actor,
    input: CreateInvitationsRequest,
    context: InvitationContext,
  ): Promise<CreateInvitationsResponse>;
  resend(
    actor: Actor,
    id: string,
    context: InvitationContext,
  ): Promise<InvitationResult>;
  revoke(actor: Actor, id: string): Promise<void>;
  /** Public: what the acceptance page shows. */
  lookup(token: string): Promise<PublicInvitation>;
  /** Public: create the account (or reuse an existing one) and join the projects. */
  accept(
    token: string,
    input: AcceptInvitationRequest,
  ): Promise<AcceptInvitationResponse>;
}

export interface InvitationDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly users: UserDirectory;
  readonly mailer: () => InvitationMailer;
  readonly accounts: () => InvitationAccounts | null;
  /** NP-117: where roles are stored; an accepted invitee is admitted as a member through it. */
  readonly roles: () => RoleAssignments;
}

const MAX_NAME_LENGTH = 100;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

async function lockInvitations(conn: Conn): Promise<void> {
  if (!isPostgres(conn)) return;
  const knex = await knexOf(conn);
  await knex.raw("SELECT pg_advisory_xact_lock(hashtext('np:invitations'))");
}

/** Whether `actor` manages every invitation: `invite` on the settings item `nocoproject.members`. */
function managesInvitations(conn: Conn, actor: Actor): Promise<boolean> {
  return canUseSetting(conn, actor, NP_SETTINGS.members, 'invite');
}

/**
 * An invitation manager (`admin`, from `managesInvitations` before the transaction): any existing projects. Others:
 * at least one project, and they must lead every one.
 */
async function checkInviter(
  conn: Conn,
  actor: Actor,
  projectIds: readonly string[],
  admin: boolean,
): Promise<string> {
  const viewer = await viewerOf(conn, actor);
  if (!admin && projectIds.length === 0)
    forbid('Only an owner or admin may invite without choosing a project.');
  for (const projectId of projectIds) {
    const access = await projectAccess(conn, viewer, projectId);
    if (!access.exists || (!admin && !access.visible))
      throw invalid('INVALID_PROJECT', `Project ${projectId} does not exist.`);
    if (!admin && !canManageProject(viewer, access))
      forbid(
        'Only the project lead or an owner/admin may invite into this project.',
      );
  }
  return viewer.userId;
}

async function existingProjects(
  conn: Conn,
  projectIds: readonly string[],
): Promise<string[]> {
  const names = await projectNames(conn, projectIds);
  return projectIds.filter((id) => names.has(id));
}

async function findByToken(
  conn: Conn,
  token: string,
): Promise<Record<string, unknown>> {
  const row =
    typeof token === 'string' && token.length > 0 && token.length <= 128
      ? await conn.query
          .selectFrom('npInvitations')
          .selectAll()
          .where('tokenHash', '=', hashInvitationToken(token))
          .executeTakeFirst()
      : undefined;
  if (!row) throw notFound('Invitation');
  return row;
}

/** Only a pending, unexpired invitation can be opened or accepted. */
function requireOpen(row: Record<string, unknown>): void {
  const status = statusOf(row, now());
  if (status === 'pending') return;
  if (status === 'expired')
    throw conflict('INVITATION_EXPIRED', 'This invitation has expired.');
  if (status === 'accepted')
    throw conflict(
      'INVITATION_ACCEPTED',
      'This invitation has already been accepted.',
    );
  throw conflict('INVITATION_REVOKED', 'This invitation has been revoked.');
}

function validateAccept(input: AcceptInvitationRequest): {
  readonly name: string;
  readonly password: string;
} {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > MAX_NAME_LENGTH)
    throw invalid(
      'INVALID_NAME',
      `name must be 1–${MAX_NAME_LENGTH} characters.`,
    );
  const password = typeof input?.password === 'string' ? input.password : '';
  if (
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  )
    throw invalid(
      'INVALID_PASSWORD',
      `password must be ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} characters.`,
    );
  return { name, password };
}

/** The row an inviter may manage: an invitation manager (`manager`) any, others only their own. */
async function managedRow(
  conn: Conn,
  actor: Actor,
  id: string,
  manager: boolean,
): Promise<Record<string, unknown>> {
  const viewer = await viewerOf(conn, actor);
  const row = await conn.query
    .selectFrom('npInvitations')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row || (str(row.invitedById) !== viewer.userId && !manager))
    throw notFound('Invitation');
  return row;
}

export function createInvitationService(
  deps: InvitationDeps,
): InvitationService {
  return {
    async list(actor) {
      const conn = deps.tx.read();
      const viewer = await viewerOf(conn, actor);
      let query = conn.query
        .selectFrom('npInvitations')
        .selectAll()
        .where('status', '=', 'pending');
      if (!(await managesInvitations(conn, actor)))
        query = query.where('invitedById', '=', viewer.userId);
      const rows = await query.orderBy('createdAt', 'desc').execute();
      return mapInvitations(conn, deps.users, rows, now());
    },

    async create(actor, input, context) {
      const emails = validateEmails(input?.emails);
      const projectIds = validateProjectIds(input?.projectIds);
      const direct: InvitationResult[] = [];
      const manager = await managesInvitations(deps.tx.read(), actor);
      const { inviterId, outgoing } = await deps.tx.run(async (tx) => {
        const inviter = await checkInviter(tx.conn, actor, projectIds, manager);
        await lockInvitations(tx.conn);
        const accounts = await usersByEmail(tx.conn, emails);
        const links: Outgoing[] = [];
        for (const email of emails) {
          const userId = accounts.get(email);
          if (userId) {
            let joined = false;
            for (const projectId of projectIds)
              joined =
                (await joinProject(tx, deps.ids, projectId, userId)) || joined;
            direct.push({ email, outcome: joined ? 'added' : 'alreadyMember' });
            continue;
          }
          links.push(await upsertPending(tx, deps, inviter, email, projectIds));
        }
        return { inviterId: inviter, outgoing: links };
      });
      const sent = await deliver(deps, inviterId, outgoing, context);
      const byEmail = new Map(
        [...direct, ...sent].map((result) => [result.email, result]),
      );
      return {
        results: emails.flatMap((email) => byEmail.get(email) ?? []),
      };
    },

    async resend(actor, id, context) {
      const manager = await managesInvitations(deps.tx.read(), actor);
      const { inviterId, outgoing } = await deps.tx.run(async (tx) => {
        const row = await managedRow(tx.conn, actor, id, manager);
        if (str(row.status) !== 'pending')
          throw conflict(
            'INVITATION_CLOSED',
            'Only a pending invitation can be sent again.',
          );
        const viewer = await viewerOf(tx.conn, actor);
        await lockInvitations(tx.conn);
        const email = str(row.email) ?? '';
        const item = await upsertPending(
          tx,
          deps,
          viewer.userId,
          email,
          projectIdsOf(row),
        );
        return { inviterId: viewer.userId, outgoing: [item] };
      });
      const [result] = await deliver(deps, inviterId, outgoing, context);
      return result;
    },

    async revoke(actor, id) {
      const manager = await managesInvitations(deps.tx.read(), actor);
      await deps.tx.run(async (tx) => {
        const row = await managedRow(tx.conn, actor, id, manager);
        if (str(row.status) !== 'pending')
          throw conflict(
            'INVITATION_CLOSED',
            'Only a pending invitation can be revoked.',
          );
        await tx.conn.query
          .updateTable('npInvitations')
          .set({ status: 'revoked', updatedAt: now() })
          .where('id', '=', id)
          .execute();
      });
    },

    async lookup(token) {
      const conn = deps.tx.read();
      const row = await findByToken(conn, token);
      requireOpen(row);
      const inviterId = str(row.invitedById) ?? '';
      const names = await projectNames(conn, projectIdsOf(row));
      return {
        email: str(row.email) ?? '',
        inviterName:
          (await deps.users.names(conn, [inviterId])).get(inviterId) ??
          inviterId,
        projectNames: projectIdsOf(row)
          .filter((id) => names.has(id))
          .map((id) => names.get(id) ?? ''),
        expiresAt: toDate(row.expiresAt)?.toISOString() ?? '',
      };
    },

    async accept(token, input) {
      const { name, password } = validateAccept(input);
      return deps.tx.run(async (tx) => {
        const row = await findByToken(tx.conn, token);
        requireOpen(row);
        const email = str(row.email) ?? '';
        const claimed = await tx.conn.query
          .updateTable('npInvitations')
          .set({ status: 'accepted', acceptedAt: now(), updatedAt: now() })
          .where('id', '=', row.id)
          .where('status', '=', 'pending')
          .execute();
        if (num(claimed.updatedCount) === 0)
          throw conflict(
            'INVITATION_ACCEPTED',
            'This invitation has already been accepted.',
          );
        const existing = (await usersByEmail(tx.conn, [email])).get(email);
        let userId = existing;
        if (!userId) {
          const accounts = deps.accounts();
          if (!accounts)
            throw conflict(
              'ACCOUNTS_UNAVAILABLE',
              'Accounts cannot be created on this server.',
            );
          userId = await accounts.create(tx.conn, { name, email, password });
        }
        await admitMember(tx, deps.ids, deps.roles(), userId);
        for (const projectId of await existingProjects(
          tx.conn,
          projectIdsOf(row),
        ))
          await joinProject(tx, deps.ids, projectId, userId);
        await tx.conn.query
          .updateTable('npInvitations')
          .set({ acceptedUserId: userId })
          .where('id', '=', row.id)
          .execute();
        return { email, existingAccount: !!existing };
      });
    },
  };
}
