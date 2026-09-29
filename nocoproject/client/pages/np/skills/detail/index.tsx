import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { Breadcrumbs } from '@/components/breadcrumbs';
import { NpMarkdown } from '@/components/np-markdown';
import { NpDetailSkeleton } from '@/components/np-states';
import { PageContainer } from '@/components/page-container';
import { PageHeader } from '@/components/page-header';
import { RouteChildPage } from '@/components/route-child-page';
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from '@/components/ui/toast';

import { fetchMembers } from '../../api-collab.js';
import {
  deleteSkill,
  fetchSkill,
  stripSkillFrontMatter,
} from '../../api-agent-extras.js';
import { fetchMe } from '../../api.js';
import { npKeys } from '../../constants.js';
import { isWorkspaceAdmin, viewerFrom } from '../../permissions.js';
import type { SkillDetail } from '../../types.js';
import { SkillAgents } from './skill-agents.js';
import { SkillEditor } from './skill-editor.js';
import { SkillFiles } from './skill-files.js';

/**
 * Route `/skills/:skillId` (NP-140, iteration 2 §H): the skill's rendered SKILL.md by default (YAML front matter is
 * stripped from the body; name and description sit above it as properties), the agents it is mounted on, and its
 * supporting files. Its creator and owner/admin get an "edit" action opening the source form (name, description,
 * content); saving or cancelling returns to the reading view. Read-only for everyone else.
 */
export default function SkillDetailPage(): ReactElement {
  const { skillId = '' } = useParams();
  return (
    <RouteChildPage>
      <SkillView key={skillId} skillId={skillId} />
    </RouteChildPage>
  );
}

function SkillView({ skillId }: { readonly skillId: string }): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const detail = useQuery({
    queryKey: npKeys.skill(skillId),
    queryFn: ({ signal }) => fetchSkill(api, skillId, signal),
    retry: (count, error) =>
      !(error instanceof ApiClientError && [403, 404].includes(error.status)) &&
      count < 2,
  });
  const me = useQuery({ queryKey: npKeys.me, queryFn: () => fetchMe(api) });
  const members = useQuery({
    queryKey: npKeys.members,
    queryFn: () => fetchMembers(api),
  });

  if (detail.isError && !detail.data) {
    const notFound =
      detail.error instanceof ApiClientError && detail.error.status === 404;
    return (
      <PageContainer>
        <Breadcrumbs />
        <Alert variant='destructive'>
          <AlertCircleIcon />
          <AlertTitle>{t('np.skills.loadFailed')}</AlertTitle>
          <AlertDescription>
            {notFound ? t('np.skills.notFound') : t('np.common.requestFailed')}
          </AlertDescription>
          <AlertAction>
            <Button
              variant='outline'
              size='sm'
              nativeButton={false}
              render={<Link to='..' relative='path' />}
            >
              {t('np.skills.backToList')}
            </Button>
          </AlertAction>
        </Alert>
      </PageContainer>
    );
  }
  if (!detail.data) return <NpDetailSkeleton />;
  const viewer = viewerFrom(me.data?.userId, members.data);
  const { skill } = detail.data;
  const canEdit =
    skill.canEdit ??
    (isWorkspaceAdmin(viewer) ||
      (!!skill.createdById && skill.createdById === viewer?.userId));
  return (
    <SkillDetailBody key={skill.id} detail={detail.data} canEdit={canEdit} />
  );
}

function SkillDetailBody({
  detail,
  canEdit,
}: {
  readonly detail: SkillDetail;
  readonly canEdit: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { skill } = detail;
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const remove = useMutation({
    mutationFn: () => deleteSkill(api, skill.id),
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: t('np.skills.deleted', { name: skill.name }),
      });
      void queryClient.invalidateQueries({ queryKey: npKeys.skills });
      void queryClient.invalidateQueries({ queryKey: npKeys.agents });
      void navigate('/skills');
    },
    onError: () =>
      toast.add({
        type: 'error',
        priority: 'high',
        title: t('np.common.requestFailed'),
      }),
  });

  const body = stripSkillFrontMatter(skill.content ?? '');

  return (
    <PageContainer>
      <Breadcrumbs />
      <PageHeader
        title={skill.name}
        description={
          <>
            <span className='font-mono text-xs'>{skill.slug}</span>
            {canEdit ? null : <span> · {t('np.skills.readOnly')}</span>}
          </>
        }
        actions={
          canEdit && !editing ? (
            <>
              <Button
                variant='outline'
                onClick={() => setConfirmingDelete(true)}
              >
                <Trash2Icon data-icon='inline-start' />
                {t('np.skills.delete')}
              </Button>
              <Button onClick={() => setEditing(true)}>
                <PencilIcon data-icon='inline-start' />
                {t('np.skills.edit')}
              </Button>
            </>
          ) : undefined
        }
      />
      {skill.description ? (
        <p className='max-w-2xl text-sm text-muted-foreground'>
          {skill.description}
        </p>
      ) : null}
      {editing ? (
        <SkillEditor
          key={skill.updatedAt ?? skill.id}
          skill={skill}
          onDone={() => setEditing(false)}
        />
      ) : (
        <Card className='max-w-2xl'>
          <CardContent>
            {body.trim() ? (
              <NpMarkdown content={body} />
            ) : (
              <p className='text-sm text-muted-foreground'>
                {t('np.skills.emptyContent')}
              </p>
            )}
          </CardContent>
        </Card>
      )}
      <SkillAgents agents={detail.agents} />
      <SkillFiles skillId={skill.id} files={detail.files} canEdit={canEdit} />
      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('np.skills.deleteTitle', { name: skill.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('np.skills.deleteDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant='destructive'
              onClick={() => {
                setConfirmingDelete(false);
                remove.mutate();
              }}
            >
              {t('np.skills.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  );
}
