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
    expect(brief).toContain('nocoproject issue design-proposal NP-12 --content-file ./proposal.md');
    expect(brief).not.toContain('5. After delivering, set the status to `in_review`.');
    expect(brief).toContain('## Runtime rules');
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
    expect(buildBrief(iter3Run())).not.toContain('## Design first');
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

describe('configured conversation and completion briefs', () => {
 const configured = (kind: 'manager'|'coder' = 'manager') => iter4Run({ process: 'direct', executionMode: 'session' }, { kind, capabilities: ['context.read','workspace.read','comment.create','knowledge.propose'], configurationRevision: 8, instructions: 'Answer in Chinese. Do not split tasks.', taskInstructions: 'Summarize the completed work.' });
 it('uses configuration as the only role definition', () => {
  const brief = buildBrief(configured());
  expect(brief).toContain('Answer in Chinese. Do not split tasks.');
  expect(brief).toContain('Summarize the completed work.');
  expect(brief).toContain('nocoproject pm projects');
  expect(brief).toContain('--title <title> [--parent <slug|id>]');
  expect(brief).toContain('a new document inherits the parent’s scope: system-level or this project');
  expect(brief).toContain('system-level proposals still need a system-level knowledge decider');
  expect(brief).not.toContain('## Project manager');
  expect(brief).not.toContain('nocoproject issue create');
  expect(brief).not.toContain('Lead with the conclusion');
  expect(buildBrief(configured('coder'))).toBe(brief);
 });
 it.each([false,true])('does not add a profession on resumed=%s', resumed => {
  const input = configured();
  const prompt = buildTurnPrompt({...input,triggers:[{type:'retrospective'}]}, {resumed});
  expect(prompt).not.toContain('as the project manager');
  expect(prompt).toContain('comment add');
 });
 it('does not infer powers from a missing configuration', () => {
  const input = configured();
  expect(buildBrief({...input,agent:{...input.agent,capabilities:[]}})).not.toContain('nocoproject pm projects');
 });
});
