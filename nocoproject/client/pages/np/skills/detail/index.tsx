import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon, SaveIcon, Trash2Icon } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { Breadcrumbs } from '@/components/breadcrumbs';
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
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';

import { fetchMembers } from '../../api-collab.js';
import {
  deleteSkill,
  fetchSkill,
  updateSkill,
} from '../../api-agent-extras.js';
import { fetchMe } from '../../api.js';
import { npKeys } from '../../constants.js';
import { isWorkspaceAdmin, viewerFrom } from '../../permissions.js';
import type { SkillDetail } from '../../types.js';
import { SkillFiles } from './skill-files.js';

/**
 * Route `/skills/:skillId` (iteration 2 §H): the skill's name, description and SKILL.md, and its supporting files.
 * SKILL.md is edited as source (it may open with YAML front matter a rich text editor would not keep). Read-only for
 * anyone but its creator and owner/admin.
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
    <SkillEditor
      key={skill.updatedAt ?? skill.id}
      detail={detail.data}
      canEdit={canEdit}
    />
  );
}

function SkillEditor({
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
  const [name, setName] = useState(skill.name);
  const [description, setDescription] = useState(skill.description ?? '');
  const [content, setContent] = useState(skill.content ?? '');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const dirty =
    name !== skill.name ||
    description !== (skill.description ?? '') ||
    content !== (skill.content ?? '');

  const save = useMutation({
    mutationFn: () =>
      updateSkill(api, skill.id, {
        name: name.trim(),
        description: description.trim() || null,
        content,
      }),
    onSuccess: () =>
      toast.add({ type: 'success', title: t('np.skills.saved') }),
    onError: (error: unknown) =>
      toast.add({
        type: 'error',
        priority: 'high',
        title:
          error instanceof ApiClientError && error.status === 403
            ? t('np.common.forbidden')
            : error instanceof ApiClientError && error.status === 409
              ? t('np.skills.duplicate')
              : t('np.common.requestFailed'),
      }),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: npKeys.skills }),
  });
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
          canEdit ? (
            <Button variant='outline' onClick={() => setConfirmingDelete(true)}>
              <Trash2Icon data-icon='inline-start' />
              {t('np.skills.delete')}
            </Button>
          ) : undefined
        }
      />
      <FieldGroup className='max-w-2xl'>
        <Field data-invalid={!name.trim() ? true : undefined}>
          <FieldLabel htmlFor='np-skill-edit-name'>
            {t('np.skills.name')}
          </FieldLabel>
          <Input
            id='np-skill-edit-name'
            value={name}
            readOnly={!canEdit}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
          />
          {!name.trim() ? (
            <FieldError>{t('np.skills.nameRequired')}</FieldError>
          ) : null}
        </Field>
        <Field>
          <FieldLabel htmlFor='np-skill-edit-description'>
            {t('np.skills.descriptionLabel')}
          </FieldLabel>
          <Textarea
            id='np-skill-edit-description'
            rows={2}
            value={description}
            readOnly={!canEdit}
            onChange={(event) => setDescription(event.target.value)}
          />
          <FieldDescription>{t('np.skills.descriptionHint')}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor='np-skill-edit-content'>
            {t('np.skills.content')}
          </FieldLabel>
          <Textarea
            id='np-skill-edit-content'
            rows={18}
            value={content}
            readOnly={!canEdit}
            spellCheck={false}
            className='font-mono text-xs'
            onChange={(event) => setContent(event.target.value)}
          />
          <FieldDescription>{t('np.skills.contentHint')}</FieldDescription>
        </Field>
        {canEdit ? (
          <div className='flex justify-end'>
            <Button
              disabled={!dirty || !name.trim() || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? (
                <Spinner data-icon='inline-start' />
              ) : (
                <SaveIcon data-icon='inline-start' />
              )}
              {t('actions.save')}
            </Button>
          </div>
        ) : null}
      </FieldGroup>
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
