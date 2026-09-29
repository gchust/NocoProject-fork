import { requireCapability } from '../agent/capabilities.js';
/**
 * Issue checklists (NP-77 proposal §1, §6): a `checklist` stage action snapshots its items into `issueChecklistItems`
 * when the issue enters the status; leaving that status for anything but a `closed` status requires every required
 * item to be checked (409 `CHECKLIST_INCOMPLETE`, checked by `stage-guards.ts`).
 *
 * Re-entering a status keeps the rows already there (and whether they are checked) and adds items the definition
 * gained since; items the definition dropped stay in the snapshot. Members who can see the issue, and the agent of
 * the issue's run, check and uncheck items; each change records `checklist_item_checked` / `_unchecked`.
 */
import type { Actor, ActivityRecorder } from '../shared/activity.js';
import { requireVisibleIssue, viewerOf } from '../shared/authz.js';
import type { Conn, Tx, TxRunner } from '../shared/db.js';
import { bool, isoOrNull, now, num, str } from '../shared/db.js';
import { forbidden, invalid, notFound } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import type {
  IssueChecklist,
  IssueChecklistItem,
  IssueV1,
  StageChecklistItemDefinition,
  UpdateChecklistItemRequest,
} from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import { agentReadableIssue } from '../issue/issue.extras.js';
import { findIssue } from '../issue/issue.records.js';
import { agentNames } from '../run/run.queries.js';
import type { RunAuth } from '../run/token.js';

export interface ChecklistService {
  list(actor: Actor, idOrKey: string): Promise<IssueChecklist[]>;
  agentList(auth: RunAuth, idOrKey: string): Promise<IssueChecklist[]>;
  set(
    actor: Actor,
    idOrKey: string,
    statusKey: string,
    itemKey: string,
    input: UpdateChecklistItemRequest,
  ): Promise<IssueChecklist>;
  /** Only on the run's own issue (403 `ISSUE_NOT_IN_RUN` otherwise). */
  agentSet(
    auth: RunAuth,
    idOrKey: string,
    statusKey: string,
    itemKey: string,
    input: UpdateChecklistItemRequest,
  ): Promise<IssueChecklist>;
}

export interface ChecklistDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly users: UserDirectory;
  readonly activity: ActivityRecorder;
}

/** Inserts the items of `statusKey` that the issue's snapshot does not have yet. Returns how many were added. */
export async function generateChecklist(
  tx: Tx,
  ids: IdSource,
  issueId: string,
  statusKey: string,
  items: readonly StageChecklistItemDefinition[],
): Promise<number> {
  const existing = await tx.conn.query
    .selectFrom('issueChecklistItems')
    .select('itemKey')
    .where('issueId', '=', issueId)
    .where('statusKey', '=', statusKey)
    .execute();
  const have = new Set(existing.map((row) => str(row.itemKey)));
  const timestamp = now();
  let added = 0;
  for (const [position, item] of items.entries()) {
    if (have.has(item.key)) continue;
    await tx.conn.query
      .insertInto('issueChecklistItems')
      .values({
        id: ids.next(),
        issueId,
        statusKey,
        itemKey: item.key,
        label: item.label,
        required: item.required,
        position,
        checkedByType: null,
        checkedById: null,
        checkedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .execute();
    added += 1;
  }
  return added;
}

/** Labels of the required, unchecked items of the issue's `statusKey` snapshot. */
export async function incompleteRequiredItems(
  conn: Conn,
  issueId: string,
  statusKey: string,
): Promise<string[]> {
  const rows = await conn.query
    .selectFrom('issueChecklistItems')
    .select(['label', 'position'])
    .where('issueId', '=', issueId)
    .where('statusKey', '=', statusKey)
    .where('required', '=', true)
    .where('checkedAt', 'is', null)
    .orderBy('position', 'asc')
    .execute();
  return rows.map((row) => str(row.label) ?? '');
}

async function checkerNames(
  conn: Conn,
  users: UserDirectory,
  rows: readonly Record<string, unknown>[],
): Promise<Map<string, string>> {
  const byType = (type: string) =>
    rows
      .filter((row) => row.checkedByType === type)
      .map((row) => str(row.checkedById));
  const names = new Map<string, string>();
  for (const [id, name] of await users.names(conn, byType('user')))
    names.set(`user:${id}`, name);
  for (const [id, name] of await agentNames(conn, byType('agent')))
    names.set(`agent:${id}`, name);
  return names;
}

function mapItem(
  row: Record<string, unknown>,
  names: Map<string, string>,
): IssueChecklistItem {
  const type = str(row.checkedByType);
  const checkedByType = type === 'user' || type === 'agent' ? type : null;
  const checkedById = str(row.checkedById);
  return {
    itemKey: str(row.itemKey) ?? '',
    label: str(row.label) ?? '',
    required: bool(row.required),
    checked: row.checkedAt !== null && row.checkedAt !== undefined,
    checkedByType,
    checkedById,
    checkedByName:
      checkedByType && checkedById
        ? (names.get(`${checkedByType}:${checkedById}`) ?? null)
        : null,
    checkedAt: isoOrNull(row.checkedAt),
  };
}

/** Every checklist snapshot of the issue: the current status first, then by creation. */
export async function checklistsOf(
  conn: Conn,
  users: UserDirectory,
  issue: Pick<IssueV1, 'id' | 'statusKey'>,
  onlyStatus?: string,
): Promise<IssueChecklist[]> {
  let query = conn.query
    .selectFrom('issueChecklistItems')
    .selectAll()
    .where('issueId', '=', issue.id);
  if (onlyStatus) query = query.where('statusKey', '=', onlyStatus);
  const rows = await query
    .orderBy('createdAt', 'asc')
    .orderBy('position', 'asc')
    .execute();
  const names = await checkerNames(conn, users, rows);
  const groups = new Map<string, IssueChecklistItem[]>();
  for (const row of rows) {
    const key = str(row.statusKey) ?? '';
    const items = groups.get(key) ?? [];
    items.push(mapItem(row, names));
    groups.set(key, items);
  }
  const lists = Array.from(groups, ([statusKey, items]) => ({
    statusKey,
    current: statusKey === issue.statusKey,
    complete: items.every((item) => !item.required || item.checked),
    items,
  }));
  return [
    ...lists.filter((list) => list.current),
    ...lists.filter((list) => !list.current),
  ];
}

/** The unchecked items of the issue's current status, for the claim payload (null without a checklist). */
export async function currentChecklist(
  conn: Conn,
  users: UserDirectory,
  issue: Pick<IssueV1, 'id' | 'statusKey'>,
): Promise<IssueChecklist | null> {
  const [list] = await checklistsOf(conn, users, issue, issue.statusKey);
  return list ?? null;
}

async function setItem(
  deps: ChecklistDeps,
  tx: Tx,
  issue: IssueV1,
  actor: Actor,
  target: {
    statusKey: string;
    itemKey: string;
    input: UpdateChecklistItemRequest;
  },
): Promise<IssueChecklist> {
  const checked = target.input?.checked;
  if (typeof checked !== 'boolean')
    throw invalid('INVALID_FIELD', 'checked must be a boolean.');
  const row = await tx.conn.query
    .selectFrom('issueChecklistItems')
    .selectAll()
    .where('issueId', '=', issue.id)
    .where('statusKey', '=', target.statusKey)
    .where('itemKey', '=', target.itemKey)
    .executeTakeFirst();
  if (!row) throw notFound('Checklist item');
  const wasChecked = row.checkedAt !== null && row.checkedAt !== undefined;
  if (wasChecked !== checked) {
    const timestamp = now();
    await tx.conn.query
      .updateTable('issueChecklistItems')
      .set({
        checkedByType: checked ? actor.type : null,
        checkedById: checked ? actor.id : null,
        checkedAt: checked ? timestamp : null,
        updatedAt: timestamp,
      })
      .where('id', '=', str(row.id) ?? '')
      .execute();
    await deps.activity.record(tx.conn, {
      issueId: issue.id,
      actor,
      action: checked ? 'checklist_item_checked' : 'checklist_item_unchecked',
      details: {
        statusKey: target.statusKey,
        itemKey: target.itemKey,
        label: str(row.label),
        required: bool(row.required),
        position: num(row.position),
      },
    });
    tx.emit({ type: 'issue.changed', issueId: issue.id });
  }
  const [list] = await checklistsOf(
    tx.conn,
    deps.users,
    issue,
    target.statusKey,
  );
  return list;
}

export function createChecklistService(deps: ChecklistDeps): ChecklistService {
  return {
    async list(actor, idOrKey) {
      const conn = deps.tx.read();
      const issue = await requireVisibleIssue(
        conn,
        await viewerOf(conn, actor),
        idOrKey,
      );
      return checklistsOf(conn, deps.users, issue);
    },
    async agentList(auth, idOrKey) {
      const conn = deps.tx.read();
      return checklistsOf(
        conn,
        deps.users,
        await agentReadableIssue(conn, auth, idOrKey),
      );
    },
    set: (actor, idOrKey, statusKey, itemKey, input) =>
      deps.tx.run(async (tx) => {
        const issue = await requireVisibleIssue(
          tx.conn,
          await viewerOf(tx.conn, actor),
          idOrKey,
        );
        return setItem(deps, tx, issue, actor, { statusKey, itemKey, input });
      }),
    agentSet: (auth, idOrKey, statusKey, itemKey, input) =>
      deps.tx.run(async (tx) => {
        await requireCapability(tx.conn, auth, 'checklist.write');
        const issue = await findIssue(tx.conn, idOrKey);
        if (!issue) throw notFound('Issue');
        if (issue.id !== auth.issueId)
          throw forbidden(
            'ISSUE_NOT_IN_RUN',
            'A run token may only write to its own issue.',
          );
        const actor: Actor = {
          type: 'agent',
          id: auth.agentId,
          runId: auth.runId,
        };
        return setItem(deps, tx, issue, actor, { statusKey, itemKey, input });
      }),
  };
}
