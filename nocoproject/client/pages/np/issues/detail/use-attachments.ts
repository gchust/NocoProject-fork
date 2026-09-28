import { ApiClientError, useService } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import {
  type ClipboardEvent,
  type DragEvent,
  type RefObject,
  useMemo,
} from 'react';

import {
  clientFileRepositoryManagerToken,
  type FileUploadFieldHandle,
} from '@/extensions/nocobase-file-component-ui';

import { ATTACHMENT_RESOURCE } from '../../api-attachments.js';

/**
 * Shared by the attachments section and the manual "new issue" form (NP-78): the upload repository, the file
 * components' labels and the upload error wording.
 */

/** The file plugin's client repository for attachment uploads (`npFiles`). */
export function useAttachmentRepository() {
  const manager = useService(clientFileRepositoryManagerToken);
  return useMemo(() => manager.repository(ATTACHMENT_RESOURCE), [manager]);
}

/** The labels the file components take, in the application's wording. */
export function useFileLabels() {
  const { t } = useTranslation();
  return {
    choose: t('np.attachments.choose'),
    preview: t('np.attachments.preview'),
    download: t('np.attachments.download'),
    remove: t('np.attachments.remove'),
    retry: t('np.attachments.retry'),
  };
}

/** An upload error in the application's words (the plugin's codes for size and type). */
export function uploadErrorTitle(
  t: (key: string) => string,
  error: Error,
): string {
  if (error instanceof ApiClientError && error.status === 413)
    return t('np.attachments.tooLarge');
  return t('np.attachments.uploadFailed');
}

/** Whether a drag carries files (not text or a link). */
function carriesFiles(data: DataTransfer | null): boolean {
  return !!data && Array.from(data.types).includes('Files');
}

/**
 * Handlers that hand files pasted into or dropped onto an element (a description box, a card) to an upload field.
 * Text pastes and drops pass through untouched.
 */
export function usePasteDrop(field: RefObject<FileUploadFieldHandle | null>): {
  onPaste: (event: ClipboardEvent) => void;
  onDragOver: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
} {
  return useMemo(
    () => ({
      onPaste: (event: ClipboardEvent) => {
        const files = Array.from(event.clipboardData.files);
        if (files.length === 0) return;
        event.preventDefault();
        field.current?.addFiles(files);
      },
      onDragOver: (event: DragEvent) => {
        if (carriesFiles(event.dataTransfer)) event.preventDefault();
      },
      onDrop: (event: DragEvent) => {
        const files = Array.from(event.dataTransfer.files);
        if (files.length === 0) return;
        event.preventDefault();
        field.current?.addFiles(files);
      },
    }),
    [field],
  );
}
