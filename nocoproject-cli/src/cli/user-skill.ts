/**
 * `nocoproject user skill install` (NP-86): installs the bundled `nocoproject-user` skill for the local Claude Code
 * (`~/.claude/skills/`) and Codex (`~/.codex/skills/`). The skill text is bundled into dist/cli.js at build time.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import SKILL_MD from '../../skills/nocoproject-user/SKILL.md';
import { CliError, EXIT, printJson, printLine } from './output.js';
import { action, type JsonOpt } from './run-token.js';
import { refuseInsideRun } from './user-context.js';

export const USER_SKILL_NAME = 'nocoproject-user';

export interface SkillInstallResult {
  readonly tool: 'claude' | 'codex';
  readonly path: string;
  readonly status: 'installed' | 'updated' | 'unchanged';
}

/** Writes `<home>/.<tool>/skills/nocoproject-user/SKILL.md`; different existing content needs `force`. */
export function installUserSkill(tools: readonly ('claude' | 'codex')[], force: boolean, home = homedir(), content: string = SKILL_MD): SkillInstallResult[] {
  const planned = tools.map((tool) => {
    const dir = join(home, `.${tool}`, 'skills', USER_SKILL_NAME);
    const path = join(dir, 'SKILL.md');
    const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
    return { tool, dir, path, current };
  });
  const conflicts = planned.filter((p) => p.current !== null && p.current !== content && !force);
  if (conflicts.length > 0) {
    throw new CliError(`${conflicts.map((c) => c.path).join(', ')} already exists with different content; pass --force to overwrite`, EXIT.validation, 'SKILL_EXISTS');
  }
  return planned.map(({ tool, dir, path, current }) => {
    if (current === content) return { tool, path, status: 'unchanged' as const };
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, content);
    return { tool, path, status: current === null ? ('installed' as const) : ('updated' as const) };
  });
}

export function registerUserSkillCommand(user: Command): void {
  user
    .command('skill')
    .description('The skill that teaches local agents these commands')
    .command('install')
    .description('Install it for Claude Code (~/.claude/skills) and/or Codex (~/.codex/skills); both when neither flag is given')
    .option('--claude', 'install for Claude Code')
    .option('--codex', 'install for Codex')
    .option('--force', 'overwrite a changed copy')
    .option('--json', 'JSON output')
    .action(
      action(async (opts: JsonOpt & { claude?: boolean; codex?: boolean; force?: boolean }) => {
        refuseInsideRun();
        const tools = opts.claude || opts.codex ? [...(opts.claude ? (['claude'] as const) : []), ...(opts.codex ? (['codex'] as const) : [])] : (['claude', 'codex'] as const);
        const results = installUserSkill(tools, Boolean(opts.force));
        if (opts.json) printJson(results);
        else for (const r of results) printLine(`${r.tool}: ${r.status} ${r.path}`);
      }),
    );
}
