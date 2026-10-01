import { useTranslation } from '@nocobase/i18n/client';
import {
  DownloadIcon,
  FileAudioIcon,
  FileIcon,
  FileImageIcon,
  FileTextIcon,
  FileVideoIcon,
} from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';

import { FilePreviewDialog } from '@/extensions/nocobase-file-component-ui';
import {
  type FilePreviewKind,
  resolveFilePreviewKind,
} from '@/extensions/nocobase-file-component-ui/lib/file-preview';
import { buttonVariants } from '@/components/ui/button';

import {
  type CommentAttachment,
  commentFileRecord,
  formatFileSize,
} from '../../api-attachments.js';
import { useFileLabels } from './use-attachments.js';

/** The row icon by what the preview dialog will do with the file. */
function kindIcon(kind: FilePreviewKind): ReactElement {
  switch (kind) {
    case 'image':
      return <FileImageIcon aria-hidden='true' />;
    case 'audio':
      return <FileAudioIcon aria-hidden='true' />;
    case 'video':
      return <FileVideoIcon aria-hidden='true' />;
    case 'pdf':
    case 'text':
    case 'markdown':
    case 'ooxml':
    case 'office':
      return <FileTextIcon aria-hidden='true' />;
    default:
      return <FileIcon aria-hidden='true' />;
  }
}

/**
 * A comment's files (NP-216, attached through NP-214), under its text in the thread and in replies. Images the server
 * serves inline (`previewable`) show as thumbnails; every other file is a row with its name, size and a download link.
 * Clicking a thumbnail or a name opens the file components' preview dialog, which steps through all of the comment's
 * files and offers the download: images, PDF, audio and video, text and Markdown, and Office documents preview there,
 * while SVG, HTML and other active content are never rendered and fall back to the download. Nothing renders for a
 * comment without files.
 */
export function CommentAttachments({
  attachments,
  createdAt,
}: {
  readonly attachments: readonly CommentAttachment[];
  /** The comment's time, standing in for the files' own (the comment view carries none). */
  readonly createdAt: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const labels = useFileLabels();
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const records = useMemo(
    () => attachments.map((file) => commentFileRecord(file, createdAt)),
    [attachments, createdAt],
  );
  if (attachments.length === 0) return null;

  const indexed = attachments.map((attachment, index) => ({
    attachment,
    index,
  }));
  const images = indexed.filter(({ attachment }) => attachment.previewable);
  const files = indexed.filter(({ attachment }) => !attachment.previewable);

  return (
    <div
      role='group'
      aria-label={t('np.attachments.title')}
      className='space-y-2'
      data-testid='np-comment-attachments'
    >
      {images.length > 0 ? (
        <ul className='flex flex-wrap gap-2'>
          {images.map(({ attachment, index }) => (
            <li key={attachment.id}>
              <button
                type='button'
                className='block overflow-hidden rounded-md border bg-muted/30 transition-shadow hover:ring-2 hover:ring-ring/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
                aria-label={`${labels.preview}: ${attachment.filename}`}
                title={attachment.filename}
                onClick={() => setPreviewIndex(index)}
              >
                <img
                  src={attachment.contentUrl}
                  alt={attachment.filename}
                  loading='lazy'
                  className='h-28 w-auto max-w-60 object-cover'
                />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {files.length > 0 ? (
        <ul className='flex max-w-xl flex-col gap-1.5'>
          {files.map(({ attachment, index }) => (
            <li
              key={attachment.id}
              className='flex min-w-0 items-center gap-2 rounded-md border bg-background px-2 py-1'
            >
              <span className='flex shrink-0 text-muted-foreground [&_svg]:size-4'>
                {kindIcon(resolveFilePreviewKind(records[index]))}
              </span>
              <button
                type='button'
                className='min-w-0 flex-1 truncate text-left text-sm font-medium hover:underline'
                title={attachment.filename}
                onClick={() => setPreviewIndex(index)}
              >
                {attachment.filename}
              </button>
              <span className='shrink-0 text-xs text-muted-foreground tabular-nums'>
                {formatFileSize(attachment.size)}
              </span>
              <a
                className={buttonVariants({
                  variant: 'ghost',
                  size: 'icon-sm',
                })}
                href={attachment.contentUrl}
                download={attachment.filename}
                aria-label={`${labels.download}: ${attachment.filename}`}
                title={labels.download}
              >
                <DownloadIcon />
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      <FilePreviewDialog
        files={records}
        initialIndex={previewIndex ?? 0}
        open={previewIndex !== null}
        onOpenChange={(open) => {
          if (!open) setPreviewIndex(null);
        }}
        labels={labels}
      />
    </div>
  );
}
