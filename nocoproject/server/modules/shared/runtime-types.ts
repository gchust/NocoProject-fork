/**
 * Validation of runtime types (NP-219, protocol-runtime-types.md §3, §5): the required `runtimeType` of a new agent
 * and the optional `?runtimeType=` filter of the run, runtime and usage lists. Both answer 400
 * `INVALID_RUNTIME_TYPE` for anything but `computer` / `builtin`.
 */
import { invalid } from './errors.js';
import { RUNTIME_TYPES, type RuntimeType } from './protocol.js';

export function isRuntimeType(value: unknown): value is RuntimeType {
  return (RUNTIME_TYPES as readonly unknown[]).includes(value);
}

export function validateRuntimeType(value: unknown): RuntimeType {
  if (!isRuntimeType(value))
    throw invalid(
      'INVALID_RUNTIME_TYPE',
      `runtimeType must be ${RUNTIME_TYPES.join(' or ')}.`,
    );
  return value;
}

/** A list filter: absent or empty = every type. */
export function runtimeTypeFilter(value: unknown): RuntimeType | null {
  if (value === undefined || value === null || value === '') return null;
  return validateRuntimeType(value);
}
