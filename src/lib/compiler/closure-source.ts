/**
 * Combined multi-entity TypeSpec source for a reference closure (multi-entity emission, Task 4).
 *
 * One document holds every entity of the closure, each in its own `namespace <Domain>.<Product>.<Entity> { ... }` block, its
 * model named after the entity (see {@link closureModelNames}: only entities that would share a name are qualified, so the JSON
 * Schema / Avro file names `<Model>.json` never collide even when two products each have an `Order`, and a closure of one entity
 * keeps its stand-alone names). A reference field is typed with the target's fully qualified model
 * (`SuperSchemaClosure.Sales.Orders.Customer.Customer`); a reference to something not in the closure is `unknown`, never a
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
import type { SuperSchemaField, SuperSchemaModel } from "@/types/super-schema-model";
import { ENTERPRISE_NAMESPACE, JSON_SCHEMA_LIBRARY_IMPORT } from "./governance-decorators";
import { generateTypeSpecWithDiagnostics, type GeneratorDiagnostic } from "./typespec-generator";
import { withUnionFieldsAsString } from "./union-fields";
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
 * The FULLY QUALIFIED model name of an entity: `<domain>_<product>_<entity>`, each segment sanitized, so a name is readable and
 * the same on every run. Joining with `_` and sanitizing can merge two DIFFERENT references (`a-b`/`c` and `a_b`/`c`, or
 * `a_b`/`c` and `a`/`b_c`); a name is therefore the plain join only when every segment is purely alphanumeric (the `_tenant`
 * placeholder aside), which cannot merge. Otherwise a short stable hash of the qualified name is appended. The result is always a
 * valid, non-reserved TypeSpec identifier.
 *
 * This is the LAST tier of {@link closureModelNames}: a model is named after its entity, and only an entity whose name another
 * entity of the closure would share (or that cannot be used as it is) is qualified, step by step, up to this name. Two refs with
 * the SAME qualified name get the same name here (the closure disambiguates those by order).
 */
export function uniqueModelName(ref: EntityRef): string {
  const segments = [ref.domain, ref.product, ref.entity];
  const lossless = segments.every((s) => s === TENANT_PLACEHOLDER || PLAIN_SEGMENT.test(s));
  const joined = sanitizeIdentifier(segments.map((s) => s.replace(/[^A-Za-z0-9_]/g, "_")).join("_"));
  return lossless ? joined : `${joined}_${shortHash(qualifiedName(ref))}`;
}

/**
 * Every entity namespace lives under this one root, and every reference is written from it
 * (`SuperSchemaClosure.<Domain>.<Product>.<Entity>.<Model>`). TypeSpec resolves the FIRST segment of a reference lexically,
 * innermost scope outward, so a relative `Billing.Billing.Customer.M` breaks as soon as an enclosing namespace has a member
 * called `Billing` (domain == product, entity == domain, ...). The root is safe because no enclosing scope can hold a member
 * with its name: members are the sanitized segments (which {@link namespaceSegment} never lets equal the root) and models /
 * shared types, which {@link closureModelNames} and the shared-name prefixing never let equal it either.
 */
export const CLOSURE_ROOT_NAMESPACE = "SuperSchemaClosure";

const MODEL_NAME_TIERS = 3;

const nameSegment = (s: string): string => s.replace(/[^A-Za-z0-9_]/g, "_");

/** The name tier `tier` of a ref: 0 the entity, 1 `<Product>_<Entity>`, 2 `<Domain>_<Product>_<Entity>`, 3 that plus a hash if sanitizing merged. */
function modelNameAtTier(ref: EntityRef, tier: number): string {
  switch (tier) {
    case 0:
      return sanitizeIdentifier(ref.entity);
    case 1:
      return sanitizeIdentifier(`${nameSegment(ref.product)}_${nameSegment(ref.entity)}`);
    case 2:
      return sanitizeIdentifier([ref.domain, ref.product, ref.entity].map(nameSegment).join("_"));
    default:
      return uniqueModelName(ref);
  }
}

/**
 * The model name of each entity of a closure, in order. A model is named after its ENTITY (the sanitized entity name, exactly what
 * the stand-alone path writes), so a file / message / record / class is called what the user calls the entity and does not change
 * when the entity gains a reference. Only an entity that would get the SAME name as another entity of the closure is qualified, and
 * only those: first `<Product>_<Entity>`, then `<Domain>_<Product>_<Entity>`, and only if sanitizing still merges two distinct
 * references a stable hash ({@link uniqueModelName}). A name that cannot be used as it is (empty, the reserved closure root, or one
 * of `reserved`) is qualified the same way. Deterministic and independent of the entities' order, except that references with an
 * identical qualified name keep one name here (the caller suffixes `_2`, `_3`, ... by order). Pure.
 *
 * A closure of one entity therefore always gets today's stand-alone name.
 */
export function closureModelNames(refs: readonly EntityRef[], reserved: ReadonlySet<string> = new Set()): string[] {
  const tiers = refs.map(() => 0);
  for (;;) {
    const names = refs.map((ref, i) => modelNameAtTier(ref, tiers[i]));
    const sharedBy = new Map<string, number>();
    for (const name of names) sharedBy.set(name, (sharedBy.get(name) ?? 0) + 1);
    let bumped = false;
    names.forEach((name, i) => {
      const unusable = name === "" || name === CLOSURE_ROOT_NAMESPACE || reserved.has(name);
      if ((unusable || (sharedBy.get(name) ?? 0) > 1) && tiers[i] < MODEL_NAME_TIERS) {
        tiers[i] += 1;
        bumped = true;
      }
    });
    if (!bumped) return names;
  }
}

/** A namespace segment: sanitized (keywords prefixed, invalid characters replaced), never equal to the reserved root. */
function namespaceSegment(segment: string): string {
  const safe = sanitizeIdentifier(segment);
  return safe === CLOSURE_ROOT_NAMESPACE ? `_${safe}` : safe;
}

function namespaceOf(ref: EntityRef): string {
  return [CLOSURE_ROOT_NAMESPACE, ...[ref.domain, ref.product, ref.entity].map(namespaceSegment)].join(".");
}

/** The (sanitized) names of the shared types a model declares: enums, scalars, unions, aliases, interfaces. */
function sharedTypeNames(model: SuperSchemaModel): Set<string> {
  const declared = new Set<string>();
  for (const group of [model.sharedEnums, model.customScalars, model.unionTypes, model.aliases, model.interfaces]) {
    for (const d of group ?? []) declared.add(sanitizeIdentifier(d.name));
  }
  return declared;
}

/**
 * Closure mode only: a shared type an entity declares (enum, scalar, union, alias, interface) whose name `mustPrefix` flags is
 * renamed `<modelName>_<name>`, and every use of it in the entity (field type, array element / map value, union name and members,
 * alias / union member text) follows, so two entities that each declare a shared `Status` stay distinct declarations and distinct
 * emitted file names. A name nothing else in the closure claims keeps its stand-alone name. Pure; the input model is not mutated.
 * The stand-alone path never calls this.
 */
function prefixSharedNames(model: SuperSchemaModel, modelName: string, mustPrefix: (name: string) => boolean): SuperSchemaModel {
  const declared = new Set([...sharedTypeNames(model)].filter(mustPrefix));
  if (declared.size === 0) return model;
  const rename = (name: string): string => (declared.has(sanitizeIdentifier(name)) ? `${modelName}_${sanitizeIdentifier(name)}` : name);
  // Free text (union members, alias targets) may mention a declared name inside an expression: replace whole identifiers.
  const renameInText = (text: string): string => text.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (word) => rename(word));
  const opt = (v: string | undefined) => (v === undefined ? undefined : rename(v));

  return {
    ...model,
    sharedEnums: model.sharedEnums?.map((d) => ({ ...d, name: rename(d.name) })),
    customScalars: model.customScalars?.map((d) => ({ ...d, name: rename(d.name), baseType: renameInText(d.baseType) })),
    unionTypes: model.unionTypes?.map((d) => ({ ...d, name: rename(d.name), memberTypes: d.memberTypes.map(renameInText) })),
    aliases: model.aliases?.map((d) => ({ ...d, name: rename(d.name), type: renameInText(d.type) })),
    interfaces: model.interfaces?.map((d) => ({ ...d, name: rename(d.name) })),
    fields: model.fields.map((f) => {
      const ct = f.complexType;
      return {
        ...f,
        type: rename(f.type) as SuperSchemaField["type"],
        ...(ct
          ? {
              complexType: {
                ...ct,
                ...(ct.arrayElementType !== undefined ? { arrayElementType: opt(ct.arrayElementType) } : {}),
                ...(ct.mapValueType !== undefined ? { mapValueType: opt(ct.mapValueType) } : {}),
                ...(ct.unionName !== undefined ? { unionName: opt(ct.unionName) } : {}),
                ...(ct.unionMembers !== undefined ? { unionMembers: ct.unionMembers.map(rename) } : {}),
              },
            }
          : {}),
      };
    }),
  };
}

type Placed = { entity: ClosureEntity; namespace: string; modelName: string };

const nameKey = (name: string) => name.trim().toLowerCase();
const idKey = (name: string) => sanitizeIdentifier(name.trim()).toLowerCase();

export type ClosureTypeSpec = {
  source: string;
  /** The root entity's model name (the stem of its `<Model>.json` / `<Model>.avsc`). */
  rootModel: string;
  /** entityId -> the model's fully qualified TypeSpec name (`SuperSchemaClosure.Domain.Product.Entity.Model`), in closure order. */
  models: Map<string, string>;
  /** What the generator could not express faithfully, across every member. */
  diagnostics: GeneratorDiagnostic[];
  /** entityId -> the namespace its block sits in (`SuperSchemaClosure.Domain.Product.Entity`; a merged group shares one). */
  namespaces: Map<string, string>;
  /**
   * entityId -> every top-level name its block declares (model, enums, unions, scalars, aliases, interfaces), in source order.
   * A target that names a file after a declaration (JSON Schema writes `<Name>.json` for each) maps the file back to its entity with this.
   */
  declarations: Map<string, string[]>;
  /** Reference fields typed `unknown` because their target is not part of the closure (one entry per entity and field). */
  unresolved: Array<{ entityId: string; fieldName: string; reference: string }>;
};

/** A top-level declaration line of an entity block, before the block is indented: `model Name {`, `enum Name {`, ... */
const DECLARATION = /^(?:model|enum|union|scalar|alias|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/;

/**
 * Generates the combined document. Root first, then the rest in closure order. `opts.target` adds the import a target
 * needs (`json-schema`); `opts.governance` (default false: the emission projection) keeps the governance overlay and the pin tag.
 * `opts.mergeNamespaces`: groups of entity ids whose blocks all sit in the namespace of the group's FIRST id (a target that
 * derives a package from the namespace, such as Protobuf, needs one namespace for a reference cycle). Each member keeps its
 * own block and unique model name; references are written against the shared namespace. An id that is not in the closure
 * is ignored, and so is a group of fewer than two members.
 */
export function generateClosureTypeSpec(
  closure: { entities: ClosureEntity[] },
  opts: { target: ClosureTarget; governance?: boolean; mergeNamespaces?: string[][] }
): ClosureTypeSpec {
  const governance = opts.governance === true;

  // Model names: the entity's own name, qualified only where two entities of the closure would share it (see closureModelNames);
  // then `_2`, `_3` ... for the same qualified name claimed twice. A .proto reference is written `Domain.Product.Entity.Message`
  // and protoc resolves its first component innermost scope first, so a message named like a domain would hide it: Protobuf
  // treats the domains of the closure as reserved names.
  const reserved = opts.target === "protobuf" ? new Set(closure.entities.map((e) => namespaceSegment(e.ref.domain))) : undefined;
  const baseNames = closureModelNames(closure.entities.map((e) => e.ref), reserved);
  const taken = new Set<string>();
  const placed: Placed[] = closure.entities.map((entity, i) => {
    const base = baseNames[i];
    let modelName = base;
    for (let n = 2; taken.has(modelName); n++) modelName = `${base}_${n}`;
    taken.add(modelName);
    return { entity, namespace: namespaceOf(entity.ref), modelName };
  });

  // A shared type keeps its stand-alone name unless another entity claims the name (a second entity declaring it, or a model of
  // the closure called that), or it is the reserved root: then the entity's model name is prefixed to it.
  const compiled = new Map(
    placed.map((p) => {
      const model = compileEntity(p.entity.entity, p.entity.fields);
      // A .proto message field cannot be a union: it is typed string there (the emission plan reports it, see closure-emit.ts).
      return [p, opts.target === "protobuf" ? withUnionFieldsAsString(model).model : model] as const;
    })
  );
  const sharedClaims = new Map<string, number>();
  for (const model of compiled.values()) for (const name of sharedTypeNames(model)) sharedClaims.set(name, (sharedClaims.get(name) ?? 0) + 1);
  const mustPrefix = (name: string): boolean =>
    (sharedClaims.get(name) ?? 0) > 1 || taken.has(name) || name === CLOSURE_ROOT_NAMESPACE || (reserved?.has(name) ?? false);
  for (const group of opts.mergeNamespaces ?? []) {
    const members = group.map((id) => placed.find((p) => p.entity.entityId === id)).filter((p): p is Placed => p !== undefined);
    if (members.length < 2) continue;
    for (const p of members) p.namespace = members[0].namespace;
  }

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
  const declarations = new Map<string, string[]>();
  const unresolved: ClosureTypeSpec["unresolved"] = [];
  for (const p of placed) {
    const model = prefixSharedNames(compiled.get(p) as SuperSchemaModel, p.modelName, mustPrefix);
    const reported = new Set<string>();
    const memberReferenceType = (field: SuperSchemaField): string | null => {
      const type = referenceType(field);
      const ref = field.complexType?.reference;
      if (type === null && ref && !reported.has(field.name)) {
        reported.add(field.name);
        unresolved.push({ entityId: p.entity.entityId, fieldName: field.name, reference: "legacyName" in ref ? ref.legacyName : qualifiedName(ref) });
      }
      return type;
    };
    const generated = generateTypeSpecWithDiagnostics(model, {
      governance,
      closureMember: { modelName: p.modelName, referenceType: memberReferenceType, enterpriseShadowed },
    });
    diagnostics.push(...generated.diagnostics);

    const lines = generated.source.replace(/\n$/, "").split("\n");
    let i = 0;
    while (i < lines.length && lines[i].startsWith("import ")) {
      if (!imports.includes(lines[i])) imports.push(lines[i]);
      i++;
    }
    const body = lines.slice(i).filter((l, idx, all) => !(idx === 0 && l === "") && !(idx === all.length - 1 && l === ""));
    declarations.set(
      p.entity.entityId,
      body.flatMap((l) => {
        const declared = DECLARATION.exec(l);
        return declared ? [declared[1]] : [];
      })
    );
    blocks.push([`namespace ${p.namespace} {`, ...body.map((l) => (l === "" ? "" : `  ${l}`)), "}"].join("\n"));
  }

  if (opts.target === "json-schema" && !imports.includes(JSON_SCHEMA_LIBRARY_IMPORT)) imports.push(JSON_SCHEMA_LIBRARY_IMPORT);

  const source = [...(imports.length > 0 ? [...imports, ""] : []), blocks.join("\n\n"), ""].join("\n");
  return {
    source,
    rootModel: placed[0]?.modelName ?? "",
    models: new Map(placed.map((p) => [p.entity.entityId, qualifiedModel(p)])),
    diagnostics,
    namespaces: new Map(placed.map((p) => [p.entity.entityId, p.namespace])),
    declarations,
    unresolved,
  };
}
