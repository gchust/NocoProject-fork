import type { AgentEntryBindings } from '../shared/protocol.capabilities.js';
import { EMPTY_ENTRIES } from './agent-entries.js';
/**
 * The single `systemSettings` row: the issue prefix, the issue counter and (iteration 1) the `settings` json.
 * Iteration 2 adds `modelPrices` and `intakeParser` to the json, iteration 3 `metricThresholds`, iteration 4
 * `defaultProcess`, `pmAgentId` and `retrospectiveOnDone`, Phase 2 (NP-77) `stageRunLimit` and `stageRunWindowHours`;
 * missing keys read as their defaults.
 */
import type { Conn } from '../shared/db.js';
import {
  fromJson,
  isPostgres,
  knexOf,
  num,
  rawRows,
  str,
  toJson,
} from '../shared/db.js';
import type {
  DefaultProcess,
  IntakeParserSetting,
  MetricThresholds,
  ModelPrice,
} from '../shared/protocol.js';
import {
  DEFAULT_METRIC_THRESHOLDS,
  DEFAULT_STAGE_RUN_LIMIT,
  DEFAULT_STAGE_RUN_WINDOW_HOURS,
  METRIC_THRESHOLD_KEYS,
} from '../shared/protocol.js';

export const SETTINGS_ID = 'default';
const DEFAULT_PREFIX = 'NP';

export interface AllocatedIssueNumber {
  readonly number: number;
  readonly identifier: string;
}

/** `systemSettings.settings` (contract §A); missing keys take these defaults. */
export interface WorkspaceSettings {
  readonly agentEntries: AgentEntryBindings;
  readonly autoExecuteSubtasksDefault: boolean;
  /** PR merged → this status; `'none'` leaves the status alone (iteration 2). */
  readonly prMergedStatus: string;
  readonly modelPrices: readonly ModelPrice[];
  readonly intakeParser: IntakeParserSetting;
  /** Iteration 3: acceptance metric thresholds (missing keys take the defaults). */
  readonly metricThresholds: MetricThresholds;
  /** Iteration 4: the process of a new issue that names none (`auto` = the classifier). */
  readonly defaultProcess: DefaultProcess;
  /** Iteration 4: the project manager agent (conversations and retrospectives), or null. */
  readonly pmAgentId: string | null;
  /** Iteration 4: a done issue an agent worked on gets a retrospective run of the project manager. */
  readonly retrospectiveOnDone: boolean;
  /** Phase 2: at most this many `runExecutor` stage runs per issue and status within `stageRunWindowHours`. */
  readonly stageRunLimit: number;
  readonly stageRunWindowHours: number;
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  agentEntries: EMPTY_ENTRIES,
  autoExecuteSubtasksDefault: false,
  prMergedStatus: 'done',
  modelPrices: [],
  intakeParser: 'auto',
  metricThresholds: DEFAULT_METRIC_THRESHOLDS,
  defaultProcess: 'auto',
  pmAgentId: null,
  retrospectiveOnDone: true,
  stageRunLimit: DEFAULT_STAGE_RUN_LIMIT,
  stageRunWindowHours: DEFAULT_STAGE_RUN_WINDOW_HOURS,
};

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function normalizeThresholds(value: unknown): MetricThresholds {
  const stored = (value && typeof value === 'object' ? value : {}) as Partial<
    Record<keyof MetricThresholds, unknown>
  >;
  const result: Record<keyof MetricThresholds, number> = {
    ...DEFAULT_METRIC_THRESHOLDS,
  };
  for (const key of METRIC_THRESHOLD_KEYS) {
    const candidate = stored[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate))
      result[key] = candidate;
  }
  return result;
}

export interface SettingsService {
  read(conn: Conn): Promise<WorkspaceSettings>;
  /** Merges `patch` into the stored json (already validated by the caller). */
  write(
    conn: Conn,
    patch: Partial<WorkspaceSettings>,
  ): Promise<WorkspaceSettings>;
  issuePrefix(conn: Conn): Promise<string>;
  /**
   * Allocates the next issue number. Must run inside the caller's transaction: on PostgreSQL the counter row stays
   * locked by `UPDATE … RETURNING` until that transaction ends, so concurrent creates are serialized and numbers are
   * never reused — a rolled-back create releases its number.
   */
  allocateIssueNumber(conn: Conn): Promise<AllocatedIssueNumber>;
}

interface CounterRow {
  readonly issue_counter: unknown;
  readonly issue_prefix: unknown;
}

async function incrementPostgres(conn: Conn): Promise<CounterRow | undefined> {
  const knex = await knexOf(conn);
  const result: unknown = await knex.raw(
    'UPDATE system_settings SET issue_counter = issue_counter + 1, updated_at = now() ' +
      'WHERE id = ? RETURNING issue_counter, issue_prefix',
    [SETTINGS_ID],
  );
  return rawRows<CounterRow>(result)[0];
}

async function incrementPortable(conn: Conn): Promise<CounterRow | undefined> {
  // Other dialects: read-modify-write inside the caller's transaction. SQLite serializes writers, which is all the
  // non-PostgreSQL path (application smoke tests) needs.
  const row = await conn.query
    .selectFrom('systemSettings')
    .select(['issueCounter', 'issuePrefix'])
    .where('id', '=', SETTINGS_ID)
    .executeTakeFirst();
  if (!row) return undefined;
  const next = num(row.issueCounter) + 1;
  await conn.query
    .updateTable('systemSettings')
    .set({ issueCounter: next, updatedAt: new Date() })
    .where('id', '=', SETTINGS_ID)
    .execute();
  return { issue_counter: next, issue_prefix: row.issuePrefix };
}

function normalize(stored: Partial<WorkspaceSettings>): WorkspaceSettings {
  return {
    agentEntries: stored.agentEntries ?? EMPTY_ENTRIES,
    autoExecuteSubtasksDefault:
      typeof stored.autoExecuteSubtasksDefault === 'boolean'
        ? stored.autoExecuteSubtasksDefault
        : DEFAULT_WORKSPACE_SETTINGS.autoExecuteSubtasksDefault,
    prMergedStatus:
      typeof stored.prMergedStatus === 'string'
        ? stored.prMergedStatus
        : DEFAULT_WORKSPACE_SETTINGS.prMergedStatus,
    modelPrices: Array.isArray(stored.modelPrices)
      ? stored.modelPrices
      : DEFAULT_WORKSPACE_SETTINGS.modelPrices,
    intakeParser:
      stored.intakeParser === 'heuristic'
        ? 'heuristic'
        : DEFAULT_WORKSPACE_SETTINGS.intakeParser,
    metricThresholds: normalizeThresholds(stored.metricThresholds),
    defaultProcess:
      stored.defaultProcess === 'direct' ||
      stored.defaultProcess === 'design_first'
        ? stored.defaultProcess
        : DEFAULT_WORKSPACE_SETTINGS.defaultProcess,
    pmAgentId:
      typeof stored.pmAgentId === 'string' && stored.pmAgentId
        ? stored.pmAgentId
        : null,
    retrospectiveOnDone:
      typeof stored.retrospectiveOnDone === 'boolean'
        ? stored.retrospectiveOnDone
        : DEFAULT_WORKSPACE_SETTINGS.retrospectiveOnDone,
    stageRunLimit: positiveInt(
      stored.stageRunLimit,
      DEFAULT_WORKSPACE_SETTINGS.stageRunLimit,
    ),
    stageRunWindowHours: positiveInt(
      stored.stageRunWindowHours,
      DEFAULT_WORKSPACE_SETTINGS.stageRunWindowHours,
    ),
  };
}

async function readStored(conn: Conn): Promise<Partial<WorkspaceSettings>> {
  const row = await conn.query
    .selectFrom('systemSettings')
    .select('settings')
    .where('id', '=', SETTINGS_ID)
    .executeTakeFirst();
  return fromJson<Partial<WorkspaceSettings>>(row?.settings) ?? {};
}

export function createSettingsService(): SettingsService {
  return {
    async read(conn) {
      return normalize(await readStored(conn));
    },
    async write(conn, patch) {
      const current = await readStored(conn);
      let entries = patch.agentEntries;
      if (
        !entries &&
        (patch.pmAgentId !== undefined ||
          patch.retrospectiveOnDone !== undefined)
      ) {
        const previous = current.agentEntries ?? EMPTY_ENTRIES;
        entries = {
          ...previous,
          revision: previous.revision + 1,
          conversation: {
            ...previous.conversation,
            ...(patch.pmAgentId !== undefined
              ? { agentId: patch.pmAgentId }
              : {}),
          },
          completion: {
            ...previous.completion,
            ...(patch.pmAgentId !== undefined
              ? { agentId: patch.pmAgentId }
              : {}),
            ...(patch.retrospectiveOnDone !== undefined
              ? { enabled: patch.retrospectiveOnDone }
              : {}),
          },
        };
      }
      const next = {
        ...current,
        ...patch,
        ...(entries ? { agentEntries: entries } : {}),
      };
      await conn.query
        .updateTable('systemSettings')
        .set({ settings: toJson(next), updatedAt: new Date() })
        .where('id', '=', SETTINGS_ID)
        .execute();
      return normalize(next);
    },
    async issuePrefix(conn) {
      const row = await conn.query
        .selectFrom('systemSettings')
        .select('issuePrefix')
        .where('id', '=', SETTINGS_ID)
        .executeTakeFirst();
      return str(row?.issuePrefix) || DEFAULT_PREFIX;
    },
    async allocateIssueNumber(conn) {
      const increment = isPostgres(conn)
        ? incrementPostgres
        : incrementPortable;
      let row = await increment(conn);
      if (!row) {
        // The seed normally creates the row; recreate it rather than failing if it is missing.
        await conn.query
          .insertInto('systemSettings')
          .values({
            id: SETTINGS_ID,
            issuePrefix: DEFAULT_PREFIX,
            issueCounter: 0,
          })
          .execute();
        row = await increment(conn);
      }
      const number = num(row?.issue_counter);
      const prefix = str(row?.issue_prefix) || DEFAULT_PREFIX;
      return { number, identifier: `${prefix}-${number}` };
    },
  };
}
