// @vitest-environment node
/**
 * Inbox items that can be acted on directly (iteration-3 contract §E): `payload.actions` for every type (pure, and
 * computed on read for rows written before iteration 3), and the delivery endpoints on a real PostgreSQL —
 * accept (done + optional comment that triggers nothing), accept held for approval (202), request changes
 * (in_progress + a comment that wakes the executor) — each resolving the `review_requested` card; `agent_blocked`
 * resolving on a reply or a reassignment.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { inboxActions } from '../../server/modules/notification/inbox.actions.ts';
import type { NpServices } from '../../server/modules/services.ts';
import type { Actor } from '../../server/modules/shared/activity.ts';
import type {
  DeliveryResultV3,
  InboxAction,
  InboxItemV3,
} from '../../server/modules/shared/protocol.ts';
import {
  ALICE,
  BOB,
  buildServices,
  createAgent,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  rows,
  runRows,
  setRole,
  type NpTestDatabase,
} from './np-harness.ts';
import { browserApi, type ApiCall } from './np-iter3-harness.ts';

const keys = (actions: readonly InboxAction[]) =>
  actions.map((action) => action.key);

describe('inbox actions per type (pure)', () => {
  const base = {
    issueId: 'i1',
    issueIdentifier: 'NP-1',
    resolvedAt: null,
  } as const;

  it('gives every decision type its actions', () => {
    const review = inboxActions({
      ...base,
      type: 'review_requested',
      payload: {},
    });
    expect(keys(review)).toEqual(['accept', 'requestChanges', 'open']);
    expect(review[0]).toEqual({
      key: 'accept',
      label: 'np.inboxActions.accept',
      kind: 'primary',
      method: 'POST',
      path: '/np/issues/i1/deliveries/accept',
      commentField: 'comment',
    });
    expect(review[1]).toMatchObject({
      path: '/np/issues/i1/deliveries/request-changes',
      needsComment: true,
    });
    expect(review[2]).toMatchObject({
      method: 'GET',
      path: '/issues/NP-1',
      opensIssue: true,
    });
    const blocked = inboxActions({
      ...base,
      type: 'agent_blocked',
      payload: {},
    });
    expect(keys(blocked)).toEqual(['reply', 'reassign', 'open']);
    expect(blocked[0]).toMatchObject({
      path: '/np/issues/i1/comments',
      needsComment: true,
      commentField: 'content',
    });
    expect(blocked[1]).toMatchObject({ opensIssue: true, method: 'GET' });
    expect(
      inboxActions({
        ...base,
        type: 'proposal_pending',
        payload: { parentIssueId: 'p9' },
      })[0],
    ).toMatchObject({
      key: 'acceptAll',
      path: '/np/issues/p9/proposals/accept-all',
    });
    const approval = inboxActions({
      ...base,
      type: 'approval_pending',
      payload: { requestId: 'ap1' },
    });
    expect(keys(approval)).toEqual(['approve', 'reject', 'open']);
    expect(approval[1]).toMatchObject({
      kind: 'danger',
      path: '/np/approvals/ap1/reject',
      needsComment: true,
    });
    expect(
      keys(inboxActions({ ...base, type: 'batch_done', payload: {} })),
    ).toEqual(['open']);
    const pr = inboxActions({
      ...base,
      type: 'pr_review',
      payload: { url: 'https://github.com/a/b/pull/1' },
    });
    expect(keys(pr)).toEqual(['openPr', 'open']);
    expect(pr[0]).toMatchObject({
      method: 'GET',
      path: 'https://github.com/a/b/pull/1',
      external: true,
    });
    const knowledge = inboxActions({
      ...base,
      type: 'knowledge_proposal',
      payload: { proposalId: 'k1', docId: 'd1' },
    });
    expect(keys(knowledge)).toEqual(['accept', 'reject', 'openDoc', 'open']);
    expect(knowledge[0]?.path).toBe('/np/knowledge/proposals/k1/accept');
    expect(knowledge[2]?.path).toBe('/knowledge/d1');
    expect(
      keys(inboxActions({ ...base, type: 'commented', payload: {} })),
    ).toEqual(['open']);
  });

  it('keeps only navigation once resolved, and nothing without an issue', () => {
    expect(
      keys(
        inboxActions({
          ...base,
          type: 'review_requested',
          payload: {},
          resolvedAt: '2026-09-30T00:00:00.000Z',
        }),
      ),
    ).toEqual(['open']);
    expect(
      inboxActions({
        type: 'commented',
        issueId: null,
        issueIdentifier: null,
        payload: null,
        resolvedAt: null,
      }),
    ).toEqual([]);
  });
});

const opened = await openNpTestDatabase('np_t_inbox_actions');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-inbox-actions] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

let services: NpServices;
let alice: ApiCall;
let bob: ApiCall;
let agentId: string;

beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  services = buildServices(db.database).services;
  await setRole(db, ALICE, 'owner');
  await setRole(db, BOB, 'member');
  alice = browserApi(services, ALICE);
  bob = browserApi(services, BOB);
  const fixture = await registerRuntime(services, ALICE);
  agentId = await createAgent(services, ALICE, fixture.runtimeId, 'Dev');
});

/** An issue owned by Alice, executed by the agent, that the agent moved to `target`. */
async function delivered(
  target: 'in_review' | 'blocked',
  projectId?: string,
): Promise<string> {
  const issue = await services.issues.create(ALICE, {
    title: `Deliver ${target}`,
    executor: { type: 'agent', id: agentId },
    ...(projectId ? { projectId } : {}),
  });
  const [run] = await runRows(db!, `subject_id = '${issue.id}'`);
  const agent: Actor = { type: 'agent', id: agentId, runId: String(run?.id) };
  await services.issues.agentSetStatus(agent, issue.id, 'in_progress');
  await services.issues.agentSetStatus(agent, issue.id, target);
  // The run is done; a later comment may queue a new one.
  await db!.knex.raw(
    `UPDATE "${db!.schema}".runs SET status = 'completed', finished_at = now() WHERE subject_id = ?`,
    [issue.id],
  );
  return issue.id;
}

async function card(
  userId: Actor,
  type: string,
  issueId: string,
): Promise<InboxItemV3 | undefined> {
  const items = await services.inbox.list(userId, { resolved: null });
  return items.data.find(
    (item) => item.type === type && item.issueId === issueId,
  );
}

function action(item: InboxItemV3 | undefined, key: string): InboxAction {
  const found = (item?.payload?.actions as InboxAction[] | undefined)?.find(
    (candidate) => candidate.key === key,
  );
  if (!found) throw new Error(`no ${key} action`);
  return found;
}

describe.skipIf(!db)('delivery endpoints and resolution (PostgreSQL)', () => {
  it('accepts a delivery: done, a note that wakes nobody, the card resolved', async () => {
    const issueId = await delivered('in_review');
    const review = await card(ALICE, 'review_requested', issueId);
    expect(review?.resolvedAt).toBeNull();
    const accept = action(review, 'accept');
    const response = await alice<{ data: DeliveryResultV3 }>(
      'POST',
      accept.path,
      {
        comment: 'Looks good',
      },
    );
    expect(response.status).toBe(200);
    expect(response.body.data.issue.statusKey).toBe('done');
    expect(response.body.data.pendingApproval).toBeNull();
    expect(response.body.data.comment?.content).toBe('Looks good');
    expect(
      (await card(ALICE, 'review_requested', issueId))?.resolvedAt,
    ).not.toBeNull();
    const active = await runRows(
      db!,
      `subject_id = '${issueId}' AND status IN ('queued', 'deferred')`,
    );
    expect(active).toEqual([]);
    const activity = await rows(
      db!,
      'activities',
      "issue_id = ? AND action = 'delivery_accepted'",
      [issueId],
    );
    expect(activity).toHaveLength(1);
    // A second accept is harmless (already done); the body may be omitted.
    expect((await alice('POST', accept.path)).status).toBe(200);
  });

  it('holds an acceptance for approval with 202 and still resolves the review card', async () => {
    const project = await services.projects.create(ALICE, { name: 'Gated' });
    await services.projects.update(ALICE, project.id, {
      workflowId: 'software-with-approval',
    });
    const issueId = await delivered('in_review', project.id);
    const response = await bob<{ data: DeliveryResultV3 }>(
      'POST',
      `/np/issues/${issueId}/deliveries/accept`,
    );
    expect(response.status).toBe(202);
    expect(response.body.data.issue.statusKey).toBe('in_review');
    expect(response.body.data.pendingApproval).toMatchObject({
      status: 'pending',
      toStatus: 'done',
    });
    expect(
      (await card(ALICE, 'review_requested', issueId))?.resolvedAt,
    ).not.toBeNull();
    const approval = await card(ALICE, 'approval_pending', issueId);
    expect(keys(approval?.payload?.actions as InboxAction[])).toEqual([
      'approve',
      'reject',
      'open',
    ]);
    const approve = action(approval, 'approve');
    expect(approve.path).toBe(
      `/np/approvals/${response.body.data.pendingApproval?.id}/approve`,
    );
  });

  it('requests changes: in_progress, a comment that wakes the executor, the card resolved', async () => {
    const issueId = await delivered('in_review');
    const review = await card(ALICE, 'review_requested', issueId);
    const request = action(review, 'requestChanges');
    const missing = await alice('POST', request.path, {});
    expect(missing).toMatchObject({
      status: 400,
      body: { code: 'INVALID_COMMENT' },
    });
    const response = await alice<{ data: DeliveryResultV3 }>(
      'POST',
      request.path,
      {
        [request.commentField ?? 'comment']: 'Please add tests',
      },
    );
    expect(response.status).toBe(200);
    expect(response.body.data.issue.statusKey).toBe('in_progress');
    expect(response.body.data.comment?.content).toBe('Please add tests');
    expect(
      (await card(ALICE, 'review_requested', issueId))?.resolvedAt,
    ).not.toBeNull();
    const queued = await runRows(
      db!,
      `subject_id = '${issueId}' AND status IN ('queued', 'deferred')`,
    );
    expect(queued).toHaveLength(1);
    const activity = await rows(
      db!,
      'activities',
      "issue_id = ? AND action = 'changes_requested'",
      [issueId],
    );
    expect(activity).toHaveLength(1);
  });

  it('resolves agent_blocked on a reply (not a note) and on reassignment', async () => {
    const first = await delivered('blocked');
    const blocked = await card(ALICE, 'agent_blocked', first);
    expect(keys(blocked?.payload?.actions as InboxAction[])).toEqual([
      'reply',
      'reassign',
      'open',
    ]);
    await services.comments.create(ALICE, first, { content: '/note thinking' });
    expect((await card(ALICE, 'agent_blocked', first))?.resolvedAt).toBeNull();
    await services.comments.create(ALICE, first, {
      content: 'Use the staging DB',
    });
    expect(
      (await card(ALICE, 'agent_blocked', first))?.resolvedAt,
    ).not.toBeNull();

    const second = await delivered('blocked');
    const issue = await services.issueQueries.detail(ALICE, second);
    await services.issues.update(ALICE, second, {
      executor: { type: 'user', id: BOB.id },
      revision: issue.issue.revision,
    });
    expect(
      (await card(ALICE, 'agent_blocked', second))?.resolvedAt,
    ).not.toBeNull();
  });

  it('computes actions on read for items written before iteration 3', async () => {
    const issue = await services.issues.create(ALICE, { title: 'Legacy' });
    await db!.knex.raw(
      `INSERT INTO "${db!.schema}".inbox_items (id, user_id, kind, type, issue_id, title, dedupe_key, payload,
         created_at, updated_at)
       VALUES ('legacy-1', ?, 'decision', 'review_requested', ?, 't', 'legacy-1', '{"from":"in_progress"}', now(), now()),
              ('legacy-2', ?, 'decision', 'pr_review', ?, 't', 'legacy-2', NULL, now(), now())`,
      [ALICE.id, issue.id, ALICE.id, issue.id],
    );
    const items = (await services.inbox.list(ALICE, {})).data;
    const legacy = items.find((item) => item.id === 'legacy-1');
    expect(legacy?.payload).toMatchObject({ from: 'in_progress' });
    expect(keys(legacy?.payload?.actions as InboxAction[])).toEqual([
      'accept',
      'requestChanges',
      'open',
    ]);
    const pr = items.find((item) => item.id === 'legacy-2');
    // No url in the payload: only the issue link.
    expect(keys(pr?.payload?.actions as InboxAction[])).toEqual(['open']);
    const marked = await services.inbox.mark(ALICE, 'legacy-1', 'read');
    expect(keys(marked.payload?.actions as InboxAction[])).toHaveLength(3);
  });
});
