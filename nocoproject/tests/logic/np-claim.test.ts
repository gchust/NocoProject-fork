// @vitest-environment node
/**
 * Claim protocol on a real PostgreSQL (protocol.md §4): concurrent claims, per-agent limits, tokens, the Knex
 * transaction binding the claim SQL relies on, and the event log.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Knex } from 'knex';

import {
  CLAIM_RUN_SQL,
  CLAIM_RUNTIME_LOCK_SQL,
  claimLockKey,
} from '../../server/modules/run/claim.sql.ts';
import type { NpServices } from '../../server/modules/services.ts';
import { PROTOCOL_VERSION } from '../../server/modules/shared/protocol.ts';
import {
  ALICE,
  BOB,
  buildServices,
  createAgent,
  mention,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  runRows,
  type NpTestDatabase,
} from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_claim');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-claim] skipped: ${skip}`);
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

async function queueIssues(agentId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const issue = await services.issues.create(ALICE, {
      title: `Issue ${index}`,
      executor: { type: 'agent', id: agentId },
    });
    ids.push(issue.id);
  }
  return ids;
}

describe.skipIf(!db)('claim concurrency (PostgreSQL)', () => {
  it('binds connection.client() to the transaction inside db.transaction()', async () => {
    const outer = await db!.database.connection().client<Knex>();
    expect(outer.isTransaction).toBeFalsy();
    await db!.database
      .transaction(async (connection) => {
        const inner = await connection.client<Knex>();
        expect(inner.isTransaction).toBe(true);
        // A write through the raw client is rolled back with the transaction.
        await inner.raw(
          `INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p-tx', 'tx', now(), now())`,
        );
        const visibleInside = await connection.query
          .selectFrom('projects')
          .select('id')
          .where('id', '=', 'p-tx')
          .exists();
        expect(visibleInside).toBe(true);
        throw new Error('rollback');
      })
      .catch((error: Error) => expect(error.message).toBe('rollback'));
    const visibleAfter = await db!.database
      .query()
      .selectFrom('projects')
      .select('id')
      .where('id', '=', 'p-tx')
      .exists();
    expect(visibleAfter).toBe(false);
  });

  it('10 concurrent claims over 5 queued runs claim exactly 5, each once, with unique tokens', async () => {
    const { runtimeId, daemonId } = await registerRuntime(services, ALICE);
    const agentId = await createAgent(services, ALICE, runtimeId, 'Worker', 10);
    await queueIssues(agentId, 5);
    expect(await runRows(db!, "status = 'queued'")).toHaveLength(5);

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        services.claims.claim(
          ALICE.id!,
          {
            daemonId,
            configurationProtocol: 1,
            slots: [{ runtimeId, free: 1 }],
          },
          'http://test/main',
        ),
      ),
    );
    const claimed = responses.flatMap((response) => response.runs);
    expect(claimed).toHaveLength(5);
    expect(new Set(claimed.map((run) => run.run.id)).size).toBe(5);
    expect(new Set(claimed.map((run) => run.token)).size).toBe(5);
    for (const run of claimed) {
      expect(run.token).toMatch(/^npr_[0-9a-f]{40}$/u);
      expect(run.leaseSeconds).toBe(45);
      expect(run.agent.id).toBe(agentId);
      expect(run.issue.identifier).toMatch(/^NP-\d+$/u);
      expect(run.issue.ownerName).toBe('Alice');
      expect(run.triggers).toEqual([{ type: 'assign' }]);
      expect(run.session).toEqual({
        providerSessionId: null,
        workDir: null,
        fresh: true,
        branchName: null,
        repoUrl: null,
      });
      expect(run.server).toEqual({
        url: 'http://test/main',
        protocolVersion: PROTOCOL_VERSION,
      });
    }
    expect(await runRows(db!, "status = 'dispatched'")).toHaveLength(5);
    expect(await runRows(db!, "status = 'queued'")).toHaveLength(0);
    const tokens = (await db!.knex.raw('SELECT hash FROM run_tokens')) as {
      rows: { hash: string }[];
    };
    expect(tokens.rows).toHaveLength(5);
    // Only hashes are stored.
    for (const run of claimed)
      expect(tokens.rows.map((row) => row.hash)).not.toContain(run.token);
  });

  it('10 concurrent raw claimOne calls across two agents never double-claim', async () => {
    const { runtimeId } = await registerRuntime(services, ALICE);
    const first = await createAgent(services, ALICE, runtimeId, 'First', 10);
    const second = await createAgent(services, ALICE, runtimeId, 'Second', 10);
    await queueIssues(first, 3);
    await queueIssues(second, 2);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => services.claims.claimOne(runtimeId)),
    );
    const claimed = results.filter((result) => result !== null);
    expect(claimed).toHaveLength(5);
    expect(new Set(claimed.map((result) => result!.runId)).size).toBe(5);
  });
});

describe.skipIf(!db)('claim per-agent limits (PostgreSQL)', () => {
  it('keeps the per-agent limits under concurrent claims', async () => {
    const { runtimeId } = await registerRuntime(services, ALICE);
    // maxConcurrentRuns = 2 across five issues.
    const limited = await createAgent(services, ALICE, runtimeId, 'Two', 2);
    await queueIssues(limited, 5);
    // Two pending runs of one agent on one issue (different thread scopes): only one may execute.
    const single = await createAgent(services, ALICE, runtimeId, 'One', 6);
    const issue = await services.issues.create(ALICE, {
      title: 'Shared',
      executor: { type: 'agent', id: single },
    });
    await services.comments.create(ALICE, issue.id, {
      content: `${mention(single)} thread`,
    });
    expect(
      await runRows(db!, `agent_id = '${single}' AND status = 'queued'`),
    ).toHaveLength(2);

    for (let round = 0; round < 3; round += 1) {
      await Promise.all(
        Array.from({ length: 12 }, () => services.claims.claimOne(runtimeId)),
      );
    }
    expect(
      await runRows(db!, `agent_id = '${limited}' AND status = 'dispatched'`),
    ).toHaveLength(2);
    expect(
      await runRows(db!, `agent_id = '${single}' AND status = 'dispatched'`),
    ).toHaveLength(1);
  });

  it('serializes claims per runtime so an uncommitted claim is respected by the next one', async () => {
    const { runtimeId } = await registerRuntime(services, ALICE);
    const agentId = await createAgent(services, ALICE, runtimeId, 'Serial', 6);
    const issue = await services.issues.create(ALICE, {
      title: 'Race',
      executor: { type: 'agent', id: agentId },
    });
    await services.comments.create(ALICE, issue.id, {
      content: `${mention(agentId)} second thread`,
    });
    expect(await runRows(db!, "status = 'queued'")).toHaveLength(2);

    // Claimer A: claims one run of the agent on this issue and keeps its transaction open.
    const knex = await db!.database.connection().client<Knex>();
    const trx = await knex.transaction();
    await trx.raw(CLAIM_RUNTIME_LOCK_SQL, [claimLockKey(runtimeId)]);
    const first = (await trx.raw(CLAIM_RUN_SQL, [runtimeId, runtimeId])) as {
      rows: unknown[];
    };
    expect(first.rows).toHaveLength(1);

    // Claimer B must wait for A; without the runtime lock it would see A's run as still queued and claim the other.
    let settled = false;
    const second = services.claims.claimOne(runtimeId).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    await trx.commit();
    expect(await second).toBeNull();
    expect(await runRows(db!, "status = 'dispatched'")).toHaveLength(1);
  });

  it('respects maxConcurrentRuns', async () => {
    const { runtimeId, daemonId } = await registerRuntime(services, ALICE);
    const agentId = await createAgent(services, ALICE, runtimeId, 'Limited', 2);
    await queueIssues(agentId, 4);
    const first = await services.claims.claim(
      ALICE.id!,
      { daemonId, configurationProtocol: 1, slots: [{ runtimeId, free: 10 }] },
      'u',
    );
    expect(first.runs).toHaveLength(2);
    expect(
      (
        await services.claims.claim(
          ALICE.id!,
          {
            daemonId,
            configurationProtocol: 1,
            slots: [{ runtimeId, free: 10 }],
          },
          'u',
        )
      ).runs,
    ).toHaveLength(0);

    await services.runs.start(first.runs[0]!.run.id, { workDir: '/tmp/w' });
    await services.runs.complete(first.runs[0]!.run.id, {
      workDir: '/tmp/w',
      providerSessionId: 'sess-1',
    });
    const next = await services.claims.claim(
      ALICE.id!,
      { daemonId, configurationProtocol: 1, slots: [{ runtimeId, free: 10 }] },
      'u',
    );
    expect(next.runs).toHaveLength(1);
  });
});

describe.skipIf(!db)('claim ordering and sessions (PostgreSQL)', () => {
  it('waits while the same agent has an active run on the same issue, then resumes the session', async () => {
    const { runtimeId, daemonId } = await registerRuntime(services, ALICE);
    const agentId = await createAgent(services, ALICE, runtimeId, 'Solo', 6);
    const [issueId] = await queueIssues(agentId, 1);
    const claim = () =>
      services.claims.claim(
        ALICE.id!,
        { daemonId, configurationProtocol: 1, slots: [{ runtimeId, free: 5 }] },
        'u',
      );

    const [running] = (await claim()).runs;
    await services.runs.start(running!.run.id, {
      workDir: '/w',
      providerSessionId: 'sess-A',
    });

    // A new top-level comment while the run is running creates a separate queued run (no coalescing into running).
    const comment = await services.comments.create(ALICE, issueId!, {
      content: 'One more thing',
    });
    expect(comment.triggered).toHaveLength(1);
    expect(comment.triggered[0]!.runId).not.toBe(running!.run.id);
    // A mention in another thread is a different scope: also its own queued run.
    const mentioned = await services.comments.create(ALICE, issueId!, {
      content: `${mention(agentId)} look`,
    });
    expect(mentioned.triggered[0]!.runId).not.toBe(comment.triggered[0]!.runId);
    expect(await runRows(db!, "status = 'queued'")).toHaveLength(2);

    expect((await claim()).runs).toHaveLength(0);
    await services.runs.complete(running!.run.id, {
      workDir: '/w',
      providerSessionId: 'sess-A',
    });

    const after = (await claim()).runs;
    // Still one at a time for this agent and issue.
    expect(after).toHaveLength(1);
    expect(after[0]!.triggers.map((trigger) => trigger.type)).toEqual([
      'comment',
    ]);
    expect(after[0]!.triggers[0]!.comment).toMatchObject({
      authorName: 'Alice',
      content: 'One more thing',
    });
    expect(after[0]!.session).toEqual({
      providerSessionId: 'sess-A',
      workDir: '/w',
      fresh: false,
      branchName: null,
      repoUrl: null,
    });
  });
});

describe.skipIf(!db)('claim authorization (PostgreSQL)', () => {
  it('refuses slots for runtimes the caller does not own', async () => {
    const { runtimeId, daemonId } = await registerRuntime(services, ALICE);
    await expect(
      services.claims.claim(
        BOB.id!,
        { daemonId, configurationProtocol: 1, slots: [{ runtimeId, free: 1 }] },
        'u',
      ),
    ).rejects.toMatchObject({ kind: 'forbidden', code: 'RUNTIME_NOT_OWNED' });
  });

  it('answers RUNTIME_NOT_FOUND for unknown runtimes so the daemon re-registers', async () => {
    const { runtimeId, daemonId } = await registerRuntime(services, ALICE);
    await expect(
      services.claims.claim(
        ALICE.id!,
        {
          daemonId,
          configurationProtocol: 1,
          slots: [{ runtimeId: 'missing', free: 1 }],
        },
        'u',
      ),
    ).rejects.toMatchObject({ kind: 'notFound', code: 'RUNTIME_NOT_FOUND' });
    await expect(
      services.claims.claim(
        ALICE.id!,
        {
          daemonId: 'other-daemon',
          configurationProtocol: 1,
          slots: [{ runtimeId, free: 1 }],
        },
        'u',
      ),
    ).rejects.toMatchObject({ kind: 'notFound', code: 'RUNTIME_NOT_FOUND' });
    await expect(
      services.runtimes.heartbeat(ALICE.id!, {
        daemonId,
        runtimeIds: [runtimeId, 'missing'],
      }),
    ).rejects.toMatchObject({ kind: 'notFound', code: 'RUNTIME_NOT_FOUND' });
    await expect(
      services.runtimes.heartbeat(ALICE.id!, {
        daemonId: 'unknown-daemon',
        runtimeIds: [],
      }),
    ).rejects.toMatchObject({ code: 'RUNTIME_NOT_FOUND' });
    expect(
      await services.runtimes.heartbeat(ALICE.id!, {
        daemonId,
        runtimeIds: [runtimeId],
      }),
    ).toMatchObject({ count: 1, compatibility: { status: 'ok' } });
  });

  it('skips archived agents', async () => {
    const { runtimeId, daemonId } = await registerRuntime(services, ALICE);
    const agentId = await createAgent(
      services,
      ALICE,
      runtimeId,
      'Archived',
      6,
    );
    await queueIssues(agentId, 1);
    await services.agents.update(ALICE, agentId, {
      configurationRevision: (await services.agents.get(ALICE, agentId))
        .configurationRevision,
      archived: true,
    });
    expect(
      (
        await services.claims.claim(
          ALICE.id!,
          {
            daemonId,
            configurationProtocol: 1,
            slots: [{ runtimeId, free: 5 }],
          },
          'u',
        )
      ).runs,
    ).toHaveLength(0);
  });
});

describe.skipIf(!db)('run tokens and events (PostgreSQL)', () => {
  async function claimOne(): Promise<{ runId: string; token: string }> {
    const { runtimeId } = await registerRuntime(services, ALICE);
    const agentId = await createAgent(services, ALICE, runtimeId, 'Evented', 6);
    await queueIssues(agentId, 1);
    const claimed = await services.claims.claimOne(runtimeId);
    return claimed!;
  }

  it('resolves a live token and rejects it once the run is terminal', async () => {
    const { runId, token } = await claimOne();
    const auth = await services.runTokens.verify(token);
    expect(auth).toMatchObject({ runId, actorUserId: ALICE.id });
    expect(await services.runTokens.verify(`npr_${'0'.repeat(40)}`)).toBeNull();
    await services.runs.start(runId, { workDir: '/w' });
    await services.runs.complete(runId, { workDir: '/w' });
    expect(await services.runTokens.verify(token)).toBeNull();
  });

  it('appends events idempotently on seq and truncates oversized content', async () => {
    const { runId } = await claimOne();
    const at = new Date().toISOString();
    const first = await services.runEvents.append(runId, [
      { seq: 1, type: 'text', content: 'a', at },
      { seq: 2, type: 'toolUse', tool: 'bash', input: { cmd: 'ls' }, at },
      { seq: 3, type: 'toolResult', output: 'x'.repeat(70 * 1024), at },
    ]);
    expect(first).toEqual({ accepted: 3, last: 3 });
    const second = await services.runEvents.append(runId, [
      { seq: 2, type: 'text', content: 'duplicate', at },
      { seq: 3, type: 'text', content: 'duplicate', at },
      { seq: 4, type: 'status', content: 'done', at },
    ]);
    expect(second).toEqual({ accepted: 1, last: 4 });

    const listed = await services.runEvents.list(runId, null);
    expect(listed.last).toBe(4);
    expect(listed.data.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(listed.data[1]).toMatchObject({
      type: 'toolUse',
      tool: 'bash',
      input: { cmd: 'ls' },
    });
    expect(listed.data[2]!.truncated).toBe(true);
    expect(Buffer.byteLength(listed.data[2]!.output ?? '')).toBe(64 * 1024);
    expect(
      (await services.runEvents.list(runId, 2)).data.map((event) => event.seq),
    ).toEqual([3, 4]);
  });

  it('rejects batches over 200 events', async () => {
    const { runId } = await claimOne();
    const at = new Date().toISOString();
    const events = Array.from({ length: 201 }, (_, seq) => ({
      seq,
      type: 'text' as const,
      content: 'x',
      at,
    }));
    await expect(
      services.runEvents.append(runId, events),
    ).rejects.toMatchObject({ code: 'BATCH_TOO_LARGE' });
  });
});
