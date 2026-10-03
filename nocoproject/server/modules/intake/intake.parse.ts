/**
 * Running the intake parsers (moved out of `intake.service.ts` for NP-78): the AI parser when it is available and
 * allowed, else — or when it fails or finds nothing — the heuristic, and the parser input (project, workflow and
 * labels) the AI parser is given.
 */
import type { Conn } from '../shared/db.js';
import { str } from '../shared/db.js';
import type { WorkflowService } from '../workflow/workflow.service.js';
import type { IntakeDeps } from './intake.service.js';
import type { IntakeParseInput, IntakeParseOutcome } from './parser.js';

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 500) || 'The AI parser failed.';
}

/** The AI parser is registered, an LLM service is configured and the workspace setting allows it (NP-120: refine too). */
export async function aiEnabled(
  deps: IntakeDeps,
  conn: Conn,
): Promise<boolean> {
  return (
    deps.ai !== null &&
    (await deps.aiConfigured()) &&
    (await deps.settings.read(conn)).intakeParser === 'auto'
  );
}

/** Runs the AI parser when it is available and allowed, falling back to the heuristic (never failing). */
export async function parseIntake(
  deps: IntakeDeps,
  conn: Conn,
  input: IntakeParseInput,
  userId: string,
): Promise<IntakeParseOutcome> {
  let parseError: string | null = null;
  let aiSessionId: string | null = null;
  if (deps.ai && (await aiEnabled(deps, conn))) {
    try {
      const result = await deps.ai.parseAs(input, userId);
      aiSessionId = result.sessionId || null;
      if (result.drafts.length > 0)
        return {
          drafts: result.drafts,
          parser: 'ai',
          parseError: null,
          aiSessionId,
        };
      parseError = 'The AI parser returned no drafts.';
    } catch (error) {
      parseError = errorMessage(error);
    }
  }
  return {
    drafts: await deps.heuristic.parse(input),
    parser: 'heuristic',
    parseError,
    aiSessionId,
  };
}

export async function parseInput(
  conn: Conn,
  workflows: WorkflowService,
  projectId: string | null,
  rawContent: string,
) {
  const project = projectId
    ? await conn.query
        .selectFrom('projects')
        .select(['name', 'description'])
        .where('id', '=', projectId)
        .executeTakeFirst()
    : null;
  const view = await workflows.forProject(conn, projectId);
  const labels = await conn.query
    .selectFrom('issueLabels')
    .select('name')
    .orderBy('name', 'asc')
    .execute();
  return {
    rawContent,
    project: project
      ? { name: str(project.name) ?? '', description: str(project.description) }
      : null,
    workflow: {
      name: view.workflow.name,
      statuses: view.catalog.map((entry) => entry.key),
    },
    labels: labels.map((row) => str(row.name) ?? ''),
  };
}
