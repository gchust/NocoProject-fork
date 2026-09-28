/**
 * Iteration 4 parts of the runtime brief and the turn prompt (iteration-4 contract §B, §C):
 * `## Design first` (design-first issues before and after approval), `## Project manager`
 * (agents of kind `manager`) with the `pm` commands, and the `designApproved` / `retrospective`
 * turn openings. Pure string builders.
 */
import { agentKindOf, type ClaimedRunV1, designPendingOf, issueProcessOf } from '../run-context.js';
import { KB_PROPOSALS_PER_RUN } from './brief-knowledge.js';

export type Iter4BriefInput = Pick<ClaimedRunV1, 'agent' | 'issue'>;

/** Opening line of a run triggered by the design approval (§B). */
export const DESIGN_APPROVED_OPENING = '方案已批准，按方案实现';

/** Opening line of a retrospective run (§C). */
export function retrospectiveOpening(key: string): string {
  return `任务 ${key} 已完成，请做总结`;
}

export const isManager = (input: Pick<ClaimedRunV1, 'agent'>): boolean => agentKindOf(input) === 'manager';

/** `issue design-proposal` in `## Available Commands` (design-first issues only). */
export function designCommands(input: Iter4BriefInput): string[] {
  if (issueProcessOf(input) !== 'design_first') return [];
  const key = input.issue.identifier;
  return [`- \`nocoproject issue design-proposal ${key} --content-file ./proposal.md --json\` — submit (or resubmit) the design proposal of ${key} (see Design first)`];
}

/** `## Design first`: the whole design loop while unapproved; a short reminder once approved. */
export function designFirstSection(input: Iter4BriefInput): string[] {
  if (issueProcessOf(input) !== 'design_first') return [];
  const key = input.issue.identifier;
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

/** The `pm` commands (manager agents only). */
export function pmCommands(): string[] {
  return [
    '- `nocoproject pm projects --json` — every project you can see (lead, members, issue counts)',
    '- `nocoproject pm issues [--project <id>] [--status <key>] [--owner me|<userId>] [--executor <agentId>] [--q <text>] [--since 7d] [--limit n] [--cursor c] --json` — search issues across projects (`{ data, nextCursor }`)',
    '- `nocoproject pm issue <issue> --json` — one issue in full: comments and activities (latest 50), runs, pull requests, sub-issues',
    '- `nocoproject pm inbox --json` — the decisions waiting for the person who asked you',
    '- `nocoproject pm metrics [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--project <id>] --json` — the metrics report',
    '- `nocoproject pm knowledge [--project <id>] [--q <text>] --json` — knowledge documents of every visible project and system-wide',
  ];
}

/** `## Project manager` (§C): the manager agent's role and rules. */
export function managerSection(input: Iter4BriefInput): string[] {
  if (!isManager(input)) return [];
  return [
    '## Project manager',
    '',
    'You are the project manager of this NocoProject workspace. You do not write code: you read across all projects, answer questions, write retrospectives and suggest knowledge. You see exactly what the person who asked you can see.',
    '',
    '- Lead with the conclusion, then the supporting facts. Keep it short.',
    '- Answer in the language the person asked in.',
    '- Cite issue identifiers (for example `NP-12`) and project names for every fact, so people can check them.',
    '- Get facts with the `pm` commands (see Available Commands); never guess numbers or statuses.',
    '- Never change the status of any issue, and never @-mention any agent (mentions would start agents working). Point people to the issue instead.',
    '- Get facts only through the `nocoproject` commands. Never read configuration files, never look for API keys or tokens, never call the server API directly with curl or code, and never read the CLI source.',
    `- To add to the knowledge base, use \`nocoproject kb propose\` (the project lead decides; at most ${KB_PROPOSALS_PER_RUN} per run). Never edit documents directly.`,
    '',
  ];
}

/** `## Workflow` for a manager agent. */
export function managerWorkflowSection(): string[] {
  return [
    '## Workflow',
    '',
    '1. Read the new comment(s) quoted in this turn’s prompt; read earlier comments only when you need more context.',
    '2. Collect the facts with the `pm` commands.',
    '3. Reply with one comment using `comment add`, in the triggering thread (`--parent <rootId>`): conclusion first, identifiers cited.',
    '4. Leave the status alone; you never need to set `in_review`.',
  ];
}

export function managerStatusRules(): string[] {
  return ['You never change the status of any issue, including this one; people do.'];
}

type PromptInput = Pick<ClaimedRunV1, 'run' | 'issue' | 'triggers'>;

export const hasTrigger = (input: PromptInput, type: string): boolean => input.triggers.some((t) => t.type === type);

/** The whole prompt of a retrospective run (§C). */
export function retrospectivePrompt(input: PromptInput): string {
  const key = input.issue.identifier;
  return [
    retrospectiveOpening(key),
    `Issue ${key} "${input.issue.title}" is done; you are writing its retrospective as the project manager. Run: ${input.run.id}.`,
    `1. Read everything about it: \`nocoproject pm issue ${key} --json\` (issue, comments, activities, runs with usage, pull requests, sub-issues).`,
    `2. Write exactly one internal note: a comment whose first line is \`/note\` (it notifies no one), posted with \`nocoproject issue comment add ${key} --content-file ./note.md\`. Cover what was done, how long it took and what the runs used, conventions or pitfalls worth keeping, and whether the team's conventions need updating.`,
    `3. Propose each durable convention or pitfall with \`nocoproject kb propose ... --json\` (it goes to the project lead; at most ${KB_PROPOSALS_PER_RUN}).`,
    '4. Do not change the status, do not @-mention anyone and do not post anything else.',
    '5. Use only the `nocoproject` commands; never read configuration files, keys or the CLI source, and never call the server API directly.',
  ].join('\n');
}

/** The approved proposal quoted in a `designApproved` turn. */
export function approvedProposalLines(input: PromptInput, quote: (text: string) => string): string[] {
  if (!hasTrigger(input, 'designApproved')) return [];
  const content = input.issue.designProposal?.content?.trim();
  if (!content) return [`Read the approved proposal (the latest comment of kind \`proposal\`): \`nocoproject issue comment list ${input.issue.identifier} --json\`.`];
  return ['The approved design proposal:', quote(content)];
}
