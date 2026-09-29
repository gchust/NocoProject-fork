/**
 * nocoproject-echo-agent: a scripted stand-in for a coding agent, used in automated e2e tests.
 *
 * Reads the per-turn prompt from argv, then does what a real agent is told to do, using the
 * real CLI in run-token mode: `issue get`, `issue status in_progress`, write reply.md,
 * `issue comment add --content-file reply.md [--parent <rootId>]`, `issue status in_review`.
 * Prints NDJSON events (text / tool_use / tool_result / result) on stdout.
 *
 * Test directives may appear in the issue title or description:
 *   [echo:sleep=<ms>]   pause before replying (to test cancellation / watchdogs)
 *   [echo:fail=<text>]  print <text> to stderr and exit 1 (to test failure classification)
 *   [echo:subtasks=<n>] create n sub-issues with `issue create --executor self --stage <i>` and keep
 *                       the parent in_progress (as the brief tells a coordinating agent to). On a later
 *                       turn the sub-issues already exist, so the agent does not split again: it writes
 *                       in_review once every child is done, otherwise it keeps waiting.
 *   [echo:checkout=<url>] run `repo checkout <url> --json`, write a file in the worktree and commit it
 *   [echo:pr=<url>]     run `pr link <url> --json` (iteration 2 §C)
 *   [echo:status=<key>] run `issue status <issue> <key>` instead of the usual in_review; a 202 "approval
 *                       pending" answer counts as success (iteration 2 §D)
 *   [echo:env=<NAME>]   write `NAME=<value>` of that environment variable into the reply and a text event,
 *                       to check env injection and redaction (iteration 2 §G)
 *   [echo:skill=<slug>] write the first body line of `.nocoproject/skills/<slug>/SKILL.md` (after the front
 *                       matter) into the reply (iteration 2 §H)
 *   [echo:kb=<slug>]    run `kb get <slug>` and write the document's first non-empty line into the reply
 *                       (iteration 3 §I)
 *   [echo:kb-propose=<title>] write kb.md and run `kb propose --title <title> --content-file kb.md --reason ...`
 *                       (iteration 3 §I)
 *
 *   [echo:design]       design first (iteration 4 §B): unless context.json has `issue.designApprovedAt`, move
 *                       todo → analysis, write proposal.md, run `issue design-proposal <issue> --content-file
 *                       proposal.md`, set `proposal_review` and stop (no in_progress, no in_review, no reply)
 *   [echo:pm=<question>] run `pm issues --json` and write `PM <question>: <n> issues` into the reply (§C)
 *
 * In session mode (`issue.executionMode` in context.json) the agent never moves the issue to in_review; a
 * agent without `issue.status.write` never changes the status.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let callSeq = 0;

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

interface CliResult {
  readonly ok: boolean;
  readonly json: unknown;
  readonly output: string;
}

function cli(args: string[]): CliResult {
  const id = `call_${++callSeq}`;
  emit({ type: 'tool_use', id, name: 'shell', input: { command: `nocoproject ${args.join(' ')}` } });
  const cliPath = process.env.NOCOPROJECT_CLI_PATH;
  const proc = cliPath
    ? spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', env: process.env })
    : spawnSync('nocoproject', args, { encoding: 'utf8', env: process.env });
  const output = `${proc.stdout ?? ''}${proc.stderr ?? ''}`.trim();
  const ok = proc.status === 0;
  emit({ type: 'tool_result', id, output: output.slice(0, 4000), is_error: !ok });
  let json: unknown = undefined;
  try {
    json = JSON.parse(proc.stdout ?? '');
  } catch {
    json = undefined;
  }
  return { ok, json, output };
}

function shell(command: string, args: string[], cwd: string): CliResult {
  const id = `call_${++callSeq}`;
  emit({ type: 'tool_use', id, name: 'shell', input: { command: `${command} ${args.join(' ')}` } });
  const proc = spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env });
  const output = `${proc.stdout ?? ''}${proc.stderr ?? ''}`.trim();
  const ok = proc.status === 0;
  emit({ type: 'tool_result', id, output: output.slice(0, 4000), is_error: !ok });
  return { ok, json: undefined, output };
}

interface ChildSummary {
  readonly identifier?: string;
  readonly statusKey?: string;
}

/** The existing sub-issues of `issueKey`, via `issue children --json`. */
function listChildren(issueKey: string): ChildSummary[] {
  const r = cli(['issue', 'children', issueKey, '--json']);
  if (!r.ok) fail(`echo agent: issue children failed: ${r.output}`);
  const data = r.json as ChildSummary[] | { children?: ChildSummary[]; data?: ChildSummary[] } | undefined;
  if (Array.isArray(data)) return data;
  return data?.children ?? data?.data ?? [];
}

const TERMINAL = new Set(['done', 'closed', 'cancelled', 'canceled']);

/** Creates `count` staged sub-issues executed by this agent. Returns their identifiers. */
function createSubtasks(issueKey: string, count: number): string[] {
  const created: string[] = [];
  for (let i = 1; i <= count; i++) {
    const r = cli(['issue', 'create', '--title', `Part ${i} of ${issueKey}`, '--description', `Created by the echo agent for ${issueKey}.`, '--executor', 'self', '--stage', String(i), '--json']);
    if (!r.ok) fail(`echo agent: issue create failed: ${r.output}`);
    const data = r.json as { identifier?: string; id?: string; issue?: { identifier?: string; id?: string } } | undefined;
    const issue = data?.issue ?? data;
    created.push(issue?.identifier ?? issue?.id ?? `sub-${i}`);
  }
  return created;
}

/** Checks out `url`, writes a file on the agent branch and commits it. Returns the branch. */
function checkoutAndCommit(issueKey: string, url: string): string {
  const r = cli(['repo', 'checkout', url, '--json']);
  if (!r.ok) fail(`echo agent: repo checkout failed: ${r.output}`);
  const rec = r.json as { path: string; branchName: string };
  const runId = process.env.NOCOPROJECT_RUN_ID ?? 'run';
  writeFileSync(join(rec.path, `echo-${runId}.md`), `Echo agent was here for ${issueKey} (run ${runId}).\n`);
  if (!shell('git', ['add', '-A'], rec.path).ok) fail('echo agent: git add failed');
  const commit = shell('git', ['commit', '-q', '-m', `${issueKey}: echo agent change (run ${runId})`], rec.path);
  if (!commit.ok) fail(`echo agent: git commit failed: ${commit.output}`);
  return rec.branchName;
}

function workDir(): string {
  return process.env.NOCOPROJECT_WORKDIR ?? process.cwd();
}

interface EchoContext {
  readonly issue?: { readonly executionMode?: string; readonly designApprovedAt?: string | null };
  readonly agent?: { readonly kind?: string; readonly capabilities?: readonly string[] };
}

/** The daemon's context.json (`{}` when missing or unreadable). */
function runContext(): EchoContext {
  try {
    return JSON.parse(readFileSync(join(workDir(), '.nocoproject', 'context.json'), 'utf8')) as EchoContext;
  } catch {
    return {};
  }
}

/** Design first: analysis → proposal → proposal_review. Returns the proposal comment id. */
function proposeDesign(issueKey: string, title: string, status: string | undefined): string {
  if (status === 'todo') {
    const moved = cli(['issue', 'status', issueKey, 'analysis', '--json']);
    if (!moved.ok) fail(`echo agent: status analysis failed: ${moved.output}`);
  }
  const file = join(process.cwd(), 'proposal.md');
  writeFileSync(file, [`## 需求理解`, `${title}`, '', '## 方案', 'Echo the request.', '', '## 影响范围', 'None.', '', '## 风险与待定', 'None.', '', '## 验证计划', 'Run the tests.', ''].join('\n'));
  const r = cli(['issue', 'design-proposal', issueKey, '--content-file', file, '--json']);
  if (!r.ok) fail(`echo agent: issue design-proposal failed: ${r.output}`);
  const review = cli(['issue', 'status', issueKey, 'proposal_review', '--json']);
  if (!review.ok) fail(`echo agent: status proposal_review failed: ${review.output}`);
  return (r.json as { id?: string } | undefined)?.id ?? '?';
}

/** `pm issues --json` → the number of issues on the first page. */
function pmIssueCount(): number {
  const r = cli(['pm', 'issues', '--json']);
  if (!r.ok) fail(`echo agent: pm issues failed: ${r.output}`);
  return ((r.json as { data?: unknown[] } | undefined)?.data ?? []).length;
}

function finish(summary: string, inputTokens: number, outputTokens: number): void {
  emit({ type: 'text', text: summary });
  emit({ type: 'result', session_id: `echo-${process.env.NOCOPROJECT_RUN_ID ?? 'session'}`, text: summary, usage: { inputTokens, outputTokens } });
}

/** First non-empty line of a skill's SKILL.md body (front matter skipped). */
function skillFirstLine(slug: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(slug)) return '(invalid slug)';
  const path = join(workDir(), '.nocoproject', 'skills', slug, 'SKILL.md');
  if (!existsSync(path)) return '(not found)';
  let lines = readFileSync(path, 'utf8').split(/\r?\n/);
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    lines = end > 0 ? lines.slice(end + 1) : lines;
  }
  return lines.find((l) => l.trim())?.trim() ?? '(empty)';
}

/** `kb get <slug>` → the document's first non-empty line. */
function kbFirstLine(slug: string): string {
  const r = cli(['kb', 'get', slug]);
  if (!r.ok) fail(`echo agent: kb get failed: ${r.output}`);
  return r.output.split(/\r?\n/).find((l) => l.trim())?.trim() ?? '(empty)';
}

/** Proposes a new knowledge document titled `title`; returns the proposal id. */
function kbPropose(issueKey: string, title: string): string {
  const file = join(process.cwd(), 'kb.md');
  writeFileSync(file, `# ${title}\n\nLearned by the echo agent while working on ${issueKey}.\n`);
  const r = cli(['kb', 'propose', '--title', title, '--content-file', file, '--reason', `Found while working on ${issueKey}.`, '--json']);
  if (!r.ok) fail(`echo agent: kb propose failed: ${r.output}`);
  return (r.json as { id?: string } | undefined)?.id ?? '?';
}

function directive(text: string, name: string): string | undefined {
  return text.match(new RegExp(`\\[echo:${name}=([^\\]]*)\\]`))?.[1];
}

function fail(message: string): never {
  emit({ type: 'error', message });
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const prompt = process.argv[2] ?? '';
  const issueKey = process.env.NOCOPROJECT_ISSUE_KEY ?? process.env.NOCOPROJECT_ISSUE_ID;
  if (!issueKey || !process.env.NOCOPROJECT_TOKEN) fail('echo agent: run-token environment is missing');
  emit({ type: 'text', text: `Echo agent received a ${prompt.length}-character prompt for ${issueKey}.` });

  const got = cli(['issue', 'get', issueKey, '--json']);
  if (!got.ok) fail(`echo agent: issue get failed: ${got.output}`);
  const issue = got.json as { identifier?: string; title?: string; description?: string; statusKey?: string };
  const text = `${issue.title ?? ''}\n${issue.description ?? ''}`;

  const failWith = directive(text, 'fail');
  if (failWith) fail(failWith);
  const sleepMs = Number(directive(text, 'sleep') ?? 0);
  if (sleepMs > 0) {
    emit({ type: 'text', text: `Sleeping ${sleepMs}ms as requested.` });
    await new Promise((r) => setTimeout(r, sleepMs));
  }

  const ctx = runContext();
  const manager = !ctx.agent?.capabilities?.includes('issue.status.write');
  let status = issue.statusKey;
  if (text.includes('[echo:design]') && !ctx.issue?.designApprovedAt) {
    const commentId = proposeDesign(issueKey, issue.title ?? '', status);
    return finish(`Echo agent submitted a design proposal (comment ${commentId}) on ${issue.identifier ?? issueKey}.`, prompt.length, 0);
  }
  if (!manager && (status === 'todo' || status === 'blocked')) {
    const moved = cli(['issue', 'status', issueKey, 'in_progress', '--json']);
    if (!moved.ok) fail(`echo agent: status in_progress failed: ${moved.output}`);
    status = 'in_progress';
  }

  const extra: string[] = [];
  const checkoutUrl = directive(text, 'checkout');
  if (checkoutUrl) extra.push(`Committed on branch ${checkoutAndCommit(issueKey, checkoutUrl)}.`);
  const envName = directive(text, 'env');
  if (envName && /^[A-Z_][A-Z0-9_]*$/.test(envName)) {
    const line = `Env ${envName}=${process.env[envName] ?? '(unset)'}`;
    emit({ type: 'text', text: line });
    extra.push(line);
  }
  const skillSlug = directive(text, 'skill');
  if (skillSlug) extra.push(`Skill ${skillSlug}: ${skillFirstLine(skillSlug)}`);
  const kbSlug = directive(text, 'kb');
  if (kbSlug) extra.push(`KB ${kbSlug}: ${kbFirstLine(kbSlug)}`);
  const pmQuestion = directive(text, 'pm');
  if (pmQuestion !== undefined) extra.push(`PM ${pmQuestion}: ${pmIssueCount()} issues`);
  const kbTitle = directive(text, 'kb-propose');
  if (kbTitle) extra.push(`Proposed knowledge "${kbTitle}" (proposal ${kbPropose(issueKey, kbTitle)}).`);
  const prUrl = directive(text, 'pr');
  if (prUrl) {
    const linked = cli(['pr', 'link', prUrl, '--json']);
    if (!linked.ok) fail(`echo agent: pr link failed: ${linked.output}`);
    extra.push(`Linked pull request ${prUrl}.`);
  }
  const statusKey = directive(text, 'status');
  if (statusKey) {
    const changed = cli(['issue', 'status', issueKey, statusKey]);
    if (!changed.ok) fail(`echo agent: status ${statusKey} failed: ${changed.output}`);
    if (changed.output.startsWith('status set to')) status = statusKey;
    extra.push(`Status ${statusKey}: ${changed.output}.`);
  }
  const subtaskCount = Number(directive(text, 'subtasks') ?? 0);
  let coordinating = false;
  if (subtaskCount > 0) {
    const existing = listChildren(issueKey);
    if (existing.length === 0) {
      extra.push(`Created sub-issues: ${createSubtasks(issueKey, subtaskCount).join(', ')}.`);
      coordinating = true;
    } else if (existing.some((c) => !TERMINAL.has(c.statusKey ?? ''))) {
      extra.push(`Waiting on sub-issues: ${existing.map((c) => `${c.identifier ?? '?'} (${c.statusKey ?? '?'})`).join(', ')}.`);
      coordinating = true;
    } else {
      extra.push(`All ${existing.length} sub-issues are done; handing the parent over for review.`);
    }
  }

  const parent = prompt.match(/--parent\s+([A-Za-z0-9_-]+)/)?.[1];
  const trigger = prompt.match(/^> (.*)$/m)?.[1];
  const reply = [
    `Echo agent report: handled ${issue.identifier ?? issueKey} "${issue.title ?? ''}".`,
    '',
    trigger ? `You said: ${trigger}` : 'No trigger comment in this turn.',
    ...(extra.length ? ['', ...extra] : []),
    '',
    `Run: ${process.env.NOCOPROJECT_RUN_ID ?? 'unknown'}`,
  ].join('\n');
  writeFileSync(join(process.cwd(), 'reply.md'), `${reply}\n`);
  const commentArgs = ['issue', 'comment', 'add', issueKey, '--content-file', 'reply.md', '--json'];
  if (parent) commentArgs.push('--parent', parent);
  const commented = cli(commentArgs);
  if (!commented.ok) fail(`echo agent: comment add failed: ${commented.output}`);

  if (!manager && status === 'in_progress' && !coordinating && !statusKey && ctx.issue?.executionMode !== 'session') {
    const reviewed = cli(['issue', 'status', issueKey, 'in_review', '--json']);
    if (!reviewed.ok) fail(`echo agent: status in_review failed: ${reviewed.output}`);
  }

  finish(`Echo agent delivered a reply on ${issue.identifier ?? issueKey}.`, prompt.length, reply.length);
}

main().catch((error: unknown) => fail(`echo agent crashed: ${(error as Error).message}`));
