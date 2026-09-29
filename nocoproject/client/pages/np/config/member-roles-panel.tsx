import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { UserPlusIcon } from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';

import { DataTable } from '@/components/data-table';
import { NpActorAvatar } from '@/components/np-actor-avatar';
import { NpMultiSelect } from '@/components/np-multi-select';
import { NpListSkeleton, NpLoadError } from '@/components/np-states';
import { NpTag } from '@/components/np-tag';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';

import { fetchMembers } from '../api-collab.js';
import { fetchBusinessRoles, replaceMemberRoles } from '../api-roles.js';
import { fetchProjects } from '../api.js';
import { npKeys } from '../constants.js';
import type { Member } from '../types.js';
import type { BusinessRole } from '../types-roles.js';
import { useWorkspaceViewer } from '../use-workspace-viewer.js';
import { settingsCheck } from './config-access.js';
import { ConfigSectionHeading } from './config-section.js';
import { InvitationsSection } from './invitations-section.js';
import { InviteDialog } from './invite-dialog.js';
import {
  nextRoles,
  roleErrorKey,
  roleOptions,
  rolesOf,
  roleTitle,
  sameRoles,
} from './roles-model.js';

function MemberRolesCell({
  member,
  roles,
  viewerId,
  canAssign,
  busy,
  onChange,
}: {
  readonly member: Member;
  readonly roles: readonly BusinessRole[];
  readonly viewerId: string | undefined;
  readonly canAssign: boolean;
  readonly busy: boolean;
  readonly onChange: (roles: string[]) => void;
}): ReactElement {
  const { t } = useTranslation();
  const held = rolesOf(roles, member.userId);
  const byKey = new Map(roles.map((role) => [role.key, role]));
  if (!canAssign) {
    return held.length === 0 ? (
      <span className='text-muted-foreground'>
        —<span className='sr-only'>{t('np.roles.none')}</span>
      </span>
    ) : (
      <div className='flex flex-wrap gap-1'>
        {held.map((key) => (
          <NpTag key={key} tone='grey'>
            {roleTitle(t, byKey.get(key)!)}
          </NpTag>
        ))}
      </div>
    );
  }
  const options = roleOptions(roles, member.userId, viewerId).map((option) => ({
    ...option,
    label: roleTitle(t, byKey.get(option.value)!),
  }));
  return (
    <div className='w-72'>
      <NpMultiSelect
        aria-label={t('np.roles.rolesFor', { name: member.name })}
        options={options}
        value={held}
        disabled={busy}
        placeholder={t('np.roles.pick')}
        onChange={(requested) => {
          const next = nextRoles(roles, member.userId, viewerId, requested);
          if (!sameRoles(next, held)) onChange(next);
        }}
      />
    </div>
  );
}

/**
 * The Members tab of `/config/members` (NP-153): every member and their business roles, changed in place through
 * `PUT /np/members/:userId/roles` by whoever holds `nocoproject.members` `assign`. Only roles without platform grants
 * are offered and only an owner adds or removes the owner role (`roles-model.ts`); the server checks the same.
 * Accounts themselves (creating, disabling) stay in the platform; newcomers arrive by invitation (NP-88).
 */
export function MemberRolesPanel(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const { viewer } = useWorkspaceViewer();
  const members = useQuery({
    queryKey: npKeys.members,
    queryFn: () => fetchMembers(api),
  });
  const roles = useQuery({
    queryKey: npKeys.accessRoles,
    queryFn: ({ signal }) => fetchBusinessRoles(api, signal),
  });
  const projects = useQuery({
    queryKey: npKeys.projects,
    queryFn: () => fetchProjects(api),
  });
  const [inviting, setInviting] = useState(false);
  const canAssign = useCan(settingsCheck('members', 'assign')).can;
  const inviteAll = useCan(settingsCheck('members', 'invite')).can;

  const change = useMutation({
    mutationFn: ({ member, next }: { member: Member; next: string[] }) =>
      replaceMemberRoles(api, member.userId, next),
    onSuccess: (_, { member }) =>
      toast.add({
        type: 'success',
        title: t('np.roles.assigned', { name: member.name }),
      }),
    onError: (error: unknown) =>
      toast.add({
        type: 'error',
        priority: 'high',
        title: t(
          error instanceof ApiClientError
            ? roleErrorKey(error.code, error.status)
            : 'np.common.requestFailed',
        ),
      }),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: npKeys.members }),
  });

  const roleRows = roles.data;
  const columns = useMemo<ColumnDef<Member, unknown>[]>(
    () => [
      {
        accessorKey: 'name',
        header: t('np.members.columns.name'),
        cell: ({ row }) => (
          <div className='flex items-center gap-2'>
            <NpActorAvatar type='user' name={row.original.name} />
            <span className='font-medium'>{row.original.name}</span>
            {row.original.userId === viewer?.userId ? (
              <span className='text-xs text-muted-foreground'>
                {t('np.properties.you')}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        accessorKey: 'email',
        header: t('np.members.columns.email'),
        cell: ({ row }) => (
          <span className='text-sm text-muted-foreground'>
            {row.original.email ?? '—'}
          </span>
        ),
      },
      {
        id: 'roles',
        header: t('np.members.columns.roles'),
        meta: { className: 'w-76' },
        cell: ({ row }) => (
          <MemberRolesCell
            member={row.original}
            roles={roleRows ?? []}
            viewerId={viewer?.userId}
            canAssign={canAssign}
            busy={change.isPending}
            onChange={(next) => change.mutate({ member: row.original, next })}
          />
        ),
      },
    ],
    [t, viewer, roleRows, change, canAssign],
  );

  const invitable = (projects.data ?? []).filter(
    (project) => inviteAll || project.leadUserId === viewer?.userId,
  );
  const canInvite = inviteAll || invitable.length > 0;
  const failed = members.isError ? members : roles.isError ? roles : null;

  let content: ReactElement;
  if (failed && !(members.data && roleRows)) {
    content = (
      <NpLoadError
        title={t('np.members.loadFailed')}
        error={failed.error}
        onRetry={() => void failed.refetch()}
      />
    );
  } else if (!members.data || !roleRows) {
    content = <NpListSkeleton rows={4} />;
  } else {
    content = (
      <DataTable
        columns={columns}
        data={members.data}
        pageSize={50}
        showSelectedCount={false}
        getRowId={(member) => member.userId}
      />
    );
  }

  return (
    <div className='space-y-6'>
      <section
        className='space-y-4'
        aria-labelledby='np-config-members-heading'
      >
        <ConfigSectionHeading
          id='np-config-members-heading'
          title={t('np.members.title')}
          description={t('np.members.description')}
          actions={
            canInvite ? (
              <Button size='sm' onClick={() => setInviting(true)}>
                <UserPlusIcon />
                {t('np.invitations.invite')}
              </Button>
            ) : null
          }
        />
        {content}
      </section>
      {canInvite ? <InvitationsSection /> : null}
      <InviteDialog
        open={inviting}
        projects={invitable.map((project) => ({
          id: project.id,
          name: project.name,
        }))}
        requireProject={!inviteAll}
        onClose={() => setInviting(false)}
      />
    </div>
  );
}
