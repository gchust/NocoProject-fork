/**
 * `settings.signalRules` (protocol.phase2-signals.ts): which signal kinds wake the executor agent. Stored per kind;
 * a missing kind, or a stored value that no longer parses, reads as disabled — no rule, no signal run.
 */
import { invalid } from '../shared/errors.js';
import type {
  SignalKind,
  SignalKindInfo,
  SignalRule,
  SignalRules,
} from '../shared/protocol.js';
import {
  DEFAULT_SIGNAL_MAX_CONSECUTIVE,
  MAX_SIGNAL_INSTRUCTION_LENGTH,
  MAX_SIGNAL_MAX_CONSECUTIVE,
  SIGNAL_KIND_DEFAULTS,
  SIGNAL_KINDS,
} from '../shared/protocol.js';

export const DISABLED_SIGNAL_RULE: SignalRule = {
  enabled: false,
  instruction: null,
  maxConsecutive: DEFAULT_SIGNAL_MAX_CONSECUTIVE,
};

/** The known kinds with their defaults, for the settings view. */
export function signalKindInfos(): SignalKindInfo[] {
  return SIGNAL_KINDS.map((kind) => ({
    kind,
    source: kind.slice(0, kind.indexOf('.')),
    defaultTitle: SIGNAL_KIND_DEFAULTS[kind].title,
    defaultInstruction: SIGNAL_KIND_DEFAULTS[kind].instruction,
  }));
}

function isKind(value: string): value is SignalKind {
  return (SIGNAL_KINDS as readonly string[]).includes(value);
}

function normalizeRule(value: unknown): SignalRule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rule = value as Record<string, unknown>;
  const max = rule.maxConsecutive;
  return {
    enabled: rule.enabled === true,
    instruction:
      typeof rule.instruction === 'string' && rule.instruction.trim()
        ? rule.instruction
        : null,
    maxConsecutive:
      typeof max === 'number' &&
      Number.isInteger(max) &&
      max >= 1 &&
      max <= MAX_SIGNAL_MAX_CONSECUTIVE
        ? max
        : DEFAULT_SIGNAL_MAX_CONSECUTIVE,
  };
}

/** The stored rules, known kinds only. */
export function normalizeSignalRules(value: unknown): SignalRules {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Partial<Record<SignalKind, SignalRule>> = {};
  for (const [kind, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isKind(kind)) continue;
    const rule = normalizeRule(raw);
    if (rule) result[kind] = rule;
  }
  return result;
}

/** The rule of `kind`, disabled when none is stored. */
export function signalRuleOf(rules: SignalRules, kind: string): SignalRule {
  return (isKind(kind) ? rules[kind] : undefined) ?? DISABLED_SIGNAL_RULE;
}

/** PATCH: each given kind replaces its stored rule; the kinds left out keep theirs. */
export function validateSignalRules(
  value: unknown,
  current: SignalRules,
): SignalRules {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid('INVALID_SIGNAL_RULES', 'signalRules must be an object.');
  const result: Partial<Record<SignalKind, SignalRule>> = { ...current };
  for (const [kind, raw] of Object.entries(value as Record<string, unknown>)) {
    const at = `signalRules.${kind}`;
    if (!isKind(kind))
      throw invalid(
        'INVALID_SIGNAL_RULES',
        `${at} is not a known signal (${SIGNAL_KINDS.join(', ')}).`,
      );
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw invalid('INVALID_SIGNAL_RULES', `${at} must be an object.`);
    const rule = raw as Record<string, unknown>;
    if (typeof rule.enabled !== 'boolean')
      throw invalid('INVALID_SIGNAL_RULES', `${at}.enabled must be a boolean.`);
    const instruction = rule.instruction ?? null;
    if (
      instruction !== null &&
      (typeof instruction !== 'string' ||
        instruction.length > MAX_SIGNAL_INSTRUCTION_LENGTH)
    )
      throw invalid(
        'INVALID_SIGNAL_RULES',
        `${at}.instruction must be null or text of at most ${MAX_SIGNAL_INSTRUCTION_LENGTH} characters.`,
      );
    const max = rule.maxConsecutive ?? DEFAULT_SIGNAL_MAX_CONSECUTIVE;
    if (
      typeof max !== 'number' ||
      !Number.isInteger(max) ||
      max < 1 ||
      max > MAX_SIGNAL_MAX_CONSECUTIVE
    )
      throw invalid(
        'INVALID_SIGNAL_RULES',
        `${at}.maxConsecutive must be an integer 1–${MAX_SIGNAL_MAX_CONSECUTIVE}.`,
      );
    result[kind] = {
      enabled: rule.enabled,
      instruction:
        typeof instruction === 'string' && instruction.trim()
          ? instruction
          : null,
      maxConsecutive: max,
    };
  }
  return result;
}
