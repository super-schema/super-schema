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
 *  - the entity's OWN model name is the entity itself (a self-reference), whatever else the tenant calls that.
 * A reference the field already stores keeps meaning what it stored: written as the same name, a qualified one is left alone (its id is
 * the key, so a name the tenant now shares does not matter) and a legacy name-only one is upgraded when the name has one match.
 *
 * Pure: no I/O, nothing throws, user-controlled keys are read as own properties only.
 */

import { sanitizeIdentifier } from "@/lib/compiler/typespec-identifiers";
import { activeDanglingRef } from "@/lib/field-dangling";
import { createRefResolver, type RefResolution } from "@/lib/references/closure";
import { holdsEntityReference, parseQualifiedName, type EntityRef } from "@/lib/references/entity-reference";

/** At most this many different written names are looked at in one save; a source with more cannot be told apart from an attack. */
export const MAX_WRITTEN_NAMES = 500;

/** A field of the entity's model whose type is a plain name: the name as written (`Address` / `Billing.Payments.Address`), and whether it is the ELEMENT of an array. */
export type WrittenFieldType = { field: string; written: string; element: boolean };

/** A stored field row, as far as the resolution reads it. */
export type StoredFieldRow = { id: string; name: string; type: string; decorators: unknown };

/** What a field of the source resolves to; `element` says the reference is the element of an array field. */
export type SourceReference = { ref: EntityRef; element: boolean };

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
function storedTarget(row: StoredFieldRow | undefined, element: boolean): { name: string; dotted?: string; legacy: boolean } | undefined {
  if (!row || typeof row.type !== "string") return undefined;
  if (!holdsEntityReference(row.type, row.decorators)) return undefined;
  if (element ? row.type !== "array" : row.type !== "reference") return undefined;
  const name = ownString(row.decorators, "referencedEntityName");
  if (name === undefined) return undefined;
  const dotted = dottedSpelling(row.decorators);
  return { name, ...(dotted !== undefined ? { dotted } : {}), legacy: ownString(row.decorators, "referencedQualifiedName") === undefined };
}

/**
 * The names of the references the rows store (the name, and for a qualified one its `Domain.Product.Entity` spelling), for the compile
 * gate: a name the entity ALREADY refers to may stay in the source even when the tenant no longer has it (its entity was deleted or
 * renamed: the field keeps its id and stays as it is, and the entity is not stuck). A row that carries a dangling marker (its target is a
 * raw `$ref`, not an entity) is not counted: its name licenses nothing.
 */
export function storedReferenceNames(rows: readonly StoredFieldRow[]): Set<string> {
  const names = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row.type !== "string" || !holdsEntityReference(row.type, row.decorators)) continue;
    if (activeDanglingRef(row.type, isRec(row.decorators) ? row.decorators : null) !== undefined) continue;
    const name = ownString(row.decorators, "referencedEntityName");
    if (name !== undefined) names.add(name);
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
 * Fields that resolve to nothing, and stored qualified references written as the same name, have no entry (the merge leaves them as they are);
 * of those, a field that did NOT already refer to the name is also listed in `unresolved`.
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

    // The entity's own model is the entity: nothing to choose, whatever the tenant calls that.
    if (bare !== undefined && bare === input.self.modelName && selfRef) {
      references.set(f.field, { ref: selfRef, element: f.element });
      continue;
    }

    // Written as the name the field already refers to, a qualified reference is the same reference (its id is the key, so a name the
    // tenant now shares does not matter). A legacy one falls through: upgraded when the name has exactly one match, asked about when it
    // has several, left dangling when it has none.
    const target = storedTarget(row, f.element);
    const sameName = target !== undefined && ((bare !== undefined && target.name === bare) || (target.dotted !== undefined && target.dotted === f.written));
    if (sameName && target !== undefined && !target.legacy) continue;

    const resolution = resolve(f.written);
    if (!resolution) {
      // Nothing is named so, and the field is not one that already refers to that name (a deleted entity's reference is kept as it is):
      // the name stays unknown. (It compiled only because ANOTHER field's stored reference licensed the name.)
      if (!sameName) unresolved.push(f);
      continue;
    }

    if ("target" in resolution) {
      references.set(f.field, { ref: resolution.target, element: f.element });
      continue;
    }
    const picked = resolution.ambiguous.find((c) => c.entityId !== undefined && c.entityId === picks.get(f.field));
    if (picked) {
      references.set(f.field, { ref: picked, element: f.element });
      continue;
    }
    return { ok: false, ambiguous: { field: f.field, name: f.written, candidates: resolution.ambiguous, fieldId: row?.id ?? "" } };
  }
  return { ok: true, references, unresolved };
}
