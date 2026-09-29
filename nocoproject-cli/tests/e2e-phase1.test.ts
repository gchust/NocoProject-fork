import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repoCachePath } from '../src/repo/naming.js';
import { startDaemon, waitFor, type Harness } from './helpers/daemon-harness.js';
import { createRemote, sh } from './helpers/git-fixture.js';
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

const runStatus = (m: MockServer, id: string) => m.runs.get(id)?.status;
const startBody = (m: MockServer, id: string) => m.callsTo(new RegExp(`runs/${id}/start`))[0]?.body;
const completeBody = (m: MockServer, id: string) => m.callsTo(new RegExp(`runs/${id}/complete`))[0]?.body;

describe('Phase 1 daemon e2e (echo adapter)', () => {
  it('writes context.json, lets the agent check out and commit, reports the branch, and resumes it on the next claim', async () => {
    const { mock, harness } = await setup();
    const remote = createRemote();
    const project = { id: 'p1', name: 'Demo', description: 'Demo project', resources: [{ type: 'gitRepo' as const, url: remote.url, defaultRef: null }] };
    mock.addIssue({ id: 'i31', identifier: 'NP-31', title: 'Change code', description: `Please edit. [echo:checkout=${remote.url}]` });
    const first = mock.enqueue('i31', { project });
    await waitFor(() => runStatus(mock, first) === 'completed' || runStatus(mock, first) === 'failed', 20_000, 'first run');
    expect(runStatus(mock, first)).toBe('completed');

    const workDir = startBody(mock, first)?.workDir as string;
    const contextPath = join(workDir, '.nocoproject', 'context.json');
    expect(statSync(contextPath).mode & 0o777).toBe(0o600);
    const contextText = readFileSync(contextPath, 'utf8');
    expect(contextText).not.toContain(mock.runs.get(first)?.claimed.token as string);
    expect(JSON.parse(contextText)).toMatchObject({ runId: first, project, issue: { identifier: 'NP-31' }, session: { branchName: null } });
    expect(readFileSync(join(workDir, 'AGENTS.md'), 'utf8')).toContain(`- \`${remote.url}\``);

    expect(completeBody(mock, first)).toMatchObject({ branchName: 'agent/np-31', repoUrl: remote.url });
    const bare = repoCachePath(harness.home, remote.url);
    expect(sh(['log', '--format=%s', 'agent/np-31'], bare).split('\n')[0]).toBe(`NP-31: echo agent change (run ${first})`);

    mock.issues.set('i31', { ...(mock.issues.get('i31') as any), statusKey: 'todo' });
    const session = { providerSessionId: null, workDir: null, fresh: true, branchName: 'agent/np-31', repoUrl: remote.url };
    const second = mock.enqueue('i31', { project, session });
    await waitFor(() => runStatus(mock, second) === 'completed' || runStatus(mock, second) === 'failed', 20_000, 'second run');
    expect(runStatus(mock, second)).toBe('completed');
    expect(startBody(mock, second)?.workDir).not.toBe(workDir);
    expect(completeBody(mock, second)).toMatchObject({ branchName: 'agent/np-31', repoUrl: remote.url });
    const subjects = sh(['log', '--format=%s', 'agent/np-31'], bare).split('\n');
    expect(subjects.slice(0, 2)).toEqual([`NP-31: echo agent change (run ${second})`, `NP-31: echo agent change (run ${first})`]);
  });

  it('lets the agent create staged sub-issues and keeps the parent in progress', async () => {
    const { mock } = await setup();
    mock.addIssue({ id: 'i32', identifier: 'NP-32', title: 'Big job', description: 'Split it. [echo:subtasks=2]' });
    const runId = mock.enqueue('i32', { issueExtras: { autoExecuteSubtasks: true, stage: null, parent: null, projectId: null }, triggerType: 'assign' });
    await waitFor(() => runStatus(mock, runId) === 'completed' || runStatus(mock, runId) === 'failed', 20_000, 'run');
    expect(runStatus(mock, runId)).toBe('completed');
    const created = [...mock.meta.entries()].filter(([, m]) => m.createdByRunId === runId);
    expect(created.map(([, m]) => ({ parent: m.parentIssueId, stage: m.stage, executor: m.executor }))).toEqual([
      { parent: 'i32', stage: 1, executor: 'self' },
      { parent: 'i32', stage: 2, executor: 'self' },
    ]);
    expect(mock.issues.get('i32')?.statusKey).toBe('in_progress');
    const reply = (mock.comments.get('i32') ?? []).find((c) => c.authorType === 'agent');
    expect(reply?.content).toMatch(/Created sub-issues: NP-\d+, NP-\d+\./);
    const workDir = startBody(mock, runId)?.workDir as string;
    expect(readFileSync(join(workDir, 'AGENTS.md'), 'utf8')).toContain('Auto-execute sub-issues is **on** for NP-32');
    expect(completeBody(mock, runId)?.branchName).toBeUndefined();

    // Woken again while a child is still open: no second split, parent stays in progress.
    const childIds = created.map(([id]) => id);
    const wake = mock.enqueue('i32', { issueExtras: { autoExecuteSubtasks: true, stage: null, parent: null, projectId: null }, triggerType: 'childBatchDone' });
    await waitFor(() => runStatus(mock, wake) === 'completed' || runStatus(mock, wake) === 'failed', 20_000, 'wake run');
    expect(runStatus(mock, wake)).toBe('completed');
    expect([...mock.meta.values()].filter((m) => m.parentIssueId === 'i32')).toHaveLength(2);
    expect(mock.issues.get('i32')?.statusKey).toBe('in_progress');

    // Woken once every child is done: hands the parent over for review.
    for (const id of childIds) mock.issues.set(id, { ...(mock.issues.get(id) as any), statusKey: 'done' });
    const last = mock.enqueue('i32', { issueExtras: { autoExecuteSubtasks: true, stage: null, parent: null, projectId: null }, triggerType: 'childBatchDone' });
    await waitFor(() => runStatus(mock, last) === 'completed' || runStatus(mock, last) === 'failed', 20_000, 'final run');
    expect(runStatus(mock, last)).toBe('completed');
    expect([...mock.meta.values()].filter((m) => m.parentIssueId === 'i32')).toHaveLength(2);
    expect(mock.issues.get('i32')?.statusKey).toBe('in_review');
  });

  it('injects agent env into the tool, redacts the values everywhere and writes skills (iteration 2 §G, §H)', async () => {
    const { mock, harness } = await setup();
    const secret = 'super-secret-deploy-value';
    mock.addIssue({ id: 'i33', identifier: 'NP-33', title: 'Deploy', description: 'Go. [echo:env=DEPLOY_TOKEN] [echo:skill=deploy]' });
    const runId = mock.enqueue('i33', {
      agentExtras: {
        instructions: `Never paste ${secret} anywhere.`,
        env: { DEPLOY_TOKEN: secret, SHORT: 'abc', PATH: '/evil' },
        skills: [
          { id: 's1', slug: 'deploy', name: 'Deploy', description: 'Deploy to staging', content: '# Deploy runbook\n\nRun make deploy.', files: [{ path: 'scripts/go.sh', content: 'make deploy\n' }, { path: '../escape.sh', content: 'no' }] },
        ],
      },
    });
    await waitFor(() => runStatus(mock, runId) === 'completed' || runStatus(mock, runId) === 'failed', 20_000, 'run');
    expect(runStatus(mock, runId)).toBe('completed');

    const reply = (mock.comments.get('i33') ?? []).find((c) => c.authorType === 'agent')?.content ?? '';
    expect(reply).toContain(`Env DEPLOY_TOKEN=${secret}`);
    expect(reply).toContain('Skill deploy: # Deploy runbook');

    const events = JSON.stringify(mock.runs.get(runId)?.events ?? []);
    expect(events).not.toContain(secret);
    expect(events).toContain('Env DEPLOY_TOKEN=[REDACTED]');
    expect(events).toContain('Skipped reserved or invalid environment variables: PATH');
    expect(events).toContain('skill deploy: rejected file path \\"../escape.sh\\"');
    expect(JSON.stringify(completeBody(mock, runId))).not.toContain(secret);
    expect(harness.logs.join('\n')).not.toContain(secret);

    const workDir = startBody(mock, runId)?.workDir as string;
    const context = readFileSync(join(workDir, '.nocoproject', 'context.json'), 'utf8');
    expect(context).not.toContain(secret);
    expect(context).not.toContain('DEPLOY_TOKEN');
    const brief = readFileSync(join(workDir, 'AGENTS.md'), 'utf8');
    expect(brief).not.toContain(secret);
    expect(brief).toContain('Never paste [REDACTED] anywhere.');
    expect(brief).toContain('- **Deploy** — Deploy to staging `.nocoproject/skills/deploy/SKILL.md`');
    expect(readFileSync(join(workDir, '.nocoproject', 'skills', 'deploy', 'scripts', 'go.sh'), 'utf8')).toBe('make deploy\n');
    expect(existsSync(join(workDir, '.nocoproject', 'escape.sh'))).toBe(false);
    expect(existsSync(join(workDir, '.claude'))).toBe(false);
  });

  it('links a pull request and treats a 202 approval gate as success (iteration 2 §C, §D)', async () => {
    const { mock } = await setup();
    mock.addIssue({ id: 'i34', identifier: 'NP-34', title: 'Ship it', description: '[echo:pr=https://github.com/acme/demo/pull/5] [echo:status=in_review]', approvalRequired: ['in_review'] });
    const runId = mock.enqueue('i34', { issueExtras: { executionMode: 'task', pullRequests: [] } });
    await waitFor(() => runStatus(mock, runId) === 'completed' || runStatus(mock, runId) === 'failed', 20_000, 'run');
    expect(runStatus(mock, runId)).toBe('completed');
    expect(mock.pullRequests.get('i34')?.map((p) => `${p.repo}#${p.number}`)).toEqual(['acme/demo#5']);
    expect(mock.approvals).toMatchObject([{ issueId: 'i34', fromStatus: 'in_progress', toStatus: 'in_review' }]);
    expect(mock.issues.get('i34')?.statusKey).toBe('in_progress');
    const reply = (mock.comments.get('i34') ?? []).find((c) => c.authorType === 'agent')?.content ?? '';
    expect(reply).toContain('Linked pull request https://github.com/acme/demo/pull/5.');
    expect(reply).toMatch(/Status in_review: approval pending \(request ap\d+\)\./);
  });

  it('runs a session-mode turn without moving the issue to in_review (iteration 2 §J)', async () => {
    const { mock } = await setup();
    mock.addIssue({ id: 'i35', identifier: 'NP-35', title: 'Chat', description: 'Let us talk.' });
    const pullRequests = [{ number: 9, url: 'https://github.com/acme/demo/pull/9', state: 'open' as const }];
    const runId = mock.enqueue('i35', { triggerComment: 'How is it going?', issueExtras: { executionMode: 'session', pullRequests } });
    await waitFor(() => runStatus(mock, runId) === 'completed' || runStatus(mock, runId) === 'failed', 20_000, 'run');
    expect(runStatus(mock, runId)).toBe('completed');
    expect(mock.issues.get('i35')?.statusKey).toBe('in_progress');
    const workDir = startBody(mock, runId)?.workDir as string;
    expect(JSON.parse(readFileSync(join(workDir, '.nocoproject', 'context.json'), 'utf8')).issue).toMatchObject({ executionMode: 'session', pullRequests });
    const brief = readFileSync(join(workDir, 'AGENTS.md'), 'utf8');
    expect(brief).toContain('## Conversation Mode');
    expect(brief).toContain('- #9 (open) https://github.com/acme/demo/pull/9');
    expect(existsSync(join(workDir, '.nocoproject', 'skills'))).toBe(false);
  });
});

describe('iteration 3 daemon e2e (echo adapter)', () => {
  it('writes the knowledge index to context.json and the brief, reads a document and proposes a new one', async () => {
    const { mock } = await setup();
    const project = { id: 'p1', name: 'Demo', description: null, resources: [] };
    const doc = mock.knowledge.add({ slug: 'api-conventions', title: 'API conventions', summary: 'Errors and naming.', projectId: 'p1', content: '\nAlways return { code, message }.\nMore.' });
    mock.addIssue({ id: 'i36', identifier: 'NP-36', title: 'Learn', description: '[echo:kb=api-conventions] [echo:kb-propose=Flaky e2e tests]' });
    const knowledge = [{ id: doc.id, slug: doc.slug, title: doc.title, summary: doc.summary, projectId: 'p1', childCount: 0 }];
    const runId = mock.enqueue('i36', { project, knowledge });
    await waitFor(() => runStatus(mock, runId) === 'completed' || runStatus(mock, runId) === 'failed', 20_000, 'run');
    expect(runStatus(mock, runId)).toBe('completed');

    const workDir = startBody(mock, runId)?.workDir as string;
    expect(JSON.parse(readFileSync(join(workDir, '.nocoproject', 'context.json'), 'utf8')).knowledge).toEqual(knowledge);
    const brief = readFileSync(join(workDir, 'AGENTS.md'), 'utf8');
    expect(brief).toContain('- **API conventions** (`api-conventions`) — Errors and naming.');
    expect(brief).toContain('## Capture learnings');

    const reply = (mock.comments.get('i36') ?? []).find((c) => c.authorType === 'agent')?.content ?? '';
    expect(reply).toContain('KB api-conventions: Always return { code, message }.');
    expect(reply).toMatch(/Proposed knowledge "Flaky e2e tests" \(proposal kp\d+\)\./);
    expect(mock.knowledge.proposals).toMatchObject([
      { docId: null, title: 'Flaky e2e tests', status: 'pending', sourceRunId: runId, sourceIssueId: 'i36', projectId: 'p1', reason: 'Found while working on NP-36.' },
    ]);
    expect(mock.issues.get('i36')?.statusKey).toBe('in_review');
  });

  it('defaults context.json knowledge to [] when the server sends none', async () => {
    const { mock } = await setup();
    mock.addIssue({ id: 'i37', identifier: 'NP-37', title: 'Plain' });
    const runId = mock.enqueue('i37');
    await waitFor(() => runStatus(mock, runId) === 'completed' || runStatus(mock, runId) === 'failed', 20_000, 'run');
    const workDir = startBody(mock, runId)?.workDir as string;
    expect(JSON.parse(readFileSync(join(workDir, '.nocoproject', 'context.json'), 'utf8')).knowledge).toEqual([]);
    expect(readFileSync(join(workDir, 'AGENTS.md'), 'utf8')).toContain('No knowledge documents are available to this run yet.');
  });
});
