/**
 * Runtime brief (CLAUDE.md / AGENTS.md marker block) and per-turn prompt (protocol §7).
 * Pure string builders plus one small file writer.
 */
import { pmBriefSections, pageContextLines, planResultLines, RUNTIME_RULES } from './brief-pm.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ClaimedRunV1, designPendingOf, executionModeOf } from '../run-context.js';
import { repositoriesSection, skillsSection, projectSection, workflowSection, conversationModeSection, subIssuesSection, parentCoordinationSection, commentAttachmentsSection } from './brief-sections.js';
import { knowledgeSection, captureLearningsSection, hasUserManual, MANUAL_ROOT_SLUG, userManualSection } from './brief-knowledge.js';
import { approvedProposalLines, DESIGN_APPROVED_OPENING, designFirstSection, hasTrigger } from './brief-iter4.js';
import { stageEnteredLines, stageChecklistSection, workflowTemplatesSection } from './brief-workflow.js';
import { signalLines } from './brief-signal.js';
import { AGENT_COMMANDS, type AgentCapability } from '../protocol.js';

export const BRIEF_BEGIN = '<!-- BEGIN NOCOPROJECT-RUNTIME (auto-managed; do not edit) -->';
export const BRIEF_END = '<!-- END NOCOPROJECT-RUNTIME -->';

export type BriefInput = Pick<ClaimedRunV1, 'agent' | 'issue' | 'agentTransitions' | 'statusCatalog' | 'project' | 'session' | 'knowledge'>;

function permits(input: BriefInput, key: AgentCapability): boolean { return input.agent.capabilities?.includes(key) === true; }
export function buildBrief(input: BriefInput): string {
  if (input.issue.conversation) return [BRIEF_BEGIN, ...pmBriefSections(input), BRIEF_END].join('\n');
  const key = input.issue.identifier || input.issue.id;
  const executing = permits(input, 'issue.execute') && executionModeOf(input) !== 'session';
  const manual = executing && permits(input, 'knowledge.propose') && hasUserManual(input);
  const commands = input.agent.commandDescriptions ?? (input.agent.capabilities ?? []).flatMap(c => AGENT_COMMANDS[c] ?? []);
  return [BRIEF_BEGIN, '# NocoProject Agent Runtime', '',
    `You are **${input.agent.name}** (agent id \`${input.agent.id}\`).`,
    `Configuration revision: ${input.agent.configurationRevision ?? 'unavailable'}.`,
    '', '## Instructions from your owner', '', input.agent.instructions,
    ...conversationModeSection(input),
    '', '## Task instructions', '', input.agent.taskInstructions ?? '',
    '', '## Runtime rules', '',
    ...RUNTIME_RULES,
    '', '## Available Commands', '',
    ...commands.map(command => `- \`nocoproject ${command.replaceAll('<issue>', key)}\``),
    '', ...projectSection(input), ...skillsSection(input),
    ...(permits(input, 'context.read') ? knowledgeSection(input) : []),
    ...(permits(input, 'issue.execute') ? repositoriesSection(input) : []),
    ...(permits(input, 'attachment.upload') && permits(input, 'comment.create') ? commentAttachmentsSection(key) : []),
    ...(permits(input, 'subtask.create') ? [...subIssuesSection(input), ...parentCoordinationSection(key)] : []),
    ...(permits(input, 'knowledge.propose') ? captureLearningsSection() : []),
    ...(manual ? userManualSection(input) : []),
    ...(executing && permits(input, 'issue.status.write') && !designPendingOf(input) ? workflowSection(input, { manual }) : []),
    ...(permits(input, 'checklist.write') ? stageChecklistSection(input) : []),
    ...(permits(input, 'workflow.propose') ? workflowTemplatesSection() : []),
    ...(executing && permits(input, 'design.propose') ? designFirstSection(input) : []),
    '', '## Status Rules', '',
    ...(permits(input, 'issue.status.write') ? input.agentTransitions.map(t => `- \`${t.from}\` → \`${t.to}\``) : ['No status changes are authorized.']),
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

export type PromptInput = Pick<ClaimedRunV1, 'run' | 'issue' | 'triggers' | 'agent'> & Partial<Pick<ClaimedRunV1, 'knowledge'>>;

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

/**
 * NP-179: a `retrospective` run gets its role from the completion entry's task instructions (NP-125); this only
 * says what triggered it and, when the run can propose and sees the user manual, to check the manual first.
 */
function retrospectiveLines(input: PromptInput): string[] {
  const key = input.issue.identifier;
  const lines = [`${key} entered a done status; this run was triggered for its completion. Follow your task instructions.`];
  if (input.agent.capabilities?.includes('knowledge.propose') && hasUserManual(input))
    lines.push(`If you suggest knowledge updates, first check the user manual (\`${MANUAL_ROOT_SLUG}\` subtree, \`nocoproject kb list --tree\`): propose updates to the \`manual-*\` pages that ${key} made outdated before any other document.`);
  return lines;
}

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
    `It has ${files.length} attached file${files.length === 1 ? '' : 's'} (${names}): save them with \`nocoproject issue attachment download ${input.issue.identifier || input.issue.id}\` and open the printed paths.`,
  ];
}

function openingLines(input: PromptInput): string[] {
  const key = input.issue.identifier || input.issue.id;
  if (input.issue.conversation) {
    return [
      'You are assisting the asker in conversation ' + key + ' ' + JSON.stringify(input.issue.title) + '.',
      ...attachmentLines(input),
      'Run: ' + input.run.id + '. Conversation history: nocoproject issue comment list ' + key + ' --json.',
    ];
  }
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
  const key = input.issue.identifier || input.issue.id;

  const lines = [...(hasTrigger(input, 'designApproved') ? [DESIGN_APPROVED_OPENING] : []), ...openingLines(input)];
  let rootId: string | undefined;
  for (const trigger of input.triggers) {
    if (trigger.type === 'planExecuted' && trigger.plan) {
      rootId = trigger.comment?.rootId ?? rootId;
      lines.push(...planResultLines(trigger.plan));
    } else if (trigger.comment) {
      rootId = trigger.comment.rootId;
      lines.push(`[NEW COMMENT] from ${trigger.comment.authorName} (reply with --parent ${trigger.comment.rootId}):`);
      lines.push(quote(trigger.comment.content));
      if (input.issue.conversation) lines.push(...pageContextLines(trigger.comment.context));
    } else if (trigger.type === 'stageEntered') {
      lines.push(...stageEnteredLines(trigger, quote));
    } else if (trigger.type === 'signal') {
      lines.push(...signalLines(trigger, quote));
    } else if (trigger.type === 'retrospective') {
      lines.push(...retrospectiveLines(input));
    } else {
      const note = TRIGGER_NOTES[trigger.type];
      if (note) lines.push(note(key));
    }
  }
  lines.push(...approvedProposalLines(input, quote));
  lines.push(`Session: ${opts.resumed ? 'resumed' : 'fresh'}.`);
  if (input.issue.conversation && !opts.resumed) lines.push('This is a fresh tool session. First read the conversation history with nocoproject issue comment list ' + key + ' --json.');
  const parent = rootId ? ` --parent ${rootId}` : '';
  if (!input.agent.capabilities?.includes('comment.create')) {
    lines.push('No comment writing is authorized for this run. Follow the configured task instructions within your granted capabilities.');
  } else if (input.issue.conversation) {
    lines.push('Reply via nocoproject issue comment add ' + key + ' --content-file ./reply.md' + parent + '. Do not change the conversation status. Distinguish completed operations from plans awaiting human execution.');
  } else if (!input.agent.capabilities?.includes('issue.status.write')) {
    lines.push(`Reply via \`nocoproject issue comment add ${key} --content-file ./reply.md${parent}\`; you do not need to set \`in_review\` and never change the status.`);
  } else if (designPendingOf(input) && input.agent.capabilities?.includes('design.propose')) {
    lines.push(`Submit or revise the proposal with \`nocoproject issue design-proposal ${key} --content-file ./proposal.md\`, then set \`proposal_review\`; answer questions via \`nocoproject issue comment add ${key} --content-file ./reply.md${parent}\`. No code changes or pull requests before approval.`);
  } else if (executionModeOf(input) === 'session') {
    lines.push(`Reply briefly via \`nocoproject issue comment add ${key} --content-file ./reply.md${parent}\`; you do not need to set \`in_review\`.`);
  } else {
    lines.push(`When done, deliver via \`nocoproject issue comment add ${key} --content-file ./reply.md${parent}\`.`);
  }
  return lines.join('\n');
}
