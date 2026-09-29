/**
 * Skills (docs/phase1/iteration-2-contract.md §H): a named SKILL.md body plus up to 20 supporting files (64 KB each),
 * mounted on agents and delivered to the daemon in the claim payload.
 *
 * Every member reads; any member creates; the creator and owner/admin edit and delete. `slug` is derived from the
 * name (lower-case ASCII letters, digits and hyphens, `skill` when nothing is left) and kept unique with a numeric
 * suffix; it does not change on rename, because the daemon writes `<workDir>/.nocoproject/skills/<slug>/`. File paths
 * are relative, use `/`, contain no `..` segment, and may not be `SKILL.md` itself. Deleting a skill unmounts it
 * from every agent.
 */
import type { Actor } from '../shared/activity.js';
import { NP_BUSINESS } from '../shared/access.js';
import {
  allowsOwn,
  forbid,
  scopeIn,
  viewerOf,
  type Viewer,
} from '../shared/authz.js';
import type { Conn, Tx, TxRunner } from '../shared/db.js';
import {
  iso,
  isArrayValue,
  isUniqueViolation,
  now,
  num,
  str,
  unique,
} from '../shared/db.js';
import { invalid, notFound } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import type {
  ClaimedSkill,
  CreateSkillRequest,
  Skill,
  SkillAgentRef,
  SkillDetail,
  SkillFile,
  SkillRef,
  SkillSource,
  UpdateSkillRequest,
} from '../shared/protocol.js';
import { SKILL_MAX_FILE_BYTES, SKILL_MAX_FILES } from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import { optionalText, requiredName } from '../shared/validate.js';

const MAX_CONTENT_LENGTH = 200_000;
const MAX_PATH_LENGTH = 255;
const MAX_SLUG_LENGTH = 64;

export interface SkillService {
  list(actor: Actor): Promise<Skill[]>;
  get(actor: Actor, id: string): Promise<SkillDetail>;
  create(actor: Actor, input: CreateSkillRequest): Promise<SkillDetail>;
  update(
    actor: Actor,
    id: string,
    patch: UpdateSkillRequest,
  ): Promise<SkillDetail>;
  remove(actor: Actor, id: string): Promise<void>;
  putFiles(actor: Actor, id: string, files: unknown): Promise<SkillDetail>;
}

export interface SkillDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly users: UserDirectory;
}

export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/u, '');
  return slug || 'skill';
}

/** A relative path with `/` separators, no `..`, not SKILL.md; 400 otherwise. */
export function validateSkillPath(value: unknown): string {
  const path = typeof value === 'string' ? value.trim() : '';
  const segments = path.split('/');
  if (
    !path ||
    path.length > MAX_PATH_LENGTH ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    /^[A-Za-z]:/u.test(path) ||
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    )
  )
    throw invalid(
      'INVALID_SKILL_PATH',
      `path must be relative, use '/', and contain no '..' (got ${JSON.stringify(path.slice(0, 80))}).`,
    );
  if (path.toLowerCase() === 'skill.md')
    throw invalid(
      'INVALID_SKILL_PATH',
      'SKILL.md is the skill content itself.',
    );
  return path;
}

export function validateSkillFiles(value: unknown): SkillFile[] {
  if (!isArrayValue(value))
    throw invalid(
      'INVALID_FIELD',
      'files must be an array of { path, content }.',
    );
  const list = value as unknown[];
  if (list.length > SKILL_MAX_FILES)
    throw invalid(
      'TOO_MANY_FILES',
      `A skill has at most ${SKILL_MAX_FILES} files.`,
    );
  const result: SkillFile[] = [];
  for (const item of list) {
    const entry = (item ?? {}) as Record<string, unknown>;
    const path = validateSkillPath(entry.path);
    if (typeof entry.content !== 'string')
      throw invalid('INVALID_FIELD', `${path}: content must be a string.`);
    if (Buffer.byteLength(entry.content, 'utf8') > SKILL_MAX_FILE_BYTES)
      throw invalid('FILE_TOO_LARGE', `${path} is larger than 64 KB.`);
    if (result.some((file) => file.path === path))
      throw invalid('INVALID_FIELD', `${path} appears twice.`);
    result.push({ path, content: entry.content });
  }
  return result;
}

function sourceOf(value: unknown): SkillSource {
  return value === 'import' ? 'import' : 'manual';
}

async function decorate(
  deps: SkillDeps,
  conn: Conn,
  viewer: Viewer,
  rows: readonly Record<string, unknown>[],
): Promise<Skill[]> {
  const ids = rows.map((row) => str(row.id) ?? '');
  const count = async (table: 'skillFiles' | 'agentSkills') => {
    if (ids.length === 0) return new Map<string, number>();
    const counted = await conn.query
      .selectFrom(table)
      .select((eb) => ['skillId', eb.fn.countAll().as('count')])
      .where('skillId', 'in', ids)
      .groupBy('skillId')
      .execute();
    return new Map(
      counted.map((row) => [str(row.skillId) ?? '', num(row.count)]),
    );
  };
  const files = await count('skillFiles');
  const agents = await count('agentSkills');
  const names = await deps.users.names(
    conn,
    rows.map((row) => str(row.createdById)),
  );
  return rows.map((row) => {
    const id = str(row.id) ?? '';
    const createdById = str(row.createdById) ?? '';
    return {
      id,
      name: str(row.name) ?? '',
      slug: str(row.slug) ?? '',
      description: str(row.description) ?? '',
      content: str(row.content) ?? '',
      source: sourceOf(row.source),
      createdById,
      createdByName: names.get(createdById) ?? null,
      fileCount: files.get(id) ?? 0,
      agentCount: agents.get(id) ?? 0,
      canEdit: allowsOwn(
        scopeIn(viewer, NP_BUSINESS.skills, 'manage'),
        createdById,
        viewer.userId,
      ),
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  });
}

async function skillFiles(conn: Conn, skillId: string): Promise<SkillFile[]> {
  const rows = await conn.query
    .selectFrom('skillFiles')
    .select(['path', 'content'])
    .where('skillId', '=', skillId)
    .orderBy('path', 'asc')
    .execute();
  return rows.map((row) => ({
    path: str(row.path) ?? '',
    content: str(row.content) ?? '',
  }));
}

/** Agents the skill is mounted on (excludes deleted agents), sorted by name for a stable listing. */
async function agentsForSkill(
  conn: Conn,
  skillId: string,
): Promise<SkillAgentRef[]> {
  const links = await conn.query
    .selectFrom('agentSkills')
    .select('agentId')
    .where('skillId', '=', skillId)
    .execute();
  const agentIds = unique(links.map((row) => str(row.agentId)));
  if (agentIds.length === 0) return [];
  const rows = await conn.query
    .selectFrom('agents')
    .select(['id', 'name'])
    .where('id', 'in', agentIds)
    .where('deletedAt', 'is', null)
    .execute();
  const result = rows.map((row) => ({
    id: str(row.id) ?? '',
    name: str(row.name) ?? '',
  }));
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

async function requireRow(
  conn: Conn,
  id: string,
): Promise<Record<string, unknown>> {
  const row = await conn.query
    .selectFrom('skills')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw notFound('Skill');
  return row;
}

async function detail(
  deps: SkillDeps,
  conn: Conn,
  viewer: Viewer,
  id: string,
): Promise<SkillDetail> {
  const [skill] = await decorate(deps, conn, viewer, [
    await requireRow(conn, id),
  ]);
  return {
    skill: skill,
    files: await skillFiles(conn, id),
    agents: await agentsForSkill(conn, id),
  };
}

async function editable(tx: Tx, actor: Actor, id: string): Promise<Viewer> {
  const viewer = await viewerOf(tx.conn, actor);
  const row = await requireRow(tx.conn, id);
  if (
    !allowsOwn(
      scopeIn(viewer, NP_BUSINESS.skills, 'manage'),
      str(row.createdById),
      viewer.userId,
    )
  )
    forbid('Only the skill creator or an owner/admin may change this skill.');
  return viewer;
}

async function insertSkill(
  deps: SkillDeps,
  tx: Tx,
  viewer: Viewer,
  input: CreateSkillRequest,
): Promise<string> {
  const name = requiredName(input?.name);
  const base = slugify(name);
  const id = deps.ids.next();
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const slug =
      attempt === 1 ? base : `${base.slice(0, MAX_SLUG_LENGTH - 4)}-${attempt}`;
    const taken = await tx.conn.query
      .selectFrom('skills')
      .select('id')
      .where('slug', '=', slug)
      .exists();
    if (taken) continue;
    const timestamp = now();
    try {
      await tx.conn.transaction(async (inner) => {
        await inner.query
          .insertInto('skills')
          .values({
            id,
            name,
            slug,
            description:
              optionalText(input.description, 'description', 10_000) ?? '',
            content:
              optionalText(input.content, 'content', MAX_CONTENT_LENGTH) ?? '',
            source: sourceOf(input.source),
            createdById: viewer.userId,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .execute();
      });
      return id;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  throw invalid(
    'INVALID_NAME',
    'Could not derive a unique slug from this name.',
  );
}

async function replaceFiles(
  deps: SkillDeps,
  tx: Tx,
  skillId: string,
  files: readonly SkillFile[],
): Promise<void> {
  await tx.conn.query
    .deleteFrom('skillFiles')
    .where('skillId', '=', skillId)
    .execute();
  if (files.length === 0) return;
  const timestamp = now();
  await tx.conn.query
    .insertInto('skillFiles')
    .values(
      files.map((file) => ({
        id: deps.ids.next(),
        skillId,
        path: file.path,
        content: file.content,
        createdAt: timestamp,
        updatedAt: timestamp,
      })),
    )
    .execute();
}

export function createSkillService(deps: SkillDeps): SkillService {
  async function get(actor: Actor, id: string): Promise<SkillDetail> {
    const conn = deps.tx.read();
    return detail(deps, conn, await viewerOf(conn, actor), id);
  }
  return {
    async list(actor) {
      const conn = deps.tx.read();
      const viewer = await viewerOf(conn, actor);
      const rows = await conn.query.selectFrom('skills').selectAll().execute();
      // Sorted here, not in SQL: the database collation differs between machines (macOS vs the CI container), which
      // put equal or case-different names in different orders. `localeCompare` is the same everywhere Node runs.
      rows.sort(
        (a, b) =>
          String(a.name).localeCompare(String(b.name), 'en', {
            sensitivity: 'base',
          }) || String(a.slug).localeCompare(String(b.slug), 'en'),
      );
      return decorate(deps, conn, viewer, rows);
    },
    get,
    async create(actor, input) {
      const id = await deps.tx.run(async (tx) =>
        insertSkill(deps, tx, await viewerOf(tx.conn, actor), input),
      );
      return get(actor, id);
    },
    async update(actor, id, patch) {
      await deps.tx.run(async (tx) => {
        await editable(tx, actor, id);
        const values: Record<string, unknown> = {};
        if (patch?.name !== undefined) values.name = requiredName(patch.name);
        if (patch?.description !== undefined)
          values.description =
            optionalText(patch.description, 'description', 10_000) ?? '';
        if (patch?.content !== undefined)
          values.content =
            optionalText(patch.content, 'content', MAX_CONTENT_LENGTH) ?? '';
        if (Object.keys(values).length > 0)
          await tx.conn.query
            .updateTable('skills')
            .set({ ...values, updatedAt: now() })
            .where('id', '=', id)
            .execute();
        tx.emit({ type: 'agents.changed' });
      });
      return get(actor, id);
    },
    async remove(actor, id) {
      await deps.tx.run(async (tx) => {
        await editable(tx, actor, id);
        await tx.conn.query
          .deleteFrom('agentSkills')
          .where('skillId', '=', id)
          .execute();
        await tx.conn.query
          .deleteFrom('skillFiles')
          .where('skillId', '=', id)
          .execute();
        await tx.conn.query.deleteFrom('skills').where('id', '=', id).execute();
        tx.emit({ type: 'agents.changed' });
      });
    },
    async putFiles(actor, id, files) {
      const validated = validateSkillFiles(files);
      await deps.tx.run(async (tx) => {
        await editable(tx, actor, id);
        await replaceFiles(deps, tx, id, validated);
        await tx.conn.query
          .updateTable('skills')
          .set({ updatedAt: now() })
          .where('id', '=', id)
          .execute();
      });
      return get(actor, id);
    },
  };
}

/** Skills mounted on each agent (for agent rows). */
export async function skillRefsForAgents(
  conn: Conn,
  agentIds: readonly string[],
): Promise<Map<string, SkillRef[]>> {
  const result = new Map<string, SkillRef[]>();
  const ids = unique(agentIds);
  if (ids.length === 0) return result;
  const links = await conn.query
    .selectFrom('agentSkills')
    .select(['agentId', 'skillId'])
    .where('agentId', 'in', ids)
    .execute();
  const skillIds = unique(links.map((row) => str(row.skillId)));
  const skills = skillIds.length
    ? await conn.query
        .selectFrom('skills')
        .select(['id', 'name', 'slug'])
        .where('id', 'in', skillIds)
        .execute()
    : [];
  const byId = new Map(
    skills.map((row) => [
      str(row.id) ?? '',
      {
        id: str(row.id) ?? '',
        name: str(row.name) ?? '',
        slug: str(row.slug) ?? '',
      },
    ]),
  );
  for (const link of links) {
    const skill = byId.get(str(link.skillId) ?? '');
    if (!skill) continue;
    const agentId = str(link.agentId) ?? '';
    result.set(agentId, [...(result.get(agentId) ?? []), skill]);
  }
  for (const list of result.values())
    list.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

/** Replaces an agent's skills inside `tx` (every id must exist; 400 otherwise). */
export async function replaceAgentSkills(
  tx: Tx,
  ids: IdSource,
  agentId: string,
  skillIds: readonly string[],
): Promise<void> {
  const wanted = unique(skillIds);
  if (wanted.length > 0) {
    const found = await tx.conn.query
      .selectFrom('skills')
      .select('id')
      .where('id', 'in', wanted)
      .execute();
    const existing = new Set(found.map((row) => str(row.id)));
    const missing = wanted.find((id) => !existing.has(id));
    if (missing)
      throw invalid('INVALID_SKILL', `Skill ${missing} does not exist.`);
  }
  await tx.conn.query
    .deleteFrom('agentSkills')
    .where('agentId', '=', agentId)
    .execute();
  if (wanted.length === 0) return;
  const timestamp = now();
  await tx.conn.query
    .insertInto('agentSkills')
    .values(
      wanted.map((skillId) => ({
        id: ids.next(),
        agentId,
        skillId,
        createdAt: timestamp,
        updatedAt: timestamp,
      })),
    )
    .execute();
}

/** The claim payload's `agent.skills`, with every file. */
export async function claimSkills(
  conn: Conn,
  agentId: string,
): Promise<ClaimedSkill[]> {
  const links = await conn.query
    .selectFrom('agentSkills')
    .select('skillId')
    .where('agentId', '=', agentId)
    .execute();
  const skillIds = unique(links.map((row) => str(row.skillId)));
  if (skillIds.length === 0) return [];
  const rows = await conn.query
    .selectFrom('skills')
    .selectAll()
    .where('id', 'in', skillIds)
    .orderBy('slug', 'asc')
    .execute();
  const files = await conn.query
    .selectFrom('skillFiles')
    .select(['skillId', 'path', 'content'])
    .where('skillId', 'in', skillIds)
    .orderBy('path', 'asc')
    .execute();
  return rows.map((row) => {
    const id = str(row.id) ?? '';
    return {
      id,
      slug: str(row.slug) ?? '',
      name: str(row.name) ?? '',
      description: str(row.description) ?? '',
      content: str(row.content) ?? '',
      files: files
        .filter((file) => str(file.skillId) === id)
        .map((file) => ({
          path: str(file.path) ?? '',
          content: str(file.content) ?? '',
        })),
    };
  });
}
