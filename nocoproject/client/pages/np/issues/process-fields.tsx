import { useTranslation } from '@nocobase/i18n/client';
import { DraftingCompassIcon, NotebookPenIcon } from 'lucide-react';
import type { ReactElement } from 'react';

import { NpTag } from '@/components/np-tag';

import { issueProcess, type CommentTag } from '../api-iter4.js';
import type { IssueListItem } from '../types.js';
import { PROCESS_CHOICES, type ProcessChoice } from '../types-iter4.js';
import { PropertySelect } from './detail/property-fields.js';

/**
 * The design-first marker (iteration 4 §B): a tinted tag beside the status in the issue header and on board cards.
 * A direct issue has none, so the marker only appears where it changes what happens next.
 */
export function NpProcessBadge({
  issue,
}: {
  readonly issue: Pick<IssueListItem, 'process'>;
}): ReactElement | null {
  const { t } = useTranslation();
  if (issueProcess(issue) !== 'design_first') return null;
  return (
    <NpTag
      tone='blue'
      icon={<DraftingCompassIcon aria-hidden='true' />}
      data-process='design_first'
    >
      {t('np.process.badge')}
    </NpTag>
  );
}

/** The tag of a proposal or retrospective comment in the timeline (iteration 4 §B, §C). */
export function NpCommentTag({
  tag,
}: {
  readonly tag: CommentTag;
}): ReactElement | null {
  const { t } = useTranslation();
  if (tag === 'proposal') {
    return (
      <NpTag
        tone='blue'
        icon={<DraftingCompassIcon aria-hidden='true' />}
        data-comment-tag='proposal'
      >
        {t('np.proposal.tag')}
      </NpTag>
    );
  }
  if (tag === 'retrospective') {
    return (
      <NpTag
        tone='green'
        icon={<NotebookPenIcon aria-hidden='true' />}
        data-comment-tag='retrospective'
      >
        {t('np.retrospective.tag')}
      </NpTag>
    );
  }
  return null;
}

/** 自动 / 直接开发 / 先出方案 as a select; `choices` narrows it (the issue page offers no "automatic"). */
export function ProcessSelect({
  id,
  value,
  onChange,
  disabled,
  size = 'default',
  choices = PROCESS_CHOICES,
  'aria-label': ariaLabel,
}: {
  readonly id: string;
  readonly value: ProcessChoice;
  readonly onChange: (value: ProcessChoice) => void;
  readonly disabled?: boolean;
  readonly size?: 'sm' | 'default';
  readonly choices?: readonly ProcessChoice[];
  readonly 'aria-label'?: string;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <PropertySelect
      id={id}
      size={size}
      aria-label={ariaLabel}
      options={choices.map((choice) => ({
        value: choice,
        label: t(`np.process.choices.${choice}`),
      }))}
      value={value}
      disabled={disabled}
      onChange={(next) => {
        const choice = choices.find((candidate) => candidate === next);
        if (choice) onChange(choice);
      }}
    />
  );
}
