import { useTranslation } from '@nocobase/i18n/client';
import {
  FilterIcon,
  PinIcon,
  QuoteIcon,
  SquareDashedMousePointerIcon,
  XIcon,
} from 'lucide-react';
import type { ReactElement } from 'react';

import { NpTag } from '@/components/np-tag';
import { Button } from '@/components/ui/button';

import type { PmResolvedContext } from '../../types-pm.js';
import {
  type PmContextChip,
  type PmContextFilter,
  selectionPreview,
} from './pm-context-model.js';

/** "status=in_progress, owner=me" for a filter tag. */
export function filterText(filter: PmContextFilter): string {
  return Object.entries(filter.params)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}

function useChipText(): (chip: PmContextChip) => string {
  const { t } = useTranslation();
  return (chip) =>
    chip.kind === 'object'
      ? chip.object.label
      : chip.kind === 'filter'
        ? t('np.pmAssistant.context.filter', {
            filter: filterText(chip.filter),
          })
        : t('np.pmAssistant.context.selection', {
            text: selectionPreview(chip.selection.text),
          });
}

function ChipIcon({ chip }: { readonly chip: PmContextChip }): ReactElement {
  if (chip.kind === 'filter') return <FilterIcon aria-hidden='true' />;
  if (chip.kind === 'selection') return <QuoteIcon aria-hidden='true' />;
  return chip.pinned ? (
    <PinIcon aria-hidden='true' />
  ) : (
    <SquareDashedMousePointerIcon aria-hidden='true' />
  );
}

/** The context the next message carries, above the composer; each tag has its own remove button. */
export function PmContextChips({
  chips,
  onRemove,
}: {
  readonly chips: readonly PmContextChip[];
  readonly onRemove: (key: string) => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const text = useChipText();
  if (chips.length === 0) return null;
  return (
    <ul
      className='flex flex-wrap items-center gap-1'
      aria-label={t('np.pmAssistant.context.label')}
      data-testid='np-pm-context-chips'
    >
      {chips.map((chip) => {
        const label = text(chip);
        return (
          <li key={chip.key} className='inline-flex max-w-full items-center'>
            <NpTag
              tone={chip.kind === 'object' && chip.pinned ? 'blue' : 'grey'}
              icon={<ChipIcon chip={chip} />}
              className='max-w-60'
              title={
                chip.kind === 'selection' ? chip.selection.text : label
              }
            >
              <span className='truncate'>{label}</span>
            </NpTag>
            <Button
              variant='ghost'
              size='icon-sm'
              className='text-muted-foreground'
              aria-label={t('np.pmAssistant.context.remove', { label })}
              onClick={() => onRemove(chip.key)}
            >
              <XIcon />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

/** The context a sent message carried, as the server resolved it (§8.2), read-only under the message. */
export function PmSentContext({
  context,
}: {
  readonly context: PmResolvedContext;
}): ReactElement | null {
  const { t } = useTranslation();
  const tags: { key: string; label: string; title?: string }[] = [
    ...context.items.map((item) => ({
      key: `${item.type}:${item.id}`,
      label: item.identifier ? `${item.identifier} ${item.title}` : item.title,
    })),
  ];
  if (context.filter) {
    tags.push({
      key: 'filter',
      label: t('np.pmAssistant.context.filter', {
        filter: filterText(context.filter),
      }),
    });
  }
  if (context.selection) {
    tags.push({
      key: 'selection',
      label: t('np.pmAssistant.context.selection', {
        text: selectionPreview(context.selection.text),
      }),
      title: context.selection.text,
    });
  }
  if (tags.length === 0) return null;
  return (
    <ul
      className='mt-1.5 flex flex-wrap gap-1'
      aria-label={t('np.pmAssistant.context.sent')}
    >
      {tags.map((tag) => (
        <li key={tag.key} className='max-w-full'>
          <NpTag tone='grey' className='max-w-60' title={tag.title ?? tag.label}>
            <span className='truncate'>{tag.label}</span>
          </NpTag>
        </li>
      ))}
    </ul>
  );
}
