/**
 * Maps domain events to the realtime topics of protocol.md §4.1 and §6. Realtime messages are invalidation signals
 * only; HTTP stays the source of truth, so a failed publish is logged and otherwise ignored.
 */
import type { RealtimeService } from '@nocobase/app-server/realtime';

import type { DomainEvent, DomainEventBus } from './events.js';
import {
  REALTIME_TOPICS,
  REALTIME_TOPICS_PHASE1,
  type AgentsTopicPayload,
  type DaemonWakeupPayload,
  type InboxTopicPayload,
  type IssuesTopicPayload,
  type RunTopicPayload,
} from './protocol.js';

export interface NpRealtimeTopics {
  close(): void;
}

export function connectRealtime(
  realtime: RealtimeService,
  bus: DomainEventBus,
): NpRealtimeTopics {
  const issues = realtime.defineTopic<IssuesTopicPayload, 'public'>(
    REALTIME_TOPICS.issues,
    { audience: 'public' },
  );
  const agents = realtime.defineTopic<AgentsTopicPayload, 'public'>(
    REALTIME_TOPICS.agents,
    { audience: 'public' },
  );
  const daemon = realtime.defineTopic<DaemonWakeupPayload, 'user'>(
    REALTIME_TOPICS.daemon,
    { audience: 'user' },
  );
  const inbox = realtime.defineTopic<InboxTopicPayload, 'user'>(
    REALTIME_TOPICS_PHASE1.inbox,
    { audience: 'user' },
  );

  // `np:run:<runId>` is one topic per run, so it is not registered: an unregistered topic is public, which is the
  // audience §6 asks for.
  const publishRun = (runId: string, payload: RunTopicPayload) => {
    realtime.publish(REALTIME_TOPICS.run(runId), payload);
  };

  const handle = (event: DomainEvent): void => {
    switch (event.type) {
      case 'issue.changed':
        issues.publish({ kind: 'issue.changed', issueId: event.issueId });
        return;
      case 'run.status':
        publishRun(event.runId, { kind: 'run.status', status: event.status });
        return;
      case 'run.events':
        publishRun(event.runId, { kind: 'run.events', last: event.last });
        return;
      case 'agents.changed':
        agents.publish({ kind: 'agents.changed' });
        return;
      case 'daemon.workAvailable':
        daemon.publishFor(event.userId, {
          kind: 'workAvailable',
          runtimeId: event.runtimeId,
        });
        return;
      case 'daemon.cancelRequested':
        daemon.publishFor(event.userId, {
          kind: 'cancelRequested',
          runId: event.runId,
        });
        return;
      case 'inbox.changed':
        inbox.publishFor(event.userId, { kind: 'inbox.changed' });
        return;
      default:
        // Notification-module events (`issue.created`, `run.failed`, …) have no realtime topic of their own.
        return;
    }
  };

  // Several events of one transaction often name the same issue; coalesce identical messages within a tick.
  const pending = new Map<string, DomainEvent>();
  let scheduled = false;
  const unsubscribe = bus.subscribe((event) => {
    pending.set(JSON.stringify(event), event);
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const batch = Array.from(pending.values());
      pending.clear();
      for (const item of batch) {
        try {
          handle(item);
        } catch (error) {
          console.error('NocoProject realtime publish failed.', error);
        }
      }
    });
  });

  return {
    close() {
      unsubscribe();
      issues.close();
      agents.close();
      daemon.close();
      inbox.close();
    },
  };
}
