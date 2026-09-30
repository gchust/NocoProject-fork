// @temporary(nocobase-official): to be replaced by the official NocoBase activity stream and change events
/**
 * Activity recorder: one row in `activities` per change to an issue, written in the caller's transaction so the
 * activity exists exactly when the change does.
 */
import type { ActorAccess } from './access.js';
import type { Conn } from './db.js';
import { now, toJson } from './db.js';
import type { IdSource } from './ids.js';
import type { ActorType } from './protocol.js';

/**
 * How a signed-in user reached the API when it was not the browser: `cli` for the CLI user mode (API key plus the
 * `x-np-client: nocoproject-cli/<version>` header), `api_key` for any other API-key client. Traceability only; never
 * used for permission checks.
 */
export type ActorVia = 'cli' | 'api_key' | 'pm' | 'pm_plan';

/**
 * NP-183: what the project manager acted for. `pm`: its run wrote directly in the asker's name (`agentId`, the run in
 * `Actor.runId`); `pm_plan`: the member executed its plan card (`planId`). Recorded on activities, never checked.
 */
export interface ActorPmContext {
  readonly conversationId: string;
  readonly agentId?: string;
  readonly planId?: string;
}

/**
 * Who performed an operation. `runId` is set when an agent acts through a run token (and, with `via: 'pm'`, when the
 * project manager's run acts in a member's name); `via` when a user acts through an API key instead of a browser
 * session, or through the project manager; `access` (NP-117) when a signed-in user's request carries the built-in
 * authorization, which then decides the user's role and settings capabilities.
 */
export interface Actor {
  readonly type: ActorType;
  readonly id: string | null;
  readonly runId?: string;
  readonly via?: ActorVia;
  readonly access?: ActorAccess;
  readonly pm?: ActorPmContext;
}

export const SYSTEM_ACTOR: Actor = { type: 'system', id: null };

export interface ActivityInput {
  readonly issueId: string;
  readonly actor: Actor;
  readonly action: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ActivityRecorder {
  record(conn: Conn, input: ActivityInput): Promise<void>;
}

export function createActivityRecorder(ids: IdSource): ActivityRecorder {
  return {
    async record(conn, input) {
      const { runId, via, pm } = input.actor;
      const details =
        runId !== undefined || via !== undefined
          ? {
              ...input.details,
              ...(runId !== undefined ? { runId } : {}),
              ...(via !== undefined ? { via } : {}),
              ...(pm ?? {}),
            }
          : input.details;
      await conn.query
        .insertInto('activities')
        .values({
          id: ids.next(),
          issueId: input.issueId,
          actorType: input.actor.type,
          actorId: input.actor.id,
          action: input.action,
          details: toJson(details ?? null),
          createdAt: now(),
        })
        .execute();
    },
  };
}
