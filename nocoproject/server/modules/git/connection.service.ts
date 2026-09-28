/**
 * The GitHub connection (docs/phase1/iteration-2-contract.md §C): one row in `gitConnections` (provider `github`),
 * managed by owner/admin. The token and the webhook secret are stored encrypted (`shared/crypto.ts`) and never
 * returned; the view only says whether each is set.
 */
import type { Actor } from '../shared/activity.js';
import { forbid, isAdmin, viewerOf } from '../shared/authz.js';
import type { Conn, Tx, TxRunner } from '../shared/db.js';
import { isoOrNull, now, str } from '../shared/db.js';
import { conflict, invalid, NpError } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import type { SecretBox } from '../shared/crypto.js';
import type {
  GitConnectionTestResponse,
  GitConnectionView,
  UpdateGitConnectionRequest,
} from '../shared/protocol.js';
import {
  GitHubApiError,
  type GitHubClient,
  type GitHubCredentials,
} from './github-client.js';

export const DEFAULT_GITHUB_API = 'https://api.github.com';
const PROVIDER = 'github';
const MAX_SECRET_LENGTH = 4096;

export interface GitConnectionService {
  view(actor: Actor, webhookUrl: string): Promise<GitConnectionView>;
  update(
    actor: Actor,
    input: UpdateGitConnectionRequest,
    webhookUrl: string,
  ): Promise<GitConnectionView>;
  /** `GET /user` with the stored token; 409 `GITHUB_NOT_CONFIGURED` without one. */
  test(actor: Actor): Promise<GitConnectionTestResponse>;
}

export interface GitConnectionDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly secrets: SecretBox;
  readonly github: GitHubClient;
}

export interface StoredConnection {
  readonly id: string;
  readonly apiBaseUrl: string;
  readonly token: string | null;
  readonly webhookSecret: string | null;
  readonly lastEventAt: string | null;
}

/** The stored connection with its secrets decrypted, or null when none is configured. */
export async function loadConnection(
  conn: Conn,
  secrets: SecretBox,
): Promise<StoredConnection | null> {
  const row = await conn.query
    .selectFrom('gitConnections')
    .selectAll()
    .where('provider', '=', PROVIDER)
    .executeTakeFirst();
  if (!row) return null;
  const open = (value: unknown): string | null => {
    const text = str(value);
    if (!text) return null;
    try {
      return secrets.decrypt(text);
    } catch {
      // Sealed with another key (the secret key changed): treat as not set rather than failing every request.
      return null;
    }
  };
  return {
    id: str(row.id) ?? '',
    apiBaseUrl: str(row.apiBaseUrl) || DEFAULT_GITHUB_API,
    token: open(row.tokenEncrypted),
    webhookSecret: open(row.webhookSecretEncrypted),
    lastEventAt: isoOrNull(row.lastEventAt),
  };
}

export function credentialsOf(
  connection: StoredConnection | null,
): (GitHubCredentials & { connectionId: string }) | null {
  if (!connection?.token) return null;
  return {
    apiBaseUrl: connection.apiBaseUrl,
    token: connection.token,
    connectionId: connection.id,
  };
}

/** Maps GitHub failures to domain errors without echoing anything GitHub sent. */
export function githubError(error: unknown): NpError {
  if (error instanceof GitHubApiError) {
    if (error.status === 401 || error.status === 403)
      return conflict(
        'GITHUB_AUTH_FAILED',
        'GitHub rejected the configured token.',
      );
    if (error.status === 404)
      return new NpError(
        'notFound',
        'GITHUB_NOT_FOUND',
        'GitHub does not know this pull request (or the token cannot see it).',
      );
  }
  return new NpError(
    'upstream',
    'GITHUB_REQUEST_FAILED',
    'The request to GitHub failed.',
  );
}

async function requireAdmin(conn: Conn, actor: Actor): Promise<void> {
  if (!isAdmin(await viewerOf(conn, actor)))
    forbid('Only an owner or admin may manage the GitHub connection.');
}

function toView(
  connection: StoredConnection | null,
  webhookUrl: string,
): GitConnectionView {
  return {
    configured: !!connection?.token,
    apiBaseUrl: connection?.apiBaseUrl ?? DEFAULT_GITHUB_API,
    tokenSet: !!connection?.token,
    webhookSecretSet: !!connection?.webhookSecret,
    webhookUrl,
    lastEventAt: connection?.lastEventAt ?? null,
  };
}

function secretValue(
  secrets: SecretBox,
  value: unknown,
  field: string,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > MAX_SECRET_LENGTH)
    throw invalid('INVALID_FIELD', `${field} must be a string.`);
  return value.trim() === '' ? null : secrets.encrypt(value.trim());
}

function apiBaseUrlValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string')
    throw invalid('INVALID_URL', 'apiBaseUrl must be a URL.');
  if (value.trim() === '') return DEFAULT_GITHUB_API;
  if (!/^https?:\/\/[^\s]+$/u.test(value.trim()) || value.length > 500)
    throw invalid('INVALID_URL', 'apiBaseUrl must be an http(s) URL.');
  return value.trim().replace(/\/+$/u, '');
}

async function update(
  deps: GitConnectionDeps,
  tx: Tx,
  actor: Actor,
  input: UpdateGitConnectionRequest,
): Promise<void> {
  const values: Record<string, unknown> = {};
  const apiBaseUrl = apiBaseUrlValue(input?.apiBaseUrl);
  if (apiBaseUrl !== undefined) values.apiBaseUrl = apiBaseUrl;
  const token = secretValue(deps.secrets, input?.token, 'token');
  if (token !== undefined) values.tokenEncrypted = token;
  const secret = secretValue(
    deps.secrets,
    input?.webhookSecret,
    'webhookSecret',
  );
  if (secret !== undefined) values.webhookSecretEncrypted = secret;
  const existing = await tx.conn.query
    .selectFrom('gitConnections')
    .select('id')
    .where('provider', '=', PROVIDER)
    .executeTakeFirst();
  const timestamp = now();
  if (existing) {
    if (Object.keys(values).length > 0)
      await tx.conn.query
        .updateTable('gitConnections')
        .set({ ...values, updatedAt: timestamp })
        .where('id', '=', existing.id)
        .execute();
    return;
  }
  await tx.conn.query
    .insertInto('gitConnections')
    .values({
      id: deps.ids.next(),
      provider: PROVIDER,
      name: 'GitHub',
      apiBaseUrl: DEFAULT_GITHUB_API,
      tokenEncrypted: null,
      webhookSecretEncrypted: null,
      createdById: actor.id,
      lastEventAt: null,
      ...values,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .execute();
}

export function createGitConnectionService(
  deps: GitConnectionDeps,
): GitConnectionService {
  return {
    async view(actor, webhookUrl) {
      const conn = deps.tx.read();
      await requireAdmin(conn, actor);
      return toView(await loadConnection(conn, deps.secrets), webhookUrl);
    },
    async update(actor, input, webhookUrl) {
      await deps.tx.run(async (tx) => {
        await requireAdmin(tx.conn, actor);
        await update(deps, tx, actor, input);
      });
      return toView(
        await loadConnection(deps.tx.read(), deps.secrets),
        webhookUrl,
      );
    },
    async test(actor) {
      const conn = deps.tx.read();
      await requireAdmin(conn, actor);
      const credentials = credentialsOf(
        await loadConnection(conn, deps.secrets),
      );
      if (!credentials)
        throw conflict(
          'GITHUB_NOT_CONFIGURED',
          'No GitHub token is configured.',
        );
      try {
        const user = await deps.github.getAuthenticatedUser(credentials);
        return { ok: true, login: user.login, scopes: user.scopes };
      } catch (error) {
        throw githubError(error);
      }
    },
  };
}
