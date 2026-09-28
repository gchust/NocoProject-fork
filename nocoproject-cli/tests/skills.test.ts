import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../src/daemon/adapters/claude.js';
import { EchoAdapter } from '../src/daemon/adapters/echo.js';
import { safeSkillPath, skillMarkdown, writeSkills } from '../src/daemon/skills.js';
import type { ClaimedSkill } from '../src/protocol.js';

const skill = (slug: string, extra: Partial<ClaimedSkill> = {}): ClaimedSkill => ({
  id: `id-${slug}`,
  slug,
  name: slug.toUpperCase(),
  description: `About ${slug}`,
  content: `# ${slug}\n\nBody of ${slug}.`,
  files: [],
  ...extra,
});

describe('skills on disk', () => {
  it('validates file paths', () => {
    expect(safeSkillPath('scripts/run.sh')).toBe('scripts/run.sh');
    expect(safeSkillPath('./a.md')).toBe('a.md');
    for (const bad of ['../x', 'a/../../x', 'a/..', '/etc/passwd', 'C:/x', 'a\\b', '', 'a//b']) expect(safeSkillPath(bad)).toBeNull();
  });

  it('adds front matter unless the body has its own', () => {
    expect(skillMarkdown(skill('deploy', { description: 'Two\nlines "quoted"' }))).toBe('---\nname: deploy\ndescription: "Two lines \\"quoted\\""\n---\n\n# deploy\n\nBody of deploy.\n');
    expect(skillMarkdown(skill('x', { content: '---\nname: x\n---\nbody' }))).toBe('---\nname: x\n---\nbody\n');
  });

  it('rebuilds .nocoproject/skills each run, rejecting unsafe paths and slugs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ncp-skills-'));
    const first = writeSkills(dir, [
      skill('deploy', { files: [{ path: 'scripts/deploy.sh', content: 'echo hi\n' }, { path: '../escape.txt', content: 'no' }, { path: '/abs.txt', content: 'no' }, { path: 'SKILL.md', content: 'ignored' }] }),
      skill('old'),
      skill('../bad'),
    ]);
    const root = join(dir, '.nocoproject', 'skills');
    expect(first.skills.map((s) => s.path)).toEqual(['.nocoproject/skills/deploy/SKILL.md', '.nocoproject/skills/old/SKILL.md']);
    expect(first.warnings).toEqual(['rejected skill slug "../bad"', 'skill deploy: rejected file path "../escape.txt"', 'skill deploy: rejected file path "/abs.txt"']);
    expect(readFileSync(join(root, 'deploy', 'scripts', 'deploy.sh'), 'utf8')).toBe('echo hi\n');
    expect(readFileSync(join(root, 'deploy', 'SKILL.md'), 'utf8')).toContain('# deploy');
    expect(existsSync(join(dir, '.nocoproject', 'escape.txt'))).toBe(false);
    expect(existsSync(join(dir, '.claude'))).toBe(false);

    writeFileSync(join(root, 'deploy', 'stale.txt'), 'left over');
    writeSkills(dir, [skill('deploy')]);
    expect(existsSync(join(root, 'old'))).toBe(false);
    expect(existsSync(join(root, 'deploy', 'stale.txt'))).toBe(false);
    expect(existsSync(join(root, 'deploy', 'scripts'))).toBe(false);
    writeSkills(dir, []);
    expect(existsSync(root)).toBe(false);
  });

  it('copies skills into the native directory and removes only the ones it wrote', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ncp-skills-native-'));
    const native = join(dir, '.claude', 'skills');
    mkdirSync(join(native, 'mine'), { recursive: true });
    writeFileSync(join(native, 'mine', 'SKILL.md'), 'user skill');
    writeSkills(dir, [skill('deploy', { files: [{ path: 'ref.md', content: 'ref' }] }), skill('lint')], '.claude/skills');
    expect(readFileSync(join(native, 'deploy', 'SKILL.md'), 'utf8')).toBe(readFileSync(join(dir, '.nocoproject', 'skills', 'deploy', 'SKILL.md'), 'utf8'));
    expect(readFileSync(join(native, 'deploy', 'ref.md'), 'utf8')).toBe('ref');
    writeSkills(dir, [skill('deploy')], '.claude/skills');
    expect(existsSync(join(native, 'lint'))).toBe(false);
    expect(existsSync(join(native, 'deploy', 'ref.md'))).toBe(false);
    expect(readFileSync(join(native, 'mine', 'SKILL.md'), 'utf8')).toBe('user skill');
  });

  it('only the Claude adapter asks for a native skills directory', () => {
    expect(new ClaudeAdapter().capabilities().nativeSkillsDir).toBe('.claude/skills');
    expect(new EchoAdapter().capabilities().nativeSkillsDir).toBeUndefined();
  });
});
