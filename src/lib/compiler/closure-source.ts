/**
 * Combined multi-entity TypeSpec source for a reference closure (multi-entity emission, Task 4).
 *
 * One document holds every entity of the closure, each in its own `namespace <Domain>.<Product>.<Entity> { ... }` block, its
 * model named by {@link uniqueModelName} (unique across the closure, so the JSON Schema / Avro file names `<Model>.json`
 * never collide even when two products each have an `Order`). A reference field is typed with the target's fully qualified
 * model (`Sales.Orders.Customer.Sales_Orders_Customer`); a reference to something not in the closure is `unknown`, never a
 * name nothing declares. A self-reference and an A <-> B cycle are plain forward references and compile.
 *
 * This is the EMISSION projection: governance is off by default, so the reference pin tag (`x-super-schema-pin`, see
 * governance-decorators.ts) is absent from the text handed to a target. Pass `governance: true` for a source that keeps it.
 *
 * Pure - no I/O; every identifier goes through the shared TypeSpec identifier rules, nothing throws.
 */

import type { ClosureEntity } from "@/lib/references/closure";
import { TENANT_PLACEHOLDER, qualifiedName, type EntityRef } from "@/lib/references/entity-reference";
import { compileEntity } from "@/lib/compiler/compiler.service";
import type { SuperSchemaField } from "@/types/super-schema-model";
import { ENTERPRISE_NAMESPACE, JSON_SCHEMA_LIBRARY_IMPORT } from "./governance-decorators";
import { generateTypeSpecWithDiagnostics, type GeneratorDiagnostic } from "./typespec-generator";
import { sanitizeIdentifier } from "./typespec-identifiers";

/** A schema target key as the catalog names it (`json-schema`, `avro`, ...). */
export type ClosureTarget = string;

const PLAIN_SEGMENT = /^[A-Za-z0-9]+$/;

/** 32-bit FNV-1a, 8 lowercase hex digits. Stable across runs and platforms (no `crypto`: this runs in client bundles too). */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * The model name of an entity in a combined document: `<domain>_<product>_<entity>`, each segment sanitized, so a name is
 * readable and the same on every run. Joining with `_` and sanitizing can merge two DIFFERENT references (`a-b`/`c` and
 * `a_b`/`c`, or `a_b`/`c` and `a`/`b_c`); a name is therefore the plain join only when every segment is purely alphanumeric
 * (the `_tenant` placeholder aside), which cannot merge. Otherwise a short stable hash of the qualified name is appended.
 * The result is always a valid, non-reserved TypeSpec identifier. Two refs with the SAME qualified name get the same name
 * (the closure disambiguates those by order).
 */
export function uniqueModelName(ref: EntityRef): string {
  const segments = [ref.domain, ref.product, ref.entity];
  const lossless = segments.every((s) => s === TENANT_PLACEHOLDER || PLAIN_SEGMENT.test(s));
  const joined = sanitizeIdentifier(segments.map((s) => s.replace(/[^A-Za-z0-9_]/g, "_")).join("_"));
  return lossless ? joined : `${joined}_${shortHash(qualifiedName(ref))}`;
}

/** A namespace segment: sanitized (keywords prefixed, invalid characters replaced), `_tenant` kept as it is a valid identifier. */
function namespaceSegment(segment: string): string {
  return sanitizeIdentifier(segment);
}

function namespaceOf(ref: EntityRef): string {
  return [ref.domain, ref.product, ref.entity].map(namespaceSegment).join(".");
}

type Placed = { entity: ClosureEntity; namespace: string; modelName: string };

const nameKey = (name: string) => name.trim().toLowerCase();
const idKey = (name: string) => sanitizeIdentifier(name.trim()).toLowerCase();

export type ClosureTypeSpec = {
  source: string;
  /** The root entity's model name (the stem of its `<Model>.json` / `<Model>.avsc`). */
  rootModel: string;
  /** entityId -> the model's fully qualified TypeSpec name (`Domain.Product.Entity.Model`), in closure order. */
  models: Map<string, string>;
  /** What the generator could not express faithfully, across every member. */
  diagnostics: GeneratorDiagnostic[];
};

/**
 * Generates the combined document. Root first, then the rest in closure order. `opts.target` adds the import a target
 * needs (`json-schema`); `opts.governance` (default false: the emission projection) keeps the governance overlay and the pin tag.
 */
export function generateClosureTypeSpec(
  closure: { entities: ClosureEntity[] },
  opts: { target: ClosureTarget; governance?: boolean }
): ClosureTypeSpec {
  const governance = opts.governance === true;

  // Closure-unique model names: the deterministic name, then `_2`, `_3` ... for the same name claimed twice.
  const taken = new Set<string>();
  const placed: Placed[] = closure.entities.map((entity) => {
    const base = uniqueModelName(entity.ref);
    let modelName = base;
    for (let n = 2; taken.has(modelName); n++) modelName = `${base}_${n}`;
    taken.add(modelName);
    return { entity, namespace: namespaceOf(entity.ref), modelName };
  });

  const qualifiedModel = (p: Placed) => `${p.namespace}.${p.modelName}`;
  const byId = new Map(placed.map((p) => [p.entity.entityId, p]));
  const byQualified = new Map<string, Placed>();
  for (const p of placed) if (!byQualified.has(qualifiedName(p.entity.ref))) byQualified.set(qualifiedName(p.entity.ref), p);

  const resolveLegacy = (name: string): Placed | undefined => {
    const exact = placed.filter((p) => nameKey(p.entity.ref.entity) === nameKey(name));
    const matches = exact.length > 0 ? exact : placed.filter((p) => idKey(p.entity.ref.entity) === idKey(name));
    return matches.length === 1 ? matches[0] : undefined;
  };

  /** id -> qualified name -> legacy bare name, the order the closure loader resolves in. */
  const referenceType = (field: SuperSchemaField): string | null => {
    const ref = field.complexType?.reference;
    let target: Placed | undefined;
    if (ref && "legacyName" in ref) target = resolveLegacy(ref.legacyName);
    else if (ref) target = (ref.entityId ? byId.get(ref.entityId) : undefined) ?? byQualified.get(qualifiedName(ref));
    return target ? qualifiedModel(target) : null;
  };

  const enterpriseShadowed = placed.some(
    (p) => p.modelName === ENTERPRISE_NAMESPACE || p.namespace.split(".").includes(ENTERPRISE_NAMESPACE)
  );

  const imports: string[] = [];
  const blocks: string[] = [];
  const diagnostics: GeneratorDiagnostic[] = [];
  for (const p of placed) {
    const model = compileEntity(p.entity.entity, p.entity.fields);
    const generated = generateTypeSpecWithDiagnostics(model, {
      governance,
      closureMember: { modelName: p.modelName, referenceType, enterpriseShadowed },
    });
    diagnostics.push(...generated.diagnostics);

    const lines = generated.source.replace(/\n$/, "").split("\n");
    let i = 0;
    while (i < lines.length && lines[i].startsWith("import ")) {
      if (!imports.includes(lines[i])) imports.push(lines[i]);
      i++;
    }
    const body = lines.slice(i).filter((l, idx, all) => !(idx === 0 && l === "") && !(idx === all.length - 1 && l === ""));
    blocks.push([`namespace ${p.namespace} {`, ...body.map((l) => (l === "" ? "" : `  ${l}`)), "}"].join("\n"));
  }

  if (opts.target === "json-schema" && !imports.includes(JSON_SCHEMA_LIBRARY_IMPORT)) imports.push(JSON_SCHEMA_LIBRARY_IMPORT);

  const source = [...(imports.length > 0 ? [...imports, ""] : []), blocks.join("\n\n"), ""].join("\n");
  return {
    source,
    rootModel: placed[0]?.modelName ?? "",
    models: new Map(placed.map((p) => [p.entity.entityId, qualifiedModel(p)])),
    diagnostics,
  };
}
