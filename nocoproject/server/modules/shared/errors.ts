/**
 * Domain errors raised by NocoProject services.
 *
 * Services never pick HTTP status codes; they raise an error of a `kind` and the route layer maps the kind to a
 * status (see `shared/http.ts`). `code` is the stable machine-readable code that reaches the client body.
 */
export type NpErrorKind =
  | 'invalid'
  | 'notFound'
  | 'forbidden'
  | 'conflict'
  | 'unauthorized'
  | 'upgradeRequired'
  /** An upstream service (GitHub, the LLM) failed: 502. */
  | 'upstream'
  /** An upstream service did not answer in time: 504. */
  | 'timeout';

export class NpError extends Error {
  public readonly kind: NpErrorKind;
  public readonly code: string;
  /** Extra machine-readable facts for the client body (`details`); never secrets. */
  public readonly details?: Readonly<Record<string, unknown>>;

  public constructor(
    kind: NpErrorKind,
    code: string,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'NpError';
    this.kind = kind;
    this.code = code;
    if (details) this.details = details;
  }
}

export function invalid(
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): NpError {
  return new NpError('invalid', code, message, details);
}

export function notFound(what: string): NpError {
  return new NpError('notFound', 'NOT_FOUND', `${what} not found.`);
}

/** The daemon answers this by registering again (protocol.md §4). */
export function runtimeNotFound(runtimeId: string): NpError {
  return new NpError(
    'notFound',
    'RUNTIME_NOT_FOUND',
    `Runtime ${runtimeId} is not registered for this daemon; register again.`,
  );
}

export function forbidden(
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): NpError {
  return new NpError('forbidden', code, message, details);
}

export function conflict(
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): NpError {
  return new NpError('conflict', code, message, details);
}
