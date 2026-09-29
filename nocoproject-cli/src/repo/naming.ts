/**
 * Pure naming rules for repository checkouts (contract §I).
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** Allowlist comparison key: trimmed, lower-cased, without trailing slashes or a `.git` suffix. */
export function normalizeRepoUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

export function sameRepoUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && normalizeRepoUrl(a) === normalizeRepoUrl(b));
}

/** Bare cache directory: `<home>/repos/<sha1(normalized url)>.git`. */
export function repoCachePath(home: string, url: string): string {
  const digest = createHash('sha1').update(normalizeRepoUrl(url)).digest('hex');
  return join(home, 'repos', `${digest}.git`);
}

/** Short directory name from a remote URL: `https://github.com/org/my-repo.git` → `my-repo`. */
export function repoNameFromUrl(url: string): string {
  let s = url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const slash = s.lastIndexOf('/');
  if (slash >= 0) s = s.slice(slash + 1);
  const colon = s.lastIndexOf(':');
  if (colon >= 0) s = s.slice(colon + 1);
  const name = s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '');
  return name || 'repo';
}

function issueSegment(identifier: string): string {
  const s = identifier
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return s || 'issue';
}

/** `agent/<issueIdentifier lower-case>` (NP-145: no agent segment; the session remembers who owns it). */
export function branchNameFor(issueIdentifier: string): string {
  return `agent/${issueSegment(issueIdentifier)}`;
}

/** Short, branch-safe run key used to disambiguate a colliding branch name. */
export function runKey(runId: string | undefined): string {
  const cleaned = (runId ?? '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return cleaned ? cleaned.slice(-8) : Date.now().toString(36);
}
