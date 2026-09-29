// @vitest-environment node
/**
 * Iteration 2 additions to the claim payload and the §K visibility leftovers, on a real PostgreSQL: `agent.env`,
 * `agent.skills`, `issue.executionMode` and `issue.pullRequests`; the run queued behind the current turn; agent
 * reads limited to the run issue's project and issues without a project; runs of invisible issues hidden from
 * members.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { NpServices } from '../../server/modules/services.ts';
import {
  ALICE,
  CAROL,
  agentApi,
  buildServices,
  claimOne as claimFirst,
  createAgent,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  runRows,
  setRole,
  type NpTestDatabase,
} from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_claim_iter2');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-claim-iter2] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

let services: NpServices;

beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  services = buildServices(db.database).services;
});

describe.skipIf(!db)(
  'iteration 2 claim payload, agent read scope and run visibility (PostgreSQL)',
  () => {
    it('carries env, skills, executionMode and pull requests (defaults when none)', async () => {
      const fixture = await registerRuntime(services, ALICE);
      const agentId = await createAgent(
        services,
        ALICE,
        fixture.runtimeId,
        'Dev',
      );
      const plain = await services.issues.create(ALICE, {
        title: 'Plain',
        executor: { type: 'agent', id: agentId },
      });
      const first = await claimFirst(services, ALICE, fixture);
      expect(first?.agent).toMatchObject({ env: {}, skills: [] });
      expect(first?.issue).toMatchObject({
        id: plain.id,
        executionMode: 'task',
        pullRequests: [],
      });

      const session = await services.issues.create(ALICE, { title: 'Session' });
      await services.issues.update(ALICE, session.id, {
        executionMode: 'session',
        revision: session.revision,
      });
      await services.pullRequests.agentLink(
        ALICE,
        session,
        'https://github.com/a/b/pull/3',
      );
      await services.agentEnv.put(ALICE, agentId, [
        { name: 'TOKEN_A', value: 'value-a' },
      ]);
      await services.issues.update(ALICE, session.id, {
        executor: { type: 'agent', id: agentId },
        revision: session.revision + 1,
      });
      await services.runs.complete(first!.run.id, { workDir: '/tmp/w' });
      const second = await claimFirst(services, ALICE, fixture);
      expect(second?.issue).toMatchObject({
        id: session.id,
        executionMode: 'session',
        pullRequests: [
          { number: 3, url: 'https://github.com/a/b/pull/3', state: 'open' },
        ],
      });
      expect(second?.agent.env).toEqual({ TOKEN_A: 'value-a' });
      const activity = (await services.issueQueries.detail(ALICE, session.id))
        .activities;
      expect(
        activity.some((item) => item.action === 'execution_mode_changed'),
      ).toBe(true);
    });

    it('shows the run queued behind the current turn', async () => {
      const fixture = await registerRuntime(services, ALICE);
      const agentId = await createAgent(
        services,
        ALICE,
        fixture.runtimeId,
        'Dev',
      );
      const issue = await services.issues.create(ALICE, {
        title: 'Chat',
        executor: { type: 'agent', id: agentId },
      });
      const claimed = await claimFirst(services, ALICE, fixture);
      await services.runs.start(claimed!.run.id, { workDir: '/tmp/w' });
      expect(
        (await services.issueQueries.runs(ALICE, issue.id)).queuedRun,
      ).toBeNull();
      await services.comments.create(ALICE, issue.id, {
        content: 'one more thing',
      });
      await services.comments.create(ALICE, issue.id, {
        content: 'and another',
      });
      const { data, queuedRun } = await services.issueQueries.runs(
        ALICE,
        issue.id,
      );
      expect(data).toHaveLength(2);
      expect(queuedRun).toMatchObject({ triggerCount: 2 });
      expect(
        (await services.issueQueries.detail(ALICE, issue.id)).queuedRun,
      ).toEqual(queuedRun);
    });

    it('limits agent reads to the run issue project and issues without a project', async () => {
      await setRole(db!, ALICE, 'owner');
      const fixture = await registerRuntime(services, ALICE);
      const agentId = await createAgent(
        services,
        ALICE,
        fixture.runtimeId,
        'Dev',
      );
      const web = await services.projects.create(ALICE, { name: 'Web' });
      const secret = await services.projects.create(ALICE, {
        name: 'Secret',
        visibility: 'members',
      });
      const own = await services.issues.create(ALICE, {
        title: 'Own',
        projectId: web.id,
        executor: { type: 'agent', id: agentId },
      });
      const sibling = await services.issues.create(ALICE, {
        title: 'Sibling',
        projectId: web.id,
      });
      const loose = await services.issues.create(ALICE, { title: 'Loose' });
      const hidden = await services.issues.create(ALICE, {
        title: 'Hidden',
        projectId: secret.id,
      });
      const claimed = await claimFirst(services, ALICE, fixture);
      const call = agentApi(services, claimed!.token);
      for (const target of [own, sibling, loose]) {
        expect((await call('GET', `/issues/${target.identifier}`)).status).toBe(
          200,
        );
        expect(
          (await call('GET', `/issues/${target.id}/comments`)).status,
        ).toBe(200);
        expect(
          (await call('GET', `/issues/${target.id}/children`)).status,
        ).toBe(200);
      }
      for (const path of [
        `/issues/${hidden.id}`,
        `/issues/${hidden.id}/comments`,
        `/issues/${hidden.id}/children`,
      ]) {
        const response = await call('GET', path);
        expect(response.status).toBe(404);
        expect(response.body.code).toBe('NOT_FOUND');
      }
      expect(own.id).toBe(claimed!.issue.id);
    });

    it('hides runs of issues a member cannot see', async () => {
      await setRole(db!, ALICE, 'owner');
      await setRole(db!, CAROL, 'member');
      const fixture = await registerRuntime(services, ALICE);
      const agentId = await createAgent(
        services,
        ALICE,
        fixture.runtimeId,
        'Dev',
      );
      const secret = await services.projects.create(ALICE, {
        name: 'Secret',
        visibility: 'members',
      });
      await services.issues.create(ALICE, {
        title: 'Hidden',
        projectId: secret.id,
        executor: { type: 'agent', id: agentId },
      });
      const [run] = await runRows(db!);
      const runId = run!.id as string;
      await expect(
        services.runQueries.assertVisible(ALICE, runId),
      ).resolves.toBeUndefined();
      await expect(
        services.runQueries.assertVisible(CAROL, runId),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        services.runQueries.assertVisible(ALICE, 'missing'),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  },
);
