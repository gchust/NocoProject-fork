import { describe, expect, it } from 'vitest';
import { buildTurnPrompt } from '../src/daemon/brief.js';
import { iter4Run } from './helpers/fixtures.js';

describe('Phase 2 brief: signals', () => {
  it('opens a signal turn with the title, the link and the rule instruction', () => {
    const run = iter4Run(
      { process: 'direct' },
      {},
      {
        triggers: [
          {
            type: 'signal',
            signal: {
              source: 'github',
              kind: 'github.ciFailed',
              key: 'acme/app#5@abc',
              title: 'Checks failed on acme/app#5',
              url: 'https://github.com/acme/app/pull/5',
              instruction: 'Fix it on feature/login.\nPush to the same branch.',
            },
          },
        ],
      },
    );
    const prompt = buildTurnPrompt(run, { resumed: true });
    expect(prompt).toContain('[SIGNAL] Checks failed on acme/app#5 — https://github.com/acme/app/pull/5 (`github.ciFailed`).');
    expect(prompt).toContain('A rule the workspace configured woke you for this');
    expect(prompt).toContain('Instruction:\n> Fix it on feature/login.\n> Push to the same branch.');
    expect(prompt).toContain('Session: resumed.');
  });

  it('still says why it woke when the server sent no signal payload', () => {
    const prompt = buildTurnPrompt(iter4Run({ process: 'direct' }, {}, { triggers: [{ type: 'signal' }] }), { resumed: false });
    expect(prompt).toContain('[SIGNAL] Something linked to this issue needs your attention');
    expect(prompt).not.toContain('Instruction:');
  });
});
