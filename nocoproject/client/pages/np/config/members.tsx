import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { UserPlusIcon } from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';

import { DataTable } from '@/components/data-table';
import { NpActorAvatar } from '@/components/np-actor-avatar';
import { NpListSkeleton, NpLoadError } from '@/components/np-states';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';

import { fetchMembers, updateMemberRole } from '../api-collab.js';
import { fetchMe, fetchProjects } from '../api.js';
import { npKeys } from '../constants.js';
import {
  type Viewer,
  canChangeMemberRole,
  isWorkspaceAdmin,
  memberRoleOptions,
  viewerFrom,
} from '../permissions.js';
import type { Member, MemberRole } from '../types.js';
import { ConfigSectionHeading } from './config-section.js';
import { InvitationsSection } from './invitations-section.js';
import { InviteDialog } from './invite-dialog.js';

function RoleSelect({
  member,
  members,
  viewer,
  busy,
  onChange,
}: {
  readonly member: Member;
  readonly members: readonly Member[];
  readonly viewer: Viewer | null;
  readonly busy: boolean;
  readonly onChange: (role: MemberRole) => void;
}): ReactElement {
  const { t } = useTranslation();
  const options = memberRoleOptions(viewer, member, members);
  const items = options.map((option) => ({
    value: option.value,
    label: t(`np.members.role.${option.value}`),
  }));
  return (
    <Select
      items={items}
      value={member.role}
      disabled={busy || !canChangeMemberRole(viewer, member, members)}
      onValueChange={(value: MemberRole | null) => {
        if (value && value !== member.role) onChange(value);
      }}
    >
      <SelectTrigger
        size='sm'
        className='w-32'
        aria-label={t('np.members.roleFor', { name: member.name })}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            disabled={option.disabled}
          >
            {t(`np.members.role.${option.value}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Tab `/config/members` (iteration 1 §J 6, moved into the front-end settings in iteration 3 §G): the workspace
 * members and their roles. Everyone can open it, but only owner/admin change roles, only an owner grants or revokes
 * owner, and the last owner keeps the role (`memberRoleOptions`); `PATCH /np/members/:userId` enforces the same rules.
 *
 * NP-88: owner/admin, and a project lead for the projects they lead, invite people by email ("Invite members"); the
 * invitations not accepted yet are listed under the members.
 */
export default function MembersConfigTab(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const members = useQuery({
    queryKey: npKeys.members,
    queryFn: () => fetchMembers(api),
  });
  const me = useQuery({ queryKey: npKeys.me, queryFn: () => fetchMe(api) });
  const viewer = viewerFrom(me.data?.userId, members.data);
  const projects = useQuery({
    queryKey: npKeys.projects,
    queryFn: () => fetchProjects(api),
  });
  const [inviting, setInviting] = useState(false);

  const change = useMutation({
    mutationFn: ({ member, role }: { member: Member; role: MemberRole }) =>
      updateMemberRole(api, member.userId, role),
    onSuccess: (_, { member, role }) =>
      toast.add({
        type: 'success',
        title: t('np.members.roleChanged', {
          name: member.name,
          role: t(`np.members.role.${role}`),
        }),
      }),
    onError: (error: unknown) =>
      toast.add({
        type: 'error',
        priority: 'high',
        title:
          error instanceof ApiClientError && error.status === 403
            ? t('np.members.forbidden')
            : t('np.common.requestFailed'),
      }),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: npKeys.members }),
  });

  const rows = members.data;
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
        accessorKey: 'role',
        header: t('np.members.columns.role'),
        cell: ({ row }) => (
          <RoleSelect
            member={row.original}
            members={rows ?? []}
            viewer={viewer}
            busy={change.isPending}
            onChange={(role) => change.mutate({ member: row.original, role })}
          />
        ),
      },
    ],
    [t, viewer, rows, change],
  );

  const admin = isWorkspaceAdmin(viewer);
  const invitable = (projects.data ?? []).filter(
    (project) => admin || project.leadUserId === viewer?.userId,
  );
  const canInvite = admin || invitable.length > 0;

  let content: ReactElement;
  if (members.isError && !rows) {
    content = (
      <NpLoadError
        title={t('np.members.loadFailed')}
        error={members.error}
        onRetry={() => void members.refetch()}
      />
    );
  } else if (!rows) {
    content = <NpListSkeleton rows={4} />;
  } else {
    content = (
      <DataTable
        columns={columns}
        data={rows}
        pageSize={50}
        showSelectedCount={false}
        getRowId={(member) => member.userId}
      />
    );
  }

  return (
    <section className='space-y-4' aria-labelledby='np-config-members-heading'>
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
      {canInvite ? <InvitationsSection /> : null}
      <InviteDialog
        open={inviting}
        projects={invitable.map((project) => ({
          id: project.id,
          name: project.name,
        }))}
        requireProject={!admin}
        onClose={() => setInviting(false)}
      />
    </section>
  );
}
