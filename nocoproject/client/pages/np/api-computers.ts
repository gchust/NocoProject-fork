import type { ApiClient } from '@nocobase/app-client';

import type { CreateComputerResponse, NpComputer } from './types-computers.js';

/** Request functions for computer credentials (NP-150): `/np/computers` (signed in). */

export async function fetchComputers(api: ApiClient): Promise<NpComputer[]> {
  const { data } = await api.request<{ data: NpComputer[] }>({
    path: 'np/computers',
  });
  return data;
}

export async function createComputer(
  api: ApiClient,
  name: string,
): Promise<CreateComputerResponse> {
  const { data } = await api.request<
    { data: CreateComputerResponse },
    { name: string }
  >({ path: 'np/computers', method: 'POST', json: { name } });
  return data;
}

export async function revokeComputer(
  api: ApiClient,
  id: string,
): Promise<NpComputer> {
  const { data } = await api.request<{ data: NpComputer }>({
    path: `np/computers/${encodeURIComponent(id)}`,
    method: 'DELETE',
  });
  return data;
}
