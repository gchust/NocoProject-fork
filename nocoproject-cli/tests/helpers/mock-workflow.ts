/**
 * Workflow part of the mock server (NP-77): `GET /np/agent/workflows[/:id]`,
 * `POST /np/agent/workflows/proposals` (a light stand-in for the server's validation: built-in statuses
 * must stay, system templates may only be copied, one pending proposal per template per run) and the
 * stage checklists `GET /np/agent/issues/:id/checklists`, `PATCH .../checklists/:statusKey/items/:itemKey`.
 */
import type { AgentWorkflowListItem, IssueChecklist, WorkflowDefinitionV5, WorkflowProposal } from '../../src/protocol.js';
import type { ClaimedRunV1 as ClaimedRun } from '../../src/run-context.js';

type Send = (status: number, payload: unknown) => void;

const EMPTY_DIFF = { statuses: { added: [], removed: [], changed: [] }, transitions: { added: [], removed: [], changed: [] }, actions: [], runExecutorAgents: [], empty: true };

export class MockWorkflow {
  readonly templates: AgentWorkflowListItem[] = [];
  readonly proposals: WorkflowProposal[] = [];
  readonly checklists = new Map<string, IssueChecklist[]>();
  private seq = 0;

  add(partial: Partial<AgentWorkflowListItem> & { id: string; name: string; definition: WorkflowDefinitionV5 }): AgentWorkflowListItem {
    const now = new Date().toISOString();
    const item: AgentWorkflowListItem = { isDefault: false, isSystem: false, revision: 1, projectCount: 0, usedByRunProject: false, createdAt: now, updatedAt: now, ...partial };
    this.templates.push(item);
    return item;
  }

  route(method: string, path: string, body: any, claimed: ClaimedRun, send: Send): void {
    if (path === '/np/agent/workflows' && method === 'GET') return send(200, { data: this.templates });
    if (path === '/np/agent/workflows/proposals' && method === 'POST') return this.propose(body, claimed, send);
    const m = path.match(/^\/np\/agent\/workflows\/([^/]+)$/);
    const template = m && method === 'GET' ? this.templates.find((t) => t.id === decodeURIComponent(m[1] as string)) : undefined;
    return template ? send(200, { data: template }) : send(404, { code: 'NOT_FOUND', message: 'Workflow not found.' });
  }

  private propose(body: any, claimed: ClaimedRun, send: Send): void {
    const target = this.templates.find((t) => t.id === (body?.templateId ?? body?.copyFrom));
    if (!target) return send(404, { code: 'NOT_FOUND', message: 'Workflow not found.' });
    if (body.templateId && target.isSystem) return send(409, { code: 'WORKFLOW_SYSTEM_TEMPLATE', message: 'system template: copy it' });
    const statuses: { key: string }[] = Array.isArray(body.definition?.statuses) ? body.definition.statuses : [];
    const missing = target.definition.statuses.filter((s) => s.builtIn && !statuses.some((n) => n.key === s.key));
    if (missing.length > 0) {
      return send(400, {
        code: 'INVALID_WORKFLOW',
        message: `Invalid workflow definition: statuses: The built-in status ${missing[0]?.key} cannot be removed.`,
        details: { issues: missing.map((s) => ({ path: 'statuses', message: `The built-in status ${s.key} cannot be removed.` })) },
      });
    }
    const templateId = body.templateId ?? null;
    if (this.proposals.some((p) => p.status === 'pending' && p.sourceRunId === claimed.run.id && p.templateId === templateId && p.copyFromId === (body.copyFrom ?? null))) {
      return send(409, { code: 'WORKFLOW_PROPOSAL_PENDING', message: 'This run already has a pending proposal for this template.' });
    }
    const now = new Date().toISOString();
    const added = statuses.filter((s) => !target.definition.statuses.some((o) => o.key === s.key)).map((s: any) => ({ key: s.key, name: s.name, category: s.category }));
    const proposal: WorkflowProposal = {
      id: `wp${++this.seq}`,
      kind: templateId ? 'update' : 'copy',
      templateId,
      templateName: templateId ? target.name : null,
      copyFromId: body.copyFrom ?? null,
      copyFromName: body.copyFrom ? target.name : null,
      name: body.name ?? null,
      reason: body.reason,
      baseRevision: target.revision,
      currentRevision: templateId ? target.revision : null,
      outdated: false,
      definition: body.definition,
      diff: { ...EMPTY_DIFF, statuses: { ...EMPTY_DIFF.statuses, added }, empty: added.length === 0 },
      affectedProjectCount: templateId ? target.projectCount : 0,
      proposedByAgentId: claimed.agent.id,
      proposedByAgentName: claimed.agent.name,
      sourceRunId: claimed.run.id,
      sourceIssueId: claimed.issue.id,
      sourceIssueIdentifier: claimed.issue.identifier,
      status: 'pending',
      decidedById: null,
      decidedByName: null,
      decidedAt: null,
      comment: null,
      resultRevision: null,
      canDecide: false,
      createdAt: now,
      updatedAt: now,
    };
    this.proposals.push(proposal);
    return send(201, { data: proposal });
  }

  checklist(method: string, issueId: string, statusKey: string | undefined, itemKey: string | undefined, body: any, claimed: ClaimedRun, send: Send): void {
    const lists = this.checklists.get(issueId) ?? [];
    if (!statusKey) return send(200, { data: lists });
    if (method !== 'PATCH') return send(404, { code: 'NOT_FOUND', message: 'not found' });
    if (issueId !== claimed.issue.id) return send(403, { code: 'ISSUE_NOT_IN_RUN', message: 'not the run’s issue' });
    if (typeof body?.checked !== 'boolean') return send(400, { code: 'INVALID_FIELD', message: 'checked must be a boolean.' });
    const list = lists.find((l) => l.statusKey === statusKey);
    const item = list?.items.find((i) => i.itemKey === itemKey);
    if (!list || !item) return send(404, { code: 'NOT_FOUND', message: 'Checklist item not found.' });
    const items = list.items.map((i) => (i === item ? { ...i, checked: body.checked, checkedByType: body.checked ? ('agent' as const) : null } : i));
    const next: IssueChecklist = { ...list, items, complete: items.every((i) => !i.required || i.checked) };
    this.checklists.set(
      issueId,
      lists.map((l) => (l === list ? next : l)),
    );
    return send(200, { data: next });
  }
}
