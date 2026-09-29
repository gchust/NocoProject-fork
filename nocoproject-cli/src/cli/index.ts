/**
 * nocoproject / ncp — NocoProject daemon and agent CLI.
 */
import { Command } from 'commander';
import { CLI_VERSION, PROTOCOL_VERSION } from '../version.js';
import { registerDaemonCommands } from './daemon.js';
import { registerUpgradeCommand } from './upgrade.js';
import { registerIssueCommands } from './issue.js';
import { registerKbCommands } from './kb.js';
import { registerLoginCommand } from './login.js';
import { registerPmCommands } from './pm.js';
import { registerPrCommands } from './pr.js';
import { registerProjectCommands } from './project.js';
import { registerRepoCommands } from './repo.js';
import { registerWorkflowCommands } from './workflow.js';
import { registerUserCommands } from './user.js';
import { EXIT, printJson, printLine } from './output.js';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('nocoproject')
    .description('NocoProject CLI: local agent daemon, agent write-back commands, and the user mode (`user`)')
    .version(CLI_VERSION, '-v, --version', 'print the version')
    .showHelpAfterError()
    .exitOverride((err) => {
      if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version' || err.code === 'commander.help') process.exit(EXIT.ok);
      process.exit(EXIT.validation);
    });
  program
    .command('version')
    .description('Print CLI and protocol versions')
    .option('--json', 'JSON output')
    .action((opts: { json?: boolean }) => {
      const info = { version: CLI_VERSION, protocolVersion: PROTOCOL_VERSION, node: process.version };
      if (opts.json) printJson(info);
      else printLine(`nocoproject ${CLI_VERSION} (protocol ${PROTOCOL_VERSION}, node ${process.version})`);
    });
  registerLoginCommand(program);
  registerDaemonCommands(program);
  registerUpgradeCommand(program);
  registerIssueCommands(program);
  registerProjectCommands(program);
  registerRepoCommands(program);
  registerPrCommands(program);
  registerKbCommands(program);
  registerPmCommands(program);
  registerWorkflowCommands(program);
  registerUserCommands(program);
  return program;
}

await buildProgram().parseAsync(process.argv);
