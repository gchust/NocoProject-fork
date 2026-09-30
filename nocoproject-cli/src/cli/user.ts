/**
 * `nocoproject user …` (NP-86): the CLI user mode. Reads and writes issues as the person who ran `nocoproject login`,
 * through the browser API with their API key, so it can do exactly what that person can do in the UI. Refused inside
 * agent runs (`NOCOPROJECT_TOKEN`); the server labels the activities it writes `via: 'cli'`.
 */
import { readText, issueRef } from './input.js';
import type { Command } from 'commander';
import { z } from 'zod';
import { HttpError } from '../api/client.js';
import { loadConfig } from '../config.js';
import { describeStorage } from '../secrets/index.js';
import type { IssueDetailView, IssueListQuery, Page } from '../api/user-client.js';
import { DEFAULT_PROCESSES, type AgentListItem, type Comment, type CreateIssueRequestV1, type DefaultProcess, type InboxItem, type IssueListItemV1, type IssuePhase4Input, type IssuePriority, type Label, type ProjectListItem } from '../protocol.js';
import { CliError, EXIT, failAndExit, printJson, printLine } from './output.js';
import { action, type JsonOpt, splitList } from './run-token.js';
import { NameResolver, refuseInsideRun, userContext, type UserContext } from './user-context.js';
import { registerUserSkillCommand } from './user-skill.js';

const out = <T>(opts: JsonOpt, data: T, text: (d: T) => void): void => (opts.json ? printJson(data) : text(data));

/** Like `action`, but refuses inside an agent run before anything else happens. */
function userAction<A extends unknown[]>(fn: (ctx: UserContext, ...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return action(async (...args: A) => fn(await userContext(), ...args));
}

const PRIORITIES: readonly IssuePriority[] = ['urgent', 'high', 'medium', 'low', 'none'];
const STATUS_KEY = z.string().regex(/^[a-z][a-z0-9_]*$/, 'invalid status key');
const POSITIVE = (v: string) => z.coerce.number().int().positive().parse(v);

export interface UserIssuesOpts extends JsonOpt {
  mine?: boolean;
  owner?: string;
  project?: string;
  status?: string;
  label?: string;
  executor?: string;
  q?: string;
  limit?: number;
  cursor?: string;
}

/** Maps the flags to the `GET /np/issues` query. No filter at all means `--mine`. */
export async function userIssuesQuery(opts: UserIssuesOpts, names: NameResolver): Promise<IssueListQuery> {
  const filtered = Boolean(opts.owner || opts.project || opts.status || opts.label || opts.executor || opts.q);
  const owner = opts.mine || !filtered ? 'me' : opts.owner;
  return {
    ...(owner ? { ownerUserId: await names.user(owner) } : {}),
    ...(opts.project ? { projectId: await names.project(opts.project) } : {}),
    ...(opts.status ? { statusKey: STATUS_KEY.parse(opts.status) } : {}),
    ...(opts.label ? { labelId: await names.label(opts.label) } : {}),
    ...(opts.executor ? { executorId: await names.agent(opts.executor) } : {}),
    ...(opts.q ? { q: opts.q } : {}),
    ...(opts.limit ? { limit: opts.limit } : {}),
    ...(opts.cursor ? { cursor: opts.cursor } : {}),
  };
}

export interface UserCreateOpts extends JsonOpt {
  title: string;
  description?: string;
  descriptionFile?: string;
  project?: string;
  label?: string;
  executor?: string;
  owner?: string;
  priority?: string;
  status?: string;
  parent?: string;
  blockedBy?: string;
  process?: string;
}

/** Builds the `POST /np/issues` body; names become ids, and no `ownerUserId` unless `--owner` (the server defaults to you). */
export async function userCreateBody(opts: UserCreateOpts, names: NameResolver): Promise<CreateIssueRequestV1 & IssuePhase4Input> {
  const title = opts.title.trim();
  if (!title) throw new CliError('--title is empty', EXIT.validation, 'TITLE_REQUIRED');
  const description = readText(opts.description, opts.descriptionFile, 'description');
  if (opts.priority && !PRIORITIES.includes(opts.priority as IssuePriority)) {
    throw new CliError(`--priority must be one of ${PRIORITIES.join(', ')}`, EXIT.validation, 'INVALID_PRIORITY');
  }
  if (opts.process !== undefined && !DEFAULT_PROCESSES.includes(opts.process as DefaultProcess)) {
    throw new CliError(`--process must be one of ${DEFAULT_PROCESSES.join(', ')}`, EXIT.validation, 'INVALID_PROCESS');
  }
  const labels = splitList(opts.label);
  const blockedBy = splitList(opts.blockedBy);
  const executor = opts.executor?.trim();
  return {
    title,
    ...(description !== undefined ? { description } : {}),
    ...(opts.project ? { projectId: await names.project(opts.project) } : {}),
    ...(labels.length ? { labelIds: await Promise.all(labels.map((l) => names.label(l))) } : {}),
    ...(executor ? { executor: executor.toLowerCase() === 'none' ? { type: 'none' } : { type: 'agent', id: await names.agent(executor) } } : {}),
    ...(opts.owner ? { ownerUserId: await names.user(opts.owner) } : {}),
    ...(opts.priority ? { priority: opts.priority as IssuePriority } : {}),
    ...(opts.status ? { statusKey: STATUS_KEY.parse(opts.status) } : {}),
    ...(opts.parent ? { parentIssueId: opts.parent.trim() } : {}),
    ...(blockedBy.length ? { blockedBy } : {}),
    ...(opts.process !== undefined ? { process: opts.process as DefaultProcess } : {}),
  } as CreateIssueRequestV1 & IssuePhase4Input;
}

function printIssueRow(i: IssueListItemV1): void {
  const who = [i.ownerName ? `owner ${i.ownerName}` : '', i.executorName ? `executor ${i.executorName}` : '', i.projectName ? `project ${i.projectName}` : ''].filter(Boolean).join(', ');
  printLine(`${i.identifier}  [${i.statusKey}]  ${i.title}${who ? `  (${who})` : ''}`);
}

function printIssues(page: Page<IssueListItemV1>): void {
  if (page.data.length === 0) printLine('(no issues)');
  for (const i of page.data) printIssueRow(i);
  if (page.nextCursor) printLine(`more: --cursor ${page.nextCursor}`);
}

function printComments(comments: readonly Comment[]): void {
  if (comments.length === 0) return printLine('(no comments)');
  for (const c of comments) {
    printLine(`--- [${c.id}] ${c.authorName} (${c.authorType}) ${c.createdAt}${c.parentId ? ` ↳ reply in thread ${c.rootId}` : ''}`);
    printLine(c.content);
  }
}

function printDetail(d: IssueDetailView): void {
  const i = d.issue;
  printLine(`${i.identifier}  ${i.title}`);
  printLine(`status: ${i.statusKey}   priority: ${i.priority}   owner: ${i.ownerName ?? '-'}   executor: ${i.executorName ?? '-'}${i.projectName ? `   project: ${i.projectName}` : ''}`);
  if (i.labels?.length) printLine(`labels: ${i.labels.map((l) => l.name).join(', ')}`);
  printLine();
  printLine(i.description?.trim() || '(no description)');
  printLine();
  printComments(d.comments);
  if (d.commentsNextCursor || d.commentsOmitted) printLine('(older comments not shown: --comments all)');
}

function printInbox(page: Page<InboxItem>): void {
  if (page.data.length === 0) printLine('(nothing waiting)');
  for (const item of page.data) {
    printLine(`[${item.kind}/${item.type}] ${item.issueIdentifier ? `${item.issueIdentifier} ` : ''}${item.title}${item.readAt ? '' : '  (unread)'}`);
  }
  if (page.nextCursor) printLine(`more: --cursor ${page.nextCursor}`);
}

const printNamed =
  <T extends { id: string; name: string }>(empty: string, extra: (item: T) => string = () => '') =>
  (items: readonly T[]): void => {
    if (items.length === 0) return printLine(empty);
    for (const item of items) printLine(`${item.name}  (${item.id}${extra(item)})`);
  };

/** The detail with its comments cut to the last `limit` (`all`: older pages fetched first). */
async function issueWithComments(ctx: UserContext, ref: string, limit: number | 'all'): Promise<IssueDetailView> {
  const detail = await ctx.api.issue(ref);
  let comments = [...(detail.comments ?? [])];
  let cursor = detail.commentsNextCursor ?? null;
  if (limit === 'all') {
    while (cursor) {
      const older = await ctx.api.comments(detail.issue.id, cursor);
      comments = [...older.data, ...comments];
      cursor = older.nextCursor;
    }
  }
  const omitted = limit === 'all' ? 0 : Math.max(0, comments.length - limit);
  if (omitted > 0) comments = comments.slice(-limit);
  return { ...detail, comments, commentsNextCursor: cursor, ...(omitted > 0 ? { commentsOmitted: omitted } : {}) };
}

/** GET for the current revision, then PATCH; a concurrent change (409 `REVISION_CONFLICT`) is retried once. */
async function changeStatus(ctx: UserContext, ref: string, statusKey: string) {
  for (let attempt = 0; ; attempt++) {
    const { issue } = await ctx.api.issue(ref);
    try {
      return await ctx.api.setStatus(issue.id, statusKey, issue.revision);
    } catch (error) {
      if (attempt === 0 && error instanceof HttpError && error.code === 'REVISION_CONFLICT') continue;
      throw error;
    }
  }
}

export function registerUserCommands(program: Command): void {
  const user = program
    .command('user')
    .description('Act as yourself with the API key saved by `nocoproject login` (terminal and local agents; refused inside agent runs)')
    // Every subcommand, present and future, is refused inside a run before its action starts.
    .hook('preAction', (_cmd, actionCmd) => {
      try {
        refuseInsideRun();
      } catch (error) {
        failAndExit(error, Boolean((actionCmd.optsWithGlobals() as JsonOpt).json));
      }
    });

  user
    .command('whoami')
    .description('Who the saved API key belongs to, the server, and where the key is stored')
    .option('--json', 'JSON output')
    .action(
      userAction(async (ctx, opts: JsonOpt) => {
        const me = await ctx.api.me();
        const where = describeStorage(ctx.keyStorage, loadConfig().home);
        out(opts, { userId: me.userId, name: me.name, serverUrl: ctx.serverUrl, keyStorage: ctx.keyStorage }, (d) =>
          printLine(`${d.name} (${d.userId}) on ${d.serverUrl} — key ${ctx.keyStorage === 'env' ? 'from' : 'in'} ${where}`),
        );
      }),
    );

  user
    .command('issues')
    .description('List issues ({ data, nextCursor }); without filters: the issues you own')
    .option('--mine', 'only issues you own (the default when no other filter is given)')
    .option('--owner <user>', '`me` or a user id')
    .option('--project <project>', 'project name or id')
    .option('--status <key>', 'status key, e.g. in_progress')
    .option('--label <label>', 'label name or id')
    .option('--executor <agent>', 'agent name or id')
    .option('--q <text>', 'search title and description')
    .option('--limit <n>', 'page size (server default 50, max 100)', (v) => z.coerce.number().int().positive().max(100).parse(v))
    .option('--cursor <cursor>', 'next page (nextCursor of the previous page)')
    .option('--json', 'JSON output')
    .action(
      userAction(async (ctx, opts: UserIssuesOpts) => {
        const query = await userIssuesQuery(opts, new NameResolver(ctx.api));
        out(opts, await ctx.api.issues(query), printIssues);
      }),
    );

  user
    .command('issue <issue>')
    .description('One issue with its comments')
    .option('--comments <n>', 'how many of the latest comments, or `all`', '50')
    .option('--json', 'JSON output (the whole detail)')
    .action(
      userAction(async (ctx, ref: string, opts: JsonOpt & { comments: string }) => {
        const limit = opts.comments === 'all' ? 'all' : POSITIVE(opts.comments);
        out(opts, await issueWithComments(ctx, issueRef(ref), limit), printDetail);
      }),
    );

  user
    .command('inbox')
    .description('Your inbox ({ data, nextCursor }); by default only items not yet resolved')
    .option('--kind <kind>', '`decision` or `info`')
    .option('--all', 'include resolved items')
    .option('--cursor <cursor>', 'next page')
    .option('--json', 'JSON output')
    .action(
      userAction(async (ctx, opts: JsonOpt & { kind?: string; all?: boolean; cursor?: string }) => {
        const page = await ctx.api.inbox({ kind: opts.kind, cursor: opts.cursor, resolved: opts.all ? undefined : false });
        out(opts, page, printInbox);
      }),
    );

  user
    .command('create')
    .description('Create an issue; you are the owner unless --owner says otherwise')
    .requiredOption('--title <title>', 'title')
    .option('--description-file <path>', 'Markdown description from a file (preferred)')
    .option('--description <text>', 'inline Markdown description')
    .option('--project <project>', 'project name or id')
    .option('--label <labels>', 'comma-separated label names or ids')
    .option('--executor <agent>', 'agent name or id, or `none`')
    .option('--owner <user>', '`me` (default) or a user id')
    .option('--priority <priority>', PRIORITIES.join(' | '))
    .option('--status <key>', 'initial status key (default todo)')
    .option('--parent <issue>', 'parent issue id or identifier')
    .option('--blocked-by <issues>', 'comma-separated issue ids or identifiers')
    .option('--process <process>', '`direct` (execute right away), `design_first` (proposal first) or `auto` (classifier); default: workspace setting')
    .option('--json', 'JSON output')
    .action(
      userAction(async (ctx, opts: UserCreateOpts) => {
        const issue = await ctx.api.createIssue(await userCreateBody(opts, new NameResolver(ctx.api)));
        out(opts, issue, (i) => printLine(`created ${i.identifier}  ${i.title}`));
      }),
    );

  user
    .command('comment <issue>')
    .description('Post a comment as yourself (mentions work as in the UI)')
    .option('--content-file <path>', 'Markdown body from a file (preferred)')
    .option('--content <text>', 'inline Markdown body')
    .option('--parent <commentId>', 'reply inside this thread')
    .option('--json', 'JSON output')
    .action(
      userAction(async (ctx, ref: string, opts: JsonOpt & { content?: string; contentFile?: string; parent?: string }) => {
        const content = readText(opts.content, opts.contentFile, 'content');
        if (!content?.trim()) throw new CliError('pass --content-file or --content with a non-empty body', EXIT.validation, 'EMPTY_CONTENT');
        out(opts, await ctx.api.addComment(issueRef(ref), content, opts.parent), () => printLine('comment posted'));
      }),
    );

  user
    .command('status <issue> <statusKey>')
    .description('Change the status as yourself; an approval gate answers "approval pending" (exit 0)')
    .option('--json', 'JSON output')
    .action(
      userAction(async (ctx, ref: string, key: string, opts: JsonOpt) => {
        const statusKey = STATUS_KEY.parse(key);
        const result = await changeStatus(ctx, issueRef(ref), statusKey);
        if (result.kind === 'pending') {
          out(opts, result.data, (d) => printLine(`approval pending (request ${d?.pendingApproval?.id ?? 'unknown'})`));
          return;
        }
        out(opts, result.data ?? { ok: true, statusKey }, () => printLine(`status set to ${statusKey}`));
      }),
    );

  user
    .command('projects')
    .description('Projects you can see (names and ids for --project)')
    .option('--json', 'JSON output')
    .action(userAction(async (ctx, opts: JsonOpt) => out(opts, await ctx.api.projects(), printNamed<ProjectListItem>('(no projects)', (p) => (p.status ? `, ${p.status}` : '')))));

  user
    .command('labels')
    .description('Labels (names and ids for --label; labels are workspace-wide)')
    .option('--json', 'JSON output')
    .action(userAction(async (ctx, opts: JsonOpt) => out(opts, await ctx.api.labels(), printNamed<Label>('(no labels)'))));

  user
    .command('agents')
    .description('Agents you can see (names and ids for --executor)')
    .option('--json', 'JSON output')
    .action(userAction(async (ctx, opts: JsonOpt) => out(opts, await ctx.api.agents(), printNamed<AgentListItem>('(no agents)', (a) => `, ${a.runtimeOnline ? 'online' : 'offline'}`))));

  registerUserSkillCommand(user);
}
