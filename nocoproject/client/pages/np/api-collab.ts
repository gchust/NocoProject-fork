import type { ApiClient } from '@nocobase/app-client';

import type {
  DependencyType,
  Label,
  LabelColor,
  Member,
  MemberRole,
  Workflow,
} from './types.js';

/**
 * Request functions for the iteration 1 collaboration endpoints (`docs/phase1/iteration-1-contract.md` §C–§F):
 * members, labels, workflows, dependencies, executor proposals and subscriptions. Responses follow the Phase 0
 * envelope `{ data }`; the write endpoints whose body the contract leaves open resolve to `void`, and callers reload
 * the issue detail afterwards.
 */

const id = (value: string): string => encodeURIComponent(value);

export async function fetchMembers(api: ApiClient): Promise<Member[]> {
  const { data } = await api.request<{ data: Member[] }>({
    path: 'np/members',
  });
  return data;
}

export async function updateMemberRole(
  api: ApiClient,
  userId: string,
  role: MemberRole,
): Promise<void> {
  await api.request<unknown, { role: MemberRole }>({
    path: `np/members/${id(userId)}`,
    method: 'PATCH',
    json: { role },
  });
}

export async function fetchLabels(api: ApiClient): Promise<Label[]> {
  const { data } = await api.request<{ data: Label[] }>({ path: 'np/labels' });
  return data;
}

export async function createLabel(
  api: ApiClient,
  input: { readonly name: string; readonly color: LabelColor },
): Promise<Label> {
  const { data } = await api.request<
    { data: Label },
    { name: string; color: LabelColor }
  >({ path: 'np/labels', method: 'POST', json: input });
  return data;
}

export async function updateLabelColor(
  api: ApiClient,
  labelId: string,
  color: LabelColor,
): Promise<void> {
  await api.request<unknown, { color: LabelColor }>({
    path: `np/labels/${id(labelId)}`,
    method: 'PATCH',
    json: { color },
  });
}

export async function fetchWorkflows(api: ApiClient): Promise<Workflow[]> {
  const { data } = await api.request<{ data: Workflow[] }>({
    path: 'np/workflows',
  });
  return data;
}

export async function addDependency(
  api: ApiClient,
  issueId: string,
  input: { readonly dependsOnIssueId: string; readonly type: DependencyType },
): Promise<void> {
  await api.request<
    unknown,
    { dependsOnIssueId: string; type: DependencyType }
  >({
    path: `np/issues/${id(issueId)}/dependencies`,
    method: 'POST',
    json: input,
  });
}

export async function removeDependency(
  api: ApiClient,
  issueId: string,
  dependencyId: string,
): Promise<void> {
  await api.request<unknown>({
    path: `np/issues/${id(issueId)}/dependencies/${id(dependencyId)}`,
    method: 'DELETE',
  });
}

export type ProposalDecision = 'accept' | 'reject';

export async function decideProposal(
  api: ApiClient,
  issueId: string,
  proposalId: string,
  decision: ProposalDecision,
  reason?: string,
): Promise<void> {
  await api.request<unknown, { reason?: string }>({
    path: `np/issues/${id(issueId)}/proposals/${id(proposalId)}/${decision}`,
    method: 'POST',
    json: reason ? { reason } : {},
  });
}

/** Accepts every pending proposal under the issue; the server skips the ones the caller may not accept. */
export async function acceptAllProposals(
  api: ApiClient,
  parentIssueId: string,
): Promise<{ accepted: number; skipped: number }> {
  const body = await api.request<{
    data?: { accepted?: readonly unknown[]; skipped?: readonly unknown[] };
  }>({
    path: `np/issues/${id(parentIssueId)}/proposals/accept-all`,
    method: 'POST',
  });
  return {
    accepted: body.data?.accepted?.length ?? 0,
    skipped: body.data?.skipped?.length ?? 0,
  };
}

export async function setSubscription(
  api: ApiClient,
  issueId: string,
  subscribed: boolean,
): Promise<void> {
  await api.request<unknown>({
    path: `np/issues/${id(issueId)}/${subscribed ? 'subscribe' : 'unsubscribe'}`,
    method: 'POST',
  });
}
