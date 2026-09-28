/**
 * Buffers agent events, redacts and truncates them, numbers them with a monotonically
 * increasing `seq`, and ships them to `POST /np/daemon/runs/:id/events` in batches.
 *
 * Flushes every `flushIntervalMs` (500ms), immediately on the first visible event, and on
 * close. Failed batches stay queued and are retried with backoff; duplicate seqs are
 * ignored by the server, so re-sending is safe.
 */
import { HttpError, isTransient } from '../api/client.js';
import type { RunEventInput } from '../protocol.js';
import { backoffDelay, sleep } from '../util/backoff.js';
import { silentLogger, type Logger } from '../util/log.js';
import { redactText, redactValue } from '../util/redact.js';
import type { AgentEvent } from './adapters/types.js';

export const MAX_BATCH = 200;
export const MAX_CONTENT_BYTES = 64 * 1024;

export interface EventSink {
  events(runId: string, body: { events: readonly RunEventInput[] }): Promise<unknown>;
}

export interface StreamerOptions {
  readonly flushIntervalMs?: number;
  readonly maxAttempts?: number;
  readonly logger?: Logger;
}

/** Truncates to at most `max` UTF-8 bytes without splitting a character. */
export function truncateUtf8(text: string, max = MAX_CONTENT_BYTES): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= max) return { text, truncated: false };
  let end = max;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}

function truncateInput(input: unknown): { value: unknown; truncated: boolean } {
  if (input === undefined) return { value: undefined, truncated: false };
  const json = JSON.stringify(input);
  if (json === undefined || Buffer.byteLength(json) <= MAX_CONTENT_BYTES) return { value: input, truncated: false };
  return { value: { _truncated: truncateUtf8(json).text }, truncated: true };
}

export function toWireEvent(event: AgentEvent, seq: number): RunEventInput {
  const content = event.content === undefined ? undefined : truncateUtf8(redactText(event.content));
  const output = event.output === undefined ? undefined : truncateUtf8(redactText(event.output));
  const input = truncateInput(redactValue(event.input));
  const truncated = Boolean(content?.truncated || output?.truncated || input.truncated);
  return {
    seq,
    type: event.type,
    ...(event.tool ? { tool: event.tool } : {}),
    ...(content ? { content: content.text } : {}),
    ...(input.value !== undefined ? { input: input.value } : {}),
    ...(output ? { output: output.text } : {}),
    ...(truncated ? { truncated: true } : {}),
    at: event.at,
  };
}

const VISIBLE = new Set(['text', 'thinking', 'toolUse', 'toolResult']);

export class EventStreamer {
  private seq = 0;
  private readonly queue: RunEventInput[] = [];
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;
  private sawVisible = false;
  private failures = 0;
  private closed = false;
  private readonly logger: Logger;
  private readonly flushIntervalMs: number;
  private readonly maxAttempts: number;
  lastSeq = 0;

  constructor(
    private readonly sink: EventSink,
    private readonly runId: string,
    opts: StreamerOptions = {},
  ) {
    this.logger = opts.logger ?? silentLogger;
    this.flushIntervalMs = opts.flushIntervalMs ?? 500;
    this.maxAttempts = opts.maxAttempts ?? 8;
  }

  push(event: AgentEvent): void {
    if (this.closed) return;
    this.seq += 1;
    this.queue.push(toWireEvent(event, this.seq));
    if (!this.sawVisible && VISIBLE.has(event.type)) {
      this.sawVisible = true;
      void this.flush();
      return;
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.flushIntervalMs);
  }

  /** Sends everything queued so far (one batch at a time). */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing.then(() => (this.queue.length ? this.flush() : undefined));
    this.flushing = this.drain().finally(() => (this.flushing = undefined));
    return this.flushing;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.slice(0, MAX_BATCH);
      try {
        await this.sink.events(this.runId, { events: batch });
        this.queue.splice(0, batch.length);
        this.lastSeq = batch[batch.length - 1]?.seq ?? this.lastSeq;
        this.failures = 0;
      } catch (error) {
        this.failures += 1;
        const permanent = error instanceof HttpError && !isTransient(error);
        if (permanent || this.failures >= this.maxAttempts) {
          this.logger.warn('dropping event batch', { runId: this.runId, count: batch.length, error: (error as Error).message });
          this.queue.splice(0, batch.length);
          this.failures = 0;
          continue;
        }
        const delay = backoffDelay(this.failures - 1, 250, 8000);
        this.logger.debug('event batch failed; retrying', { runId: this.runId, delay, error: (error as Error).message });
        await sleep(delay);
      }
    }
  }

  /** Stops the timer and flushes the remainder. */
  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flush();
    this.closed = true;
  }
}
