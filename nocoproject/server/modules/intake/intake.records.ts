/**
 * Row mapping and writes for `intakeBatches` and `intakeDrafts`.
 */
import type { Conn, Tx } from '../shared/db.js';
import {
  fromJson,
  iso,
  isoOrNull,
  now,
  num,
  str,
  toJson,
} from '../shared/db.js';
import { notFound } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import type {
  IntakeBatch,
  IntakeBatchStatus,
  IntakeDraft,
  IntakeDraftFields,
} from '../shared/protocol.js';
import type { ValidatedDraft } from './intake.validation.js';

const STATUSES: readonly IntakeBatchStatus[] = [
  'draft',
  'confirmed',
  'cancelled',
  'reverted',
];

export function mapBatch(row: Record<string, unknown>): IntakeBatch {
  const status = str(row.status) as IntakeBatchStatus;
  return {
    id: str(row.id) ?? '',
    createdById: str(row.createdById) ?? '',
    projectId: str(row.projectId),
    source: row.source === 'issue' ? 'issue' : 'paste',
    sourceIssueId: str(row.sourceIssueId),
    rawContent: str(row.rawContent) ?? '',
    parser: row.parser === 'ai' ? 'ai' : 'heuristic',
    status: STATUSES.includes(status) ? status : 'draft',
    aiSessionId: str(row.aiSessionId),
    confirmedAt: isoOrNull(row.confirmedAt),
    parseError: str(row.parseError),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function mapDraft(row: Record<string, unknown>): IntakeDraft {
  const validation = fromJson<{ errors?: unknown }>(row.validation);
  return {
    id: str(row.id) ?? '',
    batchId: str(row.batchId) ?? '',
    position: num(row.position),
    parentPosition:
      row.parentPosition === null || row.parentPosition === undefined
        ? null
        : num(row.parentPosition),
    fields: fromJson<IntakeDraftFields>(row.fields) ?? { title: '' },
    validation: {
      errors: Array.isArray(validation?.errors)
        ? validation.errors.filter(
            (item): item is string => typeof item === 'string',
          )
        : [],
    },
    createdIssueId: str(row.createdIssueId),
  };
}

export async function findBatch(conn: Conn, id: string): Promise<IntakeBatch> {
  const row = await conn.query
    .selectFrom('intakeBatches')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw notFound('Intake batch');
  return mapBatch(row);
}

export async function draftsOf(
  conn: Conn,
  batchId: string,
): Promise<IntakeDraft[]> {
  const rows = await conn.query
    .selectFrom('intakeDrafts')
    .selectAll()
    .where('batchId', '=', batchId)
    .orderBy('position', 'asc')
    .execute();
  return rows.map(mapDraft);
}

/** Replaces every draft of a batch. */
export async function replaceDrafts(
  tx: Tx,
  ids: IdSource,
  batchId: string,
  drafts: readonly ValidatedDraft[],
): Promise<void> {
  await tx.conn.query
    .deleteFrom('intakeDrafts')
    .where('batchId', '=', batchId)
    .execute();
  if (drafts.length === 0) return;
  const timestamp = now();
  await tx.conn.query
    .insertInto('intakeDrafts')
    .values(
      drafts.map((draft) => ({
        id: ids.next(),
        batchId,
        position: draft.position,
        parentPosition: draft.parentPosition,
        fields: toJson(draft.fields),
        validation: toJson({ errors: draft.errors }),
        createdIssueId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })),
    )
    .execute();
}

export async function setBatchStatus(
  tx: Tx,
  batchId: string,
  status: IntakeBatchStatus,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await tx.conn.query
    .updateTable('intakeBatches')
    .set({ status, ...extra, updatedAt: now() })
    .where('id', '=', batchId)
    .execute();
}
