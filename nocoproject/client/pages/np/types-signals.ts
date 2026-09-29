/**
 * Browser-side types for signals (`server/modules/shared/protocol.phase2-signals.ts`): the rules that let an outside
 * system's report (a linked pull request's checks failed, it conflicts with its base) wake the issue's executor agent.
 *
 * Copied from the contract rather than imported, for the same reason as `types.ts`: the client tsconfig must not reach
 * into `server/`. Kinds stay plain strings: the settings page lists whatever `signalKinds` the server sends.
 */

export interface SignalRule {
  readonly enabled: boolean;
  /** null = the kind's default instruction */
  readonly instruction: string | null;
  /** 1–20 runs in a row before the owner takes over */
  readonly maxConsecutive: number;
}

export type SignalRules = Readonly<Record<string, SignalRule>>;

export interface SignalKindInfo {
  /** `<source>.<name>`, e.g. `github.ciFailed` */
  readonly kind: string;
  readonly source: string;
  readonly defaultTitle: string;
  readonly defaultInstruction: string;
}

export const DEFAULT_SIGNAL_MAX_CONSECUTIVE = 3;
export const MAX_SIGNAL_MAX_CONSECUTIVE = 20;
export const MAX_SIGNAL_INSTRUCTION_LENGTH = 4000;
