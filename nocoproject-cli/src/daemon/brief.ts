/**
 * Runtime brief (CLAUDE.md / AGENTS.md marker block) and per-turn prompt (protocol §7).
 * Pure string builders plus one small file writer.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ClaimedRunV1, designPendingOf, executionModeOf } from '../run-context.js';
import {
  conversationModeSection,
  parentCoordinationSection,
  phase1Commands,
  projectSection,
  repositoriesSection,
  skillsSection,
  subIssuesSection,
  workflowSection,
} from './brief-sections.js';
import { captureLearningsSection, knowledgeCommands, knowledgeSection } from './brief-knowledge.js';
import { stageChecklistSection, stageEnteredLines, workflowCommands, workflowTemplatesSection } from './brief-workflow.js';
import {
  approvedProposalLines,
  DESIGN_APPROVED_OPENING,
  designCommands,
  designFirstSection,
  designWorkflowSection,
  hasTrigger,
  isManager,
  managerSection,
  managerStatusRules,
  managerWorkflowSection,
  pmCommands,
  retrospectivePrompt,
} from './brief-iter4.js';

export const BRIEF_BEGIN = '<!-- BEGIN NOCOPROJECT-RUNTIME (auto-managed; do not edit) -->';
export const BRIEF_END = '<!-- END NOCOPROJECT-RUNTIME -->';

export type BriefInput = Pick<ClaimedRunV1, 'agent' | 'issue' | 'agentTransitions' | 'statusCatalog' | 'project' | 'session' | 'knowledge'>;

function statusRules(input: BriefInput): string[] {
  if (isManager(input)) return managerStatusRules();
  if (input.agentTransitions.length === 0) return ['You may not change the issue status in this workspace.'];
  const lines = ['You may only make these status transitions (the server rejects anything else):', ''];
  for (const t of input.agentTransitions) lines.push(`- \`${t.from}\` → \`${t.to}\``);
  lines.push('', 'Every other status change (for example to `done`) is made by a human.');
  return lines;
}

/** Commands, sections and workflow that only a coding agent (kind `coder`) gets. */
function coderParts(input: BriefInput): { commands: string[]; sections: string[]; workflow: string[] } {
  const key = input.issue.identifier;
  return {
    commands: [`- \`nocoproject issue status ${key} <statusKey>\` — change the issue status`, ...designCommands(input), ...phase1Commands(key), ...workflowCommands(key)],
    sections: [...stageChecklistSection(input), ...repositoriesSection(input), '', ...skillsSection(input), ...knowledgeSection(input)],
    workflow: [
      ...(designPendingOf(input) ? designWorkflowSection(input) : workflowSection(input)),
      '',
      ...subIssuesSection(input),
      '',
      ...parentCoordinationSection(key),
      '',
      ...workflowTemplatesSection(),
      '',
      ...captureLearningsSection(),
    ],
  };
}

/** A manager agent (§C) reads and answers: no status, repository, sub-issue or delivery rules. */
function managerParts(input: BriefInput): { commands: string[]; sections: string[]; workflow: string[] } {
  return {
    commands: pmCommands(),
    sections: [...skillsSection(input), ...knowledgeSection(input)],
    workflow: managerWorkflowSection(),
  };
}

export function buildBrief(input: BriefInput): string {
  const key = input.issue.identifier;
  const instructions = input.agent.instructions.trim() || '(no additional instructions)';
  const parts = isManager(input) ? managerParts(input) : coderParts(input);
  return [
    BRIEF_BEGIN,
    '# NocoProject Agent Runtime',
    '',
    ...managerSection(input),
    ...conversationModeSection(input),
    ...designFirstSection(input),
    '## Background Task Safety',
    '',
    'This run ends the moment your turn ends: anything still running in the background is killed and its result is lost.',
    '- Do all work in foreground commands that finish before you reply. Never start background jobs, daemons or watchers and then yield.',
    '- Do not wait on CI or external systems; report what you did and what is pending instead.',
    '- Never stop, restart or kill the `nocoproject` daemon or its processes.',
    '',
    '## Agent Identity',
    '',
    `You are **${input.agent.name}** (agent id \`${input.agent.id}\`), an AI agent working in NocoProject.`,
    '',
    'Instructions from your owner:',
    '',
    instructions,
    '',
    '## Available Commands',
    '',
    'The `nocoproject` CLI is already authenticated for this run (do not print or log `NOCOPROJECT_TOKEN`).',
    '',
    `- \`nocoproject issue get ${key} --json\` — read the issue (title, description, status, owner)`,
    `- \`nocoproject issue comment list ${key} --json\` — read the comments (\`--thread <rootId>\`, \`--tail <n>\`, \`--since <iso>\`)`,
    `- \`nocoproject issue comment add ${key} --content-file ./reply.md [--parent <rootId>]\` — post a comment`,
    `- \`nocoproject issue attachment download ${key} [--id <fileId>] [--dir <path>]\` — save the issue's attached files (images, documents) locally and print their paths; \`issue attachment list\` lists them`,
    ...parts.commands,
    ...knowledgeCommands(),
    '',
    ...projectSection(input),
    '',
    ...parts.sections,
    ...parts.workflow,
    '',
    '## Status Rules',
    '',
    ...statusRules(input),
    '',
    '## Output',
    '',
    'Always write comment bodies to a Markdown file inside the working directory and pass it with `--content-file`; never inline long content on the command line.',
    'Your final message in this turn is only a log; the comment you post is what humans read.',
    BRIEF_END,
  ].join('\n');
}

/** Replaces the marker block in `existing` (or appends it). Content outside the markers is untouched. */
export function applyBriefBlock(existing: string | null, block: string): string {
  if (!existing) return `${block}\n`;
  const start = existing.indexOf(BRIEF_BEGIN);
  const end = start >= 0 ? existing.indexOf(BRIEF_END, start) : -1;
  if (start >= 0 && end >= 0) return existing.slice(0, start) + block + existing.slice(end + BRIEF_END.length);
  const sep = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${sep}${block}\n`;
}

export function writeBrief(workDir: string, fileName: string, block: string): string {
  const path = join(workDir, fileName);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
  writeFileSync(path, applyBriefBlock(existing, block));
  return path;
}

export type PromptInput = Pick<ClaimedRunV1, 'run' | 'issue' | 'triggers' | 'agent'>;

function quote(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

const TRIGGER_NOTES: Record<string, (key: string) => string> = {
  assign: () => 'You were assigned to this issue.',
  statusChange: () => 'The issue was moved out of backlog and is ready to be worked on.',
  retry: () => 'This is a retry of a previous run that failed.',
  dependencyReleased: () => 'The issues this one was waiting for are done: it is unblocked and ready to be worked on.',
  childBatchDone: (key) =>
    `A batch of ${key}'s sub-issues has finished. Review them with \`nocoproject issue children ${key} --json\` and continue as described under "Parent coordination".`,
  proposalAccepted: () => 'The owner accepted the proposal to make you the executor of this issue.',
};

function parentLine(input: PromptInput): string[] {
  const parent = input.issue.parent;
  if (!parent) return [];
  const stage = input.issue.stage === null || input.issue.stage === undefined ? '' : ` (stage ${input.issue.stage})`;
  return [`It is a sub-issue${stage} of ${parent.identifier} "${parent.title}".`];
}

/** NP-111: the issue's attached files, so the agent downloads them instead of assuming there are none. */
function attachmentLines(input: PromptInput): string[] {
  const files = input.issue.attachments ?? [];
  if (files.length === 0) return [];
  const names = files.map((file) => file.filename).join(', ');
  return [
    `It has ${files.length} attached file${files.length === 1 ? '' : 's'} (${names}): save them with \`nocoproject issue attachment download ${input.issue.identifier}\` and open the printed paths.`,
  ];
}

function openingLines(input: PromptInput): string[] {
  const key = input.issue.identifier;
  if (executionModeOf(input) === 'session') {
    return [
      `You are in a live conversation with the owner on issue ${key} "${input.issue.title}" (session mode).`,
      ...parentLine(input),
      ...attachmentLines(input),
      `Run: ${input.run.id}. When you need more context, read the issue (\`nocoproject issue get ${key} --json\`) and earlier comments (\`nocoproject issue comment list ${key} --json\`).`,
    ];
  }
  return [
    `You are working on issue ${key} "${input.issue.title}".`,
    ...parentLine(input),
    ...attachmentLines(input),
    `Run: ${input.run.id}. Read the issue first: \`nocoproject issue get ${key} --json\``,
    `Then catch up on comments: \`nocoproject issue comment list ${key} --json\``,
  ];
}

/** The per-turn user message (§7); session mode (iteration 2 §J) opens conversationally. */
export function buildTurnPrompt(input: PromptInput, opts: { readonly resumed: boolean }): string {
  const key = input.issue.identifier;
  if (hasTrigger(input, 'retrospective')) return `${retrospectivePrompt(input)}\nSession: ${opts.resumed ? 'resumed' : 'fresh'}.`;
  const lines = [...(hasTrigger(input, 'designApproved') ? [DESIGN_APPROVED_OPENING] : []), ...openingLines(input)];
  let rootId: string | undefined;
  for (const trigger of input.triggers) {
    if (trigger.comment) {
      rootId = trigger.comment.rootId;
      lines.push(`[NEW COMMENT] from ${trigger.comment.authorName} (reply with --parent ${trigger.comment.rootId}):`);
      lines.push(quote(trigger.comment.content));
    } else if (trigger.type === 'stageEntered') {
      lines.push(...stageEnteredLines(trigger, quote));
    } else {
      const note = TRIGGER_NOTES[trigger.type];
      if (note) lines.push(note(key));
    }
  }
  lines.push(...approvedProposalLines(input, quote));
  lines.push(`Session: ${opts.resumed ? 'resumed' : 'fresh'}.`);
  const parent = rootId ? ` --parent ${rootId}` : '';
  if (isManager(input)) {
    lines.push(`Reply via \`nocoproject issue comment add ${key} --content-file ./reply.md${parent}\`, conclusion first; you do not need to set \`in_review\` and never change the status.`);
  } else if (designPendingOf(input)) {
    lines.push(`Submit or revise the proposal with \`nocoproject issue design-proposal ${key} --content-file ./proposal.md\`, then set \`proposal_review\`; answer questions via \`nocoproject issue comment add ${key} --content-file ./reply.md${parent}\`. No code changes or pull requests before approval.`);
  } else if (executionModeOf(input) === 'session') {
    lines.push(`Reply briefly via \`nocoproject issue comment add ${key} --content-file ./reply.md${parent}\`; you do not need to set \`in_review\`.`);
  } else {
    lines.push(`When done, deliver via \`nocoproject issue comment add ${key} --content-file ./reply.md${parent}\`.`);
  }
  return lines.join('\n');
}
