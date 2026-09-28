/**
 * `nocoproject repo checkout <url> [--ref <ref>] [--fresh] [--json]` (contract §I).
 */
import type { Command } from 'commander';
import { nocoprojectHome } from '../config.js';
import { RUN_ENV } from '../protocol.js';
import { checkoutRepo } from '../repo/checkout.js';
import { findWorkDir, readRunContext } from '../run-context.js';
import { CliError, EXIT, printJson, printLine } from './output.js';
import { action, type JsonOpt } from './run-token.js';

export function registerRepoCommands(program: Command): void {
  const repo = program.command('repo').description('Git repositories of the current agent run');
  repo
    .command('checkout <url>')
    .description('Check out a project repository into the run’s workDir on the agent branch')
    .option('--ref <ref>', 'base branch, tag or commit (default: the resource’s default ref, then the remote default branch)')
    .option('--fresh', 'discard this workDir’s checkout and restart the branch from the base ref')
    .option('--json', 'JSON output')
    .action(
      action(async (url: string, opts: JsonOpt & { ref?: string; fresh?: boolean }) => {
        const workDir = findWorkDir();
        const context = workDir ? readRunContext(workDir) : null;
        if (!workDir || !context) {
          throw new CliError(
            'repo checkout runs inside an agent run: NOCOPROJECT_WORKDIR/.nocoproject/context.json was not found',
            EXIT.validation,
            'CONTEXT_MISSING',
          );
        }
        const record = checkoutRepo({
          url,
          ref: opts.ref,
          fresh: opts.fresh,
          workDir,
          context,
          home: nocoprojectHome(),
          runId: process.env[RUN_ENV.runId] ?? context.runId,
          note: (message) => process.stderr.write(`${message}\n`),
        });
        if (opts.json) printJson(record);
        else printLine(record.path);
      }),
    );
}
