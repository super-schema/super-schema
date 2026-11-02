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
  type StringLiteral,
  type NumericLiteral,
  type BooleanLiteral,
  type Interface,
  type Operation,
  type Type,
  type Namespace,
  type Diagnostic,
  type LinterRuleSet,
} from "@typespec/compiler";
import { SyntaxKind } from "@typespec/compiler/ast";
import { mkdtemp, writeFile, rm, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { mapTypeSpecType } from "./typespec-parser";
import { DATA_TYPE_HIERARCHY } from "@/lib/data-types";
import { upgradeLegacyTagDecorators } from "./legacy-tag-decorators";
import { createLibraryOnlyHost } from "./library-only-host";
import { isPlainIdentifier, quoteIdentifier } from "./typespec-identifiers";
import { assertTypeSpecImportsAllowed, TypeSpecImportGuardError } from "@/lib/typespec/import-guard";
import * as gov from "@superschema/typespec-enterprise";
import {
  CLASSIFICATION_EXTENSION_KEY,
  PIN_EXTENSION_KEY,
  TAGS_EXTENSION_KEY,
  MAX_LITERAL_DEPTH,
  LiteralSyntaxError,
  setOwn,
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

/** The line a VALIDATION-ONLY compile adds in front of the source (see `stubs` below): positions in its diagnostics are shifted back by this. */
const STUBS_IMPORT = 'import "./stubs.tsp";\n';
const STUBS_FILE = "stubs.tsp";

async function compileSource(
  source: string,
  options?: {
    linterRuleSet?: LinterRuleSet;
    /**
     * Validation only: declarations written to a SECOND file the source is given an import of (`stubs.tsp`, imported by one line placed
     * before the source's text, which is otherwise compiled as it is). The models declared there are not in the source file, so they are
     * not part of the document read back from it: nothing here is stored or emitted. Only `compileTypeSpecWithGovernance` passes it.
     */
    stubs?: string;
  }
): Promise<{ program: Program; mainPath: string; stubPaths: ReadonlySet<string> }> {
  const { text } = assertTypeSpecImportsAllowed(source);
  await mkdir(WORK_DIR, { recursive: true });
  const dir = await mkdtemp(join(WORK_DIR, "job-"));
  const mainPath = join(dir, "main.tsp");
  // This job's stand-in file, as the compiler may name it: the path it was written to, and its real path (the compiler may resolve an import).
  const stubPaths = new Set<string>();
  if (options?.stubs !== undefined) {
    const stubsPath = join(dir, STUBS_FILE);
    await writeFile(stubsPath, options.stubs, "utf8");
    stubPaths.add(stubsPath);
    stubPaths.add(await realpath(stubsPath).catch(() => stubsPath));
  }
  await writeFile(mainPath, options?.stubs !== undefined ? STUBS_IMPORT + text : text, "utf8");
  try {
    const program = await compile(libraryOnlyHost(), mainPath, {
      noEmit: true,
      ...(options?.linterRuleSet ? { linterRuleSet: options.linterRuleSet } : {}),
    });
    return { program, mainPath, stubPaths };
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

/**
 * The logical types a scalar can stand for: every data type that is a plain value (not a structure or a reference, which a scalar cannot be).
 */
const SCALAR_LOGICAL_TYPES: ReadonlySet<string> = new Set(
  DATA_TYPE_HIERARCHY.filter((t) => t.category !== "Structured" && t.category !== "Special").map((t) => t.id),
);

/**
 * The logical type of a scalar. A declared scalar is its base: `scalar Price extends decimal;` is `decimal`, `scalar Money extends Price;`
 * the same, walking up the chain to the first scalar the app has a type for. A scalar with no such base keeps its own name, which the
 * source save refuses as a type it does not know (it is never stored as `string`).
 */
function scalarLogicalType(scalar: Scalar): string {
  for (let cur: Scalar | undefined = scalar; cur; cur = cur.baseScalar) {
    const id = mapTypeSpecType(cur.name).type;
    if (SCALAR_LOGICAL_TYPES.has(id)) return id;
  }
  return scalar.name;
}

/** The type of a property that never has a value (`x: never;`): the property is not a field (see `extractModel`). */
const isNeverType = (t: Type): boolean => t.kind === "Intrinsic" && (t as { name?: string }).name === "never";

/**
 * The logical type an unresolved name stands for: none. A property whose type did not resolve is refused by the callers (the compile that
 * found it failed, and a document with errors is not read), so this value is never stored: it is not a type of the app.
 */
const UNRESOLVED_TYPE = "unresolved";

function elementName(type: Type | undefined): string {
  if (!type) return "string";
  if (type.kind === "Scalar") return scalarLogicalType(type as Scalar);
  // An array whose element is itself an array (`int32[][]`): the element is the logical type `array`, as the importers store it. The
  // model's own name, `Array`, is not a type of ours and generates `Array` with no element (`invalid-template-args`).
  if (type.kind === "Model" && (type as Model).name === "Array") return "array";
  if (type.kind === "Model") return (type as Model).name || "object";
  if (type.kind === "Enum") return (type as Enum).name;
  return "string";
}

/** What a property's type means: its logical type, and the null / union facts that its text spells (`T | null`, `A | B`). */
interface MappedProperty {
  type: string;
  arrayElementType?: string;
  /** The type is `T | null`: `type` / `arrayElementType` is T. */
  nullableType?: boolean;
  unionName?: string;
  unionMembers?: string[];
  /** The type is a union of two or more literal values (`"a" | "b"`, `1 | 2`, `true | false`): the text of each, the symbols of the enum it stands for (`type` / `arrayElementType` is not a type). */
  literalValues?: string[];
}

const isNullType = (t: Type): boolean => t.kind === "Intrinsic" && (t as { name?: string }).name === "null";

/** A union's members, the `null` of `T | null` taken out. */
function unionMembersOf(u: Union): { members: Type[]; hasNull: boolean } {
  const all = [...u.variants.values()].map((v) => v.type);
  const members = all.filter((t) => !isNullType(t));
  return { members, hasNull: members.length !== all.length };
}

/** A member that names a type of the text (a scalar, model, enum or union), not a value. */
const isTypeMember = (t: Type): boolean => t.kind === "Scalar" || t.kind === "Model" || t.kind === "Enum" || t.kind === "Union";

/**
 * The symbols of a union of two or more literal values (`"a" | "b"`, `1 | 2`, `true | false`), each as its text: an enum of the app holds text
 * (OpenAPI's inline enums of numbers and booleans import this way, so the document still imports). Undefined when a member is a type or a mix.
 */
function literalSymbols(members: readonly Type[]): string[] | undefined {
  if (members.length < 2) return undefined;
  const values: string[] = [];
  for (const m of members) {
    if (m.kind === "String") values.push((m as StringLiteral).value);
    else if (m.kind === "Number") values.push(String((m as NumericLiteral).value));
    else if (m.kind === "Boolean") values.push(String((m as BooleanLiteral).value));
    else return undefined;
  }
  return values;
}

function mapPropertyType(type: Type): MappedProperty {
  switch (type.kind) {
    case "Model": {
      const m = type as Model;
      if (m.name === "Array") {
        const value = m.indexer?.value;
        if (value?.kind === "Union") {
          // An array of a union: `(A | B)[]` is an array whose element is a union; `(T | null)[]` an array of T (the element's null is not kept).
          const { members } = unionMembersOf(value as Union);
          // A union of values (`("a" | "b")[]`) or a mix of values and types names no type: its element is the union's text, which the
          // planner refuses (the import reads the values as an enum).
          if (members.length >= 2 && !members.every(isTypeMember)) {
            const literals = literalSymbols(members);
            return { type: "array", arrayElementType: members.map(elementName).join(" | "), ...(literals ? { literalValues: literals } : {}) };
          }
          if (members.length >= 2 || ((value as Union).name && members.length >= 1)) {
            return { type: "array", arrayElementType: "union", unionName: (value as Union).name || undefined, unionMembers: members.map(elementName) };
          }
          return { type: "array", arrayElementType: mapTypeSpecType(elementName(members[0])).type };
        }
        const el = elementName(value);
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
      const { members, hasNull } = unionMembersOf(u);
      // `T | null` (an inline union of one type and null): the type is T, and the null is the field's own fact.
      if (!u.name && members.length === 1) return { ...mapPropertyType(members[0]), nullableType: true };
      const names = members.map(elementName);
      // A union of literals (`"a" | "b"`) is values, not types: it has no members to name (its symbols ride in `literalValues`).
      const ofTypes = members.every(isTypeMember);
      const literals = literalSymbols(members);
      return {
        type: names.join(" | "),
        ...(ofTypes ? { ...(u.name ? { unionName: u.name } : {}), unionMembers: names } : {}),
        ...(literals ? { literalValues: literals } : {}),
        ...(hasNull ? { nullableType: true } : {}),
      };
    }
    case "Scalar":
      return { type: scalarLogicalType(type as Scalar) };
    case "Intrinsic": {
      const name = (type as { name?: string }).name;
      // `void` / `never` / an unresolved name have no logical type: they are never read as `string` (`never` properties are skipped
      // before they get here, and a document that did not compile is refused before anything is mapped). `unknown` stays the generic
      // string: the generator writes a dangling reference as `unknown` plus its `$ref` extension, which reads back as this.
      if (name === "void") return { type: "void" };
      if (name === "ErrorType") return { type: UNRESOLVED_TYPE };
      return { type: "string" };
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
  for (const { name, args, rawArgs } of readAstDecorators(type)) {
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
        // The reference pin (a non-empty string); any other value of this key is an ordinary extension (see merge-fields).
        if (s0 === PIN_EXTENSION_KEY && typeof args[1] === "string" && args[1] !== "") {
          d.referencedEntityVersion = args[1];
          break;
        }
        // @extension / @TypeSpec.JsonSchema.extension / @TypeSpec.OpenAPI.extension ("x-key", value): the
        // value keeps its JSON shape; the emitted JsonSchema + OpenAPI pair for one key collapses to one entry.
        if (s0) {
          try {
            d.extensions = { ...(d.extensions ?? {}), [s0]: valueNodeToJs(rawArgs[1]) };
          } catch (e) {
            if (!(e instanceof LiteralSyntaxError)) throw e; // over-deep value: drop this key
          }
        }
        break;
    }
  }
  return d;
}

/**
 * A decorator-argument value node (`"s"`, `1`, `true`, `null`, `#[...]`, `#{...}`) → plain JS, recursively.
 * Read from the AST (not the checked value) like the rest of this file, so it works without decorator
 * implementations. Unknown nodes yield the flattened reference/literal text, or null. Throws
 * LiteralSyntaxError past MAX_LITERAL_DEPTH values of nesting (same count as the text reader); the extension
 * collector drops that key.
 */
function valueNodeToJs(node: unknown, depth = 1): unknown {
  if (depth > MAX_LITERAL_DEPTH) throw new LiteralSyntaxError("literal nested too deeply");
  const n = node as
    | {
        value?: unknown;
        values?: unknown[];
        properties?: Array<{ id?: { sv?: string }; value?: unknown }>;
        target?: { sv?: string; id?: { sv?: string } };
        sv?: string;
      }
    | undefined;
  if (n === undefined || n === null) return null;
  if (Array.isArray(n.properties)) {
    const out: Record<string, unknown> = {};
    for (const p of n.properties) {
      const key = p.id?.sv;
      if (key !== undefined) setOwn(out, key, valueNodeToJs(p.value, depth + 1));
    }
    return out;
  }
  if (Array.isArray(n.values)) return n.values.map((v) => valueNodeToJs(v, depth + 1));
  if (typeof n.value === "string" || typeof n.value === "number" || typeof n.value === "boolean") return n.value;
  const ref = exprToArgValue(n);
  // `null` parses as a reference to the keyword identifier, so it arrives as the text "null".
  return ref === undefined || ref === "null" ? null : ref;
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
    ...(mapped.nullableType ? { nullableType: true } : {}),
    ...(mapped.unionMembers && mapped.unionMembers.length > 0 ? { unionMembers: mapped.unionMembers } : {}),
    ...(mapped.unionName ? { unionName: mapped.unionName } : {}),
    ...(mapped.literalValues ? { literalValues: mapped.literalValues } : {}),
    isOptional: prop.optional,
    isKey: hasKeyDecorator(prop),
    decorators: readDecorators(prop),
    defaultValue: undefined,
  };
}

function extractModel(program: Program, model: Model): ParsedTypeSpecModel {
  const fields: ParsedTypeSpecField[] = [];
  for (const [, prop] of model.properties) {
    // A property typed `never` can hold no value: it is no field (the text reader skips it the same way).
    if (isNeverType(prop.type)) continue;
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
    extensions: decorators.extensions,
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

/**
 * A TypeSpec text the compiler refused (it has errors): it has no document to import, so the import answers with its diagnostics. Thrown by
 * `compileTypeSpecDocument`, which never returns the document of a text with errors (an unresolved name would otherwise be read as a type).
 */
export class TypeSpecCompileError extends Error {
  readonly code = "TYPESPEC_COMPILE_ERROR";

  constructor(readonly diagnostics: GovernanceDiagnostic[]) {
    // The first few errors, each bounded: the message is shown to the person who imports.
    const messages = diagnostics.slice(0, 5).map((d) => d.message.slice(0, 300));
    super(`The TypeSpec does not compile: ${messages.join("; ")}`);
    this.name = "TypeSpecCompileError";
  }
}

/**
 * The document of a TypeSpec text, for an import. A text the compiler refuses throws `TypeSpecCompileError` with its errors: an unresolved or
 * misspelt name is not read as a type of its own, and nothing is imported from a text that does not compile (the Source save refuses the same).
 */
export async function compileTypeSpecDocument(source: string): Promise<ParsedTypeSpecDocument> {
  // A stored source from before Story 16.6 can carry `@tag` lines that real TypeSpec refuses: they are read in the form the generator emits now
  // (a no-op for any other text), so an import of such text keeps its classifications and tags, and everything else is still compiled as written.
  const { program, mainPath } = await compileSource(upgradeLegacyTagDecorators(source));
  const errors: GovernanceDiagnostic[] = (program.diagnostics ?? [])
    .filter((d: Diagnostic) => d.severity === "error")
    .map((d: Diagnostic) => ({ severity: "error", code: d.code, message: d.message, target: describeDiagnosticTarget(d, mainPath) }));
  if (errors.length > 0) throw new TypeSpecCompileError(errors);
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

/**
 * A plain NAME (`Address`, `Billing.Payments.Address`) that the type of a field of a model of the source is, or is made of, and how: `direct`
 * (`Address`), `array` (`Address[]`), `map` (`Record<Address>`), `union` (`Card | Bank`: one entry per member, the union being the field's own
 * type). `model` is the model the field belongs to (the caller picks the entity's own model by name; the names of the other models are listed
 * too, so the compile can be told about each of them). Read from the syntax tree, so a qualified name is as written (the semantic type only
 * knows the model's short name). Anything else (a template instance other than `Record<Name>`, an array of a union, an inline model, a name
 * inside a nested expression) is not listed: a name only there is never offered for a stand-in.
 */
export interface FieldTypeName {
  model: string;
  field: string;
  written: string;
  shape: "direct" | "array" | "map" | "union";
}

export type CompileWithGovernanceResult =
  | {
      success: true;
      document: ParsedTypeSpecDocument;
      /** Keyed by `${modelName}.${fieldName}` */
      fieldGovernance: Record<string, FieldGovernanceInfo>;
      modelGovernance: Record<string, ModelGovernanceInfo>;
      diagnostics: GovernanceDiagnostic[];
      /** The plain type names the fields of every model of the source write (see {@link FieldTypeName}), in declaration order. */
      fieldTypeNames: FieldTypeName[];
      /** The names `options.externalModels` accepted: the source compiled only because they were given a stand-in. Empty for a source that compiled on its own. */
      externalModels: ReadonlySet<string>;
    }
  | {
      success: false;
      diagnostics: GovernanceDiagnostic[];
    };

export interface CompileWithGovernanceOptions {
  /**
   * The Source tab saves a source whose fields may be typed with the name of ANOTHER entity of the tenant, a model that source does not
   * declare, so on its own it fails with `invalid-ref`. When it does, for a name a field of a model of the source WRITES that the compiler
   * could not find (as written: `Address` or `Billing.Payments.Address`), this is asked which of them the caller resolves (an entity of
   * the tenant); the source is compiled once more with an empty stand-in model for each name it accepts, so the rest of the source is
   * still checked for real. The stand-ins live in a separate file: they are not in the document read back, so nothing of them is stored
   * or emitted. A name is offered only when every use of it is part of the type of a field of that model (see {@link FieldTypeName}: `Name`,
   * `Name[]`, `Record<Name>`, a member of the field's own union); a name used anywhere else (extends, a spread, an alias, a union
   * declaration, a decorator argument, a template argument) is never offered: all its uses stay errors. `unionOnly` are the offered
   * names that are ONLY ever a member of a field's union (those are not stored as references, so the caller may hold them to a stricter
   * licence).
   */
  externalModels?: (written: string[], unionOnly: ReadonlySet<string>) => Promise<ReadonlySet<string>> | ReadonlySet<string>;
}

const GOVERNANCE_RULE_SET: LinterRuleSet = {
  extends: ["@superschema/typespec-enterprise/recommended"],
};

/**
 * The identifiers the compiler reports as unknown (`Unknown identifier Address`; for `A.B.C` the first segment it could not find), with how
 * many times each was reported: one report per use.
 */
function unknownIdentifiers(diagnostics: readonly GovernanceDiagnostic[]): Map<string, number> {
  const names = new Map<string, number>();
  for (const d of diagnostics) {
    if (d.severity !== "error" || d.code !== "invalid-ref") continue;
    const m = /^Unknown identifier (.+)$/.exec(d.message);
    if (m) names.set(m[1], (names.get(m[1]) ?? 0) + 1);
  }
  return names;
}

/** The declarations of the stand-in models: `model Address {}` and `namespace Billing.Payments { model Address {} }`. */
function standInDeclarations(names: Iterable<string>): string {
  const ident = (name: string) => (isPlainIdentifier(name) ? name : quoteIdentifier(name));
  const lines = ["// Validation only: stand-ins for the tenant entities the source refers to. Never stored, never emitted."];
  for (const written of names) {
    const parts = written.split(".");
    const model = ident(parts[parts.length - 1]);
    lines.push(parts.length === 1 ? `model ${model} {}` : `namespace ${parts.slice(0, -1).map(ident).join(".")} { model ${model} {} }`);
  }
  return lines.join("\n") + "\n";
}

/**
 * The name `node` is when it is a plain type reference without template arguments, else undefined. A member chain longer than
 * {@link MAX_NAME_SEGMENTS} is not a name an entity can have (read iteratively: a hostile source cannot overflow the stack).
 */
const MAX_NAME_SEGMENTS = 8;
function plainTypeName(node: unknown): string | undefined {
  const ref = node as { kind?: SyntaxKind; target?: unknown; arguments?: readonly unknown[] } | undefined;
  if (ref?.kind !== SyntaxKind.TypeReference || (ref.arguments?.length ?? 0) > 0) return undefined;
  const segments: string[] = [];
  let cursor = ref.target as { kind?: SyntaxKind; sv?: string; id?: { sv?: string }; base?: unknown; selector?: string } | undefined;
  while (cursor?.kind === SyntaxKind.MemberExpression) {
    if (cursor.selector !== "." || typeof cursor.id?.sv !== "string" || cursor.id.sv === "" || segments.length >= MAX_NAME_SEGMENTS) return undefined;
    segments.unshift(cursor.id.sv);
    cursor = cursor.base as typeof cursor | undefined;
  }
  if (cursor?.kind !== SyntaxKind.Identifier || typeof cursor.sv !== "string" || cursor.sv === "") return undefined;
  segments.unshift(cursor.sv);
  return segments.join(".");
}

/** `Name` when `node` is exactly `Record<Name>` (the std string-keyed map; the generator's spelling of a map), else undefined. */
function recordValueName(node: unknown): string | undefined {
  const ref = node as { kind?: SyntaxKind; target?: { kind?: SyntaxKind; sv?: string }; arguments?: readonly { argument?: unknown }[] } | undefined;
  if (ref?.kind !== SyntaxKind.TypeReference || ref.target?.kind !== SyntaxKind.Identifier || ref.target.sv !== "Record") return undefined;
  if (ref.arguments?.length !== 1) return undefined;
  return plainTypeName(ref.arguments[0].argument);
}

/**
 * {@link FieldTypeName}s of every model of the source, in declaration order (the same models `compileTypeSpecDocumentFromProgram` lists).
 * An array of a union (`(A | B)[]`) is not listed on purpose: the reader reports the element of such an array as `string`, so a save would
 * overwrite the row with an array of strings.
 */
function entityFieldTypeNames(program: Program, mainPath: string): FieldTypeName[] {
  const models: Model[] = [];
  navigateProgram(program, {
    model(m: Model) {
      if (!isFromSource(m, mainPath)) return;
      if (m.name === "Array" || m.name === "Record" || !m.name) return;
      models.push(m);
    },
  });
  const names: FieldTypeName[] = [];
  for (const model of models) {
    for (const [, prop] of model.properties) {
      const node = prop.node as { kind?: SyntaxKind; value?: { kind?: SyntaxKind; elementType?: unknown; options?: readonly unknown[] } } | undefined;
      if (node?.kind !== SyntaxKind.ModelProperty || !node.value) continue;
      const push = (written: string, shape: FieldTypeName["shape"]) => names.push({ model: model.name, field: prop.name, written, shape });
      const direct = plainTypeName(node.value);
      if (direct !== undefined) {
        push(direct, "direct");
      } else if (node.value.kind === SyntaxKind.ArrayExpression) {
        const element = plainTypeName(node.value.elementType);
        if (element !== undefined) push(element, "array");
      } else if (node.value.kind === SyntaxKind.UnionExpression) {
        // `T | null` is T, nullable (the compiler's own reading, see `mapPropertyType`): its name is a direct type, not a union member.
        const options = (node.value.options ?? []).filter((option) => plainTypeName(option) !== "null");
        if (options.length === 1) {
          const only = plainTypeName(options[0]);
          if (only !== undefined) push(only, "direct");
        } else {
          for (const option of options) {
            const member = plainTypeName(option);
            if (member !== undefined) push(member, "union");
          }
        }
      } else {
        const value = recordValueName(node.value);
        if (value !== undefined) push(value, "map");
      }
    }
  }
  return names;
}

export async function compileTypeSpecWithGovernance(
  source: string,
  options?: CompileWithGovernanceOptions
): Promise<CompileWithGovernanceResult> {
  const first = await governanceCompile(source);
  if (first.result.success || !options?.externalModels || !first.program) return first.result;

  // The type of a field names something the source does not declare: is it an entity of the tenant? Only the names the compiler could
  // not find are offered, and only when written as the type of a field (or of an array's element) of some model of the source. Which model is
  // the entity's is the caller's to pick (`FieldTypeName.model`): a name a helper model writes may compile, and is linked by nothing.
  const unknown = unknownIdentifiers(first.result.diagnostics);
  if (unknown.size === 0) return first.result;
  const typed = entityFieldTypeNames(first.program, first.mainPath).filter((n) => unknown.has(n.written.split(".")[0]));

  // The compiler reports an unknown name once per use. A name used anywhere BESIDES as the type of a field (extends, a spread, a map value,
  // a decorator argument) has more reports than field types: a stand-in would silently satisfy that use too (a spread of an empty model),
  // so such a name gets none and every use of it stays an error.
  const typedUses = new Map<string, number>();
  for (const n of typed) typedUses.set(n.written.split(".")[0], (typedUses.get(n.written.split(".")[0]) ?? 0) + 1);
  const onlyAsFieldType = (written: string) => {
    const head = written.split(".")[0];
    return typedUses.get(head) === unknown.get(head);
  };

  const unresolved = [...new Set(typed.map((n) => n.written))].filter(onlyAsFieldType);
  if (unresolved.length === 0) return first.result;
  // Names that are only ever a member of a field's union: not stored as references, so the caller may hold them to a stricter licence.
  const unionOnly = new Set(unresolved.filter((written) => typed.every((n) => n.written !== written || n.shape === "union")));
  const accepted = await options.externalModels(unresolved, unionOnly);
  const standIns = unresolved.filter((written) => accepted.has(written));
  if (standIns.length === 0) return first.result;
  return (await governanceCompile(source, standInDeclarations(standIns), new Set(standIns))).result;
}

async function governanceCompile(
  source: string,
  standIns?: string,
  externalModels: ReadonlySet<string> = new Set()
): Promise<{ result: CompileWithGovernanceResult; program?: Program; mainPath: string }> {
  let compiled: { program: Program; mainPath: string; stubPaths: ReadonlySet<string> };
  try {
    compiled = await compileSource(source, { linterRuleSet: GOVERNANCE_RULE_SET, ...(standIns !== undefined ? { stubs: standIns } : {}) });
  } catch (e) {
    // A disallowed import is a normal, user-facing failure of this source (shown like any compile error);
    // anything else is unexpected and propagates as before.
    if (e instanceof TypeSpecImportGuardError) {
      return { result: { success: false, diagnostics: [{ severity: "error", code: e.code, message: e.message }] }, mainPath: "" };
    }
    throw e;
  }
  const { program, mainPath, stubPaths } = compiled;

  // A diagnostic raised inside THIS job's stand-in file is about the stand-in (a lint on an empty model), never about the user's source.
  const allDiagnostics: GovernanceDiagnostic[] = (program.diagnostics ?? [])
    .filter((d: Diagnostic) => standIns === undefined || !isInStandInFile(d, stubPaths))
    .map((d: Diagnostic) => ({
      severity: d.severity === "error" ? "error" : "warning",
      code: d.code,
      message: d.message,
      target: describeDiagnosticTarget(d, mainPath, standIns !== undefined ? STUBS_IMPORT.length : 0),
    }));

  const hasBlockingError = allDiagnostics.some((d) => d.severity === "error");
  if (hasBlockingError) {
    return { result: { success: false, diagnostics: allDiagnostics }, program, mainPath };
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
        setOwn(modelGovernance, m.name, modelInfo);
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

  return {
    result: {
      success: true,
      document,
      fieldGovernance,
      modelGovernance,
      diagnostics: allDiagnostics,
      fieldTypeNames: entityFieldTypeNames(program, mainPath),
      externalModels,
    },
    program,
    mainPath,
  };
}

/** The position in the SOURCE: `prefix` characters (the stand-in import line) are not part of it. */
function describeDiagnosticTarget(d: Diagnostic, mainPath?: string, prefix = 0): string | undefined {
  try {
    const loc = getSourceLocation(d.target as Parameters<typeof getSourceLocation>[0]);
    if (!loc) return undefined;
    return `line ${mainPath !== undefined && loc.file?.path === mainPath ? Math.max(0, loc.pos - prefix) : loc.pos}`;
  } catch {
    return undefined;
  }
}

/**
 * Whether a diagnostic is raised inside one of `stubPaths`: the full path of THIS job's stand-in file, never a file of the same name
 * somewhere else (an installed library may well have a `stubs.tsp` of its own). Exported for tests.
 */
export function isInStandInFile(d: Pick<Diagnostic, "target">, stubPaths: ReadonlySet<string>): boolean {
  try {
    const loc = getSourceLocation(d.target as Parameters<typeof getSourceLocation>[0]);
    return loc?.file?.path !== undefined && stubPaths.has(loc.file.path);
  } catch {
    return false;
  }
}

