/**
 * Workflow template proposals (NP-77 方案 §4–§6, stage 2): agents read templates and propose a whole new definition
 * for an existing template (`templateId`) or for a copy of one (`copyFrom`); an owner/admin accepts or rejects it.
 * Structure follows `knowledge/knowledge.proposals.ts`.
 *
 * Submitting (run token): validation and the compatibility check run at once (400 `INVALID_WORKFLOW` with
 * `details.issues`, 409 `WORKFLOW_STATUS_CONFLICT` with counts per project); system templates may only be copied
 * (409 `WORKFLOW_SYSTEM_TEMPLATE`); an edit identical to the current definition is 400 `WORKFLOW_UNCHANGED`; one
 * pending proposal per template (or copy source) per run (409 `WORKFLOW_PROPOSAL_PENDING`). It writes
 * `workflow_proposed` on the run's issue and emits `workflow.proposed` → `workflow_proposal` cards for owner/admins.
 *
 * Deciding (owner/admin, else 403): accepting an edit whose template moved past `baseRevision` marks the proposal
 * `stale` (emitting `workflow.decided`) and answers 409 `WORKFLOW_PROPOSAL_STALE`; otherwise validation and the
 * compatibility check run again, the definition takes effect with a revision snapshot (a copy becomes a new
 * template), `workflow_updated` goes on the source issue, and the workflow cache is invalidated after the commit.
 * Rejecting keeps an optional comment. Every write emits `workflow.decided`, and acceptances `workflow.changed`.
 *
 * The admin `PUT /np/workflows/:id` (no page) takes the same path without a proposal, under the same lock
 * (409 `REVISION_CONFLICT`). Agents cannot write templates any other way.
 */
import { NP_SETTINGS } from '../shared/access.js';
import type { Actor } from '../shared/activity.js';
import {
  adminUserIds,
  canSeeIssue,
  canUseSetting,
  viewerOf,
} from '../shared/authz.js';
import type { Conn, TxRunner } from '../shared/db.js';
import { now, num, str, toJson } from '../shared/db.js';
import { conflict, forbidden, invalid, notFound } from '../shared/errors.js';
import type { IdSource } from '../shared/ids.js';
import type { ActivityRecorder } from '../shared/activity.js';
import type {
  AgentWorkflowListItem,
  AgentWorkflowProposalRequest,
  DecideWorkflowProposalRequest,
  UpdateWorkflowRequest,
  WorkflowListItemV5,
  WorkflowProposal,
  WorkflowRevision,
} from '../shared/protocol.js';
import {
  ERROR_WORKFLOW_PROPOSAL_DECIDED,
  ERROR_WORKFLOW_PROPOSAL_PENDING,
  ERROR_WORKFLOW_PROPOSAL_STALE,
  ERROR_WORKFLOW_SYSTEM_TEMPLATE,
} from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import { findIssue } from '../issue/issue.records.js';
import type { RunAuth } from '../run/token.js';
import { agentNames } from '../run/run.queries.js';
import {
  definitionOf,
  diffCounts,
  mapProposal,
  proposalDiff,
  validateComment,
  validateName,
  validateReason,
} from './workflow.proposal-records.js';
import {
  applyDefinition,
  checkDefinition,
  findTemplateRow,
  insertTemplate,
  listRevisions,
  type TemplateRow,
} from './workflow.revisions.js';
import { mapWorkflow, type WorkflowService } from './workflow.service.js';

export interface WorkflowProposalDeps {
  readonly tx: TxRunner;
  readonly ids: IdSource;
  readonly users: UserDirectory;
  readonly activity: ActivityRecorder;
  readonly workflows: WorkflowService;
}

export interface WorkflowProposalService {
  agentList(auth: RunAuth): Promise<AgentWorkflowListItem[]>;
  agentGet(auth: RunAuth, id: string): Promise<AgentWorkflowListItem>;
  agentPropose(
    auth: RunAuth,
    input: AgentWorkflowProposalRequest,
  ): Promise<WorkflowProposal>;
  get(actor: Actor, id: string): Promise<WorkflowProposal>;
  decide(
    actor: Actor,
    id: string,
    decision: 'accept' | 'reject',
    input: DecideWorkflowProposalRequest,
  ): Promise<WorkflowProposal>;
  revisions(actor: Actor, templateId: string): Promise<WorkflowRevision[]>;
  update(
    actor: Actor,
    templateId: string,
    input: UpdateWorkflowRequest,
  ): Promise<WorkflowListItemV5>;
}

async function requireTemplate(conn: Conn, id: unknown): Promise<TemplateRow> {
  const row =
    typeof id === 'string' && id ? await findTemplateRow(conn, id) : undefined;
  if (!row) throw notFound('Workflow');
  return row;
}

function assertEditable(template: TemplateRow): void {
  if (template.isSystem)
    throw conflict(
      ERROR_WORKFLOW_SYSTEM_TEMPLATE,
      `${str(template.name) ?? 'This template'} is a system template: copy it (copyFrom) and change the copy.`,
    );
}

async function assertNoPending(
  conn: Conn,
  runId: string,
  target: { templateId: string | null; copyFromId: string | null },
): Promise<void> {
  let select = conn.query
    .selectFrom('workflowProposals')
    .select('id')
    .where('status', '=', 'pending')
    .where('sourceRunId', '=', runId);
  select = target.templateId
    ? select.where('templateId', '=', target.templateId)
    : select
        .where('templateId', 'is', null)
        .where('copyFromId', '=', target.copyFromId ?? '');
  if (await select.exists())
    throw conflict(
      ERROR_WORKFLOW_PROPOSAL_PENDING,
      'This run already has a pending proposal for this template.',
    );
}

export function createWorkflowProposalService(
  deps: WorkflowProposalDeps,
): WorkflowProposalService {
  async function runTemplateId(conn: Conn, auth: RunAuth): Promise<string> {
    const issue = await findIssue(conn, auth.issueId);
    return (await deps.workflows.forProject(conn, issue?.projectId ?? null))
      .workflow.id;
  }

  async function load(
    conn: Conn,
    id: string,
    actor: Actor | null,
  ): Promise<WorkflowProposal> {
    const row = await conn.query
      .selectFrom('workflowProposals')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw notFound('Workflow proposal');
    const viewer = actor ? await viewerOf(conn, actor) : null;
    return mapProposal(conn, row, {
      users: deps.users,
      canDecide:
        actor && viewer
          ? await canUseSetting(conn, actor, NP_SETTINGS.workflows, 'update')
          : false,
      canSeeIssue: async (issueId) => {
        if (!viewer) return true;
        const issue = await findIssue(conn, issueId);
        return !!issue && (await canSeeIssue(conn, viewer, issue));
      },
    });
  }

  /** NP-117: deciding proposals and the admin `PUT` need `update` on the settings item `nocoproject.workflows`. */
  async function requireAdmin(conn: Conn, actor: Actor): Promise<void> {
    if (!(await canUseSetting(conn, actor, NP_SETTINGS.workflows, 'update')))
      throw forbidden('FORBIDDEN', 'You may not change workflow templates.');
  }

  return {
    async agentList(auth) {
      const conn = deps.tx.read();
      const current = await runTemplateId(conn, auth);
      return (await deps.workflows.list()).map((item) => ({
        ...item,
        usedByRunProject: item.id === current,
      }));
    },

    async agentGet(auth, id) {
      const conn = deps.tx.read();
      const item = await deps.workflows.get(id);
      return {
        ...item,
        usedByRunProject: item.id === (await runTemplateId(conn, auth)),
      };
    },

    async agentPropose(auth, input) {
      const reason = validateReason(input?.reason);
      const hasTemplate = typeof input.templateId === 'string';
      if (hasTemplate === (typeof input.copyFrom === 'string'))
        throw invalid(
          'INVALID_TARGET',
          'Pass exactly one of templateId (change a template) or copyFrom (create a copy).',
        );
      const name = validateName(input.name, !hasTemplate);
      const id = await deps.tx.run(async (tx) => {
        const template = await requireTemplate(
          tx.conn,
          hasTemplate ? input.templateId : input.copyFrom,
        );
        if (hasTemplate) assertEditable(template);
        const base = mapWorkflow(template);
        const definition = await checkDefinition(
          tx.conn,
          input.definition,
          hasTemplate ? template : null,
        );
        const target = {
          templateId: hasTemplate ? base.id : null,
          copyFromId: hasTemplate ? null : base.id,
        };
        await assertNoPending(tx.conn, auth.runId, target);
        const issue = await findIssue(tx.conn, auth.issueId);
        const proposalId = deps.ids.next();
        const timestamp = now();
        const row = {
          id: proposalId,
          ...target,
          name,
          definition: toJson(definition),
          baseDefinition: toJson(base.definition),
          baseName: base.name,
          baseRevision: base.revision,
          reason,
          proposedByAgentId: auth.agentId,
          sourceRunId: auth.runId,
          sourceIssueId: issue?.id ?? null,
          status: 'pending',
          decidedById: null,
          decidedAt: null,
          comment: null,
          resultRevision: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        const diff = proposalDiff(
          row,
          await agentNames(tx.conn, [auth.agentId]),
        );
        if (hasTemplate && diff.empty)
          throw invalid(
            'WORKFLOW_UNCHANGED',
            'The proposed definition and name are identical to the current revision.',
          );
        await tx.conn.query
          .insertInto('workflowProposals')
          .values(row)
          .execute();
        const actor = { type: 'agent' as const, id: auth.agentId };
        const kind = hasTemplate ? ('update' as const) : ('copy' as const);
        if (issue) {
          await deps.activity.record(tx.conn, {
            issueId: issue.id,
            actor: { ...actor, runId: auth.runId },
            action: 'workflow_proposed',
            details: { proposalId, kind, ...target, name: name ?? base.name },
          });
          tx.emit({ type: 'issue.changed', issueId: issue.id });
        }
        tx.emit({
          type: 'workflow.proposed',
          proposalId,
          kind,
          templateId: target.templateId,
          templateName: hasTemplate ? base.name : (name ?? base.name),
          copyFromId: target.copyFromId,
          reason,
          changes: diffCounts(diff),
          issueId: issue?.id ?? null,
          deciderUserIds: await adminUserIds(tx.conn),
          actor,
        });
        return proposalId;
      });
      return load(deps.tx.read(), id, null);
    },

    async get(actor, id) {
      return load(deps.tx.read(), id, actor);
    },

    async decide(actor, proposalId, decision, input) {
      const comment = validateComment(input?.comment);
      let changed = false;
      await requireAdmin(deps.tx.read(), actor);
      const stale = await deps.tx.run(async (tx) => {
        const row = await tx.conn.query
          .selectFrom('workflowProposals')
          .selectAll()
          .where('id', '=', proposalId)
          .executeTakeFirst();
        if (!row) throw notFound('Workflow proposal');
        if (row.status !== 'pending')
          throw conflict(
            ERROR_WORKFLOW_PROPOSAL_DECIDED,
            'This proposal has already been decided.',
          );
        const copyFromId = str(row.copyFromId);
        const kind = copyFromId ? ('copy' as const) : ('update' as const);
        const template =
          kind === 'update'
            ? await requireTemplate(tx.conn, str(row.templateId))
            : null;
        const isStale =
          decision === 'accept' &&
          !!template &&
          num(template.revision, 1) !== num(row.baseRevision, 1);
        let resultId = str(row.templateId);
        let revision: number | null = null;
        if (decision === 'accept' && !isStale) {
          const definition = await checkDefinition(
            tx.conn,
            definitionOf(row.definition),
            template,
          );
          const author = {
            type: 'agent' as const,
            id: str(row.proposedByAgentId),
          };
          const change = {
            definition,
            proposalId,
            note: str(row.reason),
            author,
          };
          if (template) {
            revision = await applyDefinition(tx.conn, deps.ids, {
              ...change,
              template,
              baseRevision: num(row.baseRevision, 1),
              name: str(row.name),
            });
            if (revision === null)
              throw conflict(
                ERROR_WORKFLOW_PROPOSAL_STALE,
                'The template changed while this proposal was being accepted; try again.',
              );
          } else {
            resultId = await insertTemplate(tx.conn, deps.ids, {
              ...change,
              name: str(row.name) ?? str(row.baseName) ?? '',
            });
            revision = 1;
          }
        }
        const status =
          decision === 'reject' ? 'rejected' : isStale ? 'stale' : 'accepted';
        const timestamp = now();
        const result = await tx.conn.query
          .updateTable('workflowProposals')
          .set({
            status,
            templateId: resultId,
            decidedById: actor.id,
            decidedAt: timestamp,
            comment,
            resultRevision: revision,
            updatedAt: timestamp,
          })
          .where('id', '=', proposalId)
          .where('status', '=', 'pending')
          .execute();
        if (num(result.updatedCount) === 0)
          throw conflict(
            ERROR_WORKFLOW_PROPOSAL_DECIDED,
            'This proposal has already been decided.',
          );
        const templateName =
          str(row.name) ?? str(template?.name) ?? str(row.baseName) ?? '';
        const issue = str(row.sourceIssueId)
          ? await findIssue(tx.conn, str(row.sourceIssueId) ?? '')
          : null;
        const eventActor = { type: 'user' as const, id: actor.id };
        if (issue && revision !== null && resultId) {
          await deps.activity.record(tx.conn, {
            issueId: issue.id,
            actor,
            action: 'workflow_updated',
            details: {
              proposalId,
              kind,
              templateId: resultId,
              name: templateName,
              revision,
            },
          });
        }
        if (issue) tx.emit({ type: 'issue.changed', issueId: issue.id });
        tx.emit({
          type: 'workflow.decided',
          proposalId,
          kind,
          templateId: resultId,
          templateName,
          decision: status,
          revision,
          comment,
          issueId: issue?.id ?? null,
          actor: eventActor,
        });
        if (revision !== null && resultId) {
          changed = true;
          tx.emit({
            type: 'workflow.changed',
            templateId: resultId,
            revision,
            actor: eventActor,
          });
        }
        return isStale;
      });
      if (changed) deps.workflows.invalidate();
      if (stale)
        throw conflict(
          ERROR_WORKFLOW_PROPOSAL_STALE,
          'The template has changed since this proposal was made; it is now stale and the agent must propose again from the latest revision.',
        );
      return load(deps.tx.read(), proposalId, actor);
    },

    async revisions(actor, templateId) {
      const conn = deps.tx.read();
      await viewerOf(conn, actor);
      await requireTemplate(conn, templateId);
      return listRevisions(conn, deps.users, templateId);
    },

    async update(actor, templateId, input) {
      const name = validateName(input?.name, false);
      if (!Number.isInteger(input?.revision))
        throw invalid(
          'REVISION_REQUIRED',
          'revision (the revision this change is based on) is required.',
        );
      const note =
        typeof input.note === 'string' && input.note.trim()
          ? input.note.trim()
          : null;
      await requireAdmin(deps.tx.read(), actor);
      await deps.tx.run(async (tx) => {
        const template = await requireTemplate(tx.conn, templateId);
        assertEditable(template);
        const definition = await checkDefinition(
          tx.conn,
          input.definition,
          template,
        );
        const revision = await applyDefinition(tx.conn, deps.ids, {
          template,
          baseRevision: input.revision,
          definition,
          name,
          proposalId: null,
          note,
          author: actor,
        });
        if (revision === null)
          throw conflict(
            'REVISION_CONFLICT',
            `The template is at revision ${num(template.revision, 1)}, not ${input.revision}.`,
          );
        tx.emit({
          type: 'workflow.changed',
          templateId,
          revision,
          actor: { type: 'user', id: actor.id },
        });
      });
      deps.workflows.invalidate();
      return deps.workflows.get(templateId);
    },
  };
}
