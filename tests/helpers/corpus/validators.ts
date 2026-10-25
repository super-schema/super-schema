/**
 * The validator tier per target (offline ones; the emulator tiers are in emulators.ts):
 *   json-schema -> ajv 8 (the copy @typespec/compiler ships) compiles the schema against its own $schema meta-schema
 *   openapi3    -> @scalar/openapi-parser `validate` (OpenAPI 3.1 aware)
 *   avro        -> avsc `Type.forSchema`
 *   protobuf    -> protobufjs `parse` + `resolveAll`
 *   postgresql  -> the DDL executed in PGlite (inside a transaction that is rolled back)
 *   java-pojo   -> `javac -proc:none` with tiny stubs for the imported annotation packages
 *   spanner / bigquery -> LocalCloud emulators (emulators.ts)
 */
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TargetKey } from "../../fixtures/corpus/types";

const req = createRequire(path.join(process.cwd(), "package.json"));
const compilerReq = createRequire(req.resolve("@typespec/compiler"));

export interface Validation {
  ok: boolean;
  tier: string;
  /** Present when !ok. */
  error?: string;
  /** The result could not be judged (tool missing): the matrix shows SKIPPED. */
  skipped?: boolean;
}

const pass = (tier: string): Validation => ({ ok: true, tier });
const fail = (tier: string, error: string): Validation => ({ ok: false, tier, error: error.slice(0, 700) });

/** At most this many unresolved external `$ref`s are stubbed per output (a hostile document cannot make the loop unbounded). */
const MAX_STUBBED_REFS = 500;

/**
 * Makes the node a JSON pointer (`/$defs/Money`) names exist in `stub` (as `{}`); true when something was added. A pointer that is
 * not a plain `/a/b` path (an anchor, `__proto__`, an empty path) adds nothing, so the caller gives up on that ref.
 */
function graftPointer(stub: Record<string, unknown>, pointer: string): boolean {
  if (!pointer.startsWith("/")) return false;
  let node = stub;
  let added = false;
  for (const raw of pointer.slice(1).split("/")) {
    let key: string;
    try { key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~"); } catch { return added; }
    if (key === "__proto__") return added;
    if (!Object.prototype.hasOwnProperty.call(node, key)) {
      node[key] = {};
      added = true;
    }
    const next = node[key];
    if (typeof next !== "object" || next === null) return added;
    node = next as Record<string, unknown>;
  }
  return added;
}

/** What `validateJsonSchema` may tolerate. */
export interface JsonSchemaOptions {
  /**
   * The `$ref` strings the case's OWN INPUT leaves dangling on purpose (`user_links.json`: an import has no base URL to fetch them from),
   * exactly as written there. Only these, and refs that cannot be a file of the output set at all, are stubbed: any other ref to a
   * bare `<Name>.json` is a sibling file the emitted set must hold.
   */
  external?: readonly string[];
}

/**
 * Whether an unresolved `$ref` target (ajv's resolved key) names a SIBLING FILE of the emitted set: a bare `<Name>.json` next to the
 * documents (no directory, scheme, query or pointer beyond the document's own base). The emitter writes a reference to another entity (or
 * to a file of its own: an inline enum) as exactly that, so one that does not resolve is a defect of the output. A ref with a directory
 * (`common_components/v4/date_time.json`), a URL or a `..` is not: the file set has no such path.
 */
export function isSiblingFileRef(missing: string, documentIds: readonly string[]): boolean {
  const bases = new Set(documentIds.map((id) => id.slice(0, id.lastIndexOf("/") + 1)));
  if (bases.size === 0) bases.add("");
  for (const base of bases) {
    if (!missing.startsWith(base)) continue;
    // A file name the emitter writes: a TypeSpec identifier (letters, digits, `_`; a qualified name adds `.` and `-`), never a
    // percent-escape or a quote (that is a string the input's own `$ref` carried).
    if (/^[\p{L}_][\p{L}\p{N}_.-]*\.json$/u.test(missing.slice(base.length))) return true;
  }
  return false;
}

/**
 * The JSON Schema output of the app is one bare document, or (a closure, or a stand-alone entity that declares an enum / shared
 * type) several documents joined as `===== <Name>.json =====` blocks, which reference each other by file (`$ref: "Other.json"`,
 * resolved against each document's own `$id`). Every document is added to one ajv instance (adding validates it against the
 * meta-schema of its dialect) and compiled, so a `$ref` to a sibling file must resolve.
 *
 * A `$ref` to a SIBLING file of the set (a bare `<Name>.json`) that no document answers to FAILS, whether the file is missing or its
 * `$id` differs from the name the reference uses. Only a genuinely external `$ref` is tolerated: one the case's own input declared
 * dangling (`options.external`), or one that cannot be a file of the set (`common_components/.../date_time.json`, a URL). Those are
 * kept dangling ON PURPOSE (an import has no base URL to fetch them from), so they get an empty stub schema and compilation continues.
 */
export async function validateJsonSchema(output: string, options: JsonSchemaOptions = {}): Promise<Validation> {
  const tier = "ajv 8 meta-schema compile";
  const bundled = splitBundledFiles(output);
  const files = bundled.length > 0 ? bundled : [{ name: "main.json", body: output }];
  const schemas: Array<{ name: string; schema: Record<string, unknown> }> = [];
  const declared = new Set(options.external ?? []);
  for (const file of files) {
    try {
      // A `$ref` the case's own input declared dangling (exactly as written there) is dropped while parsing: it constrains nothing, which is
      // what stubbing it with an empty schema would say, without depending on how ajv spells a key for a string such as `x"y'z.json`.
      const parsed: unknown = JSON.parse(file.body, (key, value: unknown) => (key === "$ref" && typeof value === "string" && declared.has(value) ? undefined : value));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fail(tier, `${file.name} is not a JSON object`);
      schemas.push({ name: file.name, schema: parsed as Record<string, unknown> });
    } catch (e) {
      return fail(tier, `not JSON${bundled.length > 0 ? ` (${file.name})` : ""}: ${(e as Error).message}`);
    }
  }
  const uri = String(schemas[0]?.schema.$schema ?? "");
  const known = uri.includes("2020-12") || uri.includes("2019-09");
  // `unicodeRegExp: false`: a `pattern` is judged as the ECMA-262 regular expression a document written without the `u` flag means (ajv
  // compiles with `u` by default, which rejects `${x}` and a lone `{`); the app passes a pattern through verbatim, it does not rewrite it.
  const ajvOptions = { strict: false, validateFormats: false, allErrors: false, unicodeRegExp: false };
  try {
    let Ctor: new (o: object) => {
      addSchema(s: object, key?: string): unknown;
      removeSchema(key: string): unknown;
      getSchema(key: string): unknown;
      addKeyword(keyword: string): unknown;
      removeKeyword(keyword: string): unknown;
    };
    if (uri.includes("2020-12")) Ctor = compilerReq("ajv/dist/2020").default;
    else if (uri.includes("2019-09")) Ctor = compilerReq("ajv/dist/2019").default;
    else Ctor = compilerReq("ajv").default ?? compilerReq("ajv");
    const ajv = new Ctor(ajvOptions);
    // `id` is draft-04's schema id, which ajv 8 refuses outright (`NOT SUPPORTED: keyword "id"`). It is no keyword of the dialects
    // judged here, where an unknown keyword is an annotation: a draft-04 `id` the import kept as an extension is just that.
    ajv.removeKeyword("id");
    ajv.addKeyword("id");
    const keys = schemas.map(({ name, schema }) => {
      // A draft we do not know is compiled as the default one.
      const { $schema: _ignored, ...rest } = schema;
      void _ignored;
      const key = typeof schema.$id === "string" && schema.$id !== "" ? schema.$id : name;
      ajv.addSchema(known ? schema : rest, key);
      return key;
    });
    let stubbed = 0;
    const stubs = new Map<string, Record<string, unknown>>();
    const documentIds = schemas.map(({ schema }) => (typeof schema.$id === "string" ? schema.$id : ""));
    for (const key of keys) {
      for (;;) {
        try {
          // Compiling the schema validates it against the meta-schema of its dialect and resolves its references.
          ajv.getSchema(key);
          break;
        } catch (e) {
          const { missingSchema, missingRef } = e as { missingSchema?: unknown; missingRef?: unknown };
          if (typeof missingSchema !== "string" || stubbed >= MAX_STUBBED_REFS) throw e;
          // A pointer into a document of the set that has no such node (`MapRef.json#/$defs/V`: the file is there, the node is not) is a
          // defect of the output, never an external ref: the set is all there is to resolve it in.
          if (keys.includes(missingSchema) && typeof missingRef === "string" && missingRef.includes("#")) {
            throw new Error(`Can't resolve reference: ${missingRef.slice(missingRef.indexOf("#"))} (${missingSchema} is in the output and has no such node)`);
          }
          // A ref to a file of the set that no document answers to is a defect of the output (missing file, or its `$id` differs).
          if (isSiblingFileRef(missingSchema, documentIds)) {
            const named = schemas.find(({ name, schema }) => name === missingSchema || (typeof schema.$id === "string" && schema.$id.split("/").pop() === missingSchema));
            const detail = named && named.schema.$id !== missingSchema
              ? `the file ${named.name} is there but its $id is ${JSON.stringify(named.schema.$id ?? null)}, not ${JSON.stringify(missingSchema)}`
              : `no file of the output has that name or $id`;
            throw new Error(`a $ref to the sibling file ${JSON.stringify(missingSchema)} does not resolve: ${detail} (documents: ${schemas.map(({ name, schema }) => `${name} [$id ${typeof schema.$id === "string" ? schema.$id : "-"}]`).join(", ")})`);
          }
          const stub = stubs.get(missingSchema) ?? {};
          // A ref with a pointer (`other.json#/$defs/Money`) needs that node to exist in the stub.
          const pointer = typeof missingRef === "string" && missingRef.includes("#") ? missingRef.slice(missingRef.indexOf("#") + 1) : "";
          if (!graftPointer(stub, pointer) && stubs.has(missingSchema)) throw e;
          if (stubs.has(missingSchema)) ajv.removeSchema(missingSchema);
          stubs.set(missingSchema, stub);
          stubbed += 1;
          ajv.addSchema(stub, missingSchema);
        }
      }
    }
    return pass(stubbed > 0 ? `${tier} (dangling external $ref tolerated)` : tier);
  } catch (e) {
    return fail(tier, (e as Error).message);
  }
}

/**
 * The files of an output: its `===== path =====` blocks, or the whole text as the one file `fallback` when it is bare (a single file is
 * written without the marker). EVERY file of a closure is judged, never just the first.
 */
function filesOf(output: string, fallback: string): Array<{ name: string; body: string }> {
  const files = splitBundledFiles(output);
  return files.length > 0 ? files : [{ name: fallback, body: output }];
}

async function validateOpenApiDocument(output: string): Promise<Validation> {
  const tier = "@scalar/openapi-parser validate";
  try {
    const { validate } = (await import("@scalar/openapi-parser")) as unknown as {
      validate: (c: string) => Promise<{ valid: boolean; errors?: Array<{ message: string }> }>;
    };
    const result = await validate(output);
    if (result.valid) return pass(tier);
    // A `$ref` to another file is kept dangling ON PURPOSE (the import has no base URL); that is not a defect of the document.
    const real = (result.errors ?? []).filter((x) => !/Can't resolve external reference/i.test(x.message));
    return real.length === 0 ? { ok: true, tier: `${tier} (dangling external $ref tolerated)` } : fail(tier, real.map((x) => x.message).join(" | "));
  } catch (e) {
    return fail(tier, `validator threw: ${(e as Error).message}`);
  }
}

/** OpenAPI has no reference between files (a closure's entities are inlined in each service's file), so every file is a document on its own. */
export async function validateOpenApi(output: string): Promise<Validation> {
  const files = filesOf(output, "openapi.yaml");
  let tolerated = false;
  for (const file of files) {
    const v = await validateOpenApiDocument(file.body);
    if (!v.ok) return files.length > 1 ? { ...v, error: `${file.name}: ${v.error}`.slice(0, 700) } : v;
    tolerated ||= v.tier.includes("tolerated");
  }
  return pass(`@scalar/openapi-parser validate${files.length > 1 ? ` (${files.length} files)` : ""}${tolerated ? " (dangling external $ref tolerated)" : ""}`);
}

/** Avro files of a closure are each self-contained (first use inline, later use by full name): every file must parse on its own. */
export async function validateAvro(output: string): Promise<Validation> {
  const tier = "avsc Type.forSchema";
  const files = filesOf(output, "schema.avsc.json");
  try {
    const avsc = req("avsc") as { Type: { forSchema(s: unknown): unknown } };
    for (const file of files) {
      try {
        avsc.Type.forSchema(JSON.parse(file.body));
      } catch (e) {
        return fail(tier, files.length > 1 ? `${file.name}: ${(e as Error).message}` : (e as Error).message);
      }
    }
    return pass(files.length > 1 ? `${tier} (${files.length} files)` : tier);
  } catch (e) {
    return fail(tier, (e as Error).message);
  }
}

/**
 * Every `.proto` of the output is written under its own path in one directory and loaded together, so an `import "a/b.proto"` between
 * the files resolves (protobufjs also resolves `google/protobuf/*.proto` from its bundled copies, which only works for files it loads).
 */
export async function validateProtobuf(output: string): Promise<Validation> {
  const tier = "protobufjs parse + resolveAll";
  const dir = await mkdtemp(path.join(tmpdir(), "ss-corpus-proto-"));
  try {
    const protobuf = req("protobufjs") as {
      Root: new () => { resolvePath: (origin: string, target: string) => string | null; loadSync(file: string | string[], o?: object): { resolveAll(): void } };
    };
    const files = filesOf(output, "schema.proto");
    const written: string[] = [];
    for (const f of files) {
      const rel = path.normalize(f.name);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return fail(tier, `unsafe file name ${f.name}`);
      const abs = path.join(dir, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, f.body);
      written.push(abs);
    }
    // protobufjs bundles google/protobuf/* only; the google/type/* well-known files the emitter may import are stubbed (field-for-field as published).
    const stubs: Record<string, string> = {
      "google/type/date.proto": 'syntax = "proto3"; package google.type; message Date { int32 year = 1; int32 month = 2; int32 day = 3; }',
      "google/type/timeofday.proto": 'syntax = "proto3"; package google.type; message TimeOfDay { int32 hours = 1; int32 minutes = 2; int32 seconds = 3; int32 nanos = 4; }',
    };
    for (const [rel, body] of Object.entries(stubs)) {
      if (!files.some((f) => f.body.includes(`"${rel}"`))) continue;
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), body);
    }
    const root = new protobuf.Root();
    // An import names a path under the output root, never one relative to the importing file's directory (that is how `tsp` writes them).
    const inherited = root.resolvePath.bind(root);
    root.resolvePath = (origin, target) => (path.isAbsolute(target) || target.startsWith("google/protobuf/") ? inherited(origin, target) : path.join(dir, target));
    root.loadSync(written, { keepCase: true }).resolveAll();
    return pass(files.length > 1 ? `${tier} (${files.length} files)` : tier);
  } catch (e) {
    return fail(tier, (e as Error).message.replaceAll(dir, "<tmp>"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type Pg = { exec(sql: string): Promise<unknown> };
let pglite: Promise<Pg> | undefined;
async function sharedPglite(): Promise<Pg> {
  pglite ??= import("@electric-sql/pglite").then(async ({ PGlite }) => {
    const db = new PGlite();
    await db.waitReady;
    return db as unknown as Pg;
  });
  return pglite;
}
let pgChain: Promise<unknown> = Promise.resolve();

/** PGlite is single-connection: serialise, and roll every case back so cases cannot see each other's tables. */
export async function validatePostgres(ddl: string): Promise<Validation> {
  const tier = "PGlite DDL execution";
  const run = async (): Promise<Validation> => {
    const db = await sharedPglite();
    try {
      await db.exec("BEGIN");
      await db.exec(ddl);
      return pass(tier);
    } catch (e) {
      return fail(tier, (e as Error).message);
    } finally {
      try { await db.exec("ROLLBACK"); } catch { /* nothing open */ }
    }
  };
  const result = pgChain.then(run, run);
  pgChain = result.catch(() => undefined);
  return result;
}

function exec(cmd: string, args: string[], cwd: string, timeout: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? ((error as { code?: number }).code ?? 1) : 0;
      resolve({ code: typeof code === "number" ? code : 1, out: `${stdout}${stderr}` });
    });
  });
}

let javacAvailable: Promise<boolean> | undefined;

/** Splits the "===== Name.ext =====" multi-file output (bundleGeneratedFiles) into its files; empty when the output is one bare file. */
export function splitBundledFiles(output: string): Array<{ name: string; body: string }> {
  const parts = output.split(/^===== (.+?) =====$/m);
  const files: Array<{ name: string; body: string }> = [];
  for (let i = 1; i + 1 < parts.length; i += 2) files.push({ name: parts[i].trim(), body: parts[i + 1] });
  return files;
}

/** The java-pojo emitter's multi-file output (a single class is written without the marker, see validateJava). */
export const splitJavaFiles = splitBundledFiles;

/** Stub annotation types for the annotation packages the emitter may import (all imports of those packages become empty @interfaces). */
function stubsFor(sources: string[]): Array<{ rel: string; body: string }> {
  const stubs = new Map<string, { rel: string; body: string }>();
  for (const src of sources) {
    for (const m of src.matchAll(/^import\s+((?:com\.fasterxml|jakarta|javax)\.[\w.]+)\.([A-Z]\w*);/gm)) {
      const pkg = m[1];
      const name = m[2];
      if (pkg.startsWith("javax.xml") || pkg === "javax.annotation") { /* still stub: not in JDK 25 */ }
      stubs.set(`${pkg}.${name}`, {
        rel: path.join(...pkg.split("."), `${name}.java`),
        body: `package ${pkg};\npublic @interface ${name} { String value() default ""; String[] names() default {}; String pattern() default ""; String regexp() default ""; int min() default 0; int max() default Integer.MAX_VALUE; String message() default ""; }\n`,
      });
    }
  }
  return [...stubs.values()];
}

async function compileJava(files: Array<{ name: string; body: string }>): Promise<{ ok: boolean; out: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-corpus-java-"));
  try {
    const out = path.join(dir, "out");
    await mkdir(out, { recursive: true });
    const written: string[] = [];
    for (const f of files) {
      const rel = path.normalize(f.name);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return { ok: false, out: `unsafe file name ${f.name}` };
      const abs = path.join(dir, "src", rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, f.body);
      written.push(abs);
    }
    for (const s of stubsFor(files.map((f) => f.body))) {
      const abs = path.join(dir, "stubs", s.rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, s.body);
      written.push(abs);
    }
    const result = await exec("javac", ["-proc:none", "-Xlint:none", "-d", out, ...written], dir, 60000);
    return { ok: result.code === 0, out: result.out.replaceAll(dir, "<tmp>") };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Marker prefix of the one failure that compiles once a missing `package` line is added (see known-issues.ts). */
export const JAVA_ENUM_NO_PACKAGE = "enum/class file has no package declaration";

export async function validateJava(output: string): Promise<Validation> {
  const tier = "javac -proc:none (annotation stubs)";
  javacAvailable ??= exec("javac", ["-version"], process.cwd(), 15000).then((r) => r.code === 0);
  if (!(await javacAvailable)) return { ok: true, tier: "javac not installed", skipped: true };
  let files = splitJavaFiles(output);
  if (files.length === 0) {
    // A single class is written without the `===== File.java =====` marker.
    const m = /public\s+(?:final\s+)?(?:class|enum|interface|record)\s+(\w+)/.exec(output);
    if (!m) return fail(tier, "java-pojo output has no class and no file markers");
    files = [{ name: `${m[1]}.java`, body: output }];
  }
  const first = await compileJava(files);
  if (first.ok) return pass(tier);
  // Isolate the known sibling defect: files without a package line next to files with one.
  const pkg = files.map((f) => /^package\s+[\w.]+;/m.exec(f.body)?.[0]).find((p) => p);
  if (pkg && files.some((f) => !/^package\s/m.test(f.body))) {
    const fixed = await compileJava(files.map((f) => (/^package\s/m.test(f.body) ? f : { ...f, body: `${pkg}\n\n${f.body}` })));
    if (fixed.ok) return fail(tier, `${JAVA_ENUM_NO_PACKAGE}: javac fails as emitted but compiles after adding \`${pkg}\` to the package-less files`);
    return fail(tier, `still failing with the package line added: ${fixed.out.slice(0, 380)} (as emitted: ${first.out.slice(0, 200)})`);
  }
  return fail(tier, first.out);
}

/** The offline validator for `target`; the emulator targets return undefined (see emulators.ts). `options.jsonSchema` is the case's own dangling refs. */
export async function validateOffline(target: TargetKey, output: string, options: { jsonSchema?: JsonSchemaOptions } = {}): Promise<Validation | undefined> {
  switch (target) {
    case "json-schema": return validateJsonSchema(output, options.jsonSchema);
    case "openapi3": return validateOpenApi(output);
    case "avro": return validateAvro(output);
    case "protobuf": return validateProtobuf(output);
    case "postgresql": return validatePostgres(output);
    case "java-pojo": return validateJava(output);
    default: return undefined;
  }
}
