/**
 * Resolving the names a field's type WRITES in TypeSpec source (multi-entity emission, Task 11).
 *
 * The TypeSpec Source tab saves text; a field of it can be typed with the name of another entity of the tenant. This module decides what
 * such a name means, with the closure walk's own resolver (`createRefResolver`: id, then qualified name, then a bare name across the
 * tenant), and never guesses:
 *  - the name is written bare (`Address`) or qualified (`Billing.Payments.Address`, the `Domain.Product.Entity` of the entity; `_tenant`
 *    stands in for a missing domain / product, each segment as the TypeSpec identifier the generator makes of it);
 *  - exactly one entity -> the reference the field stores (a qualified reference with the entity id, NO version: only a pin tag stores one);
 *  - several -> nothing is decided: the caller asks the author, and the answer comes back as `picks` (field name -> entity id, which must be
 *    one of the candidates, so a pick can never point outside what the name matches in the tenant);
 *  - none -> not a reference of the tenant (the compile reports an unknown name, as it always did);
 *  - the entity's OWN model name is the entity itself (a self-reference), but only for a field that does not already store a reference:
 *    what a field stores wins (below), and a legacy name-only reference named like the entity is asked about like any shared name.
 * A reference the field already stores keeps meaning what it stored: written as the same name (as it is, as the identifier it is spelled
 * as, or as its Domain.Product.Entity), a qualified one is LEFT ALONE (its id is the key, so a name the tenant now shares, or the
 * entity's own name, does not matter) and a legacy name-only one is upgraded when the name has one match.
 *
 * Pure: no I/O, nothing throws, user-controlled keys are read as own properties only.
 */

import { sanitizeIdentifier } from "@/lib/compiler/typespec-identifiers";
import { activeDanglingRef } from "@/lib/field-dangling";
import { createRefResolver, type RefResolution } from "@/lib/references/closure";
import { holdsEntityReference, parseQualifiedName, type EntityRef, type ReferenceShape } from "@/lib/references/entity-reference";

/** At most this many different written names are looked at in one save; a source with more cannot be told apart from an attack. */
export const MAX_WRITTEN_NAMES = 500;

/**
 * A field of the entity's model whose type is, or is made of, a plain name: the name as written (`Address` / `Billing.Payments.Address`)
 * and how the field holds it (`direct`: `Address`, `array`: `Address[]`, `map`: `Record<Address>`).
 */
export type WrittenFieldType = { field: string; written: string; shape: ReferenceShape };

/** A stored field row, as far as the resolution reads it. */
export type StoredFieldRow = { id: string; name: string; type: string; decorators: unknown };

/**
 * What a field of the source resolves to. `ref`: the entity the field becomes a reference to (the pin tag of the source is the only
 * version). `keep`: the field already stores that reference and the text names it again (by the name it stores, or as another spelling of
 * it): it is left as it is, but still a reference of that `shape`, so the merge does not read the spelling as a retype.
 */
export type SourceReference = { ref: EntityRef; shape: ReferenceShape } | { keep: true; shape: ReferenceShape };

export type SourceReferenceOutcome =
  | {
      ok: true;
      references: Map<string, SourceReference>;
      /** Fields whose name no entity has and that do not already store a reference to that name: the name is unknown, as the compiler would have said. */
      unresolved: WrittenFieldType[];
    }
  | { ok: false; ambiguous: { field: string; name: string; candidates: EntityRef[]; fieldId: string } };

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const ownString = (o: unknown, k: string): string | undefined => {
  const v = isRec(o) ? own(o, k) : undefined;
  return typeof v === "string" && v !== "" ? v : undefined;
};

type ParsedName = { bare: string } | { segments: [string, string, string] };

/** `Address` is a bare name, `A.B.C` a qualified one; two segments, four or more, or an empty segment is neither. */
function parseWrittenName(written: string): ParsedName | undefined {
  if (typeof written !== "string" || written === "") return undefined;
  const parts = written.split(".");
  if (parts.some((p) => p === "")) return undefined;
  if (parts.length === 1) return { bare: parts[0] };
  if (parts.length === 3) return { segments: [parts[0], parts[1], parts[2]] };
  return undefined;
}

/**
 * The resolver for a name as written: `resolve(written)`. A bare name goes through the closure's legacy bare-name rule; a qualified one
 * is matched on the three segments as TypeSpec identifiers (the way the generator spells them), so an entity called `Order Item` in
 * `Billing & Co` is `Billing___Co.<Product>.Order_Item`.
 */
export function createNameResolver(refs: readonly EntityRef[]): (written: string) => RefResolution {
  const resolve = createRefResolver(refs);
  const spelled = refs.map((ref) => ({ ref, segments: [sanitizeIdentifier(ref.domain), sanitizeIdentifier(ref.product), sanitizeIdentifier(ref.entity)] }));
  return (written) => {
    const parsed = parseWrittenName(written);
    if (!parsed) return undefined;
    if ("bare" in parsed) return resolve({ legacyName: parsed.bare });
    const [domain, product, entity] = parsed.segments;
    const matches = spelled.filter((s) => s.segments[0] === domain && s.segments[1] === product && s.segments[2] === entity).map((s) => s.ref);
    if (matches.length === 0) return undefined;
    if (matches.length === 1) return { target: matches[0] };
    return { ambiguous: matches, name: written };
  };
}

/** The field type of each shape: a reference field is `reference`, an array of references `array`, a map of references `map`. */
const SHAPE_TYPE: Record<ReferenceShape, string> = { direct: "reference", array: "array", map: "map" };

/** The `Domain.Product.Entity` spelling (segments as identifiers) of the qualified name a row stores (`Domain/Product/Entity`), if it stores one. */
function dottedSpelling(decorators: unknown): string | undefined {
  const qualified = ownString(decorators, "referencedQualifiedName");
  const parsed = qualified === undefined ? undefined : parseQualifiedName(qualified);
  return parsed ? [parsed.domain, parsed.product, parsed.entity].map(sanitizeIdentifier).join(".") : undefined;
}

/**
 * The target a stored row's reference carries: its name, its dotted spelling when it is qualified, and whether it is name-only (legacy).
 * Undefined when the row is not a reference of that shape.
 */
function storedTarget(row: StoredFieldRow | undefined, shape: ReferenceShape): { name: string; dotted?: string; legacy: boolean } | undefined {
  if (!row || typeof row.type !== "string") return undefined;
  if (!holdsEntityReference(row.type, row.decorators)) return undefined;
  if (row.type !== SHAPE_TYPE[shape]) return undefined;
  const name = ownString(row.decorators, "referencedEntityName");
  if (name === undefined) return undefined;
  const dotted = dottedSpelling(row.decorators);
  return { name, ...(dotted !== undefined ? { dotted } : {}), legacy: ownString(row.decorators, "referencedQualifiedName") === undefined };
}

/**
 * The names of the references the rows store (the name, as the identifier the generator spells it as, and for a qualified one its
 * `Domain.Product.Entity` spelling), for the compile gate: a name the entity ALREADY refers to may stay in the source even when the tenant no longer has it (its entity was deleted or
 * renamed: the field keeps its id and stays as it is, and the entity is not stuck). A row that carries a dangling marker (its target is a
 * raw `$ref`, not an entity) is not counted: its name licenses nothing.
 */
export function storedReferenceNames(rows: readonly StoredFieldRow[]): Set<string> {
  const names = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row.type !== "string" || !holdsEntityReference(row.type, row.decorators)) continue;
    if (activeDanglingRef(row.type, isRec(row.decorators) ? row.decorators : null) !== undefined) continue;
    const name = ownString(row.decorators, "referencedEntityName");
    if (name !== undefined) {
      names.add(name);
      names.add(sanitizeIdentifier(name));
    }
    const dotted = dottedSpelling(row.decorators);
    if (dotted !== undefined) names.add(dotted);
  }
  return names;
}

/** `picks` as the client sent it: only own string values of a plain object, anything else reads as no pick. */
function readPicks(picks: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!isRec(picks)) return out;
  for (const key of Object.keys(picks)) {
    const value = own(picks, key);
    if (typeof value === "string" && value !== "") out.set(key, value);
  }
  return out;
}

/**
 * What each candidate field of the entity's model means. `fields` are the fields whose written type names a model the source does not
 * declare (an entity of the tenant) or the entity's own model; `stored` are the entity's rows by field name; `refs` the tenant's entities.
 * A field that already stores a reference and is written as that same name is `keep` (a qualified one always; a legacy one when its name
 * has no match at all); a name no entity has on any other field is listed in `unresolved`.
 * The first field (in `fields` order) whose bare name has several matches and no valid pick stops the resolution: `ambiguous`.
 */
export function resolveSourceReferences(input: {
  fields: readonly WrittenFieldType[];
  stored: ReadonlyMap<string, StoredFieldRow>;
  self: { entityId: string; modelName: string };
  refs: readonly EntityRef[];
  picks?: unknown;
}): SourceReferenceOutcome {
  const resolve = createNameResolver(input.refs);
  const selfRef = input.refs.find((r) => r.entityId === input.self.entityId);
  const picks = readPicks(input.picks);
  const references = new Map<string, SourceReference>();
  const unresolved: WrittenFieldType[] = [];

  for (const f of input.fields) {
    const row = input.stored.get(f.field);
    const parsed = parseWrittenName(f.written);
    const bare = parsed && "bare" in parsed ? parsed.bare : undefined;

    // Written as the reference the field ALREADY stores (the name it stores, that name as an identifier, or its Domain.Product.Entity),
    // a qualified reference is the same reference and is left alone: its id is the key, so neither a name the tenant now shares nor the
    // entity's own name changes what it points at. A legacy (name-only) one falls through: upgraded when the name has exactly one
    // match, asked about when it has several (the entity itself among them when it is named so), left dangling when it has none.
    const target = storedTarget(row, f.shape);
    const sameName =
      target !== undefined &&
      ((bare !== undefined && (target.name === bare || sanitizeIdentifier(target.name) === bare)) || (target.dotted !== undefined && target.dotted === f.written));
    if (sameName && target !== undefined && !target.legacy) {
      references.set(f.field, { keep: true, shape: f.shape });
      continue;
    }

    // The entity's own model is the entity: nothing to choose, whatever the tenant calls that. Only for a field that does not already
    // refer to that name (handled above and below): what a field stores is not overwritten by a self-reference.
    if (!sameName && bare !== undefined && bare === input.self.modelName && selfRef) {
      references.set(f.field, { ref: selfRef, shape: f.shape });
      continue;
    }

    const resolution = resolve(f.written);
    if (!resolution) {
      // Nothing is named so. A legacy reference to that very name stays as it is (its entity is gone: it stays dangling); on any other
      // field the name stays unknown. (It compiled only because ANOTHER field's stored reference licensed the name.)
      if (sameName) references.set(f.field, { keep: true, shape: f.shape });
      else unresolved.push(f);
      continue;
    }

    if ("target" in resolution) {
      references.set(f.field, { ref: resolution.target, shape: f.shape });
      continue;
    }
    const picked = resolution.ambiguous.find((c) => c.entityId !== undefined && c.entityId === picks.get(f.field));
    if (picked) {
      references.set(f.field, { ref: picked, shape: f.shape });
      continue;
    }
    return { ok: false, ambiguous: { field: f.field, name: f.written, candidates: resolution.ambiguous, fieldId: row?.id ?? "" } };
  }
  return { ok: true, references, unresolved };
}
