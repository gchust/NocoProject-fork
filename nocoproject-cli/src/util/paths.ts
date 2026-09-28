import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedRoot: string | null | undefined;

function packageRoot(): string | null {
  if (cachedRoot !== undefined) return cachedRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if ((JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === 'nocoproject-cli') return (cachedRoot = dir);
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return (cachedRoot = null);
}

/**
 * Absolute path of a built file (`cli.js`, `echo-agent.js`). Works both from the bundle
 * (files sit next to each other in dist/) and from sources (falls back to <pkg>/dist).
 */
export function distPath(name: string): string {
  if (process.env.NOCOPROJECT_DIST_DIR) return join(process.env.NOCOPROJECT_DIST_DIR, name);
  const here = join(dirname(fileURLToPath(import.meta.url)), name);
  if (existsSync(here)) return here;
  const root = packageRoot();
  return root ? join(root, 'dist', name) : here;
}
