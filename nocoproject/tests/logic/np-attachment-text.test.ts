// @vitest-environment node
/**
 * NP-78: the text the AI 整理 parser gets from attached files — plain text decoded, docx / xlsx / pptx / pdf through
 * officeparser, legacy Office and images not read, broken files reported as failed, and the per-file and total
 * character limits.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createAttachmentTextReader,
  type AttachmentSource,
} from '../../server/modules/intake/attachment-text.ts';

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures/attachments');

const load = async (_disk: string, key: string): Promise<Uint8Array> =>
  readFileSync(path.join(FIXTURES, key));

function file(
  filename: string,
  mimeType = 'application/octet-stream',
): AttachmentSource {
  return {
    id: `id-${filename}`,
    filename,
    ext: filename.split('.').pop() ?? '',
    mimeType,
    disk: 'local',
    key: filename,
  };
}

describe('attachment text for AI 整理', () => {
  it('reads text and Office documents and reports the rest', async () => {
    const reader = createAttachmentTextReader(load);
    const result = await reader.read([
      file('notes.md', 'text/markdown'),
      file('spec.docx'),
      file('backlog.xlsx'),
      file('roadmap.pptx'),
      file('invoice.pdf', 'application/pdf'),
      file('pixel.png', 'image/png'),
      file('old.doc'),
      file('broken.docx'),
    ]);
    expect(result.documents).toEqual([
      {
        filename: 'notes.md',
        text: '# 会议纪要\n\n- 导出 CSV\n- 修复登录超时',
        truncated: false,
      },
      {
        filename: 'spec.docx',
        text: '登录页需求\n支持手机号验证码登录',
        truncated: false,
      },
      {
        filename: 'backlog.xlsx',
        text: 'Export report\nDark mode',
        truncated: false,
      },
      {
        filename: 'roadmap.pptx',
        text: 'Q4 roadmap: SSO login',
        truncated: false,
      },
      { filename: 'invoice.pdf', text: 'Invoice export API', truncated: false },
    ]);
    expect(result.unreadNames).toEqual(['pixel.png', 'old.doc', 'broken.docx']);
    expect(Object.fromEntries(result.statuses)).toMatchObject({
      'id-notes.md': { state: 'read' },
      'id-spec.docx': { state: 'read', chars: 16 },
      'id-pixel.png': { state: 'unsupported', chars: 0 },
      'id-old.doc': { state: 'legacy', chars: 0 },
      'id-broken.docx': { state: 'failed', chars: 0 },
    });
  });

  it('cuts each file and the total, and reports files past the total as skipped', async () => {
    const reader = createAttachmentTextReader(load, {
      perFileChars: 10,
      totalChars: 16,
    });
    const result = await reader.read([
      file('backlog.xlsx'),
      file('roadmap.pptx'),
      file('invoice.pdf'),
    ]);
    expect(result.documents).toEqual([
      { filename: 'backlog.xlsx', text: 'Export rep', truncated: true },
      { filename: 'roadmap.pptx', text: 'Q4 roa', truncated: true },
    ]);
    expect(result.statuses.get('id-invoice.pdf')).toEqual({
      state: 'skipped',
      chars: 0,
    });
    expect(result.unreadNames).toEqual(['invoice.pdf']);
  });

  it('treats a storage failure or a slow read as failed', async () => {
    const failing = createAttachmentTextReader(async () => {
      throw new Error('disk gone');
    });
    expect(
      (await failing.read([file('notes.md')])).statuses.get('id-notes.md'),
    ).toEqual({ state: 'failed', chars: 0 });
    const slow = createAttachmentTextReader(
      () => new Promise<Uint8Array>(() => undefined),
      { timeoutMs: 20 },
    );
    expect(
      (await slow.read([file('notes.md')])).statuses.get('id-notes.md'),
    ).toEqual({ state: 'failed', chars: 0 });
  });
});
