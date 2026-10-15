import "server-only";

/**
 * TypeSpec import via the real @typespec/compiler (semantic AST), replacing the
 * regex parser for the import path. Produces the same `ParsedTypeSpecDocument`
 * shape the importer already maps to `TypeSpecImportResult`.
 *
 * Server-only: `@typespec/compiler` is an async, Node-only ESM package (uses the
 * filesystem host). It must never be bundled into the client — the `server-only`
 * import above enforces that. The regex parser (typespec-parser.ts) still powers
 * client-side live-typing hints.
 */

import {
  compile,
  navigateProgram,
  getSourceLocation,
  type CompilerHost,
  type Program,
  type Model,
  type ModelProperty,
  type Enum,
  type Scalar,
  type Union,
  type Interface,
  type Operation,
  type Type,
  type Namespace,
  type Diagnostic,
  type LinterRuleSet,
} from "@typespec/compiler";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { mapTypeSpecType } from "./typespec-parser";
import { createLibraryOnlyHost } from "./library-only-host";
import { assertTypeSpecImportsAllowed, TypeSpecImportGuardError } from "@/lib/typespec/import-guard";
import * as gov from "@superschema/typespec-enterprise";
import {
  CLASSIFICATION_EXTENSION_KEY,
  TAGS_EXTENSION_KEY,
  classificationFromEnterpriseMember,
} from "./governance-decorators";
import type {
  ParsedTypeSpecDocument,
  ParsedTypeSpecModel,
  ParsedTypeSpecField,
  ParsedTypeSpecDecorators,
  ParsedTypeSpecEnum,
  ParsedTypeSpecScalar,
  ParsedTypeSpecUnion,
  ParsedTypeSpecInterface,
  ParsedTypeSpecOperation,
} from "./typespec-parser";

// ---------------------------------------------------------------------------
// Compile a source string in a throwaway temp dir.
//
// MUST be inside the project tree, not the OS tmpdir: @typespec/compiler
// resolves `import "some-package"` statements via normal Node module
// resolution starting from the file being compiled. A directory under
// os.tmpdir() has no node_modules in its parent chain, so any non-stdlib
// library import (including this project's own governance decorator
// package, @superschema/typespec-enterprise) fails with "Couldn't resolve
// import" — confirmed directly during the 2026-10-12 architecture work.
// Compiling under <project>/.typespec-work instead gives it the project's
// real node_modules to resolve against.
//
// Security (finding C-C1): `compile` LOADS what a source imports, and a `.js` / `.mjs` import is EXECUTED inside
// this (Next server) process. `compileSource` is the only caller of `compile` and every public entry point below
// goes through it (Source-tab save, publish gate, TypeSpec / OpenAPI import, migration), so both layers sit here:
//   1. `assertTypeSpecImportsAllowed` - TypeSpec's own parser decides what the source imports; anything but an
//      allowed library (`@typespec/*`, `@superschema/typespec-enterprise`) throws `TypeSpecImportGuardError`
//      BEFORE a temp dir is created or `compile` is called;
//   2. `createLibraryOnlyHost` - even if (1) were ever bypassed, JavaScript only loads from installed libraries.
// ---------------------------------------------------------------------------

const WORK_DIR = join(process.cwd(), ".typespec-work");

let sharedHost: CompilerHost | undefined;
const libraryOnlyHost = (): CompilerHost => (sharedHost ??= createLibraryOnlyHost());

async function compileSource(
  source: string,
  options?: { linterRuleSet?: LinterRuleSet }
): Promise<{ program: Program; mainPath: string }> {
  const { text } = assertTypeSpecImportsAllowed(source);
  await mkdir(WORK_DIR, { recursive: true });
  const dir = await mkdtemp(join(WORK_DIR, "job-"));
  const mainPath = join(dir, "main.tsp");
  await writeFile(mainPath, text, "utf8");
  try {
    const program = await compile(libraryOnlyHost(), mainPath, {
      noEmit: true,
      ...(options?.linterRuleSet ? { linterRuleSet: options.linterRuleSet } : {}),
    });
    return { program, mainPath };
  } finally {
    // Best-effort cleanup; the program is already in memory.
    void rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}


/** Keep only types declared in the pasted source (exclude the TypeSpec std lib). */
function isFromSource(type: Type, mainPath: string): boolean {
  const node = (type as { node?: unknown }).node;
  if (!node) return false;
  try {
    const loc = getSourceLocation(node as Parameters<typeof getSourceLocation>[0]);
    return loc?.file?.path === mainPath;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Type → our logical type string
// ---------------------------------------------------------------------------

function elementName(type: Type | undefined): string {
  if (!type) return "string";
  if (type.kind === "Scalar") return (type as Scalar).name;
  if (type.kind === "Model") return (type as Model).name || "object";
  if (type.kind === "Enum") return (type as Enum).name;
  return "string";
}

function mapPropertyType(type: Type): { type: string; arrayElementType?: string } {
  switch (type.kind) {
    case "Scalar":
      return { type: mapTypeSpecType((type as Scalar).name).type };
    case "Model": {
      const m = type as Model;
      if (m.name === "Array") {
        const el = elementName(m.indexer?.value);
        return { type: "array", arrayElementType: mapTypeSpecType(el).type };
      }
      if (m.name === "Record") return { type: "map" };
      // A reference to another declared model.
      return { type: m.name || "object" };
    }
    case "Enum":
      return { type: (type as Enum).name };
    case "Union": {
      const u = type as Union;
      const members = [...u.variants.values()].map((v) => elementName(v.type));
      return { type: members.join(" | ") };
    }
    case "EnumMember":
    case "Number":
    case "String":
    case "Boolean":
      return { type: "string" };
    default:
      return { type: "string" };
  }
}

// ---------------------------------------------------------------------------
// Decorators — read from the AST (syntactic).
//
// The TypeSpec std-lib decorator *implementations* don't load in the Next server
// runtime, so semantic getters (getDoc/getKey/getFormat/…) return nothing there.
// The AST always carries decorators as written, so we extract everything from it.
// ---------------------------------------------------------------------------

function readDecorators(type: Type): ParsedTypeSpecDecorators {
  const d: ParsedTypeSpecDecorators = {};
  for (const { name, args } of readAstDecorators(type)) {
    const a0 = args[0];
    const s0 = typeof a0 === "string" ? a0 : undefined;
    const n0 = typeof a0 === "number" ? a0 : undefined;
    switch (name) {
      case "doc": if (s0) d.doc = s0; break;
      case "summary": if (s0) d.summary = s0; break;
      case "format": if (s0) d.format = s0; break;
      case "pattern": if (s0) d.pattern = s0; break;
      case "minLength": if (n0 !== undefined) d.minLength = n0; break;
      case "maxLength": if (n0 !== undefined) d.maxLength = n0; break;
      case "minValue": if (n0 !== undefined) d.minValue = n0; break;
      case "maxValue": if (n0 !== undefined) d.maxValue = n0; break;
      case "minValueExclusive": if (n0 !== undefined) d.minValueExclusive = n0; break;
      case "maxValueExclusive": if (n0 !== undefined) d.maxValueExclusive = n0; break;
      case "minItems": if (n0 !== undefined) d.minItems = n0; break;
      case "maxItems": if (n0 !== undefined) d.maxItems = n0; break;
      case "encode":
        if (s0) {
          d.encode = s0;
          if (typeof args[1] === "string") d.encodeSubType = args[1];
        }
        break;
      case "secret": d.secret = true; break;
      case "tag": if (s0) d.tag = s0; break;
      // Story 16.6 classification: the governance enum member, mapped back to the app's level.
      case "dataClassification": {
        const level = classificationFromEnterpriseMember(s0);
        if (level) d.classification = level;
        break;
      }
      case "deprecated": d.deprecated = s0 ?? ""; break;
      case "discriminator": if (s0) d.discriminator = s0; break;
      case "error": d.error = true; break;
      case "friendlyName": if (s0) d.friendlyName = s0; break;
      case "visibility": {
        // @visibility(Lifecycle.Read, Lifecycle.Create) → ["Read", "Create"]
        const phases = args
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.split(".").pop() as string);
        if (phases.length > 0) d.visibility = phases;
        break;
      }
      case "extension":
        // Story 16.6 overlay keys are consumed, not kept as generic extensions: x-classification is the
        // level of a field with no Enterprise member; x-tags (model tags) is read by modelTags().
        if (s0 === CLASSIFICATION_EXTENSION_KEY) {
          if (typeof args[1] === "string") d.classification = args[1];
          break;
        }
        if (s0 === TAGS_EXTENSION_KEY) break;
        // @extension("x-key", value) → { "x-key": "value" }
        if (s0) d.extensions = { ...(d.extensions ?? {}), [s0]: String(args[1] ?? "") };
        break;
    }
  }
  return d;
}

/** True when the AST shows an @key decorator on this type. */
function hasKeyDecorator(type: Type): boolean {
  return readAstDecorators(type).some((x) => x.name === "key");
}

/** Resolve a decorator-argument AST node to a literal or dotted reference name. */
function exprToArgValue(node: unknown): string | number | boolean | undefined {
  const n = node as {
    value?: unknown;
    target?: unknown;
    base?: { sv?: string; id?: { sv?: string } };
    id?: { sv?: string };
    sv?: string;
  };
  if (n && "value" in n && typeof n.value !== "object") {
    return n.value as string | number | boolean;
  }
  // TypeReference wraps the identifier/member in `.target`.
  const ref = (n?.target as typeof n) ?? n;
  if (!ref) return undefined;
  if (ref.base) {
    const base = ref.base.sv ?? ref.base.id?.sv;
    const id = ref.id?.sv;
    return base && id ? `${base}.${id}` : (id ?? base);
  }
  return ref.sv ?? ref.id?.sv;
}

/** String elements of a value tuple argument (`#["a", "b"]`), or [] for anything else. */
function exprToStringArray(node: unknown): string[] {
  const values = (node as { values?: unknown[] } | undefined)?.values;
  if (!Array.isArray(values)) return [];
  return values.map(exprToArgValue).filter((v): v is string => typeof v === "string");
}

/**
 * Model tags in source order: the `x-tags` extension (Story 16.6) and legacy `@tag("...")` lines (stored
 * pre-16.6 sources; invalid on a model, but this import reader ignores diagnostics and the AST keeps them).
 */
function modelTags(type: Type): string[] | undefined {
  const tags: string[] = [];
  for (const { name, args, rawArgs } of readAstDecorators(type)) {
    if (name === "tag" && typeof args[0] === "string") tags.push(args[0]);
    if (name === "extension" && args[0] === TAGS_EXTENSION_KEY) tags.push(...exprToStringArray(rawArgs[1]));
  }
  return tags.length > 0 ? tags : undefined;
}

/**
 * Read decorator names + resolved args directly from a type's AST node. `rawArgs` keeps the argument
 * nodes for values `exprToArgValue` does not flatten (e.g. a value tuple).
 */
function readAstDecorators(
  type: Type
): Array<{ name: string; args: Array<string | number | boolean | undefined>; rawArgs: unknown[] }> {
  const node = (type as { node?: { decorators?: unknown[] } }).node;
  const out: Array<{ name: string; args: Array<string | number | boolean | undefined>; rawArgs: unknown[] }> = [];
  for (const raw of node?.decorators ?? []) {
    const deco = raw as {
      target?: { sv?: string; id?: { sv?: string } };
      arguments?: unknown[];
    };
    const name = (deco.target?.sv ?? deco.target?.id?.sv ?? "").replace(/^@/, "");
    if (!name) continue;
    const rawArgs = deco.arguments ?? [];
    out.push({ name, args: rawArgs.map(exprToArgValue), rawArgs });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

function extractField(program: Program, prop: ModelProperty): ParsedTypeSpecField {
  const mapped = mapPropertyType(prop.type);
  return {
    name: prop.name,
    type: mapped.type,
    arrayElementType: mapped.arrayElementType,
    isOptional: prop.optional,
    isKey: hasKeyDecorator(prop),
    decorators: readDecorators(prop),
    defaultValue: undefined,
  };
}

function extractModel(program: Program, model: Model): ParsedTypeSpecModel {
  const fields: ParsedTypeSpecField[] = [];
  for (const [, prop] of model.properties) {
    fields.push(extractField(program, prop));
  }
  const decorators = readDecorators(model);
  return {
    name: model.name,
    doc: decorators.doc,
    fields,
    extends: model.baseModel?.name,
    isError: decorators.error,
    friendlyName: decorators.friendlyName,
    tags: modelTags(model),
    discriminator: decorators.discriminator,
  };
}

function namespaceName(ns: Namespace | undefined): string | undefined {
  const parts: string[] = [];
  let cur = ns;
  while (cur && cur.name) {
    if (cur.name === "TypeSpec") return undefined;
    parts.unshift(cur.name);
    cur = cur.namespace;
  }
  return parts.length > 0 ? parts.join(".") : undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function compileTypeSpecDocument(source: string): Promise<ParsedTypeSpecDocument> {
  const { program, mainPath } = await compileSource(source);
  return compileTypeSpecDocumentFromProgram(program, mainPath);
}

function compileTypeSpecDocumentFromProgram(program: Program, mainPath: string): ParsedTypeSpecDocument {
  const models: ParsedTypeSpecModel[] = [];
  const enums: ParsedTypeSpecEnum[] = [];
  const scalars: ParsedTypeSpecScalar[] = [];
  const unions: ParsedTypeSpecUnion[] = [];
  const interfaces: ParsedTypeSpecInterface[] = [];
  const operations: ParsedTypeSpecOperation[] = [];
  let namespace: string | undefined;

  const opInInterface = new Set<Operation>();

  navigateProgram(program, {
    model(m) {
      if (!isFromSource(m, mainPath)) return;
      if (m.name === "Array" || m.name === "Record" || !m.name) return;
      namespace = namespace ?? namespaceName(m.namespace);
      models.push(extractModel(program, m));
    },
    enum(e: Enum) {
      if (!isFromSource(e, mainPath)) return;
      const decorators = readDecorators(e);
      enums.push({
        name: e.name,
        doc: decorators.doc,
        values: [...e.members.values()].map((mem) => mem.name),
      });
    },
    scalar(s: Scalar) {
      if (!isFromSource(s, mainPath)) return;
      const decorators = readDecorators(s);
      scalars.push({
        name: s.name,
        doc: decorators.doc,
        baseType: s.baseScalar?.name ?? "string",
        format: decorators.format,
        pattern: decorators.pattern,
      });
    },
    union(u: Union) {
      if (!u.name || !isFromSource(u, mainPath)) return;
      const decorators = readDecorators(u);
      unions.push({
        name: u.name,
        doc: decorators.doc,
        memberTypes: [...u.variants.values()].map((v) => elementName(v.type)),
      });
    },
    interface(i: Interface) {
      if (!isFromSource(i, mainPath)) return;
      const ops: ParsedTypeSpecOperation[] = [];
      for (const [, op] of i.operations) {
        opInInterface.add(op);
        ops.push(extractOperation(program, op));
      }
      interfaces.push({
        name: i.name,
        doc: readDecorators(i).doc,
        operations: ops,
      });
    },
    operation(op: Operation) {
      if (!isFromSource(op, mainPath) || opInInterface.has(op)) return;
      operations.push(extractOperation(program, op));
    },
  });

  return {
    namespace,
    usings: [],
    imports: [],
    models,
    enums,
    scalars,
    unions,
    aliases: [],
    decorators: [],
    operations,
    interfaces,
    consts: [],
  };
}

function extractOperation(program: Program, op: Operation): ParsedTypeSpecOperation {
  const params: ParsedTypeSpecOperation["params"] = [];
  for (const [, p] of op.parameters.properties) {
    params.push({
      name: p.name,
      type: mapPropertyType(p.type).type,
      isOptional: p.optional,
    });
  }
  return {
    name: op.name,
    doc: readDecorators(op).doc,
    params,
    returnType: op.returnType ? mapPropertyType(op.returnType).type : "void",
  };
}

// ---------------------------------------------------------------------------
// Governance-aware compilation — used by the TypeSpec Source editor.
//
// Unlike compileTypeSpecDocument() above (AST-only, no error checking, no
// custom decorators — built that way originally because the temp-dir
// resolution bug above meant custom decorators couldn't load at all), this:
//   1. Actually checks program.diagnostics and fails closed on real errors —
//      the existing import path doesn't do this today and will silently
//      proceed on malformed input; flagging but not touching that here,
//      out of scope for this change.
//   2. Enables the @superschema/typespec-enterprise governance ruleset so
//      lint warnings (missing @precision on decimal, PII without
//      @anonymization, etc.) surface to the user.
//   3. Reads governance decorator values through the real semantic
//      accessors (getDataClassification, isPii, etc.) now that the temp-dir
//      fix lets the package actually resolve and register its state maps —
//      not the syntactic AST scraping readDecorators() above uses for
//      TypeSpec's own standard decorators.
// ---------------------------------------------------------------------------

export interface GovernanceDiagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  target?: string;
}

export interface FieldGovernanceInfo {
  classification?: string;
  pii?: boolean;
  retentionPolicy?: string;
  anonymization?: string;
  qualityRule?: string;
  sourceMapping?: { system: string; entity: string; field?: string; transform?: string };
  avroLogicalType?: string;
  avroFixedSize?: number;
  avroOrder?: string;
  protobufFieldNumber?: number;
  protobufOneofGroup?: string;
  partitionHint?: boolean;
  indexHint?: boolean;
  clusterHint?: boolean;
  deprecation?: { since: string; replacement?: string };
}

export interface ModelGovernanceInfo {
  businessOwner?: string;
  steward?: string;
  classification?: string;
  retentionPolicy?: string;
  avroNamespace?: string;
  avroRecordAliases?: string[];
  deprecation?: { since: string; replacement?: string };
}

export type CompileWithGovernanceResult =
  | {
      success: true;
      document: ParsedTypeSpecDocument;
      /** Keyed by `${modelName}.${fieldName}` */
      fieldGovernance: Record<string, FieldGovernanceInfo>;
      modelGovernance: Record<string, ModelGovernanceInfo>;
      diagnostics: GovernanceDiagnostic[];
    }
  | {
      success: false;
      diagnostics: GovernanceDiagnostic[];
    };

const GOVERNANCE_RULE_SET: LinterRuleSet = {
  extends: ["@superschema/typespec-enterprise/recommended"],
};

export async function compileTypeSpecWithGovernance(
  source: string
): Promise<CompileWithGovernanceResult> {
  let compiled: { program: Program; mainPath: string };
  try {
    compiled = await compileSource(source, { linterRuleSet: GOVERNANCE_RULE_SET });
  } catch (e) {
    // A disallowed import is a normal, user-facing failure of this source (shown like any compile error);
    // anything else is unexpected and propagates as before.
    if (e instanceof TypeSpecImportGuardError) {
      return { success: false, diagnostics: [{ severity: "error", code: e.code, message: e.message }] };
    }
    throw e;
  }
  const { program, mainPath } = compiled;

  const allDiagnostics: GovernanceDiagnostic[] = (program.diagnostics ?? []).map((d: Diagnostic) => ({
    severity: d.severity === "error" ? "error" : "warning",
    code: d.code,
    message: d.message,
    target: describeDiagnosticTarget(d),
  }));

  const hasBlockingError = allDiagnostics.some((d) => d.severity === "error");
  if (hasBlockingError) {
    return { success: false, diagnostics: allDiagnostics };
  }

  const fieldGovernance: Record<string, FieldGovernanceInfo> = {};
  const modelGovernance: Record<string, ModelGovernanceInfo> = {};

  navigateProgram(program, {
    model(m: Model) {
      if (!isFromSource(m, mainPath)) return;
      if (m.name === "Array" || m.name === "Record" || !m.name) return;

      const avroAliases = gov.getAvroRecordAliases(program, m);
      const modelInfo: ModelGovernanceInfo = {
        businessOwner: gov.getBusinessOwner(program, m),
        steward: gov.getSteward(program, m),
        classification: classificationFromEnterpriseMember(gov.getDataClassification(program, m)),
        retentionPolicy: gov.getRetentionPolicy(program, m),
        avroNamespace: gov.getAvroNamespace(program, m),
        avroRecordAliases: avroAliases && avroAliases.length > 0 ? avroAliases : undefined,
        deprecation: gov.getDeprecation(program, m),
      };
      if (Object.values(modelInfo).some((v) => v !== undefined)) {
        modelGovernance[m.name] = modelInfo;
      }

      for (const [, prop] of m.properties) {
        const fieldInfo: FieldGovernanceInfo = {
          // The governance enum member mapped back to the app's level (`Internal` → `INTERNAL`).
          classification: classificationFromEnterpriseMember(gov.getDataClassification(program, prop)),
          pii: gov.isPii(program, prop) || undefined,
          retentionPolicy: gov.getRetentionPolicy(program, prop),
          anonymization: gov.getAnonymization(program, prop),
          qualityRule: gov.getQualityRule(program, prop),
          sourceMapping: gov.getSourceMapping(program, prop),
          avroLogicalType: gov.getAvroLogicalType(program, prop),
          avroFixedSize: gov.getAvroFixedSize(program, prop),
          avroOrder: gov.getAvroOrder(program, prop),
          protobufFieldNumber: gov.getProtobufFieldNumber(program, prop),
          protobufOneofGroup: gov.getProtobufOneofGroup(program, prop),
          partitionHint: gov.hasPartitionHint(program, prop) || undefined,
          indexHint: gov.hasIndexHint(program, prop) || undefined,
          clusterHint: gov.hasClusterHint(program, prop) || undefined,
          deprecation: gov.getDeprecation(program, prop),
        };
        if (Object.values(fieldInfo).some((v) => v !== undefined)) {
          fieldGovernance[`${m.name}.${prop.name}`] = fieldInfo;
        }
      }
    },
  });

  // Reuse the existing AST-based extraction for everything else (types,
  // standard TypeSpec decorators, structure) — only governance state needed
  // the semantic accessors above.
  const document = compileTypeSpecDocumentFromProgram(program, mainPath);

  return { success: true, document, fieldGovernance, modelGovernance, diagnostics: allDiagnostics };
}

function describeDiagnosticTarget(d: Diagnostic): string | undefined {
  try {
    const loc = getSourceLocation(d.target as Parameters<typeof getSourceLocation>[0]);
    return loc ? `line ${loc.pos}` : undefined;
  } catch {
    return undefined;
  }
}

