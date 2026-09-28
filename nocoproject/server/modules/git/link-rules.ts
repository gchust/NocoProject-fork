/**
 * Which issues a pull request belongs to (docs/phase1/iteration-2-contract.md §C). Pure functions, unit-tested in
 * `tests/logic/np-git.test.ts`.
 *
 * Rules, first hit wins:
 * 1. The head branch is `agent/<slug>/<identifier>` (identifier in lower case, e.g. `agent/echo/np-12`) → that issue.
 * 2. Issue numbers (`\bNP-\d+\b`, prefix from the system settings, case-insensitive) in the title, the body or the
 *    head branch → every issue named (deduplicated, at most 5).
 * 3. Nothing → the pull request is stored without a link.
 */
import type { PullRequestState } from '../shared/protocol.js';

export const MAX_MENTIONED_ISSUES = 5;

export interface LinkRuleInput {
  readonly headRef: string;
  readonly title: string;
  readonly body: string | null;
  /** The issue prefix from the system settings (`NP`). */
  readonly prefix: string;
}

export type LinkRuleMatch =
  | { readonly rule: 'branch'; readonly identifiers: readonly [string] }
  | { readonly rule: 'mention'; readonly identifiers: readonly string[] }
  | { readonly rule: 'none'; readonly identifiers: readonly [] };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Identifiers keep the configured prefix spelling (`NP-12`), whatever case the text used. */
export function matchIssueIdentifiers(input: LinkRuleInput): LinkRuleMatch {
  const prefix = escapeRegExp(input.prefix);
  const branch = new RegExp(`^agent/[^/]+/${prefix}-(\\d+)$`, 'iu').exec(
    input.headRef.trim(),
  );
  if (branch?.[1])
    return {
      rule: 'branch',
      identifiers: [`${input.prefix}-${Number(branch[1])}`],
    };
  const pattern = new RegExp(`\\b${prefix}-(\\d+)\\b`, 'giu');
  const found: string[] = [];
  for (const text of [input.title, input.body ?? '', input.headRef]) {
    for (const match of text.matchAll(pattern)) {
      const identifier = `${input.prefix}-${Number(match[1])}`;
      if (!found.includes(identifier)) found.push(identifier);
      if (found.length >= MAX_MENTIONED_ISSUES)
        return { rule: 'mention', identifiers: found };
    }
  }
  return found.length > 0
    ? { rule: 'mention', identifiers: found }
    : { rule: 'none', identifiers: [] };
}

export interface PullRequestRef {
  /** `owner/name` */
  readonly repo: string;
  readonly number: number;
  /** Normalized `https://<host>/<owner>/<name>/pull/<number>` */
  readonly url: string;
  readonly host: string;
}

const PR_URL_PATTERN =
  /^https?:\/\/([A-Za-z0-9.-]+(?::\d+)?)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/u;

/** A GitHub (or GitHub Enterprise) pull request URL, or null. */
export function parsePullRequestUrl(value: unknown): PullRequestRef | null {
  if (typeof value !== 'string') return null;
  const match = PR_URL_PATTERN.exec(value.trim());
  if (!match) return null;
  const [, host, owner, name, number] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  const parsed = Number(number);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return {
    repo: `${owner}/${name}`,
    number: parsed,
    url: `https://${host}/${owner}/${name}/pull/${parsed}`,
    host,
  };
}

/** `state` + `merged` of a GitHub pull request object → our state. */
export function pullRequestStateOf(
  state: unknown,
  merged: unknown,
  mergedAt: unknown,
): PullRequestState {
  if (merged === true || (typeof mergedAt === 'string' && mergedAt))
    return 'merged';
  return state === 'closed' ? 'closed' : 'open';
}
