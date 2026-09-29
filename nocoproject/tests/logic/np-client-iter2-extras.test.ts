import { describe, expect, it } from 'vitest';

import {
  envNameProblem,
  envValueTooLong,
  normalizeSkillDetail,
  skillFilePathProblem,
  stripSkillFrontMatter,
} from '../../client/pages/np/api-agent-extras.js';
import { unwrap, unwrapList } from '../../client/pages/np/api-iter2.js';
import { normalizeIssueDetail } from '../../client/pages/np/detail-normalize.js';
import {
  inboxBadgeText,
  inboxTitle,
} from '../../client/pages/np/inbox/inbox-model.js';
import { inboxBodyText } from '../../client/pages/np/inbox/inbox-text.js';
import {
  activeSessionRun,
  sessionHint,
  sessionMessages,
} from '../../client/pages/np/issues/detail/session-model.js';
import {
  activityLabel,
  commentSnippet,
} from '../../client/pages/np/issues/detail/timeline.js';
import { reorderResources } from '../../client/pages/np/projects/detail/resource-order.js';
import { gitConnectionChanges } from '../../client/pages/np/config/github-model.js';
import {
  priceDraft,
  priceProblems,
  pricesFromDrafts,
} from '../../client/pages/np/config/model-prices.js';
import type {
  ProjectResource,
  RunSummary,
} from '../../client/pages/np/types.js';

const run = (
  id: string,
  status: RunSummary['status'],
  createdAt: string,
): RunSummary => ({
  id,
  agentId: 'a1',
  status,
  createdAt,
});

describe('session mode', () => {
  it('says "sent after this turn (N queued)" while a turn runs with a queued one', () => {
    const active = run('r1', 'running', '2026-09-27T01:00:00Z');
    expect(sessionHint(active, { id: 'r2', triggerCount: 3 })).toEqual({
      kind: 'queued',
      count: 3,
    });
    expect(sessionHint(active, null)).toEqual({ kind: 'working' });
    expect(sessionHint(null, { id: 'r2', triggerCount: 1 })).toBeNull();
  });

  it('finds the working turn and lists top-level messages', () => {
    const runs = [
      run('old', 'completed', '2026-09-27T00:00:00Z'),
      run('queued', 'queued', '2026-09-27T02:00:00Z'),
      run('now', 'running', '2026-09-27T01:00:00Z'),
    ];
    expect(activeSessionRun(runs)?.id).toBe('now');
    expect(activeSessionRun([runs[0]])).toBeNull();
    const detail = normalizeIssueDetail({
      issue: { id: '1' } as never,
      comments: [
        {
          id: 'c1',
          authorType: 'user',
          authorId: 'u1',
          content: 'hi',
          parentId: null,
          createdAt: '1',
        },
        {
          id: 'c2',
          authorType: 'agent',
          authorId: 'a1',
          content: 'yo',
          parentId: 'c1',
          createdAt: '2',
        },
        {
          id: 's1',
          authorType: 'system',
          authorId: null,
          content: 'x',
          kind: 'system',
          parentId: null,
          createdAt: '3',
        },
      ],
    });
    // Replies are part of the conversation (the agent answers in the question's thread); system rows are not.
    expect(
      sessionMessages(detail.threads).map((message) => message.id),
    ).toEqual(['c1', 'c2']);
  });
});

describe('inbox', () => {
  const status = (key: string) => `<${key}>`;
  const failure = (reason: string) => `!${reason}`;

  it('builds the localized sentence from type and payload', () => {
    expect(
      inboxBodyText(
        {
          type: 'approval_pending',
          actorName: 'Bot',
          payload: { fromStatus: 'in_review', toStatus: 'done' },
        },
        status,
        failure,
      ),
    ).toEqual({
      key: 'np.inboxBody.approval_pending',
      values: { actor: 'Bot', from: '<in_review>', to: '<done>' },
    });
    expect(
      inboxBodyText(
        {
          type: 'approval_decided',
          actorName: 'Zhou',
          payload: { decision: 'rejected', to: 'done' },
        },
        status,
        failure,
      )?.key,
    ).toBe('np.inboxBody.approval_rejected');
    expect(
      inboxBodyText(
        {
          type: 'pr_review',
          actorName: null,
          payload: { repo: 'o/r', number: 7 },
        },
        status,
        failure,
      ),
    ).toEqual({
      key: 'np.inboxBody.pr_review',
      values: { actor: '', repo: 'o/r', number: 7 },
    });
    expect(
      inboxBodyText(
        {
          type: 'run_failed',
          actorName: 'Bot',
          payload: { reason: 'timeout' },
        },
        status,
        failure,
      )?.values.reason,
    ).toBe('!timeout');
    expect(
      inboxBodyText(
        { type: 'batch_done', actorName: null, payload: { stage: 2 } },
        status,
        failure,
      )?.key,
    ).toBe('np.inboxBody.batch_done_stage');
  });

  it('falls back to the server body when the payload lacks what the sentence needs', () => {
    expect(
      inboxBodyText(
        { type: 'pr_merged', actorName: null, payload: {} },
        status,
        failure,
      ),
    ).toBeNull();
    expect(
      inboxBodyText(
        { type: 'status_changed', actorName: 'A', payload: null },
        status,
        failure,
      ),
    ).toBeNull();
  });

  it('shows the pending decision count on the navigation badge and the tab title', () => {
    expect(inboxBadgeText(0)).toBeNull();
    expect(inboxBadgeText(3)).toBe('3');
    expect(inboxBadgeText(120)).toBe('99+');
    expect(inboxTitle('NocoProject', '3')).toBe('(3) NocoProject');
    expect(inboxTitle('(3) NocoProject', '99+')).toBe('(99+) NocoProject');
    expect(inboxTitle('(99+) NocoProject', null)).toBe('NocoProject');
    expect(inboxTitle('NocoProject', null)).toBe('NocoProject');
  });
});

describe('activity and threads', () => {
  it('labels the iteration 2 actions exactly', () => {
    expect(activityLabel('pr_linked')).toBe('prLinked');
    expect(activityLabel('approval_requested')).toBe('approvalRequested');
    expect(activityLabel('thread_unresolved')).toBe('threadUnresolved');
    expect(activityLabel('execution_mode_changed')).toBe(
      'executionModeChanged',
    );
    expect(activityLabel('status_changed')).toBe('statusChanged');
  });

  it('reduces a resolved thread to a plain snippet', () => {
    expect(
      commentSnippet('**Done** by [@Bot](mention://agent/a1)\n\nmore'),
    ).toBe('Done by @Bot more');
    expect(commentSnippet('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('agent env and skills', () => {
  it('checks environment variable names and sizes', () => {
    expect(envNameProblem('')).toBe('required');
    expect(envNameProblem('api_key')).toBe('pattern');
    expect(envNameProblem('1ABC')).toBe('pattern');
    expect(envNameProblem('PATH')).toBe('reserved');
    expect(envNameProblem('NOCOPROJECT_TOKEN')).toBe('reserved');
    expect(envNameProblem('GITHUB_TOKEN')).toBeNull();
    expect(envValueTooLong('x'.repeat(8 * 1024))).toBe(false);
    expect(envValueTooLong('界'.repeat(3000))).toBe(true);
  });

  it('checks skill file paths', () => {
    expect(skillFilePathProblem('', [])).toBe('required');
    expect(skillFilePathProblem('../etc', [])).toBe('invalid');
    expect(skillFilePathProblem('/abs', [])).toBe('invalid');
    expect(skillFilePathProblem('a//b', [])).toBe('invalid');
    expect(skillFilePathProblem('a.md', ['a.md'])).toBe('duplicate');
    expect(skillFilePathProblem('scripts/run.sh', [])).toBeNull();
  });

  it('reads the skill detail envelope and sorts files and agents', () => {
    const detail = normalizeSkillDetail({
      data: {
        skill: { id: 's1', name: 'Review', slug: 'review', description: null },
        files: [
          { path: 'b.md', content: '' },
          { path: 'a.md', content: '' },
        ],
        agents: [
          { id: 'a2', name: 'Zed' },
          { id: 'a1', name: 'Amy' },
        ],
      },
    });
    expect(detail.files.map((file) => file.path)).toEqual(['a.md', 'b.md']);
    expect(detail.agents.map((agent) => agent.name)).toEqual(['Amy', 'Zed']);
    expect(
      normalizeSkillDetail({
        id: 's2',
        name: 'X',
        slug: 'x',
        description: null,
      }).skill.id,
    ).toBe('s2');
    expect(
      normalizeSkillDetail({ data: { skill: { id: 's3' } } }).agents,
    ).toEqual([]);
  });

  it('strips a leading YAML front matter block before rendering', () => {
    expect(stripSkillFrontMatter('# Review\n\nSteps.')).toBe(
      '# Review\n\nSteps.',
    );
    expect(
      stripSkillFrontMatter(
        '---\nname: review\ndescription: "Review code"\n---\n# Review\n',
      ),
    ).toBe('# Review\n');
    // No closing delimiter: not front matter, left as written.
    expect(stripSkillFrontMatter('---\nname: review\n')).toBe(
      '---\nname: review\n',
    );
    // A `---` rule that doesn't open the content is body text, not front matter.
    expect(stripSkillFrontMatter('# Review\n\n---\n\nMore.')).toBe(
      '# Review\n\n---\n\nMore.',
    );
  });
});

describe('settings, projects and envelopes', () => {
  it('sends only what changed in the GitHub form', () => {
    const current = {
      configured: true,
      apiBaseUrl: 'https://api.github.com',
      tokenSet: true,
      webhookSecretSet: false,
      webhookUrl: 'https://x/np/webhooks/github',
      lastEventAt: null,
    };
    const blank = {
      apiBaseUrl: current.apiBaseUrl,
      token: '',
      webhookSecret: '',
      clearToken: false,
      clearSecret: false,
    };
    expect(gitConnectionChanges(current, blank)).toEqual({});
    expect(gitConnectionChanges(current, { ...blank, token: 'ghp_x' })).toEqual(
      { token: 'ghp_x' },
    );
    expect(
      gitConnectionChanges(current, { ...blank, clearToken: true }),
    ).toEqual({ token: '' });
    expect(
      gitConnectionChanges(current, {
        ...blank,
        apiBaseUrl: 'https://ghe/api/v3',
        webhookSecret: 's',
      }),
    ).toEqual({ apiBaseUrl: 'https://ghe/api/v3', webhookSecret: 's' });
  });

  it('validates model prices and reads empty numbers as zero', () => {
    const draft = {
      ...priceDraft(),
      model: 'claude-*',
      inputPerM: '3',
      outputPerM: '15',
    };
    expect(priceProblems({ ...draft, model: '' })).toEqual(['modelRequired']);
    expect(priceProblems({ ...draft, cacheReadPerM: '-1' })).toEqual([
      'invalidNumber',
    ]);
    expect(pricesFromDrafts([draft])).toEqual([
      {
        provider: '',
        model: 'claude-*',
        inputPerM: 3,
        outputPerM: 15,
        cacheReadPerM: 0,
        cacheWritePerM: 0,
      },
    ]);
    expect(pricesFromDrafts([{ ...draft, outputPerM: 'x' }])).toBeNull();
  });

  it('rewrites only the positions a move changes', () => {
    const resource = (id: string, position: number): ProjectResource => ({
      id,
      projectId: 'p',
      type: 'gitRepo',
      url: `https://x/${id}.git`,
      defaultRef: null,
      label: null,
      position,
    });
    const list = [resource('a', 0), resource('b', 1), resource('c', 2)];
    expect(reorderResources(list, 2, 1)).toEqual([
      { id: 'c', position: 1 },
      { id: 'b', position: 2 },
    ]);
    expect(reorderResources(list, 0, -1)).toEqual([]);
  });

  it('unwraps both envelopes', () => {
    expect(unwrap({ data: 1 })).toBe(1);
    expect(unwrap({ x: 1 })).toEqual({ x: 1 });
    expect(unwrapList({ data: [1] })).toEqual([1]);
    expect(unwrapList([2])).toEqual([2]);
    expect(unwrapList({ data: { items: [3] } })).toEqual([3]);
    expect(unwrapList({ issues: [4] }, 'issues')).toEqual([4]);
    expect(unwrapList({ data: null })).toEqual([]);
  });
});
