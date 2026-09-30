/** File and reference parsing shared by user and run-token commands. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CliError, EXIT } from "./output.js";
import { IDENTIFIER } from "./run-token.js";

export function readText(
  inline: string | undefined,
  file: string | undefined,
  what: string,
): string | undefined {
  if (inline !== undefined && file !== undefined)
    throw new CliError(
      `pass either --${what} or --${what}-file, not both`,
      EXIT.validation,
      "CONFLICTING_OPTIONS",
    );
  if (file === undefined) return inline;
  const path = resolve(file);
  if (!existsSync(path))
    throw new CliError(
      `file not found: ${path}`,
      EXIT.validation,
      "FILE_NOT_FOUND",
    );
  return readFileSync(path, "utf8");
}

export function readJsonObject(file: string): Record<string, unknown> {
  const text = readText(undefined, file, "params")!;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CliError(
      "invalid JSON file: " + file,
      EXIT.validation,
      "INVALID_JSON",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CliError(
      "expected a JSON object: " + file,
      EXIT.validation,
      "INVALID_JSON",
    );
  return value as Record<string, unknown>;
}

export function issueRef(value: string): string {
  const ref = value.trim();
  if (!ref)
    throw new CliError(
      "an issue id or identifier (NP-12) is required",
      EXIT.validation,
      "ISSUE_REQUIRED",
    );
  return IDENTIFIER.test(ref) ? ref.toUpperCase() : ref;
}
