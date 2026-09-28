import { realtimeClientToken, useService } from '@nocobase/app-client';
import { useEffect, useRef } from 'react';

/**
 * Subscribes to a realtime topic for as long as the component is mounted (protocol §6).
 *
 * Events are invalidation signals only; HTTP stays authoritative. The listener is also called with `undefined`
 * whenever the connection (re)opens, so whatever was published while disconnected is recovered by a refetch.
 * Pass `null` as the topic to stay unsubscribed.
 */
export function useRealtimeTopic<Payload>(
  topic: string | null,
  listener: (payload: Payload | undefined) => void,
): void {
  const realtime = useService(realtimeClientToken);
  const listenerRef = useRef(listener);
  useEffect(() => {
    listenerRef.current = listener;
  });

  useEffect(() => {
    if (!topic) return undefined;
    const unsubscribe = realtime.subscribe<Payload>(topic, (event) => {
      listenerRef.current(event.payload);
    });
    const offOpen = realtime.onOpen(() => {
      listenerRef.current(undefined);
    });
    return () => {
      unsubscribe();
      offOpen();
    };
  }, [realtime, topic]);
}
