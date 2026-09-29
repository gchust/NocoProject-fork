import { useTranslation } from '@nocobase/i18n/client';

import { statusLabelKey } from '../constants.js';
import { failureReasonKey } from '../format.js';
import { inboxBodyText } from '../inbox/inbox-text.js';
import type {
  IssueComment,
  IssueDetail,
  InboxItem,
  RunSummary,
} from '../types.js';

/** Reading a decision (nocosolution/guidelines/NocoSolution 前端规范.md §S3): its title, its sentence, and what explains it on the issue. */

/** The newest comment an agent wrote on the issue: its delivery note, or why it is blocked. */
export function latestAgentComment(
  detail: IssueDetail | undefined,
): IssueComment | null {
  if (!detail) return null;
  const comments = detail.threads
    .flatMap((thread) => [thread.root, ...thread.replies])
    .filter(
      (comment) => comment.authorType === 'agent' && comment.kind !== 'system',
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return comments[0] ?? null;
}

/** The newest finished run, whose summary or failure explains the delivery. */
export function latestFinishedRun(
  detail: IssueDetail | undefined,
): RunSummary | null {
  if (!detail) return null;
  return (
    [...detail.runs]
      .filter((run) => run.status === 'completed' || run.status === 'failed')
      .sort((a, b) =>
        (b.finishedAt ?? b.createdAt).localeCompare(
          a.finishedAt ?? a.createdAt,
        ),
      )[0] ?? null
  );
}

/** The one sentence under a decision's title, in the viewer's language (the server's English body otherwise). */
export function useDecisionSentence(): (item: InboxItem) => string | null {
  const { t } = useTranslation();
  return (item) => {
    const localized = inboxBodyText(
      item,
      (key) => t(statusLabelKey(key), { defaultValue: key }),
      (reason) => t(failureReasonKey(reason), { defaultValue: reason }),
    );
    return localized ? t(localized.key, localized.values) : item.body;
  };
}

/** A decision's title ("Delivery to accept"), falling back to the inbox type label. */
export function useDecisionTitle(): (item: Pick<InboxItem, 'type'>) => string {
  const { t } = useTranslation();
  return (item) =>
    t(`np.decision.titles.${item.type}`, {
      defaultValue: t(`np.inbox.types.${item.type}`, {
        defaultValue: item.type,
      }),
    });
}
