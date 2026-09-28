/**
 * Row mapping, validation and token helpers for email invitations (NP-88).
 */
import { createHash, randomBytes } from 'node:crypto';

import type { Conn } from '../shared/db.js';
import { fromJson, iso, isoOrNull, str, toDate, unique } from '../shared/db.js';
import { invalid } from '../shared/errors.js';
import type { Invitation, InvitationStatus } from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';

/** An invitation link stays valid for seven days; resending starts a new period. */
export const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Addresses per `POST /np/invitations`. */
export const MAX_INVITATION_EMAILS = 50;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** A new invitation token (the link carries it) and the hash that is stored. */
export function mintInvitationToken(): {
  readonly token: string;
  readonly hash: string;
} {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashInvitationToken(token) };
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 255 && EMAIL.test(email) ? email : null;
}

/** Trimmed, lower-cased, de-duplicated addresses; every one must be valid. */
export function validateEmails(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw invalid('INVALID_EMAILS', 'emails must be a non-empty array.');
  const emails: string[] = [];
  for (const item of value) {
    const email = normalizeEmail(item);
    if (!email)
      throw invalid(
        'INVALID_EMAIL',
        `${typeof item === 'string' ? item : String(item)} is not a valid email address.`,
      );
    if (!emails.includes(email)) emails.push(email);
  }
  if (emails.length > MAX_INVITATION_EMAILS)
    throw invalid(
      'TOO_MANY_EMAILS',
      `At most ${MAX_INVITATION_EMAILS} addresses per request.`,
    );
  return emails;
}

export function validateProjectIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    value.some((id) => typeof id !== 'string' || !id)
  )
    throw invalid('INVALID_PROJECTS', 'projectIds must be an array of ids.');
  return unique(value as string[]);
}

export function projectIdsOf(row: Record<string, unknown>): string[] {
  const ids = fromJson<unknown>(row.projectIds);
  return Array.isArray(ids)
    ? unique(ids.filter((id): id is string => typeof id === 'string'))
    : [];
}

export function statusOf(
  row: Record<string, unknown>,
  at: Date,
): InvitationStatus {
  const status = str(row.status);
  if (status === 'accepted' || status === 'revoked') return status;
  const expiresAt = toDate(row.expiresAt);
  return expiresAt && expiresAt.getTime() <= at.getTime()
    ? 'expired'
    : 'pending';
}

export async function projectNames(
  conn: Conn,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (ids.length === 0) return result;
  const rows = await conn.query
    .selectFrom('projects')
    .select(['id', 'name'])
    .where('id', 'in', [...ids])
    .execute();
  for (const row of rows) result.set(str(row.id) ?? '', str(row.name) ?? '');
  return result;
}

/** Maps rows to the list shape; projects deleted since the invitation was sent are left out. */
export async function mapInvitations(
  conn: Conn,
  users: UserDirectory,
  rows: readonly Record<string, unknown>[],
  at: Date,
): Promise<Invitation[]> {
  const projects = await projectNames(
    conn,
    unique(rows.flatMap((row) => projectIdsOf(row))),
  );
  const inviters = await users.names(
    conn,
    rows.map((row) => str(row.invitedById)),
  );
  return rows.map((row) => {
    const invitedById = str(row.invitedById) ?? '';
    return {
      id: str(row.id) ?? '',
      email: str(row.email) ?? '',
      status: statusOf(row, at),
      projects: projectIdsOf(row)
        .filter((id) => projects.has(id))
        .map((id) => ({ id, name: projects.get(id) ?? '' })),
      invitedBy: {
        userId: invitedById,
        name: inviters.get(invitedById) ?? invitedById,
      },
      expiresAt: iso(row.expiresAt),
      sentAt: isoOrNull(row.sentAt),
      createdAt: iso(row.createdAt),
    };
  });
}

/** Ids of the accounts using each address. The authentication plugin stores addresses lower-cased. */
export async function usersByEmail(
  conn: Conn,
  emails: readonly string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (emails.length === 0) return result;
  const rows = await conn.query
    .selectFrom('user')
    .select(['id', 'email'])
    .where('email', 'in', [...emails])
    .execute();
  for (const row of rows) {
    const email = str(row.email)?.toLowerCase();
    if (email && !result.has(email)) result.set(email, str(row.id) ?? '');
  }
  return result;
}
