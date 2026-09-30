/**
 * Per-run execution environment: `<root>/<issueKey>-<runKey>/{workdir,logs}`.
 * A previous session's workDir is reused when the server hands it back, it still
 * exists, and the session is not marked fresh.
 */
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { which } from '../util/process.js';
import { AGENT_ENV_NAME_PATTERN, RESERVED_ENV_NAMES, RESERVED_ENV_PREFIX, RUN_ENV_PHASE1 as RUN_ENV } from '../protocol.js';
import type { ClaimedRunV1 } from '../run-context.js';

export interface RunEnvironment {
  readonly envDir: string;
  readonly workDir: string;
  readonly logsDir: string;
  readonly reused: boolean;
  readonly resumeSessionId?: string;
}

function safeSegment(value: string, max = 40): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (cleaned || 'x').slice(0, max);
}

export function envDirName(issueKey: string, runId: string): string {
  return `${safeSegment(issueKey)}-${safeSegment(runId.slice(-12), 12)}`;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function prepareRunEnvironment(root: string, claimed: Pick<ClaimedRunV1, 'run' | 'issue' | 'session'>, canResume: boolean): RunEnvironment {
  const envDir = join(root, envDirName(claimed.issue.identifier || claimed.issue.id, claimed.run.id));
  const logsDir = join(envDir, 'logs');
  mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  const prior = claimed.session.workDir;
  const reuse = !claimed.session.fresh && !!prior && isDirectory(prior);
  const workDir = reuse ? (prior as string) : join(envDir, 'workdir');
  mkdirSync(workDir, { recursive: true });
  const resumeSessionId =
    reuse && canResume && !claimed.session.fresh && claimed.session.providerSessionId ? claimed.session.providerSessionId : undefined;
  return { envDir, workDir, logsDir, reused: reuse, resumeSessionId };
}

/**
 * Writes `<home>/bin/nocoproject` (and `ncp`) pointing at the CLI bundle so agents can run
 * `nocoproject ...` even when the package is not installed globally. Returns the bin dir.
 */
export function ensureCliShim(home: string, cliPath: string): string {
  const binDir = join(home, 'bin');
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const script = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} "$@"\n`;
  for (const name of ['nocoproject', 'ncp']) {
    const path = join(binDir, name);
    writeFileSync(path, script, { mode: 0o755 });
    chmodSync(path, 0o755);
  }
  ensureKeychainGuards(binDir);
  return binDir;
}

/** Subcommands (and interactive mode) of `security` / `secret-tool` that read secrets. */
const KEYCHAIN_READS = ['-i', '-p*', 'find-generic-password', 'find-internet-password', 'dump-keychain', 'export', 'lookup', 'search'];

/** The guard script: refuses the reading subcommands inside an agent run, passes everything else to `real`. */
export function keychainGuardScript(real: string): string {
  return [
    '#!/bin/sh',
    '# Written by the NocoProject daemon (NP-190): agent runs may not read the keychain, where the personal API key is.',
    'if [ -n "${NOCOPROJECT_TOKEN}${NOCOPROJECT_RUN_ID}" ]; then',
    '  for arg in "$@"; do',
    '    case "$arg" in',
    `      ${KEYCHAIN_READS.join('|')})`,
    '        echo "nocoproject: agent runs cannot read the keychain; use nocoproject issue ... (the run token) instead" >&2',
    '        exit 1 ;;',
    '      -*) ;;',
    '      *) break ;;',
    '    esac',
    '  done',
    'fi',
    `exec ${JSON.stringify(real)} "$@"`,
    '',
  ].join('\n');
}

/**
 * Puts `security` and `secret-tool` guards next to the CLI shim (first on the agents' PATH), so an agent that goes
 * looking for the personal key through the keychain tools is refused (NP-190). This stops the casual path only: the
 * agent runs as the same OS user and can still call `/usr/bin/security` by its absolute path.
 */
export function ensureKeychainGuards(binDir: string): void {
  const others = (process.env.PATH ?? '').split(delimiter).filter((dir) => dir && dir !== binDir);
  for (const tool of ['security', 'secret-tool']) {
    const real = findOutside(tool, others);
    if (!real) continue;
    const path = join(binDir, tool);
    writeFileSync(path, keychainGuardScript(real), { mode: 0o755 });
    chmodSync(path, 0o755);
  }
}

function findOutside(tool: string, dirs: readonly string[]): string | null {
  for (const dir of dirs) {
    const found = which(join(dir, tool));
    if (found) return found;
  }
  return null;
}

/** True for names the agent's env vars may not set: `NOCOPROJECT_*`, `PATH`, `HOME`, `SHELL`. */
export function isReservedEnvName(name: string): boolean {
  return name.startsWith(RESERVED_ENV_PREFIX) || RESERVED_ENV_NAMES.includes(name);
}

/**
 * Filters the claim payload's `agent.env` (contract §G): reserved names and names that are not
 * `^[A-Z_][A-Z0-9_]*$` are skipped (the server rejects both; this is defence in depth).
 * Returns the names that were skipped, never their values.
 */
export function filterAgentEnv(env: Readonly<Record<string, string>> | null | undefined): { vars: Record<string, string>; skipped: string[] } {
  const vars: Record<string, string> = {};
  const skipped: string[] = [];
  for (const [name, value] of Object.entries(env ?? {})) {
    if (typeof value !== 'string' || !AGENT_ENV_NAME_PATTERN.test(name) || isReservedEnvName(name)) skipped.push(name);
    else vars[name] = value;
  }
  return { vars, skipped };
}

export interface AgentEnvInput {
  readonly serverUrl: string;
  readonly token: string;
  readonly claimed: Pick<ClaimedRunV1, 'run' | 'agent' | 'issue'>;
  readonly binDir?: string;
  /** The run's workDir → `NOCOPROJECT_WORKDIR` (contract §I). */
  readonly workDir?: string;
  /** The daemon's state dir → `NOCOPROJECT_HOME`, so `repo checkout` shares its repo cache. */
  readonly home?: string;
}

/**
 * Environment injected into the agent process (§7, plus NOCOPROJECT_WORKDIR from Phase 1 §I and
 * the agent's own env vars from iteration 2 §G, which can never override the run variables).
 */
export function buildAgentEnv(input: AgentEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    ...filterAgentEnv(input.claimed.agent.env).vars,
    [RUN_ENV.serverUrl]: input.serverUrl,
    [RUN_ENV.token]: input.token,
    [RUN_ENV.runId]: input.claimed.run.id,
    [RUN_ENV.agentId]: input.claimed.agent.id,
    [RUN_ENV.issueId]: input.claimed.issue.id,
    [RUN_ENV.issueKey]: input.claimed.issue.identifier || input.claimed.issue.id,
  };
  if (input.workDir) env[RUN_ENV.workDir] = input.workDir;
  if (input.home) env.NOCOPROJECT_HOME = input.home;
  if (input.binDir && existsSync(input.binDir)) env.PATH = `${input.binDir}${delimiter}${process.env.PATH ?? ''}`;
  return env;
}
