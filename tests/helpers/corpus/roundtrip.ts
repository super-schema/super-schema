/**
 * Round trip (JSON Schema cases): import -> generate json-schema -> re-import, then compare a normalised projection of the root entity.
 * Every difference is classified EXPECTED (a documented lossy mapping; see EXPECTED_RULES) or DEFECT.
 */
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { pickRootEntity } from "@/lib/importers/multi-asset";
import type { ParsedEntity, ParsedField } from "@/lib/importers/types";
import { renameReservedFields } from "@/lib/reserved-field-names";
import { sanitizeIdentifier } from "@/lib/compiler/typespec-identifiers";

export interface Difference { path: string; before: unknown; after: unknown; classification: "EXPECTED" | "OPEN" | "DEFECT"; why?: string }
export interface RoundTripResult { status: "SAME" | "EXPECTED_DIFF" | "OPEN_DIFF" | "DEFECT" | "SKIPPED" | "REIMPORT_FAILED"; differences: Difference[]; note?: string }

const sortObject = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortObject(v)]));
  return value;
};

function projectField(f: ParsedField): Record<string, unknown> {
  return {
    type: f.type, nullable: f.nullable, format: f.format, classification: f.classification,
    dataClass: f.governance?.dataClass, dataCategory: f.governance?.dataCategory,
    constraints: [...(f.constraints ?? [])].map((c) => `${c.type}=${c.value}`).sort(),
    minValueExclusive: f.minValueExclusive, maxValueExclusive: f.maxValueExclusive,
    extensions: sortObject(f.extensions ?? {}),
    danglingRef: f.danglingRef ? `${f.danglingRef.ref}${f.danglingRef.element ? " (items)" : ""}` : undefined,
    enumValues: f.enumValues ? [...f.enumValues] : undefined,
    unionMembers: f.unionMembers ? [...f.unionMembers].sort() : undefined,
    arrayElementType: f.arrayElementType, mapValueType: f.mapValueType,
    referencedEntityName: f.danglingRef ? undefined : f.referencedEntityName,
    description: f.description || undefined, deprecated: f.deprecated || undefined,
  };
}

/** The importer's fields as the persisted rows name them (a field called `__proto__` is stored as `__proto___1`). */
function persistedNames(entity: ParsedEntity): ParsedEntity {
  const renamed = renameReservedFields(entity.fields.map((f) => ({ name: f.name })));
  return { ...entity, fields: entity.fields.map((f, i) => ({ ...f, name: renamed[i].name })) };
}

export function projectEntity(entity: ParsedEntity): { name: string; description?: string; extensions: unknown; fields: Record<string, Record<string, unknown>> } {
  return {
    name: entity.name, description: entity.description || undefined, extensions: sortObject(entity.extensions ?? {}),
    fields: Object.fromEntries(entity.fields.map((f) => [f.name, projectField(f)])),
  };
}

const INT_RANGES: Record<string, [number, number]> = {
  int8: [-128, 127], int16: [-32768, 32767], int32: [-2147483648, 2147483647], uint8: [0, 255], uint16: [0, 65535], uint32: [0, 4294967295],
};
const SIXTY_FOUR = new Set(["int64", "uint64"]);

interface RuleCtx { field?: string; prop?: string; before?: Record<string, unknown>; after?: Record<string, unknown> }

/** Documented lossy mappings: a difference matching a rule is EXPECTED with the rule's reason; everything else is a DEFECT. */
const EXPECTED_RULES: Array<{ test: (a: unknown, b: unknown, c: RuleCtx) => boolean; why: string; open?: boolean }> = [
  { why: "the official JSON Schema emitter writes a fixed-width integer as `type: integer` plus its range (minimum / maximum), with no `format`",
    test: (a, b, c) => (c.prop === "type" && b === "integer" && typeof a === "string" && a in INT_RANGES)
      || (c.prop === "constraints" && typeof c.before?.type === "string" && c.before.type in INT_RANGES && Array.isArray(b) && (b as string[]).filter((x) => !(a as string[]).includes(x)).every((x) => {
        const [lo, hi] = INT_RANGES[c.before!.type as string];
        return x === `minValue=${lo}` || x === `maxValue=${hi}`;
      })) },
  { why: "the official JSON Schema emitter writes int64 / uint64 as a plain string (JSON numbers cannot hold 64 bits)",
    test: (a, b, c) => (c.prop === "type" || c.prop === "arrayElementType") && b === "string" && typeof a === "string" && SIXTY_FOUR.has(a) },
  { why: "the official JSON Schema emitter writes float32 as a plain number, which imports as float64",
    test: (a, b, c) => (c.prop === "type" || c.prop === "arrayElementType") && a === "float32" && b === "float64" },
  { why: "bytes has no JSON Schema type: it is written as a base64 string (`contentEncoding`), which imports as a string with that extension",
    test: (a, b, c) => (c.prop === "type" && a === "bytes" && b === "string") || (c.prop === "extensions" && (b as Record<string, unknown>)?.contentEncoding === "base64" && c.before?.type === "bytes") },
  { why: "the emitted JSON Schema carries no classification overlay (emitter.service.ts projects the governance overlay out); only a vendor block kept verbatim as an extension survives",
    test: (a, b, c) => (c.prop === "classification" || c.prop === "dataClass" || c.prop === "dataCategory") && a !== undefined && b === undefined },
  { why: "the official emitter writes Record<unknown> (an `object` / map field) as the named definition RecordUnknown, which imports as a reference to that entity",
    test: (a, b, c) => ((c.prop === "type" && a === "object" && b === "reference") || (c.prop === "arrayElementType" && a === "object" && b === "reference") || (c.prop === "referencedEntityName" && b === "RecordUnknown")) && (c.after?.referencedEntityName === "RecordUnknown") },
  { why: "a numeric bound outside a fixed-width integer's range is not written (commit 0485b17f: the JSON number 9223372036854775807 is read as 2^63, which the compiler rejects for int64)",
    test: (a, b, c) => c.prop === "constraints" && typeof c.before?.type === "string" && (c.before.type === "int64" || c.before.type === "uint64") && Array.isArray(a) && Array.isArray(b) && (a as string[]).filter((x) => !(b as string[]).includes(x)).every((x) => /^m(ax|in)Value=-?\d{19,}/.test(x)) },
  { open: true, why: "OPEN: an array with no item type (no `items`, a tuple, ...) is generated as string[], so the re-imported field narrows from any item to string",
    test: (a, b, c) => c.prop === "arrayElementType" && a === undefined && b === "string" },
];

function fieldCtx(path: string, ctxFields: { before: Record<string, Record<string, unknown>>; after: Record<string, Record<string, unknown>> }): RuleCtx {
  const m = /^entity\.fields\.(.+?)\.([A-Za-z]+)(?:\..*)?$/.exec(path);
  if (!m) return {};
  return { field: m[1], prop: m[2], before: ctxFields.before[m[1]], after: ctxFields.after[m[1]] };
}

function diff(path: string, a: unknown, b: unknown, out: Difference[], ctx: { ignored: string[]; fields: { before: Record<string, Record<string, unknown>>; after: Record<string, Record<string, unknown>> } }): void {
  if (JSON.stringify(sortObject(a)) === JSON.stringify(sortObject(b))) return;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of [...keys].sort()) diff(`${path}.${k}`, (a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], out, ctx);
    return;
  }
  // `extensions` is compared per key: judge the rule on the whole extensions object of the field
  const rc = fieldCtx(path, ctx.fields);
  const ext = rc.prop === "extensions";
  const rule = EXPECTED_RULES.find((r) => r.test(ext ? { ...(rc.before?.extensions as object) } : a, ext ? { ...(rc.after?.extensions as object) } : b, rc));
  const nameRule = path === "entity.name" && typeof a === "string" && sanitizeIdentifier(a) === b;
  out.push({ path, before: a, after: b, classification: nameRule || (rule && !rule.open) ? "EXPECTED" : rule ? "OPEN" : "DEFECT", why: nameRule ? "an entity name is written as a TypeSpec identifier (spaces and symbols become `_`, a reserved word gets a prefix)" : rule?.why });
}

export function compareRoundTrip(original: ParsedEntity, generatedJsonSchema: string): RoundTripResult {
  const reparsed = parseJsonSchemaDocument(generatedJsonSchema);
  if (!reparsed.success) return { status: "REIMPORT_FAILED", differences: [], note: reparsed.error.message.slice(0, 300) };
  const second = pickRootEntity(reparsed.data);
  const differences: Difference[] = [];
  const p1 = projectEntity(persistedNames(original));
  const p2 = projectEntity(second);
  diff("entity", p1, p2, differences, { ignored: original.ignoredKeywords ?? [], fields: { before: p1.fields, after: p2.fields } });
  if (differences.length === 0) return { status: "SAME", differences };
  const status = differences.some((d) => d.classification === "DEFECT") ? "DEFECT" : differences.some((d) => d.classification === "OPEN") ? "OPEN_DIFF" : "EXPECTED_DIFF";
  return { status, differences };
}
