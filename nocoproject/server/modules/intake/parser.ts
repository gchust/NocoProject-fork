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
  /** NP-78: text of the files attached on the AI 整理 tab (only the AI parser reads it). */
  readonly attachments?: {
    readonly documents: readonly {
      readonly filename: string;
      readonly text: string;
      readonly truncated: boolean;
    }[];
    readonly unreadNames: readonly string[];
  };
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
