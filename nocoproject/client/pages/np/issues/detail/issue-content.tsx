import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useQuery } from '@tanstack/react-query';
import { PencilIcon } from 'lucide-react';
import { type ReactElement, useRef, useState } from 'react';

import { NpMarkdown } from '@/components/np-markdown';
import { NpRichTextEditor } from '@/components/np-rich-text-editor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';

import { fetchMembers } from '../../api-collab.js';
import { npKeys } from '../../constants.js';
import type { AgentListItem, Issue } from '../../types.js';
import { useMentionCandidates } from './mention-candidates.js';
import { useIssueUpdate } from './use-issue-update.js';

/** The issue title as the page heading; click (or the edit button) to rename, Enter saves, Escape cancels. */
export function IssueTitle({ issue }: { readonly issue: Issue }): ReactElement {
  const { t } = useTranslation();
  const update = useIssueUpdate(issue);
  const [draft, setDraft] = useState<string | null>(null);
  // Enter saves and then blurs the disabled input, which would save a second time without this guard.
  const savingRef = useRef(false);

  function save(): void {
    if (savingRef.current) return;
    const title = draft?.trim() ?? '';
    if (!title || title === issue.title) {
      setDraft(null);
      return;
    }
    savingRef.current = true;
    update.mutate(
      { title },
      {
        onSettled: () => {
          savingRef.current = false;
          setDraft(null);
        },
      },
    );
  }

  if (draft !== null) {
    return (
      <div className='flex items-center gap-2'>
        <Input
          value={draft}
          autoFocus
          maxLength={500}
          aria-label={t('np.issueForm.titleLabel')}
          className='h-10 text-xl font-semibold'
          disabled={update.isPending}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              save();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setDraft(null);
            }
          }}
        />
        {update.isPending ? <Spinner className='size-4' /> : null}
      </div>
    );
  }

  return (
    <div className='group flex items-start gap-2'>
      <h1 className='min-w-0 font-heading text-2xl font-semibold tracking-tight wrap-anywhere'>
        {issue.title}
      </h1>
      <Button
        variant='ghost'
        size='icon-sm'
        aria-label={t('np.issue.editTitle')}
        className='mt-0.5 shrink-0 opacity-60 group-hover:opacity-100 focus-visible:opacity-100'
        onClick={() => setDraft(issue.title)}
      >
        <PencilIcon />
      </Button>
    </div>
  );
}

/**
 * The description rendered as Markdown, edited in the rich text editor with Save and Cancel (iteration 2 "rich text").
 * The editor reads and writes Markdown, so the stored description stays Markdown. A save that loses the revision race
 * reports the conflict and reloads (`useIssueUpdate`); the draft stays open so nothing typed is lost.
 */
export function IssueDescription({
  issue,
  agents = [],
}: {
  readonly issue: Issue;
  readonly agents?: readonly AgentListItem[];
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const update = useIssueUpdate(issue);
  const [draft, setDraft] = useState<string | null>(null);
  const description = issue.description ?? '';
  const members = useQuery({
    queryKey: npKeys.members,
    queryFn: () => fetchMembers(api),
    enabled: draft !== null,
  });
  const candidates = useMentionCandidates(agents, members.data);

  if (draft !== null) {
    return (
      <div className='space-y-2'>
        <NpRichTextEditor
          value={draft}
          autoFocus
          aria-label={t('np.issueForm.descriptionLabel')}
          placeholder={t('np.issueForm.descriptionPlaceholder')}
          disabled={update.isPending}
          mentionCandidates={candidates}
          mentionPlacement='below'
          contentClassName='min-h-40'
          onChange={setDraft}
          onEscape={() => {
            if (!update.isPending) setDraft(null);
          }}
          onSubmit={() => {
            if (draft !== description) {
              update.mutate(
                { description: draft },
                { onSuccess: () => setDraft(null) },
              );
            }
          }}
        />
        <div className='flex justify-end gap-2'>
          <Button
            variant='outline'
            size='sm'
            disabled={update.isPending}
            onClick={() => setDraft(null)}
          >
            {t('actions.cancel')}
          </Button>
          <Button
            size='sm'
            disabled={update.isPending || draft === description}
            onClick={() =>
              update.mutate(
                { description: draft },
                { onSuccess: () => setDraft(null) },
              )
            }
          >
            {update.isPending ? <Spinner data-icon='inline-start' /> : null}
            {t('actions.save')}
          </Button>
        </div>
      </div>
    );
  }

  // Without a description the block is one muted row, so an empty issue shows no blank area (nocosolution/frontend/frontend-standard.md §3.4).
  if (!description.trim()) {
    return (
      <div className='flex items-center gap-2 text-sm text-muted-foreground'>
        <p>{t('np.issue.noDescription')}</p>
        <Button
          variant='ghost'
          size='sm'
          className='text-muted-foreground'
          onClick={() => setDraft(description)}
        >
          <PencilIcon data-icon='inline-start' />
          {t('np.issue.editDescription')}
        </Button>
      </div>
    );
  }
  return (
    <div className='group relative'>
      <NpMarkdown content={description} className='max-w-3xl' />
      <Button
        variant='ghost'
        size='sm'
        className='mt-2 text-muted-foreground'
        onClick={() => setDraft(description)}
      >
        <PencilIcon data-icon='inline-start' />
        {t('np.issue.editDescription')}
      </Button>
    </div>
  );
}
