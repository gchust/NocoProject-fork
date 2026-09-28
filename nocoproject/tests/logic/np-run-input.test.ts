// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMigrator } from '@nocobase/db';
import type { NpServices } from '../../server/modules/services.ts';
import {
  ALICE,
  BOB,
  MIGRATIONS_DIR,
  buildServices,
  createAgent,
  mention,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  runRows,
  type NpTestDatabase,
} from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_run_input');
const db = ('skip' in opened ? null : opened) as NpTestDatabase | null;
if ('skip' in opened) console.warn(opened.skip);
afterAll(async () => {
  await db?.close();
});
let services: NpServices;
let runtimeId: string;
let daemonId: string;
let alpha: string;
let beta: string;
beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  services = buildServices(db.database).services;
  ({ runtimeId, daemonId } = await registerRuntime(services, ALICE));
  alpha = await createAgent(services, ALICE, runtimeId, 'Alpha');
  beta = await createAgent(services, ALICE, runtimeId, 'Beta');
});
async function working(acceptsInput = true) {
  const issue = await services.issues.create(ALICE, {
    title: 'Live input',
    executor: { type: 'agent', id: alpha },
  });
  const claim = await services.claims.claim(
    ALICE.id!,
    { daemonId, slots: [{ runtimeId, free: 1 }] },
    'u',
  );
  const runId = claim.runs[0].run.id;
  await services.runs.start(runId, { workDir: '/w', acceptsInput });
  return { issue, runId };
}

describe.skipIf(!db)('run input (PostgreSQL)', () => {
  it('keeps comments on the current run, fences completion and records all triggers', async () => {
    const { issue, runId } = await working();
    const first = await services.comments.create(ALICE, issue.id, {
      content: 'Also test Safari',
    });
    const second = await services.comments.create(ALICE, issue.id, {
      content: 'And Firefox',
    });
    expect(first.triggered).toEqual([{ agentId: alpha, runId }]);
    expect(second.triggered).toEqual(first.triggered);
    expect(await runRows(db!, `subject_id = '${issue.id}'`)).toHaveLength(1);
    expect(
      (await services.runs.daemonStatus(runId)).inputs?.map(
        (input) => input.content,
      ),
    ).toEqual(['Also test Safari', 'And Firefox']);
    await expect(
      services.runs.complete(runId, {
        workDir: '/w',
        handledInputIds: [first.comment.id],
      }),
    ).rejects.toMatchObject({ code: 'RUN_INPUT_PENDING' });
    expect((await services.runs.get(runId)).status).toBe('running');
    await services.runs.complete(runId, {
      workDir: '/w',
      handledInputIds: [first.comment.id, second.comment.id],
    });
    const later = await services.comments.create(ALICE, issue.id, {
      content: 'One more',
    });
    expect(later.triggered[0].runId).not.toBe(runId);
  });

  it('routes ordinary comments to the current agent even if the configured executor changed', async () => {
    const { issue, runId } = await working();
    await services.issues.update(ALICE, issue.id, {
      revision: issue.revision,
      executor: { type: 'agent', id: beta },
      start: false,
    });
    const comment = await services.comments.create(ALICE, issue.id, {
      content: 'Keep going',
    });
    expect(comment.triggered).toEqual([{ agentId: alpha, runId }]);
    const directed = await services.comments.create(ALICE, issue.id, {
      content: `${mention(beta)} please review`,
    });
    expect(directed.triggered[0].agentId).toBe(beta);
    expect(directed.triggered[0].runId).not.toBe(runId);
  });

  it('preserves reply routing, notes and agent-authored comment silence', async () => {
    const { issue, runId } = await working();
    const replyTarget = await services.comments.create(
      { type: 'agent', id: alpha, runId },
      issue.id,
      { content: 'Progress' },
    );
    const reply = await services.comments.create(ALICE, issue.id, {
      content: 'Continue',
      parentId: replyTarget.comment.id,
    });
    expect(reply.triggered).toEqual([{ agentId: alpha, runId }]);
    expect((await services.runs.daemonStatus(runId)).inputs?.[0].rootId).toBe(
      replyTarget.comment.id,
    );
    expect(
      (
        await services.comments.create(ALICE, issue.id, {
          content: '/note internal',
        })
      ).triggered,
    ).toEqual([]);
    expect(replyTarget.triggered).toEqual([]);
  });

  it('keeps legacy daemons on queued delivery and does not require acknowledgements', async () => {
    const { issue, runId } = await working(false);
    const comment = await services.comments.create(ALICE, issue.id, {
      content: 'Legacy follow-up',
    });
    expect(comment.triggered[0].runId).not.toBe(runId);
    await services.runs.complete(runId, { workDir: '/w' });
    const next = await services.claims.claim(
      ALICE.id!,
      { daemonId, slots: [{ runtimeId, free: 1 }] },
      'u',
    );
    expect(next.runs[0].triggers[0].comment?.id).toBe(comment.comment.id);
    await services.runs.start(next.runs[0].run.id, { workDir: '/w' });
    await services.runs.complete(next.runs[0].run.id, { workDir: '/w' });
  });

  it('does not borrow another human’s authorization context', async () => {
    const { issue, runId } = await working();
    const comment = await services.comments.create(BOB, issue.id, {
      content: 'Bob follow-up',
    });
    expect(comment.triggered[0].runId).not.toBe(runId);
  });

  it('serializes a comment against completion without losing it', async () => {
    const { issue, runId } = await working();
    const [completion, comment] = await Promise.allSettled([
      services.runs.complete(runId, { workDir: '/w', handledInputIds: [] }),
      services.comments.create(ALICE, issue.id, {
        content: 'Concurrent input',
      }),
    ]);
    expect(comment.status).toBe('fulfilled');
    if (comment.status !== 'fulfilled') throw comment.reason;
    if (completion.status === 'fulfilled') {
      expect(comment.value.triggered[0].runId).not.toBe(runId);
    } else {
      expect(completion.reason).toMatchObject({ code: 'RUN_INPUT_PENDING' });
      expect(comment.value.triggered[0].runId).toBe(runId);
    }
  });

  it('carries appended comments into automatic retry', async () => {
    const { issue, runId } = await working();
    const added = await services.comments.create(ALICE, issue.id, {
      content: 'Survive provider failure',
    });
    await services.runRecovery.fail(runId, {
      reason: 'agentError.providerNetwork',
      providerSessionId: 'session-a',
      workDir: '/w',
    });
    const retry = await services.claims.claim(
      ALICE.id!,
      { daemonId, slots: [{ runtimeId, free: 1 }] },
      'u',
    );
    expect(retry.runs).toHaveLength(1);
    expect(
      retry.runs[0].triggers.some(
        (trigger) => trigger.comment?.id === added.comment.id,
      ),
    ).toBe(true);
    expect(retry.runs[0].session.providerSessionId).toBe('session-a');
  });

  it('does not append to a run after cancellation was requested', async () => {
    const { issue, runId } = await working();
    await services.runs.requestCancel(ALICE, runId);
    const added = await services.comments.create(ALICE, issue.id, {
      content: 'Next attempt',
    });
    expect(added.triggered[0].runId).not.toBe(runId);
    expect((await services.runs.daemonStatus(runId)).inputs).toEqual([]);
    await expect(
      services.runs.complete(runId, { workDir: '/w' }),
    ).rejects.toMatchObject({ code: 'RUN_CANCEL_REQUESTED' });
  });

  it('rolls the input capability column down and up', async () => {
    const migrator = createMigrator({
      database: db!.database,
      directory: MIGRATIONS_DIR,
      packageName: 'nocoproject',
    });
    while ((await migrator.rollback()).rolledBack.length > 0);
    await migrator.upTo('2026100600001_np_member_preferences');
    expect(await db!.knex.schema.hasColumn('runs', 'accepts_input')).toBe(
      false,
    );
    expect((await migrator.latest()).executed).toEqual([
      '2026100700001_np_run_input',
    ]);
    expect(await db!.knex.schema.hasColumn('runs', 'accepts_input')).toBe(true);
    expect((await migrator.rollback()).rolledBack).toEqual([
      '2026100700001_np_run_input',
    ]);
    expect(await db!.knex.schema.hasColumn('runs', 'accepts_input')).toBe(
      false,
    );
    await migrator.latest();
  });
});
