/**
 * Secret redaction for agent output, logs and error details.
 *
 * Everything that leaves this machine (run events, failure details) or lands in a
 * log file goes through `redactText` / `redactValue` first.
 */

interface SecretPattern {
  readonly re: RegExp;
  readonly replacement: string;
}

const PATTERNS: readonly SecretPattern[] = [
  { re: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, replacement: '[REDACTED PRIVATE KEY]' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[REDACTED AWS KEY]' },
  {
    re: /(aws_secret_access_key|secret_?access_?key)(\s*[=:]\s*)[A-Za-z0-9/+=]{40}/gi,
    replacement: '$1$2[REDACTED AWS SECRET]',
  },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,255}\b/g, replacement: '[REDACTED GITHUB TOKEN]' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g, replacement: '[REDACTED GITHUB TOKEN]' },
  { re: /\bnpr_[A-Fa-f0-9]{16,}\b/g, replacement: '[REDACTED RUN TOKEN]' },
  { re: /\bsk-[A-Za-z0-9_.\-]{16,}/g, replacement: '[REDACTED API KEY]' },
  { re: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, replacement: 'Bearer [REDACTED]' },
  { re: /(x-api-key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, replacement: '$1[REDACTED]' },
  { re: /\b(https?:\/\/)[^/\s@'"]+@/gi, replacement: '$1[REDACTED]@' },
];

/**
 * Values registered at runtime (the daemon API key, issued run tokens, agent env values) are
 * always masked. Registrations are reference-counted: two concurrent runs of the same agent
 * register the same env values, and one finishing must not unmask them for the other.
 */
const knownSecrets = new Map<string, number>();

export interface SecretOptions {
  /** Values shorter than this are ignored (default 8; agent env values use 6). */
  readonly minLength?: number;
}

export function registerSecret(value: string | undefined | null, opts: SecretOptions = {}): void {
  if (!value || value.length < (opts.minLength ?? 8)) return;
  knownSecrets.set(value, (knownSecrets.get(value) ?? 0) + 1);
}

export function forgetSecret(value: string | undefined | null): void {
  if (!value) return;
  const n = knownSecrets.get(value);
  if (n === undefined) return;
  if (n <= 1) knownSecrets.delete(value);
  else knownSecrets.set(value, n - 1);
}

/** Masks only the registered secrets (no pattern rules); used for files the agent reads, like the brief. */
export function redactKnownSecrets(input: string): string {
  let out = input;
  // Longest first, so a secret that contains another one is masked as a whole.
  for (const secret of [...knownSecrets.keys()].sort((a, b) => b.length - a.length)) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

export function redactText(input: string): string {
  let out = redactKnownSecrets(input);
  for (const p of PATTERNS) out = out.replace(p.re, p.replacement);
  return out;
}

const MAX_DEPTH = 32;

/** Deep-redacts every string inside a JSON-like value; returns a copy. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth >= MAX_DEPTH) return '[REDACTED DEPTH LIMIT]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactValue(v, depth + 1);
    return out;
  }
  return value;
}
