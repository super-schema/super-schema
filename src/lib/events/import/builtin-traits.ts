// src/lib/events/import/builtin-traits.ts
// Recognises the built-in library traits (CloudEvents, W3C Trace Context) in an imported message trait. Pure — client-safe.
//
// The definitions live in `bundled-traits.ts` (`BUNDLED_TRAITS`); nothing here repeats a property name or a version. A trait matches a
// built-in when its inline headers schema (1) declares every REQUIRED property of the built-in and no property the built-in does not list,
// (2) itself marks every one of those properties as required, and (3) does not pin `specversion` (CloudEvents) to another version than the
// built-in's. A trait with extra headers, weaker requirements or another spec version is the user's own trait and stays a local copy.
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

/** Which built-in family a library trait's `x-bundled` marker (`cloudevents@1.0`) belongs to; `null` for any other marker. */
export function builtInKindOfMarker(marker: string): BuiltInTraitKind | null {
  return FAMILIES.find((family) => marker.startsWith(family.markerPrefix))?.kind ?? null;
}

interface Definition { kind: BuiltInTraitKind; name: string; required: string[]; allowed: Set<string>; constants: Map<string, unknown> }

/** The built-in definitions, read once from `BUNDLED_TRAITS`. `constants`: properties the built-in pins with a `const` (`specversion: "1.0"`). */
const DEFINITIONS: Definition[] = FAMILIES.flatMap(({ kind, markerPrefix }): Definition[] => {
  const trait = BUNDLED_TRAITS.find((t) => typeof t.spec[BUNDLED_MARKER_KEY] === "string" && (t.spec[BUNDLED_MARKER_KEY] as string).startsWith(markerPrefix));
  const headers = trait?.spec.headers;
  if (!trait || !isObject(headers) || !isObject(headers.properties)) return [];
  const required = Array.isArray(headers.required) ? headers.required.filter((r): r is string => typeof r === "string") : [];
  const constants = new Map<string, unknown>();
  for (const [name, schema] of Object.entries(headers.properties)) if (isObject(schema) && schema.const !== undefined) constants.set(name, schema.const);
  return [{ kind, name: trait.name, required, allowed: new Set(Object.keys(headers.properties)), constants }];
});

/**
 * Which built-in a message trait's `spec` is, judged by its inline `headers` schema alone (summary, description, tags and the other
 * trait fields do not matter); `null` when it is none of them. `spec` is the trait as written in the file, refs already inlined.
 */
export function detectBuiltInTrait(spec: unknown): BuiltInMatch | null {
  if (!isObject(spec) || !isObject(spec.headers) || !isObject(spec.headers.properties)) return null;
  const { properties, required } = spec.headers;
  const names = Object.keys(properties);
  if (names.length === 0) return null;
  const requiredNames = new Set(Array.isArray(required) ? required.filter((r): r is string => typeof r === "string") : []);
  for (const definition of DEFINITIONS) {
    const hasRequired = definition.required.every((name) => Object.hasOwn(properties, name) && requiredNames.has(name));
    if (!hasRequired || !names.every((name) => definition.allowed.has(name))) continue;
    // a `const` the built-in pins (CloudEvents' specversion "1.0") must not be pinned to something else
    const pinnedElsewhere = [...definition.constants].some(([name, value]) => {
      const schema = properties[name];
      return isObject(schema) && schema.const !== undefined && schema.const !== value;
    });
    if (!pinnedElsewhere) return { kind: definition.kind, name: definition.name };
  }
  return null;
}
