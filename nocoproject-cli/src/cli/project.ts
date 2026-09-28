/**
 * `nocoproject project get`: the run's project and its repositories, from
 * `<workDir>/.nocoproject/context.json` (falls back to `GET /np/agent/context`).
 */
import type { Command } from 'commander';
import type { ClaimedProject } from '../protocol.js';
import { findWorkDir, readRunContext } from '../run-context.js';
import { printJson, printLine } from './output.js';
import { action, type JsonOpt, runTokenContext } from './run-token.js';

async function loadProject(): Promise<ClaimedProject | null> {
  const workDir = findWorkDir();
  const context = workDir ? readRunContext(workDir) : null;
  if (context) return context.project;
  const remote = await runTokenContext().api.context();
  return remote.project ?? null;
}

function printProject(project: ClaimedProject | null): void {
  if (!project) return printLine('This issue is not in a project.');
  printLine(`${project.name}  (project ${project.id})`);
  if (project.description) printLine(project.description);
  printLine();
  if (project.resources.length === 0) return printLine('No repositories.');
  printLine('Repositories:');
  for (const r of project.resources) {
    printLine(`- ${r.url}${r.defaultRef ? ` (default ref ${r.defaultRef})` : ''}`);
    printLine(`  nocoproject repo checkout ${r.url}`);
  }
}

export function registerProjectCommands(program: Command): void {
  const project = program.command('project').description('The project of the current agent run');
  project
    .command('get')
    .description('Show the project and its repositories')
    .option('--json', 'JSON output')
    .action(
      action(async (opts: JsonOpt) => {
        const data = await loadProject();
        if (opts.json) printJson(data);
        else printProject(data);
      }),
    );
}
