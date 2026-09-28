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
