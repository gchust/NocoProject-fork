import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { Trash2Icon } from 'lucide-react';
import { type ReactElement, useState } from 'react';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';

import {
  addProjectMember,
  removeProjectMember,
  updateProject,
} from '../../api-projects.js';
import {
  PropertyRow,
  PropertySelect,
} from '../../issues/detail/property-fields.js';
import { initials } from '../../format.js';
import type {
  Member,
  ProjectMember,
  ProjectMemberRole,
  ProjectVisibility,
} from '../../types.js';
import { useProjectMutation } from './use-project-mutation.js';

/**
 * Visibility and the project's members (§F). `members` visibility hides the project and its issues from everyone
 * but its members and owner/admin — the server enforces it. A member's role is changed by posting them again with
 * the new role, since the contract has no PATCH for project members.
 */
export function MembersSection({
  projectId,
  visibility,
  members,
  workspaceMembers,
  canEdit,
}: {
  readonly projectId: string;
  readonly visibility: ProjectVisibility;
  readonly members: readonly ProjectMember[];
  readonly workspaceMembers: readonly Member[];
  readonly canEdit: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const [adding, setAdding] = useState<string | null>(null);

  const setVisibility = useProjectMutation((next: ProjectVisibility) =>
    updateProject(api, projectId, { visibility: next }),
  );
  const upsert = useProjectMutation(
    (input: { userId: string; role: ProjectMemberRole }) =>
      addProjectMember(api, projectId, input),
  );
  const remove = useProjectMutation(
    (userId: string) => removeProjectMember(api, projectId, userId),
    t('np.projectMembers.removed'),
  );
  const busy = setVisibility.isPending || upsert.isPending || remove.isPending;

  const candidates = workspaceMembers.filter(
    (member) => !members.some((entry) => entry.userId === member.userId),
  );
  const roleOptions = [
    { value: 'lead', label: t('np.projectMembers.role.lead') },
    { value: 'member', label: t('np.projectMembers.role.member') },
  ];

  return (
    <section className='space-y-3' aria-labelledby='np-project-members-heading'>
      <h2 id='np-project-members-heading' className='text-sm font-semibold'>
        {t('np.projectMembers.title')}
      </h2>
      <PropertyRow
        label={t('np.projects.visibilityLabel')}
        htmlFor='np-project-visibility'
      >
        <PropertySelect
          id='np-project-visibility'
          options={[
            { value: 'everyone', label: t('np.projects.visibility.everyone') },
            { value: 'members', label: t('np.projects.visibility.members') },
          ]}
          value={visibility}
          disabled={!canEdit || busy}
          onChange={(value) =>
            setVisibility.mutate(value === 'members' ? 'members' : 'everyone')
          }
        />
      </PropertyRow>
      <p className='text-xs text-muted-foreground'>
        {t(`np.projects.visibilityHint.${visibility}`)}
      </p>
      {members.length === 0 ? (
        <p className='text-sm text-muted-foreground'>
          {t('np.projectMembers.empty')}
        </p>
      ) : (
        <ul className='space-y-2'>
          {members.map((member) => (
            <li key={member.userId} className='flex items-center gap-2 text-sm'>
              <Avatar size='sm'>
                <AvatarFallback>{initials(member.name)}</AvatarFallback>
              </Avatar>
              <span className='min-w-0 flex-1 truncate'>{member.name}</span>
              <div className='w-28'>
                <PropertySelect
                  id={`np-project-member-${member.userId}`}
                  options={roleOptions}
                  value={member.role}
                  disabled={!canEdit || busy}
                  onChange={(value) =>
                    upsert.mutate({
                      userId: member.userId,
                      role: value === 'lead' ? 'lead' : 'member',
                    })
                  }
                />
              </div>
              {canEdit ? (
                <Button
                  variant='ghost'
                  size='icon-xs'
                  disabled={busy}
                  aria-label={t('np.projectMembers.remove', {
                    name: member.name,
                  })}
                  onClick={() => remove.mutate(member.userId)}
                >
                  <Trash2Icon />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit && candidates.length > 0 ? (
        <div className='flex items-center gap-2'>
          <div className='min-w-0 flex-1'>
            <PropertySelect
              id='np-project-member-add'
              options={candidates.map((member) => ({
                value: member.userId,
                label: member.name,
              }))}
              value={adding}
              noneLabel={t('np.projectMembers.choose')}
              disabled={busy}
              onChange={setAdding}
            />
          </div>
          <Button
            size='sm'
            variant='outline'
            disabled={!adding || busy}
            onClick={() => {
              if (!adding) return;
              upsert.mutate(
                { userId: adding, role: 'member' },
                { onSuccess: () => setAdding(null) },
              );
            }}
          >
            {t('np.projectMembers.add')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
