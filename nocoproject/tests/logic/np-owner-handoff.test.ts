// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { NpServices } from '../../server/modules/services.ts';
import {
  ALICE,
  BOB,
  CAROL,
  buildServices,
  claimOne,
  createAgent,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  runRows,
  setRole,
  triggerRows,
  type NpTestDatabase,
} from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_owner_handoff');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-owner-handoff] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;
afterAll(async () => {
  await db?.close();
});
let services: NpServices;
let runtime: { runtimeId: string; daemonId: string };
let agentId: string;
beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  services = buildServices(db.database).services;
  await setRole(db, ALICE, 'owner');
  await setRole(db, BOB, 'member');
  await setRole(db, CAROL, 'member');
  runtime = await registerRuntime(services, ALICE);
  agentId = await createAgent(services, ALICE, runtime.runtimeId, 'Private');
});

async function assigned() {
  return services.issues.create(ALICE, {
    title: 'Hand off',
    executor: { type: 'agent', id: agentId },
  });
}

describe.skipIf(!db)('owner handoff and agent invocation (PostgreSQL)', () => {
  it.each(['queued', 'deferred'] as const)(
    'clears a private executor and withdraws %s work even with start:false',
    async (status) => {
      const issue = await assigned();
      const [run] = await runRows(db!, `subject_id = '${issue.id}'`);
      if (status === 'deferred')
        await db!.knex
          .withSchema(db!.schema)
          .table('runs')
          .where({ id: run!.id })
          .update({ status });
      const after = await services.issues.update(ALICE, issue.id, {
        ownerUserId: BOB.id,
        revision: issue.revision,
        start: false,
      });
      expect(after).toMatchObject({
        ownerUserId: BOB.id,
        executorType: 'none',
        executorId: null,
        revision: issue.revision + 1,
      });
      expect(await runRows(db!, `subject_id = '${issue.id}'`)).toEqual([
        expect.objectContaining({
          status: 'cancelled',
          failure_reason: 'cancelled',
        }),
      ]);
      const detail = await services.issueQueries.detail(BOB, issue.id);
      expect(detail.activities).toContainEqual(
        expect.objectContaining({
          action: 'executor_changed',
          details: {
            from: { type: 'agent', id: agentId },
            to: { type: 'none', id: null },
            reason: 'ownerCannotInvoke',
          },
        }),
      );
      expect(await claimOne(services, ALICE, runtime)).toBeUndefined();
    },
  );

  it.each(['everyone', 'specificUsers'] as const)(
    'retains a %s executor when the new owner has access',
    async (access) => {
      await services.agents.update(ALICE, agentId, {
        access,
        accessUserIds: access === 'specificUsers' ? [BOB.id!] : [],
      });
      const issue = await assigned();
      const after = await services.issues.update(ALICE, issue.id, {
        ownerUserId: BOB.id,
        revision: issue.revision,
      });
      expect(after).toMatchObject({
        executorType: 'agent',
        executorId: agentId,
      });
      expect(await runRows(db!, `subject_id = '${issue.id}'`)).toEqual([
        expect.objectContaining({ status: 'queued' }),
      ]);
      const comment = await services.comments.create(BOB, issue.id, {
        content: 'Continue',
      });
      expect(comment.triggered).toHaveLength(1);
    },
  );

  it('clears a specificUsers executor outside the grant list, even for an admin', async () => {
    await services.agents.update(ALICE, agentId, {
      access: 'specificUsers',
      accessUserIds: [CAROL.id!],
    });
    await setRole(db!, BOB, 'admin');
    const issue = await assigned();
    const after = await services.issues.update(BOB, issue.id, {
      ownerUserId: BOB.id,
      revision: issue.revision,
    });
    expect(after.executorType).toBe('none');
  });

  it('evaluates the final executor in a combined PATCH and leaves an accessible replacement', async () => {
    const replacement = await createAgent(
      services,
      ALICE,
      runtime.runtimeId,
      'Shared',
    );
    await services.agents.update(ALICE, replacement, { access: 'everyone' });
    const issue = await assigned();
    const after = await services.issues.update(ALICE, issue.id, {
      ownerUserId: BOB.id,
      executor: { type: 'agent', id: replacement },
      revision: issue.revision,
    });
    expect(after).toMatchObject({
      executorType: 'agent',
      executorId: replacement,
    });
    expect(await runRows(db!, `subject_id = '${issue.id}'`)).toEqual([
      expect.objectContaining({ agent_id: agentId, status: 'cancelled' }),
      expect.objectContaining({ agent_id: replacement, status: 'queued' }),
    ]);
  });

  it('clears an inaccessible replacement with one final executor activity', async () => {
    const replacement = await createAgent(
      services,
      ALICE,
      runtime.runtimeId,
      'Also private',
    );
    const issue = await assigned();
    const after = await services.issues.update(ALICE, issue.id, {
      ownerUserId: BOB.id,
      executor: { type: 'agent', id: replacement },
      revision: issue.revision,
    });
    expect(after.executorType).toBe('none');
    const detail = await services.issueQueries.detail(BOB, issue.id);
    expect(
      detail.activities.filter((a) => a.action === 'executor_changed'),
    ).toHaveLength(1);
    expect(await runRows(db!, `agent_id = '${replacement}'`)).toHaveLength(0);
  });

  it('keeps human executors and rejects unauthorized or stale ownership edits atomically', async () => {
    const issue = await services.issues.create(ALICE, {
      title: 'Human',
      executor: { type: 'user', id: CAROL.id! },
    });
    await expect(
      services.issues.update(BOB, issue.id, {
        ownerUserId: BOB.id,
        revision: issue.revision,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      services.issues.update(ALICE, issue.id, {
        ownerUserId: BOB.id,
        revision: issue.revision + 1,
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const after = await services.issues.update(ALICE, issue.id, {
      ownerUserId: BOB.id,
      revision: issue.revision,
    });
    expect(after).toMatchObject({ executorType: 'user', executorId: CAROL.id });
  });

  it('keeps comments but does not enqueue or coalesce unauthorized implicit triggers', async () => {
    const issue = await assigned();
    const [run] = await runRows(db!, `subject_id = '${issue.id}'`);
    const top = await services.comments.create(BOB, issue.id, {
      content: 'Hello private executor',
    });
    expect(top.triggered).toEqual([]);
    expect(
      (await triggerRows(db!, run!.id as string)).map((r) => r.type),
    ).toEqual(['assign']);
    const output = await services.comments.create(
      { type: 'agent', id: agentId },
      issue.id,
      { content: 'My output' },
    );
    await services.issues.update(ALICE, issue.id, {
      ownerUserId: BOB.id,
      revision: issue.revision,
    });
    const reply = await services.comments.create(BOB, issue.id, {
      content: 'Can you continue?',
      parentId: output.comment.id,
    });
    expect(reply.comment.content).toBe('Can you continue?');
    expect(reply.triggered).toEqual([]);
    await expect(
      services.comments.create(BOB, issue.id, {
        content: `[@Private](mention://agent/${agentId})`,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // The agent's owner can still explicitly reply; ownership of the issue does not revoke Alice's access.
    expect(
      (
        await services.comments.create(ALICE, issue.id, {
          content: 'Authorized reply',
          parentId: output.comment.id,
        })
      ).triggered,
    ).toHaveLength(1);
  });

  it.each(['dispatched', 'running'] as const)(
    'lets a %s round finish after handoff',
    async (status) => {
      const issue = await assigned();
      const claimed = await claimOne(services, ALICE, runtime);
      expect(claimed).toBeDefined();
      if (status === 'running') await services.runs.start(claimed!.run.id, {});
      await services.issues.update(ALICE, issue.id, {
        ownerUserId: BOB.id,
        revision: issue.revision,
      });
      expect(await services.runs.get(claimed!.run.id)).toMatchObject({
        status,
        cancelRequestedAt: null,
      });
      await services.runs.complete(claimed!.run.id, {
        summary: 'Preserved work',
      });
      expect(await services.runs.get(claimed!.run.id)).toMatchObject({
        status: 'completed',
      });
      expect(await runRows(db!, `subject_id = '${issue.id}'`)).toHaveLength(1);
    },
  );

  it('does not change private executors on unrelated edits or repeated owner values', async () => {
    const issue = await assigned();
    const after = await services.issues.update(ALICE, issue.id, {
      title: 'Same owner',
      ownerUserId: ALICE.id,
      revision: issue.revision,
    });
    expect(after).toMatchObject({ executorType: 'agent', executorId: agentId });
    expect(await runRows(db!, `subject_id = '${issue.id}'`)).toEqual([
      expect.objectContaining({ status: 'queued' }),
    ]);
  });

  it('does not automatically retry a private run after handoff', async () => {
    const issue = await assigned();
    const claimed = await claimOne(services, ALICE, runtime);
    await services.runs.start(claimed!.run.id, {});
    await services.issues.update(ALICE, issue.id, {
      ownerUserId: BOB.id,
      revision: issue.revision,
    });
    await services.runRecovery.fail(claimed!.run.id, {
      reason: 'agentError.providerNetwork',
      detail: 'temporary failure',
    });
    expect(await runRows(db!, `subject_id = '${issue.id}'`)).toEqual([
      expect.objectContaining({ status: 'failed' }),
    ]);
    await expect(
      services.runRecovery.retry(BOB, claimed!.run.id),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Alice can explicitly authorize another round; Bob cannot inherit that permission.
    await services.runRecovery.retry(ALICE, claimed!.run.id);
    expect(
      await runRows(db!, `retry_of_run_id = '${claimed!.run.id}'`),
    ).toHaveLength(1);
  });
});
