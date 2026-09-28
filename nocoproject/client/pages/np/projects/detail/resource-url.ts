/**
 * A repository URL the CLI can clone: https, ssh (`ssh://`) or scp-style (`git@host:owner/repo`). The daemon checks
 * the URL again against the project's resources before a checkout (§I), so this only catches typos.
 */
export function isGitRepoUrl(value: string): boolean {
  const url = value.trim();
  return (
    /^https?:\/\/[^\s/]+\/\S+$/u.test(url) ||
    /^ssh:\/\/\S+$/u.test(url) ||
    /^[\w.-]+@[\w.-]+:\S+$/u.test(url)
  );
}

/**
 * `owner/repo` on a GitHub host (github.com or an Enterprise host whose name contains "github") from any URL form
 * `isGitRepoUrl` accepts, with the page that adds a webhook to it; `null` for other hosts. Every such repository needs
 * its own webhook, or merged pull requests never reach NocoProject (NP-118).
 */
export function githubRepoOf(
  value: string,
): { readonly fullName: string; readonly webhookSettingsUrl: string } | null {
  const url = value.trim();
  const match =
    /^(?:https?|ssh):\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/u.exec(
      url,
    ) ?? /^[\w.-]+@([\w.-]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/u.exec(url);
  if (!match) return null;
  const [, host, owner, repo] = match;
  if (!host || !owner || !repo || !/github/iu.test(host)) return null;
  return {
    fullName: `${owner}/${repo}`,
    webhookSettingsUrl: `https://${host}/${owner}/${repo}/settings/hooks/new`,
  };
}
