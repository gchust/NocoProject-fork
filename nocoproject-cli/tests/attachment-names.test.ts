import { expect, it } from 'vitest';
import { fileNames } from '../src/cli/attachment.js';

it('keeps all names distinct even when a filename matches the collision fallback', () => {
  const names = fileNames([
    { id: 'a', filename: 'b-photo.png', mimeType: 'image/png', size: 1 },
    { id: 'c', filename: 'photo.png', mimeType: 'image/png', size: 1 },
    { id: 'b', filename: 'PHOTO.png', mimeType: 'image/png', size: 1 },
  ]);
  expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(3);
});
