/**
 * Knowledge-base part of the mock server (iteration 3 §B agent endpoints):
 * `GET /np/agent/knowledge`, `GET /np/agent/knowledge/:idOrSlug`, `POST /np/agent/knowledge/proposals`.
 * Visibility: the run's project documents plus system-level ones (projectId null), not archived.
 */
import type { KnowledgeDoc, KnowledgeDocSummary, KnowledgeProposal } from '../../src/protocol.js';
import type { ClaimedRunV1 as ClaimedRun } from '../../src/run-context.js';

type Send = (status: number, payload: unknown) => void;

export class MockKnowledge {
  readonly docs: KnowledgeDoc[] = [];
  readonly proposals: KnowledgeProposal[] = [];
  private seq = 0;

  add(partial: Partial<KnowledgeDoc> & { slug: string; title: string }): KnowledgeDoc {
    const now = new Date().toISOString();
    const doc: KnowledgeDoc = {
      id: `kd${++this.seq}`,
      projectId: null,
      projectName: null,
      summary: '',
      content: `# ${partial.title}\n`,
      version: 1,
      updatedByType: 'user',
      updatedById: '1',
      updatedByName: 'Alice',
      archivedAt: null,
      pendingProposalCount: 0,
      canEdit: false,
      createdAt: now,
      updatedAt: now,
      ...partial,
    };
    this.docs.push(doc);
    return doc;
  }

  private visible(claimed: ClaimedRun): KnowledgeDoc[] {
    const projectId = claimed.project?.id ?? claimed.issue.projectId ?? null;
    return this.docs.filter((d) => !d.archivedAt && (d.projectId === null || d.projectId === projectId));
  }

  /** Project documents win over system-level ones with the same slug. */
  private find(claimed: ClaimedRun, ref: string): KnowledgeDoc | undefined {
    const docs = this.visible(claimed);
    return docs.find((d) => d.id === ref) ?? docs.find((d) => d.slug === ref && d.projectId !== null) ?? docs.find((d) => d.slug === ref);
  }

  route(method: string, path: string, body: any, claimed: ClaimedRun, send: Send): void {
    if (path === '/np/agent/knowledge' && method === 'GET') {
      const summaries: KnowledgeDocSummary[] = this.visible(claimed).map(({ content: _content, ...rest }) => rest);
      return send(200, { data: summaries });
    }
    if (path === '/np/agent/knowledge/proposals' && method === 'POST') return this.propose(body, claimed, send);
    const m = path.match(/^\/np\/agent\/knowledge\/([^/]+)$/);
    if (m && method === 'GET') {
      const doc = this.find(claimed, decodeURIComponent(m[1] as string));
      return doc ? send(200, { data: { doc } }) : send(404, { code: 'KNOWLEDGE_NOT_FOUND', message: path });
    }
    return send(404, { code: 'NOT_FOUND', message: path });
  }

  private propose(body: any, claimed: ClaimedRun, send: Send): void {
    if (!body?.content || typeof body.content !== 'string') return send(400, { code: 'VALIDATION_ERROR', message: 'content is required' });
    if (!body.reason || String(body.reason).length > 500) return send(400, { code: 'VALIDATION_ERROR', message: 'reason is required (at most 500 characters)' });
    const doc = body.docId ? this.visible(claimed).find((d) => d.id === body.docId) : undefined;
    if (body.docId && !doc) return send(404, { code: 'KNOWLEDGE_NOT_FOUND', message: String(body.docId) });
    if (!doc && !body.title) return send(400, { code: 'VALIDATION_ERROR', message: 'docId or title is required' });
    if (doc && this.proposals.some((p) => p.docId === doc.id && p.sourceRunId === claimed.run.id && p.status === 'pending')) {
      return send(409, { code: 'KNOWLEDGE_PROPOSAL_PENDING', message: 'this run already has a pending proposal for the document' });
    }
    const now = new Date().toISOString();
    const proposal: KnowledgeProposal = {
      id: `kp${++this.seq}`,
      docId: doc?.id ?? null,
      docTitle: doc?.title ?? body.title,
      projectId: body.projectId ?? doc?.projectId ?? claimed.project?.id ?? null,
      projectName: claimed.project?.name ?? null,
      title: doc ? (body.title ?? '') : body.title,
      slug: doc ? null : (body.slug ?? null),
      summary: body.summary ?? '',
      content: body.content,
      reason: body.reason,
      isNew: !doc,
      baseVersion: doc?.version ?? null,
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
      canDecide: false,
      createdAt: now,
      updatedAt: now,
    };
    this.proposals.push(proposal);
    return send(201, { data: proposal });
  }
}
