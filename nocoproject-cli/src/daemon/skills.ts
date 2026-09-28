/**
 * Skills on disk (contract §H). Every run rebuilds `<workDir>/.nocoproject/skills/<slug>/`
 * (SKILL.md plus the skill's files) from the claim payload's `agent.skills`, removing skills that
 * are no longer attached. Adapters with a native skills directory (Claude Code:
 * `.claude/skills/`) get a copy there as well; only directories the daemon wrote before (listed
 * in `.nocoproject/native-skills.json`) are ever removed from that directory.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import type { ClaimedSkill } from '../protocol.js';
import { CONTEXT_DIR } from '../run-context.js';

export const SKILLS_DIR = 'skills';
export const SKILL_FILE = 'SKILL.md';
const NATIVE_MANIFEST = 'native-skills.json';
const SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/** `.nocoproject/skills/<slug>` relative to the workDir (POSIX separators, used in the brief). */
export function skillRelDir(slug: string): string {
  return posix.join(CONTEXT_DIR, SKILLS_DIR, slug);
}

/**
 * Validates a skill file path: relative, no `..` segment, no empty segment, no backslashes or NUL.
 * Returns the normalized POSIX path or null when the path is rejected.
 */
export function safeSkillPath(path: string): string | null {
  if (typeof path !== 'string' || !path || path.includes('\0') || path.includes('\\')) return null;
  if (isAbsolute(path) || posix.isAbsolute(path) || /^[A-Za-z]:/.test(path)) return null;
  const segments = path.split('/');
  if (segments.some((s) => s === '..' || s === '')) return null;
  const normalized = posix.normalize(path);
  return normalized === '.' || normalized.startsWith('..') ? null : normalized;
}

/** Prepends YAML front matter (name, description) when the body has none, so tools can discover the skill. */
export function skillMarkdown(skill: Pick<ClaimedSkill, 'slug' | 'description' | 'content'>): string {
  const body = skill.content ?? '';
  if (body.startsWith('---\n') || body.startsWith('---\r\n')) return body.endsWith('\n') ? body : `${body}\n`;
  const description = (skill.description ?? '').replace(/\s+/g, ' ').trim();
  const front = ['---', `name: ${skill.slug}`, `description: ${JSON.stringify(description)}`, '---', ''].join('\n');
  return `${front}\n${body}${body.endsWith('\n') ? '' : '\n'}`;
}

export interface WrittenSkill {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  /** `.nocoproject/skills/<slug>/SKILL.md`, relative to the workDir. */
  readonly path: string;
}

export interface WriteSkillsResult {
  readonly skills: readonly WrittenSkill[];
  /** Human-readable problems (rejected slugs or paths); the rest of the skills are still written. */
  readonly warnings: readonly string[];
}

function writeSkillDir(dir: string, skill: ClaimedSkill, warnings: string[]): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const file of skill.files ?? []) {
    const rel = safeSkillPath(file.path);
    if (!rel) {
      warnings.push(`skill ${skill.slug}: rejected file path ${JSON.stringify(file.path)}`);
      continue;
    }
    if (rel === SKILL_FILE) continue; // SKILL.md always comes from `content`
    const target = resolve(dir, rel);
    const within = relative(dir, target);
    if (!within || within.startsWith('..') || isAbsolute(within) || within.split(sep).includes('..')) {
      warnings.push(`skill ${skill.slug}: rejected file path ${JSON.stringify(file.path)}`);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content ?? '');
  }
  writeFileSync(join(dir, SKILL_FILE), skillMarkdown(skill));
}

function readManifest(path: string): string[] {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && SLUG.test(v)) : [];
  } catch {
    return [];
  }
}

/** Skills with a usable, unique slug (first one wins), in payload order. Rejections go to `warnings`. */
function acceptedSkills(skills: readonly ClaimedSkill[] | null | undefined, warnings: string[]): ClaimedSkill[] {
  const valid: ClaimedSkill[] = [];
  const seen = new Set<string>();
  for (const skill of skills ?? []) {
    if (!skill || typeof skill.slug !== 'string' || !SLUG.test(skill.slug)) {
      warnings.push(`rejected skill slug ${JSON.stringify(skill?.slug)}`);
      continue;
    }
    if (seen.has(skill.slug)) continue;
    seen.add(skill.slug);
    valid.push(skill);
  }
  return valid;
}

function toWritten(skill: ClaimedSkill): WrittenSkill {
  return { slug: skill.slug, name: skill.name || skill.slug, description: skill.description ?? '', path: posix.join(skillRelDir(skill.slug), SKILL_FILE) };
}

/** The skills the daemon writes for this payload (pure; used by the brief). */
export function validSkills(skills: readonly ClaimedSkill[] | null | undefined): WrittenSkill[] {
  return acceptedSkills(skills, []).map(toWritten);
}

/**
 * Rebuilds the skills of this run. `nativeDir` (relative to the workDir, e.g. `.claude/skills`)
 * receives a copy of every skill for tools that discover skills themselves.
 */
export function writeSkills(workDir: string, skills: readonly ClaimedSkill[] | null | undefined, nativeDir?: string): WriteSkillsResult {
  const warnings: string[] = [];
  const valid = acceptedSkills(skills, warnings);
  const seen = new Set(valid.map((s) => s.slug));

  const root = join(workDir, CONTEXT_DIR, SKILLS_DIR);
  rmSync(root, { recursive: true, force: true });
  if (valid.length > 0) mkdirSync(root, { recursive: true });
  for (const skill of valid) writeSkillDir(join(root, skill.slug), skill, warnings);

  if (nativeDir) {
    const manifest = join(workDir, CONTEXT_DIR, NATIVE_MANIFEST);
    const nativeRoot = join(workDir, nativeDir);
    for (const slug of readManifest(manifest)) {
      if (!seen.has(slug)) rmSync(join(nativeRoot, slug), { recursive: true, force: true });
    }
    for (const skill of valid) writeSkillDir(join(nativeRoot, skill.slug), skill, []);
    mkdirSync(dirname(manifest), { recursive: true, mode: 0o700 });
    if (valid.length > 0 || existsSync(manifest)) writeFileSync(manifest, `${JSON.stringify(valid.map((s) => s.slug))}\n`);
  }

  return { skills: valid.map(toWritten), warnings };
}
