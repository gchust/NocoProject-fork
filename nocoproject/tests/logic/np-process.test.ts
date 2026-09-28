// @vitest-environment node
/**
 * The design-first process (iteration-4 contract §B): the classifier (pure heuristics, the AI fallback), process
 * selection on creation and PATCH (`PROCESS_LOCKED`), the design gate for agents, the proposal endpoint, the
 * `design_review` decision card and its actions, approving (wakes the agent with `designApproved`) and sending back
 * (comment + analysis), the claim payload and intake passthrough — on a real PostgreSQL.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  classifyHeuristic,
  createProcessClassifier,
  parseProcessReply,
  type AiProcessClassifier,
} from '../../server/modules/intake/process-classifier.ts';
import type { NpServices } from '../../server/modules/services.ts';
import type {
  ClaimedRunPhase4Extras,
  CommentV2,
  DesignDecisionResultV4,
  IssueV4,
} from '../../server/modules/shared/protocol.ts';
import {
  ALICE,
  BOB,
  buildServices,
  claimOne,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  rows,
  runRows,
  setRole,
  triggerRows,
  type Fixture,
  type NpTestDatabase,
} from './np-harness.ts';
import {
  agentApi4,
  browserApi4,
  createKindAgent,
  openItems,
  type ApiCall,
} from './np-iter4-harness.ts';

/** Long enough to escape the short-brief rule, with no design signal, so only the model can decide. */
const NEUTRAL =
  'Please make the tooltip appear on hover over the save button and hide it again on blur. '.repeat(
    3,
  );

describe('process classifier (pure)', () => {
  it('applies the heuristic rules in order', () => {
    expect(
      classifyHeuristic({ title: 'Checkout', description: 'x'.repeat(600) }),
    ).toEqual({ process: 'design_first', rule: 'long_description' });
    expect(
      classifyHeuristic({ title: 'fix: login redirect', description: '' }),
    ).toEqual({ process: 'direct', rule: 'fix_prefix' });
    expect(
      classifyHeuristic({ title: '修复迁移脚本的报错', description: '一行' }),
    ).toEqual({ process: 'direct', rule: 'fix_prefix' });
    expect(
      classifyHeuristic({ title: '改文案：首页标题', description: '' }).rule,
    ).toBe('fix_prefix');
    // A fix with a long description is not a small change any more.
    expect(
      classifyHeuristic({ title: 'Fix sync', description: 'y'.repeat(250) })
        .process,
    ).toBe('direct');
    expect(
      classifyHeuristic({ title: '重构认证模块', description: '' }),
    ).toEqual({ process: 'design_first', rule: 'keyword' });
    expect(
      classifyHeuristic({ title: 'Migrate billing to v2', description: '' })
        .rule,
    ).toBe('keyword');
    expect(
      classifyHeuristic({
        title: 'Onboarding',
        description: '- one\n- two\n- three',
      }),
    ).toEqual({ process: 'design_first', rule: 'subtasks' });
    expect(
      classifyHeuristic({ title: '支持导出', description: '需要拆分成几步' })
        .rule,
    ).toBe('subtasks');
    expect(
      classifyHeuristic({ title: 'Add a tooltip', description: 'On save.' }),
    ).toEqual({ process: 'direct', rule: 'short_description' });
    expect(
      classifyHeuristic({ title: 'Tooltip', description: NEUTRAL }),
    ).toEqual({ process: 'direct', rule: null });
  });

  it('reads the model reply', () => {
    expect(parseProcessReply('{"process":"design_first"}')).toBe(
      'design_first',
    );
    expect(parseProcessReply('```json\n{"process": "direct"}\n```')).toBe(
      'direct',
    );
    expect(parseProcessReply([{ text: 'design_first' }])).toBe('design_first');
    expect(parseProcessReply('no idea')).toBeNull();
  });

  it('asks the model only when no rule matched, and falls back on failure', async () => {
    const calls: string[] = [];
    const ai = (answer: () => Promise<'direct' | 'design_first' | null>) =>
      ({
        classify: async (input) => {
          calls.push(input.title);
          return answer();
        },
      }) satisfies AiProcessClassifier;
    const options = { userId: 'u1', useAi: true };
    const classifier = createProcessClassifier({
      ai: ai(async () => 'design_first'),
      aiConfigured: () => true,
    });
    expect(
      await classifier.classify(
        { title: 'fix typo', description: '' },
        options,
      ),
    ).toMatchObject({ process: 'direct', by: 'heuristic' });
    expect(
      await classifier.classify(
        { title: 'Tooltip', description: NEUTRAL },
        options,
      ),
    ).toEqual({ process: 'design_first', by: 'ai', rule: null });
    expect(calls).toEqual(['Tooltip']);
    const failing = createProcessClassifier({
      ai: ai(async () => {
        throw new Error('The process classifier timed out.');
      }),
      aiConfigured: () => true,
    });
    expect(
      await failing.classify(
        { title: 'Tooltip', description: NEUTRAL },
        options,
      ),
    ).toEqual({ process: 'direct', by: 'heuristic', rule: null });
    const unconfigured = createProcessClassifier({
      ai: ai(async () => 'design_first'),
      aiConfigured: () => false,
    });
    expect(
      (
        await unconfigured.classify(
          { title: 'Tooltip', description: NEUTRAL },
          options,
        )
      ).by,
    ).toBe('heuristic');
    expect(
      (
        await classifier.classify(
          { title: 'Tooltip', description: NEUTRAL },
          { ...options, useAi: false },
        )
      ).by,
    ).toBe('heuristic');
  });
});

const opened = await openNpTestDatabase('np_t_process');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-process] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

let services: NpServices;
let alice: ApiCall;
let bob: ApiCall;
let fixture: Fixture;
let coder: string;

beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  services = buildServices(db.database, {
    aiConfigured: () => true,
    aiProcess: { classify: async () => 'design_first' },
  }).services;
  await setRole(db, ALICE, 'member');
  await setRole(db, BOB, 'member');
  alice = browserApi4(services, ALICE);
  bob = browserApi4(services, BOB);
  fixture = await registerRuntime(services, ALICE);
  coder = await createKindAgent(
    services,
    ALICE,
    fixture.runtimeId,
    'Coder',
    'coder',
  );
});

type Data<T> = { data: T };

/** The issue's activities of one action, oldest first, with parsed details. */
async function activities(issueId: string, action: string) {
  const found = await rows(
    db!,
    'activities',
    'issue_id = ? AND action = ? ORDER BY created_at, id',
    [issueId, action],
  );
  return found.map((row) => ({
    ...row,
    details:
      typeof row.details === 'string'
        ? (JSON.parse(row.details) as Record<string, unknown>)
        : row.details,
  }));
}

/** A design-first issue executed by the coder, its run claimed: the agent API with that run's token. */
async function designFirstRun(title = 'Payments') {
  const issue = await services.issues.create(ALICE, {
    title,
    process: 'design_first',
    executor: { type: 'agent', id: coder },
  } as never);
  const claimed = await claimOne(services, ALICE, fixture);
  if (!claimed) throw new Error('nothing was claimed');
  return {
    issue: issue as IssueV4,
    claimed: claimed as typeof claimed & ClaimedRunPhase4Extras,
    agent: agentApi4(services, claimed.token),
  };
}

describe.skipIf(!db)('process selection (PostgreSQL)', () => {
  it('records how the process was chosen on creation', async () => {
    const explicit = await alice<Data<IssueV4>>('POST', '/np/issues', {
      title: 'Add a tooltip',
      process: 'design_first',
    });
    expect(explicit.status).toBe(201);
    expect(explicit.body.data.process).toBe('design_first');
    expect(explicit.body.data.designApprovedAt).toBeNull();
    expect(
      (await activities(explicit.body.data.id, 'process_selected'))[0]?.details,
    ).toEqual({ process: 'design_first', by: 'user' });

    const heuristic = await alice<Data<IssueV4>>('POST', '/np/issues', {
      title: 'fix: broken link',
      process: 'auto',
    });
    expect(heuristic.body.data.process).toBe('direct');
    expect(
      (await activities(heuristic.body.data.id, 'process_selected'))[0]
        ?.details,
    ).toEqual({ process: 'direct', by: 'heuristic', rule: 'fix_prefix' });

    // No rule matched: the (fake) model decides.
    const ai = await alice<Data<IssueV4>>('POST', '/np/issues', {
      title: 'Add a tooltip',
      description: NEUTRAL,
    });
    expect(ai.body.data.process).toBe('design_first');
    expect(
      (await activities(ai.body.data.id, 'process_selected'))[0]?.details,
    ).toEqual({ process: 'design_first', by: 'ai' });

    await setRole(db!, ALICE, 'owner');
    await services.workspaceSettings.update(ALICE, {
      defaultProcess: 'direct',
    });
    const defaulted = await alice<Data<IssueV4>>('POST', '/np/issues', {
      title: 'Refactor everything',
    });
    expect(defaulted.body.data.process).toBe('direct');
    expect(
      (await activities(defaulted.body.data.id, 'process_selected'))[0]
        ?.details,
    ).toEqual({ process: 'direct', by: 'default' });

    const invalid = await alice('POST', '/np/issues', {
      title: 'x',
      process: 'later',
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('INVALID_PROCESS');
  });

  it('lets the process change only in backlog or todo', async () => {
    const issue = (await services.issues.create(ALICE, {
      title: 'fix: typo',
    })) as IssueV4;
    const patched = await alice<Data<IssueV4>>(
      'PATCH',
      `/np/issues/${issue.id}`,
      { process: 'design_first', revision: issue.revision },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.data.process).toBe('design_first');
    expect(
      (await activities(issue.id, 'process_selected')).at(-1)?.details,
    ).toEqual({ process: 'design_first', from: 'direct', by: 'user' });
    const auto = await alice('PATCH', `/np/issues/${issue.id}`, {
      process: 'auto',
      revision: patched.body.data.revision,
    });
    expect(auto.body.code).toBe('INVALID_PROCESS');
    const started = await alice<Data<IssueV4>>(
      'PATCH',
      `/np/issues/${issue.id}`,
      { statusKey: 'in_progress', revision: patched.body.data.revision },
    );
    // A member may start an unapproved design-first issue: the design is skipped, and recorded.
    expect(started.body.data.statusKey).toBe('in_progress');
    expect((await activities(issue.id, 'design_skipped'))[0]?.details).toEqual({
      from: 'todo',
    });
    const locked = await alice('PATCH', `/np/issues/${issue.id}`, {
      process: 'direct',
      revision: started.body.data.revision,
    });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('PROCESS_LOCKED');
  });
});

describe.skipIf(!db)('design gate and proposal (PostgreSQL)', () => {
  it('keeps agents out of in_progress until the design is approved', async () => {
    const { issue, claimed, agent } = await designFirstRun();
    expect(claimed.issue).toMatchObject({
      process: 'design_first',
      designApprovedAt: null,
      designProposal: null,
      originType: 'manual',
    });
    expect(claimed.agent).toMatchObject({
      kind: 'coder',
      reasoningEffort: null,
    });
    const view = await agent<Data<{ process: string }>>(
      'GET',
      `/issues/${issue.id}`,
    );
    expect(view.body.data.process).toBe('design_first');
    const start = await agent('POST', `/issues/${issue.id}/status`, {
      statusKey: 'in_progress',
    });
    expect(start.status).toBe(403);
    expect(start.body.code).toBe('DESIGN_NOT_APPROVED');
    const analysis = await agent<Data<IssueV4>>(
      'POST',
      `/issues/${issue.id}/status`,
      { statusKey: 'analysis' },
    );
    expect(analysis.body.data.statusKey).toBe('analysis');
    const review = await agent('POST', `/issues/${issue.id}/status`, {
      statusKey: 'proposal_review',
    });
    expect(review.status).toBe(409);
    expect(review.body.code).toBe('PROPOSAL_REQUIRED');
  });

  it('refuses analysis on a direct issue', async () => {
    await services.issues.create(ALICE, {
      title: 'fix: small',
      executor: { type: 'agent', id: coder },
    });
    const claimed = await claimOne(services, ALICE, fixture);
    const agent = agentApi4(services, claimed!.token);
    const response = await agent(
      'POST',
      `/issues/${claimed!.issue.id}/status`,
      { statusKey: 'analysis' },
    );
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('TRANSITION_NOT_ALLOWED');
  });

  it('posts the proposal, raises the decision card and merges revisions into it', async () => {
    const { issue, agent } = await designFirstRun();
    const empty = await agent('POST', `/issues/${issue.id}/design-proposal`, {
      content: '  ',
    });
    expect(empty.body.code).toBe('INVALID_CONTENT');
    const proposal = await agent<Data<CommentV2>>(
      'POST',
      `/issues/${issue.id}/design-proposal`,
      { content: `## 需求理解\n${'方案'.repeat(200)}` },
    );
    expect(proposal.status).toBe(201);
    expect(proposal.body.data).toMatchObject({
      kind: 'proposal',
      authorType: 'agent',
      parentId: null,
    });
    // Proposed from todo: the issue moved to analysis first.
    const detail = await services.issueQueries.detail(ALICE, issue.id);
    expect(detail.issue.statusKey).toBe('analysis');
    expect(detail.issue.designProposal?.commentId).toBe(proposal.body.data.id);
    expect(await activities(issue.id, 'design_proposed')).toHaveLength(1);
    expect(await openItems(services, ALICE, 'design_review')).toEqual([]);

    await agent('POST', `/issues/${issue.id}/status`, {
      statusKey: 'proposal_review',
    });
    const [card] = await openItems(services, ALICE, 'design_review');
    expect(card).toMatchObject({ kind: 'decision', count: 1 });
    expect(card!.payload).toMatchObject({
      proposalCommentId: proposal.body.data.id,
      from: 'analysis',
    });
    expect(String(card!.payload?.summary)).toHaveLength(300);
    const actions = card!.payload?.actions as {
      key: string;
      path: string;
      needsComment?: boolean;
    }[];
    expect(actions.map((action) => action.key)).toEqual([
      'approve',
      'requestChanges',
      'open',
    ]);
    expect(actions[0]!.path).toBe(`/np/issues/${issue.id}/design/approve`);
    expect(actions[1]).toMatchObject({
      path: `/np/issues/${issue.id}/design/request-changes`,
      needsComment: true,
    });

    const revised = await agent<Data<CommentV2>>(
      'POST',
      `/issues/${issue.id}/design-proposal`,
      { content: 'Revised proposal' },
    );
    const [merged] = await openItems(services, ALICE, 'design_review');
    expect(merged).toMatchObject({ id: card!.id, count: 2 });
    expect(merged!.payload).toMatchObject({
      proposalCommentId: revised.body.data.id,
      summary: 'Revised proposal',
    });
  });
});

describe.skipIf(!db)('design decisions (PostgreSQL)', () => {
  async function inReview() {
    const run = await designFirstRun();
    await run.agent('POST', `/issues/${run.issue.id}/design-proposal`, {
      content: 'Plan A',
    });
    await run.agent('POST', `/issues/${run.issue.id}/status`, {
      statusKey: 'proposal_review',
    });
    await services.runs.complete(run.claimed.run.id, { workDir: '/tmp/w' });
    return run;
  }

  it('approves: in_progress, activity, a designApproved run with the comment, card resolved', async () => {
    const { issue } = await inReview();
    const forbidden = await bob(
      'POST',
      `/np/issues/${issue.id}/design/approve`,
    );
    expect(forbidden.status).toBe(403);
    const approved = await alice<Data<DesignDecisionResultV4>>(
      'POST',
      `/np/issues/${issue.id}/design/approve`,
      { comment: 'Go with plan A.' },
    );
    expect(approved.status).toBe(200);
    const result = approved.body.data;
    expect(result.issue).toMatchObject({
      statusKey: 'in_progress',
      designApprovedById: ALICE.id,
    });
    expect(result.issue.designApprovedAt).toEqual(expect.any(String));
    expect(result.comment?.content).toBe('Go with plan A.');
    expect(result.triggered).toHaveLength(1);
    const [run] = await runRows(db!, `id = '${result.triggered[0]!.runId}'`);
    expect(run).toMatchObject({ agent_id: coder, status: 'queued' });
    const triggers = await triggerRows(db!, result.triggered[0]!.runId);
    expect(triggers.map((row) => row.type)).toEqual(['designApproved']);
    expect(triggers[0]!.comment_id).toBe(result.comment?.id);
    expect(
      (await activities(issue.id, 'design_approved'))[0]?.details,
    ).toMatchObject({ from: 'proposal_review', to: 'in_progress' });
    expect(await openItems(services, ALICE, 'design_review')).toEqual([]);
    const again = await alice('POST', `/np/issues/${issue.id}/design/approve`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('DESIGN_ALREADY_APPROVED');
    // The implementation run sees the approval in its claim payload.
    const claimed = (await claimOne(services, ALICE, fixture)) as unknown as {
      issue: ClaimedRunPhase4Extras['issue'];
      triggers: { type: string; comment?: { content: string } }[];
    };
    expect(claimed.issue.designApprovedAt).toEqual(expect.any(String));
    expect(claimed.issue.designProposal?.content).toBe('Plan A');
    expect(claimed.triggers[0]).toMatchObject({
      type: 'designApproved',
      comment: { content: 'Go with plan A.' },
    });
  });

  it('sends back: comment wakes the agent, status analysis, card resolved', async () => {
    const { issue } = await inReview();
    const missing = await alice(
      'POST',
      `/np/issues/${issue.id}/design/request-changes`,
      {},
    );
    expect(missing.body.code).toBe('INVALID_COMMENT');
    const sent = await bob<Data<DesignDecisionResultV4>>(
      'POST',
      `/np/issues/${issue.id}/design/request-changes`,
      { comment: 'Cover refunds too.' },
    );
    expect(sent.status).toBe(200);
    expect(sent.body.data.issue.statusKey).toBe('analysis');
    expect(sent.body.data.comment).toMatchObject({
      content: 'Cover refunds too.',
      parentId: null,
    });
    expect(sent.body.data.triggered).toHaveLength(1);
    const triggers = await triggerRows(db!, sent.body.data.triggered[0]!.runId);
    expect(triggers.map((row) => row.type)).toEqual(['comment']);
    expect(
      (await activities(issue.id, 'design_changes_requested'))[0]?.details,
    ).toMatchObject({ from: 'proposal_review', to: 'analysis' });
    expect(await openItems(services, ALICE, 'design_review')).toEqual([]);
  });

  it('refuses decisions on a direct issue', async () => {
    const issue = await services.issues.create(ALICE, { title: 'fix: x' });
    const response = await alice(
      'POST',
      `/np/issues/${issue.id}/design/approve`,
    );
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('NOT_DESIGN_FIRST');
  });
});

describe.skipIf(!db)('intake process passthrough (PostgreSQL)', () => {
  it('writes the batch process into the drafts and confirms it', async () => {
    const created = await alice<
      Data<{
        batch: { id: string };
        drafts: { fields: { process?: string } }[];
      }>
    >('POST', '/np/intake/batches', {
      source: 'paste',
      rawContent: '- fix: typo on the landing page\n- Add a tooltip',
      process: 'design_first',
    });
    expect(created.status).toBe(201);
    expect(
      created.body.data.drafts.map((draft) => draft.fields.process),
    ).toEqual(['design_first', 'design_first']);
    const batchId = created.body.data.batch.id;
    const drafts = await alice<
      Data<{ drafts: { validation: { errors: string[] } }[] }>
    >('PUT', `/np/intake/batches/${batchId}/drafts`, {
      drafts: [
        {
          position: 1,
          parentPosition: null,
          fields: { title: 'fix: typo', process: 'auto' },
        },
        {
          position: 2,
          parentPosition: null,
          fields: { title: 'Add a tooltip', process: 'soon' },
        },
      ],
    });
    expect(drafts.body.data.drafts[1]!.validation.errors).toContain(
      'process must be auto, direct or design_first',
    );
    await alice('PUT', `/np/intake/batches/${batchId}/drafts`, {
      drafts: [
        {
          position: 1,
          parentPosition: null,
          fields: { title: 'fix: typo', process: 'auto' },
        },
        {
          position: 2,
          parentPosition: null,
          fields: { title: 'Add a tooltip', process: 'design_first' },
        },
      ],
    });
    const confirmed = await alice<Data<{ issues: { id: string }[] }>>(
      'POST',
      `/np/intake/batches/${batchId}/confirm`,
      {},
    );
    expect(confirmed.status).toBe(200);
    const [first, second] = confirmed.body.data.issues;
    const firstRow = (await rows(db!, 'issues', 'id = ?', [first!.id]))[0];
    const secondRow = (await rows(db!, 'issues', 'id = ?', [second!.id]))[0];
    expect(firstRow?.process).toBe('direct');
    expect(secondRow?.process).toBe('design_first');
    // Intake uses the heuristic only (the fake model would have said design_first).
    expect(
      (await activities(first!.id, 'process_selected'))[0]?.details,
    ).toEqual({ process: 'direct', by: 'heuristic', rule: 'fix_prefix' });
    expect(
      (await activities(second!.id, 'process_selected'))[0]?.details,
    ).toEqual({ process: 'design_first', by: 'user' });
  });
});
