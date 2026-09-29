import type { InboxItem } from '../types.js';

/**
 * The localized sentence of an inbox card, from its `type` and `payload` (iteration 1 leftover "localize the inbox
 * by type + payload", iteration 2 §K). Returns the locale key under `np.inboxBody` with its values, or null when the
 * payload lacks what the sentence needs — the card then shows the server's English `body`.
 *
 * `status` and `failure` translate a status key and a failure reason; they are passed in so this stays pure.
 */
export interface InboxText {
  readonly key: string;
  readonly values: Readonly<Record<string, string | number>>;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function count(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.length;
  return null;
}

export function inboxBodyText(
  item: Pick<InboxItem, 'type' | 'payload' | 'actorName'>,
  status: (key: string) => string,
  failure: (reason: string) => string,
): InboxText | null {
  const payload = item.payload ?? {};
  const actor = item.actorName ?? '';
  const from = text(payload.from) ?? text(payload.fromStatus);
  const to = text(payload.to) ?? text(payload.toStatus);
  const key = (name: string, values: Record<string, string | number> = {}) => ({
    key: `np.inboxBody.${name}`,
    values: { actor, ...values },
  });

  switch (item.type as string) {
    case 'review_requested':
      return to ? key('review_requested', { to: status(to) }) : null;
    case 'status_changed':
      return from && to
        ? key('status_changed', { from: status(from), to: status(to) })
        : null;
    case 'agent_blocked':
      return key('agent_blocked');
    case 'run_failed': {
      const reason = text(payload.reason);
      return reason ? key('run_failed', { reason: failure(reason) }) : null;
    }
    case 'proposal_pending': {
      const pending = count(payload.pending);
      return pending !== null
        ? key('proposal_pending', { count: pending })
        : null;
    }
    case 'batch_done': {
      const stage = payload.stage;
      return typeof stage === 'number'
        ? key('batch_done_stage', { stage })
        : key('batch_done');
    }
    case 'dependency_released': {
      const identifier = text(payload.releasedByIdentifier);
      return identifier ? key('dependency_released', { identifier }) : null;
    }
    case 'commented':
      return key('commented');
    case 'mentioned':
      return key('mentioned');
    case 'owner_assigned':
      return key('owner_assigned');
    case 'executor_assigned':
      return key('executor_assigned');
    case 'approval_pending':
      return from && to
        ? key('approval_pending', { from: status(from), to: status(to) })
        : null;
    case 'approval_decided': {
      const decision = text(payload.decision) ?? text(payload.status);
      if (!to || (decision !== 'approved' && decision !== 'rejected')) {
        return null;
      }
      return key(`approval_${decision}`, { to: status(to) });
    }
    case 'pr_review':
    case 'pr_merged': {
      const number = payload.number;
      const repo = text(payload.repo);
      return typeof number === 'number' && repo
        ? key(item.type, { repo, number })
        : null;
    }
    // Iteration 3 §B: an agent's knowledge proposal, and its outcome for the source issue's owner.
    case 'knowledge_proposal': {
      const doc = text(payload.docTitle) ?? text(payload.title);
      if (!doc) return null;
      return payload.isNew === true
        ? key('knowledge_proposal_new', { doc })
        : key('knowledge_proposal', { doc });
    }
    // Iteration 4 §B: the executor submitted a design proposal and the owner reviews it.
    case 'design_review':
      return key('design_review');
    case 'knowledge_decided': {
      const doc = text(payload.docTitle) ?? text(payload.title);
      const decision = text(payload.decision) ?? text(payload.status);
      if (!doc || (decision !== 'accepted' && decision !== 'rejected')) {
        return null;
      }
      return key(`knowledge_${decision}`, { doc });
    }
    default:
      return null;
  }
}
