import { redactText } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly scope?: string;
  readonly write?: (line: string) => void;
}

function formatFields(fields: Record<string, unknown> | undefined): string {
  if (!fields) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const text = v instanceof Error ? v.message : typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}=${/\s/.test(text ?? '') ? JSON.stringify(text) : text}`);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

/** Line logger. Every line is passed through secret redaction before it is written. */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const envLevel = process.env.NOCOPROJECT_LOG_LEVEL as LogLevel | undefined;
  const level: LogLevel = opts.level ?? (envLevel && envLevel in ORDER ? envLevel : 'info');
  const write = opts.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const scope = opts.scope;
  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (ORDER[lvl] < ORDER[level]) return;
    const prefix = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)}${scope ? ` [${scope}]` : ''}`;
    write(redactText(`${prefix} ${msg}${formatFields(fields)}`));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (s) => createLogger({ level, write, scope: scope ? `${scope}/${s}` : s }),
  };
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};
