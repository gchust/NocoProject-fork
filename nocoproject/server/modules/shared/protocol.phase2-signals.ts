/**
 * NocoProject protocol types: signals — an outside system reports that an issue's linked object needs its
 * executor's attention, and a rule a person configured decides whether the executor agent is woken up.
 *
 * The core knows nothing about where a signal comes from: a source (today only the GitHub integration) names the
 * signal `kind`, a stable `key` for de-duplication, a one-line title, a link and a default instruction. Whether a
 * kind wakes the executor, how often in a row, and with which instruction are workspace settings (`signalRules`),
 * off until a person turns them on — a workspace that never enables a rule never sees a signal run. When workflows
 * are orchestrated per domain later, only where the rule is read from changes; the trigger and its payload stay.
 *
 * Server source of truth; the CLI copies this file with `pnpm sync-protocol`. This file only imports types from the
 * earlier protocol files. Additive only.
 */
import type { InboxItemTypeV6 } from './protocol.phase2-workflow-proposals.js';
import type {
  RunTriggerTypeV5,
  UpdateWorkspaceSettingsRequestV5,
  WorkspaceSettingsViewV5,
} from './protocol.phase2-workflow.js';

// ---------- Trigger ----------

export type RunTriggerTypeSignal = 'signal';
export type RunTriggerTypeV6 = RunTriggerTypeV5 | RunTriggerTypeSignal;

/** The `payload` of a `signal` trigger, and `triggers[].signal` of the claim payload. */
export interface SignalPayload {
  /** Where it came from, e.g. `github` */
  readonly source: string;
  /** The rule key, `<source>.<name>`, e.g. `github.ciFailed` */
  readonly kind: string;
  /** Stable per occurrence: the same key never wakes the executor twice */
  readonly key: string;
  /** One line for the timeline and the turn prompt */
  readonly title: string;
  readonly url: string | null;
  /** The rendered instruction (the rule's own, else the source's default) */
  readonly instruction: string | null;
}

/** Claim payload `triggers[]` addition: a `signal` trigger carries its payload (the daemon reads it optionally). */
export interface ClaimedTriggerSignalExtras {
  readonly signal?: SignalPayload;
}

// ---------- Rules (workspace settings) ----------

/** The kinds a source can report. A rule may only be stored for a known kind. */
export const SIGNAL_KINDS = ['github.ciFailed', 'github.conflict'] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/**
 * What each kind's source reports unless the rule says otherwise: the title and the default instruction, both with
 * `{{name}}` placeholders. GitHub kinds take `repo`, `number`, `url`, `headRef`, `baseRef` and `headSha`.
 */
export const SIGNAL_KIND_DEFAULTS: Readonly<
  Record<SignalKind, { readonly title: string; readonly instruction: string }>
> = {
  'github.ciFailed': {
    title: 'Checks failed on {{repo}}#{{number}}',
    instruction:
      'The checks of pull request {{repo}}#{{number}} ({{url}}) failed on commit {{headSha}}. Find out why (for example `gh pr checks {{number}} --repo {{repo}}`, then `gh run view <run-id> --log-failed --repo {{repo}}`), fix it on the same branch `{{headRef}}` and push. Do not open a new pull request. If the failure is unrelated to your change or needs a decision, explain it in a comment on the issue instead of guessing.',
  },
  'github.conflict': {
    title: 'Merge conflicts on {{repo}}#{{number}}',
    instruction:
      'Pull request {{repo}}#{{number}} ({{url}}) conflicts with `{{baseRef}}`. Bring the latest `{{baseRef}}` into `{{headRef}}` (merge or rebase, as the repository prefers), resolve the conflicts keeping the intent of both sides, run the checks and push to the same branch. Do not open a new pull request. If a conflict needs a decision, explain it in a comment on the issue instead of guessing.',
  },
};

export interface SignalRule {
  readonly enabled: boolean;
  /** null or empty = the source's default instruction */
  readonly instruction: string | null;
  /**
   * At most this many runs in a row for the same kind on one issue; the streak ends when the source reports the
   * problem gone. The next signal after that is suppressed and the owner is told instead.
   */
  readonly maxConsecutive: number;
}

export type SignalRules = Readonly<Partial<Record<SignalKind, SignalRule>>>;

export const DEFAULT_SIGNAL_MAX_CONSECUTIVE = 3;
export const MAX_SIGNAL_MAX_CONSECUTIVE = 20;
export const MAX_SIGNAL_INSTRUCTION_LENGTH = 4000;

/** `GET/PATCH /np/settings` addition. PATCH merges per kind; a kind left out keeps its rule. */
export interface WorkspaceSettingsSignalFields {
  readonly signalRules: SignalRules;
}
/** A kind as the settings page lists it (read-only). */
export interface SignalKindInfo {
  readonly kind: SignalKind;
  /** The `<source>` part of the kind */
  readonly source: string;
  readonly defaultTitle: string;
  readonly defaultInstruction: string;
}
/** GET adds the known kinds, so the settings page lists what the server can report. */
export type WorkspaceSettingsViewV6 = WorkspaceSettingsViewV5 &
  WorkspaceSettingsSignalFields & {
    readonly signalKinds: readonly SignalKindInfo[];
  };
export type UpdateWorkspaceSettingsRequestV6 =
  UpdateWorkspaceSettingsRequestV5 & Partial<WorkspaceSettingsSignalFields>;

// ---------- Activity, inbox ----------

/**
 * `signal_received` `{ source, kind, key, title, url, agentId, runId }` (runId null when the run was held back, e.g.
 * blocked); `signal_suppressed` `{ source, kind, key, title, url, limit }`; `signal_resolved` `{ source, kind, key }`.
 * All by the system.
 */
export type ActivityActionSignal =
  'signal_received' | 'signal_suppressed' | 'signal_resolved';

/** `signal_suppressed`: info to the owner — the rule's limit was reached, a person takes over. */
export type InboxItemTypeSignal = 'signal_suppressed';
export type InboxItemTypeV7 = InboxItemTypeV6 | InboxItemTypeSignal;
