/**
 * Shared plumbing for the agent-facing commands (run-token mode): the run-token API context,
 * identifier resolution and the error-handling action wrapper.
 */
import type { Command } from 'commander';
import { AgentApi } from '../api/client.js';
import { normalizeServerUrl } from '../config.js';
import { RUN_ENV } from '../protocol.js';
import { findWorkDir, readRunContext, type RunContextFile } from '../run-context.js';
import { registerSecret } from '../util/redact.js';
import { CliError, EXIT, failAndExit } from './output.js';

export interface RunTokenContext {
  readonly api: AgentApi;
  readonly issueId?: string;
  readonly issueKey?: string;
  /** `<workDir>/.nocoproject/context.json`, when the command runs inside a daemon run. */
  readonly runContext?: RunContextFile | null;
}

export function runTokenContext(env: NodeJS.ProcessEnv = process.env): RunTokenContext {
  const token = env[RUN_ENV.token];
  const serverUrl = env[RUN_ENV.serverUrl];
  if (!token || !serverUrl) {
    throw new CliError(
      `issue commands run inside an agent run: ${RUN_ENV.token} and ${RUN_ENV.serverUrl} must be set`,
      EXIT.auth,
      'RUN_TOKEN_REQUIRED',
    );
  }
  registerSecret(token);
  const workDir = findWorkDir(env);
  return {
    api: new AgentApi(normalizeServerUrl(serverUrl), token),
    issueId: env[RUN_ENV.issueId],
    issueKey: env[RUN_ENV.issueKey],
    runContext: workDir ? readRunContext(workDir) : null,
  };
}

export const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

const sameKey = (a: string | null | undefined, b: string): boolean => Boolean(a && a.toUpperCase() === b.toUpperCase());

/** Resolves `NP-12` style identifiers for URL paths (the server also accepts identifiers there). */
export async function resolveIssueId(arg: string | undefined, ctx: RunTokenContext): Promise<string> {
  if (!arg) {
    if (ctx.issueId) return ctx.issueId;
    throw new CliError('issue id or identifier is required', EXIT.validation, 'ISSUE_REQUIRED');
  }
  if (!IDENTIFIER.test(arg)) return arg;
  if (ctx.issueId && sameKey(ctx.issueKey, arg)) return ctx.issueId;
  const context = await ctx.api.context();
  if (sameKey(context.issue.identifier, arg)) return context.issue.id;
  return arg;
}

/**
 * Resolves an identifier to a raw id for request bodies (`parentIssueId`, `blockedBy`,
 * `dependsOnIssueId`): the run's own issue and its parent locally, anything else via
 * `GET /np/agent/issues/<identifier>` (404 → exit 4).
 */
export async function resolveIssueRef(arg: string, ctx: RunTokenContext): Promise<string> {
  const value = arg.trim();
  if (!IDENTIFIER.test(value)) return value;
  if (ctx.issueId && sameKey(ctx.issueKey, value)) return ctx.issueId;
  const parent = ctx.runContext?.issue.parent;
  if (parent && sameKey(parent.identifier, value)) return parent.id;
  if (ctx.runContext && sameKey(ctx.runContext.issue.identifier, value)) return ctx.runContext.issue.id;
  return (await ctx.api.issue(value)).id;
}

export function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export type JsonOpt = { json?: boolean };

/** Wraps a command action: errors are printed (JSON with --json) and mapped to exit codes. */
export function action<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    const cmd = args[args.length - 1] as Command;
    const json = Boolean((cmd.optsWithGlobals() as JsonOpt).json);
    try {
      await fn(...args);
    } catch (error) {
      failAndExit(error, json);
    }
  };
}
