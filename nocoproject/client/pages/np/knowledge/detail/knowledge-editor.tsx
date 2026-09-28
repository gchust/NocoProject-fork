import { ApiClientError, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangleIcon, SaveIcon } from 'lucide-react';
import { type ReactElement, useState } from 'react';

import { NpRichTextEditor } from '@/components/np-rich-text-editor';
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';

import {
  isKnowledgeConflict,
  updateKnowledgeDoc,
} from '../../api-knowledge.js';
import { npKeys } from '../../constants.js';
import type { KnowledgeDoc } from '../../types-iter3.js';

/**
 * Editing a document (§B): title, summary, content in the shared rich-text editor, and a note for the version
 * history. Save sends `expectedVersion`; when someone saved in between the server answers 409
 * `KNOWLEDGE_VERSION_CONFLICT`, the draft is kept, a toast says so, and a banner offers to load the latest version
 * (discarding the draft) or keep the draft to copy from. ⌘Enter in the editor saves.
 */
export function KnowledgeEditor({
  doc,
  onDone,
}: {
  readonly doc: KnowledgeDoc;
  readonly onDone: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(doc.title);
  const [summary, setSummary] = useState(doc.summary ?? '');
  const [content, setContent] = useState(doc.content);
  const [note, setNote] = useState('');
  const [baseVersion] = useState(doc.version);
  const [conflict, setConflict] = useState(false);
  const dirty =
    title !== doc.title ||
    summary !== (doc.summary ?? '') ||
    content !== doc.content;

  const save = useMutation({
    mutationFn: () =>
      updateKnowledgeDoc(api, doc.id, {
        title: title.trim(),
        summary: summary.trim(),
        content,
        note: note.trim() || undefined,
        expectedVersion: baseVersion,
      }),
    onSuccess: (saved) => {
      toast.add({
        type: 'success',
        title: t('np.knowledge.saved', {
          version: saved.version ?? baseVersion + 1,
        }),
      });
      void queryClient.invalidateQueries({ queryKey: npKeys.knowledge });
      onDone();
    },
    onError: (error: unknown) => {
      if (isKnowledgeConflict(error)) {
        setConflict(true);
        toast.add({
          type: 'error',
          priority: 'high',
          title: t('np.knowledge.conflictTitle'),
          description: t('np.knowledge.conflictDescription'),
        });
        return;
      }
      toast.add({
        type: 'error',
        priority: 'high',
        title:
          error instanceof ApiClientError && error.status === 403
            ? t('np.common.forbidden')
            : t('np.common.requestFailed'),
      });
    },
  });

  function submit(): void {
    if (!title.trim() || save.isPending || conflict) return;
    save.mutate();
  }

  function loadLatest(): void {
    void queryClient.invalidateQueries({
      queryKey: npKeys.knowledgeDoc(doc.id),
    });
    onDone();
  }

  return (
    <FieldGroup className='max-w-2xl'>
      {conflict ? (
        <Alert variant='destructive'>
          <AlertTriangleIcon />
          <AlertTitle>{t('np.knowledge.conflictTitle')}</AlertTitle>
          <AlertDescription>
            {t('np.knowledge.conflictBanner', { version: baseVersion })}
          </AlertDescription>
          <AlertAction>
            <Button variant='outline' size='sm' onClick={loadLatest}>
              {t('np.knowledge.loadLatest')}
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      <Field data-invalid={!title.trim() ? true : undefined}>
        <FieldLabel htmlFor='np-knowledge-edit-title'>
          {t('np.knowledge.form.titleLabel')}
        </FieldLabel>
        <Input
          id='np-knowledge-edit-title'
          value={title}
          maxLength={200}
          aria-invalid={!title.trim() ? true : undefined}
          onChange={(event) => setTitle(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor='np-knowledge-edit-summary'>
          {t('np.knowledge.form.summary')}
        </FieldLabel>
        <Textarea
          id='np-knowledge-edit-summary'
          rows={2}
          maxLength={300}
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel>{t('np.knowledge.form.content')}</FieldLabel>
        <NpRichTextEditor
          value={content}
          onChange={setContent}
          aria-label={t('np.knowledge.form.content')}
          mentionPlacement='below'
          contentClassName='min-h-64'
          onSubmit={submit}
        />
        <FieldDescription>{t('np.knowledge.saveHint')}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor='np-knowledge-edit-note'>
          {t('np.knowledge.note')}
        </FieldLabel>
        <Input
          id='np-knowledge-edit-note'
          value={note}
          maxLength={200}
          placeholder={t('np.knowledge.notePlaceholder')}
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>
      <div className='flex justify-end gap-2'>
        <Button variant='outline' disabled={save.isPending} onClick={onDone}>
          {t('actions.cancel')}
        </Button>
        <Button
          disabled={!dirty || !title.trim() || save.isPending || conflict}
          onClick={submit}
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
