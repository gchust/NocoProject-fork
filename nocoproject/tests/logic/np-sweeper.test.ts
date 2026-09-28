// @vitest-environment node
/**
 * Sweeper rules (protocol.md §4.2) on a real PostgreSQL, driven by calling `sweep(now)` with a simulated clock.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { NpServices } from '../../server/modules/services.ts';
import {
  ALICE,
  buildServices,
  createAgent,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  runRows,
  type NpTestDatabase,
} from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_sweeper');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-sweeper] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

let services: NpServices;
let runtimeId: string;
let daemonId: string;
let agentId: string;

beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  services = buildServices(db.database).services;
  ({ runtimeId, daemonId } = await registerRuntime(services, ALICE));
  agentId = await createAgent(services, ALICE, runtimeId, 'Sweepy');
});

const later = (seconds: number) => new Date(Date.now() + seconds * 1000);

async function dispatchOne(): Promise<{
  runId: string;
  token: string;
  issueId: string;
}> {
  const issue = await services.issues.create(ALICE, {
    title: 'Sweep me',
    executor: { type: 'agent', id: agentId },
  });
  const claimed = await services.claims.claimOne(runtimeId);
  return { ...claimed!, issueId: issue.id };
}

describe.skipIf(!db)('sweeper (PostgreSQL)', () => {
  it('marks runtimes offline after 150 seconds of silence', async () => {
    expect((await services.runtimes.list())[0]).toMatchObject({
      status: 'online',
      online: true,
    });
    expect((await services.sweeper.sweep(later(60))).runtimesOffline).toBe(0);
    expect((await services.sweeper.sweep(later(151))).runtimesOffline).toBe(1);
    expect((await services.runtimes.list())[0]).toMatchObject({
      status: 'offline',
      online: false,
    });
    await services.runtimes.heartbeat(ALICE.id!, {
      daemonId,
      runtimeIds: [runtimeId],
    });
    expect((await services.runtimes.list())[0]!.status).toBe('online');
  });

  it('re-queues a dispatched run whose lease expired, keeping the attempt and revoking its token', async () => {
    const { runId, token } = await dispatchOne();
    expect((await services.sweeper.sweep(later(30))).leasesRequeued).toBe(0);
    const result = await services.sweeper.sweep(later(46));
    expect(result.leasesRequeued).toBe(1);
    const [row] = await runRows(db!, `id = '${runId}'`);
    expect(row).toMatchObject({
      status: 'queued',
      attempt: 1,
      lease_expires_at: null,
      dispatched_at: null,
    });
    expect(await services.runTokens.verify(token)).toBeNull();
    // It can be claimed again.
    expect((await services.claims.claimOne(runtimeId))?.runId).toBe(runId);
  });

  it('keeps a dispatched run whose lease is being renewed', async () => {
    const { runId } = await dispatchOne();
    await services.runs.extendLease(runId);
    expect((await services.sweeper.sweep(later(40))).leasesRequeued).toBe(0);
  });

  it('fails a run dispatched for more than 5 minutes as runtimeRecovery and schedules a retry', async () => {
    const { runId } = await dispatchOne();
    const result = await services.sweeper.sweep(later(301));
    expect(result.dispatchedTimedOut).toBe(1);
    const [failed] = await runRows(db!, `id = '${runId}'`);
    expect(failed).toMatchObject({
      status: 'failed',
      failure_reason: 'runtimeRecovery',
    });
    const [retry] = await runRows(db!, `retry_of_run_id = '${runId}'`);
    expect(retry).toMatchObject({ status: 'queued', attempt: 2 });
  });

  it('fails a running run whose runtime has been offline for over 3 hours', async () => {
    const { runId } = await dispatchOne();
    await services.runs.start(runId, { workDir: '/w' });
    await services.sweeper.sweep(later(200));
    expect((await runRows(db!, `id = '${runId}'`))[0]!.status).toBe('running');
    const result = await services.sweeper.sweep(later(3 * 3600 + 1));
    expect(result.runningOrphaned).toBe(1);
    expect((await runRows(db!, `id = '${runId}'`))[0]).toMatchObject({
      status: 'failed',
      failure_reason: 'runtimeOffline',
    });
    expect(await runRows(db!, `retry_of_run_id = '${runId}'`)).toHaveLength(1);
  });

  it('promotes due deferred runs', async () => {
    const issue = await services.issues.create(ALICE, { title: 'Later' });
    await services.tx.run((tx) =>
      services.runs.enqueue(tx, {
        agentId,
        subjectId: issue.id,
        threadScope: null,
        actorUserId: ALICE.id,
        ownerUserId: ALICE.id,
        priority: 0,
        fireAt: later(60),
        triggers: [{ type: 'comment' }],
      }),
    );
    expect((await runRows(db!, `subject_id = '${issue.id}'`))[0]!.status).toBe(
      'deferred',
    );
    expect((await services.sweeper.sweep(later(30))).deferredPromoted).toBe(0);
    expect((await services.sweeper.sweep(later(61))).deferredPromoted).toBe(1);
    expect((await runRows(db!, `subject_id = '${issue.id}'`))[0]!.status).toBe(
      'queued',
    );
  });

  it('expires queued runs whose runtime was deleted', async () => {
    const issue = await services.issues.create(ALICE, {
      title: 'Orphan',
      executor: { type: 'agent', id: agentId },
    });
    await db!.knex.raw('DELETE FROM runtimes WHERE id = ?', [runtimeId]);
    expect((await services.sweeper.sweep(new Date())).queuedExpired).toBe(1);
    expect((await runRows(db!, `subject_id = '${issue.id}'`))[0]).toMatchObject(
      {
        status: 'failed',
        failure_reason: 'queuedExpired',
      },
    );
  });
});
