import type { ApiClient } from '@nocobase/app-client';

import type {
  CreateProjectInput,
  ProjectDetail,
  ProjectListItem,
  ProjectMemberRole,
  ProjectResource,
  UpdateProjectInput,
} from './types.js';

/** Project endpoints (`docs/phase1/iteration-1-contract.md` §F). */

const id = (value: string): string => encodeURIComponent(value);

export async function fetchProjectList(
  api: ApiClient,
  signal?: AbortSignal,
): Promise<ProjectListItem[]> {
  const { data } = await api.request<{ data: ProjectListItem[] }>({
    path: 'np/projects',
    signal,
  });
  return data;
}

export async function fetchProject(
  api: ApiClient,
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectDetail> {
  const { data } = await api.request<{ data: ProjectDetail }>({
    path: `np/projects/${id(projectId)}`,
    signal,
  });
  return data;
}

export async function createProject(
  api: ApiClient,
  input: CreateProjectInput,
): Promise<ProjectListItem> {
  const { data } = await api.request<
    { data: ProjectListItem },
    CreateProjectInput
  >({ path: 'np/projects', method: 'POST', json: input });
  return data;
}

export async function updateProject(
  api: ApiClient,
  projectId: string,
  changes: UpdateProjectInput,
): Promise<void> {
  await api.request<unknown, UpdateProjectInput>({
    path: `np/projects/${id(projectId)}`,
    method: 'PATCH',
    json: changes,
  });
}

export async function addProjectMember(
  api: ApiClient,
  projectId: string,
  input: { readonly userId: string; readonly role: ProjectMemberRole },
): Promise<void> {
  await api.request<unknown, { userId: string; role: ProjectMemberRole }>({
    path: `np/projects/${id(projectId)}/members`,
    method: 'POST',
    json: input,
  });
}

export async function removeProjectMember(
  api: ApiClient,
  projectId: string,
  userId: string,
): Promise<void> {
  await api.request<unknown>({
    path: `np/projects/${id(projectId)}/members/${id(userId)}`,
    method: 'DELETE',
  });
}

export interface AddGitRepoInput {
  readonly type: 'gitRepo';
  readonly url: string;
  readonly defaultRef?: string;
  readonly label?: string;
}

export async function addProjectResource(
  api: ApiClient,
  projectId: string,
  input: AddGitRepoInput,
): Promise<ProjectResource | undefined> {
  const body = await api.request<{ data?: ProjectResource }, AddGitRepoInput>({
    path: `np/projects/${id(projectId)}/resources`,
    method: 'POST',
    json: input,
  });
  return body.data;
}

export async function removeProjectResource(
  api: ApiClient,
  projectId: string,
  resourceId: string,
): Promise<void> {
  await api.request<unknown>({
    path: `np/projects/${id(projectId)}/resources/${id(resourceId)}`,
    method: 'DELETE',
  });
}

export async function deleteProject(
  api: ApiClient,
  projectId: string,
): Promise<void> {
  await api.request<unknown>({
    path: `np/projects/${id(projectId)}`,
    method: 'DELETE',
  });
}

export interface UpdateResourceInput {
  readonly url?: string;
  readonly defaultRef?: string | null;
  readonly label?: string | null;
  readonly position?: number;
}

export async function updateProjectResource(
  api: ApiClient,
  projectId: string,
  resourceId: string,
  changes: UpdateResourceInput,
): Promise<void> {
  await api.request<unknown, UpdateResourceInput>({
    path: `np/projects/${id(projectId)}/resources/${id(resourceId)}`,
    method: 'PATCH',
    json: changes,
  });
}
