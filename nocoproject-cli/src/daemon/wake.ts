/**
 * Wakeups: a WebSocket subscription to the `np:daemon` user topic (NocoBase realtime
 * protocol, authenticated with the `x-api-key` header on the upgrade request), plus a
 * poll timer that fires every `pollIntervalMs` regardless.
 *
 * A daemon with a computer credential (NP-150) has no session for the socket; it long-polls
 * `GET /np/daemon/wakeups` instead (`longPoll`), with the same poll timer as the safety net.
 *
 * Realtime frames (JSON text):
 *   → {type:'subscribe', id, topic}   ← {type:'subscribed', id, topic, subscriptionId}
 *   → {type:'ping', id}               ← {type:'pong', id}
 *   ← {type:'event', topic, payload, publishedAt}
 *   ← {type:'error', id?, code, message}   (e.g. AUTHENTICATION_REQUIRED for user topics)
 */
import WebSocket from 'ws';
import { z } from 'zod';
import { REALTIME_TOPICS } from '../protocol.js';
import { backoffDelay } from '../util/backoff.js';
import type { Logger } from '../util/log.js';

const ServerFrame = z.object({
  type: z.string(),
  id: z.string().optional(),
  topic: z.string().optional(),
  payload: z.unknown().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
});

const WakeupPayload = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workAvailable'), runtimeId: z.string() }),
  z.object({ kind: z.literal('cancelRequested'), runId: z.string() }),
]);

export function realtimeUrl(serverUrl: string): string {
  const url = new URL(`${serverUrl.replace(/\/+$/, '')}/ws`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export type LongPoll = (after: number | null, timeoutS: number, signal: AbortSignal) => Promise<{ cursor: number; events: unknown[] }>;

export interface WakeOptions {
  readonly serverUrl: string;
  /** The personal API key for the socket; absent with a computer credential, which uses `longPoll`. */
  readonly apiKey?: string;
  readonly longPoll?: LongPoll;
  readonly pollIntervalMs: number;
  readonly logger: Logger;
  readonly onWork: (reason: string, runtimeId?: string) => void;
  readonly onCancel: (runId: string) => void;
  readonly pingIntervalMs?: number;
  /** Disable the socket entirely (polling only). */
  readonly disableSocket?: boolean;
}

export type SocketState = 'disabled' | 'connecting' | 'subscribed' | 'reconnecting' | 'authUnsupported' | 'longPoll';

const LONG_POLL_SECONDS = 25;
const LONG_POLL_RETRY_MS = 60_000;

/** How long to wait before retrying after the server refused WS authentication. */
const AUTH_RETRY_MS = 10 * 60_000;

export class Wake {
  private ws: WebSocket | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private attempts = 0;
  private awaitingPong = false;
  private stopped = false;
  private readonly polling = new AbortController();
  state: SocketState = 'connecting';

  constructor(private readonly opts: WakeOptions) {}

  start(): void {
    this.pollTimer = setInterval(() => this.opts.onWork('poll'), this.opts.pollIntervalMs);
    if (this.opts.disableSocket) this.state = 'disabled';
    else if (!this.opts.apiKey && this.opts.longPoll) void this.longPollLoop(this.opts.longPoll);
    else this.connect();
  }

  private async longPollLoop(poll: LongPoll): Promise<void> {
    this.state = 'longPoll';
    let cursor: number | null = null;
    while (!this.stopped) {
      try {
        const batch = await poll(cursor, LONG_POLL_SECONDS, this.polling.signal);
        cursor = batch.cursor;
        for (const event of batch.events) this.dispatch(event);
      } catch (error) {
        if (this.stopped) return;
        cursor = null;
        this.opts.logger.debug('wakeup long-poll failed; the claim poll keeps running', { error: (error as Error).message });
        await new Promise((resolve) => setTimeout(resolve, LONG_POLL_RETRY_MS).unref?.());
      }
    }
  }

  private dispatch(event: unknown): void {
    const payload = WakeupPayload.safeParse(event);
    if (!payload.success) return;
    if (payload.data.kind === 'workAvailable') this.opts.onWork('workAvailable', payload.data.runtimeId);
    else this.opts.onCancel(payload.data.runId);
  }

  stop(): void {
    this.stopped = true;
    this.polling.abort();
    clearInterval(this.pollTimer);
    clearInterval(this.pingTimer);
    clearTimeout(this.reconnectTimer);
    this.ws?.removeAllListeners();
    this.ws?.on('error', () => undefined);
    this.ws?.terminate();
    this.ws = undefined;
  }

  private connect(): void {
    if (this.stopped) return;
    this.state = this.attempts === 0 ? 'connecting' : 'reconnecting';
    const ws = new WebSocket(realtimeUrl(this.opts.serverUrl), { headers: { 'x-api-key': this.opts.apiKey ?? '' }, handshakeTimeout: 15_000 });
    this.ws = ws;
    ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', id: 'np-daemon', topic: REALTIME_TOPICS.daemon })));
    ws.on('message', (data) => this.onMessage(String(data)));
    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 0;
      if (status === 401 || status === 403) this.authUnsupported(`upgrade refused with HTTP ${status}`);
      else if (this.attempts === 0) this.opts.logger.warn('realtime upgrade failed; will keep retrying with backoff', { status });
      else this.opts.logger.debug('realtime upgrade failed', { status, attempt: this.attempts });
      ws.terminate();
    });
    ws.on('error', (error) => this.opts.logger.debug('realtime socket error', { error: error.message }));
    ws.on('close', () => this.onClose(ws));
  }

  private onMessage(text: string): void {
    let frame: z.infer<typeof ServerFrame>;
    try {
      frame = ServerFrame.parse(JSON.parse(text));
    } catch {
      return;
    }
    if (frame.type === 'subscribed') {
      this.attempts = 0;
      this.state = 'subscribed';
      this.opts.logger.info('realtime subscribed', { topic: frame.topic });
      this.startPing();
      this.opts.onWork('subscribed');
    } else if (frame.type === 'pong') {
      this.awaitingPong = false;
    } else if (frame.type === 'error') {
      if (frame.code === 'AUTHENTICATION_REQUIRED') this.authUnsupported(frame.message ?? 'authentication required');
      else this.opts.logger.warn('realtime error frame', { code: frame.code, message: frame.message });
    } else if (frame.type === 'event' && frame.topic === REALTIME_TOPICS.daemon) {
      this.dispatch(frame.payload);
    }
  }

  private startPing(): void {
    clearInterval(this.pingTimer);
    this.awaitingPong = false;
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.awaitingPong) {
        this.opts.logger.warn('realtime pong timeout; reconnecting');
        this.ws.terminate();
        return;
      }
      this.awaitingPong = true;
      this.ws.send(JSON.stringify({ type: 'ping', id: 'hb' }));
    }, this.opts.pingIntervalMs ?? 30_000);
  }

  private authUnsupported(detail: string): void {
    if (this.state !== 'authUnsupported') {
      this.opts.logger.error('realtime socket rejected x-api-key authentication; falling back to polling only', { detail });
    }
    this.state = 'authUnsupported';
    this.ws?.terminate();
  }

  private onClose(ws: WebSocket): void {
    if (this.ws !== ws) return;
    clearInterval(this.pingTimer);
    this.ws = undefined;
    if (this.stopped) return;
    const delay = this.state === 'authUnsupported' ? AUTH_RETRY_MS : backoffDelay(this.attempts, 1000, 30_000);
    if (this.state !== 'authUnsupported') this.state = 'reconnecting';
    this.attempts += 1;
    this.opts.logger.debug('realtime reconnect scheduled', { delayMs: delay });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
