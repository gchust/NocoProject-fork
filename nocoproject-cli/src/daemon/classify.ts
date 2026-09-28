/**
 * Maps an agent process outcome to a protocol FailureReason. Pure; table-tested.
 */
import type { FailureReason } from '../protocol.js';

export interface FailureInput {
  /** Error text reported by the tool (result error, error events, stderr tail). */
  readonly errorText?: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  /** errno code from spawn(), e.g. ENOENT. */
  readonly spawnErrorCode?: string;
  readonly timedOut?: boolean;
  /** Exited cleanly but produced no visible output. */
  readonly emptyOutput?: boolean;
}

const RULES: readonly (readonly [RegExp, FailureReason])[] = [
  [/command not found|executable not found|no such file or directory.*(claude|opencode|codex)|spawn \S+ ENOENT/i, 'agentError.missingExecutable'],
  [
    /prompt is too long|prompt_too_long|context[_ ]length|context window|maximum context|context_length_exceeded|too many tokens|input is too long|exceeds? the (model's )?context/i,
    'agentError.contextOverflow',
  ],
  [/\b402\b|payment required|insufficient[_ ]?(quota|balance|credits?)|usage limit|quota exceeded|exceeded your (current )?quota|credit balance is too low|billing/i, 'agentError.providerQuota'],
  [/\b429\b|\b529\b|rate[_ ]?limit|too many requests|overloaded/i, 'agentError.providerRateLimit'],
  [
    /\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid[ _-]?(x-)?api[ _-]?key|authentication[_ ]?(error|failed|required)|not logged in|please run \/login|oauth token (has )?expired|permission_error/i,
    'agentError.providerAuth',
  ],
  [/model[_ ]not[_ ]found|unknown model|invalid model|model .{0,40}(does not exist|not available|is not supported)|ProviderModelNotFound|no such model/i, 'agentError.modelUnavailable'],
  [/\b50[0-4]\b|internal server error|bad gateway|service unavailable|gateway timeout|api_error|upstream error/i, 'agentError.providerServerError'],
  [/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|socket hang up|network error|fetch failed|getaddrinfo|connection (refused|reset|error)/i, 'agentError.providerNetwork'],
  [/unknown option|unrecognized option|unknown argument|unexpected argument|requires a newer version|unsupported version/i, 'agentError.versionUnsupported'],
  [/no (default )?model (configured|selected|specified)|missing (config|configuration|api key)|not configured|no providers? (configured|found)/i, 'agentError.missingConfig'],
];

export function classifyFailure(input: FailureInput): FailureReason {
  if (input.spawnErrorCode === 'ENOENT' || input.spawnErrorCode === 'EACCES') return 'agentError.missingExecutable';
  if (input.timedOut) return 'agentError.agentTimeout';
  const text = input.errorText ?? '';
  for (const [re, reason] of RULES) if (re.test(text)) return reason;
  if (input.emptyOutput && (input.exitCode === 0 || input.exitCode === undefined)) return 'agentError.emptyOutput';
  if (input.signal) return 'agentError.processFailure';
  if (typeof input.exitCode === 'number' && input.exitCode !== 0 && !text.trim()) return 'agentError.processFailure';
  return 'agentError.unknown';
}
