import type { ApiClient } from '@nocobase/app-client';

import type {
  AccessCatalog,
  BusinessRole,
  SaveBusinessRoleRequest,
} from './types-roles.js';

/**
 * Request functions for business roles and their assignment (NP-153, docs/phase2/protocol-business-roles.md):
 * `/np/access/{catalog,roles}` and `PUT /np/members/:userId/roles`.
 */

const id = (value: string): string => encodeURIComponent(value);

export async function fetchAccessCatalog(
  api: ApiClient,
  signal?: AbortSignal,
): Promise<AccessCatalog> {
  const { data } = await api.request<{ data: AccessCatalog }>({
    path: 'np/access/catalog',
    signal,
  });
  return data;
}

export async function fetchBusinessRoles(
  api: ApiClient,
  signal?: AbortSignal,
): Promise<BusinessRole[]> {
  const { data } = await api.request<{ data: BusinessRole[] }>({
    path: 'np/access/roles',
    signal,
  });
  return data;
}

export async function createBusinessRole(
  api: ApiClient,
  input: SaveBusinessRoleRequest & { readonly title: string },
): Promise<BusinessRole> {
  const { data } = await api.request<
    { data: BusinessRole },
    SaveBusinessRoleRequest
  >({ path: 'np/access/roles', method: 'POST', json: input });
  return data;
}

export async function updateBusinessRole(
  api: ApiClient,
  key: string,
  input: SaveBusinessRoleRequest,
): Promise<BusinessRole> {
  const { data } = await api.request<
    { data: BusinessRole },
    SaveBusinessRoleRequest
  >({ path: `np/access/roles/${id(key)}`, method: 'PUT', json: input });
  return data;
}

export async function deleteBusinessRole(
  api: ApiClient,
  key: string,
): Promise<void> {
  await api.request<unknown>({
    path: `np/access/roles/${id(key)}`,
    method: 'DELETE',
  });
}

/** The member's complete set of business roles. */
export async function replaceMemberRoles(
  api: ApiClient,
  userId: string,
  roles: readonly string[],
): Promise<void> {
  await api.request<unknown, { roles: readonly string[] }>({
    path: `np/members/${id(userId)}/roles`,
    method: 'PUT',
    json: { roles },
  });
}

/** The holders a 409 `ROLE_IN_USE` names. */
export function holderIdsOfError(payload: unknown): string[] {
  const value = (payload as { details?: { holderIds?: unknown } } | null)
    ?.details?.holderIds;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
