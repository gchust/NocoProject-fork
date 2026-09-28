/**
 * Writes behind the invitation service (NP-88): pending rows, project and workspace membership, and delivering the
 * emails after the rows have committed.
 */
import type { Tx } from '../shared/db.js';
import { addSeconds, now, str, toJson } from '../shared/db.js';
import type { IdSource } from '../shared/ids.js';
import type { InvitationResult } from '../shared/protocol.js';
import { buildInvitationEmail } from './invitation.mail.js';
import {
  INVITATION_TTL_SECONDS,
  hashInvitationToken,
  mintInvitationToken,
  projectIdsOf,
  projectNames,
} from './invitation.records.js';
import type {
  InvitationContext,
  InvitationDeps,
} from './invitation.service.js';

/** One link to deliver after the rows commit. */
export interface Outgoing {
  readonly id: string;
  readonly email: string;
  readonly token: string;
  readonly projectIds: readonly string[];
  readonly expiresAt: Date;
}

/** Adds a project member unless the user already is one (an existing lead keeps the role). */
export async function joinProject(
  tx: Tx,
  ids: IdSource,
  projectId: string,
  userId: string,
): Promise<boolean> {
  const existing = await tx.conn.query
    .selectFrom('projectMembers')
    .select('id')
    .where('projectId', '=', projectId)
    .where('userId', '=', userId)
    .executeTakeFirst();
  if (existing) return false;
  const timestamp = now();
  await tx.conn.query
    .insertInto('projectMembers')
    .values({
      id: ids.next(),
      projectId,
      userId,
      role: 'member',
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .execute();
  return true;
}

export async function ensureWorkspaceMember(
  tx: Tx,
  ids: IdSource,
  userId: string,
): Promise<void> {
  const existing = await tx.conn.query
    .selectFrom('members')
    .select('id')
    .where('userId', '=', userId)
    .executeTakeFirst();
  if (existing) return;
  const timestamp = now();
  await tx.conn.query
    .insertInto('members')
    .values({
      id: ids.next(),
      userId,
      role: 'member',
      joinedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .execute();
}

/** Writes a pending invitation for `email` (merging into the pending one) and returns the link to deliver. */
export async function upsertPending(
  tx: Tx,
  deps: InvitationDeps,
  inviterId: string,
  email: string,
  projectIds: readonly string[],
): Promise<Outgoing> {
  const { token, hash } = mintInvitationToken();
  const timestamp = now();
  const expiresAt = addSeconds(timestamp, INVITATION_TTL_SECONDS);
  const pending = await tx.conn.query
    .selectFrom('npInvitations')
    .selectAll()
    .where('email', '=', email)
    .where('status', '=', 'pending')
    .executeTakeFirst();
  if (pending) {
    const merged = [...new Set([...projectIdsOf(pending), ...projectIds])];
    await tx.conn.query
      .updateTable('npInvitations')
      .set({
        tokenHash: hash,
        projectIds: toJson(merged),
        invitedById: inviterId,
        expiresAt,
        updatedAt: timestamp,
      })
      .where('id', '=', pending.id)
      .execute();
    const id = str(pending.id) ?? '';
    return { id, email, token, projectIds: merged, expiresAt };
  }
  const id = deps.ids.next();
  await tx.conn.query
    .insertInto('npInvitations')
    .values({
      id,
      email,
      tokenHash: hash,
      projectIds: toJson([...projectIds]),
      status: 'pending',
      invitedById: inviterId,
      expiresAt,
      sentAt: null,
      sendError: null,
      acceptedUserId: null,
      acceptedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .execute();
  return { id, email, token, projectIds, expiresAt };
}

/** Submits each email after the rows committed and records the outcome on the row. */
export async function deliver(
  deps: InvitationDeps,
  inviterId: string,
  outgoing: readonly Outgoing[],
  context: InvitationContext,
): Promise<InvitationResult[]> {
  const conn = deps.tx.read();
  const inviterName =
    (await deps.users.names(conn, [inviterId])).get(inviterId) ?? inviterId;
  const names = await projectNames(conn, [
    ...new Set(outgoing.flatMap((item) => item.projectIds)),
  ]);
  const base = context.appUrl.replace(/\/+$/u, '');
  const results: InvitationResult[] = [];
  for (const item of outgoing) {
    const url = `${base}/invite/${item.token}`;
    let error: string | null = null;
    try {
      await deps.mailer().send(
        buildInvitationEmail({
          to: item.email,
          inviterName,
          projectNames: item.projectIds
            .filter((id) => names.has(id))
            .map((id) => names.get(id) ?? ''),
          url,
          expiresAt: item.expiresAt,
          idempotencyKey: `np-invitation:${hashInvitationToken(item.token)}`,
        }),
      );
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const timestamp = now();
    await conn.query
      .updateTable('npInvitations')
      .set({
        sentAt: error ? null : timestamp,
        sendError: error ? error.slice(0, 1000) : null,
        updatedAt: timestamp,
      })
      .where('id', '=', item.id)
      .execute();
    results.push(
      error
        ? {
            email: item.email,
            outcome: 'invited',
            emailSent: false,
            inviteUrl: url,
          }
        : { email: item.email, outcome: 'invited', emailSent: true },
    );
  }
  return results;
}
