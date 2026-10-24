/**
 * Closure emission (multi-entity emission, Task 6): an entity plus everything it references, compiled once by the real
 * `tsp`, written as ONE FILE PER ENTITY on the five schema targets (JSON Schema, OpenAPI 3, Protobuf, Avro, Java POJO).
 *
 * How each target links the files (that format's own way):
 * - json-schema: no `bundleId`, so one `<Model>.json` per declaration, with native `$ref`s to the sibling files.
 * - openapi3: one `@service` namespace per entity, so one self-contained file per service; the entities a service refers to are
 *   inlined in its `components.schemas` (OpenAPI has no cross-file references).
 * - protobuf: one `@package` per entity from its qualified path (`Domain.Product.Entity`), `import`s between the `.proto`
 *   files. Imports must be acyclic, so the members of a reference cycle share ONE package (and file) and a warning says so.
 * - avro: each entity file is self-contained: first use of a referenced record inline, later or recursive use by full name.
 * - java-pojo: one class per entity under its package directory, `import`ed across packages.
 *
 * The closure source (closure-source.ts) puts every entity under the reserved root `SuperSchemaClosure`. That root is an
 * implementation detail and must not reach the output: Avro and Java are told to drop it (`strip-namespace-root`), Protobuf
 * packages are written explicitly, OpenAPI service names and schema names are written explicitly (`@service` title,
 * `@friendlyName`), and the OpenAPI file names are rewritten without it.
 *
 * A STAND-ALONE entity (a closure of one, no reference cycle) keeps today's package, options and content: it is generated from
 * the unchanged stand-alone source (`buildSourceForTarget`), not from the closure source. Only the file layout differs from
 * before (JSON Schema is no longer one bundle).
 *
 * Deterministic: same closure, same files in the same order (sorted by path, code-unit order). Never throws: every failure is a
 * `Result` error. The pin tag (`x-super-schema-pin`) is part of the governance overlay, which closure emission leaves off, so it
 * never reaches a target.
 */

import { compileEntity, type PrismaEntityInput, type PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { CLOSURE_ROOT_NAMESPACE, generateClosureTypeSpec, type ClosureTypeSpec } from "@/lib/compiler/closure-source";
import { DEFAULT_MAX_CLOSURE_ENTITIES, type ReferenceClosure } from "@/lib/references/closure";
import { TENANT_PLACEHOLDER, qualifiedName, type EntityRef } from "@/lib/references/entity-reference";
import type { TargetId } from "@/lib/schema-targets/catalog";
import type { SuperSchemaModel } from "@/types/super-schema-model";
import { err, ok, type Result, type ServiceError } from "@/types/result";
import { isDbTypeSpecTarget } from "./db-source";
import { describeNameCollision, findNameCollisions } from "./name-collisions";
import { describeAvroProjection, describeInvalidAvroSymbols, findInvalidAvroSymbols, projectTypeSpecSourceForAvro } from "./avro-source";
import { projectTypeSpecSourceForProtobuf } from "./protobuf-source";
import {
  buildEmitterOptions,
  buildSourceForTarget,
  bundleGeneratedFiles,
  danglingReferenceWarnings,
  emitterFailureMessage,
  escapeTypeSpecString,
  findOverlongName,
  injectProtobufFieldNumbers,
  overlongNameMessage,
  resolveEmittableTarget,
  runTypeSpecEmitterWithWarnings,
  splitLeadingImports,
  unusableOutputReason,
} from "./emitter.service";

export type { TargetId };

/** One generated file of a closure emission: where it goes, what it holds, which target wrote it and (when known) for which entity. */
export type EmittedFile = { path: string; content: string; target: TargetId; entityId?: string };

export type ClosureEmission = { files: EmittedFile[]; warnings: string[] };

/** What emission needs of a closure; a `ReferenceClosure` (from `loadReferenceClosure`) is one. */
export type Closure = Pick<ReferenceClosure, "entities" | "cycles"> & Partial<Pick<ReferenceClosure, "root" | "draftEntities">>;

/** The closure of one entity that references nothing: what the stand-alone emission entry points are built on. */
export function standaloneClosure(entity: PrismaEntityInput, fields: PrismaFieldInput[]): Closure {
  const ref: EntityRef = {
    entityId: entity.id,
    domain: entity.domain?.name ?? TENANT_PLACEHOLDER,
    product: TENANT_PLACEHOLDER,
    entity: entity.name,
  };
  const member = { entityId: entity.id, ref, source: "draft" as const, fields, entity };
  return { root: member, entities: [member], draftEntities: [], cycles: [] };
}

/** The bundled `===== path =====` string of a file list (a single file is its bare content): `SchemaVersion.output`. */
export function bundleEmittedFiles(files: ReadonlyArray<Pick<EmittedFile, "path" | "content">>): string {
  return bundleGeneratedFiles(files.map((file) => ({ relativePath: file.path, content: file.content })));
}

/** The files written for one entity, in path order. */
export function filesForEntity(files: readonly EmittedFile[], entityId: string): EmittedFile[] {
  return files.filter((file) => file.entityId === entityId);
}

/** Where a file goes and which entity it belongs to; `null` drops a file that is not part of the closure. */
type Attribution = { entityId?: string; path?: string } | null;

interface Plan {
  source: string;
  options: Record<string, unknown>;
  warnings: string[];
  errors: string[];
  attribute: (file: { path: string; content: string }) => Attribution;
  /** Checks the finished file list; returns what is wrong with it, if anything. */
  verify?: (files: EmittedFile[]) => string[];
}

type Place = {
  entityId: string;
  entityName: string;
  model: SuperSchemaModel;
  /** The block's namespace (`SuperSchemaClosure.Domain.Product.Entity`). */
  namespace: string;
  modelName: string;
};

const invalid = (errors: string[], warnings: string[] = []): Result<never> =>
  err({ code: "EMISSION_INVALID", message: errors.join("\n"), details: { errors, warnings } });

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Emits the closure for one schema target: every entity's file, sorted by path, plus the warnings (what a projection changed,
 * a reference that could not be typed, a cycle that had to share a package). Stand-alone entities keep today's content.
 */
export async function emitClosure(closure: Closure, targetKey: TargetId): Promise<Result<ClosureEmission, ServiceError>> {
  const resolved = resolveEmittableTarget(targetKey);
  if ("error" in resolved) return err({ code: "UNSUPPORTED_TARGET", message: resolved.error });
  const target = resolved.target;
  if (!target.closureEmission || isDbTypeSpecTarget(target.key)) {
    return err({
      code: "UNSUPPORTED_TARGET",
      message: `Closure emission does not apply to "${target.displayName}": a reference stays a plain column there, so emit the entity on its own.`,
    });
  }
  const entities = closure.entities;
  if (entities.length === 0) return err({ code: "EMPTY_CLOSURE", message: "The closure has no entity to emit." });
  if (entities.length > DEFAULT_MAX_CLOSURE_ENTITIES) {
    return err({ code: "CLOSURE_TOO_LARGE", message: `The closure has ${entities.length} entities; at most ${DEFAULT_MAX_CLOSURE_ENTITIES} can be emitted at once.`, details: { limit: DEFAULT_MAX_CLOSURE_ENTITIES } });
  }

  const key = target.key;
  const multi = entities.length > 1;
  const models = entities.map((e) => compileEntity(e.entity, e.fields));
  const label = (i: number): string => {
    if (!multi) return "";
    const name = entities[i].entity.name;
    return `${name.length > 40 ? `${name.slice(0, 40)}...` : name}: `;
  };

  // A name that already exists in the database may be too long for the emitters (they write a file per declaration and crash
  // with ENAMETOOLONG): say so instead.
  const overlong = models.flatMap((model, i) => {
    const name = findOverlongName(model);
    return name === undefined ? [] : [`${label(i)}${overlongNameMessage(name)}`];
  });
  if (overlong.length > 0) return invalid(overlong);
  // Names that this target rewrites into the same identifier would give an invalid schema: refuse, naming them.
  const collisions = models.flatMap((model, i) => findNameCollisions(model, key).map((c) => `${label(i)}${describeNameCollision(c, key)}`));
  if (collisions.length > 0) return invalid(collisions);

  const standalone = entities.length === 1 && closure.cycles.length === 0;
  const plan = standalone ? standalonePlan(closure, models[0], key) : combinedPlan(closure, models, key);
  if (plan.errors.length > 0) return invalid(plan.errors, plan.warnings);

  const packageName = target.packageName ?? "";
  const run = await runTypeSpecEmitterWithWarnings(packageName, plan.source, plan.options);
  if (!run.success) {
    return err({ code: run.error.code, message: emitterFailureMessage(packageName, run.error), details: { ...(run.error.details ?? {}), warnings: plan.warnings } });
  }

  const files: EmittedFile[] = [];
  for (const raw of run.data.files) {
    const path = raw.relativePath.split(/[\\/]/).join("/");
    const attribution = plan.attribute({ path, content: raw.content });
    if (attribution === null) continue;
    files.push({
      path: attribution.path ?? path,
      content: raw.content,
      target: key,
      ...(attribution.entityId !== undefined ? { entityId: attribution.entityId } : {}),
    });
  }
  files.sort((a, b) => compareCodeUnits(a.path, b.path));
  if (files.length === 0) return err({ code: "EMITTER_NO_OUTPUT", message: `Emitter "${packageName}" completed but wrote no file for this closure.`, details: { warnings: plan.warnings } });

  const problems = [...(plan.verify?.(files) ?? []), ...verifyTargetOutput(key, files)];
  if (problems.length > 0) return invalid(problems, plan.warnings);
  return ok({ files, warnings: plan.warnings });
}

/** Checks every target makes of what the emitter wrote (the safety nets behind the source projections). */
function verifyTargetOutput(key: string, files: EmittedFile[]): string[] {
  if (key !== "avro") return [];
  // Behind the Avro projection: a symbol it could not fix (a numeric-valued member) must fail here, naming the enum.
  return describeInvalidAvroSymbols(files.flatMap((file) => findInvalidAvroSymbols(parseJsonOrNull(file.content))));
}

function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stand-alone: a closure of one entity, today's source and options
// ---------------------------------------------------------------------------

function standalonePlan(closure: Closure, model: SuperSchemaModel, key: string): Plan {
  const built = buildSourceForTarget(model, key);
  const warnings = [...built.warnings, ...danglingReferenceWarnings(model, key)];
  const entityId = closure.entities[0].entityId;
  return {
    source: built.source,
    options: buildEmitterOptions(key, "entity"),
    warnings,
    errors: built.errors,
    attribute: () => ({ entityId }),
    verify:
      key === "protobuf"
        ? (files) => {
            const unusable = unusableOutputReason("@typespec/protobuf", bundleEmittedFiles(files));
            return unusable ? [unusable] : [];
          }
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// Combined: one program for the whole closure
// ---------------------------------------------------------------------------

function combinedPlan(closure: Closure, models: SuperSchemaModel[], key: string): Plan {
  const entities = closure.entities;
  const multi = entities.length > 1;
  const errors: string[] = [];
  models.forEach((model, i) => {
    const owner = entities[i].entity.name;
    // `extends` / spread of another model are written as bare, unqualified names, which cannot name a model in another entity's
    // namespace. The Prisma path (`compileEntity`) never populates them, so no closure member has one today; refuse rather than
    // emit a source that does not compile or, worse, binds to the wrong model.
    if (model.entity.parentEntityName || (model.entity.spreadFrom?.length ?? 0) > 0) {
      errors.push(`${owner}: "extends" and spread of another model are not supported in a multi-entity closure (their names cannot be qualified across entities); remove the inheritance.`);
    }
    // Operation parameter and response types are free text naming models by their bare names. In the closure every entity
    // sits in a namespace called like the entity, so a bare `Order` resolves to that NAMESPACE and the type silently becomes
    // `{}` in the output (the compile still succeeds). Text cannot be qualified safely (`string` may be an entity name too), so refuse.
    for (const iface of model.interfaces ?? []) {
      if (iface.operations.length > 0) {
        errors.push(`${owner}: interface "${iface.name}" has operations, which are not supported in a multi-entity closure (the model names in their types cannot be qualified across entities); remove the operations or the references.`);
      }
    }
  });
  if (errors.length > 0) return { source: "", options: {}, warnings: [], errors, attribute: () => null };

  const groups = cycleGroups(closure);
  const generated = generateClosureTypeSpec(closure, { target: key, ...(key === "protobuf" ? { mergeNamespaces: groups } : {}) });

  const places: Place[] = [];
  entities.forEach((entity, i) => {
    const qualified = generated.models.get(entity.entityId);
    if (qualified === undefined) return;
    const dot = qualified.lastIndexOf(".");
    places.push({ entityId: entity.entityId, entityName: entity.entity.name, model: models[i], namespace: qualified.slice(0, dot), modelName: qualified.slice(dot + 1) });
  });

  const warnings: string[] = [];
  entities.forEach((entity, i) => {
    const prefix = multi ? `${entity.entity.name}: ` : "";
    warnings.push(...danglingReferenceWarnings(models[i], key).map((w) => `${prefix}${w}`));
  });
  for (const u of generated.unresolved) {
    const owner = entities.find((e) => e.entityId === u.entityId)?.entity.name ?? u.entityId;
    warnings.push(`${owner}: Field "${u.fieldName}" references ${u.reference}, which is not part of this schema set; the field is emitted untyped.`);
  }

  const base = { warnings, errors, options: buildEmitterOptions(key, "closure") };
  switch (key) {
    case "json-schema":
      return { ...base, ...jsonSchemaPlan(generated) };
    case "openapi3":
      return { ...base, ...openApiPlan(generated, places) };
    case "protobuf": {
      const proto = protobufPlan(generated, places, groups, closure);
      warnings.push(...proto.warnings);
      return { ...base, source: proto.source, attribute: proto.attribute, verify: proto.verify };
    }
    case "avro": {
      const projection = projectTypeSpecSourceForAvro(generated.source);
      const described = describeAvroProjection(projection);
      warnings.push(...described.warnings);
      errors.push(...described.errors);
      return { ...base, source: projection.source, attribute: namespaceAttribution(places, avroNamespaceOf) };
    }
    default:
      return { ...base, source: generated.source, attribute: namespaceAttribution(places, javaDirectoryOf) };
  }
}

/** Entity ids of each reference cycle with more than one member, in the order the closure lists them (sorted by qualified name). */
function cycleGroups(closure: Closure): string[][] {
  const byLabel = new Map<string, string[]>();
  for (const e of closure.entities) {
    const label = qualifiedName(e.ref);
    byLabel.set(label, [...(byLabel.get(label) ?? []), e.entityId]);
  }
  return closure.cycles.filter((group) => group.length > 1).map((group) => [...new Set(group.flatMap((label) => byLabel.get(label) ?? []))]);
}

const stripRoot = (namespace: string): string =>
  namespace.startsWith(`${CLOSURE_ROOT_NAMESPACE}.`) ? namespace.slice(CLOSURE_ROOT_NAMESPACE.length + 1) : namespace;

/** The first place of each namespace (the entity a namespace-level file is attributed to). */
function firstByNamespace(places: Place[]): Map<string, Place> {
  const first = new Map<string, Place>();
  for (const p of places) if (!first.has(p.namespace)) first.set(p.namespace, p);
  return first;
}

/**
 * Puts `decorators(namespace)` in front of the first `namespace X {` block of every namespace, and `declaration(name)` in front of
 * every top-level `model` / `enum` / `union` / `scalar` of the closure source (blocks are written at column 0, their declarations
 * at two spaces, by `generateClosureTypeSpec`).
 */
function decorateBlocks(source: string, decorators: (namespace: string) => string[], declaration?: (name: string) => string | null): string {
  const out: string[] = [];
  const decorated = new Set<string>();
  for (const line of source.split("\n")) {
    const namespace = /^namespace (\S+) \{$/.exec(line)?.[1];
    if (namespace !== undefined) {
      if (!decorated.has(namespace)) {
        decorated.add(namespace);
        out.push(...decorators(namespace));
      }
      out.push(line);
      continue;
    }
    const declared = declaration ? /^  (?:model|enum|union|scalar) ([A-Za-z_][A-Za-z0-9_]*)/.exec(line)?.[1] : undefined;
    const prefix = declared !== undefined && declaration ? declaration(declared) : null;
    if (prefix !== null) out.push(prefix);
    out.push(line);
  }
  return out.join("\n");
}

// JSON Schema ----------------------------------------------------------------

function jsonSchemaPlan(generated: ClosureTypeSpec): Pick<Plan, "source" | "attribute"> {
  // One `<Name>.json` per declaration: the model and each enum / union / scalar its block declares.
  const owner = new Map<string, string>();
  for (const [entityId, names] of generated.declarations) for (const name of names) if (!owner.has(name)) owner.set(name, entityId);
  return {
    source: generated.source,
    attribute: (file) => {
      const entityId = owner.get((file.path.split("/").pop() ?? file.path).replace(/\.json$/, ""));
      return entityId === undefined ? null : { entityId };
    },
  };
}

// OpenAPI 3 ------------------------------------------------------------------

function openApiPlan(generated: ClosureTypeSpec, places: Place[]): Pick<Plan, "source" | "attribute"> {
  const first = firstByNamespace(places);
  // `@service` makes each entity's namespace its own document. `@friendlyName` names every schema by its declaration, because
  // a schema from another namespace would otherwise be keyed by its namespace-qualified name (root segment included).
  const decorated = decorateBlocks(
    generated.source,
    (namespace) => [`@service(#{ title: "${escapeTypeSpecString(first.get(namespace)?.entityName ?? stripRoot(namespace))}" })`],
    (name) => `  @friendlyName("${name}")`
  );
  const { imports, rest } = splitLeadingImports(decorated);
  // @typespec/rest is deliberately NOT imported (see buildOpenApi3Source): nothing here uses a rest decorator.
  const source = ['import "@typespec/http";', 'import "@typespec/openapi3";', ...imports, "using TypeSpec.Http;", "", rest, ""].join("\n");

  return {
    source,
    attribute: (file) => {
      const named = /^openapi(?:\.(.+))?\.(yaml|json)$/.exec(file.path);
      if (!named) return null;
      // One service: the emitter writes `openapi.yaml`. Several: `openapi.<namespace>.yaml`; the namespace names the entity.
      const namespace = named[1];
      if (namespace === undefined) {
        const only = places[0];
        return only ? { entityId: only.entityId } : null;
      }
      const place = first.get(namespace);
      return place ? { entityId: place.entityId, path: `openapi.${stripRoot(namespace)}.${named[2]}` } : null;
    },
  };
}

// Protobuf -------------------------------------------------------------------

function protobufPlan(
  generated: ClosureTypeSpec,
  places: Place[],
  groups: string[][],
  closure: Closure
): { source: string; warnings: string[]; attribute: Plan["attribute"]; verify: NonNullable<Plan["verify"]> } {
  // The canonical source uses stdlib scalars, `Record<...>` and value-less enums the emitter rejects: project it (as stand-alone
  // does), then number every entity's fields.
  let body = projectTypeSpecSourceForProtobuf(generated.source);
  for (const p of places) body = injectProtobufFieldNumbers(body, p.modelName, p.model.fields);

  const first = firstByNamespace(places);
  const packageOf = (namespace: string): string => stripRoot(namespace);
  const decorated = decorateBlocks(body, (namespace) => [`@package({ name: "${packageOf(namespace)}" })`]);
  const { imports, rest } = splitLeadingImports(decorated);
  const source = ['import "@typespec/protobuf";', ...imports, "using TypeSpec.Protobuf;", "", rest, ""].join("\n");

  const warnings = groups.map((group) => {
    const names = group.map((id) => closure.entities.find((e) => e.entityId === id)).filter((e): e is NonNullable<typeof e> => e !== undefined).map((e) => qualifiedName(e.ref));
    const shared = packageOf(generated.namespaces.get(group[0]) ?? "");
    return `${names.join(", ")} reference each other; Protobuf imports must be acyclic, so they share the package "${shared}" and one .proto file.`;
  });

  const pathOf = (namespace: string): string => `${packageOf(namespace).split(".").join("/")}.proto`;
  const byPath = new Map([...first].map(([namespace, place]) => [pathOf(namespace), place]));
  return {
    source,
    warnings,
    attribute: (file) => {
      const place = byPath.get(file.path);
      return place ? { entityId: place.entityId } : {};
    },
    // The protobuf emitter silently drops a message whose fields lack `@field(n)` and then writes no file (or only the syntax line).
    verify: (files) =>
      [...byPath].flatMap(([path, place]) => {
        const written = files.find((f) => f.path === path);
        return written && /^\s*message\s+\S+\s*\{/m.test(written.content)
          ? []
          : [`The protobuf emitter wrote no message for ${place.entityName}: none of its fields received a @field(n) number, so it dropped the whole message.`];
      }),
  };
}

// Avro and Java ----------------------------------------------------------------

const normalizeSegment = (segment: string): string => segment.toLowerCase().replace(/[^a-z0-9]/g, "");
const normalizePath = (dotted: string): string => dotted.split(".").map(normalizeSegment).join(".");

/** `a.b.c.Name.avsc.json` -> the namespace `a.b.c` (a flat file name qualified by its namespace). */
function avroNamespaceOf(path: string): string | null {
  const name = (path.split("/").pop() ?? path).replace(/\.avsc(?:\.json)?$/, "");
  const dot = name.lastIndexOf(".");
  return dot < 0 ? null : name.slice(0, dot);
}

/** `sales/orders/order/SalesOrdersOrder.java` -> `sales.orders.order`. */
function javaDirectoryOf(path: string): string | null {
  const dirs = path.split("/").slice(0, -1);
  return dirs.length === 0 ? null : dirs.join(".");
}

/**
 * Maps a file to the entity whose qualified path (`domain.product.entity`) its namespace / package directory ends with, comparing
 * lowercase alphanumerics only (the emitters lowercase and sanitize the segments themselves). A file that matches no entity is
 * kept without an entity.
 */
function namespaceAttribution(places: Place[], namespaceOfFile: (path: string) => string | null): Plan["attribute"] {
  const keyed = [...firstByNamespace(places).values()].map((place) => ({ place, key: normalizePath(stripRoot(place.namespace)) }));
  return (file) => {
    const namespace = namespaceOfFile(file.path);
    if (namespace === null) return {};
    const normalized = normalizePath(namespace);
    const match = keyed.find(({ key }) => normalized === key || normalized.endsWith(`.${key}`));
    return match ? { entityId: match.place.entityId } : {};
  };
}
