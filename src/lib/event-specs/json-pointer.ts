/**
 * RFC 6901 JSON pointer helpers shared by the assembler (building `$ref`s and
 * diagnostic pointers) and the structural validator (resolving `$ref`s).
 */

export function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function unescapePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** `jsonPointer("channels", "a/b")` → `/channels/a~1b`; no segments → `""` (root). */
export function jsonPointer(...segments: Array<string | number>): string {
  return segments.map((s) => "/" + escapePointerSegment(String(s))).join("");
}

/** Local reference string: `localRef("channels", "orders")` → `#/channels/orders`. */
export function localRef(...segments: Array<string | number>): string {
  return "#" + jsonPointer(...segments);
}

/** Split a local ref (`#/a/b`) into unescaped segments; `null` when not local. */
export function parseLocalRef(ref: string): string[] | null {
  if (ref === "#") return [];
  if (!ref.startsWith("#/")) return null;
  return ref
    .slice(2)
    .split("/")
    .map((raw) => {
      let decoded = raw;
      try {
        decoded = decodeURIComponent(raw);
      } catch {
        // keep the raw segment when it is not valid percent-encoding
      }
      return unescapePointerSegment(decoded);
    });
}

export type PointerResolution = { found: true; value: unknown } | { found: false };

/** Resolve a local `#/...` ref against `root`. */
export function resolveLocalRef(root: unknown, ref: string): PointerResolution {
  const segments = parseLocalRef(ref);
  if (segments === null) return { found: false };
  let current: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) return { found: false };
      const index = Number(segment);
      if (index >= current.length) return { found: false };
      current = current[index];
    } else if (
      typeof current === "object" &&
      current !== null &&
      Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}
