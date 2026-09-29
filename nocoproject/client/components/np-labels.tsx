import type { ReactElement } from 'react';

import { cn } from '@/lib/utils';
import { NpTag } from '@/components/np-tag';
import { LABEL_DOT_CLASS, LABEL_TONE } from '@/pages/np/constants';
import type { Label, LabelColor } from '@/pages/np/types';

/** The colored dot of a label; decorative, the name beside it carries the meaning. */
export function NpLabelDot({
  color,
  className,
}: {
  readonly color: LabelColor;
  readonly className?: string;
}): ReactElement {
  return (
    <span
      aria-hidden='true'
      className={cn(
        'size-2 shrink-0 rounded-full',
        LABEL_DOT_CLASS[color] ?? LABEL_DOT_CLASS.gray,
        className,
      )}
    />
  );
}

/** A label as a tag in its colour's tint (nocosolution/guidelines/NocoSolution 前端规范.md §5.3). */
export function NpLabelChip({
  label,
}: {
  readonly label: Label;
}): ReactElement {
  return (
    <NpTag
      tone={LABEL_TONE[label.color] ?? 'grey'}
      className='max-w-40 font-normal'
    >
      <span className='truncate'>{label.name}</span>
    </NpTag>
  );
}

/** The dot and name, for list items and chips inside a picker. */
export function NpLabelName({
  label,
}: {
  readonly label: Label;
}): ReactElement {
  return (
    <span className='inline-flex min-w-0 items-center gap-1.5'>
      <NpLabelDot color={label.color} />
      <span className='truncate'>{label.name}</span>
    </span>
  );
}
