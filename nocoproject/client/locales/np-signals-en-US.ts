import type { LocaleResource } from '@nocobase/i18n';

/**
 * NocoProject wording for signals (`server/modules/shared/protocol.phase2-signals.ts`): the rules on a source's
 * settings tab that let a report from outside (a linked pull request's checks failed, it conflicts with its base)
 * wake the issue's executor agent. Merged into `np` by `en-US.ts`; the group is new, so the spread shadows nothing.
 * `np-signals-zh-CN.ts` is checked against the shape derived from this object.
 */
const npSignalsEnUS = {
  signals: {
    title: 'Wake the executor agent',
    description:
      'When something on a linked pull request needs fixing, wake the agent executing the issue to fix it on the same branch. Off until you turn it on; issues a person executes are never affected.',
    readOnly:
      'Only people who may change the workspace settings can change these rules.',
    saved: 'Rules saved',
    maxConsecutive: 'Attempts in a row',
    maxConsecutiveHint:
      'After this many runs without the problem going away, the agent is not woken again and the issue owner is told instead.',
    maxConsecutiveInvalid: 'Enter a whole number from 1 to {{max}}.',
    instruction: 'Instruction for the agent',
    instructionHint:
      'Leave empty to use the default shown. Placeholders you can use:',
    kinds: {
      'github.ciFailed': {
        label: 'Checks failed',
        hint: 'A linked open pull request’s checks (GitHub Actions or commit statuses) failed.',
      },
      'github.conflict': {
        label: 'Merge conflicts',
        hint: 'A linked open pull request conflicts with its base branch. Needs the webhook’s Pushes event.',
      },
    },
  },
};

export default npSignalsEnUS;
export type NpSignalsResource = LocaleResource<typeof npSignalsEnUS>;
