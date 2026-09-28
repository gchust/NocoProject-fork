import { useApiClient } from '@nocobase/app-client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchRunEvents } from '../../api.js';
import type { RunEvent } from '../../types.js';

export interface RunEventsState {
  readonly events: readonly RunEvent[];
  readonly loaded: boolean;
  readonly error: unknown;
}

/** Merges a batch into the list by `seq`; duplicate sequence numbers (a repeated delivery) are ignored. */
export function mergeRunEvents(
  current: readonly RunEvent[],
  batch: readonly RunEvent[],
): readonly RunEvent[] {
  if (batch.length === 0) return current;
  const bySeq = new Map(current.map((event) => [event.seq, event]));
  for (const event of batch) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * Streams a run's transcript by incremental fetches of `GET /np/runs/:id/events?since=<last>`.
 *
 * `fetchMore` is safe to call from anywhere — a realtime signal, a poll tick, a button: concurrent calls collapse
 * into one request followed by one catch-up request, so nothing is fetched twice and nothing arriving mid-request
 * is missed. While `polling` is true the hook also fetches every three seconds as a fallback for lost signals.
 */
export function useRunEvents(
  runId: string,
  polling: boolean,
): RunEventsState & { readonly fetchMore: () => void } {
  const api = useApiClient();
  const [state, setState] = useState<RunEventsState>({
    events: [],
    loaded: false,
    error: undefined,
  });
  const lastRef = useRef<number | undefined>(undefined);
  const inflightRef = useRef(false);
  const againRef = useRef(false);
  const aliveRef = useRef(true);

  const fetchMore = useCallback((): void => {
    if (inflightRef.current) {
      againRef.current = true;
      return;
    }
    inflightRef.current = true;
    const run = async (): Promise<void> => {
      try {
        do {
          againRef.current = false;
          const response = await fetchRunEvents(api, runId, lastRef.current);
          if (!aliveRef.current) return;
          const batch = response.data ?? [];
          const batchLast = batch.reduce<number | undefined>(
            (max, event) =>
              max === undefined || event.seq > max ? event.seq : max,
            undefined,
          );
          const last =
            typeof response.last === 'number' ? response.last : batchLast;
          if (last !== undefined) {
            lastRef.current = Math.max(lastRef.current ?? last, last);
          }
          setState((previous) => ({
            events: mergeRunEvents(previous.events, batch),
            loaded: true,
            error: undefined,
          }));
        } while (againRef.current);
      } catch (error: unknown) {
        if (aliveRef.current) {
          setState((previous) => ({ ...previous, loaded: true, error }));
        }
      } finally {
        inflightRef.current = false;
      }
    };
    void run();
  }, [api, runId]);

  useEffect(() => {
    aliveRef.current = true;
    fetchMore();
    return () => {
      aliveRef.current = false;
    };
  }, [fetchMore]);

  useEffect(() => {
    if (!polling) return undefined;
    const timer = window.setInterval(fetchMore, 3000);
    return () => window.clearInterval(timer);
  }, [polling, fetchMore]);

  return { ...state, fetchMore };
}
