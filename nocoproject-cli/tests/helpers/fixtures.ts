import { AGENT_CAPABILITIES } from '../../src/protocol.js';
import type { ClaimedRun } from '../../src/protocol.js';
import type { ClaimedRunV1 } from '../../src/run-context.js';

export function claimedRun(overrides: Partial<ClaimedRun> = {}): ClaimedRun {
  return {
    run: { id: '7301234567890123', agentId: 'a1', runtimeId: 'rt1', attempt: 1, priority: 0, createdAt: '2026-01-01T00:00:00.000Z' },
    token: 'npr_0123456789abcdef0123456789abcdef01234567',
    agent: { capabilities: AGENT_CAPABILITIES, configurationRevision: 1, id: 'a1', name: 'Coder', instructions: 'Write tests first.\nKeep diffs small.', provider: 'claude', model: null },
    issue: { id: 'i12', identifier: 'NP-12', title: 'Fix login redirect', statusKey: 'todo', ownerName: 'Alice' },
    statusCatalog: [],
    agentTransitions: [
      { from: 'todo', to: 'in_progress' },
      { from: 'blocked', to: 'in_progress' },
      { from: 'in_progress', to: 'in_review' },
      { from: 'in_progress', to: 'blocked' },
    ],
    triggers: [
      { type: 'mention', comment: { id: 'c9', authorName: 'Alice', content: '@Coder please fix this.\nIt breaks on Safari.', parentId: null, rootId: 'c9' } },
    ],
    session: { providerSessionId: null, workDir: null, fresh: true },
    server: { url: 'http://127.0.0.1:13000/main', protocolVersion: 1 },
    leaseSeconds: 45,
    ...overrides,
  };
}

/** A claimed run carrying the Phase 1 extras (project, parent, stage, delegation, previous branch). */
export function phase1Run(overrides: Partial<ClaimedRunV1> = {}): ClaimedRunV1 {
  const base = claimedRun();
  return {
    ...base,
    project: {
      id: 'p1',
      name: 'NocoProject',
      description: 'The project management app.',
      resources: [{ type: 'gitRepo', url: 'https://github.com/nocobase/nocoproject.git', defaultRef: 'main' }],
    },
    issue: { ...base.issue, parent: { id: 'i10', identifier: 'NP-10', title: 'Login overhaul' }, stage: 2, autoExecuteSubtasks: true, projectId: 'p1' },
    agent: { ...base.agent, delegationTargets: [{ id: 'a7', name: 'Reviewer' }] },
    session: { ...base.session, branchName: 'agent/coder/np-12', repoUrl: 'https://github.com/nocobase/nocoproject.git' },
    ...overrides,
  };
}

/** A claimed run carrying the iteration-2 extras (env, skills, execution mode, linked PRs). */
export function iter2Run(overrides: Partial<ClaimedRunV1['issue']> = {}, agent: Partial<ClaimedRunV1['agent']> = {}): ClaimedRunV1 {
  const base = phase1Run();
  return {
    ...base,
    issue: {
      ...base.issue,
      executionMode: 'task',
      pullRequests: [{ number: 42, url: 'https://github.com/nocobase/nocoproject/pull/42', state: 'open' }],
      ...overrides,
    },
    agent: {
      ...base.agent,
      env: { DEPLOY_TOKEN: 'deploy-secret-value-123', PATH: '/evil', NOCOPROJECT_TOKEN: 'x' },
      skills: [
        { id: 's1', slug: 'deploy', name: 'Deploy', description: 'How to deploy\nthe app to staging.', content: '# Deploy\n\nRun `make deploy`.', files: [{ path: 'scripts/deploy.sh', content: 'echo deploy\n' }] },
      ],
      ...agent,
    },
  };
}

/** A claimed run carrying the iteration-3 knowledge index (one project and one system document). */
export function iter3Run(overrides: Partial<ClaimedRunV1> = {}): ClaimedRunV1 {
  return {
    ...iter2Run(),
    knowledge: [
      { id: 'kd1', slug: 'api-conventions', title: 'API conventions', summary: 'Error envelope,\npagination and naming rules.', projectId: 'p1', childCount: 0 },
      { id: 'kd2', slug: 'release-process', title: 'Release process', summary: '', projectId: null, childCount: 0 },
    ],
    ...overrides,
  };
}

/** A claimed run carrying the iteration-4 extras (issue process, design approval, agent kind). */
export function iter4Run(issue: Partial<ClaimedRunV1['issue']> = {}, agent: Partial<ClaimedRunV1['agent']> = {}, overrides: Partial<ClaimedRunV1> = {}): ClaimedRunV1 {
  const base = iter3Run();
  return {
    ...base,
    issue: { ...base.issue, process: 'design_first', designApprovedAt: null, designProposal: null, ...issue },
    agent: { ...base.agent, kind: 'coder', reasoningEffort: null, ...agent, ...(agent.kind === 'manager' && !agent.capabilities ? { capabilities: ['context.read', 'workspace.read', 'comment.create', 'knowledge.propose'] as const } : {}) },
    ...overrides,
  };
}
