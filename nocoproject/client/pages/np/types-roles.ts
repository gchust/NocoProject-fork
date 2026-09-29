/**
 * Browser-side types for business roles and the viewer's business scopes (NP-153,
 * `server/modules/shared/protocol.roles-server.ts`, `server/modules/shared/access.ts`).
 *
 * Copied from the contract rather than imported, for the same reason as `types.ts`: the client tsconfig must not reach
 * into `server/`. Keep them in step with those files.
 */

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
  /** Record access keys (`allRecords`, `nocoproject.visible`, ...). */
  readonly options: readonly string[];
  readonly defaultValue: string | null;
}

/** `GET /np/access/catalog`: everything a business role may hold. */
export interface AccessCatalog {
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
  readonly recordAccess: readonly {
    readonly key: string;
    readonly title: AccessTitle | null;
  }[];
}

/** A row of `GET /np/access/roles`: every `np-` permission set. */
export interface BusinessRole {
  readonly key: string;
  readonly title: AccessTitle | null;
  readonly builtIn: boolean;
  /** Whether `/config` may change its grants (not `np-owner`). */
  readonly editable: boolean;
  /** It also holds platform grants: kept when edited here, never assigned here. */
  readonly hasForeignGrants: boolean;
  /** The NocoProject grants only. */
  readonly grants: readonly AccessGrant[];
  readonly holderIds: readonly string[];
  readonly holderCount: number;
}

export interface SaveBusinessRoleRequest {
  readonly title?: string;
  readonly grants: readonly AccessGrant[];
}

/** The viewer's scope of a business action: every record, the records NocoProject relates to them, or none. */
export type NpScope = 'all' | 'related' | 'none';

/** `composite/action` → scope, e.g. `nocoproject.issues/close`. */
export type NpScopes = Readonly<Record<string, NpScope>>;

/** `GET /np/me` in the browser (NP-153): the signed-in user and their business scopes. */
export interface MeAccess {
  readonly userId: string;
  readonly name: string;
  /** Absent from an older server; read as "related" everywhere. */
  readonly scopes?: NpScopes;
}
