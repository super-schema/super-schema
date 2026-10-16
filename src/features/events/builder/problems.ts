// src/features/events/builder/problems.ts
// Maps the parser's JSON-pointer problems onto builder sections, outline items and fields. Pure — no React.
import type { DocumentProblem, EventDocument } from "@/lib/events/document/types";
import type { BuilderSection } from "./sections";

/** `item` = the local key of the keyed item the pointer points into (null for metadata, a whole list, or an unknown index). */
export interface ProblemLocation { section: BuilderSection | null; item: string | null }

/** The four list sections of the document: their pointer segment doubles as the `EventDocument` property. */
export const LIST_SECTIONS = ["servers", "channels", "messages", "operations"] as const;
export type ListSection = (typeof LIST_SECTIONS)[number];

export const isListSection = (segment: string): segment is ListSection => (LIST_SECTIONS as readonly string[]).includes(segment);

/** Sections whose pointers carry an array index into `EventDocument[section]`: the four lists and the traits. */
export type IndexedSection = ListSection | "traits";
export const isIndexedSection = (segment: string): segment is IndexedSection => isListSection(segment) || segment === "traits";

/** A canonical array index: no sign, no leading zero, no exponent. */
const INDEX_PATTERN = /^(0|[1-9]\d*)$/;

/** RFC 6901 segments of `pointer` (`~1` → `/`, `~0` → `~`); null when it is not a pointer ("" is the whole document: no segments). */
function segmentsOf(pointer: string): string[] | null {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) return null;
  return pointer.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** Where a pointer lands: a section and, for `/servers/<i>/…` style pointers, the item's array index. */
export function pointerTarget(pointer: string): { section: BuilderSection | null; index: number | null } {
  const segments = segmentsOf(pointer);
  if (!segments || segments.length === 0) return { section: null, index: null };
  const [head, second] = segments;
  if (head === "info" || head === "defaultContentType") return { section: "metadata", index: null };
  // Everything under `components` (security schemes, and the correlation ids / parameters nobody edits yet) is the Advanced section.
  if (head === "components") return { section: "advanced", index: null };
  if (isIndexedSection(head)) return { section: head, index: second !== undefined && INDEX_PATTERN.test(second) ? Number(second) : null };
  return { section: null, index: null };
}

/** The name of the security scheme a pointer points into (`/components/securitySchemes/<name>/…`, escapes decoded), or null. */
export function securitySchemeAt(pointer: string): string | null {
  const segments = segmentsOf(pointer);
  if (!segments || segments[0] !== "components" || segments[1] !== "securitySchemes") return null;
  return segments[2] ?? null;
}

export function locateProblem(doc: EventDocument, pointer: string): ProblemLocation {
  const { section, index } = pointerTarget(pointer);
  if (section === "advanced") {
    const name = securitySchemeAt(pointer);
    const known = name !== null && Object.hasOwn(doc.components?.securitySchemes ?? {}, name);
    return { section, item: known ? name : null };
  }
  if (section === null || section === "metadata" || index === null) return { section, item: null };
  const key = doc[section][index]?.key;
  return { section, item: key ? key : null };
}

const sameProblem = (a: DocumentProblem, b: DocumentProblem) => a.pointer === b.pointer && a.message === b.message;

/** The first of each identical `{ pointer, message }` pair, in order. Client and server problems are usually the same list twice. */
export function uniqueProblems(problems: DocumentProblem[]): DocumentProblem[] {
  const out: DocumentProblem[] = [];
  for (const p of problems) if (!out.some((q) => sameProblem(p, q))) out.push(p);
  return out;
}

/** Problems at `prefix` or deeper (`/info/title` matches itself and `/info/title/x`, never `/info/titles`), de-duplicated. */
export function problemsByField(problems: DocumentProblem[], prefix: string): DocumentProblem[] {
  return uniqueProblems(problems.filter((p) => p.pointer === prefix || p.pointer.startsWith(`${prefix}/`)));
}

/** One line for a field's error slot: the distinct messages joined, or undefined when the field has no problem. */
export function problemMessage(problems: DocumentProblem[]): string | undefined {
  if (problems.length === 0) return undefined;
  return [...new Set(problems.map((p) => p.message))].join("; ");
}

/** `details.problems` of a failed action result, ignoring anything that is not a `{ pointer, message }` pair of strings. */
export function readProblems(details: unknown): DocumentProblem[] {
  const list = (details as { problems?: unknown } | null | undefined)?.problems;
  if (!Array.isArray(list)) return [];
  return list.filter((p): p is DocumentProblem => typeof p?.pointer === "string" && typeof p?.message === "string")
    .map((p) => ({ pointer: p.pointer, message: p.message }));
}
