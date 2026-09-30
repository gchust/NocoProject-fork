// @vitest-environment node
/**
 * Subscriptions and the inbox on a real PostgreSQL (contract §E): automatic subscriptions, no self-notification,
 * dedupe/merge, decision auto-resolve, `run_failed` auto-archive, read state, unread and pending counts, paging, `inbox.changed`.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { NpServices } from '../../server/modules/services.ts';
import type { Actor } from '../../server/modules/shared/activity.ts';
import type { DomainEvent } from '../../server/modules/shared/events.ts';
import {
  ALICE,
  BOB,
  CAROL,
  buildServices,
  createAgent,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  rows,
  type NpTestDatabase,
} from './np-harness.ts';

const opened = await openNpTestDatabase('np_t_inbox');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-inbox] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

let services: NpServices;
let events: DomainEvent[];
let runtimeId: string;
let daemonId: string;
let agentId: string;

beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  ({ services, events } = buildServices(db.database));
  ({ runtimeId, daemonId } = await registerRuntime(services, ALICE));
  agentId = await createAgent(services, ALICE, runtimeId, 'Echo');
});

const userMention = (actor: Actor, name: string) =>
  `[@${name}](mention://user/${actor.id})`;

async function inboxOf(actor: Actor, kind?: 'decision' | 'info') {
  return services.inbox.list(actor, { kind: kind ?? null });
}

/** Starts a run on the issue and returns the agent actor of that run. */
async function runAs(): Promise<Actor> {
  const claim = await services.claims.claim(
    ALICE.id!,
    { daemonId, configurationProtocol: 1, slots: [{ runtimeId, free: 1 }] },
    'http://test',
  );
  const runId = claim.runs[0]!.run.id;
  await services.runs.start(runId, { workDir: '/w' });
  return { type: 'agent', id: agentId, runId };
}

describe.skipIf(!db)('subscriptions and inbox (PostgreSQL)', () => {
  it('subscribes the creator, owner, member executor, commenters and mentioned members', async () => {
    const issue = await services.issues.create(ALICE, {
      title: 'Subscribe',
      ownerUserId: BOB.id,
      executor: { type: 'user', id: CAROL.id! },
    });
    await services.comments.create(BOB, issue.id, { content: 'on it' });
    const detail = await services.issueQueries.detail(ALICE, issue.id);
    expect(
      detail.subscribers.map((item) => [item.userId, item.reason]).sort(),
    ).toEqual(
      [
        [ALICE.id, 'creator'],
        [BOB.id, 'owner'],
        [CAROL.id, 'executor'],
      ].sort(),
    );
    // Alice created it for Bob and Carol: they hear about it, she does not.
    expect((await inboxOf(BOB)).data.map((item) => item.type)).toEqual([
      'owner_assigned',
    ]);
    expect((await inboxOf(CAROL)).data.map((item) => item.type).sort()).toEqual(
      ['commented', 'executor_assigned'],
    );
    expect((await inboxOf(ALICE)).data.map((item) => item.type)).toEqual([
      'commented',
    ]);

    await services.inbox.unsubscribe(CAROL, issue.identifier);
    await services.comments.create(ALICE, issue.id, {
      content: `hey ${userMention(CAROL, 'Carol')}`,
    });
    const carol = await inboxOf(CAROL);
    // Mentioned members get `mentioned` rather than `commented`, subscribed or not.
    expect(carol.data.find((item) => item.type === 'mentioned')).toBeTruthy();
    expect(carol.data.find((item) => item.type === 'commented')?.count).toBe(1);
  });

  it('merges repeated notices into one unread card and restarts it once archived', async () => {
    const issue = await services.issues.create(ALICE, {
      title: 'Chatty',
      ownerUserId: BOB.id,
    });
    await services.comments.create(ALICE, issue.id, { content: 'one' });
    await services.comments.create(ALICE, issue.id, { content: 'two' });
    const [card] = (await inboxOf(BOB, 'info')).data.filter(
      (item) => item.type === 'commented',
    );
    expect(card).toMatchObject({
      count: 2,
      readAt: null,
      issueIdentifier: issue.identifier,
    });
    const read = await services.inbox.mark(BOB, card!.id, 'read');
    expect(read.readAt).not.toBeNull();
    await services.comments.create(ALICE, issue.id, { content: 'three' });
    const merged = (await inboxOf(BOB, 'info')).data.find(
      (item) => item.type === 'commented',
    );
    expect(merged).toMatchObject({ id: card!.id, count: 3, readAt: null });
    await services.inbox.mark(BOB, card!.id, 'archive');
    expect(
      (await inboxOf(BOB, 'info')).data.find(
        (item) => item.type === 'commented',
      ),
    ).toBeUndefined();
    expect(
      (await services.inbox.list(BOB, { archived: 'true' })).data.map(
        (item) => item.id,
      ),
    ).toEqual([card!.id]);
    await services.comments.create(ALICE, issue.id, { content: 'four' });
    expect(
      (await inboxOf(BOB, 'info')).data.find(
        (item) => item.type === 'commented',
      ),
    ).toMatchObject({ id: card!.id, count: 1, archivedAt: null });
    expect(events).toContainEqual({ type: 'inbox.changed', userId: BOB.id });
  });

  it('asks the owner to review when the agent delivers, and resolves it when the status moves on', async () => {
    const issue = await services.issues.create(ALICE, {
      title: 'Deliver',
      ownerUserId: BOB.id,
      executor: { type: 'agent', id: agentId },
    });
    const agent = await runAs();
    await services.issues.agentSetStatus(agent, issue.id, 'in_progress');
    await services.issues.agentSetStatus(agent, issue.id, 'in_review');
    const [review] = (await inboxOf(BOB, 'decision')).data;
    expect(review).toMatchObject({
      type: 'review_requested',
      kind: 'decision',
      actorType: 'agent',
      actorName: 'Echo',
      resolvedAt: null,
    });
    expect((await services.inbox.unreadCount(BOB)).decision).toBe(1);
    expect(await services.inbox.pendingCount(BOB)).toEqual({ decision: 1 });
    // Opening the decision clears it from the unread count but it still waits on the owner.
    await services.inbox.mark(BOB, review!.id, 'read');
    expect((await services.inbox.unreadCount(BOB)).decision).toBe(0);
    expect(await services.inbox.pendingCount(BOB)).toEqual({ decision: 1 });
    expect(await services.inbox.pendingCount(ALICE)).toEqual({ decision: 0 });
    await services.inbox.mark(BOB, review!.id, 'archive');
    expect(await services.inbox.pendingCount(BOB)).toEqual({ decision: 0 });
    await services.inbox.mark(BOB, review!.id, 'unarchive');
    expect(await services.inbox.pendingCount(BOB)).toEqual({ decision: 1 });
    // The owner got the plain notice for todo → in_progress; the in_review change is only the decision.
    const notices = (await inboxOf(BOB, 'info')).data.filter(
      (item) => item.type === 'status_changed',
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      count: 1,
      payload: { from: 'todo', to: 'in_progress' },
    });
    const current = await services.issueQueries.detail(BOB, issue.id);
    await services.issues.update(BOB, issue.id, {
      statusKey: 'done',
      revision: current.issue.revision,
    });
    const [resolved] = (await inboxOf(BOB, 'decision')).data;
    expect(resolved!.resolvedAt).not.toBeNull();
    expect((await services.inbox.unreadCount(BOB)).decision).toBe(0);
    expect(await services.inbox.pendingCount(BOB)).toEqual({ decision: 0 });
  });

  it('narrows the list to one issue for the issue page decision section', async () => {
    const delivered = await services.issues.create(ALICE, {
      title: 'Deliver me',
      ownerUserId: BOB.id,
      executor: { type: 'agent', id: agentId },
    });
    const other = await services.issues.create(ALICE, {
      title: 'Somewhere else',
      ownerUserId: BOB.id,
    });
    await services.comments.create(ALICE, other.id, { content: 'ping' });
    const agent = await runAs();
    await services.issues.agentSetStatus(agent, delivered.id, 'in_progress');
    await services.issues.agentSetStatus(agent, delivered.id, 'in_review');

    const pending = await services.inbox.list(BOB, {
      kind: 'decision',
      resolved: 'false',
      issueId: delivered.id,
    });
    expect(pending.data.map((item) => [item.type, item.issueId])).toEqual([
      ['review_requested', delivered.id],
    ]);
    const elsewhere = await services.inbox.list(BOB, {
      kind: 'decision',
      issueId: other.id,
    });
    expect(elsewhere.data).toEqual([]);
    // Without the filter the owner still sees everything addressed to them.
    expect(
      (await services.inbox.list(BOB, {})).data.map((item) => item.issueId),
    ).toEqual(expect.arrayContaining([delivered.id, other.id]));
  });

  it('reports a final run failure to subscribers and archives it when the issue reaches review', async () => {
    const issue = await services.issues.create(ALICE, {
      title: 'Fragile',
      executor: { type: 'agent', id: agentId },
    });
    await services.inbox.subscribe(BOB, issue.id);
    const agent = await runAs();
    await services.runRecovery.fail(agent.runId!, { reason: 'agentBlocked' });
    const alice = await inboxOf(ALICE);
    expect(alice.data.map((item) => item.type)).toEqual(['agent_blocked']);
    const bob = await inboxOf(BOB, 'info');
    expect(bob.data.map((item) => item.type)).toEqual(['run_failed']);

    // A retryable failure with attempts left is not final: no notice.
    const retryable = await services.issues.create(ALICE, {
      title: 'Flaky',
      executor: { type: 'agent', id: agentId },
    });
    const flaky = await runAs();
    await services.runRecovery.fail(flaky.runId!, { reason: 'runtimeOffline' });
    expect(
      await rows(db!, 'inbox_items', "type = 'run_failed' AND issue_id = ?", [
        retryable.id,
      ]),
    ).toHaveLength(0);

    const current = await services.issueQueries.detail(ALICE, issue.id);
    await services.issues.update(ALICE, issue.id, {
      statusKey: 'in_review',
      revision: current.issue.revision,
    });
    expect(
      (await inboxOf(BOB, 'info')).data.find(
        (item) => item.type === 'run_failed',
      ),
    ).toBeUndefined();
    expect(
      (await services.inbox.list(BOB, { archived: 'true' })).data.map(
        (item) => item.type,
      ),
    ).toEqual(['run_failed']);
  });

  it('marks everything read per kind and pages with a cursor', async () => {
    for (let index = 0; index < 55; index += 1)
      await services.issues.create(ALICE, {
        title: `For Bob ${index}`,
        ownerUserId: BOB.id,
      });
    const first = await services.inbox.list(BOB, {});
    expect(first.data).toHaveLength(50);
    expect(first.unread).toEqual({ decision: 0, info: 55 });
    expect(first.nextCursor).toBeTruthy();
    const second = await services.inbox.list(BOB, { cursor: first.nextCursor });
    expect(second.data).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.data, ...second.data].map((item) => item.id)).size,
    ).toBe(55);
    const counts = await services.inbox.readAll(BOB, 'info');
    expect(counts).toEqual({ decision: 0, info: 0 });
    await expect(
      services.inbox.mark(ALICE, first.data[0]!.id, 'read'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lists every pending decision before the settled ones across pages (NP-180)', async () => {
    const insert = async (
      id: string,
      minutesAgo: number,
      resolved: boolean,
    ) => {
      const at = new Date(Date.now() - minutesAgo * 60_000);
      await db!.knex(`${db!.schema}.inbox_items`).insert({
        id,
        user_id: BOB.id,
        kind: 'decision',
        type: 'review_requested',
        issue_id: null,
        title: id,
        body: '',
        count: 1,
        dedupe_key: `np180:${id}`,
        resolved_at: resolved ? at : null,
        created_at: at,
        updated_at: at,
      });
    };
    // Two old pending decisions, then 55 settled ones: settling bumps `updatedAt`, so they are all newer.
    await insert('pending-a', 1000, false);
    await insert('pending-b', 999, false);
    for (let index = 0; index < 55; index += 1)
      await insert(
        `settled-${String(index).padStart(2, '0')}`,
        500 - index,
        true,
      );
    expect((await services.inbox.pendingCount(BOB)).decision).toBe(2);
    const first = await services.inbox.list(BOB, { kind: 'decision' });
    expect(first.data.slice(0, 2).map((item) => item.id)).toEqual([
      'pending-b',
      'pending-a',
    ]);
    expect(first.data).toHaveLength(50);
    expect(first.data[2]!.id).toBe('settled-54');
    const second = await services.inbox.list(BOB, {
      kind: 'decision',
      cursor: first.nextCursor,
    });
    expect(second.data.map((item) => item.id)).toEqual([
      'settled-06',
      'settled-05',
      'settled-04',
      'settled-03',
      'settled-02',
      'settled-01',
      'settled-00',
    ]);
    expect(second.nextCursor).toBeNull();
    // Exactly one page of pending decisions: the next page starts at the newest settled one.
    for (let index = 0; index < 48; index += 1)
      await insert(
        `pending-${String(index).padStart(2, '0')}`,
        900 - index,
        false,
      );
    const full = await services.inbox.list(BOB, { kind: 'decision' });
    expect(full.data.every((item) => item.resolvedAt === null)).toBe(true);
    const rest = await services.inbox.list(BOB, {
      kind: 'decision',
      cursor: full.nextCursor,
    });
    expect(rest.data).toHaveLength(50);
    expect(rest.data[0]!.id).toBe('settled-54');
    const tail = await services.inbox.list(BOB, {
      kind: 'decision',
      cursor: rest.nextCursor,
    });
    expect(tail.data.map((item) => item.id)).toEqual([
      'settled-04',
      'settled-03',
      'settled-02',
      'settled-01',
      'settled-00',
    ]);
    expect(tail.nextCursor).toBeNull();
    // The unfiltered list keeps plain newest-first order.
    const mixed = await services.inbox.list(BOB, {});
    expect(mixed.data[0]!.id).toBe('settled-54');
  });
});
