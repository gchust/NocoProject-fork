/**
 * Stage instruction templates (NP-77 proposal §1): `{{issue.identifier}}`, `{{issue.title}}`, `{{from}}`, `{{to}}` and
 * `{{owner.name}}`, with optional whitespace inside the braces. Validation (`workflow.validate.ts`) refuses any other
 * variable; rendering leaves an unknown one as written.
 */
import type { StageInstructionVariable } from '../shared/protocol.js';

/** A `{{ name }}` placeholder; group 1 is the trimmed name. */
export const TEMPLATE_VARIABLE = /\{\{\s*([^{}]*?)\s*\}\}/gu;

export function renderInstruction(
  template: string,
  values: Readonly<Record<StageInstructionVariable, string>>,
): string {
  return template
    .replace(TEMPLATE_VARIABLE, (match, name: string) =>
      Object.hasOwn(values, name)
        ? values[name as StageInstructionVariable]
        : match,
    )
    .trim();
}
