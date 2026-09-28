import { describe, expect, it } from 'vitest';
import { buildBrief, buildTurnPrompt } from '../src/daemon/brief.js';
import { iter3Run, iter4Run } from './helpers/fixtures.js';

const APPROVED = '2026-10-01T08:00:00.000Z';
const PROPOSAL = { commentId: 'c50', content: '## 需求理解\nFix the redirect.\n\n## 方案\nUse the return URL.', createdAt: APPROVED };

describe('iteration 4 brief: design first', () => {
  it('tells an agent on an unapproved design-first issue to propose and stop', () => {
    const brief = buildBrief(iter4Run());
    expect(brief).toMatchSnapshot();
    expect(brief).toContain('## Design first');
    expect(brief).toContain('`nocoproject issue design-proposal NP-12 --content-file ./proposal.md`');
    expect(brief).toContain('`nocoproject issue status NP-12 proposal_review`');
    expect(brief).toContain('do not change any code and do not open a pull request');
    expect(brief).toContain('revise the whole proposal according to the comments');
    expect(brief).toContain('需求理解');
    expect(brief).toContain('- `nocoproject issue design-proposal NP-12 --content-file ./proposal.md --json`');
    expect(brief).not.toContain('5. After delivering, set the status to `in_review`.');
    expect(brief.indexOf('## Design first')).toBeLessThan(brief.indexOf('## Background Task Safety'));
  });

  it('only reminds the agent of the approved design once approved', () => {
    const brief = buildBrief(iter4Run({ designApprovedAt: APPROVED }));
    expect(brief).toContain('The design proposal of NP-12 was approved. Implement it as proposed');
    expect(brief).not.toContain('Before the proposal is approved');
    expect(brief).toContain('5. After delivering, set the status to `in_review`.');
  });

  it('leaves direct issues and older servers unchanged', () => {
    expect(buildBrief(iter4Run({ process: 'direct' }))).toBe(buildBrief(iter3Run()));
    expect(buildBrief(iter3Run())).not.toContain('## Design first');
    expect(buildBrief(iter3Run())).not.toContain('design-proposal');
  });

  it('opens a designApproved turn with the approval line and the proposal', () => {
    const run = iter4Run({ designApprovedAt: APPROVED, designProposal: PROPOSAL }, {}, { triggers: [{ type: 'designApproved' }] });
    const prompt = buildTurnPrompt(run, { resumed: true });
    expect(prompt).toMatchSnapshot();
    expect(prompt.split('\n')[0]).toBe('方案已批准，按方案实现');
    expect(prompt).toContain('The approved design proposal:\n> ## 需求理解\n> Fix the redirect.');
    expect(prompt).toContain('When done, deliver via');
    const noProposal = buildTurnPrompt(iter4Run({ designApprovedAt: APPROVED }, {}, { triggers: [{ type: 'designApproved' }] }), { resumed: false });
    expect(noProposal).toContain('Read the approved proposal (the latest comment of kind `proposal`)');
  });

  it('closes a pending-design turn with the proposal command instead of delivery', () => {
    const prompt = buildTurnPrompt(iter4Run(), { resumed: false });
    expect(prompt).toContain('Submit or revise the proposal with `nocoproject issue design-proposal NP-12 --content-file ./proposal.md`, then set `proposal_review`');
    expect(prompt).toContain('--content-file ./reply.md --parent c9`');
    expect(prompt).not.toContain('When done, deliver via');
  });
});

describe('iteration 4 brief: project manager', () => {
  const manager = (issue = {}, overrides = {}) => iter4Run({ process: 'direct', executionMode: 'session', ...issue }, { kind: 'manager', reasoningEffort: 'high' }, overrides);

  it('renders the Project manager section and the pm commands, without coding rules', () => {
    const brief = buildBrief(manager());
    expect(brief).toMatchSnapshot();
    expect(brief.indexOf('## Project manager')).toBeLessThan(brief.indexOf('## Conversation Mode'));
    for (const text of [
      'Lead with the conclusion',
      'Answer in the language the person asked in.',
      'Cite issue identifiers',
      'Never change the status of any issue, and never @-mention any agent',
      '`nocoproject kb propose`',
      '- `nocoproject pm projects --json`',
      '- `nocoproject pm issues [--project <id>] [--status <key>] [--owner me|<userId>]',
      '- `nocoproject pm issue <issue> --json`',
      '- `nocoproject pm inbox --json`',
      '- `nocoproject pm metrics [--from YYYY-MM-DD] [--to YYYY-MM-DD]',
      '- `nocoproject pm knowledge [--project <id>]',
      'You never change the status of any issue, including this one; people do.',
    ])
      expect(brief).toContain(text);
    for (const text of ['## Repositories', '## Sub-issues', '## Parent coordination', 'issue status NP-12', 'set it to `in_progress`', '`todo` → `in_progress`'])
      expect(brief).not.toContain(text);
    expect(buildBrief(iter3Run())).not.toContain('nocoproject pm ');
  });

  it('does not require in_review in a manager turn', () => {
    const prompt = buildTurnPrompt(manager(), { resumed: true });
    expect(prompt).toContain('you do not need to set `in_review` and never change the status');
  });

  it('opens a retrospective run with the summary request', () => {
    const prompt = buildTurnPrompt(manager({ executionMode: 'task' }, { triggers: [{ type: 'retrospective' }] }), { resumed: false });
    expect(prompt).toMatchSnapshot();
    expect(prompt.split('\n')[0]).toBe('任务 NP-12 已完成，请做总结');
    expect(prompt).toContain('`nocoproject pm issue NP-12 --json`');
    expect(prompt).toContain('a comment whose first line is `/note`');
    expect(prompt).toContain('`nocoproject kb propose ... --json`');
    expect(prompt).toContain('Do not change the status');
    expect(prompt).not.toContain('When done, deliver via');
  });
});
