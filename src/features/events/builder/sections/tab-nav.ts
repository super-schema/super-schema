// src/features/events/builder/sections/tab-nav.ts
// The pure side of the item tab strip: which tab a key moves to, and which edges of the scrolling strip hide more tabs. No React.

/** The tab a key moves to from `current`, or null when the key is not a tab-navigation key (or there are no tabs). Left / right wrap. */
export function nextTabIndex(current: number, count: number, key: string): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight": return (current + 1) % count;
    case "ArrowLeft": return (current - 1 + count) % count;
    case "Home": return 0;
    case "End": return count - 1;
    default: return null;
  }
}

/** Sub-pixel rounding of the browser's scroll metrics must not make a strip that fits look scrollable. */
const EDGE_TOLERANCE = 1;

/** `start`: tabs are hidden to the left; `end`: tabs are hidden to the right. */
export function scrollEdges(m: { scrollLeft: number; clientWidth: number; scrollWidth: number }): { start: boolean; end: boolean } {
  return {
    start: m.scrollLeft > EDGE_TOLERANCE,
    end: m.scrollLeft + m.clientWidth < m.scrollWidth - EDGE_TOLERANCE,
  };
}
