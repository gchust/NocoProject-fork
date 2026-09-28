/**
 * `nocoproject issue checklist [issue] [check|uncheck <item>]` (NP-77 §6): show the workflow stage
 * checklists of an issue, or check / uncheck an item. The item is `<itemKey>` (of the current status's
 * checklist, or `--status`) or `<statusKey>/<itemKey>`. Writes only work on the run's own issue.
 */
import type { Command } from 'commander';
import type { IssueChecklist } from '../protocol.js';
import { CliError, EXIT, printJson, printLine } from './output.js';
import { action, type JsonOpt, resolveIssueId, runTokenContext } from './run-token.js';

const OPS = new Set(['check', 'uncheck']);

export interface ChecklistArgs {
  readonly issue?: string;
  readonly op?: 'check' | 'uncheck';
  readonly item?: string;
}

/** `checklist [issue] [op] [item]`: the issue may be omitted before `check` / `uncheck`. */
export function parseChecklistArgs(args: readonly (string | undefined)[]): ChecklistArgs {
  const [a, b, c] = args;
  const [issue, op, item] = a && OPS.has(a) ? [undefined, a, b] : [a, b, c];
  if (op !== undefined && !OPS.has(op)) throw new CliError(`unknown action "${op}": use check or uncheck`, EXIT.validation, 'INVALID_ARGUMENTS');
  if (op && !item) throw new CliError(`${op} needs an item: <itemKey> or <statusKey>/<itemKey>`, EXIT.validation, 'ITEM_REQUIRED');
  return { ...(issue ? { issue } : {}), ...(op ? { op: op as 'check' | 'uncheck' } : {}), ...(item ? { item } : {}) };
}

function printChecklists(lists: readonly IssueChecklist[]): void {
  if (lists.length === 0) return printLine('(no checklists)');
  for (const list of lists) {
    printLine(`${list.statusKey}${list.current ? ' (current)' : ''}  ${list.complete ? 'complete' : 'required items open'}`);
    for (const item of list.items) printLine(`  [${item.checked ? 'x' : ' '}] ${item.itemKey}  ${item.label}${item.required ? '  (required)' : ''}`);
  }
}

export function registerChecklistCommand(issue: Command): void {
  issue
    .command('checklist [issue] [action] [item]')
    .description('Show the workflow stage checklists, or `checklist [issue] check|uncheck <item>` (item: <itemKey> or <statusKey>/<itemKey>)')
    .option('--status <statusKey>', 'the checklist’s status (defaults to the current status)')
    .option('--json', 'JSON output')
    .action(
      action(async (a: string | undefined, b: string | undefined, c: string | undefined, opts: JsonOpt & { status?: string }) => {
        const args = parseChecklistArgs([a, b, c]);
        const ctx = runTokenContext();
        const id = await resolveIssueId(args.issue, ctx);
        if (!args.op || !args.item) {
          const lists = (await ctx.api.checklists(id)) ?? [];
          if (opts.json) return printJson(lists);
          return printChecklists(lists);
        }
        const slash = args.item.indexOf('/');
        let statusKey = slash > 0 ? args.item.slice(0, slash) : opts.status?.trim();
        const itemKey = slash > 0 ? args.item.slice(slash + 1) : args.item;
        if (!statusKey) {
          const current = (await ctx.api.checklists(id)).find((list) => list.current);
          if (!current) throw new CliError('the current status has no checklist; pass --status or <statusKey>/<itemKey>', EXIT.notFound, 'CHECKLIST_NOT_FOUND');
          statusKey = current.statusKey;
        }
        const list = await ctx.api.setChecklistItem(id, statusKey, itemKey, args.op === 'check');
        if (opts.json) return printJson(list);
        const required = list.items.filter((item) => item.required);
        printLine(`${args.op === 'check' ? 'checked' : 'unchecked'} ${statusKey}/${itemKey} (${required.filter((item) => item.checked).length}/${required.length} required items checked)`);
      }),
    );
}
