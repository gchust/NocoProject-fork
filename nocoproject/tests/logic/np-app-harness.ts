/**
 * The whole application on an isolated SQLite file, with the real authentication, API key and authorization
 * plugins, for the NocoProject app-level tests (`np-daemon-auth.test.ts`, `np-members-app.test.ts`).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createStandaloneServer,
  type StandaloneServer,
} from '../../server/standalone.ts';

process.env.AUTH_SECRET ??= 'test-auth-secret-at-least-32-characters';

export interface NpAppOptions {
  /** Storage directory (uploads, sessions); defaults to the application's own `storage/`. */
  readonly storageDir?: string;
  /** Extra top-level configuration sections merged into the test config file. */
  readonly config?: Readonly<Record<string, unknown>>;
}

export async function startNpApp(
  cleanups: (() => Promise<void> | void)[],
  prefix = 'nocoproject-app-',
  options: NpAppOptions = {},
): Promise<StandaloneServer> {
  const sourceRoot = path.resolve(import.meta.dirname, '../..');
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, 'config.json');
  writeFileSync(
    configFile,
    JSON.stringify({
      auth: { secret: 'test-auth-secret-at-least-32-characters' },
      database: {
        default: 'main',
        connections: {
          main: {
            dialect: 'sqlite',
            filename: path.join(directory, 'database.sqlite'),
          },
        },
        migrations: { autoRun: true },
        seeds: { autoRun: true },
      },
      hub: { host: { enabled: false } },
      ...options.config,
    }),
  );
  const app = await createStandaloneServer({
    viteDevUrl: false,
    env: {
      DB_DIALECT: 'sqlite',
      DB_MIGRATIONS_AUTO_RUN: 'true',
      DB_SEEDS_AUTO_RUN: 'true',
      APP_CONFIG_FILE: configFile,
    },
    paths: {
      rootDir: sourceRoot,
      serverDir: path.join(sourceRoot, 'server'),
      databaseDir: path.join(sourceRoot, 'database'),
      clientDir: path.join(sourceRoot, 'dist/client'),
      storageDir: options.storageDir ?? path.join(sourceRoot, 'storage'),
    },
  });
  cleanups.push(() => app.close());
  return app;
}

/** The `name=value` pairs of a response's Set-Cookie headers, as a Cookie header. */
export function cookiesOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((header) => header.split(';')[0])
    .join('; ');
}
