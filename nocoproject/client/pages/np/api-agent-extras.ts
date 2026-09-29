import type { ApiClient } from '@nocobase/app-client';

import { unwrap, unwrapList } from './api-iter2.js';
import type {
  AgentEnvAudit,
  AgentEnvVarValue,
  AgentEnvVarView,
  Skill,
  SkillDetail,
  SkillFile,
  SkillInput,
} from './types.js';

/** Agent environment variables (§G) and skills (§H) of `docs/phase1/iteration-2-contract.md`. */

const id = (value: string): string => encodeURIComponent(value);

// ---------- §G environment variables ----------

export async function fetchAgentEnv(
  api: ApiClient,
  agentId: string,
): Promise<AgentEnvVarView[]> {
  return unwrapList(
    await api.request<unknown>({ path: `np/agents/${id(agentId)}/env` }),
  );
}

export async function setAgentEnv(
  api: ApiClient,
  agentId: string,
  vars: readonly AgentEnvVarValue[],
): Promise<void> {
  await api.request<unknown, { vars: readonly AgentEnvVarValue[] }>({
    path: `np/agents/${id(agentId)}/env`,
    method: 'PUT',
    json: { vars },
  });
}

export async function deleteAgentEnv(
  api: ApiClient,
  agentId: string,
  name: string,
): Promise<void> {
  await api.request<unknown>({
    path: `np/agents/${id(agentId)}/env/${id(name)}`,
    method: 'DELETE',
  });
}

export async function revealAgentEnv(
  api: ApiClient,
  agentId: string,
): Promise<AgentEnvVarValue[]> {
  return unwrapList(
    await api.request<unknown>({
      path: `np/agents/${id(agentId)}/env/reveal`,
      method: 'POST',
    }),
  );
}

export async function fetchAgentEnvAudits(
  api: ApiClient,
  agentId: string,
): Promise<AgentEnvAudit[]> {
  return unwrapList(
    await api.request<unknown>({
      path: `np/agents/${id(agentId)}/env/audits`,
    }),
  );
}

/** `^[A-Z_][A-Z0-9_]*$`, minus the names the daemon keeps for itself (§G). */
export const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;
const RESERVED_ENV_NAMES = new Set(['PATH', 'HOME', 'SHELL']);

export type EnvNameProblem = 'required' | 'pattern' | 'reserved' | null;

export function envNameProblem(name: string): EnvNameProblem {
  if (!name) return 'required';
  if (!ENV_NAME_PATTERN.test(name)) return 'pattern';
  if (RESERVED_ENV_NAMES.has(name) || name.startsWith('NOCOPROJECT_')) {
    return 'reserved';
  }
  return null;
}

/** 8 KB, measured in UTF-8 bytes as the server does. */
export const ENV_VALUE_MAX_BYTES = 8 * 1024;

export function envValueTooLong(value: string): boolean {
  return new TextEncoder().encode(value).length > ENV_VALUE_MAX_BYTES;
}

// ---------- §H skills ----------

export async function fetchSkills(
  api: ApiClient,
  signal?: AbortSignal,
): Promise<Skill[]> {
  return unwrapList(await api.request<unknown>({ path: 'np/skills', signal }));
}

/** `{ skill, files, agents }`, with or without the envelope; a bare skill row reads as a skill without files or agents. */
export function normalizeSkillDetail(body: unknown): SkillDetail {
  const inner = unwrap<Partial<SkillDetail> & Partial<Skill>>(body);
  const skill = (inner.skill ?? inner) as Skill;
  return {
    skill,
    files: [...(inner.files ?? [])].sort((a, b) =>
      a.path.localeCompare(b.path),
    ),
    agents: [...(inner.agents ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
  };
}

/**
 * Strips a leading YAML front matter block (`---` … `---`, as written by the daemon's `skillMarkdown` in
 * `nocoproject-cli/src/daemon/skills.ts`) so the reading view renders the body, not the raw header. Front matter is
 * detected only when it opens the content; a body that merely contains a `---` rule elsewhere is left alone.
 */
export function stripSkillFrontMatter(content: string): string {
  const opening = /^---\r?\n/u.exec(content);
  if (!opening) return content;
  const rest = content.slice(opening[0].length);
  const closing = /\r?\n---[ \t]*\r?\n?/u.exec(rest);
  if (!closing) return content;
  return rest.slice(closing.index + closing[0].length);
}

export async function fetchSkill(
  api: ApiClient,
  skillId: string,
  signal?: AbortSignal,
): Promise<SkillDetail> {
  return normalizeSkillDetail(
    await api.request<unknown>({ path: `np/skills/${id(skillId)}`, signal }),
  );
}

export async function createSkill(
  api: ApiClient,
  input: SkillInput & { readonly name: string },
): Promise<Skill> {
  const detail = normalizeSkillDetail(
    await api.request<unknown, SkillInput>({
      path: 'np/skills',
      method: 'POST',
      json: input,
    }),
  );
  return detail.skill;
}

export async function updateSkill(
  api: ApiClient,
  skillId: string,
  changes: SkillInput,
): Promise<void> {
  await api.request<unknown, SkillInput>({
    path: `np/skills/${id(skillId)}`,
    method: 'PATCH',
    json: changes,
  });
}

export async function deleteSkill(
  api: ApiClient,
  skillId: string,
): Promise<void> {
  await api.request<unknown>({
    path: `np/skills/${id(skillId)}`,
    method: 'DELETE',
  });
}

export async function saveSkillFiles(
  api: ApiClient,
  skillId: string,
  files: readonly Pick<SkillFile, 'path' | 'content'>[],
): Promise<void> {
  await api.request<
    unknown,
    { files: readonly Pick<SkillFile, 'path' | 'content'>[] }
  >({
    path: `np/skills/${id(skillId)}/files`,
    method: 'PUT',
    json: { files },
  });
}

/** A relative path without `..` segments, a leading slash or a backslash (§H). */
export function skillFilePathProblem(
  path: string,
  others: readonly string[],
): 'required' | 'invalid' | 'duplicate' | null {
  const trimmed = path.trim();
  if (!trimmed) return 'required';
  if (
    trimmed.startsWith('/') ||
    trimmed.includes('\\') ||
    trimmed.split('/').some((segment) => segment === '..' || segment === '')
  ) {
    return 'invalid';
  }
  if (others.includes(trimmed)) return 'duplicate';
  return null;
}

export const SKILL_MAX_FILES = 20;
export const SKILL_FILE_MAX_BYTES = 64 * 1024;
