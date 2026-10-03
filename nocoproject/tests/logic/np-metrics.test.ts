// @vitest-environment node
/**
 * Acceptance metrics (iteration-3 contract §C) on a real PostgreSQL: the six groups over a fixed fixture with known
 * answers (active days / weeks, AI share, trust rates, run reliability with percentiles and lost runs, cost through
 * the usage service, decision load), member visibility and the project filter, thresholds from the settings with a
 * status per metric, `PATCH /np/settings { metricThresholds }` validation and permissions, and the date range rules.
 * The pure helpers (percentile, ISO week, status) are covered first.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  isoWeek,
  percentile,
} from '../../server/modules/metrics/metrics.collect.ts';
import {
  metricStatus,
  metricsRange,
} from '../../server/modules/metrics/metrics.service.ts';
import type { NpServices } from '../../server/modules/services.ts';
import {
  DEFAULT_METRIC_THRESHOLDS,
  type MetricsReport,
  type WorkspaceSettingsViewV3,
} from '../../server/modules/shared/protocol.ts';
import {
  ALICE,
  BOB,
  CAROL,
  buildServices,
  createAgent,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  setRole,
  type NpTestDatabase,
} from './np-harness.ts';
import { browserApi, type ApiCall } from './np-iter3-harness.ts';

describe('metric helpers (pure)', () => {
  it('computes nearest-rank percentiles, ISO weeks and statuses', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
    expect(percentile([10, 60], 0.5)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(isoWeek('2026-09-01')).toBe('2026-W36');
    expect(isoWeek('2026-09-06')).toBe('2026-W36');
    expect(isoWeek('2026-09-07')).toBe('2026-W37');
    expect(isoWeek('2027-01-01')).toBe('2026-W53');
    const t = DEFAULT_METRIC_THRESHOLDS;
    expect(metricStatus('aiShare', 0.5, t)).toBe('ok');
    expect(metricStatus('aiShare', 0.49, t)).toBe('warn');
    expect(metricStatus('lostRuns', 0, t)).toBe('ok');
    expect(metricStatus('claimLatencyP50Ms', 3001, t)).toBe('warn');
    expect(metricStatus('proposalAcceptRate', null, t)).toBe('n/a');
  });

  it('defaults to the last 30 days and refuses bad ranges', () => {
    const range = metricsRange({});
    expect(
      (range.end.getTime() - range.start.getTime()) / (24 * 3600 * 1000),
    ).toBe(30);
    expect(
      metricsRange({ from: '2026-09-01', to: '2026-09-01' }),
    ).toMatchObject({ from: '2026-09-01', to: '2026-09-01' });
    expect(() =>
      metricsRange({ from: '2026-09-02', to: '2026-09-01' }),
    ).toThrow(/at most/u);
    expect(() =>
      metricsRange({ from: '2024-01-01', to: '2026-09-01' }),
    ).toThrow(/at most/u);
    expect(() => metricsRange({ from: '2026-9-1' })).toThrow(/YYYY-MM-DD/u);
  });
});

const opened = await openNpTestDatabase('np_t_metrics');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-metrics] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

let services: NpServices;
let alice: ApiCall;
let bob: ApiCall;
let carol: ApiCall;

beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  services = buildServices(db.database).services;
  await setRole(db, ALICE, 'owner');
  await setRole(db, BOB, 'member');
  await setRole(db, CAROL, 'member');
  alice = browserApi(services, ALICE);
  bob = browserApi(services, BOB);
  carol = browserApi(services, CAROL);
});

const at = (value: string) => new Date(`2026-09-${value}Z`);

async function insert(
  table: string,
  records: Record<string, unknown>[],
): Promise<void> {
  await db!.knex.withSchema(db!.schema).table(table).insert(records);
}

function issueRow(
  id: string,
  created: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    number: Number(id.replace(/\D/gu, '')),
    identifier: `NP-${id.replace(/\D/gu, '')}`,
    title: id,
    status_key: 'todo',
    priority: 'none',
    owner_user_id: ALICE.id,
    executor_type: 'none',
    revision: 1,
    last_activity_at: at(created),
    created_by_id: ALICE.id,
    created_at: at(created),
    updated_at: at(created),
    auto_execute_subtasks: false,
    ...extra,
  };
}

/**
 * Range 2026-09-01 … 2026-09-07. Issues i1, i2 (created 09-01), i3 (09-03), i9 deleted, p1 in a private project.
 */
async function fixture(agentId: string, secretId: string): Promise<void> {
  await insert('issues', [
    issueRow('i1', '01T09:00:00', {
      executor_type: 'agent',
      executor_id: agentId,
    }),
    issueRow('i2', '01T10:00:00', {
      executor_type: 'user',
      executor_id: BOB.id,
    }),
    issueRow('i3', '03T10:00:00'),
    issueRow('i9', '02T10:00:00', { deleted_at: at('02T11:00:00') }),
    issueRow('i10', '02T10:00:00', { project_id: secretId }),
    issueRow('i11', '08T10:00:00'),
  ]);
  const activity = (
    id: string,
    issueId: string,
    actor: string,
    created: string,
    action = 'title_changed',
    details: Record<string, unknown> | null = null,
  ) => ({
    id,
    issue_id: issueId,
    actor_type: actor === 'system' ? 'system' : 'user',
    actor_id: actor === 'system' ? null : actor,
    action,
    details: details ? JSON.stringify(details) : null,
    created_at: at(created),
  });
  await insert('activities', [
    activity('a1', 'i1', ALICE.id!, '01T09:00:00'),
    activity('a2', 'i2', BOB.id!, '03T09:00:00'),
    activity('a3', 'i1', 'system', '05T09:00:00', 'status_changed', {
      from: 'in_review',
      to: 'done',
    }),
    activity('a4', 'i2', BOB.id!, '04T09:00:00', 'status_changed', {
      from: 'in_review',
      to: 'in_progress',
    }),
    activity('a5', 'i2', ALICE.id!, '06T09:00:00', 'status_changed', {
      from: 'in_review',
      to: 'done',
    }),
    activity('a6', 'i10', CAROL.id!, '02T09:00:00', 'status_changed', {
      from: 'in_review',
      to: 'done',
    }),
    activity('a7', 'i1', CAROL.id!, '09T09:00:00'),
  ]);
  await insert('comments', [
    {
      id: 'c1',
      issue_id: 'i3',
      author_type: 'user',
      author_id: ALICE.id,
      content: 'hi',
      kind: 'comment',
      root_id: 'c1',
      created_at: at('04T12:00:00'),
      updated_at: at('04T12:00:00'),
    },
  ]);
  const proposal = (id: string, status: string, decided: string) => ({
    id,
    issue_id: 'i1',
    proposed_agent_id: agentId,
    proposed_by_agent_id: agentId,
    status,
    decided_at: at(decided),
    created_at: at(decided),
    updated_at: at(decided),
  });
  await insert('executor_proposals', [
    proposal('ep1', 'accepted', '02T01:00:00'),
    proposal('ep2', 'accepted', '02T02:00:00'),
    proposal('ep3', 'rejected', '02T03:00:00'),
    proposal('ep4', 'autoAccepted', '02T04:00:00'),
  ]);
  const approval = (id: string, status: string) => ({
    id,
    issue_id: 'i2',
    from_status: 'in_review',
    to_status: 'done',
    requested_by_type: 'user',
    requested_by_id: BOB.id,
    approver_user_ids: '[]',
    status,
    decided_at: at('05T10:00:00'),
    created_at: at('05T09:00:00'),
    updated_at: at('05T10:00:00'),
  });
  await insert('approval_requests', [
    approval('ap1', 'approved'),
    approval('ap2', 'rejected'),
  ]);
  const run = (
    id: string,
    status: string,
    times: Record<string, string | null>,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    agent_id: agentId,
    status,
    subject_type: 'issue',
    subject_id: 'i1',
    created_at: at(times.created!),
    dispatched_at: times.dispatched ? at(times.dispatched) : null,
    started_at: times.started ? at(times.started) : null,
    finished_at: times.finished ? at(times.finished) : null,
    updated_at: at(times.created!),
    ...extra,
  });
  await insert('runs', [
    run('r1', 'completed', {
      created: '05T10:00:00.000',
      dispatched: '05T10:00:01.000',
      started: '05T10:00:02.000',
      finished: '05T10:01:02.000',
    }),
    run(
      'r2',
      'failed',
      {
        created: '05T11:00:00.000',
        dispatched: '05T11:00:03.000',
        started: '05T11:00:04.000',
        finished: '05T11:00:14.000',
      },
      { failure_reason: 'timeout' },
    ),
    run('r3', 'running', {
      created: '05T12:00:00.000',
      dispatched: '05T12:00:05.000',
      started: '05T12:00:06.000',
    }),
    run('r4', 'queued', { created: '06T12:00:00.000' }),
  ]);
  await insert('run_usage', [
    {
      id: 'u1',
      run_id: 'r1',
      provider: 'claude',
      model: 'claude-sonnet',
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      created_at: at('05T10:01:02.000'),
    },
  ]);
  const item = (
    id: string,
    type: string,
    created: string,
    resolved: string | null,
    issueId = 'i1',
  ) => ({
    id,
    user_id: ALICE.id,
    kind: 'decision',
    type,
    issue_id: issueId,
    title: 't',
    dedupe_key: id,
    created_at: at(created),
    updated_at: at(created),
    resolved_at: resolved ? at(resolved) : null,
  });
  await insert('inbox_items', [
    item('d1', 'review_requested', '02T10:00:00', '02T11:00:00'),
    item('d2', 'agent_blocked', '03T10:00:00', '04T10:00:00'),
    item('d3', 'approval_pending', '05T10:00:00', null, 'i2'),
    item('d4', 'review_requested', '08T10:00:00', null),
    item('d5', 'pr_review', '02T10:00:00', null, 'i10'),
  ]);
}

async function seeded(): Promise<{ agentId: string; secretId: string }> {
  const runtime = await registerRuntime(services, ALICE);
  const agentId = await createAgent(services, ALICE, runtime.runtimeId, 'Dev');
  const secretId = (
    await services.projects.create(ALICE, {
      name: 'Secret',
      visibility: 'members',
    })
  ).id;
  await fixture(agentId, secretId);
  await services.workspaceSettings.update(ALICE, {
    modelPrices: [
      {
        provider: 'claude',
        model: 'claude-*',
        inputPerM: 3,
        outputPerM: 15,
        cacheReadPerM: 0,
        cacheWritePerM: 0,
      },
    ],
  });
  return { agentId, secretId };
}

const RANGE = '/np/metrics?from=2026-09-01&to=2026-09-07';

describe.skipIf(!db)('GET /np/metrics (PostgreSQL)', () => {
  it('computes the six groups for owner/admin with thresholds and statuses', async () => {
    const { agentId } = await seeded();
    const response = await alice<{ data: MetricsReport }>('GET', RANGE);
    expect(response.status).toBe(200);
    const report = response.body.data;
    expect(report).toMatchObject({
      from: '2026-09-01',
      to: '2026-09-07',
      projectId: null,
    });
    // Days: 01 (i1, i2), 02 (i10), 03 (i3), 04 (comment), 05 (runs), 06 (run r4): 6 days, all in 2026-W36.
    expect(report.adoption).toEqual({
      activeWeeks: 1,
      activeDays: 6,
      issuesCreated: 4,
      activeMembers: 3,
    });
    expect(report.aiShare).toEqual({
      deliveredByAgent: 1,
      deliveredTotal: 3,
      share: 1 / 3,
    });
    expect(report.trust.proposalAcceptRate).toBeCloseTo(2 / 3);
    expect(report.trust.reviewPassRate).toBeCloseTo(3 / 4);
    expect(report.trust.approvalApproveRate).toBe(0.5);
    expect(report.trust.reworkRate).toBeCloseTo(1 / 4);
    expect(report.reliability).toEqual({
      runs: 4,
      failedRuns: 1,
      failuresByReason: { timeout: 1 },
      claimLatencyP50Ms: 3000,
      claimLatencyP95Ms: 5000,
      runDurationP50Ms: 10_000,
      lostRuns: 1,
    });
    expect(report.cost).toEqual({
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      estimatedCost: 4.5,
      costPerDeliveredIssue: 1.5,
      byAgent: [{ agentId, name: 'Dev', cost: 4.5 }],
      // NP-219: the cost of each runtime type.
      byRuntimeType: {
        computer: { estimatedCost: 4.5, pricedRuns: 1 },
        builtin: { estimatedCost: null, pricedRuns: 0 },
      },
    });
    expect(report.humanLoad).toEqual({
      decisionsCreated: 4,
      decisionsResolved: 2,
      decisionResolveP50Ms: 3600 * 1000,
      openDecisions: 2,
      byType: {
        review_requested: 1,
        agent_blocked: 1,
        approval_pending: 1,
        pr_review: 1,
      },
    });
    expect(report.thresholds).toEqual(DEFAULT_METRIC_THRESHOLDS);
    expect(report.statuses).toEqual({
      aiShare: 'warn',
      proposalAcceptRate: 'warn',
      claimLatencyP50Ms: 'ok',
      lostRuns: 'warn',
      decisionResolveP50Ms: 'ok',
    });
  });

  it('filters members to the issues they can see, and by project', async () => {
    const { secretId } = await seeded();
    const member = (await carol<{ data: MetricsReport }>('GET', RANGE)).body
      .data;
    expect(member.adoption.issuesCreated).toBe(3);
    expect(member.aiShare.deliveredTotal).toBe(2);
    expect(member.humanLoad.decisionsCreated).toBe(3);
    expect(member.humanLoad.byType).not.toHaveProperty('pr_review');
    const project = (
      await alice<{ data: MetricsReport }>(
        'GET',
        `${RANGE}&projectId=${secretId}`,
      )
    ).body.data;
    expect(project).toMatchObject({ projectId: secretId });
    expect(project.adoption.issuesCreated).toBe(1);
    expect(project.aiShare.deliveredTotal).toBe(1);
    expect(project.reliability.runs).toBe(0);
    expect(project.reliability.claimLatencyP50Ms).toBeNull();
    expect(project.statuses.claimLatencyP50Ms).toBe('n/a');
    expect(project.cost.estimatedCost).toBeNull();
    expect(
      (await alice('GET', '/np/metrics?from=2026-09-08&to=2026-09-01')).body
        .code,
    ).toBe('INVALID_RANGE');
  });

  it('reads thresholds from the settings; only owner/admin change them', async () => {
    await seeded();
    const forbidden = await bob('PATCH', '/np/settings', {
      metricThresholds: { aiShare: 0.3 },
    });
    expect(forbidden.status).toBe(403);
    for (const bad of [
      { aiShare: 2 },
      { lostRuns: -1 },
      { unknown: 1 },
      { claimLatencyP50Ms: 'fast' },
    ]) {
      const response = await alice('PATCH', '/np/settings', {
        metricThresholds: bad,
      });
      expect(response).toMatchObject({
        status: 400,
        body: { code: 'INVALID_THRESHOLDS' },
      });
    }
    const updated = await alice<{ data: WorkspaceSettingsViewV3 }>(
      'PATCH',
      '/np/settings',
      { metricThresholds: { aiShare: 0.3, lostRuns: 2 } },
    );
    expect(updated.body.data.metricThresholds).toEqual({
      ...DEFAULT_METRIC_THRESHOLDS,
      aiShare: 0.3,
      lostRuns: 2,
    });
    // Partial updates merge over what is stored.
    await alice('PATCH', '/np/settings', {
      metricThresholds: { proposalAcceptRate: 0.6 },
    });
    const view = await bob<{ data: WorkspaceSettingsViewV3 }>(
      'GET',
      '/np/settings',
    );
    expect(view.body.data.metricThresholds).toMatchObject({
      aiShare: 0.3,
      lostRuns: 2,
      proposalAcceptRate: 0.6,
    });
    const report = (await alice<{ data: MetricsReport }>('GET', RANGE)).body
      .data;
    expect(report.statuses).toMatchObject({
      aiShare: 'ok',
      proposalAcceptRate: 'ok',
      lostRuns: 'ok',
    });
  });
});
