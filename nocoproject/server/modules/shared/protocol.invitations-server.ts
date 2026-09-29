/**
 * NocoProject protocol types: email invitations (NP-88, docs/phase2/invitations.md).
 *
 * Used only by the browser and the server; not copied by the CLI.
 */

/** Invitation status; `expired` is derived from `expiresAt` and not stored in the database */
export type InvitationStatus = 'pending' | 'expired' | 'accepted' | 'revoked';

/** A row of `GET /np/invitations` (pending and expired) */
export interface Invitation {
  readonly id: string;
  readonly email: string;
  readonly status: InvitationStatus;
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  readonly invitedBy: { readonly userId: string; readonly name: string };
  readonly expiresAt: string;
  /** Time of the most recent successful send; null means sending failed */
  readonly sentAt: string | null;
  readonly createdAt: string;
}

/** `POST /np/invitations`: multiple emails at once, multiple projects to join (joined as member) */
export interface CreateInvitationsRequest {
  readonly emails: readonly string[];
  readonly projectIds?: readonly string[];
}

/**
 * Result for each email:
 * - `invited`: an invitation was sent (when the same email already has a pending invitation, the
 *   projects are merged and it is resent);
 * - `added`: the email already has an account and was added directly to the selected projects;
 * - `alreadyMember`: already has an account, and there were no new projects to join.
 */
export type InvitationOutcome = 'invited' | 'added' | 'alreadyMember';

export interface InvitationResult {
  readonly email: string;
  readonly outcome: InvitationOutcome;
  /** When `invited`: whether the email was actually sent */
  readonly emailSent?: boolean;
  /** When sending fails, the invite link is returned once so the inviter can forward it manually; it cannot be retrieved from the list afterward */
  readonly inviteUrl?: string;
}

export interface CreateInvitationsResponse {
  readonly results: readonly InvitationResult[];
}

/** `POST /np/public/invitations/lookup` (public, body `{ token }`): the content shown on the accept page */
export interface PublicInvitation {
  readonly email: string;
  readonly inviterName: string;
  readonly projectNames: readonly string[];
  readonly expiresAt: string;
}

/** `POST /np/public/invitations/accept` (public): creates the account and joins the projects; the token travels in the body and is kept out of request logs */
export interface AcceptInvitationRequest {
  readonly token?: string;
  readonly name: string;
  readonly password: string;
}

export interface AcceptInvitationResponse {
  readonly email: string;
  /** Whether the email already had an account before accepting: only joins the projects, signs in with the existing password */
  readonly existingAccount: boolean;
}
