/**
 * Issue labels (docs/phase1/iteration-1-contract.md §F): a flat, workspace-wide list with a semantic color, linked
 * to issues through `issueLabelLinks`. Every member reads the list; creating, renaming, recoloring and deleting need
 * `update` on the settings item `nocoproject.labels` (NP-117; owner/admin by default).
 */
import type { Actor } from '../shared/activity.js';
import { NP_SETTINGS } from '../shared/access.js';
import { requireSetting } from '../shared/authz.js';
import type { Conn, Tx, TxRunner } from '../shared/db.js';
import { isUniqueViolation, now, str, unique } from '../shared/db.js';
import { conflict, invalid, notFound } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import type {
  CreateLabelRequest,
  Label,
  LabelColor,
  UpdateLabelRequest,
} from '../shared/protocol.js';
import { requiredName, validateLabelColor } from '../shared/validate.js';

const MAX_LABEL_NAME = 64;

function requireLabelManager(conn: Conn, actor: Actor): Promise<void> {
  return requireSetting(
    conn,
    actor,
    NP_SETTINGS.labels,
    'update',
    'You may not manage labels.',
  );
}

export interface LabelService {
  list(): Promise<Label[]>;
  create(actor: Actor, input: CreateLabelRequest): Promise<Label>;
  update(actor: Actor, id: string, patch: UpdateLabelRequest): Promise<Label>;
  remove(actor: Actor, id: string): Promise<void>;
}

export function mapLabel(row: Record<string, unknown>): Label {
  return {
    id: str(row.id) ?? '',
    name: str(row.name) ?? '',
    color: (str(row.color) ?? 'gray') as LabelColor,
  };
}

/** Labels of each issue, sorted by name. */
export async function labelsForIssues(
  conn: Conn,
  issueIds: readonly string[],
): Promise<Map<string, Label[]>> {
  const result = new Map<string, Label[]>();
  const wanted = unique(issueIds);
  if (wanted.length === 0) return result;
  const links = await conn.query
    .selectFrom('issueLabelLinks')
    .select(['issueId', 'labelId'])
    .where('issueId', 'in', wanted)
    .execute();
  if (links.length === 0) return result;
  const labels = new Map(
    (
      await conn.query
        .selectFrom('issueLabels')
        .selectAll()
        .where('id', 'in', unique(links.map((link) => str(link.labelId))))
        .execute()
    ).map((row) => [str(row.id) ?? '', mapLabel(row)]),
  );
  for (const link of links) {
    const label = labels.get(str(link.labelId) ?? '');
    if (!label) continue;
    const issueId = str(link.issueId) ?? '';
    const list = result.get(issueId) ?? [];
    list.push(label);
    result.set(issueId, list);
  }
  for (const list of result.values())
    list.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

/** Validates that every id names a label; returns them deduplicated. */
export async function requireLabels(
  conn: Conn,
  labelIds: readonly string[],
): Promise<string[]> {
  const wanted = unique(labelIds);
  if (wanted.length === 0) return [];
  const rows = await conn.query
    .selectFrom('issueLabels')
    .select('id')
    .where('id', 'in', wanted)
    .execute();
  if (rows.length !== wanted.length)
    throw invalid('INVALID_LABEL', 'labelIds contains an unknown label.');
  return wanted;
}

/** Replaces an issue's label set; returns what changed. */
export async function setIssueLabels(
  tx: Tx,
  ids: IdSource,
  issueId: string,
  labelIds: readonly string[],
): Promise<{ added: string[]; removed: string[] }> {
  const current = (
    await tx.conn.query
      .selectFrom('issueLabelLinks')
      .select('labelId')
      .where('issueId', '=', issueId)
      .execute()
  ).map((row) => str(row.labelId) ?? '');
  const added = labelIds.filter((id) => !current.includes(id));
  const removed = current.filter((id) => !labelIds.includes(id));
  if (removed.length > 0) {
    await tx.conn.query
      .deleteFrom('issueLabelLinks')
      .where('issueId', '=', issueId)
      .where('labelId', 'in', removed)
      .execute();
  }
  if (added.length > 0) {
    const createdAt = now();
    await tx.conn.query
      .insertInto('issueLabelLinks')
      .values(
        added.map((labelId) => ({
          id: ids.next(),
          issueId,
          labelId,
          createdAt,
        })),
      )
      .execute();
  }
  return { added, removed };
}

/** Label ids for names, creating missing labels (gray). Used by agents, which address labels by name. */
export async function ensureLabelsByName(
  tx: Tx,
  ids: IdSource,
  names: readonly string[],
): Promise<string[]> {
  const result: string[] = [];
  for (const raw of unique(names.map((name) => name.trim()))) {
    const name = requiredName(raw, MAX_LABEL_NAME);
    const existing = await tx.conn.query
      .selectFrom('issueLabels')
      .select('id')
      .where('name', '=', name)
      .executeTakeFirst();
    if (existing) {
      result.push(str(existing.id) ?? '');
      continue;
    }
    const id = ids.next();
    const timestamp = now();
    await tx.conn.query
      .insertInto('issueLabels')
      .values({
        id,
        name,
        color: 'gray',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .execute();
    result.push(id);
  }
  return unique(result);
}

export function createLabelService(deps: {
  tx: TxRunner;
  ids: IdSource;
}): LabelService {
  async function get(conn: Conn, id: string): Promise<Label> {
    const row = await conn.query
      .selectFrom('issueLabels')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw notFound('Label');
    return mapLabel(row);
  }

  function duplicate(error: unknown): never {
    if (isUniqueViolation(error))
      throw conflict('LABEL_EXISTS', 'A label with this name already exists.');
    throw error;
  }

  return {
    async list() {
      const rows = await deps.tx
        .read()
        .query.selectFrom('issueLabels')
        .selectAll()
        .orderBy('name', 'asc')
        .execute();
      return rows.map(mapLabel);
    },

    async create(actor, input) {
      const name = requiredName(input?.name, MAX_LABEL_NAME);
      const color =
        input.color === undefined ? 'gray' : validateLabelColor(input.color);
      const id = deps.ids.next();
      await requireLabelManager(deps.tx.read(), actor);
      try {
        await deps.tx.run(async (tx) => {
          const timestamp = now();
          await tx.conn.query
            .insertInto('issueLabels')
            .values({
              id,
              name,
              color,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .execute();
        });
      } catch (error) {
        duplicate(error);
      }
      return { id, name, color };
    },

    async update(actor, id, patch) {
      const values: Record<string, unknown> = {};
      if (patch?.name !== undefined)
        values.name = requiredName(patch.name, MAX_LABEL_NAME);
      if (patch?.color !== undefined)
        values.color = validateLabelColor(patch.color);
      await requireLabelManager(deps.tx.read(), actor);
      try {
        await deps.tx.run(async (tx) => {
          await get(tx.conn, id);
          if (Object.keys(values).length === 0) return;
          await tx.conn.query
            .updateTable('issueLabels')
            .set({ ...values, updatedAt: now() })
            .where('id', '=', id)
            .execute();
        });
      } catch (error) {
        duplicate(error);
      }
      return get(deps.tx.read(), id);
    },

    async remove(actor, id) {
      await requireLabelManager(deps.tx.read(), actor);
      await deps.tx.run(async (tx) => {
        await get(tx.conn, id);
        const linked = await tx.conn.query
          .selectFrom('issueLabelLinks')
          .select('issueId')
          .where('labelId', '=', id)
          .execute();
        await tx.conn.query
          .deleteFrom('issueLabelLinks')
          .where('labelId', '=', id)
          .execute();
        await tx.conn.query
          .deleteFrom('issueLabels')
          .where('id', '=', id)
          .execute();
        for (const row of linked)
          tx.emit({ type: 'issue.changed', issueId: str(row.issueId) ?? '' });
      });
    },
  };
}
