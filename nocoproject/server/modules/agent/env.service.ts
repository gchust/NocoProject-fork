/**
 * Agent environment variables and their audit trail (docs/phase1/iteration-2-contract.md §G).
 *
 * Values are stored encrypted (`shared/crypto.ts`) and only ever leave the server decrypted in two places: `reveal`
 * (owner/admin, audited) and the daemon's claim payload (`claimEnv`). Listing shows names only. The agent owner and
 * owner/admin may list, set and delete; reveal and the audit list are owner/admin only. Set and delete record an
 * audit row with the names touched.
 */
import type { Actor } from '../shared/activity.js';
import {
  canEditAgent,
  forbid,
  isAdmin,
  viewerOf,
  type Viewer,
} from '../shared/authz.js';
import type { SecretBox } from '../shared/crypto.js';
import type { Conn, Tx, TxRunner } from '../shared/db.js';
import { fromJson, iso, isArrayValue, now, str, toJson } from '../shared/db.js';
import { invalid, notFound } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import type {
  AgentEnvAudit,
  AgentEnvAuditAction,
  AgentEnvRevealItem,
  AgentEnvVarInput,
  AgentEnvVarView,
} from '../shared/protocol.js';
import {
  AGENT_ENV_MAX_VALUE_BYTES,
  AGENT_ENV_NAME_PATTERN,
  RESERVED_ENV_NAMES,
  RESERVED_ENV_PREFIX,
} from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';

const MAX_NAME_LENGTH = 128;
const MAX_VARS_PER_AGENT = 100;
const AUDIT_LIMIT = 100;

export interface AgentEnvService {
  list(actor: Actor, agentId: string): Promise<AgentEnvVarView[]>;
  put(actor: Actor, agentId: string, vars: unknown): Promise<AgentEnvVarView[]>;
  remove(actor: Actor, agentId: string, name: string): Promise<void>;
  reveal(actor: Actor, agentId: string): Promise<AgentEnvRevealItem[]>;
  audits(actor: Actor, agentId: string): Promise<AgentEnvAudit[]>;
}

export interface AgentEnvDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly users: UserDirectory;
  readonly secrets: SecretBox;
}

/** 400 unless `name` is a legal, non-reserved variable name. */
export function validateEnvName(name: unknown): string {
  if (
    typeof name !== 'string' ||
    name.length > MAX_NAME_LENGTH ||
    !AGENT_ENV_NAME_PATTERN.test(name)
  )
    throw invalid(
      'INVALID_ENV_NAME',
      'name must match ^[A-Z_][A-Z0-9_]*$ (at most 128 characters).',
    );
  if (name.startsWith(RESERVED_ENV_PREFIX) || RESERVED_ENV_NAMES.includes(name))
    throw invalid('RESERVED_ENV_NAME', `${name} is reserved.`);
  return name;
}

export function validateEnvVars(value: unknown): AgentEnvVarInput[] {
  if (!isArrayValue(value) || (value as unknown[]).length > MAX_VARS_PER_AGENT)
    throw invalid(
      'INVALID_FIELD',
      `vars must be an array of at most ${MAX_VARS_PER_AGENT} { name, value }.`,
    );
  const result: AgentEnvVarInput[] = [];
  for (const item of value as unknown[]) {
    const entry = (item ?? {}) as Record<string, unknown>;
    const name = validateEnvName(entry.name);
    if (typeof entry.value !== 'string')
      throw invalid('INVALID_ENV_VALUE', `${name}: value must be a string.`);
    if (Buffer.byteLength(entry.value, 'utf8') > AGENT_ENV_MAX_VALUE_BYTES)
      throw invalid('INVALID_ENV_VALUE', `${name}: value is larger than 8 KB.`);
    if (result.some((existing) => existing.name === name))
      throw invalid('INVALID_FIELD', `${name} appears twice.`);
    result.push({ name, value: entry.value });
  }
  return result;
}

/** Decrypted variables for the daemon's claim payload (reserved names are skipped defensively). */
export async function claimEnv(
  conn: Conn,
  secrets: SecretBox,
  agentId: string,
): Promise<Record<string, string>> {
  const rows = await conn.query
    .selectFrom('agentEnvVars')
    .select(['name', 'valueEncrypted'])
    .where('agentId', '=', agentId)
    .orderBy('name', 'asc')
    .execute();
  const env: Record<string, string> = {};
  for (const row of rows) {
    const name = str(row.name) ?? '';
    if (
      name.startsWith(RESERVED_ENV_PREFIX) ||
      RESERVED_ENV_NAMES.includes(name)
    )
      continue;
    try {
      env[name] = secrets.decrypt(str(row.valueEncrypted) ?? '');
    } catch {
      // Sealed with another key: leave it out rather than failing the claim.
    }
  }
  return env;
}

async function requireAgent(
  conn: Conn,
  agentId: string,
): Promise<{ ownerUserId: string }> {
  const row = await conn.query
    .selectFrom('agents')
    .select(['id', 'ownerUserId'])
    .where('id', '=', agentId)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (!row) throw notFound('Agent');
  return { ownerUserId: str(row.ownerUserId) ?? '' };
}

async function authorize(
  conn: Conn,
  actor: Actor,
  agentId: string,
  level: 'edit' | 'admin',
): Promise<Viewer> {
  const viewer = await viewerOf(conn, actor);
  const agent = await requireAgent(conn, agentId);
  if (level === 'admin' ? !isAdmin(viewer) : !canEditAgent(viewer, agent))
    forbid(
      level === 'admin'
        ? 'Only an owner or admin may reveal environment variables or read their audit.'
        : 'Only the agent owner or an owner/admin may manage its environment variables.',
    );
  return viewer;
}

async function audit(
  tx: Tx,
  ids: IdSource,
  input: {
    agentId: string;
    userId: string;
    action: AgentEnvAuditAction;
    names: string[];
  },
): Promise<void> {
  const timestamp = now();
  await tx.conn.query
    .insertInto('agentEnvAudits')
    .values({
      id: ids.next(),
      agentId: input.agentId,
      userId: input.userId,
      action: input.action,
      names: toJson(input.names),
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .execute();
}

async function listVars(
  deps: AgentEnvDeps,
  conn: Conn,
  agentId: string,
): Promise<AgentEnvVarView[]> {
  const rows = await conn.query
    .selectFrom('agentEnvVars')
    .select(['name', 'updatedAt', 'updatedById'])
    .where('agentId', '=', agentId)
    .orderBy('name', 'asc')
    .execute();
  const names = await deps.users.names(
    conn,
    rows.map((row) => str(row.updatedById)),
  );
  return rows.map((row) => ({
    name: str(row.name) ?? '',
    updatedAt: iso(row.updatedAt),
    updatedByName: names.get(str(row.updatedById) ?? '') ?? null,
  }));
}

async function put(
  deps: AgentEnvDeps,
  actor: Actor,
  agentId: string,
  value: unknown,
): Promise<AgentEnvVarView[]> {
  const vars = validateEnvVars(value);
  await deps.tx.run(async (tx) => {
    const viewer = await authorize(tx.conn, actor, agentId, 'edit');
    for (const item of vars) {
      const timestamp = now();
      const encrypted = deps.secrets.encrypt(item.value);
      const updated = await tx.conn.query
        .updateTable('agentEnvVars')
        .set({
          valueEncrypted: encrypted,
          updatedById: viewer.userId,
          updatedAt: timestamp,
        })
        .where('agentId', '=', agentId)
        .where('name', '=', item.name)
        .execute();
      if ((updated.updatedCount ?? 0) > 0) continue;
      await tx.conn.query
        .insertInto('agentEnvVars')
        .values({
          id: deps.ids.next(),
          agentId,
          name: item.name,
          valueEncrypted: encrypted,
          updatedById: viewer.userId,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .execute();
    }
    if (vars.length > 0)
      await audit(tx, deps.ids, {
        agentId,
        userId: viewer.userId,
        action: 'set',
        names: vars.map((item) => item.name),
      });
    tx.emit({ type: 'agents.changed' });
  });
  return listVars(deps, deps.tx.read(), agentId);
}

export function createAgentEnvService(deps: AgentEnvDeps): AgentEnvService {
  return {
    async list(actor, agentId) {
      const conn = deps.tx.read();
      await authorize(conn, actor, agentId, 'edit');
      return listVars(deps, conn, agentId);
    },
    put: (actor, agentId, vars) => put(deps, actor, agentId, vars),
    async remove(actor, agentId, name) {
      await deps.tx.run(async (tx) => {
        const viewer = await authorize(tx.conn, actor, agentId, 'edit');
        const result = await tx.conn.query
          .deleteFrom('agentEnvVars')
          .where('agentId', '=', agentId)
          .where('name', '=', name)
          .execute();
        if ((result.deletedCount ?? 0) === 0)
          throw notFound('Environment variable');
        await audit(tx, deps.ids, {
          agentId,
          userId: viewer.userId,
          action: 'delete',
          names: [name],
        });
        tx.emit({ type: 'agents.changed' });
      });
    },
    async reveal(actor, agentId) {
      return deps.tx.run(async (tx) => {
        const viewer = await authorize(tx.conn, actor, agentId, 'admin');
        const env = await claimEnv(tx.conn, deps.secrets, agentId);
        const items = Object.entries(env).map(([name, value]) => ({
          name,
          value,
        }));
        await audit(tx, deps.ids, {
          agentId,
          userId: viewer.userId,
          action: 'reveal',
          names: items.map((item) => item.name),
        });
        return items;
      });
    },
    async audits(actor, agentId) {
      const conn = deps.tx.read();
      await authorize(conn, actor, agentId, 'admin');
      const rows = await conn.query
        .selectFrom('agentEnvAudits')
        .selectAll()
        .where('agentId', '=', agentId)
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc')
        .limit(AUDIT_LIMIT)
        .execute();
      const names = await deps.users.names(
        conn,
        rows.map((row) => str(row.userId)),
      );
      return rows.map((row) => ({
        id: str(row.id) ?? '',
        agentId,
        userId: str(row.userId) ?? '',
        userName: names.get(str(row.userId) ?? '') ?? null,
        action: (str(row.action) ?? 'set') as AgentEnvAuditAction,
        names: fromJson<string[]>(row.names) ?? [],
        createdAt: iso(row.createdAt),
      }));
    },
  };
}
