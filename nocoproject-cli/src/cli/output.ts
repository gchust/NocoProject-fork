import { ZodError } from 'zod';
import { HttpError, NetworkError } from '../api/client.js';
import { redactText } from '../util/redact.js';

export const EXIT = { ok: 0, other: 1, network: 2, auth: 3, notFound: 4, validation: 5 } as const;

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.other,
    readonly code = 'CLI_ERROR',
  ) {
    super(message);
    this.name = 'CliError';
  }
}

const PM_AUTH_ERRORS = new Set(['PLAN_REQUIRED', 'PLAN_INVALID', 'NOT_CONVERSATION_RUN']);

export function exitCodeFor(error: unknown): number {
  if (error instanceof CliError) return error.exitCode;
  if (error instanceof NetworkError) return EXIT.network;
  if (error instanceof ZodError) return EXIT.validation;
  if (error instanceof HttpError) {
    if (PM_AUTH_ERRORS.has(error.code)) return EXIT.auth;
    if (error.code === 'TRANSITION_NOT_ALLOWED' || error.code === 'DESIGN_NOT_APPROVED') return EXIT.validation;
    if (error.status === 401 || error.status === 403) return EXIT.auth;
    if (error.status === 404) return EXIT.notFound;
    if (error.status === 400 || error.status === 409 || error.status === 422) return EXIT.validation;
  }
  return EXIT.other;
}

function errorCode(error: unknown): string {
  if (error instanceof CliError) return error.code;
  if (error instanceof HttpError) return error.code;
  if (error instanceof NetworkError) return 'NETWORK_ERROR';
  if (error instanceof ZodError) return 'VALIDATION_ERROR';
  return 'ERROR';
}

function errorMessage(error: unknown): string {
  if (error instanceof ZodError) return error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
  return error instanceof Error ? error.message : String(error);
}

/** Field-level lines of an error's `details` (`INVALID_WORKFLOW` issues, `WORKFLOW_STATUS_CONFLICT` counts). */
function detailLines(details: Readonly<Record<string, unknown>> | undefined): string[] {
  const issues = Array.isArray(details?.issues) ? (details.issues as { path?: unknown; message?: unknown }[]) : [];
  const statuses = Array.isArray(details?.statuses) ? (details.statuses as { statusKey?: unknown; projects?: { projectName?: unknown; count?: unknown }[] }[]) : [];
  return [
    ...issues.map((i) => `  - ${String(i.path ?? '')}: ${String(i.message ?? '')}`),
    ...statuses.map((s) => `  - ${String(s.statusKey ?? '')}: ${(s.projects ?? []).map((p) => `${String(p.projectName ?? '')} ${String(p.count ?? 0)}`).join(', ')}`),
  ];
}

/** Prints an error (JSON on stdout with --json, text on stderr otherwise) and exits. */
export function failAndExit(error: unknown, json: boolean): never {
  const code = exitCodeFor(error);
  const message = redactText(errorMessage(error));
  const details = error instanceof HttpError ? error.details : undefined;
  if (json) process.stdout.write(`${JSON.stringify({ error: { code: errorCode(error), message, exitCode: code, ...(details ? { details } : {}) } })}\n`);
  else process.stderr.write(`error: ${message}\n${detailLines(details).map((line) => `${redactText(line)}\n`).join('')}`);
  if (error instanceof HttpError && PM_AUTH_ERRORS.has(error.code) && details) {
    process.stderr.write(JSON.stringify(details) + '\n');
  }
  process.exit(code);
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printLine(text = ''): void {
  process.stdout.write(`${text}\n`);
}
