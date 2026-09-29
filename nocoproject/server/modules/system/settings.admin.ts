import { randomUUID } from 'node:crypto';
import { validateEntries } from './agent-entries.js';
import { hasCapability } from '../agent/capabilities.js';
import { isPostgres, knexOf } from '../shared/db.js';
/**
 * `GET/PATCH /np/settings` (docs/phase1/iteration-2-contract.md §I): every member reads the workspace settings;
 * owner/admin change them. `prMergedStatus` must be `'none'` or a status of the default workflow. Iteration 3 §C adds
 * `metricThresholds` (partial updates merge over the stored thresholds). Iteration 4 adds `defaultProcess`
 * (auto | direct | design_first), `pmAgentId` (null or an accessible active agent with comment.create, 400 `INVALID_PM_AGENT`) and
 * `retrospectiveOnDone`. Phase 2 (NP-77) adds `stageRunLimit` (1–100) and `stageRunWindowHours` (1–720), the loop guard
 * of `runExecutor` stage actions, and `signalRules` (per signal kind: `enabled`, `instruction`, `maxConsecutive` 1–20;
 * a kind left out keeps its rule, 400 `INVALID_SIGNAL_RULES`).
 */
import type { Actor } from '../shared/activity.js';
import { NP_SETTINGS } from '../shared/access.js';
import { canUseSetting, requireSetting, viewerOf } from '../shared/authz.js';
import type { Conn, TxRunner } from '../shared/db.js';
import { invalid } from '../shared/errors.js';
import type {
  MetricThresholds,
  ModelPrice,
  UpdateWorkspaceSettingsRequestV6,
  WorkspaceSettingsViewV6,
} from '../shared/protocol.js';
import {
  DEFAULT_PROCESSES,
  METRIC_THRESHOLD_DIRECTIONS,
  METRIC_THRESHOLD_KEYS,
} from '../shared/protocol.js';
import { validateBoolean } from '../shared/validate.js';
import type { WorkflowService } from '../workflow/workflow.service.js';
import type { SettingsService, WorkspaceSettings } from './settings.service.js';
import { signalKindInfos, validateSignalRules } from './signal-rules.js';

const MAX_PRICES = 100;

export interface WorkspaceSettingsService {
  view(actor: Actor): Promise<WorkspaceSettingsViewV6>;
  update(
    actor: Actor,
    patch: UpdateWorkspaceSettingsRequestV6,
  ): Promise<WorkspaceSettingsViewV6>;
}

function priceNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw invalid('INVALID_MODEL_PRICE', `${field} must be a number ≥ 0.`);
  return value;
}

function priceText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128)
    throw invalid('INVALID_MODEL_PRICE', `${field} is required.`);
  return value.trim();
}

export function validateModelPrices(value: unknown): ModelPrice[] {
  if (!Array.isArray(value) || value.length > MAX_PRICES)
    throw invalid(
      'INVALID_MODEL_PRICE',
      `modelPrices must be an array of at most ${MAX_PRICES} prices.`,
    );
  return (value as unknown[]).map((item, index) => {
    const price = (item ?? {}) as Record<string, unknown>;
    const at = `modelPrices[${index}]`;
    return {
      provider: priceText(price.provider, `${at}.provider`),
      model: priceText(price.model, `${at}.model`),
      inputPerM: priceNumber(price.inputPerM, `${at}.inputPerM`),
      outputPerM: priceNumber(price.outputPerM, `${at}.outputPerM`),
      cacheReadPerM: priceNumber(
        price.cacheReadPerM ?? 0,
        `${at}.cacheReadPerM`,
      ),
      cacheWritePerM: priceNumber(
        price.cacheWritePerM ?? 0,
        `${at}.cacheWritePerM`,
      ),
    };
  });
}

const RATE_KEYS: readonly (keyof MetricThresholds)[] = [
  'aiShare',
  'proposalAcceptRate',
];

/** Iteration 3: a partial `metricThresholds` merged over the stored one; rates within [0, 1], the rest ≥ 0. */
export function validateThresholds(
  value: unknown,
  current: MetricThresholds,
): MetricThresholds {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid('INVALID_THRESHOLDS', 'metricThresholds must be an object.');
  const input = value as Record<string, unknown>;
  const result: Record<keyof MetricThresholds, number> = { ...current };
  for (const [key, raw] of Object.entries(input)) {
    if (!(METRIC_THRESHOLD_KEYS as readonly string[]).includes(key))
      throw invalid(
        'INVALID_THRESHOLDS',
        `metricThresholds.${key} is not a known threshold (${Object.keys(METRIC_THRESHOLD_DIRECTIONS).join(', ')}).`,
      );
    const threshold = key as keyof MetricThresholds;
    const max = RATE_KEYS.includes(threshold) ? 1 : Number.MAX_SAFE_INTEGER;
    if (
      typeof raw !== 'number' ||
      !Number.isFinite(raw) ||
      raw < 0 ||
      raw > max
    )
      throw invalid(
        'INVALID_THRESHOLDS',
        `metricThresholds.${key} must be a number ${max === 1 ? 'between 0 and 1' : '≥ 0'}.`,
      );
    result[threshold] = raw;
  }
  return result;
}

/** Iteration 4: null, or an accessible active agent with comment.create. */
async function validatePmAgent(
  conn: Conn,
  value: unknown,
): Promise<string | null> {
  if (value === null || value === '') return null;
  const agent =
    typeof value === 'string'
      ? await conn.query
          .selectFrom('agents')
          .select(['kind', 'archivedAt'])
          .where('id', '=', value)
          .executeTakeFirst()
      : undefined;
  if (
    !agent ||
    agent.archivedAt ||
    !(await hasCapability(conn, value as string, 'comment.create'))
  )
    throw invalid(
      'INVALID_PM_AGENT',
      'Choose an active agent with comment.create.',
    );
  return value as string;
}

/** Iteration 4 keys. */
async function phase4Values(
  conn: Conn,
  patch: UpdateWorkspaceSettingsRequestV6,
  values: { -readonly [K in keyof WorkspaceSettings]?: WorkspaceSettings[K] },
): Promise<void> {
  if (patch.defaultProcess !== undefined) {
    if (!DEFAULT_PROCESSES.includes(patch.defaultProcess))
      throw invalid(
        'INVALID_FIELD',
        'defaultProcess must be auto, direct or design_first.',
      );
    values.defaultProcess = patch.defaultProcess;
  }
  if (patch.pmAgentId !== undefined)
    values.pmAgentId = await validatePmAgent(conn, patch.pmAgentId);
  if (patch.retrospectiveOnDone !== undefined)
    values.retrospectiveOnDone = validateBoolean(
      patch.retrospectiveOnDone,
      'retrospectiveOnDone',
    );
}

function boundedInt(value: unknown, field: string, max: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > max
  )
    throw invalid('INVALID_FIELD', `${field} must be an integer 1–${max}.`);
  return value;
}

/** Phase 2 keys (the stage run loop guard). */
function phase2Values(
  patch: UpdateWorkspaceSettingsRequestV6,
  values: { -readonly [K in keyof WorkspaceSettings]?: WorkspaceSettings[K] },
): void {
  if (patch.stageRunLimit !== undefined)
    values.stageRunLimit = boundedInt(
      patch.stageRunLimit,
      'stageRunLimit',
      100,
    );
  if (patch.stageRunWindowHours !== undefined)
    values.stageRunWindowHours = boundedInt(
      patch.stageRunWindowHours,
      'stageRunWindowHours',
      720,
    );
}

async function patchValues(
  conn: Conn,
  settings: SettingsService,
  workflows: WorkflowService,
  patch: UpdateWorkspaceSettingsRequestV6,
): Promise<Partial<WorkspaceSettings>> {
  const values: {
    -readonly [K in keyof WorkspaceSettings]?: WorkspaceSettings[K];
  } = {};
  if (patch.autoExecuteSubtasksDefault !== undefined)
    values.autoExecuteSubtasksDefault = validateBoolean(
      patch.autoExecuteSubtasksDefault,
      'autoExecuteSubtasksDefault',
    );
  if (patch.prMergedStatus !== undefined) {
    const status = patch.prMergedStatus;
    const view = await workflows.defaultView(conn);
    if (
      typeof status !== 'string' ||
      (status !== 'none' && !view.isKnown(status))
    )
      throw invalid(
        'INVALID_STATUS',
        "prMergedStatus must be 'none' or a status of the default workflow.",
      );
    values.prMergedStatus = status;
  }
  if (patch.intakeParser !== undefined) {
    if (patch.intakeParser !== 'auto' && patch.intakeParser !== 'heuristic')
      throw invalid('INVALID_FIELD', 'intakeParser must be auto or heuristic.');
    values.intakeParser = patch.intakeParser;
  }
  if (patch.modelPrices !== undefined)
    values.modelPrices = validateModelPrices(patch.modelPrices);
  if (patch.metricThresholds !== undefined)
    values.metricThresholds = validateThresholds(
      patch.metricThresholds,
      (await settings.read(conn)).metricThresholds,
    );
  await phase4Values(conn, patch, values);
  phase2Values(patch, values);
  if (patch.signalRules !== undefined)
    values.signalRules = validateSignalRules(
      patch.signalRules,
      (await settings.read(conn)).signalRules,
    );
  return values;
}

export function createWorkspaceSettingsService(deps: {
  tx: TxRunner;
  settings: SettingsService;
  workflows: WorkflowService;
}): WorkspaceSettingsService {
  async function view(
    conn: Conn,
    actor: Actor,
  ): Promise<WorkspaceSettingsViewV6> {
    await viewerOf(conn, actor);
    return {
      ...(await deps.settings.read(conn)),
      issuePrefix: await deps.settings.issuePrefix(conn),
      signalKinds: signalKindInfos(),
      canEdit: await canUseSetting(conn, actor, NP_SETTINGS.general, 'update'),
    };
  }
  return {
    view: (actor) => view(deps.tx.read(), actor),
    async update(actor, patch) {
      await requireSetting(
        deps.tx.read(),
        actor,
        NP_SETTINGS.general,
        'update',
        'You may not change the workspace settings.',
      );
      await deps.tx.run(async (tx) => {
        if (isPostgres(tx.conn))
          await (
            await knexOf(tx.conn)
          ).raw('SELECT pg_advisory_xact_lock(hashtext(?))', [
            'np:agent-entries',
          ]);
        const values = await patchValues(
          tx.conn,
          deps.settings,
          deps.workflows,
          patch ?? {},
        );
        const agentEntries =
          patch.agentEntries !== undefined
            ? await validateEntries(
                tx.conn,
                patch.agentEntries,
                (await deps.settings.read(tx.conn)).agentEntries,
                actor.id ?? '',
              )
            : undefined;
        const before = await deps.settings.read(tx.conn);
        const after = await deps.settings.write(tx.conn, {
          ...values,
          ...(agentEntries ? { agentEntries } : {}),
        });
        if (
          JSON.stringify(before.agentEntries) !==
          JSON.stringify(after.agentEntries)
        )
          await tx.conn.query
            .insertInto('agentConfigurationChanges')
            .values({
              id: randomUUID(),
              agentId: '@entries',
              actorUserId: actor.id,
              revision: after.agentEntries.revision,
              before: JSON.stringify(before.agentEntries),
              after: JSON.stringify(after.agentEntries),
              createdAt: new Date(),
            })
            .execute();
        tx.emit({ type: 'agents.changed' });
      });
      return view(deps.tx.read(), actor);
    },
  };
}
