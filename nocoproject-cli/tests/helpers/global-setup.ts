import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Builds dist/ once so e2e tests run the real bundle (cli.js + echo-agent.js). */
export default function setup(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  execFileSync(join(root, 'node_modules', '.bin', 'tsup'), [], { cwd: root, stdio: 'pipe' });
}
