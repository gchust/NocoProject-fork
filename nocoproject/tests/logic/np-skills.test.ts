// @vitest-environment node
/**
 * Skills (iteration-2 contract §H) on a real PostgreSQL: CRUD and permissions, slugs, file rules and limits, mounting
 * on agents, unmounting on delete, and the skills in the daemon's claim payload.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  slugify,
  validateSkillPath,
} from '../../server/modules/skill/skill.service.ts';
import type { NpServices } from '../../server/modules/services.ts';
import {
  ALICE,
  BOB,
  CAROL,
  buildServices,
  claimOne,
  createAgent,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  setRole,
  type NpTestDatabase,
} from './np-harness.ts';

describe('skill slugs and paths (pure)', () => {
  it('derives ASCII slugs', () => {
    expect(slugify('Code Review!')).toBe('code-review');
    expect(slugify('  Déjà vu  ')).toBe('deja-vu');
    expect(slugify('代码审查')).toBe('skill');
  });

  it('accepts relative paths only', () => {
    expect(validateSkillPath('scripts/run.sh')).toBe('scripts/run.sh');
    for (const bad of [
      '/etc/passwd',
      '../x',
      'a/../b',
      'a//b',
      'C:/x',
      'a\\b',
      'SKILL.md',
      'skill.MD',
      '',
      './a',
    ])
      expect(() => validateSkillPath(bad)).toThrow(
        expect.objectContaining({ code: 'INVALID_SKILL_PATH' }),
      );
  });
});

const opened = await openNpTestDatabase('np_t_skills');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-skills] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

let services: NpServices;

beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  services = buildServices(db.database).services;
  await setRole(db, ALICE, 'owner');
  await setRole(db, BOB, 'member');
  await setRole(db, CAROL, 'member');
});

describe.skipIf(!db)('skills (PostgreSQL)', () => {
  it('creates, reads, updates and deletes with creator / admin permissions and unique slugs', async () => {
    const created = await services.skills.create(BOB, {
      name: 'Code Review',
      description: 'How we review',
      content: '# Review\nCheck tests.',
    });
    expect(created.skill).toMatchObject({
      slug: 'code-review',
      source: 'manual',
      createdById: BOB.id,
      createdByName: 'Bob',
      fileCount: 0,
      canEdit: true,
    });
    const second = await services.skills.create(CAROL, { name: 'code review' });
    expect(second.skill.slug).toBe('code-review-2');
    expect(
      (await services.skills.get(CAROL, created.skill.id)).skill.canEdit,
    ).toBe(false);
    expect(
      (await services.skills.list(CAROL)).map((skill) => skill.slug),
    ).toEqual(['code-review', 'code-review-2']);
    await expect(
      services.skills.update(CAROL, created.skill.id, { name: 'X' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const renamed = await services.skills.update(ALICE, created.skill.id, {
      name: 'Reviews',
      content: 'v2',
    });
    expect(renamed.skill).toMatchObject({
      name: 'Reviews',
      slug: 'code-review',
      content: 'v2',
    });
    await expect(
      services.skills.remove(CAROL, created.skill.id),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await services.skills.remove(BOB, created.skill.id);
    await expect(
      services.skills.get(BOB, created.skill.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('replaces files within the limits', async () => {
    const { skill } = await services.skills.create(BOB, { name: 'Deploy' });
    const detail = await services.skills.putFiles(BOB, skill.id, [
      { path: 'scripts/deploy.sh', content: 'echo hi' },
      { path: 'README.md', content: 'notes' },
    ]);
    expect(detail.files.map((file) => file.path)).toEqual([
      'README.md',
      'scripts/deploy.sh',
    ]);
    expect(detail.skill.fileCount).toBe(2);
    const many = Array.from({ length: 21 }, (_, index) => ({
      path: `f${index}.txt`,
      content: '',
    }));
    await expect(
      services.skills.putFiles(BOB, skill.id, many),
    ).rejects.toMatchObject({ code: 'TOO_MANY_FILES' });
    await expect(
      services.skills.putFiles(BOB, skill.id, [
        { path: 'big.txt', content: 'x'.repeat(64 * 1024 + 1) },
      ]),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    await expect(
      services.skills.putFiles(BOB, skill.id, [
        { path: '../escape', content: '' },
      ]),
    ).rejects.toMatchObject({ code: 'INVALID_SKILL_PATH' });
    await expect(
      services.skills.putFiles(CAROL, skill.id, []),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await services.skills.putFiles(BOB, skill.id, [])).files).toEqual(
      [],
    );
  });

  it('mounts skills on agents, delivers them in the claim payload and unmounts them on delete', async () => {
    const fixture = await registerRuntime(services, BOB);
    const agentId = await createAgent(services, BOB, fixture.runtimeId, 'Dev');
    const review = await services.skills.create(BOB, {
      name: 'Review',
      description: 'd',
      content: 'SKILL body',
    });
    await services.skills.putFiles(BOB, review.skill.id, [
      { path: 'check.md', content: 'steps' },
    ]);
    const other = await services.skills.create(CAROL, { name: 'Other' });
    await expect(
      services.agents.update(BOB, agentId, { skillIds: ['missing'] }),
    ).rejects.toMatchObject({
      code: 'INVALID_SKILL',
    });
    const agent = await services.agents.update(BOB, agentId, {
      skillIds: [review.skill.id, other.skill.id],
    });
    expect(agent.skillIds).toHaveLength(2);
    expect(agent.skills.map((skill) => skill.slug)).toEqual([
      'other',
      'review',
    ]);
    const reviewDetail = await services.skills.get(BOB, review.skill.id);
    expect(reviewDetail.skill.agentCount).toBe(1);
    expect(reviewDetail.agents).toEqual([{ id: agentId, name: 'Dev' }]);
    expect((await services.skills.get(BOB, other.skill.id)).agents).toEqual([
      { id: agentId, name: 'Dev' },
    ]);
    await services.issues.create(BOB, {
      title: 'Work',
      executor: { type: 'agent', id: agentId },
    });
    const claimed = await claimOne(services, BOB, fixture);
    expect(claimed?.agent.skills).toEqual([
      {
        id: other.skill.id,
        slug: 'other',
        name: 'Other',
        description: '',
        content: '',
        files: [],
      },
      {
        id: review.skill.id,
        slug: 'review',
        name: 'Review',
        description: 'd',
        content: 'SKILL body',
        files: [{ path: 'check.md', content: 'steps' }],
      },
    ]);
    await services.skills.remove(CAROL, other.skill.id);
    expect((await services.agents.get(BOB, agentId)).skillIds).toEqual([
      review.skill.id,
    ]);
  });
});
