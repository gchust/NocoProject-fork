/**
 * `nocoproject workflow list | get | propose` (NP-77 stage 2): read the workflow templates and propose a
 * whole new definition for one (or for a copy of one). Agents never change a template directly: a
 * proposal goes to the owner/admins' inbox and takes effect once accepted. Run-token mode.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { AgentWorkflowListItem, AgentWorkflowProposalRequest, WorkflowDiff, WorkflowProposal } from '../protocol.js';
import { WORKFLOW_REASON_MAX, WORKFLOW_TEMPLATE_NAME_MAX } from '../protocol.js';
import { CliError, EXIT, printJson, printLine } from './output.js';
import { action, type JsonOpt, runTokenContext } from './run-token.js';

export interface WorkflowProposeOpts extends JsonOpt {
  definitionFile?: string;
  reason?: string;
  name?: string;
  copyFrom?: string;
}

function flags(item: AgentWorkflowListItem): string {
  const parts = [`rev ${item.revision}`];
  if (item.isSystem) parts.push('system: copy only');
  if (item.isDefault) parts.push('default');
  parts.push(`${item.projectCount} project${item.projectCount === 1 ? '' : 's'}`);
  return parts.join(', ');
}

function describeTemplate(item: AgentWorkflowListItem): string {
  return `${item.id}  ${item.name}  (${flags(item)})${item.usedByRunProject ? '  ← this run’s project' : ''}`;
}

function printTemplate(item: AgentWorkflowListItem): void {
  printLine(describeTemplate(item));
  printLine();
  printLine('statuses:');
  for (const s of item.definition.statuses) {
    const actions = (s.onEnter ?? []).map((a) => a.type).join(', ');
    printLine(`  ${s.key}  ${s.name}  [${s.category}]${s.builtIn ? ' built-in' : ''}${actions ? `  onEnter: ${actions}` : ''}`);
  }
  printLine(`transitions: ${item.definition.transitions.length}`);
  printLine();
  printLine(`Print the definition to edit with: nocoproject workflow get ${item.id} --definition > wf.json`);
}

/** Reads the definition JSON; a whole template (`workflow get --json`) is unwrapped to its `definition`. */
export function readDefinition(file: string | undefined): unknown {
  if (!file) throw new CliError('--definition-file is required', EXIT.validation, 'DEFINITION_REQUIRED');
  const path = resolve(file);
  if (!existsSync(path)) throw new CliError(`definition file not found: ${path}`, EXIT.validation, 'FILE_NOT_FOUND');
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new CliError(`definition file is not valid JSON: ${(error as Error).message}`, EXIT.validation, 'INVALID_JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError('the definition must be a JSON object', EXIT.validation, 'INVALID_JSON');
  const record = value as Record<string, unknown>;
  return !('statuses' in record) && record.definition && typeof record.definition === 'object' ? record.definition : value;
}

/** Validates the flags and builds the request body. Exactly one of `<template>` / `--copy-from`; `--name` required with `--copy-from`. */
export function proposalRequest(template: string | undefined, opts: WorkflowProposeOpts): AgentWorkflowProposalRequest {
  const templateId = template?.trim();
  const copyFrom = opts.copyFrom?.trim();
  if (Boolean(templateId) === Boolean(copyFrom)) throw new CliError('pass exactly one of <template> (change it) or --copy-from <template> (create a copy)', EXIT.validation, 'INVALID_ARGUMENTS');
  const name = opts.name?.trim();
  if (copyFrom && !name) throw new CliError('--name is required with --copy-from', EXIT.validation, 'NAME_REQUIRED');
  if (name && name.length > WORKFLOW_TEMPLATE_NAME_MAX) throw new CliError(`--name is longer than ${WORKFLOW_TEMPLATE_NAME_MAX} characters`, EXIT.validation, 'NAME_TOO_LONG');
  const reason = opts.reason?.trim();
  if (!reason) throw new CliError('--reason is required: say why the workflow should change', EXIT.validation, 'REASON_REQUIRED');
  if (reason.length > WORKFLOW_REASON_MAX) throw new CliError(`--reason is longer than ${WORKFLOW_REASON_MAX} characters`, EXIT.validation, 'REASON_TOO_LONG');
  const definition = readDefinition(opts.definitionFile);
  return { ...(templateId ? { templateId } : { copyFrom }), ...(name ? { name } : {}), definition, reason };
}

/** One line per kind of change in the diff. */
export function diffLines(diff: WorkflowDiff): string[] {
  const keys = (list: readonly { key: string }[]) => list.map((s) => s.key).join(', ');
  const pairs = (list: readonly { from: string; to: string }[]) => list.map((t) => `${t.from}→${t.to}`).join(', ');
  const lines: string[] = [];
  if (diff.name) lines.push(`name: ${diff.name.from} → ${diff.name.to}`);
  if (diff.statuses.added.length) lines.push(`statuses added: ${keys(diff.statuses.added)}`);
  if (diff.statuses.removed.length) lines.push(`statuses removed: ${keys(diff.statuses.removed)}`);
  if (diff.statuses.changed.length) lines.push(`statuses renamed/recoloured: ${keys(diff.statuses.changed)}`);
  if (diff.statuses.order) lines.push('status order changed');
  if (diff.transitions.added.length) lines.push(`transitions added: ${pairs(diff.transitions.added)}`);
  if (diff.transitions.removed.length) lines.push(`transitions removed: ${pairs(diff.transitions.removed)}`);
  if (diff.transitions.changed.length) lines.push(`transitions changed: ${pairs(diff.transitions.changed)}`);
  for (const a of diff.actions) lines.push(`actions of ${a.statusKey}: +${a.added.length} −${a.removed.length}`);
  for (const r of diff.runExecutorAgents) lines.push(`entering ${r.statusKey} runs agent ${r.agentName ?? r.agentId}${r.isNew ? ' (new)' : ''}`);
  if (diff.childBatchDoneWakesParentExecutor) lines.push(`childBatchDoneWakesParentExecutor: ${diff.childBatchDoneWakesParentExecutor.from} → ${diff.childBatchDoneWakesParentExecutor.to}`);
  return lines.length ? lines : ['(no changes)'];
}

function describeProposal(p: WorkflowProposal): string[] {
  const target = p.kind === 'copy' ? `a new template "${p.name ?? ''}" copied from ${p.copyFromName ?? p.copyFromId ?? '?'}` : `a change to ${p.templateName ?? p.templateId ?? '?'} (base revision ${p.baseRevision})`;
  return [`proposed ${target} (proposal ${p.id}, ${p.status}); an owner/admin decides whether to apply it`, ...diffLines(p.diff).map((line) => `  ${line}`)];
}

export function registerWorkflowCommands(program: Command): void {
  const wf = program.command('workflow').description('Workflow templates: read them and propose changes a human accepts (run-token mode)');

  wf.command('list')
    .description('List the workflow templates (the one of this run’s project is marked)')
    .option('--json', 'JSON output')
    .action(
      action(async (opts: JsonOpt) => {
        const data = (await runTokenContext().api.workflows()) ?? [];
        if (opts.json) return printJson(data);
        if (data.length === 0) return printLine('(no workflow templates)');
        for (const item of data) printLine(describeTemplate(item));
      }),
    );

  wf.command('get [template]')
    .description('Show a template (defaults to the one this run’s project uses)')
    .option('--definition', 'print only the definition JSON (the file to edit for `workflow propose`)')
    .option('--json', 'JSON output (the whole template)')
    .action(
      action(async (ref: string | undefined, opts: JsonOpt & { definition?: boolean }) => {
        const api = runTokenContext().api;
        let id = ref?.trim();
        if (!id) {
          const current = (await api.workflows()).find((item) => item.usedByRunProject);
          if (!current) throw new CliError('no template is marked as this run’s project template; pass a template id', EXIT.notFound, 'WORKFLOW_NOT_FOUND');
          id = current.id;
        }
        const item = await api.workflow(id);
        if (opts.definition) return printJson(item.definition);
        if (opts.json) return printJson(item);
        printTemplate(item);
      }),
    );

  wf.command('propose [template]')
    .description('Propose a whole new definition for a template, or for a copy (--copy-from); an owner/admin decides')
    .option('--definition-file <path>', 'the full proposed definition (JSON; start from `workflow get <id> --definition`)')
    .option('--reason <text>', `why it should change (at most ${WORKFLOW_REASON_MAX} characters)`)
    .option('--name <name>', 'the new name (required with --copy-from)')
    .option('--copy-from <template>', 'create a new template from this one (system templates can only be copied)')
    .option('--json', 'JSON output')
    .action(
      action(async (template: string | undefined, opts: WorkflowProposeOpts) => {
        const body = proposalRequest(template, opts);
        const proposal = await runTokenContext().api.proposeWorkflow(body);
        if (opts.json) return printJson(proposal);
        for (const line of describeProposal(proposal)) printLine(line);
      }),
    );
}
