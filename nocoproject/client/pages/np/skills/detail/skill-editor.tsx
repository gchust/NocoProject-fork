import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SaveIcon } from 'lucide-react';
import { type ReactElement, useState } from 'react';

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

import { updateSkill } from '../../api-agent-extras.js';
import { npKeys } from '../../constants.js';
import type { Skill } from '../../types.js';

/**
 * Editing a skill's name, description and SKILL.md as source (it may open with YAML front matter a rich text editor
 * would not keep). Saves with a plain `PATCH`; cancel and a successful save both return to the reading view.
 */
export function SkillEditor({
  skill,
  onDone,
}: {
  readonly skill: Skill;
  readonly onDone: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [name, setName] = useState(skill.name);
  const [description, setDescription] = useState(skill.description ?? '');
  const [content, setContent] = useState(skill.content ?? '');
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
    onSuccess: () => {
      toast.add({ type: 'success', title: t('np.skills.saved') });
      onDone();
    },
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

  return (
    <FieldGroup className='max-w-2xl'>
      <Field data-invalid={!name.trim() ? true : undefined}>
        <FieldLabel htmlFor='np-skill-edit-name'>
          {t('np.skills.name')}
        </FieldLabel>
        <Input
          id='np-skill-edit-name'
          value={name}
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
          spellCheck={false}
          className='font-mono text-xs'
          onChange={(event) => setContent(event.target.value)}
        />
        <FieldDescription>{t('np.skills.contentHint')}</FieldDescription>
      </Field>
      <div className='flex justify-end gap-2'>
        <Button variant='outline' disabled={save.isPending} onClick={onDone}>
          {t('actions.cancel')}
        </Button>
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
    </FieldGroup>
  );
}
