/**
 * NocoProject protocol types: business roles and their assignment in `/config/members` (NP-153 stage 2,
 * docs/phase2/protocol-business-roles.md).
 *
 * A business role is a built-in permission set whose key starts with `np-`; an assignment is a built-in assignment.
 * Used only by the browser and the server; not copied by the CLI.
 */
import type { Member } from './protocol.js';

/** A title as the authorization plugin stores it: plain text, or an i18n key in a namespace. */
export type AccessTitle =
  string | { readonly key: string; readonly ns: string };

/** The data scopes chosen for one composite action (`{ <scope key>: <record access key> }`). */
export interface AccessGrantPolicy {
  readonly type: 'composite';
  readonly scopes: Readonly<Record<string, string>>;
}

export interface AccessGrantAction {
  readonly action: string;
  /** Only on a business action with data scopes; a scope left out takes its default. */
  readonly policy?: AccessGrantPolicy;
}

/** One grant of a role, in the permission sets' own shape. */
export interface AccessGrant {
  readonly resource: { readonly type: string; readonly id: string };
  readonly actions: readonly AccessGrantAction[];
}

export interface AccessCatalogAction {
  readonly name: string;
  readonly title: AccessTitle | null;
}

export interface AccessCatalogScope {
  readonly key: string;
  readonly title: AccessTitle | null;
  /** Record access keys (`allRecords`, `nocoproject.visible`, ...), see `AccessCatalog.recordAccess`. */
  readonly options: readonly string[];
  readonly defaultValue: string | null;
}

/**
 * `GET /np/access/catalog`: everything a business role may hold. Only NocoProject's own resources: its pages, its
 * settings items and its business actions. Platform resources never appear.
 */
export interface AccessCatalog {
  /** Page ids (`page` grants, action `access`); the client titles them from its route tree. */
  readonly pages: readonly string[];
  readonly settings: readonly {
    readonly id: string;
    readonly title: AccessTitle | null;
    readonly actions: readonly AccessCatalogAction[];
  }[];
  readonly business: readonly {
    readonly id: string;
    readonly title: AccessTitle | null;
    readonly actions: readonly (AccessCatalogAction & {
      readonly scopes: readonly AccessCatalogScope[];
    })[];
  }[];
  /** The record accesses the scopes offer; `allRecords` is the platform's, titled by the client. */
  readonly recordAccess: readonly {
    readonly key: string;
    readonly title: AccessTitle | null;
  }[];
}

/** A row of `GET /np/access/roles`: every `np-` permission set. */
export interface BusinessRole {
  readonly key: string;
  readonly title: AccessTitle | null;
  /** `np-owner`, `np-admin`, `np-member`: never deleted. */
  readonly builtIn: boolean;
  /** Whether `/config` may change its grants (not `np-owner`). */
  readonly editable: boolean;
  /**
   * It also holds platform grants (added in the permission workspace): `/config` keeps them when editing and refuses
   * to assign or revoke the role (409 `ROLE_HAS_PLATFORM_GRANTS`).
   */
  readonly hasForeignGrants: boolean;
  /** The NocoProject grants only; platform grants are not listed. */
  readonly grants: readonly AccessGrant[];
  /** Users assigned the role directly. */
  readonly holderIds: readonly string[];
  readonly holderCount: number;
}

/** `POST /np/access/roles` (`title` required) and `PUT /np/access/roles/:key` (`title` optional). */
export interface SaveBusinessRoleRequest {
  readonly title?: string;
  readonly grants: readonly AccessGrant[];
}

/** `PUT /np/members/:userId/roles`: the user's complete set of business roles. */
export interface ReplaceMemberRolesRequest {
  readonly roles: readonly string[];
}

/** The answer of `PUT /np/members/:userId/roles`: the member with the business roles they hold directly. */
export interface MemberWithRoles extends Member {
  readonly roles: readonly string[];
}
