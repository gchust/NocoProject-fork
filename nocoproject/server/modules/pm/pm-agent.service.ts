/**
 * A member's own project manager choice (NP-183, protocol-pm-assistant.md §6.2–6.4): `GET/PUT /np/me/pm-agent` and
 * `POST /np/me/pm-agent/copy-from-default`. The choice lives on the member's preferences (`members.pmAgentMode`,
 * `pmAgentId`, `preferencesRevision`) and only affects conversations created afterwards.
 */
import type { Actor } from '../shared/activity.js';
import { viewerOf } from '../shared/authz.js';
import type { Conn, Tx, TxRunner } from '../shared/db.js';
import { str } from '../shared/db.js';
import { conflict, invalid } from '../shared/errors.js';
import type {
  AgentListItemV4,
  PmAgentChoice,
  PmAgentChoiceRequest,
  PmAgentCopyRequest,
} from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import type { AgentService } from '../agent/agent.service.js';
import { preferencesOf, writePreferences } from '../member/member.service.js';
import type { SettingsService } from '../system/settings.service.js';
import {
  allowsPersonal,
  loadPmAgentFacts,
  notEligible,
  personalIneligibility,
  runtimeFitsPersonal,
  systemPmAgent,
} from './pm-agent.eligibility.js';

export interface PmAgentService {
  choice(actor: Actor): Promise<PmAgentChoice>;
  choose(actor: Actor, input: PmAgentChoiceRequest): Promise<PmAgentChoice>;
  copyFromDefault(
    actor: Actor,
    input: PmAgentCopyRequest,
  ): Promise<{ agent: AgentListItemV4; choice: PmAgentChoice }>;
  /** Used by `POST /np/pm/conversations { switchTo }` inside its transaction. */
  switchMode(tx: Tx, userId: string, mode: 'system' | 'personal'): Promise<void>;
}

export interface PmAgentDeps {
  readonly tx: TxRunner;
  readonly users: UserDirectory;
  readonly settings: SettingsService;
  readonly agents: () => AgentService;
}

async function choiceOf(
  deps: PmAgentDeps,
  conn: Conn,
  userId: string,
): Promise<PmAgentChoice> {
  const prefs = await preferencesOf(conn, userId);
  const allow = await allowsPersonal(conn, deps.settings);
  const system = await systemPmAgent(conn, deps.settings, userId);
  const mine = await conn.query
    .selectFrom('agents')
    .select('id')
    .where('ownerUserId', '=', userId)
    .where('kind', '=', 'manager')
    .where('archivedAt', 'is', null)
    .where('deletedAt', 'is', null)
    .orderBy('name', 'asc')
    .execute();
  const candidates = [];
  for (const row of mine) {
    const facts = await loadPmAgentFacts(conn, str(row.id));
    if (facts && personalIneligibility(facts, userId, true) === null)
      candidates.push({
        id: facts.id,
        name: facts.name,
        provider: facts.provider,
        model: facts.model,
        runtimeName: facts.runtime?.name ?? null,
        online: facts.runtime?.online ?? false,
      });
  }
  const runtimes = await conn.query
    .selectFrom('runtimes')
    .selectAll()
    .where((eb) =>
      eb.or([
        eb('ownerUserId', '=', userId),
        eb.and([eb('visibility', '=', 'public'), eb('pmAllowed', '=', true)]),
      ]),
    )
    .orderBy('name', 'asc')
    .execute();
  return {
    mode: prefs.pmAgentMode,
    agentId: prefs.pmAgentId,
    revision: prefs.revision,
    allowPersonal: allow,
    systemAgent: system
      ? {
          id: system.id,
          name: system.name,
          provider: system.provider,
          model: system.model,
          online: system.runtime?.online ?? false,
        }
      : null,
    candidates,
    eligibleRuntimes: runtimes.map((row) => ({
      id: str(row.id) ?? '',
      name: str(row.name) ?? '',
      online: row.status === 'online',
      shared: row.ownerUserId !== userId,
    })),
  };
}

async function choose(
  deps: PmAgentDeps,
  actor: Actor,
  input: PmAgentChoiceRequest,
): Promise<PmAgentChoice> {
  const userId = (await viewerOf(deps.tx.read(), actor)).userId;
  if (!Number.isInteger(input?.revision))
    throw invalid('REVISION_REQUIRED', 'revision is required.');
  if (input.mode !== 'system' && input.mode !== 'personal')
    throw invalid('INVALID_PREFERENCES', 'mode must be system or personal.');
  await deps.tx.run(async (tx) => {
    if (input.mode === 'personal') {
      const agentId = typeof input.agentId === 'string' ? input.agentId : null;
      const reason = personalIneligibility(
        await loadPmAgentFacts(tx.conn, agentId),
        userId,
        await allowsPersonal(tx.conn, deps.settings),
      );
      if (reason) notEligible(reason);
      await writePreferences(tx.conn, userId, input.revision, {
        pmAgentMode: 'personal',
        pmAgentId: agentId,
      });
      return;
    }
    await writePreferences(tx.conn, userId, input.revision, {
      pmAgentMode: 'system',
    });
  });
  return choiceOf(deps, deps.tx.read(), userId);
}

async function switchMode(
  deps: PmAgentDeps,
  tx: Tx,
  userId: string,
  mode: 'system' | 'personal',
): Promise<void> {
  const prefs = await preferencesOf(tx.conn, userId);
  if (mode === 'personal') {
    const reason = personalIneligibility(
      await loadPmAgentFacts(tx.conn, prefs.pmAgentId),
      userId,
      await allowsPersonal(tx.conn, deps.settings),
    );
    if (reason) notEligible(reason);
  }
  if (prefs.pmAgentMode !== mode)
    await writePreferences(tx.conn, userId, prefs.revision, {
      pmAgentMode: mode,
    });
}

async function copyFromDefault(
  deps: PmAgentDeps,
  actor: Actor,
  input: PmAgentCopyRequest,
): Promise<{ agent: AgentListItemV4; choice: PmAgentChoice }> {
  const conn = deps.tx.read();
  const userId = (await viewerOf(conn, actor)).userId;
  if (!(await allowsPersonal(conn, deps.settings))) notEligible('personalDisabled');
  const system = await systemPmAgent(conn, deps.settings, userId);
  if (!system)
    throw conflict('PM_NOT_CONFIGURED', 'No system project manager is configured.');
  const runtime = typeof input?.runtimeId === 'string'
    ? await conn.query
        .selectFrom('runtimes')
        .selectAll()
        .where('id', '=', input.runtimeId)
        .executeTakeFirst()
    : undefined;
  if (!runtime) throw invalid('INVALID_RUNTIME', 'runtimeId is required.');
  if (
    !runtimeFitsPersonal(
      {
        id: String(runtime.id),
        name: str(runtime.name) ?? '',
        ownerUserId: str(runtime.ownerUserId),
        visibility: str(runtime.visibility) ?? 'private',
        pmAllowed: !!runtime.pmAllowed,
        online: runtime.status === 'online',
        compat: 'ok',
      },
      userId,
    )
  )
    notEligible('foreignRuntime');
  const source = await conn.query
    .selectFrom('agents')
    .selectAll()
    .where('id', '=', system.id)
    .executeTakeFirst();
  const skills = await conn.query
    .selectFrom('agentSkills')
    .select('skillId')
    .where('agentId', '=', system.id)
    .execute();
  const name =
    typeof input.name === 'string' && input.name.trim()
      ? input.name.trim()
      : `${(await deps.users.names(conn, [userId])).get(userId) ?? userId} 的项目经理`;
  const agent = await deps.agents().create(actor, {
    name,
    description: null,
    instructions: '',
    runtimeId: String(runtime.id),
    provider: system.provider as never,
    model: input.model === undefined ? system.model : input.model,
    maxConcurrentRuns: Number(source?.maxConcurrentRuns ?? 1),
    access: 'ownerOnly',
    kind: 'manager',
    reasoningEffort:
      input.reasoningEffort === undefined
        ? ((str(source?.reasoningEffort) as never) ?? null)
        : input.reasoningEffort,
    skillIds: skills.map((row) => String(row.skillId)),
  } as never);
  const prefs = await preferencesOf(deps.tx.read(), userId);
  await deps.tx.run((tx) =>
    writePreferences(tx.conn, userId, prefs.revision, {
      pmAgentMode: 'personal',
      pmAgentId: agent.id,
    }),
  );
  return { agent, choice: await choiceOf(deps, deps.tx.read(), userId) };
}

export function createPmAgentService(deps: PmAgentDeps): PmAgentService {
  return {
    async choice(actor) {
      const conn = deps.tx.read();
      return choiceOf(deps, conn, (await viewerOf(conn, actor)).userId);
    },
    choose: (actor, input) => choose(deps, actor, input),
    copyFromDefault: (actor, input) => copyFromDefault(deps, actor, input),
    switchMode: (tx, userId, mode) => switchMode(deps, tx, userId, mode),
  };
}
