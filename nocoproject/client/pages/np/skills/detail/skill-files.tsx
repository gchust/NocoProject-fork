import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileTextIcon, PlusIcon, SaveIcon, Trash2Icon } from 'lucide-react';
import { type ReactElement, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';

import {
  SKILL_FILE_MAX_BYTES,
  SKILL_MAX_FILES,
  saveSkillFiles,
  skillFilePathProblem,
} from '../../api-agent-extras.js';
import { npKeys } from '../../constants.js';
import type { SkillFile } from '../../types.js';

interface FileDraft {
  readonly key: string;
  readonly path: string;
  readonly content: string;
}

let fileSeed = 0;
function draftOf(file: Pick<SkillFile, 'path' | 'content'>): FileDraft {
  fileSeed += 1;
  return { key: `file-${fileSeed}`, path: file.path, content: file.content };
}

/**
 * A skill's supporting files (iteration 2 §H): relative paths the daemon writes next to SKILL.md. The list is edited
 * locally and saved as a whole (`PUT /np/skills/:id/files` replaces every file), at most 20 files of 64 KB each.
 */
export function SkillFiles({
  skillId,
  files,
  canEdit,
}: {
  readonly skillId: string;
  readonly files: readonly SkillFile[];
  readonly canEdit: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<FileDraft[]>(() => files.map(draftOf));
  const [dirty, setDirty] = useState(false);

  const problems = drafts.map((draft, index) => {
    const path = skillFilePathProblem(
      draft.path,
      drafts.filter((_, at) => at !== index).map((other) => other.path.trim()),
    );
    const tooLarge =
      new TextEncoder().encode(draft.content).length > SKILL_FILE_MAX_BYTES;
    return { path, tooLarge };
  });
  const blocked =
    drafts.length > SKILL_MAX_FILES ||
    problems.some((problem) => problem.path !== null || problem.tooLarge);

  const save = useMutation({
    mutationFn: () =>
      saveSkillFiles(
        api,
        skillId,
        drafts.map((draft) => ({
          path: draft.path.trim(),
          content: draft.content,
        })),
      ),
    onSuccess: () => {
      setDirty(false);
      toast.add({ type: 'success', title: t('np.skills.filesSaved') });
      void queryClient.invalidateQueries({ queryKey: npKeys.skill(skillId) });
      void queryClient.invalidateQueries({ queryKey: npKeys.skills });
    },
    onError: (error: unknown) =>
      toast.add({
        type: 'error',
        priority: 'high',
        title:
          error instanceof ApiClientError && error.status === 403
            ? t('np.common.forbidden')
            : error instanceof ApiClientError && error.status === 400
              ? t('np.skills.filesInvalid')
              : t('np.common.requestFailed'),
      }),
  });

  function change(index: number, next: Partial<FileDraft>): void {
    setDirty(true);
    setDrafts((current) =>
      current.map((draft, at) =>
        at === index ? { ...draft, ...next } : draft,
      ),
    );
  }

  return (
    <section
      className='max-w-2xl space-y-3'
      aria-labelledby='np-skill-files-heading'
    >
      <div className='flex items-center justify-between gap-2'>
        <h2
          id='np-skill-files-heading'
          className='font-heading text-sm font-semibold'
        >
          {t('np.skills.files')}
          <span className='ml-2 text-xs font-normal text-muted-foreground tabular-nums'>
            {drafts.length}/{SKILL_MAX_FILES}
          </span>
        </h2>
        {canEdit ? (
          <Button
            variant='outline'
            size='sm'
            disabled={drafts.length >= SKILL_MAX_FILES}
            onClick={() => {
              setDirty(true);
              setDrafts((current) => [
                ...current,
                draftOf({ path: '', content: '' }),
              ]);
            }}
          >
            <PlusIcon data-icon='inline-start' />
            {t('np.skills.addFile')}
          </Button>
        ) : null}
      </div>
      {drafts.length === 0 ? (
        <p className='text-sm text-muted-foreground'>
          {t('np.skills.noFiles')}
        </p>
      ) : (
        <ul className='space-y-3'>
          {drafts.map((draft, index) => (
            <li
              key={draft.key}
              className='space-y-2 rounded-lg border bg-card p-3'
            >
              <div className='flex items-center gap-2'>
                <FileTextIcon
                  className='size-4 shrink-0 text-muted-foreground'
                  aria-hidden='true'
                />
                <Input
                  value={draft.path}
                  readOnly={!canEdit}
                  placeholder='scripts/check.sh'
                  aria-label={t('np.skills.filePath')}
                  aria-invalid={problems[index].path ? true : undefined}
                  className='h-8 font-mono text-xs'
                  onChange={(event) =>
                    change(index, { path: event.target.value })
                  }
                />
                {canEdit ? (
                  <Button
                    variant='ghost'
                    size='icon-sm'
                    aria-label={t('np.skills.removeFile', {
                      path: draft.path || '—',
                    })}
                    onClick={() => {
                      setDirty(true);
                      setDrafts((current) =>
                        current.filter((_, at) => at !== index),
                      );
                    }}
                  >
                    <Trash2Icon />
                  </Button>
                ) : null}
              </div>
              {problems[index].path ? (
                <p className='text-xs text-destructive'>
                  {t(`np.skills.pathProblems.${problems[index].path}`)}
                </p>
              ) : null}
              <Textarea
                value={draft.content}
                readOnly={!canEdit}
                rows={6}
                spellCheck={false}
                aria-label={t('np.skills.fileContent', {
                  path: draft.path || '—',
                })}
                className='font-mono text-xs'
                onChange={(event) =>
                  change(index, { content: event.target.value })
                }
              />
              {problems[index].tooLarge ? (
                <p className='text-xs text-destructive'>
                  {t('np.skills.fileTooLarge')}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <div className='flex justify-end'>
          <Button
            variant='outline'
            disabled={!dirty || blocked || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? (
              <Spinner data-icon='inline-start' />
            ) : (
              <SaveIcon data-icon='inline-start' />
            )}
            {t('np.skills.saveFiles')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
