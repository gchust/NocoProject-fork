import { effectiveCapabilities, validateCapabilities } from './capabilities.js';
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
 * and `reasoningEffort` (`agent.fields.ts`).
 */
import type { Actor, ActivityRecorder } from '../shared/activity.js';
import {
  canEditAgent,
  forbid,
  invokableAgentIds,
  loadAgentAccess,
  canInvokeAgent,
  viewerOf,
  type Viewer,
} from '../shared/authz.js';
import type { Conn, Tx, TxRunner } from '../shared/db.js';
import { iso, isoOrNull, now, num, str, unique } from '../shared/db.js';
import { invalid, notFound } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import type {
  AgentListItemV4,
  AgentPhase4Fields,
  AgentProvider,
  AgentV1,
  CreateAgentRequestV4,
  UpdateAgentRequestV4,
} from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import { optionalText, requiredName, stringList } from '../shared/validate.js';
import { removeAgent } from './agent.remove.js';
import { activeRunCounts } from '../run/run.queries.js';
import {
  agentKindOf,
  isAccessLevel,
  reasoningEffortOf,
  validateAccess,
  validateConcurrency,
  validateKind,
  validateReasoningEffort,
} from './agent.fields.js';
import { isAgentProvider, isOnline } from '../runtime/runtime.records.js';
import {
  replaceAgentSkills,
  skillRefsForAgents,
} from '../skill/skill.service.js';

export const DEFAULT_MAX_CONCURRENT_RUNS = 6;

export interface AgentService {
  remove(actor: Actor, id: string): Promise<void>;
  list(actor: Actor): Promise<AgentListItemV4[]>;
  get(actor: Actor, id: string): Promise<AgentListItemV4>;
  create(actor: Actor, input: CreateAgentRequestV4): Promise<AgentListItemV4>;
  update(
    actor: Actor,
    id: string,
    patch: UpdateAgentRequestV4,
  ): Promise<AgentListItemV4>;
}

export interface AgentDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly users: UserDirectory;
  readonly activity: ActivityRecorder;
}

export function mapAgent(
  row: Record<string, unknown>,
): AgentV1 & AgentPhase4Fields & { readonly summary: string | null } {
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
    reasoningEffort: reasoningEffortOf(row.reasoningEffort),
    archivedAt: isoOrNull(row.archivedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** The runtime exists, runs `provider`, and the caller owns it or it is public. */
async function requireRuntime(
  conn: Conn,
  userId: string,
  runtimeId: unknown,
  provider: AgentProvider,
): Promise<string> {
  if (typeof runtimeId !== 'string' || runtimeId === '')
    throw invalid('INVALID_RUNTIME', 'runtimeId is required.');
  const runtime = await conn.query
    .selectFrom('runtimes')
    .select(['id', 'provider', 'ownerUserId', 'visibility'])
    .where('id', '=', runtimeId)
    .executeTakeFirst();
  if (!runtime) throw invalid('INVALID_RUNTIME', 'runtimeId does not exist.');
  if (runtime.ownerUserId !== userId && runtime.visibility !== 'public')
    forbid('Agents may only use your own runtimes or public runtimes.');
  if (runtime.provider !== provider) {
    throw invalid(
      'PROVIDER_MISMATCH',
      `Runtime ${runtimeId} runs ${String(runtime.provider)}, not ${provider}.`,
    );
  }
  return runtimeId;
}

async function replaceAccessList(
  tx: Tx,
  ids: IdSource,
  users: UserDirectory,
  agentId: string,
  userIds: readonly string[],
): Promise<void> {
  for (const userId of userIds)
    if (!(await users.exists(tx.conn, userId)))
      throw invalid('INVALID_USER', `accessUserIds: ${userId} does not exist.`);
  await tx.conn.query
    .deleteFrom('agentAccessGrants')
    .where('agentId', '=', agentId)
    .execute();
  if (userIds.length === 0) return;
  const createdAt = now();
  await tx.conn.query
    .insertInto('agentAccessGrants')
    .values(
      userIds.map((userId) => ({ id: ids.next(), agentId, userId, createdAt })),
    )
    .execute();
}

async function replaceDelegation(
  tx: Tx,
  ids: IdSource,
  viewer: Viewer,
  agentId: string,
  targetIds: readonly string[],
): Promise<void> {
  const current = new Set(
    (
      await tx.conn.query
        .selectFrom('agentDelegationGrants')
        .select('targetAgentId')
        .where('agentId', '=', agentId)
        .execute()
    ).map((row) => str(row.targetAgentId)),
  );
  for (const targetId of targetIds) {
    if (targetId === agentId)
      throw invalid(
        'INVALID_DELEGATION',
        'An agent cannot delegate to itself.',
      );
    const target = await loadAgentAccess(tx.conn, targetId);
    if (!target)
      throw invalid('INVALID_DELEGATION', `Agent ${targetId} does not exist.`);
    // Keeping an existing target needs no fresh check; adding one needs access to it.
    if (
      !current.has(targetId) &&
      !(await canInvokeAgent(tx.conn, viewer.userId, target))
    )
      forbid(`You do not have access to agent ${targetId}.`);
  }
  await tx.conn.query
    .deleteFrom('agentDelegationGrants')
    .where('agentId', '=', agentId)
    .execute();
  if (targetIds.length === 0) return;
  const createdAt = now();
  await tx.conn.query
    .insertInto('agentDelegationGrants')
    .values(
      targetIds.map((targetAgentId) => ({
        id: ids.next(),
        agentId,
        targetAgentId,
        grantedById: viewer.userId,
        createdAt,
      })),
    )
    .execute();
}

async function decorate(
  deps: AgentDeps,
  conn: Conn,
  viewer: Viewer,
  agents: readonly (AgentV1 & AgentPhase4Fields)[],
): Promise<AgentListItemV4[]> {
  const agentIds = agents.map((agent) => agent.id);
  const runtimeIds = unique(agents.map((agent) => agent.runtimeId));
  const runtimes = runtimeIds.length
    ? await conn.query
        .selectFrom('runtimes')
        .select(['id', 'name', 'status', 'lastSeenAt'])
        .where('id', 'in', runtimeIds)
        .execute()
    : [];
  const counts = await activeRunCounts(conn, 'agentId', agentIds);
  const owners = await deps.users.names(
    conn,
    agents.map((agent) => agent.ownerUserId),
  );
  const invokable = await invokableAgentIds(conn, viewer.userId, agents);
  const skills = await skillRefsForAgents(conn, agentIds);
  const grants = agentIds.length
    ? await conn.query
        .selectFrom('agentAccessGrants')
        .select(['agentId', 'userId'])
        .where('agentId', 'in', agentIds)
        .execute()
    : [];
  const delegations = agentIds.length
    ? await conn.query
        .selectFrom('agentDelegationGrants')
        .select(['agentId', 'targetAgentId'])
        .where('agentId', 'in', agentIds)
        .execute()
    : [];
  const targetNames = new Map<string, string>();
  const targetIds = unique(delegations.map((row) => str(row.targetAgentId)));
  if (targetIds.length > 0) {
    const rows = await conn.query
      .selectFrom('agents')
      .select(['id', 'name'])
      .where('id', 'in', targetIds)
      .execute();
    for (const row of rows)
      targetNames.set(str(row.id) ?? '', str(row.name) ?? '');
  }
  return agents.map((agent) => {
    const runtime = runtimes.find((row) => row.id === agent.runtimeId);
    return {
      ...agent,
      runtimeName: runtime ? str(runtime.name) : null,
      runtimeOnline: runtime
        ? isOnline(runtime.status, runtime.lastSeenAt)
        : false,
      activeRunCount: counts.get(agent.id) ?? 0,
      canInvoke: invokable.has(agent.id),
      canEdit: canEditAgent(viewer, agent),
      ownerName: owners.get(agent.ownerUserId) ?? null,
      accessUserIds: grants
        .filter((row) => row.agentId === agent.id)
        .map((row) => str(row.userId) ?? ''),
      delegationTargets: delegations
        .filter((row) => row.agentId === agent.id)
        .map((row) => {
          const id = str(row.targetAgentId) ?? '';
          return { id, name: targetNames.get(id) ?? id };
        }),
      skillIds: (skills.get(agent.id) ?? []).map((skill) => skill.id),
      skills: skills.get(agent.id) ?? [],
    };
  });
}

async function findAgent(
  conn: Conn,
  id: string,
): Promise<AgentV1 & AgentPhase4Fields> {
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
): Promise<AgentListItemV4> {
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
  input: CreateAgentRequestV4,
): Promise<AgentListItemV4> {
  const name = requiredName(input?.name);
  if (!isAgentProvider(input.provider))
    throw invalid('INVALID_PROVIDER', 'provider is not supported.');
  if (typeof input.instructions !== 'string')
    throw invalid('INVALID_INSTRUCTIONS', 'instructions is required.');
  const id = deps.ids.next();
  await deps.tx.run(async (tx) => {
    const viewer = await viewerOf(tx.conn, actor);
    const runtimeId = await requireRuntime(
      tx.conn,
      viewer.userId,
      input.runtimeId,
      input.provider,
    );
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
        capabilities: JSON.stringify(
          validateCapabilities(
            input.capabilities ?? ['context.read', 'comment.create'],
          ),
        ),
        configurationRevision: 1,
        runtimeId,
        provider: input.provider,
        model: optionalText(input.model, 'model', 128),
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
          input.reasoningEffort === undefined
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
  current: AgentV1 & AgentPhase4Fields,
  patch: UpdateAgentRequestV4,
): Promise<Record<string, unknown>> {
  const values: Record<string, unknown> = {};
  requireFixedManagerCapabilities(
    String(patch.kind ?? current.kind),
    patch.capabilities,
  );
  await requirePersonalPmStaysEligible(tx.conn, current.id, patch);
  const summary = (patch as { summary?: unknown }).summary;
  if (summary !== undefined) values.summary = validateSummary(summary);
  if (patch.capabilities !== undefined)
    values.capabilities = JSON.stringify(
      validateCapabilities(patch.capabilities),
    );
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
  if (patch.reasoningEffort !== undefined)
    values.reasoningEffort = validateReasoningEffort(patch.reasoningEffort);
  if (patch.provider !== undefined && !isAgentProvider(patch.provider))
    throw invalid('INVALID_PROVIDER', 'provider is not supported.');
  if (patch.provider !== undefined || patch.runtimeId !== undefined) {
    const provider = patch.provider ?? current.provider;
    values.provider = provider;
    values.runtimeId =
      patch.runtimeId === undefined || patch.runtimeId === current.runtimeId
        ? current.runtimeId
        : await requireRuntime(
            tx.conn,
            viewer.userId,
            patch.runtimeId,
            provider,
          );
    if (values.runtimeId === current.runtimeId && patch.provider !== undefined)
      await requireRuntime(
        tx.conn,
        current.ownerUserId,
        current.runtimeId,
        provider,
      );
  }
  if (patch.archived !== undefined)
    values.archivedAt = patch.archived ? (current.archivedAt ?? now()) : null;
  return values;
}

async function updateAgent(
  deps: AgentDeps,
  actor: Actor,
  id: string,
  patch: UpdateAgentRequestV4,
): Promise<AgentListItemV4> {
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
    const values = await patchValues(tx, viewer, current, patch ?? {});
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
