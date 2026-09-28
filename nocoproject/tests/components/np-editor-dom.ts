/**
 * ProseMirror measures the DOM to scroll the selection into view; jsdom has no layout, so the measuring APIs it
 * lacks are stubbed with empty rectangles. Import this module before rendering a TipTap editor in a test.
 */
const emptyRect = (): DOMRect =>
  ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  }) as DOMRect;

const emptyList = (): DOMRectList =>
  Object.assign([], { item: () => null }) as unknown as DOMRectList;

if (typeof Range !== 'undefined') {
  Range.prototype.getBoundingClientRect ??= emptyRect;
  Range.prototype.getClientRects ??= emptyList;
}
if (typeof Element !== 'undefined') {
  Element.prototype.getClientRects ??= emptyList;
}
if (typeof document !== 'undefined') {
  document.elementFromPoint ??= () => null;
}

export {};
