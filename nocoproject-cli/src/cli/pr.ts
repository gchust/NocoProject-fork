/**
 * `nocoproject pr link <url> [--issue <id>] [--json]` and `nocoproject pr list [--issue <id>] [--json]`
 * (iteration 2 §C): link a pull request the agent opened to an issue, and list the linked ones.
 * Run-token mode; the issue defaults to the run's own issue.
 */
import type { Command } from 'commander';
import type { IssuePullRequestView } from '../protocol.js';
import { CliError, EXIT, printJson, printLine } from './output.js';
import { action, type JsonOpt, resolveIssueId, runTokenContext } from './run-token.js';

/** Accepts absolute http(s) URLs only; the server decides whether it is a pull request (400 INVALID_PR_URL). */
export function checkPullRequestUrl(value: string): string {
  const url = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError(`not a URL: ${url}`, EXIT.validation, 'INVALID_PR_URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new CliError(`not an http(s) URL: ${url}`, EXIT.validation, 'INVALID_PR_URL');
  return url;
}

function describePr(pr: Partial<IssuePullRequestView>): string {
  const ref = pr.repo && pr.number !== undefined ? `${pr.repo}#${pr.number}` : pr.number !== undefined ? `#${pr.number}` : (pr.url ?? 'pull request');
  const state = pr.state ? ` (${pr.draft ? 'draft, ' : ''}${pr.state}${pr.ciState ? `, CI ${pr.ciState}` : ''})` : '';
  const title = pr.title ? `  ${pr.title}` : '';
  return `${ref}${state}${title}`;
}

export function registerPrCommands(program: Command): void {
  const pr = program.command('pr').description('Pull requests linked to the issue of the current agent run (run-token mode)');

  pr.command('link <url>')
    .description('Link a pull request (e.g. the URL printed by `gh pr create`) to the issue')
    .option('--issue <issue>', 'issue identifier or id (default: the run’s issue)')
    .option('--json', 'JSON output')
    .action(
      action(async (rawUrl: string, opts: JsonOpt & { issue?: string }) => {
        const url = checkPullRequestUrl(rawUrl);
        const ctx = runTokenContext();
        const issueId = await resolveIssueId(opts.issue, ctx);
        const data = await ctx.api.linkPullRequest(issueId, url);
        if (opts.json) printJson(data);
        else printLine(`linked ${describePr(data ?? { url })} to ${opts.issue ?? ctx.issueKey ?? issueId}`);
      }),
    );

  pr.command('list')
    .description('List the pull requests linked to the issue')
    .option('--issue <issue>', 'issue identifier or id (default: the run’s issue)')
    .option('--json', 'JSON output')
    .action(
      action(async (opts: JsonOpt & { issue?: string }) => {
        const ctx = runTokenContext();
        const data = (await ctx.api.pullRequests(await resolveIssueId(opts.issue, ctx))) ?? [];
        if (opts.json) return printJson(data);
        if (data.length === 0) return printLine('(no linked pull requests)');
        for (const item of data) printLine(`${describePr(item)}\n  ${item.url}`);
      }),
    );
}
