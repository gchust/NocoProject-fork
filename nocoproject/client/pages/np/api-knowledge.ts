import { ApiClientError, type ApiClient } from '@nocobase/app-client';

import { unwrap, unwrapList } from './api-iter2.js';
import type {
  CreateKnowledgeInput,
  KnowledgeDetail,
  KnowledgeDoc,
  KnowledgeDocSummary,
  KnowledgeDocVersion,
  KnowledgeProposal,
  KnowledgeProposalStatus,
  UpdateKnowledgeInput,
} from './types-iter3.js';

/**
 * The knowledge base endpoints (`docs/phase1/iteration-3-contract.md` §B). People write and keep the documents;
 * agents only propose changes, which the project lead (owner/admin for workspace documents) accepts or rejects.
 * Saving sends `expectedVersion`; a document changed in between answers 409 `KNOWLEDGE_VERSION_CONFLICT`.
 */

const id = (value: string): string => encodeURIComponent(value);

export const KNOWLEDGE_VERSION_CONFLICT = 'KNOWLEDGE_VERSION_CONFLICT';

/** A save refused because someone else saved first. Any 409 on the PATCH counts, whatever its code. */
export function isKnowledgeConflict(error: unknown): boolean {
  return (
    error instanceof ApiClientError &&
    error.status === 409 &&
    (!error.code || error.code === KNOWLEDGE_VERSION_CONFLICT)
  );
}

/**
 * `projectId: 'none'` asks for workspace documents only (server protocol §2); archived documents are included and
 * listed last with a badge.
 */
export async function fetchKnowledgeList(
  api: ApiClient,
  filters: { readonly projectId?: string; readonly q?: string },
  signal?: AbortSignal,
): Promise<KnowledgeDocSummary[]> {
  return unwrapList<KnowledgeDocSummary>(
    await api.request<unknown>({
      path: 'np/knowledge',
      query: {
        projectId: filters.projectId || undefined,
        q: filters.q || undefined,
        includeArchived: '1',
      },
      signal,
    }),
  );
}

export async function createKnowledgeDoc(
  api: ApiClient,
  input: CreateKnowledgeInput,
): Promise<KnowledgeDoc> {
  // The server answers with the detail envelope `{ doc, versions, proposals }`; a bare document is read too.
  const body = unwrap<{ doc?: KnowledgeDoc } & Partial<KnowledgeDoc>>(
    await api.request<unknown, CreateKnowledgeInput>({
      path: 'np/knowledge',
      method: 'POST',
      json: input,
    }),
  );
  return (body.doc ?? body) as KnowledgeDoc;
}

/** `{ doc, versions, proposals }`; a bare document (older shape) gets empty history. Versions are newest first. */
export function normalizeKnowledgeDetail(body: unknown): KnowledgeDetail {
  const raw = unwrap<Partial<KnowledgeDetail> & Partial<KnowledgeDoc>>(body);
  const doc = (raw.doc ?? raw) as KnowledgeDoc;
  return {
    doc: { ...doc, content: doc.content ?? '' },
    versions: [...(raw.versions ?? [])].sort((a, b) => b.version - a.version),
    proposals: (raw.proposals ?? []).filter(
      (proposal) => proposal.status === 'pending',
    ),
  };
}

export async function fetchKnowledgeDetail(
  api: ApiClient,
  docId: string,
  signal?: AbortSignal,
): Promise<KnowledgeDetail> {
  return normalizeKnowledgeDetail(
    await api.request<unknown>({ path: `np/knowledge/${id(docId)}`, signal }),
  );
}

export async function updateKnowledgeDoc(
  api: ApiClient,
  docId: string,
  input: UpdateKnowledgeInput,
): Promise<KnowledgeDoc> {
  const body = unwrap<{ doc?: KnowledgeDoc } & Partial<KnowledgeDoc>>(
    await api.request<unknown, UpdateKnowledgeInput>({
      path: `np/knowledge/${id(docId)}`,
      method: 'PATCH',
      json: input,
    }),
  );
  return (body.doc ?? body) as KnowledgeDoc;
}

export async function fetchKnowledgeVersion(
  api: ApiClient,
  docId: string,
  version: number,
  signal?: AbortSignal,
): Promise<KnowledgeDocVersion> {
  return unwrap<KnowledgeDocVersion>(
    await api.request<unknown>({
      path: `np/knowledge/${id(docId)}/versions/${version}`,
      signal,
    }),
  );
}

export async function setKnowledgeArchived(
  api: ApiClient,
  docId: string,
  archived: boolean,
): Promise<void> {
  await api.request<unknown>({
    path: `np/knowledge/${id(docId)}/${archived ? 'archive' : 'unarchive'}`,
    method: 'POST',
  });
}

export async function fetchKnowledgeProposals(
  api: ApiClient,
  status: KnowledgeProposalStatus = 'pending',
  signal?: AbortSignal,
): Promise<KnowledgeProposal[]> {
  return unwrapList<KnowledgeProposal>(
    await api.request<unknown>({
      path: 'np/knowledge/proposals',
      query: { status },
      signal,
    }),
  );
}

export type KnowledgeProposalDecision = 'accept' | 'reject';

export async function decideKnowledgeProposal(
  api: ApiClient,
  proposalId: string,
  decision: KnowledgeProposalDecision,
  comment?: string,
): Promise<void> {
  await api.request<unknown, { comment?: string }>({
    path: `np/knowledge/proposals/${id(proposalId)}/${decision}`,
    method: 'POST',
    json: comment ? { comment } : {},
  });
}

/** A slug from a title, as the server would derive it: lowercase ASCII words joined by hyphens. */
export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80);
}
