import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyBriefBlock, BRIEF_BEGIN, BRIEF_END, buildBrief, buildTurnPrompt, writeBrief } from '../src/daemon/brief.js';
import { claimedRun, iter2Run, iter3Run, phase1Run } from './helpers/fixtures.js';

describe('brief', () => {
  it('renders the runtime block', () => {
    expect(buildBrief(claimedRun())).toMatchSnapshot();
  });

  it('renders the Phase 1 sections with a project, repositories, a parent and delegation targets', () => {
    const brief = buildBrief(phase1Run());
    expect(brief).toMatchSnapshot();
    expect(brief).toContain('## Repositories');
    expect(brief).toContain('`https://github.com/nocobase/nocoproject.git` (default ref `main`)');
    expect(brief).toContain('on the branch `agent/coder/np-12`');
    expect(brief).toContain('`gh pr create --title "NP-12: <summary>"` and link it with `nocoproject pr link <url>`');
    expect(brief).toContain('The branch name already contains NP-12, so the server also links it automatically.');
    expect(brief).toContain('worked on branch `agent/coder/np-12`');
    expect(brief).toContain('Auto-execute sub-issues is **on** for NP-12');
    expect(brief).toContain('Reviewer (`a7`)');
    expect(brief).toContain('NP-12 is a sub-issue (stage 2) of NP-10 "Login overhaul"');
  });

  it('explains missing projects and repositories', () => {
    const brief = buildBrief(claimedRun());
    expect(brief).toContain('This issue is not in a project.');
    expect(brief).toContain('`repo checkout` is not available');
    expect(brief).toContain('Auto-execute sub-issues is **off**');
    expect(brief).toContain('## Parent coordination');
  });

  it('lists only agent transitions', () => {
    const brief = buildBrief(claimedRun({ agentTransitions: [{ from: 'todo', to: 'in_progress' }] }));
    expect(brief).toContain('`todo` → `in_progress`');
    expect(brief).not.toContain('`in_progress` → `in_review`');
  });

  it('appends to files without a block and keeps outside content', () => {
    const block = buildBrief(claimedRun());
    const out = applyBriefBlock('# My project\n\nRules here.\n', block);
    expect(out.startsWith('# My project\n\nRules here.\n\n' + BRIEF_BEGIN)).toBe(true);
    expect(out.endsWith(`${BRIEF_END}\n`)).toBe(true);
  });

  it('replaces the block in place', () => {
    const before = `intro\n${BRIEF_BEGIN}\nold stuff\n${BRIEF_END}\noutro\n`;
    const out = applyBriefBlock(before, `${BRIEF_BEGIN}\nnew\n${BRIEF_END}`);
    expect(out).toBe(`intro\n${BRIEF_BEGIN}\nnew\n${BRIEF_END}\noutro\n`);
    expect(applyBriefBlock(out, `${BRIEF_BEGIN}\nnew\n${BRIEF_END}`)).toBe(out);
  });

  it('writes CLAUDE.md idempotently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ncp-brief-'));
    writeFileSync(join(dir, 'CLAUDE.md'), 'Project notes.\n');
    const block = buildBrief(claimedRun());
    writeBrief(dir, 'CLAUDE.md', block);
    const once = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    writeBrief(dir, 'CLAUDE.md', block);
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe(once);
    expect(once.startsWith('Project notes.\n')).toBe(true);
  });
});

describe('iteration 2 brief', () => {
  it('lists skills, linked pull requests and the pr commands in task mode', () => {
    const brief = buildBrief(iter2Run());
    expect(brief).toContain('## Skills');
    expect(brief).toContain('- **Deploy** — How to deploy the app to staging. `.nocoproject/skills/deploy/SKILL.md`');
    expect(brief).toContain('Claude Code also discovers the same skills natively under `.claude/skills/`.');
    expect(brief).toContain('- #42 (open) https://github.com/nocobase/nocoproject/pull/42');
    expect(brief).toContain('`nocoproject pr link <url> [--issue NP-12] --json`');
    expect(brief).toContain('`nocoproject pr list [--issue NP-12] --json`');
    expect(brief).not.toContain('## Conversation Mode');
    expect(brief).toContain('5. After delivering, set the status to `in_review`.');
    expect(brief).not.toContain('deploy-secret-value-123');
  });

  it('omits the Claude note for other providers and skips invalid skill slugs', () => {
    const run = iter2Run({}, { provider: 'codex', skills: [{ id: 's2', slug: '../evil', name: 'Evil', description: 'x', content: '', files: [] }] });
    const brief = buildBrief(run);
    expect(brief).not.toContain('## Skills');
    expect(buildBrief(iter2Run({}, { provider: 'codex' }))).not.toContain('.claude/skills');
  });

  it('snapshots the task-mode brief', () => {
    expect(buildBrief(iter2Run())).toMatchSnapshot();
  });

  it('opens conversationally in session mode and does not require in_review', () => {
    const brief = buildBrief(iter2Run({ executionMode: 'session' }));
    expect(brief).toMatchSnapshot();
    expect(brief.indexOf('## Conversation Mode')).toBeLessThan(brief.indexOf('## Runtime rules'));
    expect(brief).toContain('do not write a summary report every turn');
    expect(brief).toContain('Your working directory and your session carry over');
    expect(brief).toContain('You do not need to move the issue to `in_review`');
    expect(brief).not.toContain('After delivering, set the status to `in_review`');
  });

  it('renders the session-mode turn prompt', () => {
    const prompt = buildTurnPrompt(iter2Run({ executionMode: 'session' }), { resumed: true });
    expect(prompt).toMatchSnapshot();
    expect(prompt).toContain('live conversation with the owner on issue NP-12');
    expect(prompt).toContain('--content-file ./reply.md --parent c9`; you do not need to set `in_review`.');
    expect(buildTurnPrompt(iter2Run(), { resumed: true })).toContain('When done, deliver via');
  });
});

describe('iteration 3 brief', () => {
  it('lists the knowledge documents and how to read and propose them', () => {
    const brief = buildBrief(iter3Run());
    expect(brief).toMatchSnapshot();
    expect(brief).toContain('## Knowledge');
    expect(brief).toContain('- **API conventions** (`api-conventions`) — Error envelope, pagination and naming rules.');
    expect(brief).toContain('- **Release process** (`release-process`, system-wide) — (no summary)');
    expect(brief).toContain('Read one with `nocoproject kb get <slug>`');
    expect(brief).toContain('- `nocoproject kb list --json`');
    expect(brief).toContain('## Capture learnings');
    expect(brief).toContain('Propose at most 3 per run');
    expect(brief).toContain('Do not edit knowledge documents directly');
    expect(brief.indexOf('## Skills')).toBeLessThan(brief.indexOf('## Knowledge'));
    expect(brief.indexOf('## Knowledge')).toBeLessThan(brief.indexOf('## Workflow'));
    expect(brief.indexOf('## Parent coordination')).toBeLessThan(brief.indexOf('## Capture learnings'));
    expect(brief.indexOf('## Capture learnings')).toBeLessThan(brief.indexOf('## Status Rules'));
  });

  it('says when there are no documents and still asks to capture learnings', () => {
    const brief = buildBrief(claimedRun());
    expect(brief).toContain('No knowledge documents are available to this run yet.');
    expect(brief).toContain('## Capture learnings');
    expect(buildBrief(iter3Run({ knowledge: [] }))).toContain('No knowledge documents are available to this run yet.');
  });

  it('adds a child-count hint with the exact kb list --parent command when a root document has children (NP-147)', () => {
    const brief = buildBrief(
      iter3Run({
        knowledge: [
          { id: 'kd1', slug: 'product-manual', title: 'Product manual', summary: 'Full user guide.', projectId: 'p1', childCount: 3 },
          { id: 'kd2', slug: 'release-process', title: 'Release process', summary: '', projectId: null, childCount: 0 },
          { id: 'kd3', slug: 'faq', title: 'FAQ', summary: 'Answers.', projectId: 'p1', childCount: 1 },
        ],
      }),
    );
    expect(brief).toContain('- **Product manual** (`product-manual`) — Full user guide. (3 sub-documents: `nocoproject kb list --parent product-manual`)');
    expect(brief).toContain('- **Release process** (`release-process`, system-wide) — (no summary)\n');
    expect(brief).toContain('- **FAQ** (`faq`) — Answers. (1 sub-document: `nocoproject kb list --parent faq`)');
  });
});

describe('turn prompt', () => {
  it('renders a mention turn', () => {
    expect(buildTurnPrompt(claimedRun(), { resumed: false })).toMatchSnapshot();
  });

  it('names the attached files and how to download them (NP-111)', () => {
    const issue = {
      ...claimedRun().issue,
      attachments: [
        { id: 'f1', filename: 'shot.png', mimeType: 'image/png', size: 4 },
        { id: 'f2', filename: 'spec.pdf', mimeType: 'application/pdf', size: 9 },
      ],
    };
    const prompt = buildTurnPrompt(claimedRun({ issue, triggers: [{ type: 'assign' }] }), { resumed: false });
    expect(prompt).toContain(
      'It has 2 attached files (shot.png, spec.pdf): save them with `nocoproject issue attachment download NP-12` and open the printed paths.',
    );
    expect(buildTurnPrompt(claimedRun(), { resumed: false })).not.toContain('attached file');
  });

  it('renders an assignment turn without --parent', () => {
    const prompt = buildTurnPrompt(claimedRun({ triggers: [{ type: 'assign' }] }), { resumed: true });
    expect(prompt).toMatchSnapshot();
    expect(prompt).not.toContain('--parent');
  });

  it('collects several merged triggers and replies to the last thread', () => {
    const prompt = buildTurnPrompt(
      claimedRun({
        triggers: [
          { type: 'mention', comment: { id: 'c1', authorName: 'Bob', content: 'first', parentId: null, rootId: 'c1' } },
          { type: 'reply', comment: { id: 'c3', authorName: 'Carol', content: 'second', parentId: 'c2', rootId: 'c2' } },
        ],
      }),
      { resumed: false },
    );
    expect(prompt).toContain('[NEW COMMENT] from Bob (reply with --parent c1):\n> first');
    expect(prompt).toContain('[NEW COMMENT] from Carol (reply with --parent c2):\n> second');
    expect(prompt).toContain('--content-file ./reply.md --parent c2`.');
  });
});

describe('Phase 1 turn prompts', () => {
  it('opens a childBatchDone turn for a sub-issue', () => {
    const prompt = buildTurnPrompt(phase1Run({ triggers: [{ type: 'childBatchDone' }] }), { resumed: true });
    expect(prompt).toMatchSnapshot();
    expect(prompt).toContain('It is a sub-issue (stage 2) of NP-10 "Login overhaul".');
    expect(prompt).toContain("A batch of NP-12's sub-issues has finished. Review them with `nocoproject issue children NP-12 --json`");
  });

  it('opens dependencyReleased and proposalAccepted turns', () => {
    const released = buildTurnPrompt(phase1Run({ triggers: [{ type: 'dependencyReleased' }] }), { resumed: false });
    expect(released).toContain('The issues this one was waiting for are done: it is unblocked and ready to be worked on.');
    const accepted = buildTurnPrompt(phase1Run({ triggers: [{ type: 'proposalAccepted' }] }), { resumed: false });
    expect(accepted).toContain('The owner accepted the proposal to make you the executor of this issue.');
  });
});
