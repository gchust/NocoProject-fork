/**
 * Helpers shared by the workflow template proposal tests (`np-workflow-proposals`, `np-workflow-admin`, NP-77 stage
 * 2): a fresh world per test (Alice owner, Carol admin, Bob member with a claimed agent run on an issue he owns), the
 * agent workflow routes behind the real run-token guard, custom templates inserted straight into the table, and a
 * project on a template.
 */
import { BUILTIN_DEFINITION } from '../../server/modules/issue/status.ts';
import { runTokenAuth } from '../../server/modules/run/agent-api.routes.ts';
import type { NpServices } from '../../server/modules/services.ts';
import type { Actor } from '../../server/modules/shared/activity.ts';
import { guarded } from '../../server/modules/shared/http.ts';
import type {
  WorkflowDefinitionV5,
  WorkflowStatusDefinitionV5,
} from '../../server/modules/shared/protocol.ts';
import { createAgentWorkflowRoutes } from '../../server/modules/workflow/workflow.routes.ts';
import {
  ALICE,
  BOB,
  CAROL,
  buildServices,
  resetData,
  setRole,
  type NpTestDatabase,
} from './np-harness.ts';
import {
  browserApi,
  claimedRun,
  type ApiCall,
  type ClaimedRunFixture,
} from './np-iter3-harness.ts';

export const world = {} as {
  db: NpTestDatabase;
  services: NpServices;
  alice: ApiCall;
  bob: ApiCall;
  carol: ApiCall;
  run: ClaimedRunFixture;
  issueId: string;
  agent: ApiCall;
};

/** Resets data (templates other than the seeded ones included) and claims a run of Bob's agent on Bob's issue. */
export async function setupWorld(db: NpTestDatabase): Promise<void> {
  await resetData(db);
  await db.knex.raw(
    `DELETE FROM "${db.schema}".workflow_templates WHERE id NOT IN ('default', 'software-with-approval')`,
  );
  world.db = db;
  world.services = buildServices(db.database).services;
  await setRole(db, ALICE, 'owner');
  await setRole(db, BOB, 'member');
  await setRole(db, CAROL, 'admin');
  world.alice = browserApi(world.services, ALICE);
  world.bob = browserApi(world.services, BOB);
  world.carol = browserApi(world.services, CAROL);
  const issue = await world.services.issues.create(BOB, {
    title: 'Change the workflow',
  });
  world.issueId = issue.id;
  world.run = await claimedRun(world.services, BOB, issue.id);
  world.agent = agentWorkflowApi(world.services, world.run.token);
}

/** Calls `/np/agent/workflows*` with a run token (paths relative to `/np/agent`). */
export function agentWorkflowApi(services: NpServices, token: string): ApiCall {
  const router = guarded(
    [runTokenAuth(services.runTokens)],
    createAgentWorkflowRoutes(services.workflowProposals),
  );
  return async (method, path, body) => {
    const response = await router.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    // Unknown routes answer Hono's plain-text 404.
    const json: unknown = text.startsWith('{') ? JSON.parse(text) : { text };
    return { status: response.status, body: json } as never;
  };
}

/** Another claimed run of the same agent, on a new issue of Bob's. */
export async function secondRun(): Promise<ApiCall> {
  const issue = await world.services.issues.create(BOB, { title: 'Again' });
  const run = await claimedRun(world.services, BOB, issue.id, {
    fixture: world.run.fixture,
    agentId: world.run.agentId,
  });
  return agentWorkflowApi(world.services, run.token);
}

export const CODE_REVIEW: WorkflowStatusDefinitionV5 = {
  key: 'code_review',
  name: '代码评审',
  category: 'started',
  color: 'purple',
  builtIn: false,
};

/** The built-in definition plus `extra` statuses (with user transitions in and out of them). */
export function definitionWith(
  extra: readonly WorkflowStatusDefinitionV5[] = [],
  patch: (status: WorkflowStatusDefinitionV5) => WorkflowStatusDefinitionV5 = (
    status,
  ) => status,
): WorkflowDefinitionV5 {
  return {
    ...BUILTIN_DEFINITION,
    statuses: [...BUILTIN_DEFINITION.statuses, ...extra].map(patch),
    transitions: [
      ...BUILTIN_DEFINITION.transitions,
      ...extra.flatMap((status) => [
        { from: 'in_progress', to: status.key, actors: ['user' as const] },
        { from: status.key, to: 'in_review', actors: ['user' as const] },
      ]),
    ],
  };
}

/** A custom (non-system) template at revision 1; returns its id. */
export async function insertTemplate(
  definition: WorkflowDefinitionV5,
  name = 'Custom',
): Promise<string> {
  const id = `wf-${Math.random().toString(36).slice(2, 10)}`;
  await world.db.knex.raw(
    `INSERT INTO "${world.db.schema}".workflow_templates (id, name, is_default, definition, created_at, updated_at)
     VALUES (?, ?, false, ?, now(), now())`,
    [id, name, JSON.stringify(definition)],
  );
  return id;
}

/** A project (led by Alice) on `workflowId`; returns its id. */
export async function projectOn(workflowId: string, name = 'Web') {
  const project = await world.services.projects.create(ALICE, {
    name,
    leadUserId: ALICE.id,
  });
  await world.services.projects.update(ALICE, project.id, { workflowId });
  return project.id;
}

export async function moveTo(actor: Actor, issueId: string, statusKey: string) {
  const detail = await world.services.issueQueries.detail(actor, issueId);
  return world.services.issues.patch(actor, issueId, {
    statusKey,
    revision: detail.issue.revision,
  });
}
