import { describe, expect, it } from 'vitest';
import { classifyFailure, type FailureInput } from '../src/daemon/classify.js';
import type { FailureReason } from '../src/protocol.js';

const table: [string, FailureInput, FailureReason][] = [
  ['spawn ENOENT', { spawnErrorCode: 'ENOENT' }, 'agentError.missingExecutable'],
  ['shell not found', { errorText: 'sh: claude: command not found', exitCode: 127 }, 'agentError.missingExecutable'],
  ['claude invalid key', { errorText: 'Invalid API key · Please run /login', exitCode: 1 }, 'agentError.providerAuth'],
  ['401', { errorText: 'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}' }, 'agentError.providerAuth'],
  ['403 forbidden', { errorText: 'Request failed: 403 Forbidden' }, 'agentError.providerAuth'],
  ['402', { errorText: 'HTTP 402 Payment Required' }, 'agentError.providerQuota'],
  ['opencode usage limit', { errorText: 'AI_APICallError: Go usage limit exceeded' }, 'agentError.providerQuota'],
  ['credit balance', { errorText: 'Credit balance is too low' }, 'agentError.providerQuota'],
  ['429', { errorText: 'API Error: 429 rate_limit_error' }, 'agentError.providerRateLimit'],
  ['529 overloaded', { errorText: 'API Error: 529 {"type":"overloaded_error"}' }, 'agentError.providerRateLimit'],
  ['500', { errorText: 'API Error: 500 Internal server error' }, 'agentError.providerServerError'],
  ['503', { errorText: 'upstream returned 503 Service Unavailable' }, 'agentError.providerServerError'],
  ['network', { errorText: 'fetch failed: getaddrinfo ENOTFOUND api.anthropic.com' }, 'agentError.providerNetwork'],
  ['econnreset', { errorText: 'Error: socket hang up (ECONNRESET)' }, 'agentError.providerNetwork'],
  ['context overflow', { errorText: 'Prompt is too long' }, 'agentError.contextOverflow'],
  ['context length', { errorText: "This model's maximum context length is 128000 tokens" }, 'agentError.contextOverflow'],
  ['model missing', { errorText: 'ProviderModelNotFoundError: model not found: foo/bar' }, 'agentError.modelUnavailable'],
  ['unknown option', { errorText: "error: unknown option '--input-format'" }, 'agentError.versionUnsupported'],
  ['missing config', { errorText: 'No model configured. Run opencode auth login.' }, 'agentError.missingConfig'],
  ['timeout', { timedOut: true, errorText: 'whatever' }, 'agentError.agentTimeout'],
  ['empty output', { exitCode: 0, emptyOutput: true }, 'agentError.emptyOutput'],
  ['killed by signal', { exitCode: null, signal: 'SIGSEGV' }, 'agentError.processFailure'],
  ['silent non-zero exit', { exitCode: 3 }, 'agentError.processFailure'],
  ['unrecognised text', { errorText: 'something odd happened', exitCode: 1 }, 'agentError.unknown'],
];

describe('classifyFailure', () => {
  it.each(table)('%s', (_name, input, expected) => {
    expect(classifyFailure(input)).toBe(expected);
  });
});
