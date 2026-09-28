/**
 * Run event log (protocol.md §4 `events`): batched, idempotent on `(runId, seq)`, content truncated at 64KB.
 */
import type { TxRunner } from '../shared/db.js';
import {
  bool,
  fromJson,
  isArrayValue,
  iso,
  knexOf,
  now,
  num,
  str,
  toDate,
  toJson,
} from '../shared/db.js';
import { invalid, notFound } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import {
  RUN_EVENTS_MAX_BATCH,
  RUN_EVENT_MAX_CONTENT_BYTES,
  type DaemonEventsResponse,
  type RunEvent,
  type RunEventInput,
  type RunEventType,
  type RunEventsResponse,
} from '../shared/protocol.js';
import { findRun } from './run.records.js';

const EVENT_TYPES: readonly RunEventType[] = [
  'text',
  'thinking',
  'toolUse',
  'toolResult',
  'status',
  'error',
];
const LIST_LIMIT = 1000;

export interface RunEventService {
  append(
    runId: string,
    events: readonly RunEventInput[],
  ): Promise<DaemonEventsResponse>;
  list(runId: string, since: number | null): Promise<RunEventsResponse>;
}

/** Truncates to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateUtf8(
  value: string,
  maxBytes: number,
): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return { value, truncated: false };
  let end = maxBytes;
  // Step back over UTF-8 continuation bytes (10xxxxxx) so the cut lands on a character boundary.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { value: bytes.subarray(0, end).toString('utf8'), truncated: true };
}

function clip(value: unknown): { value: string | null; truncated: boolean } {
  if (value === undefined || value === null)
    return { value: null, truncated: false };
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return truncateUtf8(text, RUN_EVENT_MAX_CONTENT_BYTES);
}

function validate(events: readonly RunEventInput[]): void {
  if (!isArrayValue(events))
    throw invalid('INVALID_EVENTS', 'events must be an array.');
  if (events.length > RUN_EVENTS_MAX_BATCH) {
    throw invalid(
      'BATCH_TOO_LARGE',
      `At most ${RUN_EVENTS_MAX_BATCH} events per batch.`,
    );
  }
  for (const event of events) {
    if (!Number.isInteger(event?.seq) || event.seq < 0) {
      throw invalid(
        'INVALID_EVENT',
        'Every event needs a non-negative integer seq.',
      );
    }
    if (!EVENT_TYPES.includes(event.type)) {
      throw invalid(
        'INVALID_EVENT',
        `Unknown event type "${String(event.type)}".`,
      );
    }
  }
}

function toPhysicalRow(
  ids: IdSource,
  runId: string,
  event: RunEventInput,
): Record<string, unknown> {
  const content = clip(event.content);
  const output = clip(event.output);
  return {
    id: ids.next(),
    run_id: runId,
    seq: event.seq,
    type: event.type,
    tool: event.tool ? event.tool.slice(0, 255) : null,
    content: content.value,
    input: toJson(event.input ?? null),
    output: output.value,
    truncated:
      event.truncated === true || content.truncated || output.truncated,
    at: toDate(event.at) ?? now(),
  };
}

export function mapRunEvent(row: Record<string, unknown>): RunEvent {
  return {
    id: str(row.id) ?? '',
    runId: str(row.runId) ?? '',
    seq: num(row.seq),
    type: (str(row.type) ?? 'text') as RunEventType,
    tool: str(row.tool),
    content: str(row.content),
    input: fromJson<unknown>(row.input),
    output: str(row.output),
    truncated: bool(row.truncated),
    at: iso(row.at),
  };
}

export function createRunEventService(deps: {
  tx: TxRunner;
  ids: IdSource;
}): RunEventService {
  async function lastSeq(runId: string): Promise<number> {
    const row = await deps.tx
      .read()
      .query.selectFrom('runEvents')
      .select((eb) => [eb.fn.max('seq').as('last')])
      .where('runId', '=', runId)
      .executeTakeFirst();
    return row?.last === null || row?.last === undefined
      ? -1
      : num(row.last, -1);
  }

  return {
    async append(runId, events) {
      validate(events);
      const run = await findRun(deps.tx.read(), runId);
      if (!run) throw notFound('Run');
      if (events.length === 0)
        return { accepted: 0, last: await lastSeq(runId) };
      const rows = events.map((event) => toPhysicalRow(deps.ids, runId, event));
      // The QueryAdapter has no ON CONFLICT; Knex's `onConflict().ignore()` makes a repeated seq a no-op on both
      // PostgreSQL and SQLite. Physical names because this is raw Knex.
      const accepted = await deps.tx.run(async (tx) => {
        const knex = await knexOf(tx.conn);
        const inserted: unknown = await knex('run_events')
          .insert(rows)
          .onConflict(['run_id', 'seq'])
          .ignore()
          .returning('id');
        const maxRow = await tx.conn.query
          .selectFrom('runEvents')
          .select((eb) => [eb.fn.max('seq').as('last')])
          .where('runId', '=', runId)
          .executeTakeFirst();
        const last = num(maxRow?.last, -1);
        tx.emit({ type: 'run.events', runId, last });
        return { count: Array.isArray(inserted) ? inserted.length : 0, last };
      });
      return { accepted: accepted.count, last: accepted.last };
    },

    async list(runId, since) {
      const run = await findRun(deps.tx.read(), runId);
      if (!run) throw notFound('Run');
      const floor = since ?? -1;
      const rows = await deps.tx
        .read()
        .query.selectFrom('runEvents')
        .selectAll()
        .where('runId', '=', runId)
        .where('seq', '>', floor)
        .orderBy('seq', 'asc')
        .limit(LIST_LIMIT)
        .execute();
      const data = rows.map(mapRunEvent);
      const last =
        data.length > 0 ? (data[data.length - 1]?.seq ?? floor) : floor;
      return { data, last };
    },
  };
}
