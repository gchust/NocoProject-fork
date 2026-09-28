import type { ReactNode, Ref } from 'react';
import type {
  ClientFileRepository,
  FileRecord,
} from '@nocobase/app-plugin-file/client';

export type { FileRecord } from '@nocobase/app-plugin-file/client';
export type FileUploadStatus = 'idle' | 'uploading' | 'error';

export interface FileUiLabels {
  readonly choose?: string;
  readonly empty?: string;
  readonly preview?: string;
  readonly download?: string;
  readonly remove?: string;
  readonly retry?: string;
}

/**
 * NocoProject addition (NP-78): lets the application feed files the field did not pick itself — pasted into or
 * dropped onto another element — through the same checks and upload queue. Reconcile on a Registry upgrade.
 */
export interface FileUploadFieldHandle {
  addFiles(files: readonly File[]): void;
}

export interface FileUploadFieldProps {
  readonly ref?: Ref<FileUploadFieldHandle>;
  readonly repository: ClientFileRepository;
  readonly value: readonly FileRecord[];
  readonly onChange: (value: readonly FileRecord[]) => void;
  readonly onError?: (error: Error) => void;
  readonly onStatusChange?: (status: FileUploadStatus) => void;
  readonly multiple?: boolean;
  readonly accept?: readonly string[];
  readonly maxSize?: number;
  readonly maxFiles?: number;
  readonly disabled?: boolean;
  /** Deletes metadata only; false removes the selection without deleting a record. */
  readonly removeOnDelete?: boolean;
  readonly labels?: FileUiLabels;
}

export interface FileListProps {
  readonly files: readonly FileRecord[];
  readonly onPreview?: (file: FileRecord) => void;
  readonly onDownload?: (file: FileRecord) => void;
  readonly onRemove?: (file: FileRecord) => void | Promise<void>;
  readonly onError?: (error: Error) => void;
  readonly labels?: FileUiLabels;
  readonly emptyState?: ReactNode;
}

export interface FilePreviewDialogProps {
  readonly files: readonly FileRecord[];
  readonly initialIndex?: number;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onError?: (error: Error) => void;
  readonly download?: boolean;
  readonly labels?: FileUiLabels;
}

export interface FilePreviewFieldProps {
  readonly files: readonly FileRecord[];
  readonly labels?: FileUiLabels;
  readonly emptyState?: ReactNode;
  readonly showFilenames?: boolean;
  readonly onError?: (error: Error) => void;
}

export interface FileThumbnailProps {
  readonly file: FileRecord;
  readonly url?: string;
  readonly alt?: string;
}
