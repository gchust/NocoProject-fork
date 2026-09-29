import { useIsFetching } from '@tanstack/react-query';
import { type RefObject, useCallback, useLayoutEffect, useRef } from 'react';

import { findScrollParent } from '@/components/np-scroll-parent';

import { npKeys } from '../../constants.js';
import type { IssueComment } from '../../types.js';

type SentComment = Pick<IssueComment, 'id' | 'parentId'>;

/** Space kept between the revealed comment and the edges it is fitted between. */
const GAP = 12;
/** Frames to wait for the comment to render: the cache update renders on the next frame, a virtualized row later. */
const ATTEMPTS = 10;

/**
 * NP-132: after sending, bring the new comment into view in the detail's scroll container, just above the composer
 * pinned to its bottom, so the older activity moves up instead of the new message landing below the fold. The
 * comment stays in view until the refetch the send started has landed, since it can add rows above the comment (an
 * activity written in the same instant sorts first).
 */
export function useRevealSentComment(
  composerRef: RefObject<HTMLElement | null>,
  issueId: string,
  timeline: unknown,
): (comment: SentComment) => void {
  const pendingRef = useRef<SentComment | null>(null);
  const fetching =
    useIsFetching({ queryKey: npKeys.issue(issueId), exact: true }) > 0;
  useLayoutEffect(() => {
    const comment = pendingRef.current;
    const composer = composerRef.current;
    if (!comment || !composer) return;
    const container = findScrollParent(composer);
    const target = findComment(container, comment.id);
    if (target) scrollAboveComposer(target, composer, container);
    if (!fetching) pendingRef.current = null;
  }, [composerRef, timeline, fetching]);
  return useCallback(
    (comment: SentComment) => {
      pendingRef.current = comment;
      revealSentComment(composerRef.current, comment);
    },
    [composerRef],
  );
}

/**
 * Reveal the comment once it renders, over the next few frames. A top-level comment ends the timeline, so until its
 * row renders (a long, virtualized timeline) the container scrolls to its end.
 */
export function revealSentComment(
  composer: HTMLElement | null,
  comment: SentComment,
): void {
  if (!composer) return;
  const container = findScrollParent(composer);
  let attempt = 0;
  const step = (): void => {
    attempt += 1;
    const target = findComment(container, comment.id);
    if (target) {
      scrollAboveComposer(target, composer, container);
      return;
    }
    if (!comment.parentId) {
      if (container) container.scrollTop = container.scrollHeight;
      else window.scrollTo(0, document.documentElement.scrollHeight);
    }
    if (attempt < ATTEMPTS) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function findComment(
  container: HTMLElement | null,
  id: string,
): HTMLElement | undefined {
  return [
    ...(container ?? document).querySelectorAll<HTMLElement>(
      '[data-comment-id]',
    ),
  ].find((element) => element.dataset.commentId === id);
}

/**
 * Scroll the least that fits `target` between the top of the scroll container and the top of the composer; a target
 * taller than that space is aligned by its top.
 */
export function scrollAboveComposer(
  target: HTMLElement,
  composer: HTMLElement,
  container: HTMLElement | null,
): void {
  const top = container ? container.getBoundingClientRect().top : 0;
  const bottom = composer.getBoundingClientRect().top;
  const rect = target.getBoundingClientRect();
  let delta = 0;
  if (rect.bottom > bottom - GAP) {
    delta = Math.min(rect.bottom - bottom + GAP, rect.top - top - GAP);
  } else if (rect.top < top + GAP) {
    delta = rect.top - top - GAP;
  }
  if (delta === 0) return;
  if (container) container.scrollTop += delta;
  else window.scrollBy(0, delta);
}
