import type { ApiClient } from '@nocobase/app-client';

import { unwrap, unwrapList } from './api-iter2.js';
import type {
  IntakeBatch,
  IntakeBatchDetail,
  IntakeConfirmInput,
  IntakeDraft,
  IntakeDraftInput,
  IntakeRevertResult,
  IssueRef,
} from './types.js';

/** Batch entry endpoints (`docs/phase1/iteration-2-contract.md` §E). */

const id = (value: string): string => encodeURIComponent(value);

/** `{ batch, drafts, parser }` with or without the `data` envelope; drafts ordered by position. */
export function normalizeBatchDetail(body: unknown): IntakeBatchDetail {
  const inner = unwrap<Partial<IntakeBatchDetail> & Partial<IntakeBatch>>(body);
  const batch = (inner.batch ?? inner) as IntakeBatch;
  return {
    batch: {
      ...batch,
      parser: inner.parser ?? batch.parser,
    },
    drafts: [...(inner.drafts ?? [])].sort((a, b) => a.position - b.position),
    parser: inner.parser ?? batch.parser,
    attachments: inner.attachments ?? [],
  };
}

export type CreateIntakeInput =
  | {
      readonly source: 'paste';
      readonly rawContent: string;
      readonly projectId?: string;
      /** NP-78: the member's own uploads, which travel with the batch. */
      readonly attachmentIds?: readonly string[];
    }
  | { readonly source: 'issue'; readonly issueId: string };

export async function createIntakeBatch(
  api: ApiClient,
  input: CreateIntakeInput,
): Promise<IntakeBatchDetail> {
  return normalizeBatchDetail(
    await api.request<unknown, CreateIntakeInput>({
      path: 'np/intake/batches',
      method: 'POST',
      json: input,
    }),
  );
}

export async function fetchMyIntakeBatches(
  api: ApiClient,
  signal?: AbortSignal,
): Promise<IntakeBatch[]> {
  return unwrapList(
    await api.request<unknown>({
      path: 'np/intake/batches',
      query: { mine: '1' },
      signal,
    }),
  );
}

export async function fetchIntakeBatch(
  api: ApiClient,
  batchId: string,
  signal?: AbortSignal,
): Promise<IntakeBatchDetail> {
  return normalizeBatchDetail(
    await api.request<unknown>({
      path: `np/intake/batches/${id(batchId)}`,
      signal,
    }),
  );
}

export async function saveIntakeDrafts(
  api: ApiClient,
  batchId: string,
  drafts: readonly IntakeDraftInput[],
): Promise<IntakeDraft[]> {
  const body = await api.request<
    unknown,
    { drafts: readonly IntakeDraftInput[] }
  >({
    path: `np/intake/batches/${id(batchId)}/drafts`,
    method: 'PUT',
    json: { drafts },
  });
  return unwrapList<IntakeDraft>(body, 'drafts').sort(
    (a, b) => a.position - b.position,
  );
}

export async function confirmIntakeBatch(
  api: ApiClient,
  batchId: string,
  input: IntakeConfirmInput,
): Promise<IssueRef[]> {
  const body = await api.request<unknown, IntakeConfirmInput>({
    path: `np/intake/batches/${id(batchId)}/confirm`,
    method: 'POST',
    json: input,
  });
  return unwrapList<IssueRef>(body, 'issues');
}

export async function cancelIntakeBatch(
  api: ApiClient,
  batchId: string,
): Promise<void> {
  await api.request<unknown>({
    path: `np/intake/batches/${id(batchId)}/cancel`,
    method: 'POST',
  });
}

export async function revertIntakeBatch(
  api: ApiClient,
  batchId: string,
): Promise<IntakeRevertResult> {
  const result = unwrap<Partial<IntakeRevertResult>>(
    await api.request<unknown>({
      path: `np/intake/batches/${id(batchId)}/revert`,
      method: 'POST',
    }),
  );
  return { reverted: result.reverted ?? [], kept: result.kept ?? [] };
}
