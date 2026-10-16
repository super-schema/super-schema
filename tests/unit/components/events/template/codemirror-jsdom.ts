// tests/unit/components/events/template/codemirror-jsdom.ts
// What CodeMirror 6 needs from a browser and jsdom does not have. Importing this file (before the component) installs it; only the
// tests that mount the real editor import it. JsonEditor decides at run time whether CodeMirror can run here by checking for
// `Range.prototype.getClientRects`, so WITHOUT this import the editor stays on its textarea, and WITH it the real editor mounts.
// Not a test file (vitest only collects *.test.ts[x]).

const ZERO_RECT = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () { /* no rects */ } }) as unknown as DOMRectList;

if (typeof Range !== "undefined") {
  // CodeMirror measures text with ranges; jsdom has no layout, so every range is empty.
  Range.prototype.getClientRects = emptyRects;
  Range.prototype.getBoundingClientRect = () => ZERO_RECT;
}

if (typeof document !== "undefined") {
  // Used when the pointer is turned into a document position.
  document.elementFromPoint = () => null;
  if (typeof document.elementsFromPoint !== "function") document.elementsFromPoint = () => [];
}

if (typeof globalThis.ResizeObserver === "undefined") {
  // CodeMirror re-measures when its scroller is resized; there are no sizes here.
  globalThis.ResizeObserver = class {
    observe() { /* no layout in jsdom */ }
    unobserve() { /* no layout in jsdom */ }
    disconnect() { /* no layout in jsdom */ }
  } as unknown as typeof ResizeObserver;
}

export {};
