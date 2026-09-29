import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { npKeys } from '../../client/pages/np/constants.js';
import {
  revealSentComment,
  scrollAboveComposer,
  useRevealSentComment,
} from '../../client/pages/np/issues/detail/use-reveal-sent-comment.js';

function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

function placed(element: HTMLElement, top: number, height: number): void {
  element.getBoundingClientRect = () => rect(top, height);
}

/** A scroll container 600px high at the top of the screen, holding the timeline and the composer pinned at 500. */
function page(): {
  container: HTMLDivElement;
  composer: HTMLDivElement;
  comment: (id: string, top: number, height: number) => HTMLDivElement;
} {
  const container = document.createElement('div');
  container.style.overflowY = 'auto';
  const composer = document.createElement('div');
  container.append(composer);
  document.body.append(container);
  placed(container, 0, 600);
  placed(composer, 500, 100);
  const comment = (id: string, top: number, height: number) => {
    const element = document.createElement('div');
    element.dataset.commentId = id;
    placed(element, top, height);
    container.insertBefore(element, composer);
    return element;
  };
  return { container, composer, comment };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('scrollAboveComposer (NP-132)', () => {
  it('scrolls a comment hidden under the composer up to just above it', () => {
    const { container, composer, comment } = page();
    container.scrollTop = 1000;
    scrollAboveComposer(comment('c9', 520, 80), composer, container);
    // bottom 600 → 488 (12px above the composer at 500)
    expect(container.scrollTop).toBe(1112);
  });

  it('aligns a comment taller than the free space by its top', () => {
    const { container, composer, comment } = page();
    container.scrollTop = 1000;
    scrollAboveComposer(comment('c9', 300, 700), composer, container);
    expect(container.scrollTop).toBe(1288);
  });

  it('leaves a comment that is already in view alone', () => {
    const { container, composer, comment } = page();
    container.scrollTop = 1000;
    scrollAboveComposer(comment('c9', 200, 80), composer, container);
    expect(container.scrollTop).toBe(1000);
  });
});

describe('revealSentComment (NP-132)', () => {
  function frames(): () => void {
    const queue: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      queue.push(callback),
    );
    return () => queue.shift()?.(0);
  }

  it('waits for the comment to render, then brings it above the composer', () => {
    const next = frames();
    const { container, composer, comment } = page();
    container.scrollTop = 1000;
    revealSentComment(composer, { id: 'c9', parentId: 'c1' });
    next();
    // Not rendered yet, and a reply is not at the end, so nothing moves.
    expect(container.scrollTop).toBe(1000);
    comment('c9', 540, 60);
    next();
    expect(container.scrollTop).toBe(1112);
  });

  it('scrolls to the end while a top-level comment has not rendered yet', () => {
    const next = frames();
    const { container, composer } = page();
    Object.defineProperty(container, 'scrollHeight', { value: 5000 });
    revealSentComment(composer, { id: 'c9', parentId: null });
    next();
    expect(container.scrollTop).toBe(5000);
  });
});

describe('useRevealSentComment (NP-132)', () => {
  it('keeps the sent comment in view until the refetch it started has landed', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    const { container, composer, comment } = page();
    container.scrollTop = 1000;
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(
      ({ timeline }: { timeline: number }) =>
        useRevealSentComment({ current: composer }, '101', timeline),
      { wrapper, initialProps: { timeline: 1 } },
    );

    let land: (value: unknown) => void = () => {};
    act(() => {
      result.current({ id: 'c9', parentId: null });
      void queryClient.fetchQuery({
        queryKey: npKeys.issue('101'),
        queryFn: () => new Promise((resolve) => (land = resolve)),
      });
    });
    // The cache update renders the comment under the composer.
    const sent = comment('c9', 520, 80);
    rerender({ timeline: 2 });
    expect(container.scrollTop).toBe(1112);

    // The refetch adds a row above it and pushes it down again.
    placed(sent, 517, 80);
    await act(async () => land({}));
    await waitFor(() => expect(container.scrollTop).toBe(1221));

    // Afterwards the reader's scrolling is theirs.
    rerender({ timeline: 3 });
    expect(container.scrollTop).toBe(1221);
  });
});
