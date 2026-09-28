import type { Command } from 'commander';
import { HttpClient, HttpError, NetworkError } from '../api/client.js';
import { configPath, loadConfig, normalizeServerUrl, readStoredConfig, writeStoredConfig } from '../config.js';
import { registerSecret } from '../util/redact.js';
import { CliError, EXIT, failAndExit, printJson, printLine } from './output.js';

/**
 * The API key from stdin. Piped input is read to EOF (`printf '%s' "$KEY" | nocoproject login --api-key-stdin`);
 * on a terminal the command prompts and reads one line without echoing it, so the key never lands in the
 * shell history or on screen.
 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return readSecretLine('Paste the API key and press Enter: ');
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

export function registerLoginCommand(program: Command): void {
  program
    .command('login')
    .description('Save the server URL and API key used by the daemon')
    .requiredOption('--server <url>', 'application URL including the mount path, e.g. http://127.0.0.1:13000/main')
    .option('--api-key <key>', 'NocoBase API key (or set NOCOPROJECT_API_KEY, or use --api-key-stdin)')
    .option('--api-key-stdin', 'read the API key from stdin')
    .option('--device-name <name>', 'name shown for this machine')
    .option('--no-verify', 'save without contacting the server')
    .option('--json', 'JSON output')
    .action(async (opts: { server: string; apiKey?: string; apiKeyStdin?: boolean; deviceName?: string; verify: boolean; json?: boolean }) => {
      try {
        const apiKey = opts.apiKeyStdin ? await readStdin() : (opts.apiKey ?? process.env.NOCOPROJECT_API_KEY);
        if (!apiKey) throw new CliError('an API key is required (--api-key, --api-key-stdin or NOCOPROJECT_API_KEY)', EXIT.validation, 'API_KEY_REQUIRED');
        registerSecret(apiKey);
        let serverUrl = normalizeServerUrl(opts.server);
        let user: string | undefined;
        if (opts.verify) {
          serverUrl = await resolveServerUrl(serverUrl);
          user = await verifyKey(serverUrl, apiKey);
        }
        const stored = readStoredConfig();
        writeStoredConfig({ ...stored, serverUrl, apiKey, ...(opts.deviceName ? { deviceName: opts.deviceName } : {}) });
        const cfg = loadConfig({ ...process.env, NOCOPROJECT_SERVER_URL: '', NOCOPROJECT_API_KEY: '' });
        const result = { serverUrl, user: user ?? null, verified: opts.verify, daemonId: cfg.daemonId, deviceName: cfg.deviceName, configPath: configPath() };
        if (opts.json) printJson(result);
        else {
          printLine(`Saved ${result.configPath} (mode 0600).`);
          printLine(`Server: ${serverUrl}${user ? ` — signed in as ${user}` : ''}`);
          printLine('Next: nocoproject daemon start');
        }
      } catch (error) {
        failAndExit(error, Boolean(opts.json));
      }
    });
}
