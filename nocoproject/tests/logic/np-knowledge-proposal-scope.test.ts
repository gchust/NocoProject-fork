// @vitest-environment node
/** NP-168: new proposals inherit a visible parent's scope without widening agent or decider permissions. */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { NpServices } from '../../server/modules/services.ts';
import {
  KNOWLEDGE_MAX_DEPTH,
  type KnowledgeDocDetail,
  type KnowledgeProposal,
} from '../../server/modules/shared/protocol.ts';
import {
  ALICE,
  BOB,
  buildServices,
  openNpTestDatabase,
  resetData,
  rows,
  setRole,
  type NpTestDatabase,
} from './np-harness.ts';
import {
  agentKnowledgeApi,
  browserApi,
  claimedRun,
  type ApiCall,
} from './np-iter3-harness.ts';

const opened = await openNpTestDatabase('np_t_knowledge_proposal_scope');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn('[np-knowledge-proposal-scope] skipped: ' + skip);
const db = (skip ? null : opened) as NpTestDatabase | null;
afterAll(async () => {
  await db?.close();
});

type Data<T> = { data: T };
let services: NpServices;
let alice: ApiCall;
let bob: ApiCall;
let projectId: string;

beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  services = buildServices(db.database).services;
  await setRole(db, ALICE, 'owner');
  await setRole(db, BOB, 'member');
  alice = browserApi(services, ALICE);
  bob = browserApi(services, BOB);
  projectId = (await services.projects.create(BOB, { name: 'Web' })).id;
});

async function createDoc(body: Record<string, unknown>) {
  const response = await alice<Data<KnowledgeDocDetail>>(
    'POST',
    '/np/knowledge',
    {
      title: 'Parent',
      content: 'Parent content',
      ...body,
    },
  );
  expect(response.status).toBe(201);
  return response.body.data.doc;
}

async function setup(withProject = true) {
  const project = await createDoc({ projectId, slug: 'project-parent' });
  const system = await createDoc({ slug: 'system-parent' });
  const issue = await services.issues.create(ALICE, {
    title: 'Write a chapter',
    projectId: withProject ? projectId : null,
  });
  const run = await claimedRun(services, ALICE, issue.id);
  return {
    project,
    system,
    run,
    agent: agentKnowledgeApi(services, run.token),
  };
}

async function propose(agent: ApiCall, body: Record<string, unknown> = {}) {
  return agent<Data<KnowledgeProposal>>('POST', '/knowledge/proposals', {
    title: 'Chapter',
    content: 'Chapter content',
    reason: 'Document this workflow.',
    ...body,
  });
}

async function accept(api: ApiCall, proposal: KnowledgeProposal) {
  const accepted = await api<Data<KnowledgeProposal>>(
    'POST',
    '/np/knowledge/proposals/' + proposal.id + '/accept',
  );
  expect(accepted.status).toBe(200);
  expect(accepted.body.data.status).toBe('accepted');
  const detail = await api<Data<KnowledgeDocDetail>>(
    'GET',
    '/np/knowledge/' + accepted.body.data.docId,
  );
  expect(detail.status).toBe(200);
  return { accepted: accepted.body.data, detail: detail.body.data };
}

describe.skipIf(!db)('knowledge proposal parent scope (PostgreSQL)', () => {
  it.each(['system', 'project', 'root'] as const)(
    'inherits the %s scope through proposal and acceptance',
    async (scope) => {
      const { project, system, run, agent } = await setup();
      const parent =
        scope === 'system' ? system : scope === 'project' ? project : null;
      const expectedProject = scope === 'system' ? null : projectId;
      const response = await propose(
        agent,
        parent ? { parentId: parent.slug } : {},
      );
      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({
        projectId: expectedProject,
        isNew: true,
        status: 'pending',
      });
      expect(
        await rows(db!, 'knowledge_docs', "slug = 'chapter'"),
      ).toHaveLength(0);
      const { detail } = await accept(
        scope === 'system' ? alice : bob,
        response.body.data,
      );
      expect(detail.doc).toMatchObject({
        projectId: expectedProject,
        parentId: parent?.id ?? null,
        version: 1,
        content: 'Chapter content',
        updatedByType: 'agent',
      });
      expect(detail.versions[0]).toMatchObject({
        sourceRunId: run.runId,
        proposalId: response.body.data.id,
      });
    },
  );

  it('keeps a projectless run at the system root', async () => {
    const { agent } = await setup(false);
    const response = await propose(agent);
    expect(response.status).toBe(201);
    expect(response.body.data.projectId).toBeNull();
    const { detail } = await accept(alice, response.body.data);
    expect(detail.doc).toMatchObject({ projectId: null, parentId: null });
  });

  it.each(['system', 'project', 'empty-system'] as const)(
    'preserves an explicit matching %s scope',
    async (scope) => {
      const { agent, system, project } = await setup();
      const parent = scope === 'project' ? project : system;
      const explicit =
        scope === 'project' ? projectId : scope === 'system' ? null : '';
      const response = await propose(agent, {
        parentId: parent.id,
        projectId: explicit,
      });
      expect(response.status).toBe(201);
      expect(response.body.data.projectId).toBe(parent.projectId);
      const { detail } = await accept(
        scope === 'project' ? bob : alice,
        response.body.data,
      );
      expect(detail.doc).toMatchObject({
        projectId: parent.projectId,
        parentId: parent.id,
      });
    },
  );

  it.each(['system', 'project'] as const)(
    'rejects an explicit scope conflicting with a %s parent',
    async (scope) => {
      const { agent, system, project } = await setup();
      const response = await propose(agent, {
        parentId: scope === 'system' ? system.id : project.id,
        projectId: scope === 'system' ? projectId : null,
      });
      expect(response).toMatchObject({
        status: 400,
        body: { code: 'INVALID_PARENT' },
      });
      expect(await rows(db!, 'knowledge_proposals')).toHaveLength(0);
    },
  );

  it('hides out-of-run parents and rejects explicit out-of-run scopes', async () => {
    const { agent } = await setup();
    const otherProject = await services.projects.create(ALICE, {
      name: 'Other',
    });
    const other = await createDoc({
      projectId: otherProject.id,
      slug: 'other-parent',
    });
    for (const parentId of [other.id, other.slug, 'missing-parent']) {
      expect((await propose(agent, { parentId })).status).toBe(404);
    }
    expect(await propose(agent, { projectId: otherProject.id })).toMatchObject({
      status: 403,
      body: { code: 'FORBIDDEN' },
    });
    expect(await rows(db!, 'knowledge_proposals')).toHaveLength(0);
    expect(await rows(db!, 'knowledge_docs', "slug = 'chapter'")).toHaveLength(
      0,
    );
  });

  it('rejects archived parents and excessive depth in the inherited system scope', async () => {
    const { agent, system } = await setup();
    const archived = await createDoc({ slug: 'archived-parent' });
    expect(
      (await alice('POST', '/np/knowledge/' + archived.id + '/archive')).status,
    ).toBe(200);
    expect(await propose(agent, { parentId: archived.id })).toMatchObject({
      status: 409,
      body: { code: 'KNOWLEDGE_ARCHIVED' },
    });
    let parent = system;
    for (let depth = 1; depth < KNOWLEDGE_MAX_DEPTH; depth++) {
      parent = await createDoc({ slug: 'level-' + depth, parentId: parent.id });
    }
    expect(await propose(agent, { parentId: parent.id })).toMatchObject({
      status: 400,
      body: { code: 'KNOWLEDGE_DEPTH_EXCEEDED' },
    });
    expect(await rows(db!, 'knowledge_proposals')).toHaveLength(0);
  });

  it('resolves a shared slug in the run project and a system parent by id', async () => {
    const { agent } = await setup();
    const system = await createDoc({ slug: 'shared' });
    const project = await createDoc({ projectId, slug: 'shared' });
    const local = await propose(agent, {
      parentId: 'shared',
      slug: 'local-child',
    });
    const global = await propose(agent, {
      parentId: system.id,
      slug: 'global-child',
    });
    expect(local.status).toBe(201);
    expect(global.status).toBe(201);
    expect((await accept(bob, local.body.data)).detail.doc).toMatchObject({
      projectId,
      parentId: project.id,
    });
    expect((await accept(alice, global.body.data)).detail.doc).toMatchObject({
      projectId: null,
      parentId: system.id,
    });
  });

  it('checks existing slugs and pending duplicates in the inherited scope', async () => {
    const { agent, system, project } = await setup();
    await createDoc({ projectId, slug: 'chapter' });
    await createDoc({ slug: 'system-taken' });
    expect(
      await propose(agent, { parentId: system.id, slug: 'system-taken' }),
    ).toMatchObject({
      status: 409,
      body: { code: 'KNOWLEDGE_SLUG_TAKEN' },
    });
    expect((await propose(agent, { parentId: system.id })).status).toBe(201);
    expect(await propose(agent, { parentId: system.id })).toMatchObject({
      status: 409,
      body: { code: 'KNOWLEDGE_PROPOSAL_PENDING' },
    });
    expect(
      (await propose(agent, { parentId: system.id, slug: 'shared-pending' }))
        .status,
    ).toBe(201);
    expect(
      (await propose(agent, { parentId: project.id, slug: 'shared-pending' }))
        .status,
    ).toBe(201);
    expect(
      await propose(agent, { parentId: project.id, slug: 'shared-pending' }),
    ).toMatchObject({
      status: 409,
      body: { code: 'KNOWLEDGE_PROPOSAL_PENDING' },
    });
  });

  it('keeps system proposal decisions with system deciders, not the source project lead', async () => {
    const { agent, system } = await setup();
    const response = await propose(agent, { parentId: system.id });
    expect(response.status).toBe(201);
    const id = response.body.data.id;
    const cards = async (as: typeof ALICE) =>
      (await services.inbox.list(as, { kind: 'decision' })).data.filter(
        (item) =>
          item.type === 'knowledge_proposal' && item.payload?.proposalId === id,
      );
    expect(await cards(BOB)).toHaveLength(0);
    expect(await cards(ALICE)).toHaveLength(1);
    expect((await cards(ALICE))[0].payload).toMatchObject({
      projectId: null,
      isNew: true,
    });
    expect(
      await bob('POST', '/np/knowledge/proposals/' + id + '/accept'),
    ).toMatchObject({
      status: 403,
      body: { code: 'FORBIDDEN' },
    });
    expect(await rows(db!, 'knowledge_docs', "slug = 'chapter'")).toHaveLength(
      0,
    );
    const { detail } = await accept(alice, response.body.data);
    expect(detail.doc).toMatchObject({ projectId: null, parentId: system.id });
  });

  it('keeps the inherited system scope when an archived parent forces root fallback', async () => {
    const { agent, system } = await setup();
    const response = await propose(agent, { parentId: system.id });
    expect(response.status).toBe(201);
    expect(
      (await alice('POST', '/np/knowledge/' + system.id + '/archive')).status,
    ).toBe(200);
    const { detail, accepted } = await accept(alice, response.body.data);
    expect(detail.doc).toMatchObject({ projectId: null, parentId: null });
    expect(accepted.comment).toContain('filed at the root');
  });
});
