// @vitest-environment node
/**
 * Knowledge base v0 (iteration-3 contract §B) on a real PostgreSQL, through the real route factories: document CRUD,
 * versions and the version conflict, archive, visibility and write permissions (project lead / owner/admin; system
 * level owner/admin) and the project detail's `knowledgeDocs`. Agents and proposals: `np-knowledge-agent.test.ts`.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { NpServices } from '../../server/modules/services.ts';
import type {
  KnowledgeDocDetail,
  KnowledgeDocSummary,
} from '../../server/modules/shared/protocol.ts';
import {
  ALICE,
  BOB,
  CAROL,
  buildServices,
  openNpTestDatabase,
  resetData,
  setRole,
  type NpTestDatabase,
} from './np-harness.ts';
import { browserApi, type ApiCall } from './np-iter3-harness.ts';

const opened = await openNpTestDatabase('np_t_knowledge');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-knowledge] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

let services: NpServices;
let alice: ApiCall;
let bob: ApiCall;
let carol: ApiCall;
let projectId: string;
let privateId: string;

beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  services = buildServices(db.database).services;
  await setRole(db, ALICE, 'owner');
  await setRole(db, BOB, 'member');
  await setRole(db, CAROL, 'member');
  alice = browserApi(services, ALICE);
  bob = browserApi(services, BOB);
  carol = browserApi(services, CAROL);
  projectId = (await services.projects.create(BOB, { name: 'Web' })).id;
  privateId = (
    await services.projects.create(BOB, {
      name: 'Secret',
      visibility: 'members',
    })
  ).id;
});

type Data<T> = { data: T };

async function createDoc(
  api: ApiCall,
  body: Record<string, unknown>,
): Promise<KnowledgeDocDetail> {
  const response = await api<Data<KnowledgeDocDetail>>(
    'POST',
    '/np/knowledge',
    body,
  );
  expect(response.status).toBe(201);
  return response.body.data;
}

describe.skipIf(!db)('knowledge documents (PostgreSQL)', () => {
  it('creates, versions and archives documents with conflicts and permissions', async () => {
    const created = await createDoc(bob, {
      projectId,
      title: 'Coding Conventions',
      summary: 'How we write code',
      content: '# Conventions\n\nUse tabs.',
    });
    expect(created.doc).toMatchObject({
      projectId,
      projectName: 'Web',
      slug: 'coding-conventions',
      version: 1,
      updatedByType: 'user',
      updatedById: BOB.id,
      updatedByName: 'Bob',
      canEdit: true,
      pendingProposalCount: 0,
    });
    expect(created.versions).toHaveLength(1);
    // Derived slugs get a suffix; an explicit duplicate is refused.
    const second = await createDoc(bob, {
      projectId,
      title: 'Coding conventions!',
      content: 'x',
    });
    expect(second.doc.slug).toBe('coding-conventions-2');
    const duplicate = await bob('POST', '/np/knowledge', {
      projectId,
      title: 'Other',
      slug: 'coding-conventions',
      content: 'x',
    });
    expect(duplicate).toMatchObject({
      status: 409,
      body: { code: 'KNOWLEDGE_SLUG_TAKEN' },
    });
    expect(
      (
        await bob('POST', '/np/knowledge', {
          title: 'x',
          slug: 'Bad Slug',
          content: '',
        })
      ).body.code,
    ).toBe('INVALID_SLUG');

    // Writers: project lead or owner/admin; system level only owner/admin.
    expect(
      (
        await carol('POST', '/np/knowledge', {
          projectId,
          title: 'x',
          content: '',
        })
      ).status,
    ).toBe(403);
    expect(
      (await bob('POST', '/np/knowledge', { title: 'System', content: '' }))
        .status,
    ).toBe(403);
    const system = await createDoc(alice, {
      title: 'Glossary',
      content: 'Terms',
    });
    expect(system.doc).toMatchObject({ projectId: null, projectName: null });
    expect(system.doc.canEdit).toBe(true);
    expect(
      (
        await carol<Data<KnowledgeDocDetail>>(
          'GET',
          `/np/knowledge/${system.doc.id}`,
        )
      ).body.data.doc.canEdit,
    ).toBe(false);

    const id = created.doc.id;
    const stale = await bob('PATCH', `/np/knowledge/${id}`, {
      content: 'new',
      expectedVersion: 0,
    });
    expect(stale).toMatchObject({
      status: 409,
      body: { code: 'KNOWLEDGE_VERSION_CONFLICT' },
    });
    expect(
      (await bob('PATCH', `/np/knowledge/${id}`, { content: 'x' })).body.code,
    ).toBe('VERSION_REQUIRED');
    expect(
      (
        await carol('PATCH', `/np/knowledge/${id}`, {
          content: 'x',
          expectedVersion: 1,
        })
      ).status,
    ).toBe(403);
    const updated = await bob<Data<KnowledgeDocDetail>>(
      'PATCH',
      `/np/knowledge/${id}`,
      {
        content: '# Conventions\n\nUse spaces.',
        note: 'switched',
        expectedVersion: 1,
      },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.data.doc.version).toBe(2);
    expect(updated.body.data.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(updated.body.data.versions[0]).toMatchObject({
      authorType: 'user',
      authorName: 'Bob',
      note: 'switched',
    });
    // Nothing changed: no new version.
    const same = await bob<Data<KnowledgeDocDetail>>(
      'PATCH',
      `/np/knowledge/${id}`,
      {
        content: '# Conventions\n\nUse spaces.',
        expectedVersion: 2,
      },
    );
    expect(same.body.data.doc.version).toBe(2);
    const v1 = await carol<Data<{ content: string; version: number }>>(
      'GET',
      `/np/knowledge/${id}/versions/1`,
    );
    expect(v1.body.data).toMatchObject({
      version: 1,
      content: '# Conventions\n\nUse tabs.',
    });
    expect((await carol('GET', `/np/knowledge/${id}/versions/9`)).status).toBe(
      404,
    );

    // Archive: read-only and out of the default list.
    expect((await carol('POST', `/np/knowledge/${id}/archive`)).status).toBe(
      403,
    );
    const archived = await bob<Data<KnowledgeDocDetail>>(
      'POST',
      `/np/knowledge/${id}/archive`,
    );
    expect(archived.body.data.doc.archivedAt).not.toBeNull();
    expect(
      (
        await bob('PATCH', `/np/knowledge/${id}`, {
          content: 'z',
          expectedVersion: 2,
        })
      ).body.code,
    ).toBe('KNOWLEDGE_ARCHIVED');
    const listed = await carol<Data<KnowledgeDocSummary[]>>(
      'GET',
      '/np/knowledge',
    );
    expect(listed.body.data.map((doc) => doc.title)).toEqual([
      'Coding conventions!',
      'Glossary',
    ]);
    expect(listed.body.data[0]).not.toHaveProperty('content');
    const withArchived = await carol<Data<KnowledgeDocSummary[]>>(
      'GET',
      '/np/knowledge?includeArchived=1&q=conventions',
    );
    expect(withArchived.body.data).toHaveLength(2);
    await bob('POST', `/np/knowledge/${id}/unarchive`);
    const systemOnly = await carol<Data<KnowledgeDocSummary[]>>(
      'GET',
      '/np/knowledge?projectId=none',
    );
    expect(systemOnly.body.data.map((doc) => doc.slug)).toEqual(['glossary']);
  });

  it('hides documents of private projects from non-members', async () => {
    const secret = await createDoc(bob, {
      projectId: privateId,
      title: 'Keys',
      content: 'secret',
    });
    expect((await carol('GET', `/np/knowledge/${secret.doc.id}`)).status).toBe(
      404,
    );
    expect(
      (await carol<Data<KnowledgeDocSummary[]>>('GET', '/np/knowledge')).body
        .data,
    ).toEqual([]);
    expect(
      (
        await carol('POST', '/np/knowledge', {
          projectId: privateId,
          title: 'x',
          content: '',
        })
      ).body.code,
    ).toBe('INVALID_PROJECT');
    expect(
      (await alice<Data<KnowledgeDocSummary[]>>('GET', '/np/knowledge')).body
        .data,
    ).toHaveLength(1);
    // The project detail lists the project's own documents.
    const detail = await bob<Data<{ knowledgeDocs: KnowledgeDocSummary[] }>>(
      'GET',
      `/np/projects/${privateId}`,
    );
    expect(detail.body.data.knowledgeDocs.map((doc) => doc.slug)).toEqual([
      'keys',
    ]);
  });
});
