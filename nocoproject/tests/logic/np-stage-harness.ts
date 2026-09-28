/**
 * Helpers shared by the workflow stage tests (`np-stage-actions`, `np-stage-guards`, NP-77): a project on a template
 * built from the built-in definition plus `onEnter` actions, issue moves, activity / inbox reads, the agent API with
 * the checklist routes behind the real run-token guard, and linked pull request fixtures. `setupWorld` resets the
 * data and rebuilds the services before each test (workflow views are cached per service instance).
 */
import { expect } from 'vitest';

import { BUILTIN_DEFINITION } from '../../server/modules/issue/status.ts';
import {
  createAgentApiRoutes,
  runTokenAuth,
} from '../../server/modules/run/agent-api.routes.ts';
import type { NpServices } from '../../server/modules/services.ts';
import type { Actor } from '../../server/modules/shared/activity.ts';
import { guarded } from '../../server/modules/shared/http.ts';
import type {
  IssueV4,
  StageAction,
  WorkflowDefinitionV5,
} from '../../server/modules/shared/protocol.ts';
import { createAgentChecklistRoutes } from '../../server/modules/workflow/checklist.routes.ts';
import {
  ALICE,
  BOB,
  CAROL,
  buildServices,
  claimOne,
  createAgent,
  registerRuntime,
  resetData,
  rows,
  runRows,
  setRole,
  triggerRows,
  type Fixture,
  type NpTestDatabase,
} from './np-harness.ts';

/** The state of the current test: services, the runtime, the `Dev` and `Reviewer` agents (owned by Alice). */
export const world = {} as {
  db: NpTestDatabase;
  services: NpServices;
  fixture: Fixture;
  dev: string;
  reviewer: string;
};

export async function setupWorld(db: NpTestDatabase): Promise<void> {
  await resetData(db);
  world.db = db;
  world.services = buildServices(db.database).services;
  await setRole(db, ALICE, 'owner');
  await setRole(db, BOB, 'member');
  await setRole(db, CAROL, 'member');
  world.fixture = await registerRuntime(world.services, ALICE);
  world.dev = await createAgent(
    world.services,
    ALICE,
    world.fixture.runtimeId,
    'Dev',
  );
  world.reviewer = await createAgent(
    world.services,
    ALICE,
    world.fixture.runtimeId,
    'Reviewer',
  );
}

/** The built-in definition with `onEnter` on some statuses and extra transitions. */
export function definitionWith(
  onEnter: Readonly<Record<string, readonly StageAction[]>>,
  transitions: WorkflowDefinitionV5['transitions'] = [],
): WorkflowDefinitionV5 {
  return {
    ...BUILTIN_DEFINITION,
    statuses: BUILTIN_DEFINITION.statuses.map((status) =>
      onEnter[status.key]
        ? { ...status, onEnter: onEnter[status.key] }
        : status,
    ),
    transitions: [...BUILTIN_DEFINITION.transitions, ...transitions],
  };
}

/** A project whose template is `definition`; returns its id. */
export async function projectWith(
  definition: WorkflowDefinitionV5,
): Promise<string> {
  const id = `wf-${Math.random().toString(36).slice(2, 10)}`;
  await world.db!.knex.raw(
    `INSERT INTO "${world.db!.schema}".workflow_templates (id, name, is_default, definition, created_at, updated_at)
     VALUES (?, ?, false, ?, now(), now())`,
    [id, id, JSON.stringify(definition)],
  );
  const project = await world.services.projects.create(ALICE, {
    name: `P ${id}`,
    leadUserId: ALICE.id,
  });
  await world.services.projects.update(ALICE, project.id, { workflowId: id });
  return project.id;
}

export async function issueIn(
  projectId: string,
  statusKey: string,
  extra: Record<string, unknown> = {},
): Promise<IssueV4> {
  return world.services.issues.create(ALICE, {
    title: 'Stage me',
    projectId,
    statusKey,
    ...extra,
  }) as Promise<IssueV4>;
}

export async function current(issueId: string): Promise<IssueV4> {
  return (await world.services.issueQueries.detail(ALICE, issueId))
    .issue as unknown as IssueV4;
}

export async function move(actor: Actor, issueId: string, statusKey: string) {
  const fresh = await current(issueId);
  return world.services.issues.patch(actor, issueId, {
    statusKey,
    revision: fresh.revision,
  });
}

export async function activities(issueId: string, action: string) {
  return (
    await rows(
      world.db!,
      'activities',
      'issue_id = ? AND action = ? ORDER BY created_at, id',
      [issueId, action],
    )
  ).map((row) => ({
    ...row,
    details: (typeof row.details === 'string'
      ? JSON.parse(row.details)
      : row.details) as Record<string, unknown>,
  }));
}

export async function inbox(userId: string, type: string, issueId: string) {
  return rows(
    world.db!,
    'inbox_items',
    'user_id = ? AND type = ? AND issue_id = ?',
    [userId, type, issueId],
  );
}

export async function triggerTypes(issueId: string): Promise<string[]> {
  const types: string[] = [];
  for (const run of await runRows(world.db!, `subject_id = '${issueId}'`))
    for (const trigger of await triggerRows(world.db!, run.id as string))
      types.push(trigger.type as string);
  return types;
}

/** The agent API (status, checklists) for a claimed run. */
export function agentCaller(token: string) {
  const router = guarded(
    [runTokenAuth(world.services.runTokens)],
    createAgentApiRoutes({
      issues: world.services.issues,
      queries: world.services.issueQueries,
      comments: world.services.comments,
      agentIssues: world.services.agentIssues,
      pullRequests: world.services.pullRequests,
    }),
    createAgentChecklistRoutes(world.services.checklists),
  );
  return async (method: string, path: string, body?: unknown) => {
    const response = await router.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as { data: unknown; code?: string },
    };
  };
}

/** An issue executed by `dev` in todo, its assign run claimed: the agent API for that run. */
export async function claimedDevIssue(projectId: string) {
  const issue = await issueIn(projectId, 'todo', {
    executor: { type: 'agent', id: world.dev },
  });
  const claimed = await claimOne(world.services, ALICE, world.fixture);
  expect(claimed?.issue.id).toBe(issue.id);
  return { issue, call: agentCaller(claimed!.token) };
}

export async function linkPullRequest(
  issueId: string,
  state: 'open' | 'merged',
) {
  const id = `pr-${Math.random().toString(36).slice(2, 10)}`;
  await world.db!.knex.raw(
    `INSERT INTO "${world.db!.schema}".pull_requests (id, repo, number, url, state, created_at, updated_at)
     VALUES (?, 'o/r', ?, 'https://github.com/o/r/pull/1', ?, now(), now())`,
    [id, Math.floor(Math.random() * 1_000_000), state],
  );
  await world.db!.knex.raw(
    `INSERT INTO "${world.db!.schema}".issue_pull_requests (id, issue_id, pull_request_id, linked_by_type, created_at, updated_at)
     VALUES (?, ?, ?, 'user', now(), now())`,
    [`l-${id}`, issueId, id],
  );
}
