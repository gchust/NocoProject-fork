import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  MailIcon,
  MailOpenIcon,
} from 'lucide-react';

/** The icon of each read / archive toggle, shared by the card menu and the detail pane. */
export const INBOX_ACTION_ICON = {
  read: MailOpenIcon,
  unread: MailIcon,
  archive: ArchiveIcon,
  unarchive: ArchiveRestoreIcon,
} as const;
