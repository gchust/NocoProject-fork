/**
 * Phase 2 workflow parts of the runtime brief and the turn prompt (NP-77 §1, §4, §6):
 * `## Stage checklist` (the current status's checklist while required items are open), the
 * `stageEntered` turn lines (the status entered and the rendered stage instruction), and the
 * workflow template commands with `## Changing a workflow template` (stage 2: read, write the whole
 * definition, propose, a human decides). Pure string builders.
 */
import { checklistOf, type ClaimedRunV1 } from '../run-context.js';

/** `## Stage checklist`: the unchecked items of the current status (nothing when all are checked). */
export function stageChecklistSection(input: Pick<ClaimedRunV1, 'issue'>): string[] {
  const list = checklistOf(input);
  if (!list || list.statusKey !== input.issue.statusKey) return [];
  const open = list.items.filter((item) => !item.checked);
  if (open.length === 0) return [];
  return [
    '## Stage checklist',
    '',
    `The workflow asks for these items while ${input.issue.identifier} is \`${list.statusKey}\` (not yet checked):`,
    '',
    ...open.map((item) => `- ${item.required ? '**(required)** ' : ''}${item.label} (\`${item.itemKey}\`)`),
    '',
    `The server refuses to move the issue out of \`${list.statusKey}\` (except to a cancelled status) while a required item is unchecked (\`CHECKLIST_INCOMPLETE\`). Check each item as you complete it: \`nocoproject issue checklist ${input.issue.identifier} check <itemKey>\`.`,
    '',
  ];
}

type PromptInput = Pick<ClaimedRunV1, 'triggers'>;

/** The lines a `stageEntered` trigger adds to the turn prompt. */
export function stageEnteredLines(trigger: PromptInput['triggers'][number], quote: (text: string) => string): string[] {
  const stage = trigger.stage;
  const lines = [
    stage ? `The issue entered \`${stage.to}\` (from \`${stage.from}\`) and the workflow asked you to work on this stage.` : 'The issue entered a new stage and the workflow asked you to work on it.',
  ];
  const instruction = stage?.instruction?.trim();
  if (instruction) lines.push('Stage instruction (阶段指令):', quote(instruction));
  return lines;
}

/** The workflow template and checklist commands (coding agents). */
export function workflowCommands(key: string): string[] {
  return [
    `- \`nocoproject issue checklist ${key} [check|uncheck <itemKey>] --json\` — show the workflow stage checklists, or check an item you completed`,
    '- `nocoproject workflow list|get [<template>] --json` — read the workflow templates (see Changing a workflow template)',
    '- `nocoproject workflow propose (<template> | --copy-from <template> --name "...") --definition-file ./wf.json --reason "..." --json` — propose a template change for a human to accept',
  ];
}

/** `## Changing a workflow template`: only when a person asks for it; propose the whole definition, a human decides. */
export function workflowTemplatesSection(): string[] {
  return [
    '## Changing a workflow template',
    '',
    'Workflow templates (statuses, transitions, approvals, stage actions) change only when a person asks for it in the issue. You never change a template directly: you propose, and an owner or admin accepts or rejects the proposal in their inbox.',
    '',
    '1. Read: `nocoproject workflow list --json` (the template of this run’s project is marked `usedByRunProject`), then `nocoproject workflow get <template> --definition > wf.json`.',
    '2. Edit `wf.json`: it is the whole definition, so keep everything you are not asked to change. The 9 built-in statuses stay with their category; a new status needs a key (`^[a-z][a-z0-9_]{1,31}$`), one of the 4 categories (fixed once created) and transitions a person can take out of it.',
    '3. Propose: `nocoproject workflow propose <template> --definition-file wf.json --reason "..." --json`. System templates (`isSystem`) can only be copied: `--copy-from <template> --name "..."`, and the project then switches to the copy.',
    '4. The server validates the definition at once: `INVALID_WORKFLOW` lists every problem with its path, and `WORKFLOW_STATUS_CONFLICT` means issues are still in a status you removed. Fix and propose again. `WORKFLOW_PROPOSAL_PENDING` means this run already proposed for that template.',
    '5. Say in your comment which proposal you made and what it changes. A `runExecutor` action with an `agentId` makes that agent run on entering the stage without the owner confirming, so call it out. If the proposal becomes `stale` (the template changed first), propose again from the latest revision.',
  ];
}
