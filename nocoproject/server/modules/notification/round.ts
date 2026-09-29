/**
 * One notification pass over a transaction's domain events: the recipients it touched and a name cache, plus the
 * delivery helper every event handler uses (`notification.service.ts`, `delivery-notices.ts`).
 */
import type { Tx } from '../shared/db.js';
import { unique } from '../shared/db.js';
import type { EventActor } from '../shared/events.js';
import type { IdSource } from '../shared/ids.js';
import type {
  InboxItemTypeV7,
  InboxKind,
  IssueV1,
} from '../shared/protocol.js';
import type { UserDirectory } from '../shared/users.js';
import { agentNames } from '../run/run.queries.js';
import type { WorkflowService } from '../workflow/workflow.service.js';
import { dedupeKey, deliver, subscribe } from './inbox.store.js';

export interface NotificationDeps {
  readonly ids: IdSource;
  readonly users: UserDirectory;
  readonly workflows: WorkflowService;
}

export interface Notice {
  readonly type: InboxItemTypeV7;
  readonly kind: InboxKind;
  readonly body: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly dedupeKey?: string;
}

/** Per-transaction state: the recipients touched and a name cache. */
export class Round {
  readonly touched = new Set<string>();
  private readonly names = new Map<string, string | null>();

  constructor(
    readonly tx: Tx,
    readonly deps: NotificationDeps,
  ) {}

  async actorName(actor: EventActor): Promise<string | null> {
    if (actor.type === 'system' || !actor.id) return null;
    const key = `${actor.type}:${actor.id}`;
    if (!this.names.has(key)) {
      const map =
        actor.type === 'agent'
          ? await agentNames(this.tx.conn, [actor.id])
          : await this.deps.users.names(this.tx.conn, [actor.id]);
      this.names.set(key, map.get(actor.id) ?? null);
    }
    return this.names.get(key) ?? null;
  }

  async existingUsers(
    ids: readonly (string | null | undefined)[],
  ): Promise<string[]> {
    const names = await this.deps.users.names(this.tx.conn, ids);
    return unique(ids).filter((id) => names.has(id));
  }

  /** Delivers to each recipient except the actor. */
  async notify(
    issue: IssueV1,
    recipients: readonly (string | null | undefined)[],
    actor: EventActor,
    notice: Notice,
  ): Promise<void> {
    const actorName = await this.actorName(actor);
    for (const userId of unique(recipients)) {
      if (actor.type === 'user' && actor.id === userId) continue;
      this.touched.add(
        await deliver(this.tx, this.deps.ids, {
          userId,
          kind: notice.kind,
          type: notice.type,
          issueId: issue.id,
          title: `${issue.identifier} ${issue.title}`,
          body: notice.body,
          actorType: actor.type,
          actorId: actor.id,
          actorName,
          dedupeKey:
            notice.dedupeKey ?? dedupeKey(userId, notice.type, issue.id),
          // Structured for the browser (iteration 2 §K): every item names its issue.
          payload: {
            identifier: issue.identifier,
            issueTitle: issue.title,
            ...notice.payload,
          },
        }),
      );
    }
  }

  async subscribe(
    issueId: string,
    userIds: readonly (string | null | undefined)[],
    reason: Parameters<typeof subscribe>[4],
  ): Promise<void> {
    for (const userId of unique(userIds))
      await subscribe(this.tx, this.deps.ids, issueId, userId, reason);
  }

  touch(userIds: readonly string[]): void {
    for (const userId of userIds) this.touched.add(userId);
  }
}
