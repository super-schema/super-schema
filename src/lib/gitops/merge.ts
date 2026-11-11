import { isDeepStrictEqual } from "node:util";

export interface MergeConflict {
  path: string;
  base: unknown;
  theirs: unknown;
  ours: unknown;
}
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const keyed = (v: unknown[]): boolean =>
  v.every((x) => object(x) && typeof x.id === "string") &&
  new Set(v.map((x) => (x as Record<string, unknown>).id)).size === v.length;
/** Structural three-way merge. Stable row ids preserve concurrent edits to different fields and detect delete/edit conflicts. */
export function mergeDocuments(
  base: unknown,
  theirs: unknown,
  ours: unknown,
): { value: unknown; conflicts: MergeConflict[] } {
  const conflicts: MergeConflict[] = [];
  function merge(b: unknown, t: unknown, o: unknown, path: string): unknown {
    if (isDeepStrictEqual(o, b)) return t;
    if (isDeepStrictEqual(t, b) || isDeepStrictEqual(o, t)) return o;
    if (object(b) && object(t) && object(o)) {
      const result: Record<string, unknown> = {};
      for (const key of new Set([
        ...Object.keys(b),
        ...Object.keys(t),
        ...Object.keys(o),
      ])) {
        const value = merge(
          b[key],
          t[key],
          o[key],
          `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
        );
        if (value !== undefined) result[key] = value;
      }
      return result;
    }
    if (
      Array.isArray(b) &&
      Array.isArray(t) &&
      Array.isArray(o) &&
      keyed(b) &&
      keyed(t) &&
      keyed(o)
    ) {
      const map = (a: unknown[]) =>
        new Map(a.map((v) => [(v as Record<string, unknown>).id as string, v]));
      const bm = map(b),
        tm = map(t),
        om = map(o);
      return [...new Set([...tm.keys(), ...om.keys(), ...bm.keys()])]
        .map((key) =>
          merge(bm.get(key), tm.get(key), om.get(key), `${path}/${key}`),
        )
        .filter((v) => v !== undefined);
    }
    conflicts.push({
      path: path || "/",
      base: b ?? null,
      theirs: t ?? null,
      ours: o ?? null,
    });
    return o;
  }
  return { value: merge(base, theirs, ours, ""), conflicts };
}
