import { useTranslation } from '@nocobase/i18n/client';
import { type ReactElement, useMemo, useState } from 'react';

import {
  FilePreviewDialog,
  FileThumbnail,
} from '@/extensions/nocobase-file-component-ui';
import { NpSectionHeading } from '@/components/np-section';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { formatFileSize, toFileRecord } from '../api-attachments.js';
import { useFileLabels } from '../issues/detail/use-attachments.js';
import type { IntakeBatchAttachment } from '../types.js';
import { type DraftRow, attachmentHolder } from './intake-model.js';

/**
 * NP-78: the files that travel with a batch, above its drafts. Each row shows the file (name opens the preview), what
 * AI 整理 read of it, and the draft whose issue will receive it; while the batch is a draft the target can be changed.
 */
export function IntakeAttachments({
  attachments,
  rows,
  readOnly,
  onMove,
}: {
  readonly attachments: readonly IntakeBatchAttachment[];
  readonly rows: readonly DraftRow[];
  readonly readOnly: boolean;
  readonly onMove: (fileId: string, rowIndex: number) => void;
}): ReactElement {
  const { t } = useTranslation();
  const labels = useFileLabels();
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const records = useMemo(
    () =>
      attachments.map((file) =>
        toFileRecord({
          ...file,
          uploadedById: null,
          uploadedByName: null,
          createdAt: '',
          updatedAt: '',
          canDelete: false,
        }),
      ),
    [attachments],
  );
  const items = rows.map((row, index) => ({
    value: String(index),
    label: `${row.position}. ${row.fields.title.trim() || t('np.intake.untitled')}`,
  }));

  return (
    <section
      className='space-y-3 rounded-lg border bg-card p-4 text-card-foreground'
      aria-labelledby='np-intake-attachments-heading'
    >
      <NpSectionHeading
        id='np-intake-attachments-heading'
        title={t('np.attachments.title')}
        count={attachments.length}
      />
      <ul className='divide-y'>
        {attachments.map((file, index) => (
          <li
            key={file.id}
            className='flex min-w-0 flex-wrap items-center gap-3 py-2 first:pt-0 last:pb-0'
          >
            <div className='flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted/30 text-muted-foreground'>
              <FileThumbnail file={records[index]} />
            </div>
            <div className='min-w-0 flex-1'>
              <button
                type='button'
                className='block max-w-full truncate text-left text-sm font-medium hover:underline'
                title={file.filename}
                onClick={() => setPreviewIndex(index)}
              >
                {file.filename}
              </button>
              <div className='text-xs text-muted-foreground'>
                {[
                  formatFileSize(file.size),
                  file.readStatus
                    ? t(`np.attachments.readStatus.${file.readStatus.state}`)
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            {rows.length > 0 ? (
              <div className='flex shrink-0 items-center gap-2 text-sm text-muted-foreground'>
                <span id={`np-intake-attachment-${file.id}`}>
                  {t('np.attachments.attachTo')}
                </span>
                <Select
                  items={items}
                  value={String(attachmentHolder(rows, file.id))}
                  disabled={readOnly}
                  onValueChange={(value) => {
                    if (value !== null) onMove(file.id, Number(value));
                  }}
                >
                  <SelectTrigger
                    className='w-56 max-w-full'
                    aria-labelledby={`np-intake-attachment-${file.id}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {items.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <FilePreviewDialog
        files={records}
        initialIndex={previewIndex ?? 0}
        open={previewIndex !== null}
        onOpenChange={(open) => {
          if (!open) setPreviewIndex(null);
        }}
        labels={labels}
      />
    </section>
  );
}
