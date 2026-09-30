/**
 * Iteration 4 parts of the runtime brief and the turn prompt (iteration-4 contract §B, §C):
 * `## Design first` (design-first issues before and after approval), `## Project manager`
 * (agents of kind `manager`) with the `pm` commands, and the `designApproved` / `retrospective`
 * turn openings. Pure string builders.
 */
import { type ClaimedRunV1, designPendingOf, issueProcessOf } from '../run-context.js';

export type Iter4BriefInput = Pick<ClaimedRunV1, 'agent' | 'issue'>;

/** Opening line of a run triggered by the design approval (§B). */
export const DESIGN_APPROVED_OPENING = '方案已批准，按方案实现';

/** `issue design-proposal` in `## Available Commands` (design-first issues only). */
export function designCommands(input: Iter4BriefInput): string[] {
  if (issueProcessOf(input) !== 'design_first') return [];
  const key = input.issue.identifier || input.issue.id;
  return [`- \`nocoproject issue design-proposal ${key} --content-file ./proposal.md --json\` — submit (or resubmit) the design proposal of ${key} (see Design first)`];
}

/** `## Design first`: the whole design loop while unapproved; a short reminder once approved. */
export function designFirstSection(input: Iter4BriefInput): string[] {
  if (issueProcessOf(input) !== 'design_first') return [];
  const key = input.issue.identifier || input.issue.id;
  if (!designPendingOf(input)) {
    return [
      '## Design first',
      '',
      `The design proposal of ${key} was approved. Implement it as proposed; the approved proposal is the latest comment of kind \`proposal\` (\`nocoproject issue comment list ${key} --json\`).`,
      'If you have to deviate from it, say where and why in your delivery comment.',
      '',
    ];
  }
  return [
    '## Design first',
    '',
    `${key} uses the design-first process and its design is not approved yet. Analyze first, propose a design, and wait for the owner to approve it.`,
    '',
    `1. Set the status to \`analysis\` when you start (\`nocoproject issue status ${key} analysis\`). Read the issue, the comments and, if needed, the code (read only).`,
    '2. Write the proposal to a Markdown file with these sections: 需求理解 (requirement understanding), 方案 (approach), 影响范围 (scope of impact), 风险与待定 (risks and open questions), 验证计划 (verification plan).',
    `3. Submit it with \`nocoproject issue design-proposal ${key} --content-file ./proposal.md\`.`,
    `4. Set the status to \`proposal_review\` (\`nocoproject issue status ${key} proposal_review\`) and end this turn.`,
    '',
    '- **Before the proposal is approved, do not change any code and do not open a pull request** (no commits, no pushes, no sub-issues: describe any split in the proposal). Do not set `in_progress`: the server refuses it with `DESIGN_NOT_APPROVED`.',
    '- When the proposal is sent back (the issue returns to `analysis` with review comments), revise the whole proposal according to the comments and submit it again as a complete document, not a diff; then set `proposal_review` again.',
    '- Questions about the proposal arrive as comments: answer them in their thread, and submit a revised proposal when the answer changes the design.',
    '- Once the owner approves, you are woken with "方案已批准，按方案实现" and implement the approved design.',
    '',
  ];
}

/** `## Workflow` while the design is pending (replaces the delivery loop). */
export function designWorkflowSection(input: Iter4BriefInput): string[] {
  return [
    '## Workflow',
    '',
    '1. Read the issue and the comments, especially the thread you were asked in.',
    '2. Follow "Design first": analyze, submit the proposal with `issue design-proposal`, set `proposal_review`, and stop.',
    `3. If you were only asked a question, answer it with a comment and do not change the status. If you are stuck, set \`blocked\` and say what you need.`,
    `4. Never set \`in_progress\` or \`in_review\` on ${input.issue.identifier} before the design is approved.`,
  ];
}

type PromptInput = Pick<ClaimedRunV1, 'run' | 'issue' | 'triggers'>;

export const hasTrigger = (input: PromptInput, type: string): boolean => input.triggers.some((t) => t.type === type);

/** The approved proposal quoted in a `designApproved` turn. */
export function approvedProposalLines(input: PromptInput, quote: (text: string) => string): string[] {
  if (!hasTrigger(input, 'designApproved')) return [];
  const content = input.issue.designProposal?.content?.trim();
  if (!content) return [`Read the approved proposal (the latest comment of kind \`proposal\`): \`nocoproject issue comment list ${input.issue.identifier} --json\`.`];
  return ['The approved design proposal:', quote(content)];
}
