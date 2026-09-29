import type { WorkspaceSettings } from '../types.js';
import {
  DEFAULT_SIGNAL_MAX_CONSECUTIVE,
  MAX_SIGNAL_INSTRUCTION_LENGTH,
  MAX_SIGNAL_MAX_CONSECUTIVE,
  type SignalKindInfo,
  type SignalRule,
} from '../types-signals.js';

/** One signal rule as the form edits it (`maxConsecutive` as typed). */
export interface SignalRuleDraft {
  readonly enabled: boolean;
  readonly instruction: string;
  readonly maxConsecutive: string;
}

/** The kinds of one source, in the server's order. */
export function signalKindsOf(
  settings: WorkspaceSettings,
  source: string,
): SignalKindInfo[] {
  return (settings.signalKinds ?? []).filter((info) => info.source === source);
}

/** The stored rules of `kinds` as drafts; a kind without a rule is off with the default limit. */
export function signalRuleDrafts(
  settings: WorkspaceSettings,
  kinds: readonly SignalKindInfo[],
): Record<string, SignalRuleDraft> {
  const drafts: Record<string, SignalRuleDraft> = {};
  for (const { kind } of kinds) {
    const rule = settings.signalRules?.[kind];
    drafts[kind] = {
      enabled: rule?.enabled ?? false,
      instruction: rule?.instruction ?? '',
      maxConsecutive: String(
        rule?.maxConsecutive ?? DEFAULT_SIGNAL_MAX_CONSECUTIVE,
      ),
    };
  }
  return drafts;
}

/** The `{{name}}` placeholders a default instruction uses, in order of first use. */
export function placeholdersOf(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(/\{\{\s*([A-Za-z][\w.]*)\s*\}\}/gu)) {
    const name = match[1];
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export function validMaxConsecutive(value: string): boolean {
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) return false;
  const count = Number(trimmed);
  return count >= 1 && count <= MAX_SIGNAL_MAX_CONSECUTIVE;
}

/** The PATCH `signalRules` for the drafts, or null while one is invalid. An empty instruction means the default. */
export function signalRulesInput(
  drafts: Readonly<Record<string, SignalRuleDraft>>,
): Record<string, SignalRule> | null {
  const rules: Record<string, SignalRule> = {};
  for (const [kind, draft] of Object.entries(drafts)) {
    if (!validMaxConsecutive(draft.maxConsecutive)) return null;
    if (draft.instruction.length > MAX_SIGNAL_INSTRUCTION_LENGTH) return null;
    rules[kind] = {
      enabled: draft.enabled,
      instruction: draft.instruction.trim() ? draft.instruction : null,
      maxConsecutive: Number(draft.maxConsecutive.trim()),
    };
  }
  return rules;
}
