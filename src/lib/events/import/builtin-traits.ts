// src/lib/events/import/builtin-traits.ts
// Recognises the built-in library traits (CloudEvents, W3C Trace Context) in an imported message trait. Pure — client-safe.
//
// The definitions live in `bundled-traits.ts` (`BUNDLED_TRAITS`); nothing here repeats a property name. A trait matches a built-in when
// its inline headers schema declares every REQUIRED property of the built-in and no property the built-in does not list: a trait with
// extra headers is the user's own trait and stays a local copy.
import { BUNDLED_MARKER_KEY, BUNDLED_TRAITS } from "@/lib/events/bundled-traits";

export type BuiltInTraitKind = "cloudEvents" | "traceContext";
/** `name` is the library trait's name (what the user sees in the trait list). */
export interface BuiltInMatch { kind: BuiltInTraitKind; name: string }

/** Marker prefix (`cloudevents@…`) of each built-in family: the version after the `@` can change, the family cannot. */
const FAMILIES: ReadonlyArray<{ kind: BuiltInTraitKind; markerPrefix: string }> = [
  { kind: "cloudEvents", markerPrefix: "cloudevents@" },
  { kind: "traceContext", markerPrefix: "w3c-trace-context@" },
];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

interface Definition { kind: BuiltInTraitKind; name: string; required: string[]; allowed: Set<string> }

/** The built-in definitions, read once from `BUNDLED_TRAITS`. */
const DEFINITIONS: Definition[] = FAMILIES.flatMap(({ kind, markerPrefix }): Definition[] => {
  const trait = BUNDLED_TRAITS.find((t) => typeof t.spec[BUNDLED_MARKER_KEY] === "string" && (t.spec[BUNDLED_MARKER_KEY] as string).startsWith(markerPrefix));
  const headers = trait?.spec.headers;
  if (!trait || !isObject(headers) || !isObject(headers.properties)) return [];
  const required = Array.isArray(headers.required) ? headers.required.filter((r): r is string => typeof r === "string") : [];
  return [{ kind, name: trait.name, required, allowed: new Set(Object.keys(headers.properties)) }];
});

/**
 * Which built-in a message trait's `spec` is, judged by its inline `headers` schema alone (summary, description, tags and the other
 * trait fields do not matter); `null` when it is none of them. `spec` is the trait as written in the file, refs already inlined.
 */
export function detectBuiltInTrait(spec: unknown): BuiltInMatch | null {
  if (!isObject(spec) || !isObject(spec.headers) || !isObject(spec.headers.properties)) return null;
  const properties = spec.headers.properties;
  const names = Object.keys(properties);
  if (names.length === 0) return null;
  for (const definition of DEFINITIONS) {
    const hasRequired = definition.required.every((name) => Object.hasOwn(properties, name));
    if (hasRequired && names.every((name) => definition.allowed.has(name))) return { kind: definition.kind, name: definition.name };
  }
  return null;
}
