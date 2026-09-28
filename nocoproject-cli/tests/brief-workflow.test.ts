import { describe, expect, it } from 'vitest';
import { buildBrief, buildTurnPrompt } from '../src/daemon/brief.js';
import { iter3Run, iter4Run } from './helpers/fixtures.js';

const item = (itemKey: string, label: string, required: boolean, checked = false) => ({
  itemKey,
  label,
  required,
  checked,
  checkedByType: null,
  checkedById: null,
  checkedByName: null,
  checkedAt: null,
});

describe('Phase 2 brief: workflow stages', () => {
  it('lists the unchecked checklist items of the current status', () => {
    const base = iter4Run({ process: 'direct' });
    const run = iter4Run({
      process: 'direct',
      checklist: {
        statusKey: base.issue.statusKey,
        current: true,
        complete: false,
        items: [item('tests', 'Tests pass', true), item('docs', 'Docs updated', false), item('lint', 'Lint clean', true, true)],
      },
    });
    const brief = buildBrief(run);
    expect(brief).toContain('## Stage checklist');
    expect(brief).toContain('- **(required)** Tests pass (`tests`)');
    expect(brief).toContain('- Docs updated (`docs`)');
    expect(brief).not.toContain('Lint clean');
    expect(brief).toContain('`CHECKLIST_INCOMPLETE`');
    expect(brief).toContain(`\`nocoproject issue checklist ${run.issue.identifier} check <itemKey>\``);
  });

  it('tells coding agents how to change a workflow template (propose, a human decides), not managers', () => {
    const brief = buildBrief(iter4Run({ process: 'direct' }));
    expect(brief).toContain('## Changing a workflow template');
    expect(brief).toContain('`nocoproject workflow get <template> --definition > wf.json`');
    expect(brief).toContain('- `nocoproject workflow propose (<template> | --copy-from <template> --name "...")');
    expect(brief).toContain('`INVALID_WORKFLOW` lists every problem with its path');
  });

  it('adds nothing without a checklist, when everything is checked, or for another status', () => {
    const plain = buildBrief(iter4Run({ process: 'direct' }));
    expect(plain).toBe(buildBrief(iter3Run()));
    const base = iter4Run({ process: 'direct' });
    const done = { statusKey: base.issue.statusKey, current: true, complete: true, items: [item('tests', 'Tests pass', true, true)] };
    expect(buildBrief(iter4Run({ process: 'direct', checklist: done }))).toBe(plain);
    expect(buildBrief(iter4Run({ process: 'direct', checklist: { ...done, statusKey: 'elsewhere', items: [item('a', 'A', true)] } }))).toBe(plain);
  });

  it('opens a stageEntered turn with the stage and the stage instruction', () => {
    const run = iter4Run(
      { process: 'direct' },
      {},
      { triggers: [{ type: 'stageEntered', stage: { from: 'in_progress', to: 'in_review', instruction: 'Review NP-12 carefully.\nCheck the tests.' } }] },
    );
    const prompt = buildTurnPrompt(run, { resumed: false });
    expect(prompt).toContain('The issue entered `in_review` (from `in_progress`) and the workflow asked you to work on this stage.');
    expect(prompt).toContain('Stage instruction (阶段指令):\n> Review NP-12 carefully.\n> Check the tests.');
    const bare = buildTurnPrompt(iter4Run({ process: 'direct' }, {}, { triggers: [{ type: 'stageEntered' }] }), { resumed: false });
    expect(bare).toContain('The issue entered a new stage');
    expect(bare).not.toContain('Stage instruction');
  });
});
