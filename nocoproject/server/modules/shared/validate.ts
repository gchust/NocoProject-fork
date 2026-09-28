/**
 * Request field validation shared by the NocoProject services. Each helper throws a 400 domain error naming the
 * field; `undefined` means "not provided" and is handled by the caller.
 */
import { invalid } from './errors.js';
import type { LabelColor } from './protocol.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/** `YYYY-MM-DD` or null. */
export function validateDate(value: unknown, field: string): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !DATE_PATTERN.test(value))
    throw invalid('INVALID_DATE', `${field} must be YYYY-MM-DD.`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw invalid('INVALID_DATE', `${field} is not a valid date.`);
  return value;
}

export function validateStage(value: unknown): number | null {
  if (value === null) return null;
  if (
    !Number.isInteger(value) ||
    (value as number) < 0 ||
    (value as number) > 1000
  )
    throw invalid(
      'INVALID_STAGE',
      'stage must be an integer between 0 and 1000, or null.',
    );
  return value as number;
}

export function optionalText(
  value: unknown,
  field: string,
  maxLength = 100_000,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string')
    throw invalid('INVALID_FIELD', `${field} must be a string.`);
  if (value.length > maxLength)
    throw invalid('INVALID_FIELD', `${field} is too long.`);
  return value;
}

export function requiredName(value: unknown, maxLength = 255): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > maxLength)
    throw invalid(
      'INVALID_NAME',
      `name is required (at most ${maxLength} characters).`,
    );
  return name;
}

export function validateBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean')
    throw invalid('INVALID_FIELD', `${field} must be a boolean.`);
  return value;
}

/** An array of non-empty strings (deduplicated, order kept). */
export function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value))
    throw invalid('INVALID_FIELD', `${field} must be an array of strings.`);
  const result: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'string' || item.trim() === '')
      throw invalid('INVALID_FIELD', `${field} must be an array of strings.`);
    if (!result.includes(item.trim())) result.push(item.trim());
  }
  return result;
}

export const LABEL_COLORS: readonly LabelColor[] = [
  'gray',
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
];

export function validateLabelColor(value: unknown): LabelColor {
  if (!(LABEL_COLORS as readonly unknown[]).includes(value))
    throw invalid(
      'INVALID_COLOR',
      `color must be one of ${LABEL_COLORS.join(', ')}.`,
    );
  return value as LabelColor;
}
