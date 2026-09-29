/**
 * Who may touch a batch and in which state, and the draft write shared by `PUT .../drafts` and NP-120's refine
 * (moved out of `intake.service.ts`).
 */
import type { Actor } from '../shared/activity.js';
import { NP_BUSINESS } from '../shared/access.js';
import { allowsOwn, scopeIn, viewerOf, type Viewer } from '../shared/authz.js';
import type { Conn, Tx } from '../shared/db.js';
import { now } from '../shared/db.js';
import { conflict, notFound } from '../shared/errors.js';
import type { IntakeBatch, IntakeDraft } from '../shared/protocol.js';
import type { IntakeDeps } from './intake.service.js';
import { draftsOf, findBatch, replaceDrafts } from './intake.records.js';
import { validateDrafts } from './intake.validation.js';

/**
 * The batch, if `intake/manage` reaches it: every batch, or those the caller entered (404 otherwise, so other members'
 * batches do not leak).
 */
export async function ownBatch(
  conn: Conn,
  actor: Actor,
  id: string,
): Promise<{ batch: IntakeBatch; viewer: Viewer }> {
  const viewer = await viewerOf(conn, actor);
  const batch = await findBatch(conn, id);
  if (
    !allowsOwn(
      scopeIn(viewer, NP_BUSINESS.intake, 'manage'),
      batch.createdById,
      viewer.userId,
    )
  )
    throw notFound('Intake batch');
  return { batch, viewer };
}

export function requireStatus(
  batch: IntakeBatch,
  status: IntakeBatch['status'],
): void {
  if (batch.status !== status)
    throw conflict(
      'INTAKE_STATE_CONFLICT',
      `The batch is ${batch.status}; expected ${status}.`,
    );
}

/** Validates and replaces every draft of a draft batch, then returns them as stored. */
export async function storeDrafts(
  deps: IntakeDeps,
  tx: Tx,
  actor: Actor,
  id: string,
  drafts: unknown,
): Promise<IntakeDraft[]> {
  const { batch, viewer } = await ownBatch(tx.conn, actor, id);
  requireStatus(batch, 'draft');
  const validated = await validateDrafts(
    {
      conn: tx.conn,
      users: deps.users,
      creatorId: batch.createdById || viewer.userId,
      underIssue: !!batch.sourceIssueId,
    },
    drafts,
  );
  await replaceDrafts(tx, deps.ids, id, validated);
  await tx.conn.query
    .updateTable('intakeBatches')
    .set({ updatedAt: now() })
    .where('id', '=', id)
    .execute();
  return draftsOf(tx.conn, id);
}
