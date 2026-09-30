/**
 * Token usage and estimated cost (docs/phase1/iteration-2-contract.md §I).
 *
 * Source rows are `runUsage` (one per completed run that reported usage) joined to their run and issue. Rows are
 * grouped by agent, issue, project, day (UTC, of the usage record) or model. Cost uses `settings.modelPrices`: the
 * first price whose provider matches (`*` or equal) and whose model glob matches; a usage record without a price
 * adds no cost, a row with no priced record has `estimatedCost: null`, and the totals add only priced records and
 * count `pricedRuns`. Visibility: members see usage of issues they can see; owner/admin see everything.
 */
import type { Actor } from '../shared/activity.js';
import { reportHiddenProjectIds, viewerOf } from '../shared/authz.js';
import type { Conn, TxRunner } from '../shared/db.js';
import { iso, num, str, unique } from '../shared/db.js';
import { invalid } from '../shared/errors.js';
import type {
  ModelPrice,
  UsageResponse,
  UsageRow,
} from '../shared/protocol.js';
import {
  USAGE_CONVERSATION_KEY,
  USAGE_GROUP_BYS_V5,
  type UsageGroupByV5,
} from '../shared/protocol.js';
import { isConversation } from '../shared/conversation.js';
import type { UserDirectory } from '../shared/users.js';
import { validateDate } from '../shared/validate.js';
import type { SettingsService } from '../system/settings.service.js';
import { agentNames } from '../run/run.queries.js';

const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 366;
const DAY_MS = 24 * 3600 * 1000;

export interface UsageQuery {
  readonly from?: string | null;
  readonly to?: string | null;
  readonly groupBy?: string | null;
  readonly projectId?: string | null;
  readonly agentId?: string | null;
  readonly issueId?: string | null;
}

export interface UsageService {
  query(actor: Actor, query: UsageQuery): Promise<UsageResponse>;
}

export interface UsageRecord {
  readonly runId: string;
  readonly agentId: string;
  readonly issueId: string;
  readonly projectId: string | null;
  /** NP-183: the member the run acted for, and whether it was a project manager conversation run. */
  readonly actorUserId?: string | null;
  readonly conversation?: boolean;
  readonly provider: string;
  readonly model: string | null;
  readonly day: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'iu');
}

/** The first price matching the provider (`*` or equal, case-insensitive) and the model glob. */
export function priceFor(
  prices: readonly ModelPrice[],
  provider: string,
  model: string | null,
): ModelPrice | null {
  for (const price of prices) {
    const providerOk =
      price.provider === '*' ||
      price.provider.toLowerCase() === provider.toLowerCase();
    if (providerOk && globToRegExp(price.model).test(model ?? '')) return price;
  }
  return null;
}

/** Dollars for one record at a price (prices are per million tokens). */
export function costOf(price: ModelPrice, record: UsageRecord): number {
  return (
    (record.inputTokens * price.inputPerM +
      record.outputTokens * price.outputPerM +
      record.cacheReadTokens * price.cacheReadPerM +
      record.cacheWriteTokens * price.cacheWritePerM) /
    1_000_000
  );
}

function keyOf(record: UsageRecord, groupBy: UsageGroupByV5): string {
  switch (groupBy) {
    case 'agent':
      return record.agentId;
    case 'issue':
      return record.issueId;
    case 'project':
      return record.projectId ?? 'none';
    case 'day':
      return record.day;
    case 'actor':
      return record.actorUserId ?? 'none';
    case 'conversation':
      return record.conversation ? USAGE_CONVERSATION_KEY : record.agentId;
    default:
      return record.model ?? 'unknown';
  }
}

interface Accumulator {
  runs: Set<string>;
  pricedRuns: Set<string>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  priced: boolean;
}

function emptyAccumulator(): Accumulator {
  return {
    runs: new Set(),
    pricedRuns: new Set(),
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    priced: false,
  };
}

function add(
  acc: Accumulator,
  record: UsageRecord,
  price: ModelPrice | null,
): void {
  acc.runs.add(record.runId);
  acc.inputTokens += record.inputTokens;
  acc.outputTokens += record.outputTokens;
  acc.cacheReadTokens += record.cacheReadTokens;
  acc.cacheWriteTokens += record.cacheWriteTokens;
  if (price) {
    acc.cost += costOf(price, record);
    acc.priced = true;
    acc.pricedRuns.add(record.runId);
  }
}

function toRow(key: string, name: string, acc: Accumulator): UsageRow {
  return {
    key,
    name,
    runs: acc.runs.size,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cacheReadTokens: acc.cacheReadTokens,
    cacheWriteTokens: acc.cacheWriteTokens,
    estimatedCost: acc.priced ? Math.round(acc.cost * 1e6) / 1e6 : null,
  };
}

/** Groups records; `names` maps a group key to its display name (the key itself when missing). */
export function aggregateUsage(
  records: readonly UsageRecord[],
  groupBy: UsageGroupByV5,
  prices: readonly ModelPrice[],
  names: ReadonlyMap<string, string> = new Map(),
): UsageResponse {
  const groups = new Map<string, Accumulator>();
  const total = emptyAccumulator();
  for (const record of records) {
    const price = priceFor(prices, record.provider, record.model);
    const key = keyOf(record, groupBy);
    const acc = groups.get(key) ?? emptyAccumulator();
    groups.set(key, acc);
    add(acc, record, price);
    add(total, record, price);
  }
  const rows = Array.from(groups.entries()).map(([key, acc]) =>
    toRow(key, names.get(key) ?? key, acc),
  );
  rows.sort((a, b) =>
    groupBy === 'day'
      ? a.key.localeCompare(b.key)
      : b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
  );
  return {
    rows,
    totals: {
      ...toRow('total', 'total', total),
      pricedRuns: total.pricedRuns.size,
    },
  };
}

interface RecordFilter {
  readonly from?: Date;
  readonly to?: Date;
  readonly issueId?: string;
}

/** Usage records joined to their run and issue (issues that no longer exist are dropped). */
export async function usageRecords(
  conn: Conn,
  filter: RecordFilter,
): Promise<UsageRecord[]> {
  let runIds: string[] | null = null;
  if (filter.issueId) {
    const runs = await conn.query
      .selectFrom('runs')
      .select('id')
      .where('subjectId', '=', filter.issueId)
      .execute();
    runIds = runs.map((row) => String(row.id));
    if (runIds.length === 0) return [];
  }
  let query = conn.query.selectFrom('runUsage').selectAll();
  if (filter.from) query = query.where('createdAt', '>=', filter.from);
  if (filter.to) query = query.where('createdAt', '<', filter.to);
  if (runIds) query = query.where('runId', 'in', runIds);
  const usage = await query.execute();
  if (usage.length === 0) return [];
  const runs = await conn.query
    .selectFrom('runs')
    .select(['id', 'agentId', 'subjectId', 'actorUserId'])
    .where('id', 'in', unique(usage.map((row) => str(row.runId))))
    .execute();
  const runById = new Map(runs.map((row) => [str(row.id) ?? '', row]));
  const issues = await conn.query
    .selectFrom('issues')
    .select(['id', 'projectId', 'originType'])
    .where('id', 'in', unique(runs.map((row) => str(row.subjectId))))
    .execute();
  const conversations = new Set(
    issues.filter(isConversation).map((row) => str(row.id) ?? ''),
  );
  const projectOf = new Map(
    issues.map((row) => [str(row.id) ?? '', str(row.projectId)]),
  );
  const result: UsageRecord[] = [];
  for (const row of usage) {
    const run = runById.get(str(row.runId) ?? '');
    const issueId = run ? (str(run.subjectId) ?? '') : '';
    if (!run || !projectOf.has(issueId)) continue;
    result.push({
      runId: str(row.runId) ?? '',
      agentId: str(run.agentId) ?? '',
      issueId,
      projectId: projectOf.get(issueId) ?? null,
      actorUserId: str(run.actorUserId),
      conversation: conversations.has(issueId),
      provider: str(row.provider) ?? '',
      model: str(row.model),
      day: iso(row.createdAt).slice(0, 10),
      inputTokens: num(row.inputTokens),
      outputTokens: num(row.outputTokens),
      cacheReadTokens: num(row.cacheReadTokens),
      cacheWriteTokens: num(row.cacheWriteTokens),
    });
  }
  return result;
}

/** The total usage of one issue (for its detail view). */
export async function usageForIssue(
  conn: Conn,
  issueId: string,
  prices: readonly ModelPrice[],
): Promise<UsageRow> {
  const records = await usageRecords(conn, { issueId });
  const { totals } = aggregateUsage(records, 'issue', prices);
  return {
    ...totals,
    key: issueId,
    name: issueId,
    pricedRuns: totals.pricedRuns,
  };
}

function dateRange(query: UsageQuery): { from: Date; to: Date } {
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const toDay = query.to ? validateDate(query.to, 'to') : null;
  const fromDay = query.from ? validateDate(query.from, 'from') : null;
  const to = toDay
    ? new Date(new Date(`${toDay}T00:00:00Z`).getTime() + DAY_MS)
    : new Date(today.getTime() + DAY_MS);
  const from = fromDay
    ? new Date(`${fromDay}T00:00:00Z`)
    : new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
  if (from >= to) throw invalid('INVALID_RANGE', 'from must not be after to.');
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS)
    throw invalid(
      'INVALID_RANGE',
      `The range is at most ${MAX_RANGE_DAYS} days.`,
    );
  return { from, to };
}

async function groupNames(
  conn: Conn,
  users: UserDirectory,
  groupBy: UsageGroupByV5,
  keys: readonly string[],
): Promise<Map<string, string>> {
  if (groupBy === 'agent') return agentNames(conn, keys);
  if (groupBy === 'conversation')
    return agentNames(
      conn,
      keys.filter((key) => key !== USAGE_CONVERSATION_KEY),
    );
  if (groupBy === 'actor') return users.names(conn, keys);
  const ids = keys.filter((key) => key !== 'none');
  if (ids.length === 0) return new Map();
  if (groupBy === 'issue') {
    const rows = await conn.query
      .selectFrom('issues')
      .select(['id', 'identifier', 'title'])
      .where('id', 'in', ids)
      .execute();
    return new Map(
      rows.map((row) => [
        str(row.id) ?? '',
        `${str(row.identifier) ?? ''} ${str(row.title) ?? ''}`.trim(),
      ]),
    );
  }
  if (groupBy === 'project') {
    const rows = await conn.query
      .selectFrom('projects')
      .select(['id', 'name'])
      .where('id', 'in', ids)
      .execute();
    return new Map(rows.map((row) => [str(row.id) ?? '', str(row.name) ?? '']));
  }
  return new Map();
}

export function createUsageService(deps: {
  tx: TxRunner;
  settings: SettingsService;
  users: UserDirectory;
}): UsageService {
  return {
    async query(actor, query) {
      const groupBy = (query.groupBy ?? 'agent') as UsageGroupByV5;
      if (!USAGE_GROUP_BYS_V5.includes(groupBy))
        throw invalid(
          'INVALID_GROUP_BY',
          `groupBy must be one of ${USAGE_GROUP_BYS_V5.join(', ')}.`,
        );
      const { from, to } = dateRange(query);
      const conn = deps.tx.read();
      const hidden = new Set(
        await reportHiddenProjectIds(conn, await viewerOf(conn, actor)),
      );
      const records = (await usageRecords(conn, { from, to })).filter(
        (record) =>
          (!record.projectId || !hidden.has(record.projectId)) &&
          (!query.projectId || record.projectId === query.projectId) &&
          (!query.agentId || record.agentId === query.agentId) &&
          (!query.issueId || record.issueId === query.issueId),
      );
      const { modelPrices } = await deps.settings.read(conn);
      const result = aggregateUsage(records, groupBy, modelPrices);
      const names = await groupNames(
        conn,
        deps.users,
        groupBy,
        result.rows.map((row) => row.key),
      );
      return {
        ...result,
        rows: result.rows.map((row) => ({
          ...row,
          name: names.get(row.key) ?? row.name,
        })),
      };
    },
  };
}
