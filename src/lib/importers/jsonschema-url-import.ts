/**
 * URL-based JSON Schema import (Addendum B of the vendor-extension round-trip spec).
 *
 * Fetches the root document through the resolver's guarded paths, resolves its `$ref` graph with
 * `resolveJsonSchemaRefs` (resolve(), never dereference(): every file stays its own document), and builds ONE
 * `MultiEntityImportResult` covering the root and every resolved file.
 *
 * How cross-file references are named (no basename guessing):
 *  1. Every external `$ref` of every document is replaced, in a COPY of that document, by a unique opaque token
 *     (`XR<per-call random nonce>x<n>x`). Self references by file name become plain `#...` pointers. The existing single-document importer
 *     (`parseJsonSchemaDocument`) then runs unchanged over each copy; it reports each external ref as a low-confidence
 *     reference by name, and that name is the token.
 *  2. Each file's assets are named (title, else `$id` basename, else file basename) and made globally unique
 *     (`_2`, `_3`, in resolution order), every collision reported.
 *  3. Each token is looked up BY RESOLVED URI (+ fragment) in the per-file index and replaced by the target's final
 *     name; a reference to an enum / union file turns the field into an enum / union field. A target that could not be
 *     loaded keeps today's dangling form (best-effort name, low confidence, original `$ref`) plus a machine-readable
 *     `danglingRef` marker on the field and one warning per distinct target.
 *  4. Inheritance cycles that only exist across files are broken on the merged graph.
 *
 * Never throws: every failure is an `err` Result or a warning. Plain objects are never written with user keys.
 */
import { randomBytes } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { err, ok, type Result } from "@/types/result";
import { setOwn } from "@/lib/compiler/governance-decorators";
import { sanitizeIdentifier } from "@/lib/compiler/typespec-identifiers";
import {
  breakInheritanceCycles,
  budgetOriginalContent,
  createResolveBudget,
  importCountLimitMessage,
  isLowFromUnresolvedRef,
  parseJsonSchemaDocumentIndexed,
  refToEntityName,
  stripBom,
  type DefinitionIndexEntry,
  type ResolveBudget,
} from "./jsonschema.importer";
import {
  fetchRootDocument,
  resolveJsonSchemaRefs,
  type ResolvedRefs,
  type ResolverDeps,
} from "./jsonschema-ref-resolver";
import type { MultiEntityImportResult, ParsedEntity, ParsedEnum, ParsedField, ParsedUnion } from "./types";

export interface UrlImportDeps extends ResolverDeps {
  /** Test seam: replaces `resolveJsonSchemaRefs`. */
  resolveRefs?: (rootUrl: string, rootContent: string, deps?: ResolverDeps) => Promise<ResolvedRefs>;
}

/** Hard cap on documents turned into assets (the resolver already bounds its own file count). */
export const MAX_IMPORT_DOCUMENTS = 200;
/** Hard cap on distinct external refs tokenized across all documents. */
const MAX_TOKENS = 5000;
/** Keywords whose value is data, never schema: their `$ref` strings are left alone (only when the key is a keyword). */
const DATA_KEYWORDS = new Set(["enum", "const", "default", "examples", "example"]);
/** Keywords whose value is a map NAME -> schema: its keys are names (even `default`, `enum`, ...), its values schemas. */
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "$defs", "definitions", "patternProperties", "dependentSchemas", "dependencies"]);
const PLACEHOLDER_KEY = "ZzImportPlaceholder";

interface TokenInfo {
  token: string;
  ref: string;
  /** Absolute URI of the referenced file (fragment removed), when computable. */
  file: string;
  absolute: string;
  /** Decoded fragment including the leading `#` ("" when none). */
  fragment: string;
}

interface FileIndex {
  rootName?: string;
  rootKind?: DefinitionIndexEntry["kind"];
  defs: Map<string, DefinitionIndexEntry>;
}

type Target =
  | { ok: true; kind: "entity" | "enum" | "union"; name: string }
  | { ok: false; reason: string; resolvedUri: string; loadFailure: boolean };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function hrefOf(uri: string): string {
  try {
    const u = new URL(uri);
    u.hash = "";
    return u.href;
  } catch {
    return uri;
  }
}

function fileBaseName(uri: string): string {
  let last = "";
  try {
    const path = new URL(uri).pathname;
    last = decodeURIComponent(path.split("/").filter(Boolean).pop() ?? "");
  } catch {
    last = uri.split(/[/#?]/).filter(Boolean).pop() ?? "";
  }
  const stripped = last.replace(/\.(schema\.json|json|ya?ml)$/i, "");
  return stripped || "schema";
}

function hasUsableId(node: Record<string, unknown>): boolean {
  if (typeof node.$id !== "string" || !node.$id.trim()) return false;
  const last = node.$id.split(/[/#]/).filter(Boolean).pop() ?? "";
  return last.replace(/\.(json|schema\.json)$/i, "") !== "";
}

// ---------------------------------------------------------------------------
// Per-document preparation
// ---------------------------------------------------------------------------

class Tokens {
  readonly byToken = new Map<string, TokenInfo>();
  private readonly byKey = new Map<string, string>();
  private counter = 0;
  overflowed = false;
  /** Per-call random nonce: document content cannot guess or collide with a token. */
  private readonly nonce = randomBytes(8).toString("hex");
  readonly globalRe = new RegExp(`XR${this.nonce}x\\d+x`, "g");
  readonly staleBaseRe = new RegExp(`base entity \`(XR${this.nonce}x\\d+x)\` is referenced but not defined`);

  isToken(name: string): boolean {
    return this.byToken.has(name);
  }

  /** Token for `ref` as written in the document at `docUri`; `null` when it is not an external ref. */
  forRef(ref: string, docUri: string): { token: string } | { self: string } | null {
    if (ref === "" || ref.startsWith("#")) return null;
    let abs: URL;
    try {
      abs = new URL(ref.replace(/\\/g, "/"), docUri);
    } catch {
      return null;
    }
    const fragment = safeDecode(abs.hash);
    const file = hrefOf(abs.href);
    if (file === hrefOf(docUri)) return { self: fragment === "" || fragment === "#" ? "#" : unescapePointer(fragment) };
    const key = `${docUri}\u0000${ref}`;
    const existing = this.byKey.get(key);
    if (existing) return { token: existing };
    if (this.counter >= MAX_TOKENS) {
      this.overflowed = true;
      return null;
    }
    const token = `XR${this.nonce}x${++this.counter}x`;
    this.byKey.set(key, token);
    this.byToken.set(token, { token, ref, file, absolute: abs.href, fragment });
    return { token };
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Deep copy of a document with external `$ref`s tokenized. Recursion depth is bounded by the engine (RangeError is caught by the caller). */
function rewriteNode(
  value: unknown,
  docUri: string,
  tokens: Tokens,
  memo: [Map<object, unknown>, Map<object, unknown>],
  isNameMap = false,
): unknown {
  if (value === null || typeof value !== "object") return value;
  const m = memo[isNameMap ? 1 : 0];
  if (m.has(value)) return m.get(value);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    m.set(value, out);
    for (const v of value) out.push(rewriteNode(v, docUri, tokens, memo));
    return out;
  }
  const out: Record<string, unknown> = {};
  m.set(value, out);
  for (const [k, v] of Object.entries(value)) {
    if (isNameMap) {
      // Keys are NAMES (a property may be called `default` or `$ref`); every value is a schema.
      setOwn(out, k, rewriteNode(v, docUri, tokens, memo));
    } else if (k === "$ref" && typeof v === "string") {
      const t = tokens.forRef(v, docUri);
      setOwn(out, k, t === null ? v : "token" in t ? t.token : t.self);
    } else if (DATA_KEYWORDS.has(k)) {
      setOwn(out, k, v);
    } else {
      setOwn(out, k, rewriteNode(v, docUri, tokens, memo, SCHEMA_MAP_KEYWORDS.has(k) && isPlainObject(v)));
    }
  }
  return out;
}

interface BuiltFile {
  doc: MultiEntityImportResult;
  index: FileIndex;
}

function buildFile(
  docUri: string,
  rawDoc: unknown,
  originalContent: string,
  tokens: Tokens,
  budget: ResolveBudget,
): { ok: true; built: BuiltFile } | { ok: false; reason: string } {
  if (!isPlainObject(rawDoc)) return { ok: false, reason: "the document is not a JSON object" };
  try {
    const rewritten = rewriteNode(rawDoc, docUri, tokens, [new Map(), new Map()]) as Record<string, unknown>;
    if (typeof rewritten.title !== "string" || !rewritten.title.trim()) {
      if (!hasUsableId(rewritten)) setOwn(rewritten, "title", fileBaseName(docUri));
    }
    const first = parseJsonSchemaDocumentIndexed(JSON.stringify(rewritten), budget);
    if (first.success && first.data.doc.rootEntityName) {
      return { ok: true, built: toBuilt(first.data.doc, first.data.definitions, first.data.doc.rootEntityName, "entity") };
    }
    const isNonObjectRoot =
      Array.isArray(rewritten.enum) || Array.isArray(rewritten.oneOf) || Array.isArray(rewritten.anyOf);
    if (isNonObjectRoot && (!first.success || !first.data.doc.rootEntityName)) {
      const synthetic = parseNonObjectRoot(rewritten, docUri, budget);
      if (synthetic) return { ok: true, built: synthetic };
    }
    if (!first.success) return { ok: false, reason: first.error.message };
    return { ok: true, built: toBuilt(first.data.doc, first.data.definitions, undefined, undefined) };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof RangeError ? "the document is nested too deeply" : "the document could not be processed",
    };
  }
}

function toBuilt(
  doc: MultiEntityImportResult,
  defs: Map<string, DefinitionIndexEntry>,
  rootName: string | undefined,
  rootKind: DefinitionIndexEntry["kind"] | undefined,
): BuiltFile {
  return { doc, index: { rootName, rootKind, defs } };
}

/**
 * A document whose root is a string enum or a union of named refs (not an object): the importer only knows definitions
 * of those kinds, so the root is parsed as one definition next to a throwaway placeholder entity (which keeps the
 * importer from rejecting an entity-less document) and the placeholder is dropped again.
 */
function parseNonObjectRoot(rewritten: Record<string, unknown>, docUri: string, budget: ResolveBudget): BuiltFile | null {
  const taken = new Set<string>();
  for (const kw of ["$defs", "definitions"]) {
    const d = rewritten[kw];
    if (isPlainObject(d)) for (const k of Object.keys(d)) taken.add(k);
  }
  const titled = typeof rewritten.title === "string" && rewritten.title.trim() ? rewritten.title.trim() : undefined;
  let key = titled ?? (hasUsableId(rewritten) ? idBase(String(rewritten.$id)) : fileBaseName(docUri));
  while (taken.has(key)) key = `${key}_root`;
  const node: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rewritten)) {
    if (k === "$defs" || k === "definitions" || k === "$schema" || k === "$id") continue;
    setOwn(node, k, v);
  }
  const defs: Record<string, unknown> = {};
  const oldDefs = rewritten.$defs;
  if (isPlainObject(oldDefs)) for (const [k, v] of Object.entries(oldDefs)) setOwn(defs, k, v);
  setOwn(defs, key, node);
  setOwn(defs, PLACEHOLDER_KEY, { type: "object", properties: { x: { type: "string" } } });
  const synth: Record<string, unknown> = { $defs: defs };
  if (isPlainObject(rewritten.definitions)) setOwn(synth, "definitions", rewritten.definitions);
  const parsed = parseJsonSchemaDocumentIndexed(JSON.stringify(synth), budget);
  if (!parsed.success) return null;
  const { doc, definitions } = parsed.data;
  const placeholder = definitions.get(`#/$defs/${PLACEHOLDER_KEY}`)?.assetName ?? PLACEHOLDER_KEY;
  doc.entities = doc.entities.filter((e) => e.name !== placeholder);
  definitions.delete(`#/$defs/${PLACEHOLDER_KEY}`);
  const rootDef = definitions.get(`#/$defs/${key}`);
  if (!rootDef) return null;
  return toBuilt(doc, definitions, rootDef.assetName, rootDef.kind);
}

/** RFC 6901 unescape of the key segment: `#/$defs/a~1b` -> `#/$defs/a/b` (the importer indexes raw keys). */
function unescapePointer(fragment: string): string {
  const m = /^(#\/(?:\$defs|definitions)\/)(.*)$/.exec(fragment);
  return m ? `${m[1]}${m[2]!.replace(/~1/g, "/").replace(/~0/g, "~")}` : fragment;
}

function idBase(id: string): string {
  const last = id.split(/[/#]/).filter(Boolean).pop() ?? "";
  return last.replace(/\.(json|schema\.json)$/i, "") || "schema";
}

// ---------------------------------------------------------------------------
// Global naming
// ---------------------------------------------------------------------------

function applyRenames(built: BuiltFile, renames: Map<string, string>): void {
  if (renames.size === 0) return;
  const bySanitized = new Map<string, string>();
  for (const [from, to] of renames) bySanitized.set(sanitizeIdentifier(from), sanitizeIdentifier(to));
  const name = (n: string | undefined): string | undefined => (n === undefined ? n : (renames.get(n) ?? n));
  const member = (n: string): string => bySanitized.get(n) ?? renames.get(n) ?? n;
  for (const e of built.doc.entities) {
    e.name = name(e.name)!;
    if (e.extends !== undefined) e.extends = name(e.extends)!;
    for (const f of e.fields) {
      if (f.referencedEntityName !== undefined) f.referencedEntityName = name(f.referencedEntityName);
      if (f.enumName !== undefined) f.enumName = name(f.enumName);
      if (f.unionName !== undefined) f.unionName = name(f.unionName);
      if (f.unionMembers) f.unionMembers = f.unionMembers.map(member);
    }
  }
  for (const e of built.doc.enums) e.name = name(e.name)!;
  for (const u of built.doc.unions ?? []) {
    u.name = name(u.name)!;
    u.memberTypes = u.memberTypes.map(member);
  }
  for (const d of built.index.defs.values()) d.assetName = name(d.assetName)!;
  if (built.index.rootName !== undefined) built.index.rootName = name(built.index.rootName);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function fail(code: string, message: string, suggestedFix?: string): Result<never> {
  return err({ code, message, ...(suggestedFix ? { suggestedFix } : {}) });
}

function parseLoose(content: string): unknown {
  try {
    return JSON.parse(stripBom(content));
  } catch {
    try {
      return parseYaml(stripBom(content));
    } catch {
      return undefined;
    }
  }
}

export async function importJsonSchemaFromUrl(
  url: string,
  deps: UrlImportDeps = {},
): Promise<Result<MultiEntityImportResult>> {
  try {
    if (typeof url !== "string" || !url.trim()) {
      return fail("VALIDATION_ERROR", "A schema URL is required", "Provide an https URL of a JSON Schema document.");
    }
    const rootUrl = url.trim();
    const fetched = await fetchRootDocument(rootUrl, deps ?? {});
    if (!fetched.ok) {
      return fail("FETCH_ERROR", `The schema could not be loaded: ${fetched.reason}`, "Check the URL and that the server can reach it.");
    }
    const resolveRefs = deps?.resolveRefs ?? resolveJsonSchemaRefs;
    const refs = await resolveRefs(rootUrl, fetched.content, deps ?? {});
    return assemble(rootUrl, fetched.content, refs);
  } catch {
    return fail("PARSE_ERROR", "Could not import the JSON Schema from the URL");
  }
}

function assemble(rootUrl: string, rootContent: string, refs: ResolvedRefs): Result<MultiEntityImportResult> {
  const resolved = refs?.resolved instanceof Map ? refs.resolved : new Map<string, unknown>();
  const unreachable = refs?.unreachable instanceof Map ? refs.unreachable : new Map<string, string>();

  // The resolver registers the root document first, under its canonical URI.
  const entries = [...resolved.entries()];
  const rootUri = entries.length > 0 ? entries[0]![0] : rootUrl;
  const rootDoc = entries.length > 0 ? entries[0]![1] : parseLoose(rootContent);
  const docs: Array<{ uri: string; doc: unknown; original: string; isRoot: boolean }> = [
    { uri: rootUri, doc: rootDoc, original: rootContent, isRoot: true },
  ];
  const warnings: string[] = [];
  let skipped = 0;
  for (const [uri, doc] of entries.slice(1)) {
    if (docs.length >= MAX_IMPORT_DOCUMENTS) {
      skipped++;
      continue;
    }
    let original = "";
    try {
      original = JSON.stringify(doc) ?? "";
    } catch {
      /* unserializable: the build step reports it */
    }
    docs.push({ uri, doc, original, isRoot: false });
  }
  if (skipped > 0) {
    warnings.push(`Only the first ${MAX_IMPORT_DOCUMENTS} referenced documents are imported; ${skipped} more were skipped.`);
  }

  const tokens = new Tokens();
  const taken = new Set<string>();
  const indexByUri = new Map<string, FileIndex>();
  const failedByUri = new Map<string, string>();
  const fileWarnings: string[] = [];
  const entities: ParsedEntity[] = [];
  const enums: ParsedEnum[] = [];
  const unions: ParsedUnion[] = [];
  let rootEntityName: string | undefined;

  // One visit budget for the whole import: every document is resolved on the event loop, so the sum is what could block it.
  const budget = createResolveBudget(true);
  for (const d of docs) {
    const built = buildFile(d.uri, d.doc, d.original, tokens, budget);
    if (!built.ok) {
      if (d.isRoot) {
        const why = built.reason;
        return fail("PARSE_ERROR", `The root document could not be imported: ${why}`, "Check that the URL points at a JSON Schema object.");
      }
      failedByUri.set(hrefOf(d.uri), built.reason);
      warnings.push(`Document \`${d.uri}\` was loaded but could not be imported: ${built.reason}.`);
      continue;
    }
    const file = built.built;
    // Unique names across files, in resolution order.
    const renames = new Map<string, string>();
    const claim = (n: string) => {
      let next = n;
      for (let i = 2; taken.has(sanitizeIdentifier(next)) && i <= taken.size + 2; i++) next = `${n}_${i}`;
      taken.add(sanitizeIdentifier(next));
      if (next !== n) {
        renames.set(n, next);
        warnings.push(`"${n}" from \`${d.uri}\` was already taken by another imported file; imported as "${next}".`);
      }
    };
    for (const e of file.doc.entities) claim(e.name);
    for (const e of file.doc.enums) claim(e.name);
    for (const u of file.doc.unions ?? []) claim(u.name);
    applyRenames(file, renames);
    for (const e of file.doc.entities) {
      e.originalContent = d.original;
      entities.push(e);
    }
    enums.push(...file.doc.enums);
    unions.push(...(file.doc.unions ?? []));
    fileWarnings.push(...file.doc.warnings);
    indexByUri.set(hrefOf(d.uri), file.index);
    if (d.isRoot && file.index.rootKind === "entity") rootEntityName = file.index.rootName;
  }
  if (tokens.overflowed) {
    warnings.push(`More than ${MAX_TOKENS} distinct cross-file references; the rest are kept as references by name.`);
  }

  // ---- Token resolution (by resolved URI) ----
  const resolvedHrefs = new Set<string>();
  for (const k of resolved.keys()) resolvedHrefs.add(hrefOf(k));
  const enumByName = new Map(enums.map((e) => [e.name, e]));
  const unionByName = new Map(unions.map((u) => [u.name, u]));
  const targets = new Map<string, Target>();
  const reportedTargets = new Set<string>();

  const lookupUnreachable = (info: TokenInfo): string | undefined =>
    unreachable.get(info.file) ?? unreachable.get(info.ref) ?? unreachable.get(info.absolute);

  const targetOf = (token: string): Target | undefined => {
    const cached = targets.get(token);
    if (cached) return cached;
    const info = tokens.byToken.get(token);
    if (!info) return undefined;
    const t = computeTarget(info);
    targets.set(token, t);
    if (!t.ok) {
      const key = t.loadFailure ? info.file : info.absolute;
      if (!reportedTargets.has(key)) {
        reportedTargets.add(key);
        warnings.push(`Reference \`${info.ref}\` could not be loaded: ${t.reason}`);
      }
    }
    return t;
  };

  const computeTarget = (info: TokenInfo): Target => {
    const idx = indexByUri.get(info.file);
    if (!idx) {
      const reason =
        failedByUri.get(info.file) ??
        lookupUnreachable(info) ??
        (resolvedHrefs.has(info.file) ? "document limit exceeded" : "the referenced file was not loaded");
      return { ok: false, reason, resolvedUri: info.file, loadFailure: true };
    }
    const miss = (reason: string): Target => ({ ok: false, reason, resolvedUri: info.absolute, loadFailure: false });
    let found: { kind: DefinitionIndexEntry["kind"]; name: string } | undefined;
    if (info.fragment === "" || info.fragment === "#") {
      if (idx.rootName === undefined || idx.rootKind === undefined) {
        return miss("the referenced document defines no importable root type");
      }
      found = { kind: idx.rootKind, name: idx.rootName };
    } else {
      const def = idx.defs.get(info.fragment) ?? idx.defs.get(unescapePointer(info.fragment));
      if (!def) return miss(`\`${info.fragment}\` does not name a top-level definition of the referenced document`);
      found = { kind: def.kind, name: def.assetName };
    }
    if (found.kind === "inline") return miss("the target is an inline definition, not a named entity, enum or union");
    return { ok: true, kind: found.kind, name: found.name };
  };

  const bestEffort = (token: string): string => {
    const info = tokens.byToken.get(token);
    return info ? refToEntityName(info.ref) : token;
  };
  const markerFor = (token: string): ParsedField["danglingRef"] | undefined => {
    const info = tokens.byToken.get(token);
    const t = targetOf(token);
    if (!info || !t || t.ok) return undefined;
    return { ref: info.ref, resolvedUri: t.resolvedUri, reason: t.reason };
  };
  const finalName = (token: string): string => {
    const t = targetOf(token);
    return t && t.ok ? t.name : bestEffort(token);
  };

  for (const e of entities) {
    if (e.extends !== undefined && tokens.isToken(e.extends)) {
      const t = targetOf(e.extends);
      if (t && t.ok && t.kind !== "entity") {
        warnings.push(`Entity "${e.name}": base \`${bestEffort(e.extends)}\` is not an object entity and is ignored as a base.`);
        delete e.extends;
      } else {
        e.extends = finalName(e.extends);
      }
    }
    for (const f of e.fields) rewriteField(f);
  }
  for (const u of unions) u.memberTypes = dedupe(u.memberTypes.map(memberName));

  function memberName(m: string): string {
    return tokens.isToken(m) ? sanitizeIdentifier(finalName(m)) : m;
  }

  function rewriteField(f: ParsedField): void {
    if (f.unionMembers) {
      for (const m of f.unionMembers) {
        if (tokens.isToken(m) && !f.danglingRef) {
          const marker = markerFor(m);
          if (marker) f.danglingRef = marker;
        }
      }
      f.unionMembers = dedupe(f.unionMembers.map(memberName));
    }
    const token = f.referencedEntityName;
    if (token === undefined || !tokens.isToken(token)) return;
    const info = tokens.byToken.get(token);
    const t = targetOf(token);
    if (!info || !t) return;
    const isArray = f.type === "array" && f.arrayElementType === "reference";
    const isDirect = f.type === "reference";
    // The importer marked this token as dangling (it was not defined in the document); the resolution below decides afresh.
    delete f.danglingRef;
    // Raise only when the low confidence came solely from the unresolved ref (not an allOf conflict, a combinator, ...).
    const lowFromRef = isLowFromUnresolvedRef(f);
    if (f.originalType === token) f.originalType = info.ref;
    if (!t.ok) {
      f.referencedEntityName = refToEntityName(info.ref);
      f.danglingRef = { ref: info.ref, resolvedUri: t.resolvedUri, reason: t.reason, ...(isArray ? { element: true as const } : {}) };
      return;
    }
    if (t.kind === "entity") {
      f.referencedEntityName = t.name;
      if (f.confidence === "low" && (isArray || isDirect) && lowFromRef) f.confidence = "high";
      return;
    }
    if (!isArray && !isDirect) {
      f.referencedEntityName = t.name;
      return;
    }
    if (t.kind === "enum") {
      const target = enumByName.get(t.name);
      if (isArray) f.arrayElementType = "enum";
      else f.type = "enum";
      f.enumName = t.name;
      f.enumValues = target ? [...target.values] : [];
      delete f.referencedEntityName;
      if (f.confidence === "low" && lowFromRef) f.confidence = "high";
      return;
    }
    const target = unionByName.get(t.name);
    if (isArray) f.arrayElementType = "union";
    else f.type = "union";
    f.unionName = t.name;
    if (target) f.unionMembers = [...target.memberTypes];
    delete f.referencedEntityName;
    if (f.confidence === "low" && lowFromRef) f.confidence = "medium";
  }

  // ---- Per-file warnings with tokens replaced ----
  for (const w of fileWarnings) {
    const stale = tokens.staleBaseRe.exec(w);
    if (stale) {
      const t = targetOf(stale[1]!);
      if (t && t.ok) continue; // the base IS defined now
    }
    warnings.push(w.replace(tokens.globalRe,(tk) => finalName(tk)));
  }

  breakInheritanceCycles(entities, warnings);

  if (entities.length === 0 && enums.length === 0 && unions.length === 0) {
    return fail(
      "PARSE_ERROR",
      "JSON Schema has no properties to import",
      'Provide an object schema with a non-empty "properties" map (at the root or in "$defs").',
    );
  }

  const tooMany = importCountLimitMessage(entities.length, enums.length);
  if (tooMany) return fail("PARSE_ERROR", tooMany, "Import fewer referenced documents or split the schema.");
  budgetOriginalContent(entities, warnings);

  return ok({
    sourceFormat: "json-schema",
    entities,
    ...(rootEntityName ? { rootEntityName } : {}),
    enums,
    scalars: [],
    unions,
    warnings,
  });
}

function dedupe(names: string[]): string[] {
  return [...new Set(names)];
}
