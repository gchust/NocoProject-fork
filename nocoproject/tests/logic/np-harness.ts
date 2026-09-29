import { AGENT_CAPABILITIES } from '../../server/modules/shared/protocol.capabilities.js';
import {
  LATEST_CLI_VERSION,
  PROTOCOL_VERSION,
} from '../../server/modules/shared/protocol.ts';
/**
 * Real-PostgreSQL harness for the NocoProject integration tests (`np-*.test.ts`).
 *
 * Each test file gets its own schema in the disposable database named by NP_TEST_DATABASE_URL, so files can run in
 * parallel. The schema is dropped and rebuilt from the application's real migration (and seed) sources, then the
 * services are built exactly as the provider builds them. A `user` fixture table stands in for the authentication
 * plugin's table, which the services only read names from.
 *
 * When the database is unreachable the harness reports why, and the calling file skips instead of failing.
 */
import path from 'node:path';

import {
  createDatabaseManager,
  createMigrator,
  createSeeder,
  type DatabaseManager,
} from '@nocobase/db';
import postgres from '@nocobase/db-postgres';
import { SnowflakeIdGenerator } from '@nocobase/snowflake';
import type { Knex } from 'knex';

import {
  createNpServices,
  type NpServiceDeps,
  type NpServices,
} from '../../server/modules/services.ts';
import type { ClaimedRunV2 } from '../../server/modules/run/claim.service.ts';
import {
  createAgentApiRoutes,
  runTokenAuth,
} from '../../server/modules/run/agent-api.routes.ts';
import { createSecretBox } from '../../server/modules/shared/crypto.ts';
import { membersTableRoles } from './np-role-double.ts';
import { guarded } from '../../server/modules/shared/http.ts';
import type { Actor } from '../../server/modules/shared/activity.ts';
import {
  createDomainEventBus,
  type DomainEvent,
} from '../../server/modules/shared/events.ts';

export const NP_TEST_DATABASE_URL =
  process.env.NP_TEST_DATABASE_URL ??
  'postgres://demo:demo123456@127.0.0.1:5432/nocoproject_test';

const ROOT = path.resolve(import.meta.dirname, '../..');
export const MIGRATIONS_DIR = path.join(ROOT, 'database/main/migrations');
export const SEEDS_DIR = path.join(ROOT, 'database/main/seeds');

export const ALICE: Actor = { type: 'user', id: 'u-alice' };
export const BOB: Actor = { type: 'user', id: 'u-bob' };
export const CAROL: Actor = { type: 'user', id: 'u-carol' };

/** Tables of the Phase 1 iteration 1 migration (workflow_templates holds the seeded default template). */
export const NP_PHASE1_TABLES = [
  'members',
  'project_members',
  'project_resources',
  'issue_labels',
  'issue_label_links',
  'issue_dependencies',
  'executor_proposals',
  'issue_subscribers',
  'inbox_items',
  'agent_access_grants',
  'agent_delegation_grants',
] as const;

/** Tables of the Phase 1 iteration 2 migration. */
export const NP_PHASE1_ITER2_TABLES = [
  'git_connections',
  'pull_requests',
  'issue_pull_requests',
  'webhook_deliveries',
  'approval_requests',
  'comment_reactions',
  'agent_env_vars',
  'agent_env_audits',
  'skills',
  'skill_files',
  'agent_skills',
  'intake_batches',
  'intake_drafts',
] as const;

/** Tables of the Phase 1 iteration 3 migration. */
export const NP_PHASE1_ITER3_TABLES = [
  'knowledge_docs',
  'knowledge_doc_versions',
  'knowledge_proposals',
] as const;

/** Tables of the Phase 2 stage actions migration (NP-77). */
export const NP_PHASE2_WORKFLOW_TABLES = ['issue_checklist_items'] as const;
/** NP-78: issue attachments (`2026100400001_np_attachments`). */
export const NP_ATTACHMENT_TABLES = ['np_files'] as const;
/** NP-88: email invitations (`2026100500001_np_invitations`). */
export const NP_INVITATION_TABLES = ['np_invitations'] as const;

/** Tables of the computer credentials migration (NP-150). */
export const NP_COMPUTER_TABLES = ['np_computers'] as const;

/** Tables of the Phase 2 workflow proposals migration (NP-77 stage 2). */
export const NP_PHASE2_PROPOSAL_TABLES = [
  'workflow_template_revisions',
  'workflow_proposals',
] as const;

/** A fixed test key for stored secrets (32 bytes of 0x11). */
export const TEST_SECRET_KEY = Buffer.alloc(32, 0x11);

/** Every table the Phase 0 migration creates, for truncation between tests. */
export const NP_TABLES = [
  'run_tokens',
  'run_usage',
  'run_events',
  'run_sessions',
  'run_triggers',
  'runs',
  'agents',
  'runtimes',
  'activities',
  'comments',
  'issues',
  'projects',
  'system_settings',
] as const;

export interface NpTestDatabase {
  readonly database: DatabaseManager;
  readonly knex: Knex;
  readonly schema: string;
  close(): Promise<void>;
}

export interface NpTestServices {
  readonly services: NpServices;
  readonly events: DomainEvent[];
}

let workerId = 1;

function connectionConfig(schema: string) {
  const url = new URL(NP_TEST_DATABASE_URL);
  return postgres({
    host: url.hostname,
    port: Number(url.port || 5432),
    database: url.pathname.replace(/^\//u, ''),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    schema,
    schemaManagement: 'managed',
    pool: { min: 0, max: 20 },
  });
}

/**
 * Opens (and resets) the file's schema, or returns the reason it cannot. `migrate: false` leaves the schema empty
 * for tests that run the migrator themselves.
 */
export async function openNpTestDatabase(
  schema: string,
  options: { migrate?: boolean } = {},
): Promise<NpTestDatabase | { skip: string }> {
  const database = createDatabaseManager({
    default: 'main',
    connections: { main: connectionConfig(schema) },
  });
  let knex: Knex;
  try {
    knex = await database.connection().client<Knex>();
    await knex.raw('select 1');
  } catch (error) {
    await database.destroy().catch(() => undefined);
    return {
      skip: `NocoProject integration database unreachable at ${NP_TEST_DATABASE_URL}: ${String(error)}`,
    };
  }
  await knex.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await knex.raw(`CREATE SCHEMA "${schema}"`);
  database.collections().invalidate();
  await knex.raw(
    `CREATE TABLE "${schema}"."user" (id varchar(64) PRIMARY KEY, name varchar(255), username varchar(255), ` +
      // Millisecond precision, as the users plugin creates these columns; the repository rejects wider timestamps.
      `email varchar(255), disabled_at timestamp(3), deleted_at timestamp(3))`,
  );
  await knex.raw(
    `INSERT INTO "${schema}"."user" (id, name, username, email) VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)`,
    [
      ALICE.id,
      'Alice',
      'alice',
      'alice@example.com',
      BOB.id,
      'Bob',
      'bob',
      'bob@example.com',
      CAROL.id,
      'Carol',
      'carol',
      'carol@example.com',
    ],
  );
  if (options.migrate !== false) {
    await createMigrator({
      database,
      directory: MIGRATIONS_DIR,
      packageName: 'nocoproject',
    }).latest();
    await createSeeder({
      database,
      directory: SEEDS_DIR,
      packageName: 'nocoproject',
    }).run();
  }
  return {
    database,
    knex,
    schema,
    async close() {
      await database.destroy();
    },
  };
}

/** Test doubles and options for iteration 2 services (GitHub client, AI parser, approval gateway). */
export type NpTestOptions = Partial<
  Pick<
    NpServiceDeps,
    | 'github'
    | 'aiIntake'
    | 'aiConfigured'
    | 'approvalGateway'
    | 'secrets'
    | 'aiProcess'
    | 'fileObjects'
    | 'attachmentText'
    | 'mailer'
    | 'accounts'
  >
>;

export function buildServices(
  database: DatabaseManager,
  options: NpTestOptions = {},
): NpTestServices {
  const events: DomainEvent[] = [];
  const bus = createDomainEventBus((error) => {
    throw error;
  });
  bus.subscribe((event) => events.push(event));
  workerId = (workerId % 31) + 1;
  const services = createNpServices({
    database,
    idGenerator: new SnowflakeIdGenerator({ workerId }),
    bus,
    secrets: createSecretBox(TEST_SECRET_KEY),
    roles: () => membersTableRoles,
    ...options,
  });
  return { services, events };
}

/** Empties every NocoProject table (keeping the seeded workflow template) and restores the settings row. */
export async function resetData(db: NpTestDatabase): Promise<void> {
  await db.knex.raw(
    `TRUNCATE ${[...NP_TABLES, ...NP_PHASE1_TABLES, ...NP_PHASE1_ITER2_TABLES, ...NP_PHASE1_ITER3_TABLES, ...NP_PHASE2_WORKFLOW_TABLES, ...NP_ATTACHMENT_TABLES, ...NP_INVITATION_TABLES, ...NP_PHASE2_PROPOSAL_TABLES, ...NP_COMPUTER_TABLES].map((table) => `"${db.schema}"."${table}"`).join(', ')}`,
  );
  await db.knex.raw(
    `INSERT INTO "${db.schema}".system_settings (id, issue_prefix, issue_counter) VALUES ('default', 'NP', 0)`,
  );
}

/** Sets a member's role directly (tests bypass the ensureMember middleware). */
export async function setRole(
  db: NpTestDatabase,
  actor: Actor,
  role: 'owner' | 'admin' | 'member',
): Promise<void> {
  await db.knex.raw(
    `INSERT INTO "${db.schema}".members (id, user_id, role, joined_at, created_at, updated_at)
     VALUES (?, ?, ?, now(), now(), now())
     ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role`,
    [`m-${actor.id}`, actor.id, role],
  );
}

export async function rows(
  db: NpTestDatabase,
  table: string,
  where = 'true',
  params: readonly unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const result = await db.knex.raw(
    `SELECT * FROM "${db.schema}"."${table}" WHERE ${where}`,
    params as unknown[],
  );
  return (result as { rows: Record<string, unknown>[] }).rows;
}

export interface Fixture {
  readonly runtimeId: string;
  readonly daemonId: string;
}

/** Registers a daemon runtime owned by `owner` (online now). */
export async function registerRuntime(
  services: NpServices,
  owner: Actor,
  daemonId = 'daemon-1',
  provider: 'echo' | 'claude' | 'opencode' = 'echo',
): Promise<Fixture> {
  const response = await services.runtimes.register(owner.id as string, {
    daemonId,
    deviceName: 'test-device',
    version: LATEST_CLI_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    runtimes: [
      {
        provider,
        version: '1.0.0',
        capabilities: { resume: true, steering: false },
      },
    ],
  });
  return { runtimeId: response.runtimes[0]!.id, daemonId };
}

export async function createAgent(
  services: NpServices,
  owner: Actor,
  runtimeId: string,
  name: string,
  maxConcurrentRuns = 6,
): Promise<string> {
  const agent = await services.agents.create(owner, {
    name,
    capabilities: AGENT_CAPABILITIES.filter((c) => c !== 'workspace.read'),
    instructions: `You are ${name}.`,
    runtimeId,
    provider: 'echo',
    maxConcurrentRuns,
  });
  return agent.id;
}

export function mention(agentId: string, name = 'Agent'): string {
  return `[@${name}](mention://agent/${agentId})`;
}

export async function runRows(
  db: NpTestDatabase,
  where = 'true',
): Promise<Record<string, unknown>[]> {
  const result = await db.knex.raw(
    `SELECT * FROM "${db.schema}".runs WHERE ${where} ORDER BY created_at, id`,
  );
  return (result as { rows: Record<string, unknown>[] }).rows;
}

export async function triggerRows(
  db: NpTestDatabase,
  runId: string,
): Promise<Record<string, unknown>[]> {
  const result = await db.knex.raw(
    `SELECT * FROM "${db.schema}".run_triggers WHERE run_id = ? ORDER BY created_at, id`,
    [runId],
  );
  return (result as { rows: Record<string, unknown>[] }).rows;
}

/** Claims one run for the runtime and returns its payload (iteration 2 extras included). */
export async function claimOne(
  services: NpServices,
  owner: Actor,
  fixture: Fixture,
): Promise<ClaimedRunV2 | undefined> {
  const claim = await services.claims.claim(
    owner.id as string,
    {
      configurationProtocol: 1,
      daemonId: fixture.daemonId,
      slots: [{ runtimeId: fixture.runtimeId, free: 1 }],
    },
    'http://test',
  );
  return claim.runs[0] as ClaimedRunV2 | undefined;
}

/** A caller of the agent API (`/np/agent/*` router) holding a run token. */
export function agentApi(services: NpServices, token: string) {
  const router = guarded(
    [runTokenAuth(services.runTokens)],
    createAgentApiRoutes({
      issues: services.issues,
      queries: services.issueQueries,
      comments: services.comments,
      agentIssues: services.agentIssues,
      pullRequests: services.pullRequests,
    }),
  );
  return async (method: string, path: string, body?: unknown) => {
    const response = await router.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as { data: unknown; code?: string },
    };
  };
}
