// @vitest-environment node
import type { AuthEnv } from '@nocobase/app-plugin-authentication';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAgentRoutes } from '../../server/modules/agent/agent.routes.ts';
import type { NpServices } from '../../server/modules/services.ts';
import type { Actor } from '../../server/modules/shared/activity.ts';
import {
  canInvokeAgent,
  loadAgentAccess,
} from '../../server/modules/shared/authz.ts';
import { fromJson } from '../../server/modules/shared/db.ts';
import type { DomainEvent } from '../../server/modules/shared/events.ts';
import { npRouter } from '../../server/modules/shared/http.ts';
import {
  ALICE,
  BOB,
  CAROL,
  buildServices,
  createAgent,
  registerRuntime,
  openNpTestDatabase,
  resetData,
  rows,
  setRole,
  type NpTestDatabase,
} from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_agent_delete');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn('[np-agent-delete] skipped:', skip);
const db = (skip ? null : opened) as NpTestDatabase | null;
afterAll(async () => {
  await db?.close();
});
let services: NpServices;
let events: DomainEvent[];
let agentId: string;
let runtimeId: string;
beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  ({ services, events } = buildServices(db.database));
  await setRole(db, ALICE, 'owner');
  await setRole(db, BOB, 'member');
  await setRole(db, CAROL, 'member');
  ({ runtimeId } = await registerRuntime(services, BOB));
  agentId = await createAgent(services, BOB, runtimeId, 'Dev');
});
function browser(as?: Actor) {
  const router = npRouter<AuthEnv>();
  if (as)
    router.use('*', async (context, next) => {
      context.set('auth', { user: { id: as.id }, session: {} } as never);
      await next();
    });
  router.route('/np/agents', createAgentRoutes(services.agents));
  return router;
}

describe.skipIf(!db)('agent deletion (PostgreSQL)', () => {
  it('requires authentication and agent ownership, including for workspace admins', async () => {
    const path = '/np/agents/' + agentId;
    expect((await browser().request(path, { method: 'DELETE' })).status).toBe(
      401,
    );
    for (const actor of [ALICE, CAROL]) {
      const response = await browser(actor).request(path, { method: 'DELETE' });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: 'FORBIDDEN',
      });
    }
    await expect(
      services.agents.remove({ type: 'agent', id: agentId }, agentId),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(
      (await services.agents.list(BOB)).map((agent) => agent.id),
    ).toContain(agentId);
    const response = await browser(BOB).request(path, { method: 'DELETE' });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(
      (await browser(BOB).request(path, { method: 'DELETE' })).status,
    ).toBe(404);
    expect(
      (await browser(BOB).request('/np/agents/missing', { method: 'DELETE' }))
        .status,
    ).toBe(404);
  });

  it.each(['queued', 'deferred', 'dispatched', 'running'])(
    'refuses deletion while a run is %s without changing data',
    async (status) => {
      await services.issues.create(BOB, {
        title: 'Work',
        executor: { type: 'agent', id: agentId },
      });
      await db!.knex
        .withSchema(db!.schema)
        .table('runs')
        .where('agent_id', agentId)
        .update({ status });
      const before = await rows(db!, 'agents');
      const eventCount = events.length;
      const response = await browser(BOB).request('/np/agents/' + agentId, {
        method: 'DELETE',
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: 'AGENT_HAS_ACTIVE_RUNS',
      });
      expect(await rows(db!, 'agents')).toEqual(before);
      expect(events).toHaveLength(eventCount);
      expect((await rows(db!, 'issues'))[0]?.executor_id).toBe(agentId);
    },
  );

  it('keeps historical identities, clears assignments and configuration, and makes deletion irreversible through PATCH', async () => {
    const other = await createAgent(services, BOB, runtimeId, 'Other');
    const { skill } = await services.skills.create(BOB, {
      name: 'Skill',
      content: '# Rules',
    });
    await services.agents.update(BOB, agentId, {
      access: 'specificUsers',
      accessUserIds: [CAROL.id!],
      skillIds: [skill.id],
      delegationTargetIds: [other],
    });
    await services.agents.update(BOB, other, {
      delegationTargetIds: [agentId],
    });
    await services.agentEnv.put(BOB, agentId, [
      { name: 'TOKEN', value: 'secret-value' },
    ]);
    const issue = await services.issues.create(BOB, {
      title: 'History',
      executor: { type: 'agent', id: agentId },
    });
    await db!.knex
      .withSchema(db!.schema)
      .table('runs')
      .where('agent_id', agentId)
      .update({ status: 'completed' });
    const before = await services.issueQueries.detail(BOB, issue.id);
    const run = (await rows(db!, 'runs'))[0]!;
    await services.agents.remove(BOB, agentId);
    expect((await services.agents.list(BOB)).map((agent) => agent.id)).toEqual([
      other,
    ]);
    for (const actor of [ALICE, BOB]) {
      await expect(services.agents.get(actor, agentId)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(
        services.agents.update(actor, agentId, { archived: false }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        services.agentEnv.list(actor, agentId),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        services.agentEnv.put(actor, agentId, [{ name: 'X', value: 'x' }]),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    const detail = await services.issueQueries.detail(BOB, issue.id);
    expect(detail.issue).toMatchObject({
      executorType: 'none',
      executorId: null,
    });
    expect(detail.issue.ownerUserId).toBe(BOB.id);
    expect(detail.issue.statusKey).toBe(before.issue.statusKey);
    expect(detail.issue.revision).toBe(before.issue.revision + 1);
    expect(await services.runQueries.detail(String(run.id))).toMatchObject({
      agentName: 'Dev',
      status: 'completed',
    });
    const activity = (await rows(db!, 'activities')).find(
      (row) =>
        fromJson<{ reason?: string }>(row.details)?.reason === 'agentDeleted',
    );
    expect(activity).toMatchObject({
      action: 'executor_changed',
      actor_id: BOB.id,
    });
    expect(events).toContainEqual({ type: 'issue.changed', issueId: issue.id });
    expect(events.at(-1)).toEqual({ type: 'agents.changed' });
    for (const table of [
      'agent_access_grants',
      'agent_skills',
      'agent_env_vars',
      'agent_delegation_grants',
      'run_sessions',
    ]) {
      expect(await rows(db!, table)).toHaveLength(0);
    }
    expect(await rows(db!, 'agent_env_audits')).toHaveLength(1);
    expect(await services.skills.get(BOB, skill.id)).toMatchObject({
      skill: { id: skill.id },
    });
    expect(await rows(db!, 'runtimes')).toHaveLength(1);
    const access = await loadAgentAccess(db!.database.connection(), agentId);
    expect(access).not.toBeNull();
    expect(
      await canInvokeAgent(db!.database.connection(), BOB.id!, access!),
    ).toBe(false);
    await expect(
      services.issues.create(BOB, {
        title: 'Cannot assign',
        executor: { type: 'agent', id: agentId },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_EXECUTOR' });
  });

  it('also allows the owner to delete an already archived agent', async () => {
    await services.agents.update(BOB, agentId, { archived: true });
    await services.agents.remove(BOB, agentId);
    expect(await services.agents.list(BOB)).toEqual([]);
  });
});
