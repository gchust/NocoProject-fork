import type { Command } from 'commander';
import { HttpClient, HttpError, NetworkError } from '../api/client.js';
import { configPath, loadConfig, normalizeServerUrl, readStoredConfig, writeStoredConfig } from '../config.js';
import { registerSecret } from '../util/redact.js';
import { CliError, EXIT, failAndExit, printJson, printLine } from './output.js';

/**
 * `nocoproject login` saves the server and a credential. The daemon's credential is the computer credential issued by
 * "Add a computer" (`--computer-key`, NP-150), which only reaches `/np/daemon/*`; saving one removes a personal API key
 * from the config unless `--keep-api-key`. A personal API key (`--api-key`) is for `nocoproject user …`, and for older
 * servers the daemon falls back to it.
 */

/**
 * The API key from stdin. Piped input is read to EOF (`printf '%s' "$KEY" | nocoproject login --api-key-stdin`);
 * on a terminal the command prompts and reads one line without echoing it, so the key never lands in the
 * shell history or on screen.
 */
async function readStdin(what = 'the API key'): Promise<string> {
  if (process.stdin.isTTY) return readSecretLine(`Paste ${what} and press Enter: `);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function readSecretLine(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const finish = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u0003') return finish(new CliError('cancelled', EXIT.validation, 'CANCELLED'));
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function healthy(serverUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/api/healthz`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch (error) {
    throw new NetworkError((error as Error).message, 'GET', '/api/healthz');
  }
}

/** Finds the application URL: the given one, or `<origin>/main` when the mount path was omitted. */
async function resolveServerUrl(input: string): Promise<string> {
  const url = normalizeServerUrl(input);
  if (await healthy(url)) return url;
  if (new URL(url).pathname === '/' || new URL(url).pathname === '') {
    const withMain = `${url}/main`;
    if (await healthy(withMain)) return withMain;
  }
  throw new CliError(`no NocoBase application answered at ${url}/api/healthz (pass the app URL including its mount path, e.g. http://127.0.0.1:13000/main)`, EXIT.notFound, 'SERVER_NOT_FOUND');
}

async function verifyKey(serverUrl: string, apiKey: string): Promise<string | undefined> {
  const client = new HttpClient(serverUrl, { kind: 'apiKey', apiKey }, 10_000);
  try {
    const me = await client.data<{ userId?: string; name?: string }>('GET', '/np/me');
    return me?.name ?? me?.userId;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return undefined;
    throw error;
  }
}

/** Checks a computer credential on the daemon API (`GET /np/daemon/compatibility`); false on a server from before it. */
async function verifyComputerKey(serverUrl: string, computerKey: string): Promise<boolean> {
  const client = new HttpClient(serverUrl, { kind: 'computerKey', computerKey }, 10_000);
  try {
    await client.data('GET', '/np/daemon/compatibility');
    return true;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return false;
    throw error;
  }
}

interface LoginOptions {
  server: string;
  apiKey?: string;
  apiKeyStdin?: boolean;
  computerKey?: string;
  computerKeyStdin?: boolean;
  keepApiKey?: boolean;
  deviceName?: string;
  verify: boolean;
  json?: boolean;
}

export function registerLoginCommand(program: Command): void {
  program
    .command('login')
    .description('Save the server URL and a credential: the computer credential for the daemon, or your API key for user commands')
    .requiredOption('--server <url>', 'application URL including the mount path, e.g. http://127.0.0.1:13000/main')
    .option('--computer-key <key>', 'computer credential from "Add a computer" (the daemon uses it; only reaches the daemon API)')
    .option('--computer-key-stdin', 'read the computer credential from stdin')
    .option('--keep-api-key', 'keep a saved personal API key when saving a computer credential')
    .option('--api-key <key>', 'personal NocoBase API key, for `nocoproject user …` (or set NOCOPROJECT_API_KEY, or use --api-key-stdin)')
    .option('--api-key-stdin', 'read the API key from stdin')
    .option('--device-name <name>', 'name shown for this machine')
    .option('--no-verify', 'save without contacting the server')
    .option('--json', 'JSON output')
    .action(async (opts: LoginOptions) => {
      try {
        const computerKey = opts.computerKeyStdin ? await readStdin('the computer credential') : opts.computerKey;
        const apiKey = computerKey ? undefined : opts.apiKeyStdin ? await readStdin() : (opts.apiKey ?? process.env.NOCOPROJECT_API_KEY);
        if (!computerKey && !apiKey)
          throw new CliError('a credential is required: --computer-key(-stdin) from "Add a computer", or --api-key(-stdin) for user commands', EXIT.validation, 'API_KEY_REQUIRED');
        registerSecret(computerKey ?? apiKey);
        let serverUrl = normalizeServerUrl(opts.server);
        let user: string | undefined;
        let verified = false;
        if (opts.verify) {
          serverUrl = await resolveServerUrl(serverUrl);
          if (computerKey) verified = await verifyComputerKey(serverUrl, computerKey);
          else {
            user = await verifyKey(serverUrl, apiKey!);
            verified = true;
          }
        }
        const stored = readStoredConfig();
        const next = computerKey
          ? { ...stored, serverUrl, computerKey, ...(opts.keepApiKey ? {} : { apiKey: undefined }) }
          : { ...stored, serverUrl, apiKey };
        const removedApiKey = !!computerKey && !opts.keepApiKey && !!stored.apiKey;
        writeStoredConfig({ ...next, ...(opts.deviceName ? { deviceName: opts.deviceName } : {}) });
        const cfg = loadConfig({ ...process.env, NOCOPROJECT_SERVER_URL: '', NOCOPROJECT_API_KEY: '', NOCOPROJECT_COMPUTER_KEY: '' });
        const result = {
          serverUrl,
          credential: computerKey ? 'computer' : 'personalKey',
          user: user ?? null,
          verified,
          removedApiKey,
          daemonId: cfg.daemonId,
          deviceName: cfg.deviceName,
          configPath: configPath(),
        };
        if (opts.json) printJson(result);
        else {
          printLine(`Saved ${result.configPath} (mode 0600).`);
          printLine(`Server: ${serverUrl}${user ? ` — signed in as ${user}` : ''}${computerKey ? ' — computer credential' : ''}`);
          if (computerKey && opts.verify && !verified) printLine('Note: this server predates computer credentials; the daemon will be refused until it is upgraded.');
          if (removedApiKey) printLine('Removed the personal API key from this computer; `nocoproject user …` needs `nocoproject login --api-key-stdin` again.');
          printLine(computerKey ? 'Next: nocoproject daemon install' : 'Next: nocoproject daemon install (better: add this computer in the app and log in with --computer-key-stdin)');
        }
      } catch (error) {
        failAndExit(error, Boolean(opts.json));
      }
    });
}
