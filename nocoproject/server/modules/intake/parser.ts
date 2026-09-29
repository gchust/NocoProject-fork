/**
 * Intake parsers (docs/phase1/iteration-2-contract.md §E): turn pasted text into issue drafts.
 *
 * `HeuristicIntakeParser` (`heuristic-parser.ts`) is pure and always available. `AiIntakeParser` (`ai-parser.ts`)
 * runs a fixed agent with a Zod response format when an LLM service is configured and `settings.intakeParser` is
 * `auto`; on failure or timeout the service falls back to the heuristic and reports why.
 */
import type { IntakeDraftInput, IntakeParserKind } from '../shared/protocol.js';

export interface IntakeParseInput {
  readonly rawContent: string;
  readonly project: {
    readonly name: string;
    readonly description: string | null;
  } | null;
  readonly workflow: {
    readonly name: string;
    readonly statuses: readonly string[];
  } | null;
  /** Names of the labels that exist. */
  readonly labels: readonly string[];
  /** NP-78: text of the files attached on the AI draft tab (np.newIssue.tabs.ai; only the AI parser reads it). */
  readonly attachments?: {
    readonly documents: readonly {
      readonly filename: string;
      readonly text: string;
      readonly truncated: boolean;
    }[];
    readonly unreadNames: readonly string[];
  };
}

/** NP-120: what the AI gets to revise a batch's drafts by one instruction. */
export interface IntakeRefineInput extends IntakeParseInput {
  readonly drafts: readonly IntakeDraftInput[];
  readonly instruction: string;
  /** Names of the batch's files (their text is not read again). */
  readonly attachmentNames: readonly string[];
  /** The batch splits an issue: every draft is a sub-task of it. */
  readonly underIssue: boolean;
}

/** NP-120: a revised draft and the position of the draft it keeps or rewrites (null = new). */
export interface RefinedDraft extends IntakeDraftInput {
  readonly from: number | null;
}

export interface IntakeParser {
  readonly kind: IntakeParserKind;
  parse(input: IntakeParseInput): Promise<IntakeDraftInput[]>;
}

/** What the service records about a parse. */
export interface IntakeParseOutcome {
  readonly drafts: IntakeDraftInput[];
  readonly parser: IntakeParserKind;
  readonly parseError: string | null;
  readonly aiSessionId: string | null;
}

export const MAX_DRAFTS = 500;
export const MAX_TITLE_LENGTH = 200;
