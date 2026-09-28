import { useApiClient } from '@nocobase/app-client';
import type { FileRecord } from '@nocobase/app-plugin-file/client';
import { useTranslation } from '@nocobase/i18n/client';
import { DownloadIcon, Trash2Icon, UploadIcon } from 'lucide-react';
import {
  type ClipboardEvent,
  type DragEvent,
  type ReactElement,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  type FileUploadFieldHandle,
  FilePreviewDialog,
  FileThumbnail,
  FileUploadField,
} from '@/extensions/nocobase-file-component-ui';
import { NpSectionHeading } from '@/components/np-section';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';

import {
  ATTACHMENT_MAX_FILES,
  ATTACHMENT_MAX_FILE_SIZE,
  attachFiles,
  formatFileSize,
  type IssueAttachment,
  removeAttachment,
  toFileRecord,
} from '../../api-attachments.js';
import { useNpFormatters } from '../../format.js';
import {
  usePasteDrop,
  uploadErrorTitle,
  useAttachmentRepository,
  useFileLabels,
} from './use-attachments.js';
import { useDetailMutation } from './use-detail-mutation.js';

/**
 * Issue attachments (NP-78): a card listing each file (thumbnail, name opening the preview, size, uploader, time),
 * download, and removal for those allowed (confirmed). "上传" opens the upload field, and so do files dropped or pasted
 * onto the card; every finished upload is attached right away. Rendered by the main column only when the issue has attachments or the "添加 → 附件" chip
 * revealed it (empty sections take no room).
 */
export function AttachmentsSection({
  issueId,
  attachments,
  initialUploading = false,
}: {
  readonly issueId: string;
  readonly attachments: readonly IssueAttachment[];
  readonly initialUploading?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const format = useNpFormatters();
  const repository = useAttachmentRepository();
  const labels = useFileLabels();
  const [uploading, setUploading] = useState(initialUploading);
  const [pending, setPending] = useState<readonly FileRecord[]>([]);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<IssueAttachment | null>(null);
  const records = useMemo(() => attachments.map(toFileRecord), [attachments]);
  const uploadRef = useRef<FileUploadFieldHandle>(null);
  // Files dropped or pasted anywhere on the card open the upload field and start uploading.
  const handlers = usePasteDrop(uploadRef);
  const cardDrop = {
    onDragOver: handlers.onDragOver,
    onDrop: (event: DragEvent) => {
      setUploading(true);
      handlers.onDrop(event);
    },
    onPaste: (event: ClipboardEvent) => {
      if (event.clipboardData.files.length > 0) setUploading(true);
      handlers.onPaste(event);
    },
  };

  const attach = useDetailMutation(
    issueId,
    (fileIds: readonly string[]) => attachFiles(api, issueId, fileIds),
    { success: t('np.attachments.added') },
  );
  const remove = useDetailMutation(
    issueId,
    (attachment: IssueAttachment) =>
      removeAttachment(api, issueId, attachment.id),
    { success: t('np.attachments.removed') },
  );

  const onUploaded = (next: readonly FileRecord[]): void => {
    const added = next.filter(
      (record) => !pending.some((item) => item.id === record.id),
    );
    setPending(next);
    if (added.length === 0) return;
    const ids = added.map((record) => record.id);
    attach.mutate(ids, {
      onSuccess: () =>
        setPending((current) =>
          current.filter((record) => !ids.includes(record.id)),
        ),
    });
  };

  return (
    <section
      className='space-y-3 rounded-lg border bg-card p-4 text-card-foreground'
      aria-labelledby='np-attachments-heading'
      {...cardDrop}
    >
      <NpSectionHeading
        id='np-attachments-heading'
        title={t('np.attachments.title')}
        count={attachments.length}
        actions={
          <Button
            variant='ghost'
            size='sm'
            aria-expanded={uploading}
            onClick={() => setUploading((open) => !open)}
          >
            <UploadIcon data-icon='inline-start' />
            {t('np.attachments.upload')}
          </Button>
        }
      />
      {attachments.length > 0 ? (
        <ul className='divide-y'>
          {attachments.map((attachment, index) => (
            <li
              key={attachment.id}
              className='flex min-w-0 items-center gap-3 py-2 first:pt-0 last:pb-0'
            >
              <div className='flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted/30 text-muted-foreground'>
                <FileThumbnail file={records[index]} />
              </div>
              <div className='min-w-0 flex-1'>
                <button
                  type='button'
                  className='block max-w-full truncate text-left text-sm font-medium hover:underline'
                  title={attachment.filename}
                  onClick={() => setPreviewIndex(index)}
                >
                  {attachment.filename}
                </button>
                <div className='truncate text-xs text-muted-foreground'>
                  {[
                    formatFileSize(attachment.size),
                    attachment.uploadedByName,
                    format.relative(attachment.createdAt),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              <div className='flex shrink-0 items-center gap-1'>
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
                {attachment.canDelete ? (
                  <Button
                    variant='ghost'
                    size='icon-sm'
                    aria-label={`${labels.remove}: ${attachment.filename}`}
                    title={labels.remove}
                    disabled={remove.isPending}
                    onClick={() => setConfirm(attachment)}
                  >
                    <Trash2Icon />
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {/* Always mounted, so files dropped or pasted onto the closed card reach it. */}
      <div hidden={!uploading}>
        <FileUploadField
          ref={uploadRef}
          repository={repository}
          value={pending}
          onChange={onUploaded}
          multiple
          maxFiles={ATTACHMENT_MAX_FILES}
          maxSize={ATTACHMENT_MAX_FILE_SIZE}
          labels={labels}
          onError={(error) =>
            toast.add({
              type: 'error',
              priority: 'high',
              title: uploadErrorTitle(t, error),
            })
          }
        />
      </div>
      <FilePreviewDialog
        files={records}
        initialIndex={previewIndex ?? 0}
        open={previewIndex !== null}
        onOpenChange={(open) => {
          if (!open) setPreviewIndex(null);
        }}
        labels={labels}
      />
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('np.attachments.removeTitle', {
                filename: confirm?.filename ?? '',
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('np.attachments.removeDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant='destructive'
              onClick={() => {
                if (confirm) remove.mutate(confirm);
                setConfirm(null);
              }}
            >
              {t('np.attachments.remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
