import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startDaemon, waitFor, type Harness } from './helpers/daemon-harness.js';
import { MockServer } from './helpers/mock-server.js';

let mock: MockServer | undefined;
let harness: Harness | undefined;

afterEach(async () => {
  await harness?.daemon.stop(5000);
  await mock?.stop();
  harness = undefined;
  mock = undefined;
});

async function setup() {
  mock = new MockServer();
  await mock.start();
  harness = await startDaemon(mock);
  return { mock, harness };
}

const done = (m: MockServer, id: string) => ['completed', 'failed'].includes(m.runs.get(id)?.status ?? '');
const workDirOf = (m: MockServer, id: string) => m.callsTo(new RegExp(`runs/${id}/start`))[0]?.body?.workDir as string;
const statusCalls = (m: MockServer, issueId: string) => m.callsTo(new RegExp(`POST /np/agent/issues/${issueId}/status`)).map((c) => c.body.statusKey);

describe('iteration 4 daemon e2e (echo adapter)', () => {
  it('design first: proposes, sets proposal_review, then implements after approval', async () => {
    const { mock } = await setup();
    mock.addIssue({ id: 'i70', identifier: 'NP-70', title: 'New importer [echo:design]', process: 'design_first', designApprovedAt: null });
    const first = mock.enqueue('i70');
    await waitFor(() => done(mock, first), 20_000, 'design run');
    expect(mock.runs.get(first)?.status).toBe('completed');
    expect(statusCalls(mock, 'i70')).toEqual(['analysis', 'proposal_review']);
    expect(mock.issues.get('i70')?.statusKey).toBe('proposal_review');
    const proposal = mock.comments.get('i70')?.find((c) => (c as { kind?: string }).kind === 'proposal');
    expect(proposal?.content).toContain('## 需求理解');
    expect(mock.comments.get('i70')).toHaveLength(1);
    const workDir = workDirOf(mock, first);
    expect(readFileSync(join(workDir, 'AGENTS.md'), 'utf8')).toContain('## Design first');
    expect(JSON.parse(readFileSync(join(workDir, '.nocoproject', 'context.json'), 'utf8'))).toMatchObject({ issue: { process: 'design_first', designApprovedAt: null }, agent: { kind: 'coder' } });

    const approvedAt = new Date().toISOString();
    mock.issues.set('i70', { ...(mock.issues.get('i70') as any), statusKey: 'in_progress', designApprovedAt: approvedAt });
    const second = mock.enqueue('i70', { triggerType: 'designApproved' });
    await waitFor(() => done(mock, second), 20_000, 'implementation run');
    expect(mock.runs.get(second)?.status).toBe('completed');
    expect(mock.issues.get('i70')?.statusKey).toBe('in_review');
    expect(mock.runs.get(second)?.claimed.issue.designProposal?.content).toContain('## 需求理解');
  });

  it('project manager: answers with pm issues and never changes the status', async () => {
    const { mock } = await setup();
    mock.addIssue({ id: 'i80', identifier: 'NP-80', title: '项目经理 · Alice', description: '[echo:pm=how many issues?]', statusKey: 'todo' });
    mock.addIssue({ id: 'i81', identifier: 'NP-81', title: 'Other work' });
    const runId = mock.enqueue('i80', { triggerComment: 'How many issues are there?', agentExtras: { kind: 'manager', reasoningEffort: 'high' }, issueExtras: { executionMode: 'session' } });
    await waitFor(() => done(mock, runId), 20_000, 'pm run');
    expect(mock.runs.get(runId)?.status).toBe('completed');
    const reply = mock.comments.get('i80')?.find((c) => c.authorType === 'agent');
    expect(reply?.content).toContain('PM how many issues?: 2 issues');
    expect(statusCalls(mock, 'i80')).toEqual([]);
    const workDir = workDirOf(mock, runId);
    expect(readFileSync(join(workDir, 'AGENTS.md'), 'utf8')).toContain('## Project manager');
    expect(JSON.parse(readFileSync(join(workDir, '.nocoproject', 'context.json'), 'utf8')).agent.kind).toBe('manager');
  });
});
