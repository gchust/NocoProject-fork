import { Editor } from '@tiptap/core';
import { describe, expect, it } from 'vitest';

import {
  editorMarkdown,
  mentionLink,
  npRichTextExtensions,
  roundTripMarkdown,
  tidyMarkdown,
} from '../../client/components/np-rich-text-extensions.js';
import { extractMentionedAgentIds } from '../../client/pages/np/issues/mentions.js';
import { isNoteComment } from '../../client/pages/np/issues/trigger-preview.js';

describe('rich text Markdown round trip', () => {
  it.each([
    [
      'an agent mention',
      'Hello [@Claude Coder](mention://agent/9001) please look',
    ],
    ['a member mention', 'Thanks [@Zhou](mention://user/42), merged'],
    ['a Chinese name', '请 [@代码助手](mention://agent/a-1) 看一下'],
    ['a /note comment', '/note just for me'],
    ['headings and nested lists', '# Title\n\n- a\n- b\n  - c\n\n1. x\n2. y'],
    ['a fenced code block', '```ts\nconst a = 1 > 0 && b;\n```'],
    ['task lists', '- [ ] todo\n- [x] done'],
    [
      'links and bare URLs',
      'see https://github.com/o/r/pull/1 and [docs](https://x.y)',
    ],
    ['inline code and a quote', '**bold** and `a > b`\n\n> quoted'],
    ['an arrow and an ampersand', 'R&D: step a -> step b'],
    ['a hard line break', 'line1\nline2'],
  ])('keeps %s', (_, markdown) => {
    expect(roundTripMarkdown(markdown)).toBe(markdown);
  });

  it('keeps several mentions in one paragraph as separate links', () => {
    const markdown =
      '[@Claude Coder](mention://agent/9001) and [@Reviewer](mention://agent/9002) and [@Zhou](mention://user/42)';
    const output = roundTripMarkdown(markdown);
    expect(output).toBe(markdown);
    expect(extractMentionedAgentIds(output)).toEqual(['9001', '9002']);
  });

  it('parses a mention link into an atomic mention node', () => {
    const editor = new Editor({
      extensions: npRichTextExtensions(),
      content: 'Ping [@Claude Coder](mention://agent/9001) now',
      contentType: 'markdown',
    });
    try {
      const paragraph = editor.getJSON().content?.[0];
      expect(paragraph?.content?.map((node) => node.type)).toEqual([
        'text',
        'npMention',
        'text',
      ]);
      expect(paragraph?.content?.[1].attrs).toEqual({
        kind: 'agent',
        id: '9001',
        label: 'Claude Coder',
      });
    } finally {
      editor.destroy();
    }
  });

  it('serialises an inserted mention as the protocol link', () => {
    const editor = new Editor({ extensions: npRichTextExtensions() });
    try {
      editor.commands.insertContent([
        { type: 'text', text: 'Hi ' },
        {
          type: 'npMention',
          attrs: { kind: 'user', id: 'u 1', label: 'Li [Lead]' },
        },
      ]);
      expect(editorMarkdown(editor)).toBe(
        'Hi [@Li Lead](mention://user/u%201)',
      );
      // …and the encoded id reads back decoded.
      expect(roundTripMarkdown(editorMarkdown(editor))).toBe(
        'Hi [@Li Lead](mention://user/u%201)',
      );
    } finally {
      editor.destroy();
    }
  });

  it('keeps /note recognisable after the round trip', () => {
    expect(isNoteComment(roundTripMarkdown('/note keep this private'))).toBe(
      true,
    );
  });

  it('stores an empty editor as an empty string', () => {
    const editor = new Editor({ extensions: npRichTextExtensions() });
    try {
      expect(editorMarkdown(editor)).toBe('');
    } finally {
      editor.destroy();
    }
  });

  it('builds mention links without characters that would end the label', () => {
    expect(mentionLink({ kind: 'agent', id: 'a/1', label: 'A [x]\nB' })).toBe(
      '[@A xB](mention://agent/a%2F1)',
    );
  });

  it('tidies the serializer escaping without touching code or line-start quotes', () => {
    expect(tidyMarkdown('a -&gt; b &amp; c &amp;amp;')).toBe(
      'a -> b & c &amp;amp;',
    );
    expect(tidyMarkdown('&gt; stays escaped at the start')).toBe(
      '&gt; stays escaped at the start',
    );
    expect(tidyMarkdown('```\n&gt;\n```')).toBe('```\n&gt;\n```');
    expect(tidyMarkdown('[https://a.b/c](https://a.b/c)')).toBe(
      'https://a.b/c',
    );
    expect(tidyMarkdown('\n\ntext\n\n')).toBe('text');
  });
});
