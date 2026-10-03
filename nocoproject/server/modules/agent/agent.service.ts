import {
  effectiveCapabilities,
  requireRuntimeTypeCapabilities,
  validateCapabilities,
} from './capabilities.js';
import {
  requireBuiltinCatalog,
  requireBuiltinModel,
  requireRuntime,
  requireSameRuntimeType,
} from './agent.runtime-type.js';
import {
  requireFixedManagerCapabilities,
  requirePersonalPmStaysEligible,
  validateSummary,
} from './agent.pm-rules.js';
import { conflict } from '../shared/errors.js';
/**
 * Agents: a named configuration (instructions, provider, model) bound to one runtime, with an access level
 * (docs/phase1/iteration-1-contract.md §H):
 *
 * - `ownerOnly`: only the owner may assign, mention it or accept proposals for it;
 * - `specificUsers`: the owner and the users in `agentAccessGrants`;
 * - `everyone`: every member.
 *
 * An agent may bind only to a runtime the caller owns or a public runtime. Only the owner or an owner/admin may edit
 * an agent, its access list and its delegation list (`agentDelegationGrants`: agents it may hand sub-issues to
 * without a proposal). Setting a delegation target requires access to that target. Iteration 2: `skillIds` mounts
 * skills (`agentSkills`, whole-set replace); rows carry `skillIds` and `skills`. Iteration 4: `kind` (coder | manager)
 * and `reasoningEffort` (`agent.fields.ts`). NP-219: `runtimeType` (computer | builtin), required on create and
 * immutable, with the rules of `agent.runtime-type.ts` and the capability limits of `capabilities.ts`.
 */
import type { Actor, ActivityRecorder } from '../shared/activity.js';
import {
  canEditAgent,
  forbid,
  viewerOf,
  type Viewer,
} from '../shared/authz.js';
import type { Conn, Tx, TxRunner } from '../shared/db.js';
import { iso, isoOrNull, now, num, str } from '../shared/db.js';
import { invalid, notFound } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import type {
  AgentListItemV4,
  AgentPhase4Fields,
  AgentProvider,
  AgentV1,
  CreateAgentRequestV4,
  RuntimeTypeFields,
  UpdateAgentRequestV4,
} from '../shared/protocol.js';
import { validateRuntimeType } from '../shared/runtime-types.js';
import {
  noBuiltinAi,
  type BuiltinAiSource,
  type BuiltinCatalog,
} from '../runtime/builtin-ai.js';
import { loadCatalog } from '../runtime/builtin-runtime.js';
import type { UserDirectory } from '../shared/users.js';
import { optionalText, requiredName, stringList } from '../shared/validate.js';
import { removeAgent } from './agent.remove.js';
import { replaceAccessList, replaceDelegation } from './agent.grants.js';
import { decorate } from './agent.view.js';
import {
  agentKindOf,
  isAccessLevel,
  reasoningEffortOf,
  validateAccess,
  validateConcurrency,
  validateKind,
  validateReasoningEffort,
} from './agent.fields.js';
import { isAgentProvider, runtimeTypeOf } from '../runtime/runtime.records.js';
import { replaceAgentSkills } from '../skill/skill.service.js';

export const DEFAULT_MAX_CONCURRENT_RUNS = 6;

/** An agent row as the browser sees it (NP-219: with its runtime type). */
export type AgentView = AgentListItemV4 & RuntimeTypeFields;
/** `POST /np/agents` / `PATCH /np/agents/:id` bodies with NP-219's `runtimeType`. */
export type CreateAgentInput = CreateAgentRequestV4 & {
  readonly runtimeType?: unknown;
};
export type UpdateAgentInput = UpdateAgentRequestV4 & {
  readonly runtimeType?: unknown;
};

export interface AgentService {
  remove(actor: Actor, id: string): Promise<void>;
  list(actor: Actor): Promise<AgentView[]>;
  get(actor: Actor, id: string): Promise<AgentView>;
  create(actor: Actor, input: CreateAgentInput): Promise<AgentView>;
  update(actor: Actor, id: string, patch: UpdateAgentInput): Promise<AgentView>;
}

export interface AgentDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly users: UserDirectory;
  readonly activity: ActivityRecorder;
  /** NP-219: the AI plugin, for built-in agents; absent = not registered. */
  readonly ai?: BuiltinAiSource;
}

export type AgentRow = AgentV1 &
  AgentPhase4Fields &
  RuntimeTypeFields & { readonly summary: string | null };

export function mapAgent(row: Record<string, unknown>): AgentRow {
  const runtimeType = runtimeTypeOf(row.runtimeType);
  return {
    id: str(row.id) ?? '',
    name: str(row.name) ?? '',
    description: str(row.description),
    ownerUserId: str(row.ownerUserId) ?? '',
    instructions: str(row.instructions) ?? '',
    capabilities: effectiveCapabilities(row),
    summary: str(row.summary),
    configurationRevision: num(row.configurationRevision, 1),
    runtimeId: str(row.runtimeId),
    provider: (str(row.provider) ?? 'echo') as AgentProvider,
    model: str(row.model),
    maxConcurrentRuns: num(row.maxConcurrentRuns, DEFAULT_MAX_CONCURRENT_RUNS),
    access: isAccessLevel(row.access) ? row.access : 'ownerOnly',
    kind: agentKindOf(row.kind),
    // A built-in agent has no reasoning effort (§3.1).
    reasoningEffort:
      runtimeType === 'builtin' ? null : reasoningEffortOf(row.reasoningEffort),
    runtimeType,
    archivedAt: isoOrNull(row.archivedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

async function findAgent(conn: Conn, id: string): Promise<AgentRow> {
  const row = await conn.query
    .selectFrom('agents')
    .selectAll()
    .where('id', '=', id)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (!row) throw notFound('Agent');
  return mapAgent(row);
}

async function getAgent(
  deps: AgentDeps,
  actor: Actor,
  id: string,
): Promise<AgentView> {
  const conn = deps.tx.read();
  const viewer = await viewerOf(conn, actor);
  const [item] = await decorate(deps, conn, viewer, [
    await findAgent(conn, id),
  ]);
  return item;
}

async function auditConfiguration(conn: Conn, id: string) {
  const agent = await findAgent(conn, id);
  const skills = await conn.query
    .selectFrom('agentSkills')
    .select('skillId')
    .where('agentId', '=', id)
    .execute();
  const access = await conn.query
    .selectFrom('agentAccessGrants')
    .select('userId')
    .where('agentId', '=', id)
    .execute();
  const delegation = await conn.query
    .selectFrom('agentDelegationGrants')
    .select('targetAgentId')
    .where('agentId', '=', id)
    .execute();
  return {
    ...agent,
    skillIds: skills.map((row) => row.skillId),
    accessUserIds: access.map((row) => row.userId),
    delegationTargetIds: delegation.map((row) => row.targetAgentId),
  };
}

async function createAgent(
  deps: AgentDeps,
  actor: Actor,
  input: CreateAgentInput,
): Promise<AgentView> {
  const name = requiredName(input?.name);
  const runtimeType = validateRuntimeType(input.runtimeType);
  if (!isAgentProvider(input.provider))
    throw invalid('INVALID_PROVIDER', 'provider is not supported.');
  if (typeof input.instructions !== 'string')
    throw invalid('INVALID_INSTRUCTIONS', 'instructions is required.');
  const catalog =
    runtimeType === 'builtin'
      ? await requireBuiltinCatalog(deps.ai ?? noBuiltinAi)
      : null;
  const capabilities = validateCapabilities(
    input.capabilities ?? ['context.read', 'comment.create'],
  );
  requireRuntimeTypeCapabilities(runtimeType, capabilities);
  const model = optionalText(input.model, 'model', 128);
  const id = deps.ids.next();
  await deps.tx.run(async (tx) => {
    const viewer = await viewerOf(tx.conn, actor);
    const runtime = await requireRuntime(
      tx.conn,
      viewer.userId,
      input.runtimeId,
      input.provider,
      runtimeType,
    );
    if (runtimeType === 'builtin')
      requireBuiltinModel(catalog, runtime.llmService, model);
    const runtimeId = runtime.id;
    const timestamp = now();
    await tx.conn.query
      .insertInto('agents')
      .values({
        id,
        name,
        description: optionalText(input.description, 'description'),
        summary: validateSummary((input as { summary?: unknown }).summary),
        ownerUserId: viewer.userId,
        instructions: input.instructions,
        capabilities: JSON.stringify(capabilities),
        configurationRevision: 1,
        runtimeId,
        runtimeType,
        provider: input.provider,
        model,
        maxConcurrentRuns:
          input.maxConcurrentRuns === undefined
            ? DEFAULT_MAX_CONCURRENT_RUNS
            : validateConcurrency(input.maxConcurrentRuns),
        access:
          input.access === undefined
            ? 'ownerOnly'
            : validateAccess(input.access),
        kind: input.kind === undefined ? 'coder' : validateKind(input.kind),
        reasoningEffort:
          input.reasoningEffort === undefined || runtimeType === 'builtin'
            ? null
            : validateReasoningEffort(input.reasoningEffort),
        archivedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .execute();
    if (input.accessUserIds !== undefined)
      await replaceAccessList(
        tx,
        deps.ids,
        deps.users,
        id,
        stringList(input.accessUserIds, 'accessUserIds'),
      );
    if (input.delegationTargetIds !== undefined)
      await replaceDelegation(
        tx,
        deps.ids,
        viewer,
        id,
        stringList(input.delegationTargetIds, 'delegationTargetIds'),
      );
    if (input.skillIds !== undefined)
      await replaceAgentSkills(
        tx,
        deps.ids,
        id,
        stringList(input.skillIds, 'skillIds'),
      );
    await tx.conn.query
      .insertInto('agentConfigurationChanges')
      .values({
        id: deps.ids.next(),
        agentId: id,
        actorUserId: viewer.userId,
        revision: 1,
        before: JSON.stringify(null),
        after: JSON.stringify(await auditConfiguration(tx.conn, id)),
        createdAt: now(),
      })
      .execute();
    tx.emit({ type: 'agents.changed' });
  });
  return getAgent(deps, actor, id);
}

async function patchValues(
  tx: Tx,
  viewer: Viewer,
  current: AgentRow,
  patch: UpdateAgentInput,
  catalog: BuiltinCatalog | null,
): Promise<Record<string, unknown>> {
  const values: Record<string, unknown> = {};
  const builtin = current.runtimeType === 'builtin';
  requireSameRuntimeType(current.runtimeType, patch.runtimeType);
  requireFixedManagerCapabilities(
    String(patch.kind ?? current.kind),
    patch.capabilities,
    current.runtimeType,
  );
  await requirePersonalPmStaysEligible(tx.conn, current.id, patch);
  const summary = (patch as { summary?: unknown }).summary;
  if (summary !== undefined) values.summary = validateSummary(summary);
  if (patch.capabilities !== undefined) {
    const capabilities = validateCapabilities(patch.capabilities);
    requireRuntimeTypeCapabilities(current.runtimeType, capabilities);
    values.capabilities = JSON.stringify(capabilities);
  }
  if (patch.name !== undefined) values.name = requiredName(patch.name);
  if (patch.description !== undefined)
    values.description = optionalText(patch.description, 'description');
  if (patch.instructions !== undefined) {
    if (typeof patch.instructions !== 'string')
      throw invalid('INVALID_INSTRUCTIONS', 'instructions must be a string.');
    values.instructions = patch.instructions;
  }
  if (patch.model !== undefined)
    values.model = optionalText(patch.model, 'model', 128);
  if (patch.maxConcurrentRuns !== undefined)
    values.maxConcurrentRuns = validateConcurrency(patch.maxConcurrentRuns);
  if (patch.access !== undefined) values.access = validateAccess(patch.access);
  if (patch.kind !== undefined) values.kind = validateKind(patch.kind);
  // Ignored for a built-in agent (§3.1).
  if (patch.reasoningEffort !== undefined && !builtin)
    values.reasoningEffort = validateReasoningEffort(patch.reasoningEffort);
  if (patch.provider !== undefined && !isAgentProvider(patch.provider))
    throw invalid('INVALID_PROVIDER', 'provider is not supported.');
  if (patch.provider !== undefined || patch.runtimeId !== undefined) {
    const provider = patch.provider ?? current.provider;
    values.provider = provider;
    values.runtimeId =
      patch.runtimeId === undefined || patch.runtimeId === current.runtimeId
        ? current.runtimeId
        : (
            await requireRuntime(
              tx.conn,
              viewer.userId,
              patch.runtimeId,
              provider,
              current.runtimeType,
            )
          ).id;
    if (values.runtimeId === current.runtimeId && patch.provider !== undefined)
      await requireRuntime(
        tx.conn,
        current.ownerUserId,
        current.runtimeId,
        provider,
        current.runtimeType,
      );
  }
  if (builtin)
    await requireBuiltinPatchModel(tx.conn, catalog, current, values);
  if (patch.archived !== undefined)
    values.archivedAt = patch.archived ? (current.archivedAt ?? now()) : null;
  return values;
}

/** A built-in agent whose model or runtime changes keeps a model its (new) service enables. */
async function requireBuiltinPatchModel(
  conn: Conn,
  catalog: BuiltinCatalog | null,
  current: AgentRow,
  values: Record<string, unknown>,
): Promise<void> {
  const runtimeId =
    (values.runtimeId as string | undefined) ?? current.runtimeId;
  const model =
    values.model === undefined
      ? current.model
      : (values.model as string | null);
  if (runtimeId === current.runtimeId && model === current.model) return;
  const runtime = await conn.query
    .selectFrom('runtimes')
    .select('llmService')
    .where('id', '=', runtimeId ?? '')
    .executeTakeFirst();
  requireBuiltinModel(catalog, str(runtime?.llmService), model);
}

async function updateAgent(
  deps: AgentDeps,
  actor: Actor,
  id: string,
  patch: UpdateAgentInput,
): Promise<AgentView> {
  // NP-219: the plugin's catalog is read before the transaction, when a built-in agent's model may need checking.
  const before = await findAgent(deps.tx.read(), id);
  const catalog =
    before.runtimeType === 'builtin' &&
    (patch?.model !== undefined || patch?.runtimeId !== undefined)
      ? await loadCatalog(deps.ai ?? noBuiltinAi)
      : null;
  await deps.tx.run(async (tx) => {
    const viewer = await viewerOf(tx.conn, actor);
    const current = await findAgent(tx.conn, id);
    if (!canEditAgent(viewer, current))
      forbid('Only the agent owner or an owner/admin may change this agent.');
    if (patch.configurationRevision !== current.configurationRevision)
      throw conflict(
        'CONFIGURATION_CONFLICT',
        'Reload the agent configuration before saving.',
      );
    const before = await auditConfiguration(tx.conn, id);
    const values = await patchValues(tx, viewer, current, patch ?? {}, catalog);
    values.configurationRevision = (current.configurationRevision ?? 1) + 1;
    const updated = await tx.conn.query
      .updateTable('agents')
      .set({ ...values, updatedAt: now() })
      .where('id', '=', id)
      .where('deletedAt', 'is', null)
      .where('configurationRevision', '=', current.configurationRevision ?? 1)
      .execute();
    if (Number(updated.updatedCount) === 0) {
      await findAgent(tx.conn, id);
      throw conflict('CONFIGURATION_CONFLICT', 'Agent configuration changed.');
    }
    if (patch.accessUserIds !== undefined)
      await replaceAccessList(
        tx,
        deps.ids,
        deps.users,
        id,
        stringList(patch.accessUserIds, 'accessUserIds'),
      );
    if (patch.delegationTargetIds !== undefined)
      await replaceDelegation(
        tx,
        deps.ids,
        viewer,
        id,
        stringList(patch.delegationTargetIds, 'delegationTargetIds'),
      );
    if (patch.skillIds !== undefined)
      await replaceAgentSkills(
        tx,
        deps.ids,
        id,
        stringList(patch.skillIds, 'skillIds'),
      );
    await tx.conn.query
      .insertInto('agentConfigurationChanges')
      .values({
        id: deps.ids.next(),
        agentId: id,
        actorUserId: viewer.userId,
        revision: values.configurationRevision,
        before: JSON.stringify(before),
        after: JSON.stringify(await auditConfiguration(tx.conn, id)),
        createdAt: now(),
      })
      .execute();
    tx.emit({ type: 'agents.changed' });
  });
  return getAgent(deps, actor, id);
}

export function createAgentService(deps: AgentDeps): AgentService {
  return {
    async list(actor) {
      const conn = deps.tx.read();
      const viewer = await viewerOf(conn, actor);
      const rows = await conn.query
        .selectFrom('agents')
        .selectAll()
        .where('deletedAt', 'is', null)
        .orderBy('name', 'asc')
        .execute();
      return decorate(deps, conn, viewer, rows.map(mapAgent));
    },
    get: (actor, id) => getAgent(deps, actor, id),
    remove: (actor, id) => removeAgent(deps, actor, id),
    create: (actor, input) => createAgent(deps, actor, input),
    update: (actor, id, patch) => updateAgent(deps, actor, id, patch),
  };
}
