import type { AgentProvider, FailureReason, ReasoningEffort, RunEventType, RunUsageInput } from '../../protocol.js';

export interface AgentEvent {
  readonly type: RunEventType;
  readonly content?: string;
  readonly tool?: string;
  readonly callId?: string;
  readonly input?: unknown;
  readonly output?: string;
  readonly at: string;
}

export interface RunSpec {
  readonly runId: string;
  readonly workDir: string;
  readonly logsDir?: string;
  readonly prompt: string;
  readonly env: Record<string, string>;
  readonly model?: string;
  readonly resumeSessionId?: string;
  /** Iteration 4: the agent's `reasoningEffort`; each adapter maps it to its own flag. */
  readonly reasoningEffort?: ReasoningEffort;
}

export interface RunResult {
  readonly exitCode: number | null;
  readonly signal?: string | null;
  readonly sessionId?: string;
  readonly usage?: RunUsageInput;
  readonly errorText?: string;
  readonly stderrTail?: string;
  readonly summary?: string;
  readonly classifiedFailure?: FailureReason;
  /** True when the provider refused `--resume` (unknown / foreign session). */
  readonly resumeRejected?: boolean;
  /** Number of visible events (text, tool use/result) the agent produced. */
  readonly visibleEvents: number;
}

export interface RunHandle {
  readonly events: AsyncIterable<AgentEvent>;
  kill(): Promise<void>;
  readonly result: Promise<RunResult>;
}

/** Passed by the runner; adapters may log through it. */
export interface RunIO {
  log(line: string): void;
}

export interface AdapterCapabilities {
  readonly resume: boolean;
  readonly steering: boolean;
  readonly briefFile: 'CLAUDE.md' | 'AGENTS.md';
  /** Workdir-relative directory the tool discovers skills in (Claude Code: `.claude/skills`). */
  readonly nativeSkillsDir?: string;
}

export interface AgentAdapter {
  readonly provider: AgentProvider;
  detect(): Promise<{ version: string; path: string } | null>;
  capabilities(): AdapterCapabilities;
  start(spec: RunSpec, io: RunIO): Promise<RunHandle>;
}

export function nowIso(): string {
  return new Date().toISOString();
}
