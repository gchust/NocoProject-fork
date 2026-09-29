// @vitest-environment node
/**
 * Knowledge for agents (iteration-3 contract §B) on a real PostgreSQL: the claim payload index and the agent API scope
 * (run project + system level, no archived documents), proposals (one pending per document per run, decider cards
 * with actions, accept → new version / new document, reject, system-level proposals to owner/admin).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { NpServices } from '../../server/modules/services.ts';
import type {
  InboxAction,
  KnowledgeDocDetail,
  KnowledgeDocSummary,
  KnowledgeProposal,
} from '../../server/modules/shared/protocol.ts';
import {
  ALICE,
  BOB,
  CAROL,
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

const opened = await openNpTestDatabase('np_t_knowledge_agent');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-knowledge-agent] skipped: ${skip}`);
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

describe.skipIf(!db)('knowledge for agents and proposals (PostgreSQL)', () => {
  async function setup() {
    const doc = await createDoc(bob, {
      projectId,
      title: 'Deploy',
      summary: 'How to deploy',
      content: 'v1 steps',
    });
    const system = await createDoc(alice, {
      title: 'Glossary',
      content: 'Terms',
    });
    const otherProject = (
      await services.projects.create(ALICE, { name: 'Other' })
    ).id;
    const other = await createDoc(alice, {
      projectId: otherProject,
      title: 'Elsewhere',
      content: 'no',
    });
    const archived = await createDoc(bob, {
      projectId,
      title: 'Old',
      content: 'old',
    });
    await bob('POST', `/np/knowledge/${archived.doc.id}/archive`);
    const issue = await services.issues.create(ALICE, {
      title: 'Ship it',
      projectId,
    });
    const run = await claimedRun(services, ALICE, issue.id);
    return {
      doc,
      system,
      other,
      issue,
      run,
      agent: agentKnowledgeApi(services, run.token),
    };
  }

  it('indexes the run project and system documents in the claim and the agent API', async () => {
    const { doc, system, other, run, agent } = await setup();
    expect(run.knowledge).toEqual([
      {
        id: doc.doc.id,
        slug: 'deploy',
        title: 'Deploy',
        summary: 'How to deploy',
        projectId,
      },
      {
        id: system.doc.id,
        slug: 'glossary',
        title: 'Glossary',
        summary: '',
        projectId: null,
      },
    ]);
    const listed = await agent<Data<KnowledgeDocSummary[]>>(
      'GET',
      '/knowledge',
    );
    expect(listed.body.data.map((item) => item.slug)).toEqual([
      'deploy',
      'glossary',
    ]);
    expect(listed.body.data.every((item) => item.canEdit === false)).toBe(true);
    const bySlug = await agent<Data<{ doc: { id: string; content: string } }>>(
      'GET',
      '/knowledge/deploy',
    );
    expect(bySlug.body.data.doc).toMatchObject({
      id: doc.doc.id,
      content: 'v1 steps',
    });
    expect((await agent('GET', `/knowledge/${system.doc.id}`)).status).toBe(
      200,
    );
    expect((await agent('GET', `/knowledge/${other.doc.id}`)).status).toBe(404);
    expect((await agent('GET', '/knowledge/old')).status).toBe(404);
    const anonymous = agentKnowledgeApi(services, `npr_${'0'.repeat(40)}`);
    expect((await anonymous('GET', '/knowledge')).status).toBe(401);
  });

  it('searches with the same q as the browser list (NP-142)', async () => {
    const { agent } = await setup();
    // "steps" only appears in the document's content ('v1 steps'), not its title, slug or summary.
    const byContent = await agent<Data<KnowledgeDocSummary[]>>(
      'GET',
      '/knowledge?q=steps',
    );
    expect(byContent.body.data.map((item) => item.slug)).toEqual(['deploy']);
    expect(byContent.body.data[0]?.matchExcerpt).toContain('steps');
    // "glossary" is the title of the other document: no excerpt needed.
    const byTitle = await agent<Data<KnowledgeDocSummary[]>>(
      'GET',
      '/knowledge?q=glossary',
    );
    expect(byTitle.body.data.map((item) => item.slug)).toEqual(['glossary']);
    expect(byTitle.body.data[0]).not.toHaveProperty('matchExcerpt');
    expect(
      (await agent<Data<KnowledgeDocSummary[]>>('GET', '/knowledge?q=nope'))
        .body.data,
    ).toEqual([]);
  });

  it('turns proposals into decider cards and new versions', async () => {
    const { doc, issue, run, agent } = await setup();
    const proposed = await agent<Data<KnowledgeProposal>>(
      'POST',
      '/knowledge/proposals',
      {
        docId: 'deploy',
        content: 'v2 steps',
        summary: 'Deploy with the new script',
        reason: 'The old script is gone.',
      },
    );
    expect(proposed.status).toBe(201);
    expect(proposed.body.data).toMatchObject({
      docId: doc.doc.id,
      docTitle: 'Deploy',
      isNew: false,
      baseVersion: 1,
      status: 'pending',
      sourceRunId: run.runId,
      sourceIssueId: issue.id,
      sourceIssueIdentifier: issue.identifier,
      proposedByAgentName: 'Scribe',
      canDecide: false,
    });
    const again = await agent('POST', '/knowledge/proposals', {
      docId: doc.doc.id,
      content: 'v3',
      reason: 'again',
    });
    expect(again).toMatchObject({
      status: 409,
      body: { code: 'KNOWLEDGE_PROPOSAL_PENDING' },
    });
    expect(
      (
        await agent('POST', '/knowledge/proposals', {
          docId: 'deploy',
          content: 'x',
        })
      ).body.code,
    ).toBe('INVALID_REASON');
    expect(
      (
        await agent('POST', '/knowledge/proposals', {
          title: 'Elsewhere doc',
          projectId: privateId,
          content: 'x',
          reason: 'y',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await agent('POST', '/knowledge/proposals', {
          title: 'Deploy',
          content: 'x',
          reason: 'y',
        })
      ).body.code,
    ).toBe('KNOWLEDGE_SLUG_TAKEN');
    const fresh = await agent<Data<KnowledgeProposal>>(
      'POST',
      '/knowledge/proposals',
      {
        title: 'Release checklist',
        content: '- tag\n- notes',
        reason: 'We keep forgetting the notes.',
      },
    );
    expect(fresh.body.data).toMatchObject({
      docId: null,
      isNew: true,
      projectId,
      slug: 'release-checklist',
    });

    // Activity on the source issue; the lead (Bob) gets cards with actions, the owner/admin does not.
    const activity = await rows(
      db!,
      'activities',
      "issue_id = ? AND action = 'knowledge_proposed'",
      [issue.id],
    );
    expect(activity).toHaveLength(2);
    const cards = (
      await services.inbox.list(BOB, { kind: 'decision' })
    ).data.filter((item) => item.type === 'knowledge_proposal');
    expect(cards).toHaveLength(2);
    const card = cards.find(
      (item) => item.payload?.proposalId === proposed.body.data.id,
    )!;
    expect(card.payload).toMatchObject({
      docId: doc.doc.id,
      docTitle: 'Deploy',
      projectId,
      projectName: 'Web',
      reason: 'The old script is gone.',
      summary: 'Deploy with the new script',
      issueId: issue.id,
      identifier: issue.identifier,
      isNew: false,
    });
    expect(
      (card.payload?.actions as InboxAction[]).map((action) => action.key),
    ).toEqual(['accept', 'reject', 'openDoc', 'open']);
    expect(
      (await services.inbox.list(ALICE, { kind: 'decision' })).data.filter(
        (item) => item.type === 'knowledge_proposal',
      ),
    ).toHaveLength(0);

    const pending = await bob<Data<KnowledgeProposal[]>>(
      'GET',
      '/np/knowledge/proposals?status=pending',
    );
    expect(pending.body.data.map((item) => item.canDecide)).toEqual([
      true,
      true,
    ]);
    expect(
      (await carol<Data<KnowledgeProposal[]>>('GET', '/np/knowledge/proposals'))
        .body.data,
    ).toEqual([]);
    expect(
      (await bob('GET', '/np/knowledge/proposals?status=accepted')).body.code,
    ).toBe('INVALID_STATUS');
    const detail = await carol<Data<KnowledgeDocDetail>>(
      'GET',
      `/np/knowledge/${doc.doc.id}`,
    );
    expect(detail.body.data.doc.pendingProposalCount).toBe(1);
    expect(detail.body.data.proposals.map((item) => item.canDecide)).toEqual([
      false,
    ]);

    const path = `/np/knowledge/proposals/${proposed.body.data.id}`;
    expect((await carol('POST', `${path}/accept`)).status).toBe(403);
    const accepted = await bob<Data<KnowledgeProposal>>(
      'POST',
      `${path}/accept`,
      {
        comment: 'Thanks',
      },
    );
    expect(accepted.body.data).toMatchObject({
      status: 'accepted',
      decidedById: BOB.id,
      decidedByName: 'Bob',
      comment: 'Thanks',
      canDecide: false,
    });
    expect((await bob('POST', `${path}/reject`)).body.code).toBe(
      'KNOWLEDGE_PROPOSAL_DECIDED',
    );
    const after = await carol<Data<KnowledgeDocDetail>>(
      'GET',
      `/np/knowledge/${doc.doc.id}`,
    );
    expect(after.body.data.doc).toMatchObject({
      version: 2,
      content: 'v2 steps',
      summary: 'Deploy with the new script',
      title: 'Deploy',
      updatedByType: 'agent',
      updatedByName: 'Scribe',
    });
    expect(after.body.data.versions[0]).toMatchObject({
      version: 2,
      authorType: 'agent',
      authorName: 'Scribe',
      sourceRunId: run.runId,
      proposalId: proposed.body.data.id,
      note: 'Thanks',
    });
    const updatedActivity = await rows(
      db!,
      'activities',
      "issue_id = ? AND action = 'knowledge_updated'",
      [issue.id],
    );
    expect(updatedActivity).toHaveLength(1);
    const bobCards = (await services.inbox.list(BOB, { kind: 'decision' }))
      .data;
    const resolvedCard = bobCards.find((item) => item.id === card.id)!;
    expect(resolvedCard.resolvedAt).not.toBeNull();
    expect(
      (resolvedCard.payload?.actions as InboxAction[]).map(
        (action) => action.key,
      ),
    ).toEqual(['openDoc', 'open']);
    const decided = (
      await services.inbox.list(ALICE, { kind: 'info' })
    ).data.find((item) => item.type === 'knowledge_decided');
    expect(decided?.payload).toMatchObject({
      proposalId: proposed.body.data.id,
      decision: 'accepted',
      version: 2,
      docTitle: 'Deploy',
    });

    // Reject the new-document proposal: nothing is created.
    const rejected = await bob<Data<KnowledgeProposal>>(
      'POST',
      `/np/knowledge/proposals/${fresh.body.data.id}/reject`,
    );
    expect(rejected.body.data.status).toBe('rejected');
    expect(
      await rows(db!, 'knowledge_docs', "slug = 'release-checklist'"),
    ).toHaveLength(0);
  });

  it('sends system-level and lead-less proposals to owner/admin, who can create the document', async () => {
    const { agent } = await setup();
    const proposed = await agent<Data<KnowledgeProposal>>(
      'POST',
      '/knowledge/proposals',
      {
        title: 'Incident playbook',
        projectId: null,
        content: 'Page someone.',
        reason: 'We had an outage.',
      },
    );
    expect(proposed.body.data.projectId).toBeNull();
    expect(
      (await services.inbox.list(BOB, { kind: 'decision' })).data.some(
        (item) => item.type === 'knowledge_proposal',
      ),
    ).toBe(false);
    const card = (
      await services.inbox.list(ALICE, { kind: 'decision' })
    ).data.find((item) => item.type === 'knowledge_proposal');
    expect(card?.payload).toMatchObject({ isNew: true, projectId: null });
    expect(
      (
        await bob(
          'POST',
          `/np/knowledge/proposals/${proposed.body.data.id}/accept`,
        )
      ).status,
    ).toBe(403);
    const accepted = await alice<Data<KnowledgeProposal>>(
      'POST',
      `/np/knowledge/proposals/${proposed.body.data.id}/accept`,
    );
    expect(accepted.body.data.docId).not.toBeNull();
    const created = await carol<Data<KnowledgeDocDetail>>(
      'GET',
      `/np/knowledge/${accepted.body.data.docId}`,
    );
    expect(created.body.data.doc).toMatchObject({
      projectId: null,
      slug: 'incident-playbook',
      version: 1,
      content: 'Page someone.',
      updatedByType: 'agent',
    });
    expect(created.body.data.versions[0]?.proposalId).toBe(
      proposed.body.data.id,
    );
  });

  it('guards accepting a proposal whose document moved on meanwhile (NP-139)', async () => {
    const { doc, agent } = await setup();
    const proposed = await agent<Data<KnowledgeProposal>>(
      'POST',
      '/knowledge/proposals',
      {
        docId: 'deploy',
        content: 'v2 steps',
        reason: 'The old script is gone.',
      },
    );
    expect(proposed.body.data).toMatchObject({
      baseVersion: 1,
      currentVersion: 1,
    });

    // Someone edits the document directly while the proposal is pending.
    await bob('PATCH', `/np/knowledge/${doc.doc.id}`, {
      content: 'v1.5 steps, edited by hand',
      expectedVersion: 1,
    });
    const stillPending = await bob<Data<KnowledgeProposal[]>>(
      'GET',
      '/np/knowledge/proposals?status=pending',
    );
    expect(stillPending.body.data[0]).toMatchObject({
      baseVersion: 1,
      currentVersion: 2,
    });

    const path = `/np/knowledge/proposals/${proposed.body.data.id}`;
    const stale = await bob('POST', `${path}/accept`);
    expect(stale).toMatchObject({
      status: 409,
      body: {
        code: 'KNOWLEDGE_PROPOSAL_STALE',
        details: { currentVersion: 2, baseVersion: 1 },
      },
    });
    // Still pending: the guarded attempt did not apply.
    expect(
      (
        await bob<Data<KnowledgeDocDetail>>(
          'GET',
          `/np/knowledge/${doc.doc.id}`,
        )
      ).body.data.doc.version,
    ).toBe(2);

    const confirmed = await bob<Data<KnowledgeProposal>>(
      'POST',
      `${path}/accept`,
      { confirmStale: true },
    );
    expect(confirmed.body.data.status).toBe('accepted');
    const after = await bob<Data<KnowledgeDocDetail>>(
      'GET',
      `/np/knowledge/${doc.doc.id}`,
    );
    expect(after.body.data.doc).toMatchObject({
      version: 3,
      content: 'v2 steps',
    });
  });
});
