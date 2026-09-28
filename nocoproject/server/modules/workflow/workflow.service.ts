/**
 * Workflow templates (docs/phase1/iteration-1-contract.md §C). Templates are read-only: the seeds write the default
 * "软件开发" template and (iteration 2) "软件开发（验收审批）"; a project without `workflowId` uses the default, and a
 * project may switch templates when none of its issues is in a status the new one lacks.
 *
 * Compiled views are cached in memory per template id, and the project → template mapping per project id. The
 * project service invalidates a project's entry when its `workflowId` changes; `invalidate()` drops everything
 * (after a template edit: NP-77 stage 2, `workflow.proposals.ts`). The cache is per process, like the rest of the
 * in-process state. Iteration 3 §F: list and get report `projectCount`; the definition is returned as stored. NP-77
 * stage 2 adds `revision` and `isSystem`.
 */
import type { Conn, TxRunner } from '../shared/db.js';
import { bool, fromJson, iso, num, str, unique } from '../shared/db.js';
import { conflict, notFound } from '../shared/errors.js';
import type {
  WorkflowDefinitionV5,
  WorkflowListItemV5,
  WorkflowV5,
} from '../shared/protocol.js';
import {
  BUILTIN_DEFINITION,
  builtinWorkflow,
  compileWorkflow,
  type WorkflowView,
} from '../issue/status.js';

export interface WorkflowService {
  /** Iteration 3 §F: each row carries `projectCount` (the default template counts projects without a template). */
  list(): Promise<WorkflowListItemV5[]>;
  get(id: string): Promise<WorkflowListItemV5>;
  /** The view for a project (its template, or the default one); `null` means "no project". */
  forProject(conn: Conn, projectId: string | null): Promise<WorkflowView>;
  forIssue(
    conn: Conn,
    issue: { readonly projectId: string | null },
  ): Promise<WorkflowView>;
  defaultView(conn: Conn): Promise<WorkflowView>;
  invalidateProject(projectId: string): void;
  invalidate(): void;
  /**
   * 409 `WORKFLOW_STATUS_CONFLICT` when an issue of the project is in a status the template (null = default) does
   * not have (iteration 2: projects may switch templates).
   */
  assertProjectCompatible(
    conn: Conn,
    projectId: string,
    workflowId: string | null,
  ): Promise<void>;
}

function isDefinition(value: unknown): value is WorkflowDefinitionV5 {
  const candidate = value as Partial<WorkflowDefinitionV5> | null;
  return (
    !!candidate &&
    Array.isArray(candidate.statuses) &&
    Array.isArray(candidate.transitions)
  );
}

export function mapWorkflow(row: Record<string, unknown>): WorkflowV5 {
  const definition = fromJson<unknown>(row.definition);
  return {
    id: str(row.id) ?? '',
    name: str(row.name) ?? '',
    isDefault: bool(row.isDefault),
    definition: isDefinition(definition)
      ? {
          ...definition,
          childBatchDoneWakesParentExecutor:
            definition.childBatchDoneWakesParentExecutor !== false,
        }
      : BUILTIN_DEFINITION,
    revision: num(row.revision, 1),
    isSystem: bool(row.isSystem),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** Projects per template id; projects without one count for the default template. */
async function projectCounts(conn: Conn): Promise<Map<string | null, number>> {
  const rows = await conn.query
    .selectFrom('projects')
    .select((eb) => ['workflowId', eb.fn.countAll().as('count')])
    .groupBy('workflowId')
    .execute();
  return new Map(rows.map((row) => [str(row.workflowId), num(row.count)]));
}

function withCount(
  workflow: WorkflowV5,
  counts: Map<string | null, number>,
): WorkflowListItemV5 {
  return {
    ...workflow,
    projectCount:
      (counts.get(workflow.id) ?? 0) +
      (workflow.isDefault ? (counts.get(null) ?? 0) : 0),
  };
}

export function createWorkflowService(deps: { tx: TxRunner }): WorkflowService {
  const views = new Map<string, WorkflowView>();
  const projectTemplate = new Map<string, string | null>();
  let defaultId: string | null = null;

  async function loadView(conn: Conn, id: string): Promise<WorkflowView> {
    const cached = views.get(id);
    if (cached) return cached;
    const row = await conn.query
      .selectFrom('workflowTemplates')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw notFound('Workflow');
    const view = compileWorkflow(mapWorkflow(row));
    views.set(id, view);
    return view;
  }

  async function defaultView(conn: Conn): Promise<WorkflowView> {
    if (defaultId) return loadView(conn, defaultId);
    const row = await conn.query
      .selectFrom('workflowTemplates')
      .selectAll()
      .where('isDefault', '=', true)
      .orderBy('createdAt', 'asc')
      .executeTakeFirst();
    if (!row) return compileWorkflow(builtinWorkflow());
    const view = compileWorkflow(mapWorkflow(row));
    defaultId = view.workflow.id;
    views.set(defaultId, view);
    return view;
  }

  async function forProject(
    conn: Conn,
    projectId: string | null,
  ): Promise<WorkflowView> {
    if (!projectId) return defaultView(conn);
    let templateId = projectTemplate.get(projectId);
    if (templateId === undefined) {
      const row = await conn.query
        .selectFrom('projects')
        .select('workflowId')
        .where('id', '=', projectId)
        .executeTakeFirst();
      templateId = row ? str(row.workflowId) : null;
      projectTemplate.set(projectId, templateId);
    }
    if (!templateId) return defaultView(conn);
    try {
      return await loadView(conn, templateId);
    } catch {
      // A project pointing at a missing template falls back to the default rather than breaking every request.
      return defaultView(conn);
    }
  }

  return {
    async list() {
      const conn = deps.tx.read();
      const rows = await conn.query
        .selectFrom('workflowTemplates')
        .selectAll()
        .orderBy('isDefault', 'desc')
        .orderBy('name', 'asc')
        .execute();
      const counts = await projectCounts(conn);
      return rows.map((row) => withCount(mapWorkflow(row), counts));
    },
    async get(id) {
      const conn = deps.tx.read();
      const row = await conn.query
        .selectFrom('workflowTemplates')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (!row) throw notFound('Workflow');
      return withCount(mapWorkflow(row), await projectCounts(conn));
    },
    forProject,
    forIssue: (conn, issue) => forProject(conn, issue.projectId),
    defaultView,
    invalidateProject(projectId) {
      projectTemplate.delete(projectId);
    },
    invalidate() {
      views.clear();
      projectTemplate.clear();
      defaultId = null;
    },
    async assertProjectCompatible(conn, projectId, workflowId) {
      const view = workflowId
        ? await loadView(conn, workflowId)
        : await defaultView(conn);
      const rows = await conn.query
        .selectFrom('issues')
        .select('statusKey')
        .where('projectId', '=', projectId)
        .where('deletedAt', 'is', null)
        .execute();
      const missing = unique(rows.map((row) => str(row.statusKey))).filter(
        (key) => !view.isKnown(key),
      );
      if (missing.length > 0)
        throw conflict(
          'WORKFLOW_STATUS_CONFLICT',
          `Issues of this project are in statuses the workflow does not have: ${missing.join(', ')}.`,
        );
    },
  };
}
