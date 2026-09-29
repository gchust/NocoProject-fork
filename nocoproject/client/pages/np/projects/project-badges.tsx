import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import { NpProgressRing } from '@/components/np-live';
import { NpTag } from '@/components/np-tag';

import type { StatusTone } from '../constants.js';
import type { ProjectStatus } from '../types.js';
import { projectStatusKey } from './progress.js';

/** Project statuses in the issue tones (nocosolution/frontend/frontend-standard.md §S7.2). */
const PROJECT_STATUS_TONE: Readonly<Record<ProjectStatus, StatusTone>> = {
  planned: 'grey',
  in_progress: 'blue',
  paused: 'amber',
  completed: 'green',
  cancelled: 'slate',
};

/** A project's status: the same tag as an issue status. */
export function ProjectStatusBadge({
  status,
}: {
  readonly status: ProjectStatus | undefined;
}): ReactElement {
  const { t } = useTranslation();
  const value = status ?? 'planned';
  return (
    <NpTag tone={PROJECT_STATUS_TONE[value]} dot data-status={value}>
      {t(projectStatusKey(value))}
    </NpTag>
  );
}

/** Progress in a list row: a small ring and "done/total" (client/pages/np/README.md §3). */
export function ProjectProgressBar({
  done,
  total,
  percent,
  label,
}: {
  readonly done: number;
  readonly total: number;
  readonly percent: number;
  readonly label: string;
}): ReactElement {
  return (
    <div
      className='flex min-w-24 items-center gap-2'
      role='img'
      aria-label={label}
    >
      <NpProgressRing percent={percent} size={18} showValue={false} />
      <span className='text-xs text-muted-foreground tabular-nums'>
        {done}/{total}
      </span>
      <span className='text-xs text-muted-foreground tabular-nums'>
        {percent}%
      </span>
    </div>
  );
}
