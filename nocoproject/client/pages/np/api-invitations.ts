import type { ApiClient } from '@nocobase/app-client';

import type {
  AcceptInvitationResponse,
  Invitation,
  InvitationResult,
  PublicInvitation,
} from './types-invitations.js';

/**
 * Request functions for email invitations (NP-88): the management endpoints `/np/invitations` (signed in) and the
 * public acceptance endpoints `/np/public/invitations/{lookup,accept}`, which carry the token in the body.
 */

const id = (value: string): string => encodeURIComponent(value);

export async function fetchInvitations(api: ApiClient): Promise<Invitation[]> {
  const { data } = await api.request<{ data: Invitation[] }>({
    path: 'np/invitations',
  });
  return data;
}

export async function createInvitations(
  api: ApiClient,
  input: {
    readonly emails: readonly string[];
    readonly projectIds: readonly string[];
  },
): Promise<InvitationResult[]> {
  const { data } = await api.request<
    { data: { results: InvitationResult[] } },
    typeof input
  >({ path: 'np/invitations', method: 'POST', json: input });
  return data.results;
}

export async function resendInvitation(
  api: ApiClient,
  invitationId: string,
): Promise<InvitationResult> {
  const { data } = await api.request<{ data: InvitationResult }>({
    path: `np/invitations/${id(invitationId)}/resend`,
    method: 'POST',
  });
  return data;
}

export async function revokeInvitation(
  api: ApiClient,
  invitationId: string,
): Promise<void> {
  await api.request({
    path: `np/invitations/${id(invitationId)}`,
    method: 'DELETE',
  });
}

export async function lookupInvitation(
  api: ApiClient,
  token: string,
): Promise<PublicInvitation> {
  const { data } = await api.request<
    { data: PublicInvitation },
    { token: string }
  >({ path: 'np/public/invitations/lookup', method: 'POST', json: { token } });
  return data;
}

export async function acceptInvitation(
  api: ApiClient,
  input: {
    readonly token: string;
    readonly name: string;
    readonly password: string;
  },
): Promise<AcceptInvitationResponse> {
  const { data } = await api.request<
    { data: AcceptInvitationResponse },
    typeof input
  >({ path: 'np/public/invitations/accept', method: 'POST', json: input });
  return data;
}

/** Splits pasted text into addresses: commas, semicolons, spaces and new lines all separate. */
export function parseEmailList(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[\s,;，；]+/u)) {
    const email = part.trim().toLowerCase();
    if (email) seen.add(email);
  }
  return [...seen];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function isEmailAddress(value: string): boolean {
  return EMAIL.test(value);
}
