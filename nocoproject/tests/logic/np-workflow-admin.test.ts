// @vitest-environment node
/**
 * The admin write `PUT /np/workflows/:id` (NP-77 stage 2, no page) and the rule that agents cannot bypass proposals,
 * on a real PostgreSQL: owner/admin only, system templates refused, optimistic lock on `revision`, the same
 * validation and compatibility checks, a revision snapshot credited to the admin, and the new definition in effect at
 * once. The seed marks both seeded templates as system templates.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type {
  WorkflowListItemV5,
  WorkflowRevision,
} from '../../server/modules/shared/protocol.ts';
import {
  ALICE,
  CAROL,
  openNpTestDatabase,
  rows,
  type NpTestDatabase,
} from './np-harness.ts';
import {
  CODE_REVIEW,
  definitionWith,
  insertTemplate,
  moveTo,
  projectOn,
  setupWorld,
  world,
} from './np-workflow-harness.ts';

const opened = await openNpTestDatabase('np_t_workflow_admin');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-workflow-admin] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  if (db) await setupWorld(db);
});

type Data<T> = { data: T };

describe.skipIf(!db)('workflow template admin write (PostgreSQL)', () => {
  it('seeds both seeded templates as system templates at revision 1', async () => {
    const templates = await rows(
      db!,
      'workflow_templates',
      '1 = 1 ORDER BY id',
    );
    expect(
      templates.map((row) => [row.id, row.is_system, row.revision]),
    ).toEqual([
      ['default', true, 1],
      ['software-with-approval', true, 1],
    ]);
  });

  it('lets an owner/admin replace a definition under the revision lock, effective at once', async () => {
    const custom = await insertTemplate(definitionWith(), 'Ops flow');
    const projectId = await projectOn(custom);
    const issue = await world.services.issues.create(ALICE, {
      title: 'Work',
      projectId,
      statusKey: 'in_progress',
    });
    const body = {
      definition: definitionWith([CODE_REVIEW]),
      revision: 1,
      note: 'Add code review by hand',
    };
    expect(
      (await world.bob('PUT', `/np/workflows/${custom}`, body)).status,
    ).toBe(403);
    const written = await world.carol<Data<WorkflowListItemV5>>(
      'PUT',
      `/np/workflows/${custom}`,
      body,
    );
    expect(written.status).toBe(200);
    expect(written.body.data).toMatchObject({
      revision: 2,
      name: 'Ops flow',
      projectCount: 1,
    });
    await moveTo(ALICE, issue.id, 'code_review');

    const stale = await world.alice('PUT', `/np/workflows/${custom}`, body);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('REVISION_CONFLICT');
    const revisions = await world.alice<Data<WorkflowRevision[]>>(
      'GET',
      `/np/workflows/${custom}/revisions`,
    );
    expect(revisions.body.data[0]).toMatchObject({
      revision: 2,
      proposalId: null,
      note: 'Add code review by hand',
      createdByType: 'user',
      createdById: CAROL.id,
    });

    // Removing the status the issue is in now is refused like a proposal would be.
    const removing = await world.alice('PUT', `/np/workflows/${custom}`, {
      definition: definitionWith(),
      revision: 2,
    });
    expect(removing.status).toBe(409);
    expect(removing.body.code).toBe('WORKFLOW_STATUS_CONFLICT');
  });

  it('refuses system templates, missing revisions, invalid definitions and unknown templates', async () => {
    const custom = await insertTemplate(definitionWith());
    const system = await world.alice('PUT', '/np/workflows/default', {
      definition: definitionWith([CODE_REVIEW]),
      revision: 1,
    });
    expect(system.status).toBe(409);
    expect(system.body.code).toBe('WORKFLOW_SYSTEM_TEMPLATE');
    expect(
      (
        await world.alice('PUT', `/np/workflows/${custom}`, {
          definition: definitionWith(),
        })
      ).body.code,
    ).toBe('REVISION_REQUIRED');
    expect(
      (
        await world.alice('PUT', `/np/workflows/${custom}`, {
          definition: { statuses: [] },
          revision: 1,
        })
      ).body.code,
    ).toBe('INVALID_WORKFLOW');
    expect(
      (
        await world.alice('PUT', '/np/workflows/missing', {
          definition: definitionWith(),
          revision: 1,
        })
      ).status,
    ).toBe(404);
  });

  it('gives agents no way to write a template other than a proposal', async () => {
    const custom = await insertTemplate(definitionWith());
    const put = await world.agent('PUT', `/workflows/${custom}`, {
      definition: definitionWith([CODE_REVIEW]),
      revision: 1,
    });
    expect(put.status).toBe(403);
    await expect(
      world.services.workflowProposals.update(
        { type: 'agent', id: world.run.agentId },
        custom,
        { definition: definitionWith([CODE_REVIEW]), revision: 1 },
      ),
    ).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(
      world.services.workflowProposals.decide(
        { type: 'agent', id: world.run.agentId },
        'p1',
        'accept',
        {},
      ),
    ).rejects.toMatchObject({ kind: 'forbidden' });
    const template = await world.alice<Data<WorkflowListItemV5>>(
      'GET',
      `/np/workflows/${custom}`,
    );
    expect(template.body.data.revision).toBe(1);
  });
});
