/**
 * NP-214 agent uploads for the mock server: `POST /np/agent/issues/:id/uploads` (multipart, field `file`) and the
 * `attachmentIds` a comment attaches. Switches answer like the real server would: `denied` (the agent lacks
 * `attachment.upload`), `legacy` (a server before NP-214, whose guard names no capability), `maxFileSize` (413) and
 * `proxyLimit` (a proxy's own 413 page, without a code or the limit).
 */
import type { IncomingMessage } from 'node:http';
import type { AgentAttachmentInfo } from '../../src/protocol.js';

export interface MockUpload extends AgentAttachmentInfo {
  readonly issueId: string;
  readonly runId: string;
  readonly bytes: Uint8Array;
  commentId: string | null;
}

type Send = (status: number, payload: unknown) => void;

export class MockUploads {
  denied = false;
  legacy = false;
  maxFileSize = 1024 * 1024;
  proxyLimit = false;
  readonly files = new Map<string, MockUpload>();
  private seq = 0;

  async upload(issueId: string, runId: string, runIssueId: string, req: IncomingMessage, body: Buffer, send: Send): Promise<void> {
    if (this.proxyLimit) return send(413, '<html><body>413 Request Entity Too Large</body></html>');
    if (this.legacy) return send(403, { code: 'CAPABILITY_DENIED', message: 'This agent endpoint has no capability assignment.' });
    if (this.denied) return send(403, { code: 'CAPABILITY_DENIED', message: 'Capability required: attachment.upload', details: { capability: 'attachment.upload' } });
    if (issueId !== runIssueId) return send(403, { code: 'ISSUE_NOT_IN_RUN', message: 'A run token may only write to its own issue.' });
    const type = String(req.headers['content-type'] ?? '');
    if (!type.startsWith('multipart/form-data;')) return send(415, { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Expected multipart/form-data.' });
    const file = (await new Response(new Uint8Array(body), { headers: { 'content-type': type } }).formData()).get('file');
    if (!(file instanceof File)) return send(400, { code: 'INVALID_FILE', message: 'Exactly one file is required.' });
    if (file.size > this.maxFileSize) return send(413, { code: 'ATTACHMENT_TOO_LARGE', message: `The file is larger than ${this.maxFileSize} bytes.`, details: { maxFileSize: this.maxFileSize } });
    const info = { id: `up${++this.seq}`, filename: file.name, mimeType: file.type || 'application/octet-stream', size: file.size };
    this.files.set(info.id, { ...info, issueId, runId, bytes: new Uint8Array(await file.arrayBuffer()), commentId: null });
    send(201, { data: info });
  }

  /** Attaches a comment's `attachmentIds` (own unattached uploads of the run), or returns the refusal. */
  attach(ids: unknown, runId: string, commentId: string): { attachments: AgentAttachmentInfo[] } | { error: { code: string; message: string } } {
    const list = Array.isArray(ids) ? (ids as string[]) : [];
    const files = list.map((id) => this.files.get(id));
    if (files.some((file) => !file || file.runId !== runId || file.commentId !== null)) return { error: { code: 'INVALID_ATTACHMENT', message: 'Unknown or unavailable attachment.' } };
    for (const file of files) file!.commentId = commentId;
    return { attachments: files.map((file) => ({ id: file!.id, filename: file!.filename, mimeType: file!.mimeType, size: file!.size })) };
  }
}
